// Chain-event indexer (Story 2.7, AD-9, AD-24, amendment 2026-09-27). Each full tick, for every bound enforced
// binding (in the fast lane only those with a write in flight, AD-20 amendment 2026-09-29), with one `latestBlock`
// read per pass: tail the PolicyWallet's events from the cursor to `latest − confirmations` in chunks, join each
// Horos write to its in-flight outbox intent by `recordHash` (→ `confirmed` WriteReceipts), record `Paid`
// history, append one ExternalRecord per transaction with unmatched events, and fold every Counterparty event
// into the mirror. Then (full tick only) derive receipts from the outbox's final states. The indexer is the only
// writer of the mirror, WriteReceipts, `Paid` history and ExternalRecords; every write is idempotent, so a chunk
// that fails part-way is simply indexed again. A wallet whose read is rate-limited by the RPC cools down (both
// lanes skip it for `rateLimitCooldownMs`, per indexer instance), so a saturated shared limit can recover.
import { isRateLimited, type BoundWallet, type HorosTx, type MirrorEvent, type PostgresIndexerStore, type PostgresJobStore } from "@horos/adapters";
import { buildExternalRecord, type ChainReader, type Notifier, type OutboxIntentRow, type PolicyWalletLog, type RecordStore, type WalletRoles } from "@horos/core";
import { HUMAN_ONLY_EVENTS, redactUrls, toWireTime, ZERO_BYTES32, type ExternalActor, type Hex } from "@horos/schema";

/** The durable founder alert for an unrecognised Registrar/Model/Rules write; its window is the tx hash. */
export const UNRECOGNISED_WRITE_ALERT_JOB = "unrecognised-write-alert";

export interface IndexerDeps {
  readonly store: PostgresIndexerStore;
  /** Holds the `unrecognised-write-alert` jobs, so an alert survives a crash or a failed delivery. */
  readonly jobs: PostgresJobStore;
  readonly records: RecordStore<HorosTx>;
  readonly reader: ChainReader;
  readonly notifier: Notifier;
  /** A fresh UUIDv7 for ExternalRecords. */
  readonly newId: (nowMs: number) => string;
  /** Blocks behind the head left unindexed. Default 1 (Arc finalises deterministically). */
  readonly confirmations?: bigint;
  /** Blocks per `logs` request. Default and maximum 2000. The reader splits a chunk whose logs exceed the RPC's result cap. */
  readonly chunkSize?: bigint;
  /** Chunks per wallet per tick. Default 10. */
  readonly maxChunksPerTick?: number;
  /** How long a wallet is skipped after a rate-limited read. Default 30 s. */
  readonly rateLimitCooldownMs?: number;
  /** Delivery attempts per alert job before it stays failed. Default 10. */
  readonly alertMaxAttempts?: number;
}

export interface WalletIndexReport {
  readonly policyWallet: Hex;
  readonly scope: string;
  /** The cursor after this tick (the next block to index). */
  readonly nextBlock?: bigint;
  readonly chunks: number;
  readonly confirmed: number;
  readonly external: number;
  readonly paid: number;
  /** Unrecognised-write alert jobs ensured (delivered by the alert step). */
  readonly alerts: number;
  readonly error?: string;
  /**
   * Set when the wallet is cooling down after a rate-limited read: with `error` on the pass that hit the limit,
   * without it on the passes that skipped the wallet (no chain call).
   */
  readonly coolingDownUntil?: Date;
}

export interface IndexerReport {
  readonly wallets: readonly WalletIndexReport[];
  readonly reconciled: number;
  readonly reconcileError?: string;
  /** Tx hashes whose unrecognised-write alert was delivered this tick. */
  readonly alertsDelivered: readonly Hex[];
  readonly alertErrors: readonly { readonly txHash: string; readonly error: string }[];
}

const MAX_CHUNK = 2000n;
export const DEFAULT_MAX_CHUNKS_PER_TICK = 10;
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 30_000;
const errMessage = (err: unknown): string => redactUrls(err instanceof Error ? err.message : String(err));

/** The first block at which `wallet` has code (binary search on `hasCodeAt`). Throws when it has none at `latest`. */
export async function findDeployBlock(reader: ChainReader, wallet: Hex, latest: bigint): Promise<bigint> {
  if (!(await reader.hasCodeAt(wallet, latest))) throw new Error(`no code at ${wallet} as of block ${latest}`);
  let lo = 0n;
  let hi = latest;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (await reader.hasCodeAt(wallet, mid)) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

/** Horos only ever sends these, so only these can match an outbox intent. */
const MATCHABLE = new Set<PolicyWalletLog["name"]>(["CounterpartyRegistered", "LimitTightened", "CounterpartyPinned"]);

/** The limit a matched event leaves on-chain, or undefined when `e` is not a compatible Horos write for `intent`. */
function compatibleLimit(intent: OutboxIntentRow, e: PolicyWalletLog, tx: readonly PolicyWalletLog[]): bigint | undefined {
  const a = e.args;
  if (intent.pin) {
    if (e.name === "CounterpartyPinned") return 0n;
    // `pin` on an unregistered Counterparty first registers it at 0 in the same tx.
    const pinned = tx.some((x) => x.name === "CounterpartyPinned" && x.args["counterparty"] === a["counterparty"] && x.args["recordHash"] === a["recordHash"]);
    if (e.name === "CounterpartyRegistered" && a["limit"] === "0" && pinned) return 0n;
    return undefined;
  }
  // A non-pin intent is sent as `register(min(target, FCC))` or `tighten(target)` (whichever the chain needs).
  const limit = e.name === "CounterpartyRegistered" ? a["limit"] : e.name === "LimitTightened" ? a["newLimit"] : undefined;
  if (limit === undefined) return undefined;
  const l = BigInt(limit);
  return l <= intent.target ? l : undefined;
}

function mirrorEvent(e: PolicyWalletLog, actor: ExternalActor | undefined, blockTimestamp: () => Promise<bigint>): Promise<MirrorEvent | undefined> | MirrorEvent | undefined {
  const a = e.args;
  const big = (k: string): bigint => {
    const v = a[k];
    if (v === undefined) throw new Error(`${e.name} is missing ${k}`);
    return BigInt(v);
  };
  switch (e.name) {
    case "CounterpartyRegistered":
      return { kind: "registered", limit: big("limit") };
    case "LimitTightened":
      return { kind: "tightened", limit: big("newLimit") };
    case "CounterpartyPinned":
      return { kind: "pinned" };
    case "PinReleased":
      // A Human `executeUnpin` bumps the epoch; a Rules `releasePin` does not.
      return { kind: "pin-released", humanEpochBump: actor === "human" };
    case "LimitSet":
      return { kind: "limit-set", limit: big("newLimit"), humanEpoch: big("humanEpoch") };
    case "UnpinRequested":
      // The contract stores `block.timestamp` as the request time.
      return blockTimestamp().then((at) => ({ kind: "unpin-requested", at }));
    default:
      return undefined;
  }
}

/** Group chain-ordered logs into transactions, keeping order. */
function byTx(logs: readonly PolicyWalletLog[]): PolicyWalletLog[][] {
  const out: PolicyWalletLog[][] = [];
  for (const l of logs) {
    const last = out[out.length - 1];
    if (last?.[0]?.txHash === l.txHash) last.push(l);
    else out.push([l]);
  }
  return out;
}

export function createIndexer(d: IndexerDeps) {
  const confirmations = d.confirmations ?? 1n;
  const chunkSize = d.chunkSize === undefined ? MAX_CHUNK : d.chunkSize < 1n ? 1n : d.chunkSize > MAX_CHUNK ? MAX_CHUNK : d.chunkSize;
  const maxChunks = d.maxChunksPerTick ?? DEFAULT_MAX_CHUNKS_PER_TICK;
  const cooldownMs = d.rateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS;
  /** Wallet → end of its rate-limit cooldown (ms). In memory: a restart simply retries. */
  const coolingDown = new Map<Hex, number>();
  const cooldownOf = (w: Hex, now: Date): number | undefined => {
    const until = coolingDown.get(w);
    if (until !== undefined && now.getTime() >= until) coolingDown.delete(w);
    return until !== undefined && now.getTime() < until ? until : undefined;
  };
  /** Start a cooldown for `w` when `err` is a rate limit; returns its end, else undefined. */
  const coolDown = (w: Hex, err: unknown, now: Date): Date | undefined => {
    if (!isRateLimited(err)) return undefined;
    const until = now.getTime() + cooldownMs;
    coolingDown.set(w, until);
    return new Date(until);
  };

  /** Who sent `txHash`: from a Human-only / ownership event, else `tx.from` against the role holders at the block. */
  async function actorOf(wallet: Hex, events: readonly PolicyWalletLog[], block: bigint, txHash: Hex): Promise<{ actor: ExternalActor; address: Hex }> {
    const from = await d.reader.txFrom(txHash);
    if (events.some((e) => HUMAN_ONLY_EVENTS.includes(e.name))) return { actor: "human", address: from };
    if (events.some((e) => e.name === "OwnershipTransferred")) return { actor: "pending-human", address: from };
    const holderOf = (r: WalletRoles): ExternalActor | undefined =>
      from === r.registrar ? "registrar" : from === r.model ? "model" : from === r.rules ? "rules" : from === r.human ? "human" : undefined;
    // Roles as of the block; a holder replaced later in that same block is still found one block earlier.
    const actor = holderOf(await d.reader.rolesAt(wallet, block)) ?? (block > 0n ? holderOf(await d.reader.rolesAt(wallet, block - 1n)) : undefined);
    if (actor === undefined) throw new Error(`tx ${txHash} was sent by ${from}, which holds no PolicyWallet role`);
    return { actor, address: from };
  }

  async function indexTx(w: BoundWallet, tx: PolicyWalletLog[], now: Date, counts: { confirmed: number; external: number; paid: number; alerts: number }) {
    const first = tx[0];
    if (first === undefined) return;
    const { txHash, blockNumber } = first;
    let ts: bigint | undefined;
    const blockTimestamp = async () => (ts ??= await d.reader.blockTimestamp(blockNumber));
    const humanTx = tx.some((e) => HUMAN_ONLY_EVENTS.includes(e.name));

    const matched = new Map<string, { intent: OutboxIntentRow; sentBy: OutboxIntentRow; limit: bigint; events: PolicyWalletLog[] }>();
    const unmatched: PolicyWalletLog[] = [];
    for (const e of tx) {
      const cp = e.args["counterparty"] as Hex | undefined;
      const hash = e.args["recordHash"] as Hex | undefined;
      if (e.name === "Paid") {
        if (cp === undefined || hash === undefined || e.args["amount"] === undefined) throw new Error("malformed Paid event");
        await d.store.insertPaid({
          scope: w.scope,
          policyWallet: w.policyWallet,
          txHash,
          logIndex: e.logIndex,
          counterparty: cp,
          amount: BigInt(e.args["amount"]),
          recordHash: hash,
          blockNumber,
          blockTimestamp: new Date(Number(await blockTimestamp()) * 1000),
        });
        counts.paid++;
        continue;
      }
      // A transaction holding a Human-only event is a Human action: nothing in it is a Horos write.
      if (!humanTx && MATCHABLE.has(e.name) && cp !== undefined && hash !== undefined) {
        const m = await d.store.matchIntent(w.scope, cp, hash, txHash);
        // Compatibility is judged against the row the mined call was built from.
        const limit = m === undefined ? undefined : compatibleLimit(m.sentBy, e, tx);
        if (m !== undefined && limit !== undefined) {
          const prior = matched.get(m.intent.id);
          matched.set(m.intent.id, {
            intent: m.intent,
            sentBy: m.sentBy,
            limit: prior === undefined || limit < prior.limit ? limit : prior.limit,
            events: [...(prior?.events ?? []), e],
          });
          continue;
        }
      }
      if (hash !== undefined || e.name === "UnpinRequested") unmatched.push(e);
    }

    for (const { intent, sentBy, limit, events } of matched.values()) {
      const confirm = { txHash, blockNumber, onchainLimitAfter: limit, now };
      // Only-tighten: an intent is done only when the mined outcome satisfies it (a pin was pinned; otherwise
      // the on-chain limit is at or below its target). A tighter coalesced target must still be sent.
      const pinned = tx.some((x) => x.name === "CounterpartyPinned" && x.args["counterparty"] === intent.counterparty);
      const satisfied = intent.pin ? pinned : limit <= intent.target;
      if (!satisfied) {
        // A genuine Horos write: never an ExternalRecord. The merged row's own records are confirmed at the
        // mined limit; the surviving intent (or a requeued row that coalesced lower) stays for the sender, and
        // its later write confirms the rest.
        if (sentBy.id !== intent.id && (await d.store.confirmMergedRow({ rowId: sentBy.id, ...confirm }))) counts.confirmed++;
        continue;
      }
      if (await d.store.confirmIntent({ intentId: intent.id, ...confirm })) counts.confirmed++;
      else unmatched.push(...events); // not confirmable after all: the events are evidence of an unexplained change
    }
    unmatched.sort((x, y) => x.logIndex - y.logIndex);

    let actor: ExternalActor | undefined;
    if (unmatched.length > 0) {
      const who = await actorOf(w.policyWallet, unmatched, blockNumber, txHash);
      actor = who.actor;
      if (!(await d.store.hasExternalRecord(w.scope, txHash))) {
        const head = unmatched[0];
        const carriedHash = head === undefined || head.name === "UnpinRequested" ? ZERO_BYTES32 : (head.args["recordHash"] ?? ZERO_BYTES32);
        const blockTime = toWireTime(new Date(Number(await blockTimestamp()) * 1000));
        const id = d.newId(now.getTime());
        const createdAt = toWireTime(now);
        await d.records.append({
          scope: w.scope,
          build: (seq, prevHash) =>
            buildExternalRecord(
              {
                id,
                scope: w.scope,
                createdAt,
                customerId: w.customerId,
                policyWallet: w.policyWallet,
                actor: who.actor,
                actorAddress: who.address,
                txHash,
                blockNumber,
                blockTimestamp: blockTime,
                carriedHash,
                events: unmatched.map((e) => ({ logIndex: e.logIndex, name: e.name, args: { ...e.args } })),
              },
              seq,
              prevHash,
            ),
        });
        counts.external++;
      }
      // Durable alert: ensured whenever the ExternalRecord exists (also on a replay after a crash); the job
      // row is unique per tx, so the founder is alerted exactly once, by the alert step.
      if (who.actor === "registrar" || who.actor === "model" || who.actor === "rules") {
        if (await d.jobs.ensureJob(UNRECOGNISED_WRITE_ALERT_JOB, txHash, now)) counts.alerts++;
      }
    }

    for (const e of tx) {
      const cp = e.args["counterparty"] as Hex | undefined;
      if (cp === undefined || e.name === "Paid") continue;
      const ev = await mirrorEvent(e, actor, blockTimestamp);
      if (ev !== undefined) await d.store.applyMirror(w.scope, cp, ev, { block: blockNumber, logIndex: e.logIndex }, now);
    }
  }

  async function indexWallet(w: BoundWallet, latest: bigint, now: Date): Promise<WalletIndexReport> {
    const counts = { confirmed: 0, external: 0, paid: 0, alerts: 0 };
    let chunks = 0;
    let next: bigint | undefined;
    try {
      let cursor = await d.store.cursor(w.policyWallet);
      if (cursor === undefined) {
        // First run: start at the deploy block (the wallet has no events before it).
        cursor = await findDeployBlock(d.reader, w.policyWallet, latest);
        await d.store.setCursor(w.policyWallet, w.scope, cursor, now);
      }
      next = cursor;
      const head = latest - confirmations;
      while (cursor <= head && chunks < maxChunks) {
        const last: bigint = cursor + chunkSize - 1n < head ? cursor + chunkSize - 1n : head;
        const logs = await d.reader.logs(w.policyWallet, cursor, last);
        for (const tx of byTx(logs)) await indexTx(w, tx, now, counts);
        cursor = last + 1n;
        // Advanced only after the whole chunk is indexed; a failure re-indexes the chunk (idempotently).
        await d.store.setCursor(w.policyWallet, w.scope, cursor, now);
        next = cursor;
        chunks++;
      }
      return { policyWallet: w.policyWallet, scope: w.scope, nextBlock: cursor, chunks, ...counts };
    } catch (err) {
      const until = coolDown(w.policyWallet, err, now);
      return {
        policyWallet: w.policyWallet,
        scope: w.scope,
        ...(next === undefined ? {} : { nextBlock: next }),
        chunks,
        ...counts,
        error: errMessage(err),
        ...(until === undefined ? {} : { coolingDownUntil: until }),
      };
    }
  }

  /** Deliver pending unrecognised-write alerts; a failed delivery fails the job, which a later tick retries. */
  async function deliverAlerts(now: Date): Promise<Pick<IndexerReport, "alertsDelivered" | "alertErrors">> {
    const alertsDelivered: Hex[] = [];
    const alertErrors: { txHash: string; error: string }[] = [];
    for (let i = 0; i < 20; i++) {
      const job = await d.jobs.claimJob(UNRECOGNISED_WRITE_ALERT_JOB, { now, maxAttempts: d.alertMaxAttempts ?? 10 });
      if (job === undefined) break;
      const txHash = job.window as Hex;
      try {
        const r = await d.store.externalRecordByTx(txHash);
        if (r === undefined) throw new Error(`no ExternalRecord for ${txHash}`);
        if (r.actor !== "registrar" && r.actor !== "model" && r.actor !== "rules") throw new Error(`ExternalRecord ${r.id} is not an automated write`);
        await d.notifier.notify({
          kind: "unrecognised-horos-write",
          scope: r.scope,
          policyWallet: r.policyWallet,
          txHash,
          actor: r.actor,
          message: `The ${r.actor} key of ${r.policyWallet} sent ${r.events.map((e) => e.name).join(", ")} in ${txHash}, which no Horos outbox intent explains.`,
        });
        await d.jobs.completeJob(UNRECOGNISED_WRITE_ALERT_JOB, txHash, now);
        alertsDelivered.push(txHash);
      } catch (err) {
        const error = errMessage(err);
        await d.jobs.failJob(UNRECOGNISED_WRITE_ALERT_JOB, txHash, now, error);
        alertErrors.push({ txHash, error });
        break; // retried on a later tick, not in a tight loop
      }
    }
    return { alertsDelivered, alertErrors };
  }

  /**
   * Index `wallets` against one `latestBlock` read for the whole pass. One wallet's error never stops the others.
   * A wallet cooling down is reported with `coolingDownUntil` and skipped (no chain call; none at all when every
   * wallet is cooling down).
   */
  async function indexWallets(list: readonly BoundWallet[], now: Date): Promise<WalletIndexReport[]> {
    const empty = (w: BoundWallet) => ({ policyWallet: w.policyWallet, scope: w.scope, chunks: 0, confirmed: 0, external: 0, paid: 0, alerts: 0 });
    const skipped = new Map<Hex, Date>();
    for (const w of list) {
      const until = cooldownOf(w.policyWallet, now);
      if (until !== undefined) skipped.set(w.policyWallet, new Date(until));
    }
    const due = list.filter((w) => !skipped.has(w.policyWallet));
    const reports = new Map<BoundWallet, WalletIndexReport>();
    if (due.length > 0) {
      let latest: bigint | undefined;
      try {
        latest = await d.reader.latestBlock();
      } catch (err) {
        const error = errMessage(err);
        for (const w of due) {
          const until = coolDown(w.policyWallet, err, now);
          reports.set(w, { ...empty(w), error, ...(until === undefined ? {} : { coolingDownUntil: until }) });
        }
      }
      if (latest !== undefined) for (const w of due) reports.set(w, await indexWallet(w, latest, now));
    }
    return list.map((w) => {
      const until = skipped.get(w.policyWallet);
      return until !== undefined ? { ...empty(w), coolingDownUntil: until } : (reports.get(w) as WalletIndexReport);
    });
  }

  return {
    /** The fast lane (AD-20): index only `wallets` (those with a write in flight); no reconcile, no alert delivery. */
    indexWallets,
    /** One fast-lane pass over the wallets with a write in flight (`walletsWithSubmittedIntents`). */
    async runInflight(now: Date): Promise<Pick<IndexerReport, "wallets">> {
      return { wallets: await indexWallets(await d.store.walletsWithSubmittedIntents(), now) };
    },
    async run(now: Date): Promise<IndexerReport> {
      const wallets = await indexWallets(await d.store.boundWallets(), now);
      let reconciled = 0;
      let reconcileError: string | undefined;
      try {
        reconciled = await d.store.reconcileReceipts(now);
      } catch (err) {
        reconcileError = errMessage(err);
      }
      let alerts: Pick<IndexerReport, "alertsDelivered" | "alertErrors">;
      try {
        alerts = await deliverAlerts(now);
      } catch (err) {
        alerts = { alertsDelivered: [], alertErrors: [{ txHash: "", error: errMessage(err) }] };
      }
      return { wallets, reconciled, ...(reconcileError === undefined ? {} : { reconcileError }), ...alerts };
    },
  };
}

export type Indexer = ReturnType<typeof createIndexer>;

/** One indexer pass (`createIndexer(deps).run(now)`); a fresh instance, so no cooldown carries over. */
export async function runIndexer(deps: IndexerDeps, now: Date): Promise<IndexerReport> {
  return createIndexer(deps).run(now);
}

/** One fast-lane indexer pass over the wallets with a write in flight (`walletsWithSubmittedIntents`). */
export async function runInflightIndexer(deps: IndexerDeps, now: Date): Promise<Pick<IndexerReport, "wallets">> {
  return createIndexer(deps).runInflight(now);
}
