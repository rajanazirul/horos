import { outboxIntent, usedNonce, decisionRecord, policyVersion } from "@horos/adapters";
import { ADVISORY_PUBLIC_CUSTOMER_ID, DecisionRecord, type Hex } from "@horos/schema";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { chainInput } from "./check.js";
import { runCheck, type CheckOutcome } from "./index.js";
import {
  harness,
  loadTemplate,
  OTHER_WALLET,
  PAYEE,
  PAYEE_2,
  SDN_ADDR,
  signedRequest,
  stranger,
  u,
  unsignedRequest,
  USDC,
  WALLET,
  type Harness,
} from "./harness.test-helpers.js";

// Migrate once for the file, outside any single test's timeout.
beforeAll(async () => {
  await loadTemplate();
});

const open: Harness[] = [];
async function setup(opts: { limitWriteWaitMs?: number } = {}): Promise<Harness> {
  const h = await harness(opts);
  open.push(h);
  return h;
}
afterEach(async () => {
  while (open.length) await open.pop()?.client.close();
});

function decided(o: CheckOutcome) {
  if (o.kind !== "decided") throw new Error(`expected a decision, got ${o.kind}`);
  return o;
}

async function counts(h: Harness) {
  const [records, nonces, intents] = await Promise.all([
    h.db.select().from(decisionRecord),
    h.db.select().from(usedNonce),
    h.db.select().from(outboxIntent),
  ]);
  return { records: records.length, nonces: nonces.length, intents: intents.length };
}

async function storedRecord(h: Harness, id: string): Promise<DecisionRecord> {
  const rows = await h.db.select().from(decisionRecord).where(eq(decisionRecord.id, id));
  return DecisionRecord.parse(rows[0]?.record);
}

describe("signed Checks (enforced Scope)", () => {
  test("first contact: allow, record + used nonce + pending register intent in one Scope", async () => {
    const h = await setup();
    const req = await signedRequest();
    const o = decided(await runCheck(req, h.deps));
    expect(o.response).toMatchObject({ decision: "allow", advisory: false, simulated: false, chain_state: "live", limit_write: "pending", confidence: 1 });
    expect(o.response.questions).toEqual([]);
    expect(o.scope).toBe(h.scope);
    const rec = await storedRecord(h, o.response.record_id);
    expect(rec).toMatchObject({ scope: h.scope, customerId: h.customerId, policyWallet: req.policy_wallet, trigger: "check", advisory: false });
    const nonces = await h.db.select().from(usedNonce);
    expect(nonces).toEqual([{ scope: h.scope, nonce: req.auth?.nonce, recordId: rec.id }]);
    const intents = await h.outbox.list(h.scope, PAYEE);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ status: "pending", laneRole: "registrar", createdByRecord: rec.id });
    expect(intents[0]?.target).toBe(BigInt(o.response.effective_limit));
  });

  test("a failure in extraWrites leaves no record, no nonce and no intent", async () => {
    const h = await setup();
    const real = h.deps.outboxWrites;
    h.deps = {
      ...h.deps,
      outboxWrites: (e, ctx) => {
        const w = real(e, ctx);
        return async (tx, record, hash) => {
          await w(tx, record, hash);
          throw new Error("injected");
        };
      },
    };
    const req = await signedRequest();
    await expect(runCheck(req, h.deps)).rejects.toThrow("injected");
    expect(await counts(h)).toEqual({ records: 0, nonces: 0, intents: 0 });
  });

  test("a second first-contact Check coalesces into the pending intent", async () => {
    const h = await setup();
    const first = decided(await runCheck(await signedRequest({ amount: u(50) }), h.deps));
    expect(first.response.limit_write).toBe("pending");
    const second = decided(await runCheck(await signedRequest({ amount: u(80) }), h.deps));
    expect(second.response.limit_write).toBe("coalesced");
    const intents = await h.outbox.list(h.scope, PAYEE);
    expect(intents).toHaveLength(1);
    expect(intents[0]?.recordIds).toEqual([first.response.record_id, second.response.record_id]);
  });

  test("an intent confirmed within the wait budget returns confirmed + tx_hash", async () => {
    const h = await setup({ limitWriteWaitMs: 2000 });
    const TX: Hex = `0x${"c".repeat(64)}`;
    let polls = 0;
    h.onSleep = async (elapsed) => {
      polls++;
      if (elapsed >= 300) await h.db.update(outboxIntent).set({ status: "confirmed", txHash: TX }).where(eq(outboxIntent.scope, h.scope));
    };
    const o = decided(await runCheck(await signedRequest(), h.deps));
    expect(o.response.limit_write).toBe("confirmed");
    expect(o.response.tx_hash).toBe(TX);
    expect(polls).toBe(3);
  });

  test("the default budget is 0: pending at once, no sleep", async () => {
    const h = await setup();
    const deps = { ...h.deps };
    Reflect.deleteProperty(deps, "limitWriteWaitMs"); // the harness sets 0 explicitly; exercise the default
    h.deps = deps;
    let sleeps = 0;
    h.onSleep = async () => {
      sleeps++;
    };
    const o = decided(await runCheck(await signedRequest(), h.deps));
    expect(o.response.limit_write).toBe("pending");
    expect(o.response.tx_hash).toBeUndefined();
    expect(sleeps).toBe(0);
  });

  test("a non-finite budget means the default (no wait)", async () => {
    for (const budget of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const h = await setup({ limitWriteWaitMs: budget });
      let sleeps = 0;
      h.onSleep = async () => {
        sleeps++;
      };
      const o = decided(await runCheck(await signedRequest(), h.deps));
      expect(o.response.limit_write).toBe("pending");
      expect(sleeps).toBe(0);
    }
  });

  test("the wait is bounded by elapsed time, not poll count (slow intentState)", async () => {
    const h = await setup({ limitWriteWaitMs: 2000 });
    let reads = 0;
    const real = h.deps.intentState;
    h.deps = {
      ...h.deps,
      intentState: async (...args) => {
        reads++;
        h.clock.ms += 700; // each read takes 700 ms
        return real(...args);
      },
    };
    const start = h.clock.ms;
    const o = decided(await runCheck(await signedRequest({ nowMs: start }), h.deps));
    expect(o.response.limit_write).toBe("pending");
    // Reads at 0, 800 and 1600 ms; the third ends past the 2000 ms deadline.
    expect(reads).toBe(3);
    expect(h.clock.ms - start).toBeLessThan(2000 + 700 + 100);
  });

  test("an intent still pending when the budget ends stays pending (no tx_hash)", async () => {
    const h = await setup({ limitWriteWaitMs: 500 });
    let polls = 0;
    h.onSleep = async () => {
      polls++;
    };
    const o = decided(await runCheck(await signedRequest(), h.deps));
    expect(o.response.limit_write).toBe("pending");
    expect(o.response.tx_hash).toBeUndefined();
    expect(polls).toBe(5);
  });
});

describe("advisory-public", () => {
  async function expectAdvisory(h: Harness, o: CheckOutcome, reason: string) {
    const d = decided(o);
    expect(d.advisoryReason).toBe(reason);
    expect(d.scope).toBe("advisory-public");
    expect(d.response.advisory).toBe(true);
    expect(d.response.limit_write).toBe("none");
    expect(d.response).not.toHaveProperty("questions");
    const rec = await storedRecord(h, d.response.record_id);
    expect(rec.customerId).toBe(ADVISORY_PUBLIC_CUSTOMER_ID);
    expect(rec.policyWallet).toBeUndefined();
    expect(rec.advisory).toBe(true);
    const intents = await h.db.select().from(outboxIntent);
    expect(intents).toHaveLength(0);
    const nonces = await h.db.select().from(usedNonce).where(eq(usedNonce.scope, "advisory-public"));
    expect(nonces).toHaveLength(0);
    return d;
  }

  test("unsigned", async () => {
    const h = await setup();
    await expectAdvisory(h, await runCheck(unsignedRequest(), h.deps), "unsigned");
  });

  test("wrong signer", async () => {
    const h = await setup();
    await expectAdvisory(h, await runCheck(await signedRequest({ signer: stranger }), h.deps), "wrong-signer");
  });

  test("bad signature", async () => {
    const h = await setup();
    const req = await signedRequest();
    const auth = req.auth;
    if (auth === undefined) throw new Error("unreachable");
    const tampered = { ...req, auth: { ...auth, signature: `0x${"1".repeat(130)}` as Hex } };
    await expectAdvisory(h, await runCheck(tampered, h.deps), "bad-signature");
  });

  test("expired, and expiry more than 300 s away", async () => {
    const h = await setup();
    const now = h.clock.ms;
    await expectAdvisory(h, await runCheck(await signedRequest({ expiryMs: now - 1000 }), h.deps), "expired");
    await expectAdvisory(h, await runCheck(await signedRequest({ expiryMs: now }), h.deps), "expired");
    await expectAdvisory(h, await runCheck(await signedRequest({ expiryMs: now + 301_000 }), h.deps), "expired");
    const ok = decided(await runCheck(await signedRequest({ expiryMs: now + 300_000 }), h.deps));
    expect(ok.response.advisory).toBe(false);
  });

  test("unbound PolicyWallet", async () => {
    const h = await setup();
    await expectAdvisory(h, await runCheck(await signedRequest({ wallet: OTHER_WALLET }), h.deps), "unbound");
  });

  test("replayed nonce: the first is enforced, the second advisory-public", async () => {
    const h = await setup();
    const req = await signedRequest();
    const first = decided(await runCheck(req, h.deps));
    expect(first.response.advisory).toBe(false);
    const second = decided(await runCheck(req, h.deps));
    expect(second.advisoryReason).toBe("replayed");
    expect(second.response.advisory).toBe(true);
    expect(second.response.limit_write).toBe("none");
    expect(await counts(h)).toEqual({ records: 2, nonces: 1, intents: 1 });
  });

  test("a lost nonce race (NonceReplayError at append) re-runs as advisory-public", async () => {
    const h = await setup();
    h.deps = { ...h.deps, nonceUsed: async () => false };
    const req = await signedRequest();
    decided(await runCheck(req, h.deps));
    const second = decided(await runCheck(req, h.deps));
    expect(second.advisoryReason).toBe("nonce-race");
    expect(second.response.advisory).toBe(true);
    expect(await counts(h)).toEqual({ records: 2, nonces: 1, intents: 1 });
  });

  test("advisory chain reads are best-effort: both RPCs down → chain-unavailable hold", async () => {
    const h = await setup();
    h.chain.primaryDown = true;
    h.chain.secondaryDown = true;
    const d = await expectAdvisory(h, await runCheck(unsignedRequest(), h.deps), "unsigned");
    expect(d.response).toMatchObject({ decision: "hold", chain_state: "stale" });
    expect(d.evaluation.decisiveRule).toBe("chain-unavailable");
  });
});

describe("chain reads (AD-3)", () => {
  test("mirror fallback: payeeIsContract comes from a successful hasCode read, else is assumed true", async () => {
    const h = await setup();
    await h.indexer.applyMirror(h.scope, PAYEE, { kind: "registered", limit: 100n * USDC }, { block: 1n, logIndex: 0 }, new Date(h.clock.ms));
    const auth = { kind: "enforced", scope: h.scope as never, customerId: h.customerId, nonce: `0x${"1".repeat(64)}` as Hex, policyWallet: WALLET, rolesLive: true } as const;
    const down = { status: "rejected", reason: new Error("down") } as const;
    const policy = { status: "fulfilled", value: h.chain.livePolicy } as const;
    const withCode = (hasCode: PromiseSettledResult<boolean>) => chainInput(h.deps, auth, PAYEE, { remaining: down, policy, hasCode });
    expect(await withCode({ status: "fulfilled", value: true })).toMatchObject({ chainState: "stale", chain: { payeeIsContract: true } });
    expect(await withCode({ status: "fulfilled", value: false })).toMatchObject({ chainState: "stale", chain: { payeeIsContract: false } });
    expect(await withCode(down)).toMatchObject({ chainState: "stale", chain: { payeeIsContract: true } });
  });

  test("remaining down, hasCode up for a contract counterparty: stale, and the contract is known", async () => {
    const h = await setup();
    await h.indexer.applyMirror(h.scope, PAYEE, { kind: "registered", limit: 100n * USDC }, { block: 1n, logIndex: 0 }, new Date(h.clock.ms));
    h.chain.remainingDown = true;
    h.chain.contracts.add(PAYEE);
    const o = decided(await runCheck(await signedRequest(), h.deps));
    expect(o.response).toMatchObject({ chain_state: "stale", advisory: false });
    expect(o.evaluation.outboxIntent).toBeUndefined();
  });

  test("primary down: the secondary serves the reads, chain_state live", async () => {
    const h = await setup();
    h.chain.primaryDown = true;
    const o = decided(await runCheck(await signedRequest(), h.deps));
    expect(o.response).toMatchObject({ chain_state: "live", decision: "allow", advisory: false });
    expect(h.chain.secondaryCalls).toBeGreaterThan(0);
    expect(h.chain.primaryCalls).toBe(0);
  });

  test("both down with a registered mirror row: stale, conservative, no register/tighten intent", async () => {
    const h = await setup();
    await h.indexer.applyMirror(h.scope, PAYEE, { kind: "registered", limit: 100n * USDC }, { block: 1n, logIndex: 0 }, new Date(h.clock.ms));
    h.chain.primaryDown = true;
    h.chain.secondaryDown = true;
    const o = decided(await runCheck(await signedRequest(), h.deps));
    expect(o.response.chain_state).toBe("stale");
    expect(o.response.advisory).toBe(false);
    expect(o.response.remaining).toBe("0");
    expect(o.response.decision === "hold" || (o.response.decision === "cap" && o.response.payable_amount === "0")).toBe(true);
    expect(o.evaluation.outboxIntent).toBeUndefined();
    expect(await h.outbox.list(h.scope)).toHaveLength(0);
    const rec = await storedRecord(h, o.response.record_id);
    expect(rec.chainState).toBe("stale");
    expect(rec.limitBefore).toBe((100n * USDC).toString());
  });

  test("both down without a mirror row: first contact holds", async () => {
    const h = await setup();
    h.chain.primaryDown = true;
    h.chain.secondaryDown = true;
    const o = decided(await runCheck(await signedRequest(), h.deps));
    expect(o.response).toMatchObject({ decision: "hold", chain_state: "stale", advisory: false, limit_write: "none" });
  });

  test("both down, SDN match: block and a pin intent", async () => {
    const h = await setup();
    h.chain.primaryDown = true;
    h.chain.secondaryDown = true;
    const o = decided(await runCheck(await signedRequest({ counterparty: SDN_ADDR }), h.deps));
    expect(o.response).toMatchObject({ decision: "block", chain_state: "stale", limit_write: "pending" });
    const intents = await h.outbox.list(h.scope, SDN_ADDR);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ pin: true, target: 0n, laneRole: "rules" });
  });

  test("roles down on both RPCs, signer = stored Payment: enforced and stale", async () => {
    const h = await setup();
    h.chain.rolesDown = true;
    const o = decided(await runCheck(await signedRequest(), h.deps));
    expect(o.scope).toBe(h.scope);
    expect(o.response).toMatchObject({ advisory: false, chain_state: "stale" });
  });

  test("roles down, signer ≠ stored Payment: advisory-public", async () => {
    const h = await setup();
    h.chain.rolesDown = true;
    const o = decided(await runCheck(await signedRequest({ signer: stranger }), h.deps));
    expect(o.advisoryReason).toBe("wrong-signer");
  });
});

describe("policy and rate limiting", () => {
  test("a fresh Scope gets the Standard Preset once; records carry its id", async () => {
    const h = await setup();
    expect(await h.policies.active(h.scope as never)).toBeUndefined();
    const a = decided(await runCheck(await signedRequest(), h.deps));
    const b = decided(await runCheck(await signedRequest({ counterparty: PAYEE_2 }), h.deps));
    const rows = await h.db.select().from(policyVersion).where(eq(policyVersion.scope, h.scope));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ seq: 1, activation: "preset", presetVersion: "standard@1" });
    for (const o of [a, b]) {
      const rec = await storedRecord(h, o.response.record_id);
      expect(rec).toMatchObject({ policyVersionId: rows[0]?.id, presetVersion: "standard@1", questionSetVersion: "v1", skippedQuestions: [] });
    }
  });

  test("ensurePresetPolicy losing a race is harmless", async () => {
    const h = await setup();
    await Promise.all([h.deps.ensurePresetPolicy(h.scope), h.deps.ensurePresetPolicy(h.scope)]);
    const rows = await h.db.select().from(policyVersion).where(eq(policyVersion.scope, h.scope));
    expect(rows).toHaveLength(1);
  });

  test("admit=false: rate_limited, nothing written, nonce still usable", async () => {
    const h = await setup();
    const req = await signedRequest();
    let recoveries = 0;
    const recover = h.deps.recoverCheckSigner;
    h.deps = { ...h.deps, recoverCheckSigner: (...args) => (recoveries++, recover(...args)) };
    const limited = await runCheck(req, h.deps, { admit: () => false });
    expect(limited).toEqual({ kind: "rate_limited", principal: { kind: "customer", customerId: h.customerId } });
    expect(await counts(h)).toEqual({ records: 0, nonces: 0, intents: 0 });
    // Refused before any RPC call or signature recovery.
    expect(h.chain.calls).toBe(0);
    expect(recoveries).toBe(0);
    const limitedAdvisory = await runCheck(unsignedRequest(), h.deps, { admit: () => false });
    expect(limitedAdvisory).toEqual({ kind: "rate_limited", principal: { kind: "advisory" } });
    expect(h.chain.calls).toBe(0);
    const ok = decided(await runCheck(req, h.deps));
    expect(ok.response.advisory).toBe(false);
  });

  test("advisory Checks are admitted under the advisory principal", async () => {
    const h = await setup();
    const seen: string[] = [];
    decided(
      await runCheck(unsignedRequest(), h.deps, {
        admit: (p) => {
          seen.push(p.kind);
          return true;
        },
      }),
    );
    expect(seen).toEqual(["advisory"]);
  });

  test("identity bindings: enforced detects a known payee at a new address", async () => {
    const h = await setup();
    const identity = { name: "Acme Data, Inc." };
    decided(await runCheck(await signedRequest({ identity }), h.deps));
    const o = decided(await runCheck(await signedRequest({ counterparty: PAYEE_2, identity: { name: "ACME data LLC" } }), h.deps));
    expect(o.response.decision).toBe("hold");
    expect(o.evaluation.signals.find((x) => x.id === "known-payee-new-address")).toMatchObject({ value: true, tierContribution: "high" });
  });

  test("advisory-public: another caller's planted identity changes nothing (no bindings, no history)", async () => {
    const h = await setup();
    const identity = { name: "Acme Data, Inc." };
    const plain = decided(await runCheck({ ...unsignedRequest({ counterparty: PAYEE_2 }), declared_identity: identity }, h.deps));
    // Another anonymous caller binds the same identity to a different address, many times.
    for (let i = 0; i < 3; i++) decided(await runCheck({ ...unsignedRequest({ counterparty: PAYEE }), declared_identity: identity }, h.deps));
    const after = decided(await runCheck({ ...unsignedRequest({ counterparty: PAYEE_2 }), declared_identity: identity }, h.deps));
    expect(after.evaluation.signals).toEqual(plain.evaluation.signals);
    expect(after.response.decision).toBe(plain.response.decision);
    expect(after.evaluation.signals.find((x) => x.id === "known-payee-new-address")?.value).toBe(false);
  });

  test("logs carry no Declared Identity or signature", async () => {
    const h = await setup();
    const entries: Record<string, unknown>[] = [];
    h.deps = { ...h.deps, log: (e) => entries.push(e) };
    const req = await signedRequest({ identity: { name: "Secret Name Co" } });
    decided(await runCheck(req, h.deps));
    const text = JSON.stringify(entries);
    expect(entries.length).toBeGreaterThan(0);
    expect(text).not.toContain("Secret Name");
    expect(text).not.toContain(req.auth?.signature.slice(2, 40));
  });
});
