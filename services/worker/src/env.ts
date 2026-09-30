// The worker's and the migrate command's environments (AD-15, AD-20), validated at boot.
// `CHAIN_WRITER=circle` needs both Circle secrets. `CHAIN_WRITER=local` (dev/CI only) needs `LOCAL_SIGNER_KEYS` with
// exactly the registrar, model and rules keys (never the Payment key), is allowed only on a local chain
// (`CHAIN_ID=31337`) or with `ALLOW_LOCAL_WRITER=1`, and is always refused under `NODE_ENV=production`, so a hosted
// worker can only sign through Circle.
import { DEFAULT_SDN_CSV_URL, httpUrl, intFromString, parseEnv, postgresUrl, sharedEnvShape, type EnvProblem, type EnvResult, type RawEnv } from "@horos/adapters";
import type { Hex } from "@horos/schema";
import { z } from "zod";

/** The roles the worker signs for. The Payment key belongs to the Customer's agent, never to Horos. */
export const SIGNER_ROLES = ["registrar", "model", "rules"] as const;

/** Anvil/Hardhat's chain id: the one chain where the local writer needs no explicit opt-in. */
export const LOCAL_CHAIN_ID = 31337;
export type SignerRole = (typeof SIGNER_ROLES)[number];

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

export const WorkerEnvSchema = z.object({
  ...sharedEnvShape,
  CHAIN_WRITER: z.enum(["circle", "local"], { message: "must be circle or local" }),
  // CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, LOCAL_SIGNER_KEYS and NODE_ENV are read conditionally below and never
  // kept on the parsed env except inside `chainWriter`.
  FOUNDER_ALERT_WEBHOOK_URL: httpUrl(),
  OFAC_SDN_URL: httpUrl().default(DEFAULT_SDN_CSV_URL),
  /** The full tick (OFAC poll, provisioning, all-wallet indexer, alerts, reconcile, full outbox pass). */
  TICK_INTERVAL_MS: intFromString(100, 3_600_000).default(5000),
  /** The loop's wake interval: the fast pass claims and sends due outbox intents (AD-20 amendment 2026-09-29). */
  FAST_TICK_MS: intFromString(50, 5_000).default(250),
  /** Circle status poll cadence, only while an intent is submitted. */
  CIRCLE_STATUS_POLL_MS: intFromString(100, 10_000).default(500),
  /** In-flight indexer cadence: only the wallets with a submitted (or sending) intent. */
  INFLIGHT_INDEX_MS: intFromString(250, 30_000).default(1000),
  /** A tick running longer than this is presumed hung: the worker alerts and exits 1 so Railway restarts it. */
  MAX_TICK_MS: intFromString(1_000, 3_600_000).default(120_000),
  /** `eth_getLogs` chunks per wallet per indexer pass (catch-up stays under the shared RPC rate limit). */
  INDEXER_MAX_CHUNKS_PER_TICK: intFromString(1, 200).default(10),
  /** After a rate-limited indexer read, the wallet is skipped by both indexer lanes for this long. */
  INDEXER_RATE_LIMIT_COOLDOWN_MS: intFromString(1_000, 600_000).default(30_000),
});


export type ChainWriterConfig =
  | { readonly kind: "circle"; readonly apiKey: string; readonly entitySecret: string }
  | { readonly kind: "local"; readonly keys: Readonly<Record<SignerRole, Hex>> };

export type WorkerEnv = z.output<typeof WorkerEnvSchema> & {
  readonly chainWriter: ChainWriterConfig;
};

/** `LOCAL_SIGNER_KEYS`: a JSON object with exactly `registrar`, `model` and `rules` → 0x-prefixed 32-byte keys. */
function parseLocalKeys(raw: string): Record<SignerRole, Hex> | undefined {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined;
  const out: Partial<Record<SignerRole, Hex>> = {};
  for (const [role, key] of Object.entries(json)) {
    if (!(SIGNER_ROLES as readonly string[]).includes(role) || typeof key !== "string" || !PRIVATE_KEY.test(key)) return undefined;
    out[role as SignerRole] = key as Hex;
  }
  const { registrar, model, rules } = out;
  if (registrar === undefined || model === undefined || rules === undefined) return undefined;
  return { registrar, model, rules };
}

export function parseWorkerEnv(raw: RawEnv): EnvResult<WorkerEnv> {
  const base = parseEnv(WorkerEnvSchema, raw);
  // Report the conditional variables too, so one boot names every problem.
  const extra: EnvProblem[] = [];
  const writer = base.ok ? base.env.CHAIN_WRITER : raw["CHAIN_WRITER"];
  const set = (name: string) => raw[name] !== undefined && raw[name] !== "";
  let chainWriter: ChainWriterConfig | undefined;
  if (writer === "circle") {
    if (!set("CIRCLE_API_KEY")) extra.push({ name: "CIRCLE_API_KEY", problem: "required when CHAIN_WRITER=circle" });
    if (!set("CIRCLE_ENTITY_SECRET")) extra.push({ name: "CIRCLE_ENTITY_SECRET", problem: "required when CHAIN_WRITER=circle" });
    if (extra.length === 0) chainWriter = { kind: "circle", apiKey: raw["CIRCLE_API_KEY"] ?? "", entitySecret: raw["CIRCLE_ENTITY_SECRET"] ?? "" };
  } else if (writer === "local") {
    if (raw["NODE_ENV"] === "production") extra.push({ name: "CHAIN_WRITER", problem: "local is refused when NODE_ENV=production (dev/CI only)" });
    else if (raw["CHAIN_ID"] !== String(LOCAL_CHAIN_ID) && raw["ALLOW_LOCAL_WRITER"] !== "1") {
      extra.push({ name: "CHAIN_WRITER", problem: `local needs CHAIN_ID=${LOCAL_CHAIN_ID} or ALLOW_LOCAL_WRITER=1` });
    }
    const keys = set("LOCAL_SIGNER_KEYS") ? parseLocalKeys(raw["LOCAL_SIGNER_KEYS"] ?? "") : undefined;
    if (!set("LOCAL_SIGNER_KEYS")) extra.push({ name: "LOCAL_SIGNER_KEYS", problem: "required when CHAIN_WRITER=local" });
    else if (keys === undefined) extra.push({ name: "LOCAL_SIGNER_KEYS", problem: "must be a JSON object with exactly registrar, model and rules -> 0x private key" });
    if (extra.length === 0 && keys !== undefined) chainWriter = { kind: "local", keys };
  }
  if (!base.ok || chainWriter === undefined) {
    const seen = new Set<string>();
    const invalid = [...(base.ok ? [] : base.invalid), ...extra].filter((p) => (seen.has(p.name) ? false : (seen.add(p.name), true)));
    return { ok: false, invalid };
  }
  return { ok: true, env: { ...base.env, chainWriter } };
}

export const MigrateEnvSchema = z.object({ MIGRATOR_DATABASE_URL: postgresUrl() });
export type MigrateEnv = z.output<typeof MigrateEnvSchema>;

export function parseMigrateEnv(raw: RawEnv): EnvResult<MigrateEnv> {
  return parseEnv(MigrateEnvSchema, raw);
}
