// Key provisioning job (AD-15, AD-20): `('provision-keys', customerId)` rows, ensured by the onboarding
// endpoint, claimed with SKIP LOCKED. The provisioner is idempotent per Customer, so a retry after a crash
// returns the same wallets. Only the worker receives the Circle credentials.
import { PROVISION_KEYS_JOB, type PostgresJobStore } from "@horos/adapters";
import type { AccountStore, KeyProvisioner } from "@horos/core";

export interface ProvisionDeps {
  readonly jobs: PostgresJobStore;
  readonly accounts: AccountStore;
  readonly provisioner: KeyProvisioner;
  /** Jobs handled per tick. Default 5. */
  readonly maxPerTick?: number;
  /** Attempts before a provisioning job stays failed. Default 10. */
  readonly maxAttempts?: number;
}

export interface ProvisionReport {
  readonly provisioned: readonly string[];
  readonly failed: readonly { readonly customerId: string; readonly error: string }[];
}

export async function runProvisioning(deps: ProvisionDeps, now: Date): Promise<ProvisionReport> {
  const provisioned: string[] = [];
  const failed: { customerId: string; error: string }[] = [];
  const max = deps.maxPerTick ?? 5;
  for (let i = 0; i < max; i++) {
    const claimed = await deps.jobs.claimJob(PROVISION_KEYS_JOB, { now, maxAttempts: deps.maxAttempts ?? 10 });
    if (claimed === undefined) break;
    const customerId = claimed.window;
    try {
      const keys = await deps.provisioner.provision(customerId);
      await deps.accounts.setKeys(customerId, keys, now);
      await deps.jobs.completeJob(PROVISION_KEYS_JOB, customerId, now);
      provisioned.push(customerId);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await deps.jobs.failJob(PROVISION_KEYS_JOB, customerId, now, error);
      failed.push({ customerId, error });
      break; // a failed job is retried on a later tick, not in a tight loop
    }
  }
  return { provisioned, failed };
}
