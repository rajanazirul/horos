import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  accountDomain,
  CHECK_TYPES,
  checkDomain,
  checkMessageFromRequest,
  CheckRequest,
  declaredIdentityHash,
  errorEnvelope,
  READ_ACCESS_TYPES,
  readAccessMessage,
  RecordDetail,
  type CheckResponse,
  type ErrorCode,
  type Hex,
} from "@horos/schema";
import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, test } from "vitest";
import { createHoros, RETRY_EXPIRY_MARGIN_MS, type FetchLike, type HorosOptions } from "./client.js";
import { HorosError } from "./errors.js";
import { fromViemAccount, type CheckSigner } from "./signer.js";

// Well-known Foundry/Anvil dev key. Test-only; never funded on any real network.
const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const CHAIN_ID = 5042002;
const WALLET: Hex = "0x7ed77bdd025d461e15d8e85dbf3ab0e9a286774c";
const PAYEE: Hex = "0x1111111111111111111111111111111111111111";
const SCOPE = "enforced:01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f00";
const RECORD_ID = "01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f01";
// Not on a whole second: the expiry must round down.
const T0 = Date.parse("2026-09-28T12:00:00.300Z");

const ok: CheckResponse = {
  decision: "allow",
  effective_limit: "500000000",
  remaining: "450000000",
  reason: "first contact within the ceiling",
  confidence: 1,
  record_id: RECORD_ID,
  simulated: false,
  advisory: false,
  limit_write: "pending",
  chain_state: "live",
};

// A real, schema-valid Decision Record (the first golden vector) as a RecordDetail body.
const golden = JSON.parse(readFileSync(fileURLToPath(new URL("../../../fixtures/golden-record-hashes.json", import.meta.url)), "utf8")) as {
  record: unknown;
  hash: string;
}[];
const detailBody = { recordHash: golden[0]?.hash, record: golden[0]?.record, receipts: [] };
const pageBody = { records: [{ recordHash: golden[0]?.hash, record: golden[0]?.record }], nextCursor: 7 };
const statusBody = { counterparty: PAYEE, status: "ok", lastSeq: 3, pinned: false, limit: "100000000", chainState: "live" };
const statusPageBody = { counterparties: [statusBody], nextCursor: PAYEE };
const PUBLIC_SCOPE = "enforced:01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f0d";
const ZERO: Hex = "0x0000000000000000000000000000000000000000";
const AUTH_HEADERS = ["x-horos-wallet", "x-horos-expiry", "x-horos-signature"];

async function recoverRead(call: { headers: Record<string, string> } | undefined): Promise<string> {
  const addr = await recoverTypedDataAddress({
    domain: accountDomain(CHAIN_ID),
    types: READ_ACCESS_TYPES,
    primaryType: "ReadAccess",
    message: readAccessMessage(WALLET, call?.headers["x-horos-expiry"] ?? ""),
    signature: (call?.headers["x-horos-signature"] ?? "0x") as Hex,
  });
  return addr.toLowerCase();
}

type Reply = Response | (() => Response) | Error;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const envelope = (code: ErrorCode, status: number, retryable?: boolean, headers?: Record<string, string>) =>
  json(status, errorEnvelope(code, `${code} happened`, retryable), headers);

function harness(replies: Reply[] | ((n: number) => Reply), opts: Partial<HorosOptions> = {}, drop: readonly (keyof HorosOptions)[] = []) {
  let clock = T0;
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const sleeps: number[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }) });
    const r = typeof replies === "function" ? replies(calls.length) : replies[calls.length - 1];
    if (r === undefined) throw new Error("no reply queued");
    if (r instanceof Error) throw r;
    return typeof r === "function" ? r() : r;
  };
  const all: Record<string, unknown> = {
    baseUrl: "https://api.horos.test/",
    chainId: CHAIN_ID,
    policyWallet: WALLET,
    signer: fromViemAccount(account),
    fetch,
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    ...opts,
  };
  const options = Object.fromEntries(Object.entries(all).filter(([k]) => !drop.includes(k as keyof HorosOptions)));
  const horos = createHoros(options as unknown as HorosOptions);
  return { horos, calls, sleeps, clock: () => clock };
}

const bodyOf = (call: { body?: string } | undefined): CheckRequest => CheckRequest.parse(JSON.parse(call?.body ?? "null"));

async function recoverCheck(req: CheckRequest): Promise<string> {
  const addr = await recoverTypedDataAddress({
    domain: checkDomain(CHAIN_ID, WALLET),
    types: CHECK_TYPES,
    primaryType: "Check",
    message: checkMessageFromRequest(req),
    signature: req.auth?.signature ?? "0x",
  });
  return addr.toLowerCase();
}

async function rejection(p: Promise<unknown>): Promise<HorosError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(HorosError);
    return err as HorosError;
  }
  throw new Error("expected a rejection");
}

describe("check()", () => {
  test("signed allow: POSTs a Check envelope that recovers to the signer and returns the parsed response", async () => {
    const h = harness([json(200, ok)]);
    const res = await h.horos.check({ counterparty: PAYEE.toUpperCase().replace("0X", "0x"), amount: 50_000_000n });
    expect(res).toEqual(ok);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.url).toBe("https://api.horos.test/v1/check");
    expect(h.calls[0]?.method).toBe("POST");
    const req = bodyOf(h.calls[0]);
    const raw = JSON.parse(h.calls[0]?.body ?? "{}");
    // Wire form: lowercase addresses, decimal-string amount, no declared_identity.
    expect(raw).toMatchObject({ policy_wallet: WALLET, counterparty: PAYEE, amount: "50000000" });
    expect(raw).not.toHaveProperty("declared_identity");
    expect(await recoverCheck(req)).toBe(account.address.toLowerCase());
    // Default expiry: 120 s, a whole second, rounded down.
    expect(req.auth?.expiry).toBe("2026-09-28T12:02:00.000Z");
    expect(checkMessageFromRequest(req).declaredIdentityHash).toBe(`0x${"0".repeat(64)}`);
  });

  test("every Check gets a fresh random 32-byte nonce", async () => {
    const h = harness([json(200, ok), json(200, ok)]);
    await h.horos.check({ counterparty: PAYEE, amount: 1n });
    await h.horos.check({ counterparty: PAYEE, amount: 1n });
    const [a, b] = [bodyOf(h.calls[0]).auth?.nonce, bodyOf(h.calls[1]).auth?.nonce];
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  test("declared identity: carried as declared_identity and hashed into the signed struct", async () => {
    const h = harness([json(200, ok)]);
    const identity = { name: "Acme" };
    await h.horos.check({ counterparty: PAYEE, amount: 1n, declaredIdentity: identity });
    const req = bodyOf(h.calls[0]);
    expect(req.declared_identity).toEqual(identity);
    const signature = req.auth?.signature ?? "0x";
    const recovered = await recoverTypedDataAddress({
      domain: checkDomain(CHAIN_ID, WALLET),
      types: CHECK_TYPES,
      primaryType: "Check",
      message: { ...checkMessageFromRequest(req), declaredIdentityHash: declaredIdentityHash(identity) },
      signature,
    });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
    expect(declaredIdentityHash(identity)).not.toBe(`0x${"0".repeat(64)}`);
  });

  test.each([
    ["empty identity", { declaredIdentity: {} }],
    ["unknown identity field", { declaredIdentity: { name: "Acme", ssn: "x" } }],
    ["amount 0", { amount: 0n }],
    ["negative amount", { amount: -5n }],
    ["number amount", { amount: 5 }],
    ["amount out of range", { amount: 10n ** 38n }],
    ["non-address counterparty", { counterparty: "0x1234" }],
    ["bad checksum", { counterparty: "0xF39FD6e51aad88F6F4ce6aB8827279cffFb92266" }],
  ])("bad input (%s): validation_failed, no network call", async (_name, patch) => {
    const h = harness([]);
    const err = await rejection(h.horos.check({ counterparty: PAYEE, amount: 1n, ...patch } as never));
    expect(err).toMatchObject({ code: "validation_failed", retryable: false, attempts: 0 });
    expect(h.calls).toHaveLength(0);
  });

  test("an invalid identity's values never reach the error message", async () => {
    const h = harness([]);
    const err = await rejection(h.horos.check({ counterparty: PAYEE, amount: 1n, declaredIdentity: { name: "SECRET-NAME", purpose: "p".repeat(501) } }));
    expect(err.message).not.toContain("SECRET-NAME");
    expect(err.message).not.toContain("ppppp");
  });

  test("retryable no-record error (503 judge_unavailable) then 200: two POSTs with the identical body", async () => {
    const h = harness([envelope("judge_unavailable", 503), json(200, ok)]);
    expect(await h.horos.check({ counterparty: PAYEE, amount: 1n })).toEqual(ok);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]?.body).toBe(h.calls[0]?.body);
    expect(h.sleeps).toEqual([250]);
  });

  test("always retryable: bounded exponential backoff, stops before the envelope expires", async () => {
    const h = harness(() => envelope("judge_unavailable", 503));
    const err = await rejection(h.horos.check({ counterparty: PAYEE, amount: 1n }));
    expect(err).toMatchObject({ code: "judge_unavailable", retryable: true, status: 503 });
    expect(err.attempts).toBeGreaterThan(5);
    expect(err.attempts).toBe(h.calls.length);
    expect(h.sleeps.slice(0, 6)).toEqual([250, 500, 1000, 2000, 4000, 4000]);
    expect(Math.max(...h.sleeps)).toBe(4000);
    const expiryMs = Date.parse(bodyOf(h.calls[0]).auth?.expiry ?? "");
    expect(h.clock()).toBeLessThan(expiryMs - RETRY_EXPIRY_MARGIN_MS);
    // One more backoff would have crossed the margin.
    expect(h.clock() + 4000).toBeGreaterThanOrEqual(expiryMs - RETRY_EXPIRY_MARGIN_MS);
    for (const c of h.calls) expect(c.body).toBe(h.calls[0]?.body);
  });

  test("non-retryable (400 validation_failed): a single POST, then HorosError", async () => {
    const h = harness([envelope("validation_failed", 400)]);
    const err = await rejection(h.horos.check({ counterparty: PAYEE, amount: 1n }));
    expect(err).toMatchObject({ code: "validation_failed", retryable: false, status: 400, attempts: 1 });
    expect(h.calls).toHaveLength(1);
  });

  test("the envelope's retryable flag is authoritative over the code's default", async () => {
    const noRetry = harness([envelope("internal", 500, false)]);
    expect(await rejection(noRetry.horos.check({ counterparty: PAYEE, amount: 1n }))).toMatchObject({ code: "internal", attempts: 1 });
    const retry = harness([envelope("conflict", 409, true), json(200, ok)]);
    expect(await retry.horos.check({ counterparty: PAYEE, amount: 1n })).toEqual(ok);
    expect(retry.calls).toHaveLength(2);
  });

  test("429 with Retry-After: 1 waits at least 1 s, then resends the same body", async () => {
    const h = harness([envelope("rate_limited", 429, undefined, { "retry-after": "1" }), json(200, ok)]);
    expect(await h.horos.check({ counterparty: PAYEE, amount: 1n })).toEqual(ok);
    expect(h.sleeps).toEqual([1000]);
    expect(h.calls[1]?.body).toBe(h.calls[0]?.body);
  });

  test("429 whose Retry-After is past the envelope's expiry: gives up without sleeping", async () => {
    const h = harness([envelope("rate_limited", 429, undefined, { "retry-after": "600" })]);
    const err = await rejection(h.horos.check({ counterparty: PAYEE, amount: 1n }));
    expect(err).toMatchObject({ code: "rate_limited", retryable: true, attempts: 1 });
    expect(h.sleeps).toEqual([]);
  });

  test("network failure and non-JSON bodies are retryable `unavailable`", async () => {
    const h = harness([new TypeError("fetch failed"), new Response("<html>bad gateway</html>", { status: 502 }), json(200, ok)]);
    expect(await h.horos.check({ counterparty: PAYEE, amount: 1n })).toEqual(ok);
    expect(h.calls).toHaveLength(3);
  });

  test("network failure until expiry: HorosError('unavailable')", async () => {
    const h = harness(() => new TypeError("fetch failed"));
    const err = await rejection(h.horos.check({ counterparty: PAYEE, amount: 1n }));
    expect(err).toMatchObject({ code: "unavailable", retryable: true });
    expect(err.attempts).toBeGreaterThan(1);
  });

  test("HTML body until expiry: HorosError('unavailable') with the HTTP status", async () => {
    const h = harness(() => new Response("<html>nope</html>", { status: 502 }));
    expect(await rejection(h.horos.check({ counterparty: PAYEE, amount: 1n }))).toMatchObject({ code: "unavailable", status: 502 });
  });

  test.each([
    ["schema-invalid", () => json(200, { decision: "maybe" })],
    ["non-JSON", () => new Response("<html>ok</html>", { status: 200 })],
  ])("a 200 with a %s body is not retried (a resend would be a replay): one POST, non-retryable `unavailable`", async (_name, reply) => {
    const h = harness([reply(), json(200, ok)]);
    const err = await rejection(h.horos.check({ counterparty: PAYEE, amount: 1n }));
    expect(err).toMatchObject({ code: "unavailable", retryable: false, status: 200, attempts: 1 });
    expect(h.calls).toHaveLength(1);
  });

  test("a retryable 503 with Retry-After waits for it; Retry-After as an HTTP date works too", async () => {
    const h = harness([
      envelope("unavailable", 503, undefined, { "retry-after": "3" }),
      envelope("unavailable", 503, undefined, { "retry-after": new Date(T0 + 3000 + 10_000).toUTCString() }),
      json(200, ok),
    ]);
    expect(await h.horos.check({ counterparty: PAYEE, amount: 1n })).toEqual(ok);
    // HTTP dates drop milliseconds: T0 + 13 s (12:00:13.300) formats as 12:00:13, i.e. 9.7 s after the first 3 s wait.
    expect(h.sleeps).toEqual([3000, 9700]);
  });

  test("Retry-After: 0 never goes below the backoff", async () => {
    const h = harness([envelope("unavailable", 503, undefined, { "retry-after": "0" }), json(200, ok)]);
    await h.horos.check({ counterparty: PAYEE, amount: 1n });
    expect(h.sleeps).toEqual([250]);
  });

  test("a throwing signer: unauthenticated, no request, and its message (may carry credentials) is not echoed", async () => {
    const leaky: CheckSigner = {
      address: account.address.toLowerCase() as Hex,
      signTypedData: async () => {
        throw new Error("Authorization: Bearer SECRET-KEY");
      },
    };
    const h = harness([json(200, ok)], { signer: leaky });
    const err = await rejection(h.horos.check({ counterparty: PAYEE, amount: 1n }));
    expect(err).toMatchObject({ code: "unauthenticated", attempts: 0 });
    expect(err.message).not.toContain("SECRET-KEY");
    expect(err.message).not.toContain("Bearer");
    expect(h.calls).toHaveLength(0);
  });

  test("an unrecoverable signature from a custom signer: unauthenticated HorosError, no request", async () => {
    const junk: CheckSigner = { address: account.address.toLowerCase() as Hex, signTypedData: async () => `0x${"00".repeat(65)}` as Hex };
    const h = harness([json(200, ok)], { signer: junk });
    expect(await rejection(h.horos.check({ counterparty: PAYEE, amount: 1n }))).toMatchObject({ code: "unauthenticated", attempts: 0 });
    expect(h.calls).toHaveLength(0);
  });

  test("a signer whose signature does not recover to its address fails before any request", async () => {
    const other = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const liar: CheckSigner = { address: account.address.toLowerCase() as Hex, signTypedData: (td) => fromViemAccount(other).signTypedData(td) };
    const h = harness([json(200, ok)], { signer: liar });
    expect(await rejection(h.horos.check({ counterparty: PAYEE, amount: 1n }))).toMatchObject({ code: "unauthenticated", attempts: 0 });
    expect(h.calls).toHaveLength(0);
  });
});

describe("createHoros()", () => {
  test.each([
    ["expiry over the maximum", { expirySeconds: 301 }],
    ["fractional expiry", { expirySeconds: 1.5 }],
    ["zero expiry", { expirySeconds: 0 }],
    ["expiry inside the retry margin", { expirySeconds: 6 }],
    ["bad policy wallet", { policyWallet: "0x12" }],
    ["bad chain id", { chainId: 0 }],
    ["bad base url", { baseUrl: "api.horos.test" }],
    ["non-http base url", { baseUrl: "ftp://api.horos.test" }],
    ["malformed scope", { scope: "enforced:nope" }],
    ["malformed signer address", { signer: { address: "0x12", signTypedData: async () => "0x" } }],
  ])("rejects %s", (_name, patch) => {
    expect(() => harness([], patch as Partial<HorosOptions>)).toThrow(HorosError);
  });

  test("a malformed signer address is validation_failed, not a raw ZodError", () => {
    try {
      harness([], { signer: { address: "0x12" as Hex, signTypedData: async () => "0x" } });
    } catch (err) {
      expect(err).toMatchObject({ code: "validation_failed" });
      expect((err as Error).message).toMatch(/^signer\.address:/);
      return;
    }
    throw new Error("expected a throw");
  });

  test("the minimum expiry (7 s) is accepted", () => {
    expect(() => harness([], { expirySeconds: 7 })).not.toThrow();
  });

  test("a configurable expiry up to 300 s", async () => {
    const h = harness([json(200, ok)], { expirySeconds: 300 });
    await h.horos.check({ counterparty: PAYEE, amount: 1n });
    expect(bodyOf(h.calls[0]).auth?.expiry).toBe("2026-09-28T12:05:00.000Z");
  });
});

describe("getRecord()", () => {
  test("sends a signed ReadAccess that recovers to the signer", async () => {
    const h = harness([envelope("not_found", 404)], { scope: SCOPE });
    const err = await rejection(h.horos.getRecord(RECORD_ID));
    expect(err).toMatchObject({ code: "not_found", attempts: 1 });
    const call = h.calls[0];
    expect(call?.method).toBe("GET");
    expect(call?.url).toBe(`https://api.horos.test/v1/scopes/${encodeURIComponent(SCOPE)}/records/${RECORD_ID}`);
    expect(call?.headers["x-horos-wallet"]).toBe(WALLET);
    const expiry = call?.headers["x-horos-expiry"] ?? "";
    expect(expiry).toBe("2026-09-28T12:01:00.000Z");
    const recovered = await recoverTypedDataAddress({
      domain: accountDomain(CHAIN_ID),
      types: READ_ACCESS_TYPES,
      primaryType: "ReadAccess",
      message: readAccessMessage(WALLET, expiry),
      signature: (call?.headers["x-horos-signature"] ?? "0x") as Hex,
    });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  test("success with a per-call scope on a client built without one", async () => {
    const h = harness([json(200, detailBody)]);
    const detail = await h.horos.getRecord(RECORD_ID, { scope: SCOPE });
    expect(detail).toEqual(RecordDetail.parse(detailBody));
    expect(h.calls[0]?.url).toBe(`https://api.horos.test/v1/scopes/${encodeURIComponent(SCOPE)}/records/${RECORD_ID}`);
  });

  test("the per-call scope wins over the client's", async () => {
    const other = "enforced:01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f99";
    const h = harness([json(200, detailBody)], { scope: other });
    await h.horos.getRecord(RECORD_ID, { scope: SCOPE });
    expect(h.calls[0]?.url).toContain(encodeURIComponent(SCOPE));
    expect(h.calls[0]?.url).not.toContain(encodeURIComponent(other));
  });

  test("needs a scope; rejects a malformed record id", async () => {
    const h = harness([]);
    expect(await rejection(h.horos.getRecord(RECORD_ID))).toMatchObject({ code: "validation_failed" });
    expect(await rejection(h.horos.getRecord("nope", { scope: SCOPE }))).toMatchObject({ code: "validation_failed" });
    expect(h.calls).toHaveLength(0);
  });
});

describe("advisory mode (no signer)", () => {
  const unsigned = (replies: Reply[], opts: Partial<HorosOptions> = {}) => harness(replies, opts, ["signer", "policyWallet"]);
  const advisoryOk: CheckResponse = { ...ok, advisory: true, limit_write: "none", chain_state: "stale" };

  test("check() sends a CheckRequest with no auth, bound to the zero address", async () => {
    const h = unsigned([json(200, advisoryOk)]);
    expect(h.horos.signed).toBe(false);
    expect(h.horos.address).toBeUndefined();
    expect(h.horos.policyWallet).toBe(ZERO);
    const res = await h.horos.check({ counterparty: PAYEE, amount: 5n, declaredIdentity: { name: "Acme" } });
    expect(res).toEqual(advisoryOk);
    const raw = JSON.parse(h.calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(raw).not.toHaveProperty("auth");
    expect(raw).toEqual({ policy_wallet: ZERO, counterparty: PAYEE, amount: "5", declared_identity: { name: "Acme" } });
  });

  test("an explicit policyWallet is kept without a signer", async () => {
    const h = harness([json(200, advisoryOk)], {}, ["signer"]);
    await h.horos.check({ counterparty: PAYEE, amount: 5n });
    expect(bodyOf(h.calls[0])).toEqual({ policy_wallet: WALLET, counterparty: PAYEE, amount: "5" });
  });

  test("an unsigned Check retries a retryable failure with the same body", async () => {
    const h = unsigned([envelope("judge_unavailable", 503), json(200, advisoryOk)]);
    await h.horos.check({ counterparty: PAYEE, amount: 5n });
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]?.body).toBe(h.calls[0]?.body);
  });

  test("policyWallet stays required with a signer", () => {
    expect(() => harness([], {}, ["policyWallet"])).toThrow(/policyWallet is required with a signer/);
    try {
      harness([], {}, ["policyWallet"]);
    } catch (err) {
      expect(err).toMatchObject({ code: "validation_failed" });
    }
  });

  test("the signed client reports signed: true and the Payment address", () => {
    const h = harness([]);
    expect(h.horos.signed).toBe(true);
    expect(h.horos.address).toBe(account.address.toLowerCase());
  });
});

describe("read methods", () => {
  const signedH = (replies: Reply[], opts: Partial<HorosOptions> = {}) => harness(replies, { scope: SCOPE, ...opts });
  const unsignedH = (replies: Reply[], opts: Partial<HorosOptions> = {}) => harness(replies, { scope: PUBLIC_SCOPE, ...opts }, ["signer", "policyWallet"]);
  const base = "https://api.horos.test/v1/scopes/";

  test("listRecords, signed: ReadAccess headers, query params, RecordPage", async () => {
    const h = signedH([json(200, pageBody)]);
    const page = await h.horos.listRecords({ after: 3, limit: 10 });
    expect(page.nextCursor).toBe(7);
    expect(page.records).toHaveLength(1);
    expect(h.calls[0]?.url).toBe(`${base}${encodeURIComponent(SCOPE)}/records?after=3&limit=10`);
    expect(h.calls[0]?.headers["x-horos-wallet"]).toBe(WALLET);
    expect(await recoverRead(h.calls[0])).toBe(account.address.toLowerCase());
  });

  test("listRecords, unsigned: no auth headers and no query when none given", async () => {
    const h = unsignedH([json(200, pageBody)]);
    await h.horos.listRecords();
    expect(h.calls[0]?.url).toBe(`${base}${encodeURIComponent(PUBLIC_SCOPE)}/records`);
    for (const k of AUTH_HEADERS) expect(h.calls[0]?.headers).not.toHaveProperty(k);
  });

  test("getRecord accepts any valid Scope; unsigned sends no auth headers", async () => {
    const h = unsignedH([json(200, detailBody)]);
    await h.horos.getRecord(RECORD_ID, { scope: "advisory-public" });
    expect(h.calls[0]?.url).toBe(`${base}advisory-public/records/${RECORD_ID}`);
    for (const k of AUTH_HEADERS) expect(h.calls[0]?.headers).not.toHaveProperty(k);
  });

  test("listCounterparties, signed and unsigned", async () => {
    const s = signedH([json(200, statusPageBody)]);
    const page = await s.horos.listCounterparties({ after: PAYEE, limit: 100 });
    expect(page.counterparties[0]?.counterparty).toBe(PAYEE);
    expect(s.calls[0]?.url).toBe(`${base}${encodeURIComponent(SCOPE)}/counterparties?after=${PAYEE}&limit=100`);
    expect(await recoverRead(s.calls[0])).toBe(account.address.toLowerCase());

    const u = unsignedH([json(200, statusPageBody)]);
    await u.horos.listCounterparties();
    expect(u.calls[0]?.url).toBe(`${base}${encodeURIComponent(PUBLIC_SCOPE)}/counterparties`);
    for (const k of AUTH_HEADERS) expect(u.calls[0]?.headers).not.toHaveProperty(k);
  });

  test("getCounterparty, signed and unsigned (the address is lowercased)", async () => {
    const s = signedH([json(200, statusBody)]);
    const view = await s.horos.getCounterparty(PAYEE.toUpperCase().replace("0X", "0x"));
    expect(view.status).toBe("ok");
    expect(s.calls[0]?.url).toBe(`${base}${encodeURIComponent(SCOPE)}/counterparties/${PAYEE}`);
    expect(await recoverRead(s.calls[0])).toBe(account.address.toLowerCase());

    const u = unsignedH([json(200, statusBody)]);
    await u.horos.getCounterparty(PAYEE);
    for (const k of AUTH_HEADERS) expect(u.calls[0]?.headers).not.toHaveProperty(k);
  });

  test("an unsigned read of a private Scope surfaces the api's 401", async () => {
    const h = unsignedH([envelope("unauthenticated", 401)], { scope: SCOPE });
    expect(await rejection(h.horos.listRecords())).toMatchObject({ code: "unauthenticated", status: 401, attempts: 1 });
  });

  test.each([0, 101, 1.5, -1])("limit %s is refused before any request", async (limit) => {
    const h = signedH([]);
    expect(await rejection(h.horos.listRecords({ limit }))).toMatchObject({ code: "validation_failed", attempts: 0 });
    expect(await rejection(h.horos.listCounterparties({ limit }))).toMatchObject({ code: "validation_failed", attempts: 0 });
    expect(h.calls).toHaveLength(0);
  });

  test("limits 1 and 100 are accepted", async () => {
    const h = signedH([json(200, pageBody), json(200, pageBody)]);
    await h.horos.listRecords({ limit: 1 });
    await h.horos.listRecords({ limit: 100 });
    expect(h.calls).toHaveLength(2);
  });

  test("bad cursors and addresses are refused before any request", async () => {
    const h = signedH([]);
    expect(await rejection(h.horos.listRecords({ after: -1 }))).toMatchObject({ code: "validation_failed" });
    expect(await rejection(h.horos.listCounterparties({ after: "0x12" }))).toMatchObject({ code: "validation_failed" });
    expect(await rejection(h.horos.getCounterparty("0x12"))).toMatchObject({ code: "validation_failed" });
    expect(await rejection(h.horos.listRecords({ scope: "enforced:nope" }))).toMatchObject({ code: "validation_failed" });
    expect(h.calls).toHaveLength(0);
  });

  test("every read method needs a scope: validation_failed, no request", async () => {
    const h = harness([]);
    expect(await rejection(h.horos.listRecords())).toMatchObject({ code: "validation_failed", attempts: 0 });
    expect(await rejection(h.horos.getRecord(RECORD_ID))).toMatchObject({ code: "validation_failed", attempts: 0 });
    expect(await rejection(h.horos.listCounterparties())).toMatchObject({ code: "validation_failed", attempts: 0 });
    expect(await rejection(h.horos.getCounterparty(PAYEE))).toMatchObject({ code: "validation_failed", attempts: 0 });
    expect(h.calls).toHaveLength(0);
  });

  test("a 200 that does not match the schema is a non-retryable unavailable", async () => {
    const h = signedH([json(200, { records: "nope" })]);
    expect(await rejection(h.horos.listRecords())).toMatchObject({ code: "unavailable", retryable: false });
  });
});
