// The deploy helper (Story 3.2; AD-11, AD-12, AD-15, AD-25): one call from a Policy Owner's (Human) address to an
// enforced, bound PolicyWallet on the standard Preset, without Solidity. It
//   1. checks inputs, chains and custody separation (before any network write),
//   2. onboards through the api (Payment-signed, "Horos Account" domain) and waits for the per-Customer
//      Registrar/Model/Rules addresses (the Human-vs-Horos-role check happens here, after onboarding),
//   3. deploys the PolicyWallet with all five roles and the standard Preset: through Circle Contracts for a Circle
//      Payment wallet (AD-15), or with viem from an existing EOA,
//   4. checks the runtime codehash against the pinned build, the five on-chain role holders and the Policy,
//   5. binds the wallet through the api, and
//   6. prints codehash, role holders, Policy, explorer links, then funding instructions.
// The Human address is an input only: it is never generated, stored or signed for. Nothing here moves funds.
import {
  accountDomain,
  Address,
  BIND_PRIMARY_TYPE,
  BIND_TYPES,
  bindMessageFromRequest,
  BindRequest,
  ONBOARD_PRIMARY_TYPE,
  ONBOARD_TYPES,
  onboardMessageFromRequest,
  OnboardingRequest,
  OnboardingResponse,
  type Hex,
} from "@horos/schema";
import { getAddress, keccak256, type Account, type Chain, type LocalAccount, type Transport as ViemTransport, type WalletClient } from "viem";
import { arcTestnet } from "viem/chains";
import { CIRCLE_ARC_TESTNET, circleIdempotencyKey, type CircleContractsClient, type CircleFeeLevel, type CircleWalletsClient } from "./circle.js";
import { HorosError } from "./errors.js";
import { expectedRuntimeCodehash, policyWalletAbi, policyWalletBytecode } from "./generated/policy-wallet-artifact.js";
import {
  createTransport,
  describe,
  expiryAt,
  failureError,
  invalid,
  parseBaseUrl,
  randomBytes32,
  RETRY_INITIAL_BACKOFF_MS,
  RETRY_MAX_BACKOFF_MS,
  signVerified,
  type AttemptFailure,
  type FetchLike,
  type Parse,
  type Transport,
} from "./internal.js";
import { STANDARD_PRESET, type OnchainPolicy } from "./preset.js";
import { circleDcwSigner, fromViemAccount, type CheckSigner } from "./signer.js";

/** Default time to wait for each phase: Horos key provisioning, the deploy, and a retryable bind. */
export const DEFAULT_DEPLOY_TIMEOUT_MS = 5 * 60_000;
/** Default interval between onboarding / bind re-POSTs and Circle contract polls. */
export const DEFAULT_POLL_INTERVAL_MS = 2_000;
/** Lifetime of each signed Onboard / Bind request, in seconds (the api accepts at most 300). */
const ACCOUNT_REQUEST_EXPIRY_SECONDS = 120;
/** A signed Onboard / Bind body is reused until its expiry is this close (Account nonces are not consumed). */
const RESIGN_MARGIN_MS = 30_000;
/** Upper bound on FAILED Circle deploy records walked past in one run. */
const MAX_CIRCLE_DEPLOY_HOPS = 16;
const ZERO_ADDRESS: Hex = `0x${"0".repeat(40)}`;
const USDC_ADDRESS: Hex = "0x3600000000000000000000000000000000000000";

/** Circle blockchain id per chain id. Unknown pairs are refused. */
const CIRCLE_BLOCKCHAIN_BY_CHAIN_ID: Readonly<Record<number, string>> = { [arcTestnet.id]: CIRCLE_ARC_TESTNET };

/** Error names that mean a transport problem (worth a rerun), not a deterministic failure. */
const TRANSIENT_ERROR_NAMES = new Set(["HttpRequestError", "TimeoutError", "AbortError", "SocketClosedError", "WebSocketRequestError", "FetchError"]);

const CUSTODY =
  "custody separation: the Human (Policy Owner) key must live where the agent's runtime cannot reach it. It must not be " +
  "the Payment key, a Horos role key, or a wallet under the same Circle account or API key as the Payment wallet. Use a separate " +
  "wallet you control (for example a hardware wallet) and pass only its address.";

/** The five role holders of a PolicyWallet, lowercase. */
export interface PolicyWalletRoles {
  readonly human: Hex;
  readonly payment: Hex;
  readonly registrar: Hex;
  readonly model: Hex;
  readonly rules: Hex;
}

/** The chain reads the helper needs. A viem `PublicClient` satisfies it. */
export interface DeployPublicClient {
  getChainId(): Promise<number>;
  getCode(args: { address: Hex }): Promise<Hex | undefined>;
  readContract(args: { address: Hex; abi: typeof policyWalletAbi; functionName: "human" | "roleHolder" | "policy"; args?: readonly [number] }): Promise<unknown>;
  waitForTransactionReceipt(args: { hash: Hex; timeout?: number }): Promise<{ readonly status: "success" | "reverted"; readonly contractAddress?: Hex | null | undefined }>;
}

/** A Payment EOA under the developer's own Circle account (the default, AD-15). Deploys go through Circle Contracts. */
export interface CirclePaymentSource {
  readonly kind: "circle";
  /** Circle developer-controlled wallets client (creates the Payment EOA, signs Onboard / Bind). */
  readonly wallets: CircleWalletsClient;
  /** Circle Contracts client (deploys the PolicyWallet from the Payment wallet). */
  readonly contracts: CircleContractsClient;
  /** An existing Circle EOA to use as the Payment key; omit to create one (idempotently). */
  readonly wallet?: { readonly id: string; readonly address: string };
  /** Circle blockchain id; must match `chainId` (5042002 ↔ `ARC-TESTNET`). Default: the one mapped to `chainId`. */
  readonly blockchain?: string;
  /** Default `MEDIUM`. */
  readonly feeLevel?: CircleFeeLevel;
}

/** An existing EOA as the Payment key. Deploys with viem `deployContract` from that account. */
export interface EoaPaymentSource {
  readonly kind: "eoa";
  /** The Payment key (a viem local account). It signs Onboard / Bind and pays the deploy gas. */
  readonly account: Pick<LocalAccount, "address" | "signTypedData"> & Account;
  /** A viem wallet client on `chainId`; the deploy is sent from `account` through it. */
  readonly walletClient: Pick<WalletClient<ViemTransport, Chain>, "deployContract" | "chain">;
}

export interface DeployPolicyWalletOptions {
  /** The Horos api origin. */
  readonly baseUrl: string;
  /** Chain id (Arc testnet: 5042002). */
  readonly chainId: number;
  /** The Policy Owner's address (the Human role), an EOA in v1. Supplied by you; never generated, stored or signed for. */
  readonly humanAddress: string;
  /** Where the Payment key comes from. */
  readonly payment: CirclePaymentSource | EoaPaymentSource;
  /** Reads chain id, code, role holders, Policy and (EOA path) the deploy receipt. */
  readonly publicClient: DeployPublicClient;
  /** Optional webhook URL registered at onboarding. */
  readonly webhookUrl?: string;
  /** Explorer origin for the report. Default: the Arc testnet explorer on chain 5042002. */
  readonly explorerUrl?: string;
  /** Per-phase timeout: Horos key provisioning, the deploy, and a retryable bind each get this long. Default 5 minutes. */
  readonly timeoutMs?: number;
  /** Interval between onboarding / bind re-POSTs and Circle contract polls. Default 2 s. */
  readonly pollIntervalMs?: number;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Progress and the final report go here. Default `console.log`. Never receives keys or signatures. */
  readonly log?: (line: string) => void;
}

export interface DeployResult {
  readonly policyWallet: Hex;
  /** The bound enforced Scope (`enforced:<uuid>`), for `createHoros({ scope })`. */
  readonly scope: string;
  readonly customerId: string;
  /** The verified runtime codehash (equals the pinned PolicyWallet build). */
  readonly codehash: Hex;
  readonly roles: PolicyWalletRoles;
  /** The Policy read back from the wallet (equals the standard Preset). */
  readonly policy: OnchainPolicy;
  readonly chainId: number;
  /** Explorer origin used in the report, if any. */
  readonly explorerUrl?: string;
  /** The Circle wallet id of the Payment EOA (Circle path only). */
  readonly circleWalletId?: string;
  /** The deploy transaction hash (EOA path, when this run deployed). */
  readonly deployTxHash?: Hex;
}

const lower = (a: string): Hex => a.toLowerCase() as Hex;

function custodyError(detail: string): HorosError {
  return new HorosError({ code: "validation_failed", message: `refused: ${detail}. ${CUSTODY}`, retryable: false, attempts: 0 });
}

function isTransient(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
    if (TRANSIENT_ERROR_NAMES.has(e.name)) return true;
  }
  return false;
}

/**
 * Circle and viem errors can quote request config (the Circle API key): only the error's name survives. Failures are
 * non-retryable (a revert, insufficient funds or a Circle 4xx will not fix itself) unless they are transport errors.
 */
async function external<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HorosError) throw err;
    throw new HorosError({ code: "unavailable", message: `${what} failed: ${err instanceof Error ? err.name : "error"}`, retryable: isTransient(err), attempts: 0 });
  }
}

interface Deployed {
  readonly address: Hex;
  readonly txHash?: Hex;
}

interface ResolvedPayment {
  readonly address: Hex;
  readonly signer: CheckSigner;
  readonly circleWalletId?: string;
  deploy(roles: PolicyWalletRoles): Promise<Deployed>;
}

interface Ctx {
  readonly pub: DeployPublicClient;
  readonly chainId: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly pollMs: number;
  readonly timeoutMs: number;
  readonly log: (line: string) => void;
}

function constructorArgs(roles: PolicyWalletRoles) {
  const p = STANDARD_PRESET.onchain;
  return [
    { human: roles.human, payment: roles.payment, registrar: roles.registrar, model: roles.model, rules: roles.rules },
    { firstContactCeiling: p.firstContactCeiling, walletPeriodCap: p.walletPeriodCap, newPayeeCap: p.newPayeeCap, policyPeriodDays: p.policyPeriodDays, unpinDelay: p.unpinDelay },
    false,
  ] as const;
}

/** Deploy a PolicyWallet on the standard Preset, verify it, and bind it to the enforced Scope. */
export async function deployPolicyWallet(options: DeployPolicyWalletOptions): Promise<DeployResult> {
  const baseUrl = parseBaseUrl(options.baseUrl);
  const chainId = options.chainId;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw invalid("chainId must be a positive integer");
  const humanParsed = Address.safeParse(options.humanAddress);
  if (!humanParsed.success) throw invalid(`humanAddress: ${describe(humanParsed.error)}`);
  const human = humanParsed.data;
  if (human === ZERO_ADDRESS || human === USDC_ADDRESS) throw invalid("humanAddress must be the Policy Owner's own address, not the zero or USDC address");
  const timeoutMs = options.timeoutMs ?? DEFAULT_DEPLOY_TIMEOUT_MS;
  const pollMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw invalid("timeoutMs must be a positive whole number");
  if (!Number.isSafeInteger(pollMs) || pollMs <= 0) throw invalid("pollIntervalMs must be a positive whole number");
  if (options.webhookUrl !== undefined) {
    const hook = OnboardingRequest.safeParse({ payment_address: human, webhook_url: options.webhookUrl });
    if (!hook.success) throw invalid(describe(hook.error));
  }
  const explorerUrl = (options.explorerUrl ?? (chainId === arcTestnet.id ? arcTestnet.blockExplorers.default.url : undefined))?.replace(/\/+$/, "");
  const log = options.log ?? ((line: string) => console.log(line));
  const transport = createTransport(options);
  const { now, sleep } = transport;
  const pub = options.publicClient;

  // 1. Chains agree, the Human is an EOA, and the Payment key is custody-separated: all before any network write.
  const liveChainId = await external("reading the chain id", () => pub.getChainId());
  if (liveChainId !== chainId) throw invalid(`publicClient is on chain ${liveChainId}, not chainId ${chainId}`);
  const humanCode = await external("reading the Human address code", () => pub.getCode({ address: human }));
  if (humanCode !== undefined && humanCode !== "0x") {
    throw new HorosError({
      code: "validation_failed",
      message:
        "refused: the Human address has contract code. In v1 the Human role must be an EOA (the PolicyWallet is deployed with " +
        `roleIsContract = false and its constructor would revert). ${CUSTODY}`,
      retryable: false,
      attempts: 0,
    });
  }
  const ctx: Ctx = { pub, chainId, now, sleep, pollMs, timeoutMs, log };
  const payment = await resolvePayment(options.payment, human, ctx);

  // 2. Onboard (Payment-signed) and wait for the per-Customer Horos keys.
  log(`Onboarding Payment ${getAddress(payment.address)} with Horos...`);
  const onboarded = await onboard(transport, baseUrl, chainId, payment, options.webhookUrl, timeoutMs, pollMs);
  const { registrar, model, rules } = onboarded;
  if (registrar === null || model === null || rules === null) throw new HorosError({ code: "unavailable", message: "onboarding returned no Horos role addresses", retryable: true, attempts: 1 });
  if (!onboarded.scope.startsWith("enforced:")) throw new HorosError({ code: "conflict", message: "onboarding returned a Scope that is not enforced", retryable: false, attempts: 1 });
  if ([registrar, model, rules].includes(human)) throw custodyError("the Human address is one of this Customer's Horos role addresses");
  const roles: PolicyWalletRoles = { human, payment: payment.address, registrar, model, rules };
  if (new Set(Object.values(roles)).size !== 5) throw new HorosError({ code: "conflict", message: "the five role holders are not distinct", retryable: false, attempts: 1 });

  // 3. Deploy, unless this Customer is already bound (a rerun after success): then verify and re-bind that wallet.
  let deployed: Deployed;
  const alreadyBound = onboarded.status === "bound" && onboarded.policyWallet !== undefined;
  if (alreadyBound && onboarded.policyWallet !== undefined) {
    deployed = { address: onboarded.policyWallet };
    log(`Already bound to PolicyWallet ${getAddress(deployed.address)}; verifying it.`);
  } else {
    log("Deploying the PolicyWallet on the standard Preset...");
    deployed = await payment.deploy(roles);
  }
  const policyWallet = deployed.address;

  let codehash: Hex;
  let policy: OnchainPolicy;
  let bound: OnboardingResponse;
  try {
    // 4. Verify before bind or any funding instruction.
    ({ codehash, policy } = await verifyDeployment(pub, policyWallet, roles, { sleep, pollMs, live: alreadyBound }));
    // 5. Bind.
    bound = await bind(transport, baseUrl, chainId, payment, policyWallet, timeoutMs, pollMs);
  } catch (err) {
    // After this run sent a deploy, every error names it, so a rerun does not lose track of the first contract.
    if (err instanceof HorosError && deployed.txHash !== undefined) {
      throw new HorosError({
        code: err.code,
        message: `${err.message} (deploy tx ${deployed.txHash}, PolicyWallet ${policyWallet})`,
        retryable: err.retryable,
        ...(err.status === undefined ? {} : { status: err.status }),
        attempts: err.attempts,
      });
    }
    throw err;
  }

  const result: DeployResult = {
    policyWallet,
    scope: bound.scope,
    customerId: bound.customerId,
    codehash,
    roles,
    policy,
    chainId,
    ...(explorerUrl === undefined ? {} : { explorerUrl }),
    ...(payment.circleWalletId === undefined ? {} : { circleWalletId: payment.circleWalletId }),
    ...(deployed.txHash === undefined ? {} : { deployTxHash: deployed.txHash }),
  };
  // 6. The report: codehash, role holders, Policy, explorer links, then funding instructions.
  log(formatDeployReport(result));
  return result;
}

async function resolvePayment(source: CirclePaymentSource | EoaPaymentSource, human: Hex, ctx: Ctx): Promise<ResolvedPayment> {
  if (source.kind === "eoa") {
    const parsed = Address.safeParse(source.account.address);
    if (!parsed.success) throw invalid(`payment.account.address: ${describe(parsed.error)}`);
    const address = parsed.data;
    const walletClient = source.walletClient;
    if (walletClient.chain?.id !== ctx.chainId) throw invalid(`payment.walletClient is on chain ${walletClient.chain?.id ?? "(none)"}, not chainId ${ctx.chainId}`);
    if (address === human) throw custodyError("the Human address equals the Payment address");
    const account = source.account;
    return {
      address,
      signer: fromViemAccount(account),
      async deploy(roles) {
        const hash = await external("the deploy transaction", () =>
          walletClient.deployContract({ abi: policyWalletAbi, bytecode: policyWalletBytecode, args: constructorArgs(roles), account, chain: walletClient.chain }),
        );
        ctx.log(`Deploy transaction ${hash} sent.`);
        const receipt = await external(`waiting for the receipt of deploy tx ${hash}`, () => ctx.pub.waitForTransactionReceipt({ hash, timeout: ctx.timeoutMs }));
        if (receipt.status !== "success" || receipt.contractAddress == null) {
          const at = receipt.contractAddress == null ? "" : ` (contract address ${lower(receipt.contractAddress)})`;
          throw new HorosError({ code: "unavailable", message: `the deploy transaction ${hash} reverted or created no contract${at}`, retryable: false, attempts: 0 });
        }
        return { address: lower(receipt.contractAddress), txHash: hash };
      },
    };
  }
  if (source.kind !== "circle") throw invalid('payment.kind must be "circle" or "eoa"');

  const mapped = CIRCLE_BLOCKCHAIN_BY_CHAIN_ID[ctx.chainId];
  if (mapped === undefined) throw invalid(`no Circle blockchain is known for chain ${ctx.chainId}`);
  if (source.blockchain !== undefined && source.blockchain !== mapped) throw invalid(`payment.blockchain ${source.blockchain} does not match chainId ${ctx.chainId} (${mapped})`);
  const blockchain = mapped;
  const { wallets, contracts } = source;
  const feeLevel = source.feeLevel ?? "MEDIUM";
  // The Human must not be a wallet under the same Circle account (entity secret / API key) as the Payment wallet.
  const same = await external("Circle listWallets", () => wallets.listWallets({ address: human }));
  if ((same.data?.wallets ?? []).length > 0) throw custodyError("the Human address is a wallet under the same Circle account as the Payment wallet");

  let walletId: string;
  let address: Hex;
  if (source.wallet !== undefined) {
    const parsed = Address.safeParse(source.wallet.address);
    if (!parsed.success) throw invalid(`payment.wallet.address: ${describe(parsed.error)}`);
    if (source.wallet.id.length === 0) throw invalid("payment.wallet.id must be non-empty");
    if (parsed.data === human) throw custodyError("the Human address equals the Payment address");
    walletId = source.wallet.id;
    address = parsed.data;
  } else {
    // The Payment address does not exist yet: the creation keys derive from the Human address, so a rerun returns the
    // same wallet set and wallet instead of creating new ones.
    const set = await external("Circle createWalletSet", () => wallets.createWalletSet({ name: "horos-payment", idempotencyKey: circleIdempotencyKey("wallet-set", human) }));
    const setId = set.data?.walletSet?.id;
    if (setId === undefined) throw new HorosError({ code: "unavailable", message: "Circle createWalletSet returned no wallet set", retryable: false, attempts: 0 });
    const created = await external("Circle createWallets", () =>
      wallets.createWallets({
        walletSetId: setId,
        blockchains: [blockchain],
        count: 1,
        accountType: "EOA",
        metadata: [{ name: "horos-payment" }],
        idempotencyKey: circleIdempotencyKey("payment-wallet", human),
      }),
    );
    const w = created.data?.wallets?.[0];
    const parsed = w === undefined ? undefined : Address.safeParse(w.address);
    if (w === undefined || parsed === undefined || !parsed.success) throw new HorosError({ code: "unavailable", message: "Circle createWallets returned no EOA", retryable: false, attempts: 0 });
    if (parsed.data === human) throw custodyError("the Human address equals the Payment address");
    walletId = w.id;
    address = parsed.data;
    ctx.log(`Payment EOA ${getAddress(address)} (Circle wallet ${walletId}).`);
  }

  /** One read of a Circle contract record: FAILED, a COMPLETE address, or still pending. */
  async function contractState(contractId: string): Promise<{ state: "failed" } | { state: "pending" } | { state: "complete"; address: Hex }> {
    const got = await external("Circle getContract", () => contracts.getContract({ id: contractId }));
    const c = got.data?.contract;
    const status = (c?.status ?? c?.deployStatus ?? "").toUpperCase();
    if (status === "FAILED") return { state: "failed" };
    if (status !== "COMPLETE") return { state: "pending" };
    const addr = c?.contractAddress === undefined ? undefined : Address.safeParse(c.contractAddress);
    if (addr?.success !== true) {
      throw new HorosError({ code: "unavailable", message: `Circle reports contract ${contractId} COMPLETE without a valid contract address`, retryable: false, attempts: 0 });
    }
    return { state: "complete", address: addr.data };
  }

  return {
    address,
    circleWalletId: walletId,
    signer: circleDcwSigner({ client: wallets, walletId, address }),
    async deploy(roles) {
      const [r, p, flag] = constructorArgs(roles);
      // The key covers everything that shapes the contract, so changed roles or bytecode never return an old record.
      const baseKey = circleIdempotencyKey("deploy", address, roles.human, roles.registrar, roles.model, roles.rules, blockchain, expectedRuntimeCodehash);
      let key = baseKey;
      // Walk past FAILED records (each one derives the next key), so a rerun resumes at the first non-FAILED record and
      // each run submits at most one new deploy: the one whose first read is not FAILED.
      for (let hop = 0; hop < MAX_CIRCLE_DEPLOY_HOPS; hop++) {
        const submitted = await external("Circle deployContract", () =>
          contracts.deployContract({
            name: "Horos PolicyWallet",
            description: "Horos PolicyWallet, standard Preset",
            walletId,
            blockchain,
            abiJson: JSON.stringify(policyWalletAbi),
            bytecode: policyWalletBytecode,
            constructorParameters: [
              [r.human, r.payment, r.registrar, r.model, r.rules],
              [p.firstContactCeiling, p.walletPeriodCap, p.newPayeeCap, p.policyPeriodDays, p.unpinDelay].map((v) => v.toString(10)),
              flag,
            ],
            fee: { type: "level", config: { feeLevel } },
            idempotencyKey: key,
          }),
        );
        const contractId = submitted.data?.contractId;
        if (contractId === undefined) throw new HorosError({ code: "unavailable", message: "Circle deployContract returned no contract id", retryable: false, attempts: 0 });
        let s = await contractState(contractId);
        if (s.state === "failed") {
          ctx.log(`Circle contract ${contractId} is an earlier FAILED deploy; moving to the next deploy key.`);
          key = circleIdempotencyKey("deploy-after-failed", baseKey, contractId);
          continue;
        }
        const deadline = ctx.now() + ctx.timeoutMs;
        while (s.state === "pending") {
          if (ctx.now() + ctx.pollMs >= deadline) {
            throw new HorosError({ code: "unavailable", message: `Circle deploy of contract ${contractId} not complete in time; rerun to resume`, retryable: true, attempts: 0 });
          }
          await ctx.sleep(ctx.pollMs);
          s = await contractState(contractId);
        }
        if (s.state === "failed") {
          throw new HorosError({ code: "unavailable", message: `Circle deploy of contract ${contractId} failed; check the Payment wallet's gas balance, then rerun`, retryable: false, attempts: 0 });
        }
        return { address: s.address };
      }
      throw new HorosError({ code: "unavailable", message: `more than ${MAX_CIRCLE_DEPLOY_HOPS} failed Circle deploy records; investigate in the Circle console`, retryable: false, attempts: 0 });
    },
  };
}

const PLACEHOLDER_SIGNATURE: Hex = `0x${"0".repeat(130)}`;

interface SignedBody {
  readonly body: string;
  readonly expiryMs: number;
}

/**
 * POST a Payment-signed account request until the api answers a settled 200, fails non-retryably, or the timeout
 * passes. A signed body is reused while its expiry is more than 30 s away (Account nonces are not consumed, so the api
 * accepts the same envelope again); only then is it signed afresh with a new nonce and expiry.
 */
async function postAccount(
  transport: Transport,
  url: string,
  signBody: () => Promise<SignedBody>,
  timeoutMs: number,
  pollMs: number,
  what: string,
  pendingTimeoutMessage: string,
  pending: (status: number, value: OnboardingResponse) => boolean,
): Promise<OnboardingResponse> {
  const deadline = transport.now() + timeoutMs;
  const parse: Parse<OnboardingResponse> = (json) => OnboardingResponse.safeParse(json);
  let attempts = 0;
  let backoff = RETRY_INITIAL_BACKOFF_MS;
  let signed: SignedBody | undefined;
  for (;;) {
    attempts++;
    if (signed === undefined || signed.expiryMs - transport.now() <= RESIGN_MARGIN_MS) signed = await signBody();
    const r = await transport.attempt(url, { method: "POST", headers: { "content-type": "application/json" }, body: signed.body }, parse, deadline, [200, 202]);
    let wait: number;
    let last: AttemptFailure | undefined;
    if (r.ok) {
      if (!pending(r.status, r.value)) return r.value;
      wait = pollMs;
    } else {
      if (!r.failure.retryable) throw failureError(r.failure, attempts);
      last = r.failure;
      wait = Math.max(r.failure.retryAfterMs ?? 0, backoff);
      backoff = Math.min(backoff * 2, RETRY_MAX_BACKOFF_MS);
    }
    if (transport.now() + wait >= deadline) {
      if (last !== undefined) throw failureError(last, attempts, ` (${what}: gave up after ${attempts} attempt${attempts === 1 ? "" : "s"})`);
      throw new HorosError({ code: "unavailable", message: `${what}: ${pendingTimeoutMessage} after ${Math.round(timeoutMs / 1000)} s; rerun later (it resumes where it stopped)`, retryable: true, status: 202, attempts });
    }
    await transport.sleep(wait);
  }
}

function onboardingRequest(paymentAddress: Hex, webhookUrl: string | undefined, nonce: Hex, expiry: string, signature: Hex): OnboardingRequest {
  const parsed = OnboardingRequest.safeParse({
    payment_address: paymentAddress,
    ...(webhookUrl === undefined ? {} : { webhook_url: webhookUrl }),
    auth: { nonce, expiry, signature },
  });
  if (!parsed.success) throw invalid(describe(parsed.error));
  return parsed.data;
}

async function onboard(
  transport: Transport,
  baseUrl: string,
  chainId: number,
  payment: ResolvedPayment,
  webhookUrl: string | undefined,
  timeoutMs: number,
  pollMs: number,
): Promise<OnboardingResponse> {
  const signBody = async (): Promise<SignedBody> => {
    const nonce = randomBytes32();
    const expiry = expiryAt(transport.now(), ACCOUNT_REQUEST_EXPIRY_SECONDS);
    const unsigned = onboardingRequest(payment.address, webhookUrl, nonce, expiry.wire, PLACEHOLDER_SIGNATURE);
    const signature = await signVerified(payment.signer, payment.address, {
      domain: accountDomain(chainId),
      types: ONBOARD_TYPES,
      primaryType: ONBOARD_PRIMARY_TYPE,
      message: { ...onboardMessageFromRequest(unsigned) },
    });
    return { body: JSON.stringify({ ...unsigned, auth: { nonce, expiry: expiry.wire, signature } }), expiryMs: expiry.ms };
  };
  return postAccount(
    transport,
    `${baseUrl}/v1/onboarding`,
    signBody,
    timeoutMs,
    pollMs,
    "onboarding",
    "the Horos role keys are still provisioning",
    (status, v) => status !== 200 || v.registrar === null || v.model === null || v.rules === null,
  );
}

async function bind(
  transport: Transport,
  baseUrl: string,
  chainId: number,
  payment: ResolvedPayment,
  policyWallet: Hex,
  timeoutMs: number,
  pollMs: number,
): Promise<OnboardingResponse> {
  const signBody = async (): Promise<SignedBody> => {
    const nonce = randomBytes32();
    const expiry = expiryAt(transport.now(), ACCOUNT_REQUEST_EXPIRY_SECONDS);
    const parsed = BindRequest.safeParse({ payment_address: payment.address, policy_wallet: policyWallet, auth: { nonce, expiry: expiry.wire, signature: PLACEHOLDER_SIGNATURE } });
    if (!parsed.success) throw invalid(describe(parsed.error));
    const signature = await signVerified(payment.signer, payment.address, {
      domain: accountDomain(chainId),
      types: BIND_TYPES,
      primaryType: BIND_PRIMARY_TYPE,
      message: { ...bindMessageFromRequest(parsed.data) },
    });
    return { body: JSON.stringify({ ...parsed.data, auth: { nonce, expiry: expiry.wire, signature } }), expiryMs: expiry.ms };
  };
  const bound = await postAccount(transport, `${baseUrl}/v1/onboarding/bind`, signBody, timeoutMs, pollMs, "bind", "the api has not confirmed the binding", (status) => status !== 200);
  if (bound.status !== "bound" || !bound.scope.startsWith("enforced:") || bound.policyWallet !== policyWallet) {
    throw new HorosError({ code: "conflict", message: `the api did not confirm an enforced Scope bound to ${policyWallet}`, retryable: false, attempts: 1 });
  }
  return bound;
}

const ROLE_ORDER = ["human", "payment", "registrar", "model", "rules"] as const;
const POLICY_FIELDS = ["firstContactCeiling", "walletPeriodCap", "newPayeeCap", "policyPeriodDays", "unpinDelay"] as const;

/**
 * Check the runtime codehash against the pinned build, the five on-chain role holders and the Policy (which the
 * codehash does not cover). Throws `conflict` on any mismatch. `live` marks an already-bound wallet (possibly funded):
 * its mismatch is reported as drift, not as "do not fund".
 */
async function verifyDeployment(
  pub: DeployPublicClient,
  wallet: Hex,
  expected: PolicyWalletRoles,
  ctx: { sleep: (ms: number) => Promise<void>; pollMs: number; live: boolean },
): Promise<{ codehash: Hex; policy: OnchainPolicy }> {
  const conflict = (what: string) =>
    new HorosError({
      code: "conflict",
      message: ctx.live
        ? `drift on the live, already-bound PolicyWallet ${wallet}: ${what}. It no longer matches the standard deployment; not re-binding. Review it with the Policy Owner.`
        : `${what} at ${wallet}. Not binding; do not fund this address.`,
      retryable: false,
      attempts: 0,
    });
  let code: Hex | undefined;
  // A just-deployed contract can lag behind on a load-balanced RPC: a few reads before calling it missing.
  for (let i = 0; i < 5; i++) {
    code = await external("reading the PolicyWallet code", () => pub.getCode({ address: wallet }));
    if (code !== undefined && code !== "0x") break;
    if (i < 4) await ctx.sleep(ctx.pollMs);
  }
  const codehash = code === undefined || code === "0x" ? undefined : keccak256(code);
  if (codehash !== expectedRuntimeCodehash) throw conflict(`codehash mismatch: deployed ${codehash ?? "no code"}, expected ${expectedRuntimeCodehash}`);

  const read = (functionName: "human" | "roleHolder" | "policy", args?: readonly [number]) =>
    external("reading the PolicyWallet", () => pub.readContract({ address: wallet, abi: policyWalletAbi, functionName, ...(args === undefined ? {} : { args }) }));
  const values = await Promise.all([read("human"), read("roleHolder", [0]), read("roleHolder", [1]), read("roleHolder", [2]), read("roleHolder", [3])]);
  const live = values.map((v) => (typeof v === "string" ? v.toLowerCase() : ""));
  const badRoles = ROLE_ORDER.filter((role, i) => live[i] !== expected[role]);
  if (badRoles.length > 0) throw conflict(`role mismatch: ${badRoles.join(", ")}`);

  const raw = (await read("policy")) as Partial<Record<(typeof POLICY_FIELDS)[number], unknown>> | undefined;
  const badPolicy = POLICY_FIELDS.filter((f) => raw?.[f] !== STANDARD_PRESET.onchain[f]);
  if (badPolicy.length > 0) throw conflict(`Policy mismatch: ${badPolicy.join(", ")}`);
  return { codehash, policy: { ...STANDARD_PRESET.onchain } };
}

const ROLE_NOTES: Readonly<Record<(typeof ROLE_ORDER)[number], string>> = {
  human: "Policy Owner (you; the only role that can raise a Limit)",
  payment: "Payment (your agent's key)",
  registrar: "Registrar (Horos, per Customer)",
  model: "Model (Horos, per Customer; can only tighten)",
  rules: "Rules (Horos, per Customer)",
};

const usdc = (v: bigint) => `${(v / 1_000_000n).toString()}${v % 1_000_000n === 0n ? "" : `.${(v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "")}`} USDC`;

/** The deploy report: codehash, the five role holders, the Policy, explorer links, then funding instructions (in that order). */
export function formatDeployReport(result: DeployResult): string {
  const show = (a: Hex) => getAddress(a);
  const link = (a: Hex) => (result.explorerUrl === undefined ? "(no explorer configured)" : `${result.explorerUrl}/address/${show(a)}`);
  const p = result.policy;
  const lines = [
    `PolicyWallet ${show(result.policyWallet)} is deployed and bound (chain ${result.chainId}, Scope ${result.scope}).`,
    "",
    `Codehash: ${result.codehash} (matches the pinned PolicyWallet build)`,
    "",
    "Role holders (read back on-chain):",
    ...ROLE_ORDER.map((r) => `  ${r.padEnd(9)} ${show(result.roles[r])}  ${ROLE_NOTES[r]}`),
    "",
    "Policy (read back on-chain, standard Preset):",
    `  first-contact ceiling  ${usdc(p.firstContactCeiling)}`,
    `  wallet period cap      ${usdc(p.walletPeriodCap)} per ${p.policyPeriodDays.toString()} days`,
    `  new-payee cap          ${p.newPayeeCap.toString()} per period`,
    `  unpin delay            ${p.unpinDelay.toString()} s`,
    "",
    "Explorer:",
    `  PolicyWallet  ${link(result.policyWallet)}`,
    `  Payment EOA   ${link(result.roles.payment)}`,
    ...(result.deployTxHash === undefined || result.explorerUrl === undefined ? [] : [`  Deploy tx     ${result.explorerUrl}/tx/${result.deployTxHash}`]),
    "",
    "Funding (only after you have checked the codehash, role holders and Policy above):",
    "  1. Check first: on the explorer, confirm the PolicyWallet's code and its five role holders match this report, and that",
    "     the Human (Policy Owner) address is yours. Do not fund if anything differs.",
    `  2. Send USDC to the PolicyWallet ${show(result.policyWallet)} from any wallet. Your agent pays out only through`,
    "     PolicyWallet.pay, within the Limits the wallet enforces.",
    `  3. Keep a little USDC in the Payment EOA ${show(result.roles.payment)} for gas.`,
    "",
    `Next: createHoros({ policyWallet: "${show(result.policyWallet)}", scope: "${result.scope}", ... }).`,
    "Horos enforces your Policy and records evidence; you remain the compliance decision-maker.",
  ];
  return lines.join("\n");
}
