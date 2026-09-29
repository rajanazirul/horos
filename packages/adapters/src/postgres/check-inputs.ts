// Postgres reads behind one Check (Story 2.9, AD-3, AD-11, AD-14): history, identity bindings, the pending
// intent target, nonce use, and the idempotent Standard Preset PolicyVersion for a fresh Scope. The only write
// here is `ensurePresetPolicy`, an insert-only PolicyVersion (seq 1) that loses a race harmlessly.
import { identityKeys, SeqConflictError, STANDARD_PRESET, toOffchainPolicy, type IdentityBinding, type PolicyVersionStore } from "@horos/core";
import { Address, Bytes32, DeclaredIdentity, PolicyVersion, Scope, toWireTime, UuidV7, type Hex } from "@horos/schema";
import { and, asc, eq, or, sql, type SQL } from "drizzle-orm";
import { uuidv7 } from "../ids.js";
import type { HorosDb } from "./db.js";
import { PostgresPolicyVersionStore } from "./policy-version-store.js";
import { counterpartyMirror, decisionRecord, outboxIntent, paidEvent, usedNonce } from "./schema.js";

/**
 * A SQL pre-filter matching every record whose Declared Identity could produce `key` (a superset; the caller
 * recomputes exact keys). `identityKeys` lowercases after NFKC and only removes characters or trims prefixes and
 * suffixes, so an ASCII key's letters and digits appear contiguously in the raw field's NFKC-lowercased letters and
 * digits. A key with non-ASCII characters falls back to every record with that field.
 */
function keyFilter(key: string): SQL {
  const sep = key.indexOf(":");
  const field = key.slice(0, sep);
  const value = key.slice(sep + 1);
  if (field !== "name" && field !== "domain") return sql`false`;
  const raw = sql`(${decisionRecord.record}->'declaredIdentity'->'value'->>${field})`;
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/u.test(value)) return sql`${raw} IS NOT NULL`;
  const compact = value.replace(/[^a-z0-9]/gu, "");
  return sql`strpos(regexp_replace(lower(normalize(${raw}, NFKC)), '[^a-z0-9]', '', 'g'), ${compact}) > 0`;
}

export class PostgresCheckInputs {
  private readonly policies: PolicyVersionStore;

  constructor(
    private readonly db: HorosDb,
    private readonly newId: (nowMs: number) => string = uuidv7,
    policies?: PolicyVersionStore,
  ) {
    this.policies = policies ?? new PostgresPolicyVersionStore(db);
  }

  /** A mirrored registration or any indexed `Paid` for `(scope, a)`. */
  async hasHistory(scope: string, counterparty: Hex): Promise<boolean> {
    const a = Address.parse(counterparty);
    const mirrored = await this.db
      .select({ registered: counterpartyMirror.registered })
      .from(counterpartyMirror)
      .where(and(eq(counterpartyMirror.scope, scope), eq(counterpartyMirror.address, a), eq(counterpartyMirror.registered, true)))
      .limit(1);
    if (mirrored.length > 0) return true;
    const paid = await this.db
      .select({ txHash: paidEvent.txHash })
      .from(paidEvent)
      .where(and(eq(paidEvent.scope, scope), eq(paidEvent.counterparty, a)))
      .limit(1);
    return paid.length > 0;
  }

  /**
   * `{key, address}` for the identity keys in `keys` bound by the Scope's DecisionRecords, by seq. Only records whose
   * Declared Identity can share one of `keys` are read: SQL pre-filters on the `name`/`domain` jsonb fields that
   * `identityKeys` uses (a superset, see `keyFilter`), then the exact keys are recomputed here. No keys, no query.
   */
  async identityBindings(scope: string, keys: readonly string[]): Promise<IdentityBinding[]> {
    const wanted = new Set(keys);
    if (wanted.size === 0) return [];
    const rows = await this.db
      .select({
        identity: sql<unknown>`${decisionRecord.record}->'declaredIdentity'->'value'`,
        counterparty: sql<string>`${decisionRecord.record}->>'counterparty'`,
      })
      .from(decisionRecord)
      .where(and(eq(decisionRecord.scope, scope), sql`${decisionRecord.record}->'declaredIdentity' IS NOT NULL`, or(...[...wanted].map(keyFilter))))
      .orderBy(asc(decisionRecord.seq));
    const out: IdentityBinding[] = [];
    for (const r of rows) {
      const identity = DeclaredIdentity.safeParse(r.identity);
      const address = Address.safeParse(r.counterparty);
      if (!identity.success || !address.success) continue;
      for (const key of identityKeys(identity.data)) if (wanted.has(key)) out.push({ key, address: address.data });
    }
    return out;
  }

  /** The target of the `pending` outbox intent for `(scope, a)`, if any. */
  async pendingIntentTarget(scope: string, counterparty: Hex): Promise<bigint | undefined> {
    const rows = await this.db
      .select({ target: outboxIntent.target })
      .from(outboxIntent)
      .where(and(eq(outboxIntent.scope, scope), eq(outboxIntent.counterparty, Address.parse(counterparty)), eq(outboxIntent.status, "pending")))
      .limit(1);
    return rows[0] === undefined ? undefined : BigInt(rows[0].target);
  }

  async nonceUsed(scope: string, nonce: Hex): Promise<boolean> {
    const rows = await this.db
      .select({ nonce: usedNonce.nonce })
      .from(usedNonce)
      .where(and(eq(usedNonce.scope, scope), eq(usedNonce.nonce, Bytes32.parse(nonce))))
      .limit(1);
    return rows.length > 0;
  }

  /** The tx hash of the intent holding `recordId`, once mined. */
  async intentTxHash(scope: string, counterparty: Hex, recordId: string): Promise<Hex | undefined> {
    const rows = await this.db
      .select({ txHash: outboxIntent.txHash })
      .from(outboxIntent)
      .where(
        and(
          eq(outboxIntent.scope, scope),
          eq(outboxIntent.counterparty, Address.parse(counterparty)),
          sql`${recordId}::uuid = ANY(${outboxIntent.recordIds})`,
          sql`${outboxIntent.txHash} IS NOT NULL`,
        ),
      )
      .orderBy(sql`${outboxIntent.status} = 'noop'`)
      .limit(1);
    const h = rows[0]?.txHash;
    return h === undefined || h === null ? undefined : Bytes32.parse(h);
  }

  /**
   * Insert the exact Standard Preset copy as seq 1 of `scope` when it has no PolicyVersion, and return the active
   * version. Idempotent: losing a concurrent insert (seq conflict) returns the winner's row.
   */
  async ensurePresetPolicy(scope: string, now: Date): Promise<PolicyVersion> {
    const s = Scope.parse(scope);
    const existing = await this.policies.active(s);
    if (existing !== undefined) return existing;
    const row = PolicyVersion.parse({
      id: UuidV7.parse(this.newId(now.getTime())),
      scope: s,
      seq: 1,
      presetVersion: STANDARD_PRESET.version,
      activation: "preset",
      policy: toOffchainPolicy(STANDARD_PRESET.offchain),
      createdAt: toWireTime(now),
    });
    try {
      await this.policies.insert(row);
      return row;
    } catch (err) {
      if (!(err instanceof SeqConflictError)) throw err;
    }
    const winner = await this.policies.active(s);
    if (winner === undefined) throw new Error(`seq conflict on ${s} but no active PolicyVersion`);
    return winner;
  }
}
