import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { shadowOutcome, ShadowClosedError, type ProvisionedKeys } from "@horos/core";
import { ShadowApiKey, type Hex } from "@horos/schema";
import { afterEach, describe, expect, test } from "vitest";
import { uuidv7 } from "../ids.js";
import { PostgresAccountStore } from "./account-store.js";
import type { HorosTx } from "./record-store.js";
import type { WindowPolicy } from "../shadow/rolling-window.js";
import { newShadowApiKey, PostgresShadowStore, SHADOW_WINDOW_POLICY, shadowKeyHash, windowPolicyForPreset, type ShadowLedgerEffect } from "./shadow-store.js";
import { freshDb, type TestClient } from "./test-db.js";

const clients: TestClient[] = [];
afterEach(async () => {
  while (clients.length) await clients.pop()?.close();
});

const PAY: Hex = "0x705f7d75b1689c42034ca5102700be481edca2da";
const WALLET: Hex = "0x7ed77bdd025d461e15d8e85dbf3ab0e9a286774c";
const A: Hex = "0x1111111111111111111111111111111111111111";
const B: Hex = "0x2222222222222222222222222222222222222222";
const T = new Date("2026-09-28T12:00:00.000Z");
const DAY = 86_400_000;
const at = (ms: number) => new Date(T.getTime() + ms);
const USDC = 1_000_000n;
const KEYS: ProvisionedKeys = {
  walletSetId: "ws-1",
  registrar: { walletId: "w-r", address: "0x7434fc9d31febe08082a710b255f3fe51b6a7ffc" },
  model: { walletId: "w-m", address: "0x081b31405e48ec71bedbc22adf10ebcdcabb69a7" },
  rules: { walletId: "w-u", address: "0x9542e0bbc0bcc0c88033233d7d70b0def37e2769" },
};

async function setup() {
  const r = await freshDb();
  clients.push(r.client);
  return { ...r, shadow: new PostgresShadowStore(r.db), accounts: new PostgresAccountStore(r.db) };
}

async function signedUp(shadow: PostgresShadowStore) {
  const r = await shadow.signup(PAY, T);
  if (r.kind !== "issued") throw new Error(`expected issued, got ${r.kind}`);
  return r;
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Run `apply` the way the record store does: inside one transaction, with a record naming the Scope and Counterparty. */
async function applyEffect(s: Setup, scope: string, a: Hex, effect: ShadowLedgerEffect, now: Date, policy?: WindowPolicy): Promise<void> {
  const writes = s.shadow.apply(scope, a, effect, now, policy);
  await s.db.transaction(async (tx: HorosTx) => {
    await writes(tx, { scope, counterparty: a } as never, `0x${"0".repeat(64)}`);
  });
}

describe("sign-up and keys", () => {
  test("a new address gets a Customer, its shadow Scope and an hsk_ key stored only as its sha256", async () => {
    const s = await setup();
    const r = await signedUp(s.shadow);
    expect(r.scope).toBe(`shadow:${r.customerId}`);
    expect(ShadowApiKey.safeParse(r.apiKey).success).toBe(true);
    const rows = await s.client.query<{ key_hash: string; scope: string; revoked_at: Date | null }>(`SELECT key_hash, scope, revoked_at FROM shadow_api_key`);
    expect(rows.rows).toEqual([{ key_hash: shadowKeyHash(r.apiKey), scope: r.scope, revoked_at: null }]);
    expect(JSON.stringify(rows.rows)).not.toContain(r.apiKey);
    const scope = await s.client.query(`SELECT kind, customer_id FROM scope WHERE id = $1`, [r.scope]);
    expect(scope.rows).toEqual([{ kind: "shadow", customer_id: r.customerId }]);
    expect(await s.shadow.resolveKey(r.apiKey)).toEqual({ customerId: r.customerId, scope: r.scope });
  });

  test("a repeat sign-up issues a new key and revokes the old one; the Customer and Scope are reused", async () => {
    const s = await setup();
    const first = await signedUp(s.shadow);
    const second = await signedUp(s.shadow);
    expect(second.customerId).toBe(first.customerId);
    expect(second.apiKey).not.toBe(first.apiKey);
    expect(await s.shadow.resolveKey(first.apiKey)).toBeUndefined();
    expect(await s.shadow.resolveKey(second.apiKey)).toEqual({ customerId: first.customerId, scope: first.scope });
    const n = await s.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM customer`);
    expect(n.rows[0]?.n).toBe(1);
  });

  test("concurrent sign-ups of one address leave exactly one active key", async () => {
    const s = await setup();
    await signedUp(s.shadow);
    const all = await Promise.all([s.shadow.signup(PAY, T), s.shadow.signup(PAY, T), s.shadow.signup(PAY, T)]);
    expect(all.every((r) => r.kind === "issued")).toBe(true);
    const active = await s.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM shadow_api_key WHERE revoked_at IS NULL`);
    expect(active.rows[0]?.n).toBe(1);
  });

  test("a signed request's nonce is consumed: a replay issues nothing", async () => {
    const s = await setup();
    const nonce: Hex = `0x${"7".repeat(64)}`;
    expect((await s.shadow.signup(PAY, T, nonce)).kind).toBe("issued");
    expect(await s.shadow.signup(PAY, T, nonce)).toEqual({ kind: "replayed" });
    const keys = await s.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM shadow_api_key`);
    expect(keys.rows[0]?.n).toBe(1);
  });

  test("malformed, unknown and revoked keys resolve to nothing", async () => {
    const s = await setup();
    await signedUp(s.shadow);
    expect(await s.shadow.resolveKey("")).toBeUndefined();
    expect(await s.shadow.resolveKey("hsk_short")).toBeUndefined();
    expect(await s.shadow.resolveKey(newShadowApiKey())).toBeUndefined();
  });

  test("once the enforced binding is bound, sign-up is closed and issues nothing; the old key stays but isClosed is true", async () => {
    const s = await setup();
    const r = await signedUp(s.shadow);
    expect(await s.shadow.isClosed(r.customerId)).toBe(false);
    // The shadow Customer onboards later (its binding is created then) and binds a PolicyWallet.
    const { binding, created } = await s.accounts.onboard({ paymentAddress: PAY, webhookUrl: "", now: T });
    expect(created).toBe(true);
    expect(binding.customerId).toBe(r.customerId);
    expect(await s.shadow.isClosed(r.customerId)).toBe(false);
    await s.accounts.setKeys(r.customerId, KEYS, T);
    await s.accounts.bind(r.customerId, WALLET, T);
    expect(await s.shadow.isClosed(r.customerId)).toBe(true);
    expect(await s.shadow.signup(PAY, T)).toEqual({ kind: "closed", customerId: r.customerId });
    const keys = await s.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM shadow_api_key`);
    expect(keys.rows[0]?.n).toBe(1);
  });

  test("onboarding first, then shadow sign-up, reuses the Customer", async () => {
    const s = await setup();
    const { binding } = await s.accounts.onboard({ paymentAddress: PAY, webhookUrl: "", now: T });
    const r = await signedUp(s.shadow);
    expect(r.customerId).toBe(binding.customerId);
  });
});

describe("virtual ledger", () => {
  test("first contact: register at the target, one new payee, then spend in the Counterparty and wallet rings", async () => {
    const s = await setup();
    const { scope } = await signedUp(s.shadow);
    const before = await s.shadow.remaining(scope, A, T);
    expect(before).toEqual({
      cpRemaining: 0n,
      walletRemaining: 5_000n * USDC,
      newPayeeRemaining: 10n,
      limit: 0n,
      pinned: false,
      registered: false,
      humanSet: false,
      humanEpoch: 0n,
    });
    expect(await s.shadow.hasHistory(scope, A)).toBe(false);
    await applyEffect(s, scope, A, { intent: { kind: "register", target: 100n * USDC }, spend: 50n * USDC }, T);
    expect(await s.shadow.remaining(scope, A, T)).toMatchObject({
      cpRemaining: 50n * USDC,
      walletRemaining: 4_950n * USDC,
      newPayeeRemaining: 9n,
      limit: 100n * USDC,
      registered: true,
    });
    expect(await s.shadow.hasHistory(scope, A)).toBe(true);
    // Another Counterparty sees the shared wallet and new-payee rings.
    expect(await s.shadow.remaining(scope, B, T)).toMatchObject({ cpRemaining: 0n, walletRemaining: 4_950n * USDC, newPayeeRemaining: 9n });
    // Spend accumulates in today's bucket, and leaves the window after 31 days.
    await applyEffect(s, scope, A, { spend: 30n * USDC }, at(1000));
    expect(await s.shadow.remaining(scope, A, T)).toMatchObject({ cpRemaining: 20n * USDC, walletRemaining: 4_920n * USDC });
    expect(await s.shadow.remaining(scope, A, at(31 * DAY))).toMatchObject({ cpRemaining: 100n * USDC, walletRemaining: 5_000n * USDC, newPayeeRemaining: 10n });
  });

  test("a registration at 0 counts no new payee; a second register is ignored (already registered)", async () => {
    const s = await setup();
    const { scope } = await signedUp(s.shadow);
    await applyEffect(s, scope, A, { intent: { kind: "register", target: 0n }, spend: 0n }, T);
    expect(await s.shadow.remaining(scope, A, T)).toMatchObject({ registered: true, limit: 0n, newPayeeRemaining: 10n });
    await applyEffect(s, scope, A, { intent: { kind: "register", target: 100n * USDC }, spend: 0n }, T);
    expect(await s.shadow.remaining(scope, A, T)).toMatchObject({ registered: true, limit: 0n, newPayeeRemaining: 10n });
  });

  test("registrations the contract would refuse are skipped: above the ceiling, or with the New-Payee Cap used up", async () => {
    const s = await setup();
    const { scope } = await signedUp(s.shadow);
    await applyEffect(s, scope, A, { intent: { kind: "register", target: SHADOW_WINDOW_POLICY.firstContactCeiling + 1n }, spend: 0n }, T);
    expect(await s.shadow.remaining(scope, A, T)).toMatchObject({ registered: false });
    for (let i = 0; i < 10; i++) {
      const a = `0x${(i + 16).toString(16).padStart(40, "0")}` as Hex;
      await applyEffect(s, scope, a, { intent: { kind: "register", target: USDC }, spend: 0n }, T);
    }
    expect(await s.shadow.remaining(scope, A, T)).toMatchObject({ newPayeeRemaining: 0n });
    await applyEffect(s, scope, A, { intent: { kind: "register", target: USDC }, spend: 0n }, T);
    expect(await s.shadow.remaining(scope, A, T)).toMatchObject({ registered: false });
  });

  test("tighten only lowers; pin sets 0, pins, and registers an unknown Counterparty without a new payee", async () => {
    const s = await setup();
    const { scope } = await signedUp(s.shadow);
    await applyEffect(s, scope, A, { intent: { kind: "register", target: 400n * USDC }, spend: 0n }, T);
    await applyEffect(s, scope, A, { intent: { kind: "tighten", target: 250n * USDC, humanEpoch: 0n }, spend: 0n }, T);
    expect(await s.shadow.remaining(scope, A, T)).toMatchObject({ limit: 250n * USDC });
    await applyEffect(s, scope, A, { intent: { kind: "tighten", target: 300n * USDC, humanEpoch: 0n }, spend: 0n }, T);
    expect(await s.shadow.remaining(scope, A, T)).toMatchObject({ limit: 250n * USDC });
    await applyEffect(s, scope, A, { intent: { kind: "pin", target: 0n }, spend: 0n }, T);
    expect(await s.shadow.remaining(scope, A, T)).toMatchObject({ limit: 0n, pinned: true, cpRemaining: 0n });
    await applyEffect(s, scope, B, { intent: { kind: "pin", target: 0n }, spend: 0n }, T);
    expect(await s.shadow.remaining(scope, B, T)).toMatchObject({ registered: true, pinned: true, limit: 0n, newPayeeRemaining: 9n });
  });

  test("spend is recorded only for a registered, unpinned Counterparty", async () => {
    const s = await setup();
    const { scope } = await signedUp(s.shadow);
    // Unregistered (no intent): nothing.
    await applyEffect(s, scope, A, { spend: 10n * USDC }, T);
    // Registration refused (above the ceiling): no spend either.
    await applyEffect(s, scope, B, { intent: { kind: "register", target: SHADOW_WINDOW_POLICY.firstContactCeiling + 1n }, spend: 10n * USDC }, T);
    expect(await s.shadow.remaining(scope, B, T)).toMatchObject({ registered: false, walletRemaining: 5_000n * USDC });
    // Pinned in the same effect: no spend.
    await applyEffect(s, scope, A, { intent: { kind: "register", target: 100n * USDC }, spend: 0n }, T);
    await applyEffect(s, scope, A, { intent: { kind: "pin", target: 0n }, spend: 10n * USDC }, T);
    expect(await s.shadow.remaining(scope, A, T)).toMatchObject({ pinned: true, walletRemaining: 5_000n * USDC });
  });

  test("spend is clamped to what is left: two 60 USDC spends against 90 remaining record 90 in total", async () => {
    const s = await setup();
    const { scope } = await signedUp(s.shadow);
    await applyEffect(s, scope, A, { intent: { kind: "register", target: 100n * USDC }, spend: 10n * USDC }, T);
    // Both decided against the same pre-lock view (90 left); the second is clamped under the lock.
    await applyEffect(s, scope, A, { spend: 60n * USDC }, T);
    await applyEffect(s, scope, A, { spend: 60n * USDC }, T);
    expect(await s.shadow.remaining(scope, A, T)).toMatchObject({ cpRemaining: 0n, walletRemaining: 4_900n * USDC });
  });

  test("the wallet cap clamps spend across Counterparties", async () => {
    const s = await setup();
    const { scope } = await signedUp(s.shadow);
    const tight: WindowPolicy = { ...SHADOW_WINDOW_POLICY, walletPeriodCap: 120n * USDC };
    await applyEffect(s, scope, A, { intent: { kind: "register", target: 100n * USDC }, spend: 100n * USDC }, T, tight);
    await applyEffect(s, scope, B, { intent: { kind: "register", target: 100n * USDC }, spend: 100n * USDC }, T, tight);
    expect(await s.shadow.remaining(scope, B, T, tight)).toMatchObject({ cpRemaining: 80n * USDC, walletRemaining: 0n });
  });

  test("a tightened window policy is used by remaining and apply (ceiling, new-payee cap, period)", async () => {
    const s = await setup();
    const { scope } = await signedUp(s.shadow);
    const tight: WindowPolicy = { firstContactCeiling: 50n * USDC, walletPeriodCap: 1_000n * USDC, newPayeeCap: 1n, policyPeriodDays: 1n };
    // Above the tightened ceiling: refused.
    await applyEffect(s, scope, A, { intent: { kind: "register", target: 60n * USDC }, spend: 0n }, T, tight);
    expect(await s.shadow.remaining(scope, A, T, tight)).toMatchObject({ registered: false, newPayeeRemaining: 1n, walletRemaining: 1_000n * USDC });
    await applyEffect(s, scope, A, { intent: { kind: "register", target: 50n * USDC }, spend: 20n * USDC }, T, tight);
    expect(await s.shadow.remaining(scope, B, T, tight)).toMatchObject({ newPayeeRemaining: 0n, walletRemaining: 980n * USDC });
    // The one-day period: two days later the spend and the new payee have left the window.
    expect(await s.shadow.remaining(scope, A, at(2 * DAY), tight)).toMatchObject({ cpRemaining: 50n * USDC, newPayeeRemaining: 1n });
    // The default policy still sees the 30-day window.
    expect(await s.shadow.remaining(scope, A, at(2 * DAY))).toMatchObject({ newPayeeRemaining: 9n });
  });

  test("windowPolicyForPreset: the Standard Preset's on-chain values, also as the fallback for an unknown Preset", () => {
    expect(windowPolicyForPreset("standard@1")).toEqual(SHADOW_WINDOW_POLICY);
    expect(windowPolicyForPreset("unknown@9")).toEqual(SHADOW_WINDOW_POLICY);
  });

  test("apply throws ShadowClosedError once the binding is bound, and writes nothing", async () => {
    const s = await setup();
    const r = await signedUp(s.shadow);
    await s.accounts.onboard({ paymentAddress: PAY, webhookUrl: "", now: T });
    await s.accounts.setKeys(r.customerId, KEYS, T);
    await s.accounts.bind(r.customerId, WALLET, T);
    await expect(applyEffect(s, r.scope, A, { intent: { kind: "register", target: USDC }, spend: USDC }, T)).rejects.toBeInstanceOf(ShadowClosedError);
    expect(await s.shadow.remaining(r.scope, A, T)).toMatchObject({ registered: false, walletRemaining: 5_000n * USDC });
  });

  test("a failed transaction leaves no ledger change (the effect rides the record append)", async () => {
    const s = await setup();
    const { scope } = await signedUp(s.shadow);
    const writes = s.shadow.apply(scope, A, { intent: { kind: "register", target: 100n * USDC }, spend: 50n * USDC }, T);
    await expect(
      s.db.transaction(async (tx: HorosTx) => {
        await writes(tx, { scope, counterparty: A } as never, `0x${"0".repeat(64)}`);
        throw new Error("record insert failed");
      }),
    ).rejects.toThrow(/record insert failed/);
    expect(await s.shadow.remaining(scope, A, T)).toMatchObject({ registered: false, walletRemaining: 5_000n * USDC });
  });

  test("an effect whose record names another Scope or Counterparty is refused", async () => {
    const s = await setup();
    const { scope } = await signedUp(s.shadow);
    const writes = s.shadow.apply(scope, A, { spend: 1n }, T);
    await expect(s.db.transaction(async (tx: HorosTx) => writes(tx, { scope, counterparty: B } as never, `0x${"0".repeat(64)}`))).rejects.toThrow(
      /does not match/,
    );
  });

  test("every ledger method refuses a non-shadow Scope", async () => {
    const s = await setup();
    const enforced = `enforced:${uuidv7(T.getTime())}`;
    await expect(s.shadow.remaining(enforced, A, T)).rejects.toThrow();
    await expect(s.shadow.hasHistory("advisory-public", A)).rejects.toThrow();
    expect(() => s.shadow.apply(enforced, A, { spend: 1n }, T)).toThrow();
    await expect(s.shadow.summary(enforced)).rejects.toThrow();
  });
});

describe("summary", () => {
  test("counts only advisory and would-have-caught (non-simulated hold/block)", async () => {
    const s = await setup();
    const { scope } = await signedUp(s.shadow);
    const rows: [string, boolean][] = [
      ["allow", false],
      ["cap", false],
      ["hold", false],
      ["block", false],
      ["block", true],
      ["hold", true],
    ];
    // A record without `simulated` counts as not simulated, in SQL and in `shadowOutcome` alike.
    const extra = [{ decision: "hold" }, { decision: "allow" }];
    let seq = 0;
    for (const [decision, simulated] of rows) {
      const id = uuidv7(T.getTime() + seq);
      const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
      await s.client.query(
        `INSERT INTO decision_record (id, scope, seq, prev_hash, record_hash, record, created_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())`,
        [id, scope, seq, hash(seq), hash(seq + 100), JSON.stringify({ decision, simulated })],
      );
      seq++;
    }
    for (const body of extra) {
      const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
      await s.client.query(
        `INSERT INTO decision_record (id, scope, seq, prev_hash, record_hash, record, created_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())`,
        [uuidv7(T.getTime() + seq), scope, seq, hash(seq), hash(seq + 100), JSON.stringify(body)],
      );
      seq++;
    }
    const summary = await s.shadow.summary(scope);
    expect(summary).toEqual({ advisory: 5, would_have_caught: 3 });
    // The SQL count equals `shadowOutcome` over the stored records.
    const stored = await s.client.query<{ record: { decision: "allow" | "cap" | "hold" | "block"; simulated?: boolean } }>(
      `SELECT record FROM decision_record WHERE scope = $1`,
      [scope],
    );
    const labels = stored.rows.map((r) => shadowOutcome({ scope, decision: r.record.decision, simulated: r.record.simulated ?? false }));
    expect({ advisory: labels.filter((l) => l === "advisory").length, would_have_caught: labels.filter((l) => l === "would-have-caught").length }).toEqual(summary);
  });

  test("an empty Scope counts zero", async () => {
    const s = await setup();
    const { scope } = await signedUp(s.shadow);
    expect(await s.shadow.summary(scope)).toEqual({ advisory: 0, would_have_caught: 0 });
  });
});

test("isolation: only the shadow store references the virtual-ledger and API-key tables", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return files(p);
      return /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [p] : [];
    });
  const users = files(root)
    .filter((f) => /shadowLedger|shadow_ledger|shadowApiKey|shadow_api_key/.test(readFileSync(f, "utf8")))
    .map((f) => f.slice(root.length).replaceAll("\\", "/"))
    .sort();
  expect(users).toEqual(["postgres/schema.ts", "postgres/shadow-store.ts"]);
});

describe("remaining-composition.json walletCases through the store", () => {
  interface JsonRemaining {
    readonly counterparty: string;
    readonly [k: string]: unknown;
  }
  interface WalletCase {
    readonly name: string;
    readonly timestamp: number;
    readonly policy: Record<keyof WindowPolicy, string>;
    readonly counterparties: readonly Hex[];
    readonly initial: readonly JsonRemaining[];
    readonly steps: readonly { readonly op: string; readonly counterparty: Hex | null; readonly value: string | null; readonly remaining: readonly JsonRemaining[] }[];
  }
  const file = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../contracts/test-vectors/remaining-composition.json", import.meta.url)), "utf8")) as {
    walletCases: WalletCase[];
  };
  // A shadow Scope has no Human: `setLimit` cannot be expressed. A case is replayed up to its first `setLimit`; the
  // steps from there on are skipped (listed below and asserted, so a new vector does not skip silently).
  const EXPECTED_SKIPS = ["ceiling_vs_human_set: steps 1..6 (from setLimit)"];

  const asJson = (a: Hex, v: Awaited<ReturnType<PostgresShadowStore["remaining"]>>) => ({
    counterparty: a,
    cpRemaining: v.cpRemaining.toString(),
    walletRemaining: v.walletRemaining.toString(),
    newPayeeRemaining: v.newPayeeRemaining.toString(),
    limit: v.limit.toString(),
    pinned: v.pinned,
    registered: v.registered,
    humanSet: v.humanSet,
    humanEpoch: v.humanEpoch.toString(),
  });

  test("register / pay (as spend) / tighten / pin / warp and the Policy setters reproduce every remaining(a)", async () => {
    const skipped: string[] = [];
    for (const c of file.walletCases) {
      const s = await setup();
      const { scope } = await signedUp(s.shadow);
      let now = new Date(c.timestamp * 1000);
      let policy: WindowPolicy = {
        firstContactCeiling: BigInt(c.policy.firstContactCeiling),
        walletPeriodCap: BigInt(c.policy.walletPeriodCap),
        newPayeeCap: BigInt(c.policy.newPayeeCap),
        policyPeriodDays: BigInt(c.policy.policyPeriodDays),
      };
      const snapshot = async () => Promise.all(c.counterparties.map(async (a) => asJson(a, await s.shadow.remaining(scope, a, now, policy))));
      expect(await snapshot(), `${c.name} initial`).toEqual(c.initial);
      for (const [i, step] of c.steps.entries()) {
        const a = step.counterparty;
        const v = step.value === null ? 0n : BigInt(step.value);
        if (step.op === "setLimit") {
          skipped.push(`${c.name}: steps ${i}..${c.steps.length - 1} (from setLimit)`);
          break;
        }
        if (step.op === "warp") now = new Date(Number(v) * 1000);
        else if (step.op === "setPolicyPeriod") policy = { ...policy, policyPeriodDays: v };
        else if (step.op === "setFirstContactCeiling") policy = { ...policy, firstContactCeiling: v };
        else if (step.op === "setWalletPeriodCap") policy = { ...policy, walletPeriodCap: v };
        else if (step.op === "setNewPayeeCap") policy = { ...policy, newPayeeCap: v };
        else {
          if (a === null) throw new Error(`${c.name} step ${i}: ${step.op} without a counterparty`);
          const effect: ShadowLedgerEffect =
            step.op === "register"
              ? { intent: { kind: "register", target: v }, spend: 0n }
              : step.op === "pay"
                ? { spend: v }
                : step.op === "tighten"
                  ? { intent: { kind: "tighten", target: v, humanEpoch: 0n }, spend: 0n }
                  : step.op === "pin"
                    ? { intent: { kind: "pin", target: 0n }, spend: 0n }
                    : (() => {
                        throw new Error(`unknown op ${step.op}`);
                      })();
          await applyEffect(s, scope, a, effect, now, policy);
        }
        expect(await snapshot(), `${c.name} step ${i} (${step.op})`).toEqual(step.remaining);
      }
    }
    expect(skipped).toEqual(EXPECTED_SKIPS);
  });
});
