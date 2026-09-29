// Smoke/latency check for `POST /v1/check` (Story 2.9; Story 2.10's CI runs it against testnet).
// Sends N signed Checks one after another, each to a fresh random counterparty, and prints p50/p95 latency (ms) and
// the decision counts.
//
// Requires Node >= 24 (the repo's engine): the file runs directly through Node's built-in TypeScript type stripping.
//
//   HOROS_SMOKE_BASE_URL=https://api.example  HOROS_SMOKE_PAYMENT_KEY=0x...  HOROS_SMOKE_POLICY_WALLET=0x...  \
//   [HOROS_SMOKE_CHAIN_ID=5042002]  [HOROS_SMOKE_N=20]  [HOROS_SMOKE_AMOUNT=1000000]  [HOROS_SMOKE_P95_MAX_MS=...]  \
//   [HOROS_SMOKE_ALLOW_ADVISORY=1]  node services/api/scripts/smoke-check.ts
//
// The Payment key comes from the environment only; it is never printed. Exits non-zero when any request fails
// (network error, non-200, unparsable or schema-invalid body), when any answer is advisory (the Check was not
// authenticated) unless HOROS_SMOKE_ALLOW_ADVISORY=1, or when p95 exceeds HOROS_SMOKE_P95_MAX_MS. Every Check is a
// first contact, so against a real PolicyWallet it queues Registration intents and uses the New-Payee Cap.
// Needs `@horos/schema` built (`pnpm turbo run build`).
import { randomBytes } from "node:crypto";
import { CHECK_TYPES, checkDomain, checkMessageFromRequest, CheckResponse, toWireTime, type CheckRequest, type Hex } from "@horos/schema";
import { privateKeyToAccount } from "viem/accounts";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v.length === 0) throw new Error(`${name} is required`);
  return v;
}

/** A whole number in [min, max] from the environment; throws on anything else (never NaN). */
function intEnv(name: string, fallback: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env(name, fallback);
  const v = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(v) || v < min || v > max) throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  return v;
}

const baseUrl = env("HOROS_SMOKE_BASE_URL").replace(/\/+$/, "");
const account = privateKeyToAccount(env("HOROS_SMOKE_PAYMENT_KEY") as Hex);
const policyWallet = env("HOROS_SMOKE_POLICY_WALLET").toLowerCase() as Hex;
const chainId = intEnv("HOROS_SMOKE_CHAIN_ID", "5042002", 1);
const n = intEnv("HOROS_SMOKE_N", "20", 1, 10_000);
const amount = String(intEnv("HOROS_SMOKE_AMOUNT", "1000000", 1));
const p95Max = process.env.HOROS_SMOKE_P95_MAX_MS === undefined ? undefined : intEnv("HOROS_SMOKE_P95_MAX_MS", "", 1);
const allowAdvisory = process.env.HOROS_SMOKE_ALLOW_ADVISORY === "1";

async function signedCheck(): Promise<CheckRequest> {
  const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;
  const expiry = toWireTime(new Date(Math.ceil((Date.now() + 120_000) / 1000) * 1000));
  const counterparty = `0x${randomBytes(20).toString("hex")}` as Hex;
  const unsigned: CheckRequest = { policy_wallet: policyWallet, counterparty, amount, auth: { nonce, expiry, signature: `0x${"0".repeat(130)}` } };
  const signature = await account.signTypedData({
    domain: checkDomain(chainId, policyWallet),
    types: CHECK_TYPES,
    primaryType: "Check",
    message: checkMessageFromRequest(unsigned),
  });
  return { ...unsigned, auth: { nonce, expiry, signature } };
}

const quantile = (sorted: readonly number[], q: number): number => sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] ?? Number.NaN;

const times: number[] = [];
const decisions = new Map<string, number>();
let failures = 0;
let advisory = 0;
for (let i = 0; i < n; i++) {
  const body = JSON.stringify(await signedCheck());
  const t0 = performance.now();
  let status: number;
  let text: string;
  try {
    const res = await fetch(`${baseUrl}/v1/check`, { method: "POST", headers: { "content-type": "application/json" }, body });
    status = res.status;
    text = await res.text();
  } catch (err) {
    failures++;
    console.error(`check ${i + 1}: request failed: ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }
  times.push(performance.now() - t0);
  if (status !== 200) {
    failures++;
    console.error(`check ${i + 1}: HTTP ${status} ${text.slice(0, 200)}`);
    continue;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    failures++;
    console.error(`check ${i + 1}: response is not JSON`);
    continue;
  }
  const parsed = CheckResponse.safeParse(json);
  if (!parsed.success) {
    failures++;
    console.error(`check ${i + 1}: response does not match CheckResponse`);
    continue;
  }
  if (parsed.data.advisory) {
    advisory++;
    if (!allowAdvisory) console.error(`check ${i + 1}: advisory answer (the Check was not authenticated)`);
  }
  const key = `${parsed.data.decision}${parsed.data.advisory ? " (advisory)" : ""}`;
  decisions.set(key, (decisions.get(key) ?? 0) + 1);
}

times.sort((a, b) => a - b);
const p50 = quantile(times, 0.5);
const p95 = quantile(times, 0.95);
console.log(JSON.stringify({ n, failures, advisory, p50Ms: Math.round(p50), p95Ms: Math.round(p95), decisions: Object.fromEntries(decisions) }));
if (failures > 0) process.exit(1);
if (advisory > 0 && !allowAdvisory) process.exit(1);
if (p95Max !== undefined && p95 > p95Max) {
  console.error(`p95 ${Math.round(p95)} ms exceeds ${p95Max} ms`);
  process.exit(1);
}
