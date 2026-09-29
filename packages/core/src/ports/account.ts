// Account store port (AD-11, AD-15, AD-25): Customers, their webhook, and the pending → bound enforced
// binding that reserves the `enforced:<uuid>` Scope before the PolicyWallet exists.
import type { Hex } from "@horos/schema";
import type { ProvisionedKeys } from "./key-provisioner.js";

export type BindingStatus = "pending" | "bound";

export interface Binding {
  readonly customerId: string;
  readonly paymentAddress: Hex;
  /** The reserved `enforced:<uuidv7>` Scope id; the `scope` row is created only at bind. */
  readonly scopeId: string;
  readonly status: BindingStatus;
  readonly policyWallet: Hex | null;
  /** Null until the worker has provisioned the keys. */
  readonly keys: ProvisionedKeys | null;
}

export interface OnboardInput {
  readonly paymentAddress: Hex;
  /** `""` when none. */
  readonly webhookUrl: string;
  readonly now: Date;
}

export interface OnboardResult {
  readonly binding: Binding;
  /** False when the Customer already existed (a repeat onboarding creates nothing). */
  readonly created: boolean;
}

export interface AccountStore {
  /**
   * In one transaction: create the Customer, its first webhook row and a pending binding, and ensure the
   * `('provision-keys', customerId)` job. Idempotent per payment address.
   */
  onboard(input: OnboardInput): Promise<OnboardResult>;
  bindingByPayment(paymentAddress: Hex): Promise<Binding | undefined>;
  bindingByWallet(policyWallet: Hex): Promise<Binding | undefined>;
  bindingByScope(scopeId: string): Promise<Binding | undefined>;
  /** Store provisioned keys (idempotent: an existing set is kept when equal, else throws). */
  setKeys(customerId: string, keys: ProvisionedKeys, now: Date): Promise<void>;
  /** Create the Scope row for the policy wallet and mark the binding bound (idempotent for the same wallet). */
  bind(customerId: string, policyWallet: Hex, now: Date): Promise<Binding>;
  /** Consume `(paymentAddress, nonce)` and insert a webhook row atomically. False (and nothing written) on replay. */
  updateWebhook(customerId: string, paymentAddress: Hex, nonce: Hex, url: string, now: Date): Promise<boolean>;
  /** The latest webhook URL (`""` when none). */
  webhookUrl(customerId: string): Promise<string>;
}
