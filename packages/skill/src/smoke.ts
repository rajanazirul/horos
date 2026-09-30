// `horos-quickstart smoke [--shadow] [--good <address>] [--amount <usdc>]`: prove the integration end to end without
// moving money.
//   enforced: a signed Check on a known-good address expects `allow`. That Check is enforced, so Horos queues one
//             first-contact Limit write for the address on the PolicyWallet (one new-payee slot); the generated
//             address is kept in .horos/quickstart.json and reused on reruns. A Check on the first Horos Demo List
//             address expects `block` with `simulated: true`. A forced `PolicyWallet.pay` to that address is only
//             SIMULATED (viem `simulateContract`, no transaction) and must revert with a blocking reason.
//   shadow:   the same two Checks, advisory, with each `outcome` recorded. No pay simulation.
// The result, pass/fail and the elapsed time since `start` go to `.horos/quickstart.json`.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Address, type Hex } from "@horos/schema";
import { createHoros, fromViemAccount, HorosError, type CheckResult, type HorosClient, type HorosOptions } from "@horos/sdk";
import { PAY_ABI, publicClientFor, type PaySimulator } from "./chain.js";
import { readConfig } from "./config.js";
import { apiKeyFromEnv, paymentAccountFromEnv, paymentKeySecret, QuickstartError, randomAddress, read, rpcUrlFromEnv, ENV, type Env } from "./env.js";
import { formatElapsed, readQuickstart, recordSmoke, saveGoodAddress, type Quickstart, type SmokeCheckResult, type SmokePayResult, type SmokeRun, type SmokeStepResult } from "./timing.js";

export const DEFAULT_AMOUNT_USDC = "1";
const ZERO_HASH: Hex = `0x${"0".repeat(64)}`;

/** The PolicyWallet reverts that mean "this payment is blocked". Any other revert fails the smoke test. */
export const BLOCKING_REVERTS: ReadonlySet<string> = new Set(["NotRegistered", "Pinned", "LimitExceeded", "WalletCapExceeded", "PayeeIsContract"]);

export interface DemoList {
  readonly label: string;
  readonly entries: readonly { readonly label: string; readonly address: string }[];
}

/** The bundled Horos Demo List (dist/ after build; the repo fixture when run from source). */
export function loadDemoList(): DemoList {
  const candidates = [new URL("./horos-demo-list.json", import.meta.url), new URL("../../../fixtures/horos-demo-list.json", import.meta.url)];
  for (const u of candidates) {
    const p = fileURLToPath(u);
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")) as DemoList;
  }
  throw new QuickstartError("the bundled Horos Demo List is missing (rebuild @horos/skill)");
}

/** The first Demo List address, lowercase. */
export function demoAddress(list: DemoList): Hex {
  const first = list.entries[0];
  const parsed = Address.safeParse(first?.address);
  if (!parsed.success) throw new QuickstartError("the Horos Demo List has no valid first address");
  return parsed.data;
}

/** "1" or "0.5" USDC → 6-dp base units. */
export function parseUsdc(raw: string): bigint {
  const v = raw.trim();
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(v);
  if (m === null) throw new QuickstartError("--amount must be a USDC amount such as 1 or 0.5 (at most 6 decimals)");
  const units = BigInt(m[1] ?? "0") * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
  if (units === 0n) throw new QuickstartError("--amount must be more than 0");
  return units;
}

/** Whether an error is a contract revert, and its decoded reason. Transport failures are not reverts. */
export function revertOf(err: unknown): { reverted: boolean; reason?: string } {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
    if (e.name === "ContractFunctionRevertedError") {
      const r = e as Error & { data?: { errorName?: string }; reason?: string; signature?: string };
      return { reverted: true, reason: r.data?.errorName ?? r.reason ?? r.signature ?? "unknown revert" };
    }
  }
  return { reverted: false };
}

export interface SmokeDeps {
  readonly root: string;
  readonly env: Env;
  readonly out: (line: string) => void;
  readonly now: () => number;
  /** Warnings (stderr). */
  readonly err?: (line: string) => void;
  /** Default: the SDK's `createHoros`. */
  readonly createHoros?: (options: HorosOptions) => Pick<HorosClient, "check">;
  readonly fetch?: HorosOptions["fetch"];
  /** Default: a viem public client on the configured chain. */
  readonly publicClient?: PaySimulator;
  readonly demoList?: DemoList;
  readonly randomAddress?: () => Hex;
}

export interface SmokeOptions {
  readonly shadow: boolean;
  readonly good?: string;
  readonly amount?: string;
}

function describeError(err: unknown): string {
  if (err instanceof HorosError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.name : "error";
}

export async function smoke(opts: SmokeOptions, deps: SmokeDeps): Promise<{ run: SmokeRun; quickstart: Quickstart | null; persistError: string | null }> {
  const warn = deps.err ?? (() => undefined);
  const config = readConfig(deps.root, true);
  const envBase = read(deps.env, ENV.baseUrl);
  if (envBase !== undefined) {
    let envOrigin: string | undefined;
    try {
      envOrigin = new URL(envBase).origin;
    } catch {
      envOrigin = undefined;
    }
    if (envOrigin !== config.baseUrl) warn(`warning: ${ENV.baseUrl} differs from horos.config.json baseUrl; smoke uses horos.config.json (${config.baseUrl}).`);
  }
  if (opts.shadow && config.mode !== "shadow") throw new QuickstartError('horos.config.json is in enforced mode: run `horos-quickstart smoke` (without --shadow)');
  if (!opts.shadow && config.mode !== "enforced") throw new QuickstartError('horos.config.json is in Shadow Mode: run `horos-quickstart smoke --shadow`');

  const demoList = deps.demoList ?? loadDemoList();
  const demo = demoAddress(demoList);
  const demoSet = new Set(demoList.entries.map((e) => e.address.toLowerCase()));
  let good: Hex;
  if (opts.good === undefined) {
    // Reuse the address from an earlier run: each new one would spend a new-payee slot on the PolicyWallet.
    const saved = readQuickstart(deps.root, warn).goodAddress;
    good = saved !== null && !demoSet.has(saved) ? (saved as Hex) : (deps.randomAddress ?? randomAddress)();
    if (good !== saved) saveGoodAddress(deps.root, good, warn);
  } else {
    const g = Address.safeParse(opts.good.trim());
    if (!g.success) throw new QuickstartError("--good must be a 0x address with 40 hex digits");
    good = g.data;
  }
  if (demoSet.has(good)) throw new QuickstartError("--good must not be a Horos Demo List address");
  const amountText = opts.amount ?? DEFAULT_AMOUNT_USDC;
  const amount = parseUsdc(amountText);

  const make = deps.createHoros ?? createHoros;
  const secrets: (string | undefined)[] = [paymentKeySecret(deps.env), read(deps.env, ENV.apiKey)];
  let client: Pick<HorosClient, "check">;
  let account: ReturnType<typeof paymentAccountFromEnv> | undefined;
  const base = { baseUrl: config.baseUrl, chainId: config.chainId, scope: config.scope, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) };
  if (opts.shadow) {
    client = make({ ...base, apiKey: apiKeyFromEnv(deps.env) });
  } else {
    account = paymentAccountFromEnv(deps.env);
    client = make({ ...base, policyWallet: config.policyWallet ?? undefined, signer: fromViemAccount(account) } as HorosOptions);
  }

  const steps: SmokeStepResult[] = [];
  const checkStep = async (step: "good" | "demo", counterparty: Hex): Promise<SmokeCheckResult> => {
    let res: CheckResult;
    try {
      res = await client.check({ counterparty, amount });
    } catch (err) {
      return { step, counterparty, passed: false, detail: `the Check failed: ${describeError(err)}` };
    }
    const seen = {
      step,
      counterparty,
      decision: res.decision,
      simulated: res.simulated,
      advisory: res.advisory,
      recordId: res.record_id,
      ...(res.outcome === undefined ? {} : { outcome: res.outcome }),
    };
    if (!opts.shadow && res.advisory) {
      return { ...seen, passed: false, detail: "the api answered advisory: is HOROS_PAYMENT_PRIVATE_KEY this PolicyWallet's Payment key, and is the wallet bound?" };
    }
    if (opts.shadow && !res.advisory) return { ...seen, passed: false, detail: "a Shadow Check must be advisory" };
    if (step === "good") {
      return res.decision === "allow" ? { ...seen, passed: true } : { ...seen, passed: false, detail: `expected allow for a known-good address, got ${res.decision}: ${res.reason}` };
    }
    return res.decision === "block" && res.simulated
      ? { ...seen, passed: true }
      : { ...seen, passed: false, detail: `expected a simulated block for the Demo List address, got ${res.decision} (simulated: ${String(res.simulated)})` };
  };

  const payStep = async (): Promise<SmokePayResult> => {
    const policyWallet = config.policyWallet;
    const fail = (detail: string, extra: Partial<SmokePayResult> = {}): SmokePayResult => ({ step: "pay", counterparty: demo, reverted: false, passed: false, detail, ...extra });
    if (policyWallet === null || account === undefined) return fail("no PolicyWallet in horos.config.json");
    const pub = deps.publicClient ?? publicClientFor(config.chainId, rpcUrlFromEnv(deps.env, config.chainId));
    // A call to an address with no code "succeeds" in simulation, and a wrong chain proves nothing: check both first.
    try {
      const live = await pub.getChainId();
      if (live !== config.chainId) return fail(`the RPC is on chain ${live}, not horos.config.json chainId ${config.chainId}`);
      const code = await pub.getCode({ address: policyWallet });
      if (code === undefined || code === "0x") return fail(`no contract code at the PolicyWallet ${policyWallet} on chain ${config.chainId}`);
    } catch (err) {
      return fail(`could not read the chain: ${describeError(err)}`);
    }
    try {
      // Simulation only: no transaction is signed or sent, no funds move.
      await pub.simulateContract({ address: policyWallet, abi: PAY_ABI, functionName: "pay", args: [demo, amount, ZERO_HASH], account });
    } catch (err) {
      const r = revertOf(err);
      if (!r.reverted) return fail(`the pay simulation could not run: ${describeError(err)}`);
      const reason = r.reason ?? "unknown revert";
      if (!BLOCKING_REVERTS.has(reason)) {
        return fail(
          reason === "Unauthorized"
            ? "pay reverted Unauthorized: the env Payment key is not this PolicyWallet's Payment role holder"
            : `pay reverted ${reason}, which is not one of the PolicyWallet's blocking reasons (${[...BLOCKING_REVERTS].join(", ")})`,
          { reverted: true, revertReason: reason },
        );
      }
      return { step: "pay", counterparty: demo, reverted: true, revertReason: reason, passed: true };
    }
    return fail("a forced pay to the Demo List address did NOT revert in simulation: the PolicyWallet would let this payment through");
  };

  const plan: (() => Promise<SmokeStepResult>)[] = [() => checkStep("good", good), () => checkStep("demo", demo), ...(opts.shadow ? [] : [payStep])];
  let failedStep: string | null = null;
  for (const s of plan) {
    const r = await s();
    steps.push(r);
    if (!r.passed) {
      failedStep = r.step;
      break;
    }
  }

  const nowMs = deps.now();
  const run: SmokeRun = { mode: opts.shadow ? "shadow" : "enforced", at: new Date(nowMs).toISOString(), amount: amount.toString(), passed: failedStep === null, failedStep, steps };
  // Print first: a refused or failed write must not hide the result.
  deps.out(formatSmoke(run));
  let quickstart: Quickstart | null = null;
  let persistError: string | null = null;
  try {
    quickstart = recordSmoke(deps.root, run, nowMs, secrets, warn);
    deps.out(formatElapsed(quickstart));
  } catch (err) {
    persistError = err instanceof QuickstartError ? err.message : err instanceof Error ? err.name : "error";
    warn(`could not record the smoke result in .horos/quickstart.json: ${persistError}`);
  }
  return { run, quickstart, persistError };
}

export function formatSmoke(run: SmokeRun): string {
  const lines = run.steps.map((s) => {
    const mark = s.passed ? "ok  " : "FAIL";
    if (s.step === "pay") return `  ${mark}  forced pay to ${s.counterparty} (simulated, nothing sent): ${s.reverted ? `reverted ${s.revertReason ?? ""}`.trim() : "did not revert"}${s.detail === undefined ? "" : ` (${s.detail})`}`;
    const what = s.step === "good" ? "known-good" : "Demo List";
    const got = s.decision === undefined ? "" : `${s.decision}${s.simulated === true ? " (simulated)" : ""}${s.outcome === undefined ? "" : `, outcome ${s.outcome}`}${s.recordId === undefined ? "" : `, record ${s.recordId}`}`;
    return `  ${mark}  ${run.mode === "shadow" ? "advisory " : ""}Check ${what} ${s.counterparty}: ${got}${s.detail === undefined ? "" : ` (${s.detail})`}`;
  });
  return [`smoke test (${run.mode}, ${run.amount} base units) ${run.passed ? "passed" : `FAILED at step "${run.failedStep ?? "?"}"`}:`, ...lines].join("\n");
}
