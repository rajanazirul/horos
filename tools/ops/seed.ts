// Test fixture for the restore drill (Story 2.10): two Scopes (one enforced, one shadow), each with a valid
// hash-chained run of Decision Records built by core exactly as the Check path builds them. `tamper` then edits
// one stored record in place (as a superuser, bypassing the app role's insert-only grants) so the drill's
// negative case can prove a break is caught and named. Fictional data only: no real Customer, wallet or payee.
import { decisionRecord, PostgresRecordStore, runMigrations, uuidv7, type HorosDb } from "@horos/adapters";
import { buildDecisionRecord, evaluate, STANDARD_PRESET, type ChainView, type ListSnapshot, type RecordContext } from "@horos/core";
import { toWireTime, type Scope } from "@horos/schema";
import { and, eq } from "drizzle-orm";

export const DRILL_CUSTOMER = "01926f3a-7b2c-7d4e-8f10-2a3b4c5d6e7f";
export const DRILL_ENFORCED: Scope = "enforced:01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f80";
export const DRILL_SHADOW: Scope = `shadow:${DRILL_CUSTOMER}`;
const WALLET = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const USDC = 1_000_000n;

const lists: ListSnapshot[] = [
  { source: "ofac-sdn", snapshotId: "drill-sdn", snapshotHash: `0x${"a".repeat(64)}`, entries: new Map(), lastVerifiedAt: NOW },
];
const view: ChainView = {
  cpRemaining: 0n,
  walletRemaining: 5_000n * USDC,
  newPayeeRemaining: 10n,
  limit: 0n,
  pinned: false,
  registered: false,
  humanSet: false,
  humanEpoch: 0n,
};

function context(scope: Scope, i: number): RecordContext {
  const counterparty = `0x${(i + 1).toString(16).padStart(40, "1")}`;
  const amount = BigInt(10 + i) * USDC;
  return {
    id: uuidv7(NOW + i),
    scope,
    createdAt: toWireTime(new Date(NOW + i * 1000)),
    trigger: "check",
    channel: "api",
    customerId: DRILL_CUSTOMER,
    policyWallet: WALLET,
    counterparty,
    amount,
    skippedQuestions: [],
    questionSetVersion: "v1",
    policyVersionId: "01926f3a-7b2c-7e00-a000-000000000001",
    presetVersion: STANDARD_PRESET.version,
    chainView: view,
    chainState: "live",
    evaluation: evaluate({
      counterparty,
      amount,
      now: NOW + i * 1000,
      lists,
      chain: { view, payeeIsContract: false, firstContactCeiling: STANDARD_PRESET.onchain.firstContactCeiling },
      chainState: "live",
      hasHistory: false,
      identityBindings: [],
      policy: STANDARD_PRESET.offchain,
    }),
  };
}

/** Migrate `db`, create the two drill Scopes and append `perScope` records to each. */
export async function seedDrillScopes(db: HorosDb, perScope = 3): Promise<readonly Scope[]> {
  await runMigrations(db);
  const store = new PostgresRecordStore(db);
  await store.ensureScope({ id: DRILL_ENFORCED, customerId: DRILL_CUSTOMER, policyWallet: WALLET });
  await store.ensureScope({ id: DRILL_SHADOW, customerId: DRILL_CUSTOMER });
  for (const scope of [DRILL_ENFORCED, DRILL_SHADOW]) {
    for (let i = 0; i < perScope; i++) {
      const ctx = context(scope, i);
      await store.append({ scope, build: (seq, prev) => buildDecisionRecord(ctx, seq, prev) });
    }
  }
  return [DRILL_ENFORCED, DRILL_SHADOW];
}

/** Rewrite the stored amount of `scope`'s record at `seq` without re-hashing: a tampered record. */
export async function tamperRecord(db: HorosDb, scope: Scope, seq = 1): Promise<void> {
  const where = and(eq(decisionRecord.scope, scope), eq(decisionRecord.seq, seq));
  const rows = await db.select({ record: decisionRecord.record }).from(decisionRecord).where(where);
  const record = rows[0]?.record as Record<string, unknown> | undefined;
  if (record === undefined) throw new Error(`no record at seq ${seq} in ${scope}`);
  await db.update(decisionRecord).set({ record: { ...record, amount: "999000000" } }).where(where);
}
