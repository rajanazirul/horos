// Key provisioning port (AD-15): per-Customer Registrar, Model and Rules EOAs. The Circle adapter creates
// them as developer-controlled wallets; retries with the same Customer return the same wallets.
import type { Hex } from "@horos/schema";

export interface ProvisionedKey {
  readonly walletId: string;
  /** Lowercase address. */
  readonly address: Hex;
}

export interface ProvisionedKeys {
  readonly walletSetId: string;
  readonly registrar: ProvisionedKey;
  readonly model: ProvisionedKey;
  readonly rules: ProvisionedKey;
}

export interface KeyProvisioner {
  /** Idempotent per `customerId`. Rejects when the provider fails; the job retries. */
  provision(customerId: string): Promise<ProvisionedKeys>;
}
