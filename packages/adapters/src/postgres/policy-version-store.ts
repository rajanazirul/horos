// Postgres PolicyVersionStore (AD-14). Insert-only: no code path updates or deletes a row.
import { SeqConflictError, type PolicyVersionStore } from "@horos/core";
import { PolicyVersion, toWireTime, type Scope } from "@horos/schema";
import { desc, eq } from "drizzle-orm";
import type { HorosDb } from "./db.js";
import { policyVersion } from "./schema.js";

const UNIQUE_VIOLATION = "23505";
const SCOPE_SEQ_CONSTRAINT = "policy_version_scope_seq_unique";

/** The first error on `err` or its `cause` chain carrying a Postgres SQLSTATE (drizzle wraps driver errors). */
function pgError(err: unknown): { code: string; constraint?: unknown } | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && typeof cur === "object" && cur !== null; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return cur as { code: string; constraint?: unknown };
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Find a Postgres SQLSTATE on an error or its `cause` chain. */
export function pgErrorCode(err: unknown): string | undefined {
  return pgError(err)?.code;
}

/** The violated constraint name reported with a Postgres error, if any. */
export function pgErrorConstraint(err: unknown): string | undefined {
  const c = pgError(err)?.constraint;
  return typeof c === "string" ? c : undefined;
}

export class PostgresPolicyVersionStore implements PolicyVersionStore {
  constructor(private readonly db: HorosDb) {}

  async active(scope: Scope): Promise<PolicyVersion | undefined> {
    const rows = await this.db
      .select()
      .from(policyVersion)
      .where(eq(policyVersion.scope, scope))
      .orderBy(desc(policyVersion.seq))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return undefined;
    return PolicyVersion.parse({
      id: row.id,
      scope: row.scope,
      seq: row.seq,
      ...(row.parentId === null ? {} : { parentId: row.parentId }),
      presetVersion: row.presetVersion,
      activation: row.activation,
      policy: row.policy,
      createdAt: toWireTime(row.createdAt),
    });
  }

  async insert(row: PolicyVersion): Promise<void> {
    const v = PolicyVersion.parse(row);
    try {
      await this.db.insert(policyVersion).values({
        id: v.id,
        scope: v.scope,
        seq: v.seq,
        parentId: v.parentId ?? null,
        presetVersion: v.presetVersion,
        activation: v.activation,
        policy: v.policy,
        createdAt: new Date(v.createdAt),
      });
    } catch (err) {
      if (pgErrorCode(err) === UNIQUE_VIOLATION && pgErrorConstraint(err) === SCOPE_SEQ_CONSTRAINT) {
        throw new SeqConflictError(v.scope, v.seq);
      }
      throw err;
    }
  }
}
