// PolicyVersion store port (AD-1, AD-14). Rows are insert-only; the active version of a scope is
// the row with the highest `seq`.
import type { PolicyVersion, Scope } from "@horos/schema";

/** Thrown by `insert` when `(scope, seq)` already exists (a concurrent activation won). */
export class SeqConflictError extends Error {
  override readonly name = "SeqConflictError";
  constructor(
    readonly scope: string,
    readonly seq: number,
  ) {
    super(`policy version seq ${seq} already exists for scope ${scope}`);
  }
}

export interface PolicyVersionStore {
  /** The active (highest-`seq`) version of `scope`, or `undefined` when there is none. */
  active(scope: Scope): Promise<PolicyVersion | undefined>;
  /** Append a version. Throws `SeqConflictError` on a `(scope, seq)` collision. Never updates. */
  insert(row: PolicyVersion): Promise<void>;
}
