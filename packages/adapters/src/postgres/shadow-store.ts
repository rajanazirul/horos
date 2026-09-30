// Shadow Mode store (Story 3.4, FR-28, AD-7, AD-25): self-serve sign-up and API keys, the `shadow_closed` test, the
// Postgres virtual ledger and the per-Scope outcome counts.
//   - Sign-up finds or creates the Customer by Payment address, ensures its `shadow:<customerId>` Scope, revokes the
//     active key and issues a fresh `hsk_<base64url(32 bytes)>` key. Only the key's sha256 is stored; the key itself
//     is returned once and never logged.
//   - The virtual ledger holds what a shadow Scope's Decisions would have written on-chain: per-Counterparty
//     Registration / Limit / pin rows and the three day-bucket rings, computed by the TypeScript port of the
//     contract's rolling window (`../shadow/rolling-window.ts`). `apply` runs inside the record-append transaction
//     (under the Scope head lock), so a record and its virtual effect never diverge.
// Every ledger method refuses a non-shadow Scope: enforced code never reads or writes these tables.
import { createHash, randomBytes } from "node:crypto";
import { findPreset, ShadowClosedError, STANDARD_PRESET, type ChainView, type ExtraWrites, type OutboxIntent } from "@horos/core";
import { Address, Bytes32, ShadowApiKey, ShadowScope, SHADOW_API_KEY_PREFIX, type Hex, type ShadowSummary } from "@horos/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { uuidv7 } from "../ids.js";
import {
  dayIndexAt,
  recordSlot,
  remainingView,
  UNKNOWN_COUNTERPARTY,
  type CounterpartyWindowState,
  type Ring,
  type Slot,
  type WindowPolicy,
} from "../shadow/rolling-window.js";
import type { HorosDb } from "./db.js";
import { PostgresRecordStore, type HorosTx } from "./record-store.js";
import { accountNonce, customer, decisionRecord, enforcedBinding, shadowApiKey, shadowLedgerCounterparty, shadowLedgerSlot } from "./schema.js";

/** The default shadow window Policy: the Standard Preset's on-chain part (500 USDC ceiling, 5,000 USDC cap, 10 payees, 30 days). */
export const SHADOW_WINDOW_POLICY: WindowPolicy = Object.freeze({
  firstContactCeiling: STANDARD_PRESET.onchain.firstContactCeiling,
  walletPeriodCap: STANDARD_PRESET.onchain.walletPeriodCap,
  newPayeeCap: BigInt(STANDARD_PRESET.onchain.newPayeeCap),
  policyPeriodDays: BigInt(STANDARD_PRESET.onchain.policyPeriodDays),
});

/** The window Policy of a PolicyVersion's Preset (its on-chain part); the Standard Preset's when the Preset is unknown. */
export function windowPolicyForPreset(presetVersion: string): WindowPolicy {
  const onchain = findPreset(presetVersion)?.onchain;
  if (onchain === undefined) return SHADOW_WINDOW_POLICY;
  return {
    firstContactCeiling: onchain.firstContactCeiling,
    walletPeriodCap: onchain.walletPeriodCap,
    newPayeeCap: BigInt(onchain.newPayeeCap),
    policyPeriodDays: BigInt(onchain.policyPeriodDays),
  };
}

const WALLET_RING = "wallet";
const NEW_PAYEE_RING = "new-payee";
const cpRing = (a: Hex): string => `cp:${a}`;

/** The virtual effect of one shadow Decision: the would-be outbox intent and the would-be payment. */
export interface ShadowLedgerEffect {
  /** The Decision's outbox intent (register / tighten / pin), applied virtually. */
  readonly intent?: OutboxIntent;
  /** Virtual spend: `amount` on `allow`, `payable_amount` on `cap`, 0 otherwise. */
  readonly spend: bigint;
}

export type ShadowSignupResult =
  | { readonly kind: "issued"; readonly customerId: string; readonly scope: string; readonly apiKey: string }
  | { readonly kind: "closed"; readonly customerId: string }
  | { readonly kind: "replayed" };

export interface ShadowKeyOwner {
  readonly customerId: string;
  readonly scope: string;
}

/** A fresh `hsk_<base64url(32 random bytes)>` API key. */
export function newShadowApiKey(): string {
  return `${SHADOW_API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** The stored form of an API key: lowercase hex sha256. */
export function shadowKeyHash(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export interface PostgresShadowStoreOptions {
  readonly newId?: (nowMs: number) => string;
  /** Test seam; default `newShadowApiKey`. */
  readonly newKey?: () => string;
}

function shadowScope(scope: string): string {
  return ShadowScope.parse(scope);
}

export class PostgresShadowStore {
  private readonly newId: (nowMs: number) => string;
  private readonly newKey: () => string;

  constructor(
    private readonly db: HorosDb,
    opts: PostgresShadowStoreOptions = {},
  ) {
    this.newId = opts.newId ?? uuidv7;
    this.newKey = opts.newKey ?? newShadowApiKey;
  }

  /**
   * Find or create the Customer for `paymentAddress`, ensure its shadow Scope, revoke its active key and issue a new
   * one, in one transaction. `nonce` (a signed request's) is consumed first: a replay issues nothing. A Customer
   * whose enforced binding is `bound` gets `closed` and nothing is issued.
   */
  async signup(paymentAddress: Hex, now: Date, nonce?: Hex): Promise<ShadowSignupResult> {
    const payment = Address.parse(paymentAddress);
    const apiKey = ShadowApiKey.parse(this.newKey());
    return this.db.transaction(async (tx) => {
      if (nonce !== undefined) {
        const used = await tx
          .insert(accountNonce)
          .values({ paymentAddress: payment, nonce: Bytes32.parse(nonce), createdAt: now })
          .onConflictDoNothing({ target: [accountNonce.paymentAddress, accountNonce.nonce] })
          .returning({ nonce: accountNonce.nonce });
        if (used.length === 0) return { kind: "replayed" } as const;
      }
      await tx.insert(customer).values({ id: this.newId(now.getTime()), paymentAddress: payment, createdAt: now }).onConflictDoNothing({ target: customer.paymentAddress });
      const found = await tx.select({ id: customer.id }).from(customer).where(eq(customer.paymentAddress, payment)).limit(1);
      const customerId = found[0]?.id;
      if (customerId === undefined) throw new Error("customer row missing after insert");
      // Serialise concurrent sign-ups of one Customer (one active key at a time).
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`shadow-signup:${customerId}`}, 0))`);
      // FOR SHARE: a concurrent bind waits for this sign-up, and a committed bind is seen here.
      if (await this.isClosed(customerId, tx, true)) return { kind: "closed", customerId } as const;
      const scope = `shadow:${customerId}`;
      await new PostgresRecordStore(this.db).ensureScope({ id: scope, customerId }, tx);
      await tx
        .update(shadowApiKey)
        .set({ revokedAt: now })
        .where(and(eq(shadowApiKey.customerId, customerId), isNull(shadowApiKey.revokedAt)));
      await tx.insert(shadowApiKey).values({ keyHash: shadowKeyHash(apiKey), customerId, scope, createdAt: now });
      return { kind: "issued", customerId, scope, apiKey } as const;
    });
  }

  /** The owner of an active API key, or undefined (unknown, malformed or revoked). Compared by hash lookup only. */
  async resolveKey(key: string): Promise<ShadowKeyOwner | undefined> {
    if (!ShadowApiKey.safeParse(key).success) return undefined;
    const rows = await this.db
      .select({ customerId: shadowApiKey.customerId, scope: shadowApiKey.scope })
      .from(shadowApiKey)
      .where(and(eq(shadowApiKey.keyHash, shadowKeyHash(key)), isNull(shadowApiKey.revokedAt)))
      .limit(1);
    return rows[0];
  }

  /** True once the Customer's enforced binding is `bound`: Shadow Mode is closed for good (nothing migrates). */
  async isClosed(customerId: string, conn: HorosDb | HorosTx = this.db, lock = false): Promise<boolean> {
    const q = conn.select({ status: enforcedBinding.status }).from(enforcedBinding).where(eq(enforcedBinding.customerId, customerId)).limit(1);
    const rows = lock ? await q.for("share") : await q;
    return rows[0]?.status === "bound";
  }

  private async counterparty(conn: HorosDb | HorosTx, scope: string, a: Hex, lock = false): Promise<CounterpartyWindowState | undefined> {
    const q = conn
      .select({ limit: shadowLedgerCounterparty.limit, registered: shadowLedgerCounterparty.registered, pinned: shadowLedgerCounterparty.pinned })
      .from(shadowLedgerCounterparty)
      .where(and(eq(shadowLedgerCounterparty.scope, scope), eq(shadowLedgerCounterparty.counterparty, a)))
      .limit(1);
    const rows = lock ? await q.for("update") : await q;
    const r = rows[0];
    return r === undefined ? undefined : { limit: BigInt(r.limit), registered: r.registered, pinned: r.pinned, humanSet: false, humanEpoch: 0n };
  }

  private async rings(conn: HorosDb | HorosTx, scope: string, a: Hex): Promise<{ counterparty: Ring; wallet: Ring; newPayees: Ring }> {
    const rows = await conn
      .select({ ring: shadowLedgerSlot.ring, slotIndex: shadowLedgerSlot.slotIndex, dayIndex: shadowLedgerSlot.dayIndex, amount: shadowLedgerSlot.amount })
      .from(shadowLedgerSlot)
      .where(and(eq(shadowLedgerSlot.scope, scope), inArray(shadowLedgerSlot.ring, [WALLET_RING, NEW_PAYEE_RING, cpRing(a)])));
    const out = { counterparty: new Map<number, Slot>(), wallet: new Map<number, Slot>(), newPayees: new Map<number, Slot>() };
    for (const r of rows) {
      const target = r.ring === WALLET_RING ? out.wallet : r.ring === NEW_PAYEE_RING ? out.newPayees : out.counterparty;
      target.set(r.slotIndex, { dayIndex: r.dayIndex, amount: BigInt(r.amount) });
    }
    return out;
  }

  private async view(conn: HorosDb | HorosTx, scope: string, a: Hex, now: Date, policy: WindowPolicy): Promise<ChainView> {
    const [cp, rings] = await Promise.all([this.counterparty(conn, scope, a), this.rings(conn, scope, a)]);
    return remainingView(cp ?? UNKNOWN_COUNTERPARTY, rings, policy, dayIndexAt(now));
  }

  /** The virtual `remaining(a)` of a shadow Scope at `now` under `policy` (the contract's `_remaining`, via the port). */
  async remaining(scope: string, counterparty: Hex, now: Date, policy: WindowPolicy = SHADOW_WINDOW_POLICY): Promise<ChainView> {
    return this.view(this.db, shadowScope(scope), Address.parse(counterparty), now, policy);
  }

  /** Virtual history: the Counterparty has a (virtual) Registration in this shadow Scope. */
  async hasHistory(scope: string, counterparty: Hex): Promise<boolean> {
    const cp = await this.counterparty(this.db, shadowScope(scope), Address.parse(counterparty));
    return cp?.registered === true;
  }

  private async recordInto(tx: HorosTx, scope: string, ring: string, today: number, amount: bigint): Promise<void> {
    const index = today % 91;
    const rows = await tx
      .select({ dayIndex: shadowLedgerSlot.dayIndex, amount: shadowLedgerSlot.amount })
      .from(shadowLedgerSlot)
      .where(and(eq(shadowLedgerSlot.scope, scope), eq(shadowLedgerSlot.ring, ring), eq(shadowLedgerSlot.slotIndex, index)))
      .limit(1);
    const current: Ring = rows[0] === undefined ? new Map() : new Map([[index, { dayIndex: rows[0].dayIndex, amount: BigInt(rows[0].amount) }]]);
    const [slotIndex, slot] = recordSlot(current, today, amount);
    await tx
      .insert(shadowLedgerSlot)
      .values({ scope, ring, slotIndex, dayIndex: slot.dayIndex, amount: slot.amount.toString() })
      .onConflictDoUpdate({
        target: [shadowLedgerSlot.scope, shadowLedgerSlot.ring, shadowLedgerSlot.slotIndex],
        set: { dayIndex: slot.dayIndex, amount: slot.amount.toString() },
      });
  }

  private async upsertCounterparty(tx: HorosTx, scope: string, a: Hex, next: CounterpartyWindowState): Promise<void> {
    const values = { limit: next.limit.toString(), registered: next.registered, pinned: next.pinned };
    await tx
      .insert(shadowLedgerCounterparty)
      .values({ scope, counterparty: a, ...values })
      .onConflictDoUpdate({ target: [shadowLedgerCounterparty.scope, shadowLedgerCounterparty.counterparty], set: values });
  }

  /**
   * The `extraWrites` applying one shadow Decision's virtual effect, committed with its record (under the Scope head
   * lock, so every read here sees the previous Check's writes). Throws `ShadowClosedError` (nothing is written) when
   * the Customer's binding is `bound`; the binding row is read `FOR SHARE`, so a concurrent bind waits. Mirrors what the
   * enforced outbox write and `PolicyWallet.pay` would do on-chain:
   *   - `register`: first contact only (not registered, not pinned) at the intent's target; a target above 0 records
   *     one new payee. A registration the contract would refuse (above the ceiling, or New-Payee Cap used up) is skipped.
   *   - `tighten`: the Limit becomes `min(limit, target)`.
   *   - `pin`: the Limit becomes 0 and pinned (an unknown Counterparty becomes Registered at 0, no new payee).
   *   - then `spend` is recorded into the Counterparty ring and the wallet ring, re-read after the intent: only for a
   *     registered, unpinned Counterparty, and clamped to `min(spend, cpRemaining, walletRemaining)`.
   */
  apply(scope: string, counterparty: Hex, effect: ShadowLedgerEffect, now: Date, policy: WindowPolicy = SHADOW_WINDOW_POLICY): ExtraWrites<HorosTx> {
    const s = shadowScope(scope);
    const a = Address.parse(counterparty);
    const customerId = s.slice("shadow:".length);
    return async (tx, record) => {
      if (record.scope !== s || record.counterparty !== a) throw new Error("shadow ledger effect does not match the record");
      if (await this.isClosed(customerId, tx, true)) throw new ShadowClosedError(customerId);
      const today = dayIndexAt(now);
      const intent = effect.intent;
      if (intent !== undefined) {
        const cp = (await this.counterparty(tx, s, a, true)) ?? UNKNOWN_COUNTERPARTY;
        if (intent.kind === "register") {
          const view = await this.view(tx, s, a, now, policy);
          const refused = cp.registered || cp.pinned || intent.target > policy.firstContactCeiling || (intent.target > 0n && view.newPayeeRemaining === 0n);
          if (!refused) {
            await this.upsertCounterparty(tx, s, a, { ...cp, registered: true, limit: intent.target });
            if (intent.target > 0n) await this.recordInto(tx, s, NEW_PAYEE_RING, today, 1n);
          }
        } else if (intent.kind === "tighten") {
          if (intent.target < cp.limit) await this.upsertCounterparty(tx, s, a, { ...cp, limit: intent.target });
        } else {
          await this.upsertCounterparty(tx, s, a, { ...cp, registered: true, limit: 0n, pinned: true });
        }
      }
      if (effect.spend > 0n) {
        // Re-read after the intent: `pay` would revert for an unregistered or pinned payee, and never exceeds a budget.
        const view = await this.view(tx, s, a, now, policy);
        if (view.registered && !view.pinned) {
          let spend = effect.spend;
          if (view.cpRemaining < spend) spend = view.cpRemaining;
          if (view.walletRemaining < spend) spend = view.walletRemaining;
          if (spend > 0n) {
            await this.recordInto(tx, s, cpRing(a), today, spend);
            await this.recordInto(tx, s, WALLET_RING, today, spend);
          }
        }
      }
    };
  }

  /** Decision counts per outcome label (`shadowOutcome`): `would_have_caught` = a non-simulated hold or block. */
  async summary(scope: string): Promise<ShadowSummary> {
    const s = shadowScope(scope);
    const decision = sql`${decisionRecord.record}->>'decision'`;
    const rows = await this.db
      .select({
        caught: sql<number>`count(*) FILTER (WHERE ${decision} IN ('hold', 'block') AND NOT coalesce((${decisionRecord.record}->>'simulated')::boolean, false))::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(decisionRecord)
      .where(and(eq(decisionRecord.scope, s), sql`${decisionRecord.record}->>'recordType' IS DISTINCT FROM 'external'`));
    const caught = rows[0]?.caught ?? 0;
    const total = rows[0]?.total ?? 0;
    return { advisory: total - caught, would_have_caught: caught };
  }
}
