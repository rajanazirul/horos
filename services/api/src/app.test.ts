import { PGlite } from "@electric-sql/pglite";
import { PostgresPolicyVersionStore, runMigrations } from "@horos/adapters";
import { STANDARD_PRESET, toOffchainPolicy, type PolicyVersionStore } from "@horos/core";
import { ErrorEnvelope, PolicyVersion, type OffchainPolicy } from "@horos/schema";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { PACKAGE_NAME, uuidv7 } from "./index.js";

const TOKEN = "test-admin-token-not-a-secret";
const scope = "enforced:01926f3a-7b2c-7d4e-8f00-0123456789ab";
const standard = toOffchainPolicy(STANDARD_PRESET.offchain);

const clients: PGlite[] = [];
afterEach(async () => {
  while (clients.length) await clients.pop()?.close();
});

async function setup(wrap: (s: PolicyVersionStore) => PolicyVersionStore = (s) => s) {
  const client = new PGlite();
  clients.push(client);
  const db = drizzle(client);
  await runMigrations(db);
  const store = new PostgresPolicyVersionStore(db);
  let t = Date.parse("2026-09-26T10:00:00.000Z");
  const app = createApp({
    policyVersions: wrap(store),
    adminToken: TOKEN,
    now: () => new Date(t++),
    newId: () => uuidv7(),
  });
  const count = async () => (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM policy_version`)).rows[0]?.n;
  return { app, store, client, count };
}

function post(app: ReturnType<typeof createApp>, body: unknown, auth: string | null = `Bearer ${TOKEN}`) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth !== null) headers["authorization"] = auth;
  return app.request("/v1/policy-versions", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const req = (policy: OffchainPolicy = standard, presetVersion = "standard@1") => ({ scope, presetVersion, policy });
const tighterElevated = { ...standard, tierCeilings: { ...standard.tierCeilings, elevated: "50000000" } };

async function expectError(res: Response, status: number, code: string, retryable = false) {
  expect(res.status).toBe(status);
  const body = ErrorEnvelope.parse(await res.json());
  expect(body.error.code).toBe(code);
  expect(body.error.retryable).toBe(retryable);
  return body.error.message;
}

describe("POST /v1/policy-versions", () => {
  test("exports", () => {
    expect(PACKAGE_NAME).toBe("@horos/api");
    expect(() => createApp({ policyVersions: {} as PolicyVersionStore, adminToken: "", now: () => new Date(), newId: uuidv7 })).toThrow();
  });

  test("first version from the Preset: 201, seq 1, activation preset", async () => {
    const { app, store } = await setup();
    const res = await post(app, req());
    expect(res.status).toBe(201);
    const v = PolicyVersion.parse(await res.json());
    expect(v).toMatchObject({ scope, seq: 1, activation: "preset", presetVersion: "standard@1", policy: standard });
    expect(v.parentId).toBeUndefined();
    expect(v.createdAt).toBe("2026-09-26T10:00:00.000Z");
    expect(await store.active(scope)).toEqual(v);
  });

  test("tighter change: 201, seq 2, tighter-proof, parentId = previous id", async () => {
    const { app } = await setup();
    const first = PolicyVersion.parse(await (await post(app, req())).json());
    const res = await post(app, req(tighterElevated));
    expect(res.status).toBe(201);
    const v = PolicyVersion.parse(await res.json());
    expect(v).toMatchObject({ seq: 2, activation: "tighter-proof", parentId: first.id, policy: tighterElevated });
  });

  test("equal change: 201", async () => {
    const { app } = await setup();
    await post(app, req());
    const res = await post(app, req());
    expect(res.status).toBe(201);
    expect(PolicyVersion.parse(await res.json())).toMatchObject({ seq: 2, activation: "tighter-proof" });
  });

  test.each([
    ["low ceiling to 600", { ...standard, tierCeilings: { ...standard.tierCeilings, low: "600000000" } }, "tierCeilings.low"],
    ["threshold to 0.6", { ...standard, autoDecideThreshold: "0.6000" }, "autoDecideThreshold"],
  ])("looser change (%s): 422 naming the dimension, nothing inserted", async (_n, policy, dim) => {
    const { app, count } = await setup();
    await post(app, req());
    const message = await expectError(await post(app, req(policy)), 422, "validation_failed");
    expect(message).toContain(dim);
    expect(await count()).toBe(1);
  });

  test.each([
    ["judge", { ...standard, judge: "jev-1.14.0" }],
    ["questionSetVersion", { ...standard, questionSetVersion: "v2" }],
  ])("%s swap: 422, nothing inserted", async (dim, policy) => {
    const { app, count } = await setup();
    await post(app, req());
    expect(await expectError(await post(app, req(policy)), 422, "validation_failed")).toContain(dim);
    expect(await count()).toBe(1);
  });

  test("first version that is not a Preset: 422", async () => {
    const { app, count } = await setup();
    await expectError(await post(app, req(tighterElevated)), 422, "validation_failed");
    await expectError(await post(app, req(standard, "permissive@1")), 422, "validation_failed");
    expect(await count()).toBe(0);
  });

  test("smuggled human_signature: 400 unknown key", async () => {
    const { app, count } = await setup();
    const message = await expectError(await post(app, { ...req(), human_signature: `0x${"ab".repeat(65)}` }), 400, "validation_failed");
    expect(message).toContain("human_signature");
    expect(await count()).toBe(0);
  });

  test("malformed JSON and schema violations: 400", async () => {
    const { app } = await setup();
    await expectError(await post(app, "{not json"), 400, "validation_failed");
    await expectError(await post(app, { ...req(), policy: { ...standard, autoDecideThreshold: 0.7 } }), 400, "validation_failed");
  });

  test.each([
    ["missing", null],
    ["wrong", "Bearer nope"],
    ["wrong scheme", `Basic ${TOKEN}`],
    ["token prefix", `Bearer ${TOKEN.slice(0, -1)}`],
  ])("%s admin token: 401, nothing inserted", async (_n, auth) => {
    const { app, count } = await setup();
    await expectError(await post(app, req(), auth), 401, "unauthenticated");
    expect(await count()).toBe(0);
  });

  test("seq race: one 201, the other 409 retryable", async () => {
    // Both requests read the same active version before either inserts; the UNIQUE(scope, seq)
    // constraint in the real Postgres adapter then rejects the loser.
    let waiting: (() => void)[] = [];
    let gateOpen = true;
    const gated = (s: PolicyVersionStore): PolicyVersionStore => ({
      active: async (sc) => {
        const v = await s.active(sc);
        if (!gateOpen) {
          await new Promise<void>((resolve) => {
            waiting.push(resolve);
            if (waiting.length === 2) {
              for (const w of waiting) w();
              waiting = [];
            }
          });
        }
        return v;
      },
      insert: (row) => s.insert(row),
    });
    const { app, count } = await setup(gated);
    expect((await post(app, req())).status).toBe(201);
    gateOpen = false;
    const [a, b] = await Promise.all([post(app, req(tighterElevated)), post(app, req())]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    await expectError(loser, 409, "conflict", true);
    expect(await count()).toBe(2);
  });
});

describe("AD-17 envelope for unknown routes and uncaught errors", () => {
  test("unknown route → 404 not_found envelope", async () => {
    const { app } = await setup();
    expect(await expectError(await app.request("/v1/nope"), 404, "not_found")).toBe("no such route");
    expect(await expectError(await app.request("/v1/policy-versions"), 404, "not_found")).toBe("no such route");
  });

  test("a thrown handler → 500 internal envelope; the error text reaches only the log", async () => {
    const secret = "https://rpc.example.com/v2/sk_live_SUPERSECRET123";
    const logged: Record<string, unknown>[] = [];
    const app = createApp({
      policyVersions: { active: () => Promise.reject(new Error(`rpc failed: ${secret}`)), insert: () => Promise.resolve() },
      adminToken: TOKEN,
      now: () => new Date(),
      newId: () => uuidv7(),
      log: (e) => logged.push(e),
    });
    const res = await post(app, req());
    const text = await res.clone().text();
    expect(text).not.toContain("SUPERSECRET");
    expect(text).not.toContain("rpc.example.com");
    expect(await expectError(res, 500, "internal", true)).toBe("internal error");
    expect(logged).toEqual([expect.objectContaining({ event: "unhandled-error", method: "POST", path: "/v1/policy-versions" })]);
  });
});
