import type { ProvisionedKeys } from "@horos/core";
import type { Hex } from "@horos/schema";
import { afterEach, describe, expect, test } from "vitest";
import { BindingConflictError, PostgresAccountStore, PROVISION_KEYS_JOB } from "./account-store.js";
import { PostgresJobStore } from "./job-store.js";
import { freshDb, type TestClient } from "./test-db.js";

const clients: TestClient[] = [];
afterEach(async () => {
  while (clients.length) await clients.pop()?.close();
});

const PAY: Hex = "0x705f7d75b1689c42034ca5102700be481edca2da";
const WALLET: Hex = "0x7ed77bdd025d461e15d8e85dbf3ab0e9a286774c";
const OTHER_WALLET: Hex = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
const T = new Date("2026-09-28T12:00:00.000Z");
const at = (s: number) => new Date(T.getTime() + s * 1000);
const KEYS: ProvisionedKeys = {
  walletSetId: "ws-1",
  registrar: { walletId: "w-r", address: "0x7434fc9d31febe08082a710b255f3fe51b6a7ffc" },
  model: { walletId: "w-m", address: "0x081b31405e48ec71bedbc22adf10ebcdcabb69a7" },
  rules: { walletId: "w-u", address: "0x9542e0bbc0bcc0c88033233d7d70b0def37e2769" },
};

async function setup() {
  const r = await freshDb();
  clients.push(r.client);
  return { ...r, accounts: new PostgresAccountStore(r.db), jobs: new PostgresJobStore(r.db) };
}

describe("PostgresAccountStore", () => {
  test("onboard creates customer, webhook, pending binding and the provision job; a repeat creates nothing", async () => {
    const { accounts, jobs, client } = await setup();
    const first = await accounts.onboard({ paymentAddress: PAY, webhookUrl: "https://hooks.example.com/h", now: T });
    expect(first.created).toBe(true);
    expect(first.binding).toMatchObject({ paymentAddress: PAY, status: "pending", policyWallet: null, keys: null });
    expect(first.binding.scopeId).toMatch(/^enforced:[0-9a-f-]{36}$/);
    expect(await jobs.get(PROVISION_KEYS_JOB, first.binding.customerId)).toMatchObject({ status: "pending" });
    const again = await accounts.onboard({ paymentAddress: PAY, webhookUrl: "https://other.example.com/", now: at(1) });
    expect(again.created).toBe(false);
    expect(again.binding).toEqual(first.binding);
    expect(await accounts.counts()).toEqual({ customers: 1, webhooks: 1, bindings: 1 });
    expect(await accounts.webhookUrl(first.binding.customerId)).toBe("https://hooks.example.com/h");
    const cat = await client.query<{ category: string }>(`SELECT category FROM customer`);
    expect(cat.rows).toEqual([{ category: "own-test" }]);
    // No scope row exists until bind.
    expect((await client.query(`SELECT 1 FROM scope`)).rows).toHaveLength(0);
  });

  test("concurrent onboards of one address create one customer", async () => {
    const { accounts } = await setup();
    const rs = await Promise.all([1, 2, 3].map((i) => accounts.onboard({ paymentAddress: PAY, webhookUrl: "", now: at(i) })));
    expect(new Set(rs.map((r) => r.binding.customerId)).size).toBe(1);
    expect(rs.filter((r) => r.created)).toHaveLength(1);
    expect(await accounts.counts()).toEqual({ customers: 1, webhooks: 1, bindings: 1 });
  });

  test("setKeys is idempotent for equal keys and rejects different ones", async () => {
    const { accounts } = await setup();
    const { binding } = await accounts.onboard({ paymentAddress: PAY, webhookUrl: "", now: T });
    await accounts.setKeys(binding.customerId, KEYS, at(1));
    await accounts.setKeys(binding.customerId, KEYS, at(2));
    expect((await accounts.bindingByPayment(PAY))?.keys).toEqual(KEYS);
    await expect(accounts.setKeys(binding.customerId, { ...KEYS, walletSetId: "ws-2" }, at(3))).rejects.toThrow(BindingConflictError);
  });

  test("bind creates the enforced scope row and is idempotent for the same wallet", async () => {
    const { accounts, client } = await setup();
    const { binding } = await accounts.onboard({ paymentAddress: PAY, webhookUrl: "", now: T });
    await accounts.setKeys(binding.customerId, KEYS, at(1));
    const bound = await accounts.bind(binding.customerId, WALLET, at(2));
    expect(bound).toMatchObject({ status: "bound", policyWallet: WALLET, scopeId: binding.scopeId });
    expect(await accounts.bind(binding.customerId, WALLET, at(3))).toEqual(bound);
    await expect(accounts.bind(binding.customerId, OTHER_WALLET, at(4))).rejects.toThrow(BindingConflictError);
    const scopes = await client.query(`SELECT id, kind, customer_id, policy_wallet FROM scope`);
    expect(scopes.rows).toEqual([{ id: binding.scopeId, kind: "enforced", customer_id: binding.customerId, policy_wallet: WALLET }]);
    expect(await accounts.bindingByWallet(WALLET)).toEqual(bound);
    expect(await accounts.bindingByScope(binding.scopeId)).toEqual(bound);
  });

  test("binding a wallet another customer holds is a BindingConflictError and leaves no scope row", async () => {
    const { accounts, client } = await setup();
    const a = (await accounts.onboard({ paymentAddress: PAY, webhookUrl: "", now: T })).binding;
    const b = (await accounts.onboard({ paymentAddress: OTHER_WALLET, webhookUrl: "", now: T })).binding;
    await accounts.bind(a.customerId, WALLET, at(1));
    await expect(accounts.bind(b.customerId, WALLET, at(2))).rejects.toThrow(BindingConflictError);
    const scopes = await client.query<{ id: string }>(`SELECT id FROM scope`);
    expect(scopes.rows.map((r) => r.id)).toEqual([a.scopeId]);
    expect((await accounts.bindingByCustomer(b.customerId))?.status).toBe("pending");
  });

  test("a repeat onboard while keys are missing resets an exhausted provision-keys job", async () => {
    const { accounts, jobs } = await setup();
    const { binding } = await accounts.onboard({ paymentAddress: PAY, webhookUrl: "", now: T });
    for (let i = 0; i < 3; i++) {
      const c = await jobs.claimJob(PROVISION_KEYS_JOB, { now: at(i), maxAttempts: 3 });
      expect(c).toBeDefined();
      await jobs.failJob(PROVISION_KEYS_JOB, binding.customerId, at(i), "circle 500");
    }
    expect(await jobs.claimJob(PROVISION_KEYS_JOB, { now: at(5), maxAttempts: 3 })).toBeUndefined();
    await accounts.onboard({ paymentAddress: PAY, webhookUrl: "", now: at(6) });
    expect(await jobs.get(PROVISION_KEYS_JOB, binding.customerId)).toMatchObject({ status: "pending", attempts: 0 });
    // Once keys exist, a repeat onboard leaves jobs alone.
    await jobs.claimJob(PROVISION_KEYS_JOB, { now: at(7) });
    await jobs.failJob(PROVISION_KEYS_JOB, binding.customerId, at(7), "x");
    await accounts.setKeys(binding.customerId, KEYS, at(8));
    await accounts.onboard({ paymentAddress: PAY, webhookUrl: "", now: at(9) });
    expect((await jobs.get(PROVISION_KEYS_JOB, binding.customerId))?.status).toBe("failed");
  });

  test("updateWebhook consumes the nonce once; the latest row wins", async () => {
    const { accounts } = await setup();
    const { binding } = await accounts.onboard({ paymentAddress: PAY, webhookUrl: "", now: T });
    const n = `0x${"ab".repeat(32)}` as Hex;
    expect(await accounts.updateWebhook(binding.customerId, PAY, n, "https://new.example.com/x", at(1))).toBe(true);
    expect(await accounts.updateWebhook(binding.customerId, PAY, n, "https://evil.example.com/x", at(2))).toBe(false);
    expect(await accounts.webhookUrl(binding.customerId)).toBe("https://new.example.com/x");
    expect(await accounts.counts()).toMatchObject({ webhooks: 2 });
  });
});
