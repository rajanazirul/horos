// Shared test fixtures for evaluate tests (imported by *.test.ts only; excluded from the build).
import { STANDARD_PRESET } from "../policy/preset.js";
import type { ChainInput, ChainView, EvaluationInput, ListSnapshot } from "./types.js";

export const USDC = 1_000_000n;
export const u = (n: number | bigint): bigint => BigInt(n) * USDC;
export const HOUR = 60 * 60 * 1000;
export const NOW = 1_790_000_000_000;

export const PAYEE = "0x1111111111111111111111111111111111111111";
export const OTHER = "0x2222222222222222222222222222222222222222";
export const SDN_ADDR = "0xabcdefabcdefabcdefabcdefabcdefabcdef0001";
export const DEMO_ADDR = "0xdddddddddddddddddddddddddddddddddddd0002";

export const sdnList = (lastVerifiedAt = NOW - HOUR): ListSnapshot => ({
  source: "ofac-sdn",
  snapshotId: "sdn-2026-09-26T00",
  snapshotHash: `0x${"a".repeat(64)}`,
  entries: new Map([[SDN_ADDR, ["EXAMPLE SANCTIONED ENTITY", "EXAMPLE ALIAS"]]]),
  lastVerifiedAt,
});

export const demoList = (): ListSnapshot => ({
  source: "horos-demo-list",
  snapshotId: "demo-v1",
  snapshotHash: `0x${"d".repeat(64)}`,
  entries: new Map([[DEMO_ADDR, ["HOROS DEMO ENTITY (TEST)"]]]),
  lastVerifiedAt: NOW - HOUR,
});

export const firstContactView = (patch: Partial<ChainView> = {}): ChainView => ({
  cpRemaining: 0n,
  walletRemaining: u(5_000),
  newPayeeRemaining: 10n,
  limit: 0n,
  pinned: false,
  registered: false,
  humanSet: false,
  humanEpoch: 0n,
  ...patch,
});

export const registeredView = (limit: bigint, cpRemaining: bigint, patch: Partial<ChainView> = {}): ChainView =>
  firstContactView({ registered: true, limit, cpRemaining, humanEpoch: 3n, ...patch });

export const chainOf = (view: ChainView, patch: Partial<Omit<ChainInput, "view">> = {}): ChainInput => ({
  view,
  payeeIsContract: false,
  firstContactCeiling: STANDARD_PRESET.onchain.firstContactCeiling,
  ...patch,
});

export const IDENTITY = { name: "Acme Data, Inc.", domain: "www.acme.example" } as const;

/** Base: standard Preset, FCC 500, wallet 5,000, new-payee 10, lists fresh, EOA payee, identity present. */
export function baseInput(patch: Partial<EvaluationInput> = {}): EvaluationInput {
  return {
    counterparty: PAYEE,
    amount: u(50),
    declaredIdentity: IDENTITY,
    now: NOW,
    lists: [sdnList(), demoList()],
    chain: chainOf(firstContactView()),
    chainState: "live",
    hasHistory: false,
    identityBindings: [],
    policy: STANDARD_PRESET.offchain,
    ...patch,
  };
}

/** The input without a Declared Identity. */
export function withoutIdentity(input: EvaluationInput): EvaluationInput {
  return omitKey(input, "declaredIdentity");
}

/** A shallow copy without `key` (exactOptionalPropertyTypes-safe "unset"). */
export function omitKey<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key)) as Omit<T, K>;
}
