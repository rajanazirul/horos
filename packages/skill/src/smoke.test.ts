import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HorosError, type CheckInput, type CheckResult, type HorosOptions } from "@horos/sdk";
import { ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult, HttpRequestError } from "viem";
import { afterAll, expect, test, vi } from "vitest";
import { PAY_ABI, type PaySimulator } from "./chain.js";
import { main, type CliDeps } from "./cli.js";
import { CONFIG_FILE } from "./config.js";
import { API_KEY, BASE_URL, checkResult, CUSTOMER, DEMO, ENFORCED_SCOPE, ENV, GOOD, io, KEY, KEY_ADDRESS, readJson, scanAndCleanTempRepos, SHADOW_SCOPE, tempRepo, WALLET, tempHome } from "./harness.test-helpers.js";
import { demoAddress, loadDemoList, parseUsdc, revertOf } from "./smoke.js";
import { QUICKSTART_FILE, readQuickstart } from "./timing.js";

afterAll(scanAndCleanTempRepos);

const T0 = Date.parse("2026-09-30T10:00:00Z");

function revert(errorName: "NotRegistered" | "Unauthorized" | "Pinned" | "LimitExceeded" | "WalletCapExceeded" | "PayeeIsContract" | "InvalidAmount" | "RoleVacant"): Error {
  const data = encodeErrorResult({ abi: PAY_ABI, errorName });
  const cause = new ContractFunctionRevertedError({ abi: PAY_ABI, data, functionName: "pay" });
  return new ContractFunctionExecutionError(cause, { abi: PAY_ABI, functionName: "pay", args: [DEMO, 1_000_000n, `0x${"0".repeat(64)}`], contractAddress: WALLET, sender: KEY_ADDRESS });
}

type Answer = (input: CheckInput) => CheckResult | Promise<CheckResult>;

const enforcedAnswers: Answer = ({ counterparty }) =>
  counterparty === DEMO ? checkResult({ decision: "block", simulated: true, limit_write: "none" }) : checkResult({ decision: "allow" });

const shadowAnswers: Answer = ({ counterparty }) =>
  counterparty === DEMO
    ? checkResult({ decision: "block", simulated: true, advisory: true, limit_write: "none", outcome: "advisory" })
    : checkResult({ decision: "allow", advisory: true, limit_write: "none", outcome: "advisory" });

function setup(opts: { mode?: "enforced" | "shadow"; env?: Record<string, string>; answer?: Answer; simulate?: () => Promise<unknown>; clock?: { t: number }; liveChainId?: number; code?: string | undefined } = {}) {
  const mode = opts.mode ?? "enforced";
  const root = tempRepo();
  writeFileSync(
    join(root, CONFIG_FILE),
    JSON.stringify({ baseUrl: BASE_URL, chainId: 5042002, policyWallet: mode === "enforced" ? WALLET : null, scope: mode === "enforced" ? ENFORCED_SCOPE : SHADOW_SCOPE, customerId: CUSTOMER, mode }),
  );
  const clock = opts.clock ?? { t: T0 };
  const x = io();
  const made: HorosOptions[] = [];
  const answer = opts.answer ?? (mode === "enforced" ? enforcedAnswers : shadowAnswers);
  const check = vi.fn(async (input: CheckInput) => answer(input));
  const randomAddress = vi.fn((): `0x${string}` => GOOD);
  const simulateContract = vi.fn<PaySimulator["simulateContract"]>(opts.simulate ?? (async () => Promise.reject(revert("NotRegistered"))));
  const deps: CliDeps = {
    root,
    env: opts.env ?? (mode === "enforced" ? ENV : { ...ENV, HOROS_API_KEY: API_KEY }),
    out: x.o,
    err: x.e,
    now: () => clock.t,
    nodeVersion: "24.1.0", home: tempHome(),
    smoke: {
      createHoros: (o) => {
        made.push(o);
        return { check };
      },
      publicClient: {
        simulateContract,
        getChainId: async () => opts.liveChainId ?? 5042002,
        getCode: async () => ("code" in opts ? opts.code : "0x6080"),
      } as unknown as PaySimulator,
      randomAddress,
    },
  };
  return { root, x, deps, check, simulateContract, made, clock, randomAddress };
}

test("enforced smoke passes: allow, simulated block, pay reverts (reason recorded); elapsed recorded", async () => {
  const s = setup();
  expect(await main(["start"], s.deps)).toBe(0);
  s.clock.t = T0 + 7 * 60_000 + 30_000;
  expect(await main(["smoke"], s.deps)).toBe(0);
  expect(s.made[0]?.signer?.address.toLowerCase()).toBe(KEY_ADDRESS);
  expect(s.made[0]?.policyWallet).toBe(WALLET);
  expect(s.check.mock.calls.map((c) => [c[0].counterparty, c[0].amount])).toEqual([
    [GOOD, 1_000_000n],
    [DEMO, 1_000_000n],
  ]);
  const sim = s.simulateContract.mock.calls[0]?.[0];
  expect(sim?.functionName).toBe("pay");
  expect(sim?.address).toBe(WALLET);
  expect(sim?.args[0]).toBe(DEMO);
  const q = readJson(s.root, QUICKSTART_FILE);
  expect(q.passed).toBe(true);
  expect(q.failedStep).toBeNull();
  expect(q.elapsedSeconds).toBe(450);
  expect(q.underTenMinutes).toBe(true);
  const steps = (q.smoke as { steps: Record<string, unknown>[] }).steps;
  expect(steps.map((x) => [x.step, x.passed])).toEqual([
    ["good", true],
    ["demo", true],
    ["pay", true],
  ]);
  expect(steps[0]?.decision).toBe("allow");
  expect(steps[1]).toMatchObject({ decision: "block", simulated: true });
  expect(steps[2]).toMatchObject({ reverted: true, revertReason: "NotRegistered" });
  expect(s.x.out.join("\n")).toMatch(/elapsed: 7m 30s \(450 s\) under the ten-minute target/);
});

test("the elapsed time is frozen at the first passing smoke; over ten minutes is recorded as such", async () => {
  const s = setup();
  await main(["start"], s.deps);
  s.clock.t = T0 + 11 * 60_000;
  expect(await main(["smoke"], s.deps)).toBe(0);
  s.clock.t = T0 + 20 * 60_000;
  expect(await main(["smoke"], s.deps)).toBe(0);
  const q = readJson(s.root, QUICKSTART_FILE);
  expect(q.elapsedSeconds).toBe(660);
  expect(q.underTenMinutes).toBe(false);
});

test("smoke fails when the good address is not allow", async () => {
  const s = setup({ answer: ({ counterparty }) => (counterparty === DEMO ? enforcedAnswers({ counterparty, amount: 1n }) : checkResult({ decision: "hold" })) as CheckResult });
  expect(await main(["smoke"], s.deps)).toBe(1);
  const q = readJson(s.root, QUICKSTART_FILE);
  expect(q.passed).toBe(false);
  expect(q.failedStep).toBe("good");
  expect(s.simulateContract).not.toHaveBeenCalled();
  expect(s.x.out.join("\n")).toMatch(/FAILED at step "good"/);
});

test("smoke fails when the api answers advisory for the enforced wallet", async () => {
  const s = setup({ answer: () => checkResult({ decision: "allow", advisory: true, limit_write: "none" }) });
  expect(await main(["smoke"], s.deps)).toBe(1);
  expect(readJson(s.root, QUICKSTART_FILE).failedStep).toBe("good");
});

test("smoke fails when the Demo List Check is not a simulated block", async () => {
  const s = setup({ answer: () => checkResult({ decision: "allow" }) });
  expect(await main(["smoke"], s.deps)).toBe(1);
  expect(readJson(s.root, QUICKSTART_FILE).failedStep).toBe("demo");
});

test("smoke fails when the forced pay simulation succeeds", async () => {
  const s = setup({ simulate: async () => ({ result: undefined }) });
  expect(await main(["smoke"], s.deps)).toBe(1);
  const q = readJson(s.root, QUICKSTART_FILE);
  expect(q.passed).toBe(false);
  expect(q.failedStep).toBe("pay");
  expect(s.x.out.join("\n")).toMatch(/did NOT revert/);
});

test("a pay revert of Unauthorized fails: the env key is not the Payment role holder", async () => {
  const s = setup({ simulate: async () => Promise.reject(revert("Unauthorized")) });
  expect(await main(["smoke"], s.deps)).toBe(1);
  const pay = (readJson(s.root, QUICKSTART_FILE).smoke as { steps: Record<string, unknown>[] }).steps[2];
  expect(pay).toMatchObject({ step: "pay", reverted: true, revertReason: "Unauthorized", passed: false });
});

test("an RPC failure is not a revert", async () => {
  const s = setup({ simulate: async () => Promise.reject(new HttpRequestError({ url: "https://rpc.example/secret-key" })) });
  expect(await main(["smoke"], s.deps)).toBe(1);
  expect(s.x.all()).not.toContain("secret-key");
  expect((readJson(s.root, QUICKSTART_FILE).smoke as { steps: Record<string, unknown>[] }).steps[2]).toMatchObject({ reverted: false, passed: false });
});

test("a Check error fails the step with its code", async () => {
  const s = setup({
    answer: () => {
      throw new HorosError({ code: "judge_unavailable", message: "try later", retryable: true, attempts: 3 });
    },
  });
  expect(await main(["smoke"], s.deps)).toBe(1);
  expect(s.x.out.join("\n")).toMatch(/judge_unavailable: try later/);
});

test("no start: smoke runs and the elapsed time is recorded as unknown", async () => {
  const s = setup();
  expect(await main(["smoke"], s.deps)).toBe(0);
  const q = readJson(s.root, QUICKSTART_FILE);
  expect(q.passed).toBe(true);
  expect(q.startedAt).toBeNull();
  expect(q.elapsedSeconds).toBeNull();
  expect(q.underTenMinutes).toBeNull();
  expect(s.x.out.join("\n")).toMatch(/elapsed: unknown/);
});

test("shadow smoke: both Checks advisory with outcome recorded, API key from env, no pay simulation", async () => {
  const s = setup({ mode: "shadow" });
  await main(["start"], s.deps);
  s.clock.t = T0 + 120_000;
  expect(await main(["smoke", "--shadow"], s.deps)).toBe(0);
  expect(s.made[0]?.apiKey).toBe(API_KEY);
  expect(s.made[0]?.signer).toBeUndefined();
  expect(s.simulateContract).not.toHaveBeenCalled();
  const q = readJson(s.root, QUICKSTART_FILE);
  expect(q).toMatchObject({ passed: true, elapsedSeconds: 120, underTenMinutes: true });
  const steps = (q.smoke as { steps: Record<string, unknown>[] }).steps;
  expect(steps).toHaveLength(2);
  expect(steps[0]).toMatchObject({ decision: "allow", advisory: true, outcome: "advisory" });
  expect(steps[1]).toMatchObject({ decision: "block", simulated: true, advisory: true, outcome: "advisory" });
});

test("shadow smoke needs HOROS_API_KEY; mode mismatches are explained", async () => {
  const s = setup({ mode: "shadow", env: ENV });
  expect(await main(["smoke", "--shadow"], s.deps)).toBe(1);
  expect(s.x.all()).toMatch(/HOROS_API_KEY is not set/);
  expect(await main(["smoke"], s.deps)).toBe(1);
  expect(s.x.all()).toMatch(/run `horos-quickstart smoke --shadow`/);
});

test("enforced smoke without a Payment key: nothing runs", async () => {
  const s = setup({ env: { HOROS_BASE_URL: BASE_URL } });
  expect(await main(["smoke"], s.deps)).toBe(1);
  expect(s.check).not.toHaveBeenCalled();
  expect(s.x.all()).toMatch(/HOROS_PAYMENT_PRIVATE_KEY is not set/);
});

test("--good and --amount", async () => {
  const s = setup();
  const good = "0x2222222222222222222222222222222222222222";
  expect(await main(["smoke", "--good", good, "--amount", "2.5"], s.deps)).toBe(0);
  expect(s.check.mock.calls[0]?.[0]).toEqual({ counterparty: good, amount: 2_500_000n });
  expect(await main(["smoke", "--good", DEMO], s.deps)).toBe(1);
  expect(await main(["smoke", "--amount", "0"], s.deps)).toBe(1);
});

test("the bundled Demo List's first address is the smoke-test target", () => {
  expect(demoAddress(loadDemoList())).toBe(DEMO);
  expect(parseUsdc("1")).toBe(1_000_000n);
  expect(parseUsdc("0.000001")).toBe(1n);
  expect(() => parseUsdc("1.0000001")).toThrow();
  expect(revertOf(revert("Pinned"))).toEqual({ reverted: true, reason: "Pinned" });
  expect(revertOf(new Error("x"))).toEqual({ reverted: false });
  expect(KEY).toMatch(/^0x/);
});

test("pay step passes only on a blocking revert; any other revert fails with its name", async () => {
  for (const reason of ["NotRegistered", "Pinned", "LimitExceeded", "WalletCapExceeded", "PayeeIsContract"] as const) {
    const s = setup({ simulate: async () => Promise.reject(revert(reason)) });
    expect(await main(["smoke"], s.deps), reason).toBe(0);
  }
  for (const reason of ["InvalidAmount", "RoleVacant"] as const) {
    const s = setup({ simulate: async () => Promise.reject(revert(reason)) });
    expect(await main(["smoke"], s.deps), reason).toBe(1);
    const pay = (readJson(s.root, QUICKSTART_FILE).smoke as { steps: Record<string, unknown>[] }).steps[2];
    expect(pay).toMatchObject({ reverted: true, revertReason: reason, passed: false });
    expect(s.x.out.join("\n")).toContain(`pay reverted ${reason}`);
  }
  // A revert viem cannot decode (no matching error in the ABI).
  const undecodable = setup({
    simulate: async () =>
      Promise.reject(new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi: PAY_ABI, data: "0xdeadbeef", functionName: "pay" }), { abi: PAY_ABI, functionName: "pay" })),
  });
  expect(await main(["smoke"], undecodable.deps)).toBe(1);
});

test("pay step: no code at the PolicyWallet, or the RPC on another chain, fails before simulating", async () => {
  const noCode = setup({ code: "0x" });
  expect(await main(["smoke"], noCode.deps)).toBe(1);
  expect(noCode.simulateContract).not.toHaveBeenCalled();
  expect(noCode.x.out.join("\n")).toMatch(/no contract code at the PolicyWallet/);
  const missing = setup({ code: undefined });
  expect(await main(["smoke"], missing.deps)).toBe(1);
  const wrongChain = setup({ liveChainId: 1 });
  expect(await main(["smoke"], wrongChain.deps)).toBe(1);
  expect(wrongChain.simulateContract).not.toHaveBeenCalled();
  expect(wrongChain.x.out.join("\n")).toMatch(/the RPC is on chain 1, not horos\.config\.json chainId 5042002/);
});

test("the generated known-good address is saved and reused on reruns (and across start)", async () => {
  const s = setup();
  expect(await main(["smoke"], s.deps)).toBe(0);
  expect(readJson(s.root, QUICKSTART_FILE).goodAddress).toBe(GOOD);
  await main(["start"], s.deps);
  expect(await main(["smoke"], s.deps)).toBe(0);
  expect(s.randomAddress).toHaveBeenCalledOnce();
  expect(s.check.mock.calls.filter((c) => c[0].counterparty === GOOD)).toHaveLength(2);
});

test("--good equal to ANY Demo List entry is refused", async () => {
  const s = setup();
  for (const e of loadDemoList().entries) {
    expect(await main(["smoke", "--good", e.address.toUpperCase().replace("0X", "0x")], s.deps)).toBe(1);
  }
  expect(s.check).not.toHaveBeenCalled();
});

test("SM-4: start → fail (+3m) → pass (+8m) → fail: elapsed is 480 s from the first pass and never moves", async () => {
  let fail = true;
  const s = setup({ answer: (i) => (fail && i.counterparty === GOOD ? checkResult({ decision: "hold" }) : enforcedAnswers(i)) });
  await main(["start"], s.deps);
  s.clock.t = T0 + 3 * 60_000;
  expect(await main(["smoke"], s.deps)).toBe(1);
  let q = readJson(s.root, QUICKSTART_FILE);
  expect([q.elapsedSeconds, q.underTenMinutes, q.firstPassedAt]).toEqual([null, null, null]);
  fail = false;
  s.clock.t = T0 + 8 * 60_000;
  expect(await main(["smoke"], s.deps)).toBe(0);
  q = readJson(s.root, QUICKSTART_FILE);
  expect([q.elapsedSeconds, q.underTenMinutes]).toEqual([480, true]);
  fail = true;
  s.clock.t = T0 + 30 * 60_000;
  expect(await main(["smoke"], s.deps)).toBe(1);
  q = readJson(s.root, QUICKSTART_FILE);
  expect([q.passed, q.elapsedSeconds, q.underTenMinutes]).toEqual([false, 480, true]);
});

test("the result is printed before it is persisted; a refused write is reported and exits 1", async () => {
  const s = setup();
  mkdirSync(join(s.root, ".horos"), { recursive: true });
  writeFileSync(join(s.root, QUICKSTART_FILE), "{}");
  // Make the file unwritable in place: replace it with a directory after the good address is saved.
  const origCheck = s.check.getMockImplementation();
  s.check.mockImplementation(async (i) => {
    if (i.counterparty === DEMO) {
      rmSync(join(s.root, QUICKSTART_FILE), { force: true });
      mkdirSync(join(s.root, QUICKSTART_FILE));
    }
    return origCheck ? origCheck(i) : enforcedAnswers(i);
  });
  expect(await main(["smoke"], s.deps)).toBe(1);
  expect(s.x.out.join("\n")).toMatch(/smoke test \(enforced, 1000000 base units\) passed/);
  expect(s.x.err.join("\n")).toMatch(/could not record the smoke result/);
});

test("a corrupt quickstart file or bad field types warn on stderr instead of silently resetting", async () => {
  const s = setup();
  mkdirSync(join(s.root, ".horos"), { recursive: true });
  writeFileSync(join(s.root, QUICKSTART_FILE), "{not json");
  expect(await main(["smoke"], s.deps)).toBe(0);
  expect(s.x.err.join("\n")).toMatch(/quickstart\.json is corrupt/);
  const t = setup();
  mkdirSync(join(t.root, ".horos"), { recursive: true });
  writeFileSync(join(t.root, QUICKSTART_FILE), JSON.stringify({ startedAt: "2026-09-30T10:00:00Z", elapsedSeconds: "fast", underTenMinutes: 1, firstPassedAt: 5 }));
  const q = readQuickstart(t.root, t.x.e);
  expect(q.elapsedSeconds).toBeNull();
  expect(q.firstPassedAt).toBeNull();
  expect(t.x.err.join("\n")).toMatch(/invalid firstPassedAt, elapsedSeconds, underTenMinutes/);
});

test("HOROS_BASE_URL differing from horos.config.json is warned about", async () => {
  const s = setup({ env: { ...ENV, HOROS_BASE_URL: "https://other.horos.test" } });
  expect(await main(["smoke"], s.deps)).toBe(0);
  expect(s.x.err.join("\n")).toMatch(/HOROS_BASE_URL differs from horos\.config\.json baseUrl/);
  const same = setup();
  await main(["smoke"], same.deps);
  expect(same.x.err.join("\n")).not.toMatch(/differs/);
});
