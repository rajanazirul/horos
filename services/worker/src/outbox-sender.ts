// Outbox sender (AD-8, AD-15, Story 2.6). Each full tick: recover crashed sends, poll submitted writes for their
// tx hash, then claim due intents one lane at a time. The fast lane (AD-20) runs `claim` every wake and `poll` on
// its own cadence. At send time the chain is re-read and the intent is
// converted: pin → `pin`; unregistered → Hard Rules re-check, then `register(min(target, live FCC))`;
// registered and tighter → `tighten(target, epoch)`; otherwise `noop`. Every write is pre-flighted with
// `eth_call` from the signing role. There is no Raise path: no `setLimit`, and `tighten` only below the Limit.
import { deterministicUuid, type HorosTx } from "@horos/adapters";
import {
  buildCorrectingRecord,
  evaluateHardRules,
  outboxBackoffMs,
  OUTBOX_ALERT_ATTEMPTS,
  signingRoleOf,
  type AccountStore,
  type Binding,
  type ChainReader,
  type ChainWriter,
  type CorrectionCause,
  type ListSnapshot,
  type Notifier,
  type OutboxIntentRow,
  type OutboxStore,
  type PolicyWalletCall,
  type RecordStore,
  type WriteSigner,
} from "@horos/core";
import { classifyContractError, redactUrls, Scope, toWireTime } from "@horos/schema";

export interface OutboxSenderDeps {
  readonly accounts: AccountStore;
  readonly outbox: OutboxStore<HorosTx>;
  readonly records: RecordStore<HorosTx>;
  readonly reader: ChainReader;
  readonly writer: ChainWriter;
  readonly notifier: Notifier;
  /** The latest active list snapshots (the send-time Hard Rules re-check). */
  readonly loadLists: () => Promise<ListSnapshot[]>;
  /** A fresh UUIDv7 for correcting records. */
  readonly newId: (nowMs: number) => string;
  /** Intents claimed per tick. Default 20. */
  readonly maxPerTick?: number;
  /** A `sending` intent untouched this long is presumed crashed and re-queued. Default 10 minutes. */
  readonly staleSendMs?: number;
}

export type IntentOutcome =
  | { readonly id: string; readonly kind: "submitted"; readonly fn: PolicyWalletCall["fn"]; readonly txId: string }
  | { readonly id: string; readonly kind: "noop" }
  | { readonly id: string; readonly kind: "failed"; readonly error: string }
  | { readonly id: string; readonly kind: "hard-rule" }
  | { readonly id: string; readonly kind: "retry"; readonly error: string; readonly attempts: number };

export interface OutboxReport {
  readonly recovered: number;
  readonly polled: readonly (IntentOutcome | { readonly id: string; readonly kind: "tx-hash" | "waiting"; readonly error?: string })[];
  readonly processed: readonly IntentOutcome[];
}

/** An error message safe to store and alert: every URL (RPC endpoints may embed API keys) reduced to its origin. */
const errMessage = (err: unknown): string => redactUrls(err instanceof Error ? err.message : String(err));

function signer(binding: Binding, role: "registrar" | "rules"): WriteSigner {
  const key = binding.keys?.[role];
  if (key === undefined) throw new Error(`binding has no ${role} key`);
  return { address: key.address, circleWalletId: key.walletId };
}

export function createOutboxSender(d: OutboxSenderDeps) {
  /** Append one correcting record for `intent` and end it as failed, in one transaction. */
  async function correct(intent: OutboxIntentRow, cause: CorrectionCause, error: string, now: Date): Promise<void> {
    const prior = await d.outbox.recordByHash(intent.sendRecordHash);
    if (prior === undefined) throw new Error(`no record with hash ${intent.sendRecordHash}`);
    const id = d.newId(now.getTime());
    const createdAt = toWireTime(now);
    await d.records.append({
      scope: Scope.parse(intent.scope),
      build: (seq, prevHash) => buildCorrectingRecord(prior, cause, id, createdAt, seq, prevHash),
      extraWrites: async (tx, record, recordHash) => {
        if (cause.kind === "hard-rule") {
          await d.outbox.upsertInTx(tx, {
            scope: intent.scope,
            counterparty: intent.counterparty,
            laneRole: "rules",
            target: 0n,
            pin: true,
            humanEpoch: intent.humanEpoch,
            recordId: record.id,
            recordHash,
            now,
          });
        }
        await d.outbox.markFailedInTx(tx, intent.id, error, now);
      },
    });
  }

  async function terminal(intent: OutboxIntentRow, rawErrorName: string, now: Date): Promise<IntentOutcome> {
    const errorName = redactUrls(rawErrorName);
    await correct(intent, { kind: "write-failed", error: errorName }, errorName, now);
    return { id: intent.id, kind: "failed", error: errorName };
  }

  async function retry(intent: OutboxIntentRow, rawError: string, now: Date): Promise<IntentOutcome> {
    const error = redactUrls(rawError);
    const attempts = intent.attempts + 1;
    let alerted = intent.alerted;
    if (!alerted && attempts >= OUTBOX_ALERT_ATTEMPTS) {
      try {
        await d.notifier.notify({
          kind: "outbox-retry-exhausted",
          scope: intent.scope,
          counterparty: intent.counterparty,
          intentId: intent.id,
          message: `Limit write for ${intent.counterparty} failed ${attempts} times (${error.slice(0, 200)}); still retrying.`,
        });
        alerted = true;
      } catch {
        // Delivery failed: leave `alerted` false so the next failure tries again.
      }
    }
    await d.outbox.markRetry(intent.id, { error, nextAttemptAt: new Date(now.getTime() + outboxBackoffMs(attempts)), alerted }, now);
    return { id: intent.id, kind: "retry", error, attempts };
  }

  /** `retry`, but a failure to record it (e.g. a DB error) becomes an outcome instead of aborting the pass. */
  async function safeRetry(intent: OutboxIntentRow, error: string, now: Date): Promise<IntentOutcome> {
    try {
      return await retry(intent, error, now);
    } catch (err) {
      return { id: intent.id, kind: "retry", error: `${redactUrls(error)}; recording the retry failed: ${errMessage(err)}`, attempts: intent.attempts };
    }
  }

  /** Decide the call for a claimed intent, or a terminal outcome that needs no transaction. */
  async function convert(intent: OutboxIntentRow, binding: Binding, now: Date): Promise<PolicyWalletCall | IntentOutcome> {
    const wallet = binding.policyWallet;
    if (wallet === null) throw new Error("binding has no PolicyWallet");
    const a = intent.counterparty;
    const h = intent.sendRecordHash;
    if (intent.pin) return { fn: "pin", counterparty: a, recordHash: h };
    const view = await d.reader.remaining(wallet, a);
    if (!view.registered) {
      const hardRules = evaluateHardRules(a, await d.loadLists(), now.getTime());
      if (hardRules.matched) {
        await correct(intent, { kind: "hard-rule", hardRules: hardRules.evidence }, "hard-rule match at send time", now);
        return { id: intent.id, kind: "hard-rule" };
      }
      // Same freshness rule as the Check path (core): a missing or stale SDN list never lets a register through.
      if (hardRules.sdnStale) return retry(intent, "sanctions list stale", now);
      const policy = await d.reader.policy(wallet);
      const limit = intent.target < policy.firstContactCeiling ? intent.target : policy.firstContactCeiling;
      return { fn: "register", counterparty: a, limit, recordHash: h };
    }
    if (intent.target < view.limit) {
      return { fn: "tighten", counterparty: a, limit: intent.target, expectedEpoch: intent.humanEpoch, recordHash: h };
    }
    await d.outbox.markNoop(intent.id, now);
    return { id: intent.id, kind: "noop" };
  }

  async function process(intent: OutboxIntentRow, now: Date): Promise<IntentOutcome> {
    let binding: Binding | undefined;
    let call: PolicyWalletCall;
    let from: WriteSigner;
    try {
      binding = await d.accounts.bindingByScope(intent.scope);
      if (binding?.status !== "bound" || binding.policyWallet === null || binding.keys === null) {
        return await retry(intent, "the Scope's binding is not bound with provisioned keys", now);
      }
      const c = await convert(intent, binding, now);
      if ("kind" in c) return c;
      call = c;
      from = signer(binding, signingRoleOf(call));
      const sim = await d.reader.simulate(binding.policyWallet, call, from.address);
      if (!sim.ok) {
        if (classifyContractError(sim.revert) === "terminal") return await terminal(intent, sim.revert, now);
        return await retry(intent, `pre-flight reverted: ${sim.revert}`, now);
      }
    } catch (err) {
      return safeRetry(intent, errMessage(err), now);
    }
    let txId: string;
    try {
      ({ txId } = await d.writer.send({
        policyWallet: binding.policyWallet,
        call,
        signer: from,
        // Seeded with everything the call carries, so an intent re-coalesced after a crash never dedupes to an older call.
        idempotencyKey: deterministicUuid(
          `horos:outbox:${intent.id}:${intent.attempts}:${intent.target}:${intent.pin}:${intent.sendRecordHash}`,
        ),
        refId: intent.id,
      }));
    } catch (err) {
      return safeRetry(intent, `send failed: ${errMessage(err)}`, now);
    }
    await d.outbox.markSubmitted(intent.id, txId, now);
    return { id: intent.id, kind: "submitted", fn: call.fn, txId };
  }

  /** Poll every submitted intent still without a tx hash for its Circle status. No submitted intent: no Circle call. */
  async function poll(now: Date): Promise<OutboxReport["polled"]> {
    const polled: OutboxReport["polled"][number][] = [];
    for (const intent of await d.outbox.listAwaitingTx()) {
      if (intent.circleTxId === null) continue;
      let status;
      try {
        status = await d.writer.status(intent.circleTxId);
      } catch {
        polled.push({ id: intent.id, kind: "waiting" });
        continue;
      }
      try {
        switch (status.state) {
          case "pending":
            polled.push({ id: intent.id, kind: "waiting" });
            break;
          case "complete":
            // Stays `submitted`: only the Story 2.7 indexer confirms (AD-24).
            await d.outbox.markTxHash(intent.id, status.txHash, now);
            polled.push({ id: intent.id, kind: "tx-hash" });
            break;
          case "failed":
            polled.push(await retry(intent, `write failed: ${status.error}`, now));
            break;
          case "denied":
          case "cancelled":
            polled.push(await terminal(intent, status.state === "denied" ? "CircleDenied" : "CircleCancelled", now));
            break;
        }
      } catch (err) {
        // One bad row never aborts the pass; it is polled again next tick.
        polled.push({ id: intent.id, kind: "waiting", error: errMessage(err) });
      }
    }
    return polled;
  }

  /** The claim step: claim and send due intents, one lane at a time, up to `maxPerTick`. */
  async function claim(now: Date): Promise<IntentOutcome[]> {
    const processed: IntentOutcome[] = [];
    const max = d.maxPerTick ?? 20;
    for (let i = 0; i < max; i++) {
      const intent = await d.outbox.claimNext(now);
      if (intent === undefined) break;
      try {
        processed.push(await process(intent, now));
      } catch (err) {
        // e.g. markSubmitted failed: the intent stays `sending` and recoverStale re-queues it later.
        processed.push({ id: intent.id, kind: "retry", error: errMessage(err), attempts: intent.attempts });
      }
    }
    return processed;
  }

  return {
    poll,
    claim,
    /** The full pass: recover crashed sends, poll submitted writes, then claim. */
    async run(now: Date): Promise<OutboxReport> {
      const recovered = await d.outbox.recoverStale(new Date(now.getTime() - (d.staleSendMs ?? 10 * 60 * 1000)), now);
      const polled = await poll(now);
      const processed = await claim(now);
      return { recovered, polled, processed };
    },
  };
}

/** One sender pass (`createOutboxSender(deps).run(now)`). */
export async function runOutbox(deps: OutboxSenderDeps, now: Date): Promise<OutboxReport> {
  return createOutboxSender(deps).run(now);
}
