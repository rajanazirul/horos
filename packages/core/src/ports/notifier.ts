// Notifier port (AD-21): founder alerts such as a quarantined list update or an outbox write that keeps
// failing. Alerts carry no secrets and no Declared Identity; adapters deliver them (webhook in v1).
import type { ListSource } from "@horos/schema";

export type FounderAlert =
  | { readonly kind: "list-quarantined"; readonly source: ListSource; readonly message: string }
  | {
      readonly kind: "outbox-retry-exhausted";
      readonly scope: string;
      readonly counterparty: string;
      readonly intentId: string;
      readonly message: string;
    }
  | {
      /** A Registrar/Model/Rules key sent a PolicyWallet write that no Horos outbox intent explains (Story 2.7). */
      readonly kind: "unrecognised-horos-write";
      readonly scope: string;
      readonly policyWallet: string;
      readonly txHash: string;
      readonly actor: "registrar" | "model" | "rules";
      readonly message: string;
    }
  | {
      /** A worker tick ran past MAX_TICK_MS; the worker exits so the platform restarts it (Story 2.10). */
      readonly kind: "worker-tick-timeout";
      readonly maxTickMs: number;
      readonly message: string;
    };

export type FounderAlertKind = FounderAlert["kind"];

export interface Notifier {
  /** Deliver one alert. Rejects when delivery fails; callers decide whether that is fatal. */
  notify(alert: FounderAlert): Promise<void>;
}
