// Test harness for Check pipeline tests: a test Postgres database with a bound enforced Scope, a fake ChainReader with
// a primary/secondary failover toggle, a controllable clock and signed-request builders. Test-only.
import {
  outboxExtraWrites,
  PostgresAccountStore,
  PostgresCheckInputs,
  PostgresIndexerStore,
  PostgresOutboxStore,
  PostgresPolicyVersionStore,
  PostgresRecordStore,
  PostgresShadowStore,
  recoverCheckSigner,
  uuidv7,
  type HorosDb,
  type HorosTx,
} from "@horos/adapters";
import { seededTemplate, type DbTemplate, type TestClient } from "@horos/adapters/testing";
import type { ChainReader, ChainView, ListSnapshot, LivePolicy, ProvisionedKeys, WalletRoles } from "@horos/core";
import { CHECK_TYPES, checkDomain, checkMessageFromRequest, toWireTime, type CheckRequest, type DeclaredIdentity, type Hex } from "@horos/schema";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { CheckDeps } from "./ports.js";

export const CHAIN_ID = 5042002;
// Well-known Foundry/Anvil dev keys. Test-only; never funded on any real network.
export const payment = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
export const stranger = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
export const PAY = payment.address.toLowerCase() as Hex;
export const WALLET: Hex = "0x7ed77bdd025d461e15d8e85dbf3ab0e9a286774c";
export const OTHER_WALLET: Hex = "0x9a676e781a523b5d0c0e43731313a708cb607508";
export const HUMAN: Hex = "0x3b60ebece31658efda2ad1cd28860cabbf2e4e85";
export const KEYS: ProvisionedKeys = {
  walletSetId: "ws-1",
  registrar: { walletId: "w-r", address: "0x7434fc9d31febe08082a710b255f3fe51b6a7ffc" },
  model: { walletId: "w-m", address: "0x081b31405e48ec71bedbc22adf10ebcdcabb69a7" },
  rules: { walletId: "w-u", address: "0x9542e0bbc0bcc0c88033233d7d70b0def37e2769" },
};
export const PAYEE: Hex = "0x1111111111111111111111111111111111111111";
export const PAYEE_2: Hex = "0x2222222222222222222222222222222222222222";
export const SDN_ADDR: Hex = "0xabcdefabcdefabcdefabcdefabcdefabcdef0001";
export const NOW_MS = Date.parse("2026-09-28T12:00:00.000Z");
export const USDC = 1_000_000n;
export const u = (n: number): string => (BigInt(n) * USDC).toString();

const FIRST_CONTACT: ChainView = {
  cpRemaining: 0n,
  walletRemaining: 5_000n * USDC,
  newPayeeRemaining: 10n,
  limit: 0n,
  pinned: false,
  registered: false,
  humanSet: false,
  humanEpoch: 0n,
};

/** A ChainReader whose "RPCs" can be taken down: primary, secondary, or both on `roles` only. */
export class FakeChain implements ChainReader {
  primaryDown = false;
  secondaryDown = false;
  rolesDown = false;
  remainingDown = false;
  /** Every ChainReader call, whether or not it succeeded. */
  calls = 0;
  primaryCalls = 0;
  secondaryCalls = 0;
  views = new Map<string, ChainView>();
  contracts = new Set<string>();
  roleMap: WalletRoles = { payment: PAY, registrar: KEYS.registrar.address, model: KEYS.model.address, rules: KEYS.rules.address, human: HUMAN };
  livePolicy: LivePolicy = { firstContactCeiling: 500n * USDC, walletPeriodCap: 5_000n * USDC, newPayeeCap: 10n, policyPeriodDays: 30n, unpinDelay: 86_400n };

  private async rpc<T>(value: () => T): Promise<T> {
    this.calls++;
    if (!this.primaryDown) {
      this.primaryCalls++;
      return value();
    }
    if (!this.secondaryDown) {
      this.secondaryCalls++;
      return value();
    }
    throw new Error("both RPCs down");
  }
  remaining(_w: Hex, a: Hex) {
    if (this.remainingDown) {
      this.calls++;
      return Promise.reject(new Error("both RPCs down on remaining"));
    }
    return this.rpc(() => this.views.get(a) ?? FIRST_CONTACT);
  }
  roles() {
    if (this.rolesDown) {
      this.calls++;
      return Promise.reject(new Error("both RPCs down on roles"));
    }
    return this.rpc(() => this.roleMap);
  }
  policy() {
    return this.rpc(() => this.livePolicy);
  }
  hasCode(a: Hex) {
    return this.rpc(() => this.contracts.has(a));
  }
  async simulate(): Promise<never> {
    throw new Error("unused");
  }
  async latestBlock(): Promise<never> {
    throw new Error("unused");
  }
  async logs(): Promise<never> {
    throw new Error("unused");
  }
  async blockTimestamp(): Promise<never> {
    throw new Error("unused");
  }
  async txFrom(): Promise<never> {
    throw new Error("unused");
  }
  async rolesAt(): Promise<never> {
    throw new Error("unused");
  }
  async hasCodeAt(): Promise<never> {
    throw new Error("unused");
  }
}

export const sdnList = (lastVerifiedAt: number): ListSnapshot => ({
  source: "ofac-sdn",
  snapshotId: "sdn-test",
  snapshotHash: `0x${"a".repeat(64)}`,
  entries: new Map([[SDN_ADDR, ["EXAMPLE SANCTIONED ENTITY"]]]),
  lastVerifiedAt,
});

export interface Harness {
  readonly client: TestClient;
  readonly db: HorosDb;
  readonly chain: FakeChain;
  readonly scope: string;
  readonly customerId: string;
  readonly clock: { ms: number };
  /** Called after every fake sleep with the elapsed ms since `sleepStart`. */
  onSleep?: (elapsedMs: number) => Promise<void>;
  sleepStart: number;
  readonly outbox: PostgresOutboxStore;
  readonly records: PostgresRecordStore;
  readonly policies: PostgresPolicyVersionStore;
  readonly indexer: PostgresIndexerStore;
  /** The shadow store behind `deps.ledger` (Story 3.4). */
  readonly shadow: PostgresShadowStore;
  deps: CheckDeps<HorosTx>;
}

export interface Template {
  readonly db: DbTemplate;
  readonly scope: string;
  readonly customerId: string;
}
let template: Promise<Template> | undefined;

/** Onboard and bind once per test file, then copy each test's database from that template (much cheaper). */
export function loadTemplate(): Promise<Template> {
  template ??= (async () => {
    let ids = { scope: "", customerId: "" };
    const db = await seededTemplate(async (seedDb) => {
      const now = new Date(NOW_MS);
      const accounts = new PostgresAccountStore(seedDb);
      const { binding } = await accounts.onboard({ paymentAddress: PAY, webhookUrl: "", now });
      await accounts.setKeys(binding.customerId, KEYS, now);
      const bound = await accounts.bind(binding.customerId, WALLET, now);
      ids = { scope: bound.scopeId, customerId: binding.customerId };
    });
    return { db, ...ids };
  })();
  return template;
}

export async function harness(opts: { limitWriteWaitMs?: number } = {}): Promise<Harness> {
  const t = await loadTemplate();
  const { client, db } = await t.db.fresh();
  const clock = { ms: NOW_MS };
  const now = () => new Date(clock.ms);
  const accounts = new PostgresAccountStore(db);
  const bound = { scopeId: t.scope };
  const binding = { customerId: t.customerId };
  const chain = new FakeChain();
  const records = new PostgresRecordStore(db);
  const outbox = new PostgresOutboxStore(db);
  const policies = new PostgresPolicyVersionStore(db);
  const indexer = new PostgresIndexerStore(db);
  const inputs = new PostgresCheckInputs(db);
  const shadow = new PostgresShadowStore(db);
  const h: Harness = {
    client,
    db,
    chain,
    scope: bound.scopeId,
    customerId: binding.customerId,
    clock,
    sleepStart: clock.ms,
    outbox,
    records,
    policies,
    indexer,
    shadow,
    deps: undefined as unknown as CheckDeps<HorosTx>,
  };
  h.deps = {
    chainId: CHAIN_ID,
    chain,
    records,
    recoverCheckSigner,
    lists: async () => [sdnList(clock.ms - 60_000)],
    activePolicy: (scope) => policies.active(scope),
    ensurePresetPolicy: (scope) => inputs.ensurePresetPolicy(scope, now()),
    ensureAdvisoryScope: () => records.ensureScope({ id: "advisory-public" }),
    mirror: (scope, a) => indexer.mirror(scope, a),
    pendingIntentTarget: (scope, a) => inputs.pendingIntentTarget(scope, a),
    hasHistory: (scope, a) => inputs.hasHistory(scope, a),
    identityBindings: (scope, keys) => inputs.identityBindings(scope, keys),
    nonceUsed: (scope, n) => inputs.nonceUsed(scope, n),
    bindingByWallet: (w) => accounts.bindingByWallet(w),
    outboxWrites: (evaluation, ctx) => outboxExtraWrites(evaluation, ctx),
    intentState: (scope, a, id) => outbox.intentState(scope, a, id),
    intentTxHash: (scope, a, id) => inputs.intentTxHash(scope, a, id),
    now,
    newId: () => uuidv7(clock.ms),
    sleep: async (ms) => {
      clock.ms += ms;
      await h.onSleep?.(clock.ms - h.sleepStart);
    },
    limitWriteWaitMs: opts.limitWriteWaitMs ?? 0,
    ledger: shadow,
  };
  return h;
}

let nonceSeq = 0;
export const freshNonce = (): Hex => `0x${(++nonceSeq).toString(16).padStart(64, "0")}`;

export interface SignOptions {
  readonly signer?: PrivateKeyAccount;
  readonly wallet?: Hex;
  readonly counterparty?: Hex;
  readonly amount?: string;
  readonly expiryMs?: number;
  readonly nonce?: Hex;
  readonly identity?: DeclaredIdentity;
  readonly nowMs?: number;
}

/** A signed CheckRequest (expiry defaults to now + 120 s, rounded up to a whole second). */
export async function signedRequest(o: SignOptions = {}): Promise<CheckRequest> {
  const nowMs = o.nowMs ?? NOW_MS;
  const expiryMs = o.expiryMs ?? Math.ceil((nowMs + 120_000) / 1000) * 1000;
  const unsigned: CheckRequest = {
    policy_wallet: o.wallet ?? WALLET,
    counterparty: o.counterparty ?? PAYEE,
    amount: o.amount ?? u(50),
    ...(o.identity === undefined ? {} : { declared_identity: o.identity }),
    auth: { nonce: o.nonce ?? freshNonce(), expiry: toWireTime(new Date(expiryMs)), signature: `0x${"0".repeat(130)}` },
  };
  const signature = await (o.signer ?? payment).signTypedData({
    domain: checkDomain(CHAIN_ID, unsigned.policy_wallet),
    types: CHECK_TYPES,
    primaryType: "Check",
    message: checkMessageFromRequest(unsigned),
  });
  const auth = unsigned.auth;
  if (auth === undefined) throw new Error("unreachable");
  return { ...unsigned, auth: { ...auth, signature: signature.toLowerCase() as Hex } };
}

export function unsignedRequest(o: { counterparty?: Hex; amount?: string; wallet?: Hex } = {}): CheckRequest {
  return { policy_wallet: o.wallet ?? WALLET, counterparty: o.counterparty ?? PAYEE, amount: o.amount ?? u(50) };
}
