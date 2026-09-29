// Circle KeyProvisioner (AD-15): one wallet set per Customer and three EOAs on ARC-TESTNET with refIds
// registrar|model|rules. Idempotency keys derive from the Customer id, so a retry returns the same wallets.
import type { KeyProvisioner, ProvisionedKey, ProvisionedKeys } from "@horos/core";
import { Address } from "@horos/schema";
import { deterministicUuid, type CircleClient, type CircleWallet } from "./client.js";

const ROLES = ["registrar", "model", "rules"] as const;

export class CircleKeyProvisioner implements KeyProvisioner {
  constructor(private readonly client: CircleClient) {}

  async provision(customerId: string): Promise<ProvisionedKeys> {
    const set = await this.client.createWalletSet({ name: `horos-${customerId}`, idempotencyKey: customerId });
    const wallets = await this.client.createWallets({
      walletSetId: set.id,
      refIds: ROLES,
      idempotencyKey: deterministicUuid(`horos:provision-keys:${customerId}`),
    });
    const pick = (role: (typeof ROLES)[number]): ProvisionedKey => {
      const w: CircleWallet | undefined = wallets.find((x) => x.refId === role);
      if (w === undefined) throw new Error(`circle returned no ${role} wallet`);
      return { walletId: w.id, address: Address.parse(w.address) };
    };
    const keys = { walletSetId: set.id, registrar: pick("registrar"), model: pick("model"), rules: pick("rules") };
    if (new Set([keys.registrar.address, keys.model.address, keys.rules.address]).size !== 3) {
      throw new Error("circle returned duplicate role addresses");
    }
    return keys;
  }
}
