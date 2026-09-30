// The MCP server end to end over an in-memory transport: an MCP client calls the tools, the server drives a real
// `@horos/sdk` client, and a fake fetch plays the api. Covers the tool list, the Check modes and every error row.
import { errorEnvelope, type CheckResponse, type ErrorCode, type Hex } from "@horos/schema";
import { createHoros, fromViemAccount, type FetchLike, type HorosOptions } from "@horos/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, test } from "vitest";
import { ADVISORY_NOTE, createHorosMcpServer, LIMIT_WRITE_FAILED_NOTE, TOOL_NAMES } from "./server.js";

// Well-known Foundry/Anvil dev key. Test-only; never funded on any real network.
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(KEY);
const WALLET: Hex = "0x7ed77bdd025d461e15d8e85dbf3ab0e9a286774c";
const PAYEE: Hex = "0x1111111111111111111111111111111111111111";
const SCOPE = "enforced:01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f00";
const DEMO_SCOPE = "enforced:01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f0d";
const RECORD_ID = "01926f3a-7b2c-7d4e-9a11-3b4c5d6e7f01";
const T0 = Date.parse("2026-09-28T12:00:00.000Z");
const AUTH_HEADERS = ["x-horos-wallet", "x-horos-expiry", "x-horos-signature"];

const enforced: CheckResponse = {
  decision: "cap",
  effective_limit: "500000000",
  remaining: "20000000",
  reason: "first contact within the ceiling",
  confidence: 0.9,
  record_id: RECORD_ID,
  simulated: false,
  advisory: false,
  limit_write: "pending",
  chain_state: "live",
  payable_amount: "20000000",
};
const advisory: CheckResponse = {
  decision: "allow",
  effective_limit: "500000000",
  remaining: "450000000",
  reason: "advisory: no signed envelope",
  confidence: 0.9,
  record_id: RECORD_ID,
  simulated: false,
  advisory: true,
  limit_write: "none",
  chain_state: "stale",
};
// Golden records: #1 carries a free-text Declared Identity ("Acme Data Labs") and a reason; #5 is an external record.
const golden = JSON.parse(readFileSync(fileURLToPath(new URL("../../../fixtures/golden-record-hashes.json", import.meta.url)), "utf8")) as {
  record: { id: string; reason: string };
  hash: string;
}[];
const withIdentity = golden[1];
const external = golden[5];
const statusBody = { counterparty: PAYEE, status: "ok", lastSeq: 3, pinned: false, limit: "100000000", chainState: "live" };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const envelope = (code: ErrorCode, status: number, retryable?: boolean) => json(status, errorEnvelope(code, `${code} happened`, retryable));

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

async function harness(replies: Response[], opts: { signed: boolean; scope?: string }) {
  let clock = T0;
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }) });
    const r = replies[calls.length - 1];
    if (r === undefined) throw new Error("no reply queued");
    return r;
  };
  const options: HorosOptions = {
    baseUrl: "https://api.horos.test",
    chainId: 5042002,
    fetch,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    ...(opts.scope === undefined ? {} : { scope: opts.scope }),
    ...(opts.signed ? { policyWallet: WALLET, signer: fromViemAccount(account) } : {}),
  };
  const server = createHorosMcpServer({ client: createHoros(options) });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { client, call, calls };
}

const text = (r: CallToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

describe("tool list", () => {
  test("exactly the five check/read tools", async () => {
    const h = await harness([], { signed: true });
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(TOOL_NAMES).toHaveLength(5);
  });

  test("no tool name, description or input field suggests a raise, pin, limit change, policy change, register, deploy or Human action", async () => {
    const h = await harness([], { signed: true });
    const { tools } = await h.client.listTools();
    const forbidden = /raise|pin|set.?limit|policy.?change|register|deploy|human/i;
    for (const t of tools) {
      expect(t.name).not.toMatch(forbidden);
      expect(t.description ?? "", t.name).not.toMatch(forbidden);
      expect(Object.keys(t.inputSchema.properties ?? {}).join(" "), t.name).not.toMatch(forbidden);
    }
    for (const t of tools.filter((x) => x.name !== "check")) expect(t.annotations?.readOnlyHint, t.name).toBe(true);
  });

  test("every tool advertises input and output JSON schemas", async () => {
    const h = await harness([], { signed: true });
    const { tools } = await h.client.listTools();
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.outputSchema?.type, t.name).toBe("object");
    }
  });
});

describe("check", () => {
  test("signed: the request carries auth; output has every FR-2 field and mode enforced", async () => {
    const h = await harness([json(200, enforced)], { signed: true });
    const r = await h.call("check", { counterparty: PAYEE, amount: "50000000", declared_identity: { name: "Acme Test Supplies" } });
    expect(r.isError).toBeFalsy();
    const sent = JSON.parse(h.calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(sent.auth).toBeDefined();
    expect(sent.policy_wallet).toBe(WALLET);
    expect(r.structuredContent).toEqual({ ...enforced, mode: "enforced", declared_identity_status: "unverified" });
    const t = text(r);
    expect(t).toMatch(/Mode: enforced/);
    expect(t).toMatch(/Declared Identity: unverified/);
    expect(t).not.toContain("Acme Test Supplies");
    expect(t).not.toContain(ADVISORY_NOTE);
    expect(t).toMatch(/payable now: 20 USDC/);
  });

  test("unsigned: no auth in the request; mode advisory with the note", async () => {
    const h = await harness([json(200, advisory)], { signed: false });
    const r = await h.call("check", { counterparty: PAYEE, amount: "1" });
    const sent = JSON.parse(h.calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(sent).not.toHaveProperty("auth");
    expect(r.structuredContent).toMatchObject({ mode: "advisory", note: ADVISORY_NOTE, advisory: true, limit_write: "none" });
    expect(text(r)).toContain(ADVISORY_NOTE);
  });

  test("signed but the api answers advisory (e.g. unbound wallet): mode advisory with the note", async () => {
    const h = await harness([json(200, advisory)], { signed: true });
    const r = await h.call("check", { counterparty: PAYEE, amount: "1" });
    expect((JSON.parse(h.calls[0]?.body ?? "{}") as Record<string, unknown>).auth).toBeDefined();
    expect(r.structuredContent).toMatchObject({ mode: "advisory", note: ADVISORY_NOTE });
  });

  test("unsigned client whose api answers advisory:false: still mode advisory with the note", async () => {
    const h = await harness([json(200, enforced)], { signed: false });
    const r = await h.call("check", { counterparty: PAYEE, amount: "1" });
    expect(r.structuredContent).toMatchObject({ mode: "advisory", note: ADVISORY_NOTE, advisory: false });
    expect(text(r)).toContain(ADVISORY_NOTE);
    expect(text(r)).not.toMatch(/Mode: enforced/);
  });

  test("signed, enforced, but the Limit write failed: mode enforced plus the failed-write note", async () => {
    const h = await harness([json(200, { ...enforced, limit_write: "failed" })], { signed: true });
    const r = await h.call("check", { counterparty: PAYEE, amount: "1" });
    expect(r.structuredContent).toMatchObject({ mode: "enforced", limit_write: "failed", note: LIMIT_WRITE_FAILED_NOTE });
    expect(text(r)).toContain(LIMIT_WRITE_FAILED_NOTE);
    expect(text(r)).not.toContain(ADVISORY_NOTE);
  });

  test("signed, enforced, pending write: no note", async () => {
    const h = await harness([json(200, enforced)], { signed: true });
    const r = await h.call("check", { counterparty: PAYEE, amount: "1" });
    expect(r.structuredContent).not.toHaveProperty("note");
  });

  test.each([
    ["negative amount", { counterparty: PAYEE, amount: "-1" }],
    ["fractional amount", { counterparty: PAYEE, amount: "1.5" }],
    ["zero amount", { counterparty: PAYEE, amount: "0" }],
    ["bad address", { counterparty: "0x12", amount: "1" }],
    ["empty declared identity", { counterparty: PAYEE, amount: "1", declared_identity: {} }],
  ])("bad input (%s): isError validation_failed, no api call", async (_name, args) => {
    const h = await harness([], { signed: true });
    const r = await h.call("check", args);
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ error: { code: "validation_failed" } });
    expect(text(r)).toMatch(/^validation_failed:/);
    expect(h.calls).toHaveLength(0);
  });

  test("api error (429 until the envelope expires): isError with code and message, never a key or signature", async () => {
    const h = await harness(Array.from({ length: 50 }, () => envelope("rate_limited", 429)), { signed: true });
    const r = await h.call("check", { counterparty: PAYEE, amount: "1" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ error: { code: "rate_limited", retryable: true } });
    expect(h.calls.length).toBeGreaterThan(1);
    const sig = (JSON.parse(h.calls[0]?.body ?? "{}") as { auth: { signature: string } }).auth.signature;
    const out = JSON.stringify(r);
    expect(out).not.toContain(sig.slice(2));
    expect(out).not.toContain(KEY.slice(2));
  });
});

describe("log tools", () => {
  test("record data goes only to structuredContent; the text is a summary with an untrusted-data line", async () => {
    const page = { records: [withIdentity, external].map((g) => ({ recordHash: g?.hash, record: g?.record })), nextCursor: 9 };
    const detail = { recordHash: withIdentity?.hash, record: withIdentity?.record, receipts: [] };
    const h = await harness([json(200, page), json(200, detail)], { signed: true, scope: SCOPE });
    const list = await h.call("list_decision_records", {});
    const one = await h.call("get_decision_record", { record_id: withIdentity?.record.id });
    for (const r of [list, one]) {
      expect(r.isError).toBeFalsy();
      const t = text(r);
      expect(t).toMatch(/untrusted, unverified data/);
      expect(t).not.toContain("Acme Data Labs");
      expect(t).not.toContain("acme.example");
      expect(t).not.toContain(withIdentity?.record.reason ?? "");
      expect(t).toContain(withIdentity?.record.id ?? "");
      expect(t).toMatch(/decision cap/);
    }
    expect(text(list)).toMatch(/nextCursor: 9/);
    expect(text(list)).toMatch(/external record/);
    expect(JSON.stringify(list.structuredContent)).toContain("Acme Data Labs");
  });

  test("signed: ReadAccess headers are sent and the detail is returned", async () => {
    const h = await harness([json(200, statusBody)], { signed: true, scope: SCOPE });
    const r = await h.call("get_counterparty_status", { counterparty: PAYEE });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual(statusBody);
    for (const k of AUTH_HEADERS) expect(h.calls[0]?.headers).toHaveProperty(k);
    expect(h.calls[0]?.url).toBe(`https://api.horos.test/v1/scopes/${encodeURIComponent(SCOPE)}/counterparties/${PAYEE}`);
  });

  test("signed list tools pass cursors and limits", async () => {
    const h = await harness([json(200, { records: [], nextCursor: null }), json(200, { counterparties: [statusBody], nextCursor: PAYEE })], {
      signed: true,
      scope: SCOPE,
    });
    const recs = await h.call("list_decision_records", { after: 4, limit: 2 });
    expect(recs.structuredContent).toEqual({ records: [], nextCursor: null });
    const cps = await h.call("list_counterparties", { limit: 100 });
    expect(cps.structuredContent).toEqual({ counterparties: [statusBody], nextCursor: PAYEE });
    expect(h.calls.map((c) => c.url)).toEqual([
      `https://api.horos.test/v1/scopes/${encodeURIComponent(SCOPE)}/records?after=4&limit=2`,
      `https://api.horos.test/v1/scopes/${encodeURIComponent(SCOPE)}/counterparties?limit=100`,
    ]);
  });

  test("unsigned, demo scope: no auth headers; data returned", async () => {
    const h = await harness([json(200, { records: [], nextCursor: null })], { signed: false, scope: DEMO_SCOPE });
    const r = await h.call("list_decision_records", {});
    expect(r.isError).toBeFalsy();
    for (const k of AUTH_HEADERS) expect(h.calls[0]?.headers).not.toHaveProperty(k);
  });

  test("unsigned, private scope: the api's 401 comes back as unauthenticated with a Payment-key hint", async () => {
    const h = await harness([envelope("unauthenticated", 401)], { signed: false });
    const r = await h.call("get_decision_record", { record_id: RECORD_ID, scope: SCOPE });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ error: { code: "unauthenticated" } });
    expect(text(r)).toMatch(/Payment key/);
  });

  test.each([
    ["list_decision_records", {}],
    ["get_decision_record", { record_id: RECORD_ID }],
    ["list_counterparties", {}],
    ["get_counterparty_status", { counterparty: PAYEE }],
  ])("%s with no scope configured or passed: validation_failed, no api call", async (name, args) => {
    const h = await harness([], { signed: true });
    const r = await h.call(name, args);
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ error: { code: "validation_failed" } });
    expect(h.calls).toHaveLength(0);
  });

  test("limit out of range: validation_failed, no api call", async () => {
    const h = await harness([], { signed: true, scope: SCOPE });
    const r = await h.call("list_counterparties", { limit: 101 });
    expect(r.structuredContent).toMatchObject({ error: { code: "validation_failed" } });
    expect(h.calls).toHaveLength(0);
  });
});
