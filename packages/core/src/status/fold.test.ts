import type { Decision, ExternalActor, ExternalEvent } from "@horos/schema";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { foldStatus, statusEntries, type StatusChain, type StatusEntry } from "./fold.js";

const CP = "0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359";
const HASH = `0x${"7".repeat(64)}`;
const LIVE: StatusChain = { pinned: false, chainState: "live" };

let seq = 0;
const d = (decision: Decision, advisory = false): StatusEntry => ({ kind: "record", seq: seq++, record: { seq, decision, advisory } });
const ext = (actor: ExternalActor, events: ExternalEvent[]): StatusEntry => ({
  kind: "record",
  seq: seq++,
  record: { recordType: "external", seq, actor, events },
});
const limitSet = (newLimit: string): ExternalEvent => ({
  logIndex: 0,
  name: "LimitSet",
  args: { counterparty: CP, oldLimit: "0", newLimit, humanEpoch: "1", recordHash: HASH },
});
const pinReleased: ExternalEvent = { logIndex: 0, name: "PinReleased", args: { counterparty: CP, recordHash: HASH } };
const registered: ExternalEvent = { logIndex: 0, name: "CounterpartyRegistered", args: { counterparty: CP, limit: "500", recordHash: HASH } };
const pinReceipt = (): StatusEntry => ({ kind: "receipt", seq: seq - 1, pin: true });
const status = (entries: StatusEntry[], chain: StatusChain = LIVE) => foldStatus(entries, chain).status;

describe("foldStatus", () => {
  test("empty → ok, lastSeq null", () => {
    expect(foldStatus([], LIVE)).toEqual({ status: "ok", lastSeq: null, pinned: false, chainState: "live" });
  });

  test.each<[string, () => StatusEntry[], string]>([
    ["hold is sticky", () => [d("hold"), d("allow"), d("allow")], "held"],
    ["block beats hold", () => [d("hold"), d("block"), d("hold")], "blocked"],
    ["cap never loosens", () => [d("block"), d("cap")], "blocked"],
    ["allow and cap stay ok", () => [d("allow"), d("cap")], "ok"],
    ["advisory hold is ignored", () => [d("allow"), d("hold", true)], "ok"],
    ["advisory allow after an enforced hold", () => [d("hold"), d("allow", true)], "held"],
    ["human raise", () => [d("hold"), ext("human", [limitSet("300")])], "ok"],
    ["human raise out of blocked", () => [d("block"), ext("human", [limitSet("1")])], "ok"],
    ["human set 0", () => [d("allow"), ext("human", [limitSet("0")])], "blocked"],
    ["human executeUnpin lands on held", () => [d("block"), ext("human", [pinReleased])], "held"],
    ["unrecognised registrar write", () => [d("allow"), ext("registrar", [registered])], "held"],
    ["unrecognised rules write never un-blocks", () => [d("block"), ext("rules", [registered])], "blocked"],
    ["unrecognised model write", () => [ext("model", [registered])], "held"],
    ["a confirmed pin receipt blocks", () => [d("block"), pinReceipt()], "blocked"],
    ["a confirmed pin receipt blocks even after allow", () => [d("allow"), { kind: "receipt", seq: 0, pin: true }], "blocked"],
    ["a non-pin receipt changes nothing", () => [d("allow"), { kind: "receipt", seq: 0, pin: false }], "ok"],
  ])("%s", (_name, entries, expected) => {
    expect(status(entries())).toBe(expected);
  });

  test("chain pinned wins over any state", () => {
    expect(status([d("allow")], { pinned: true, chainState: "live" })).toBe("pinned");
    expect(status([d("hold"), ext("human", [limitSet("300")])], { pinned: true, limit: 0n, chainState: "live" })).toBe("pinned");
  });

  test("pin receipt with a stale mirror that is not pinned → blocked, stale", () => {
    const r = foldStatus([d("block"), pinReceipt()], { pinned: false, limit: 0n, chainState: "stale" });
    expect(r).toMatchObject({ status: "blocked", pinned: false, limit: 0n, chainState: "stale" });
  });

  test("lastSeq is the highest seq that fed the fold; advisory entries do not count", () => {
    const entries = [d("allow"), d("hold")];
    expect(foldStatus(entries, LIVE).lastSeq).toBe(entries[1]?.seq);
    const withAdvisory = [d("hold"), d("allow", true)];
    expect(foldStatus(withAdvisory, LIVE).lastSeq).toBe(withAdvisory[0]?.seq);
    expect(foldStatus([d("allow", true)], LIVE).lastSeq).toBeNull();
  });

  test("an unknown decision or actor fails closed (held, never loosening blocked)", () => {
    expect(status([d("allow"), d("frozen" as Decision)])).toBe("held");
    expect(status([d("block"), d("frozen" as Decision)])).toBe("blocked");
    expect(status([d("allow"), ext("mystery" as ExternalActor, [registered])])).toBe("held");
    expect(status([d("block"), ext("mystery" as ExternalActor, [registered])])).toBe("blocked");
    expect(status([d("hold"), ext("pending-human", [registered])])).toBe("held");
  });

  test("statusEntries orders by seq, a record before its receipts", () => {
    const rec = (s: number) => ({ seq: s, record: { seq: s, decision: "block" as const, advisory: false } });
    const out = statusEntries([rec(2), rec(0)], [{ seq: 0, pin: true }, { seq: 2, pin: false }]);
    expect(out.map((e) => [e.seq, e.kind])).toEqual([
      [0, "record"],
      [0, "receipt"],
      [2, "record"],
      [2, "receipt"],
    ]);
  });
});

describe("foldStatus properties", () => {
  const decisionArb = fc.constantFrom<Decision>("allow", "cap", "hold", "block");
  const anyDecisionEntry = fc.tuple(decisionArb, fc.boolean()).map(([dec, adv]) => d(dec, adv));
  const loosening = fc.oneof(
    fc.constantFrom<Decision>("allow", "cap", "hold", "block").map((dec) => d(dec, true)), // any advisory record
    fc.constantFrom<Decision>("allow", "cap").map((dec) => d(dec, false)),
  );

  // Every non-decision entry kind except a Human LimitSet > 0: receipts and ExternalRecords.
  const nonRaising = fc.oneof(
    fc.boolean().map((pin): StatusEntry => ({ kind: "receipt", seq: seq - 1, pin })),
    fc.constantFrom<ExternalActor>("registrar", "model", "rules").map((actor) => ext(actor, [registered])),
    fc.constant(null).map(() => ext("human", [pinReleased])),
    fc.constant(null).map(() => ext("human", [limitSet("0")])),
  );
  const humanRaise = fc.bigInt({ min: 1n, max: 10n ** 12n }).map((n) => ext("human", [limitSet(n.toString())]));

  test("nothing but a Human LimitSet > 0 moves held/blocked to ok", () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(anyDecisionEntry, nonRaising, humanRaise), { maxLength: 12 }),
        fc.array(fc.oneof(anyDecisionEntry, nonRaising, humanRaise), { maxLength: 40 }),
        (prefix, suffix) => {
          fc.pre(status(prefix) !== "ok");
          let s = status(prefix);
          for (let i = 0; i < suffix.length; i++) {
            const next = status([...prefix, ...suffix.slice(0, i + 1)]);
            const e = suffix[i];
            const isRaise = e?.kind === "record" && "recordType" in e.record && e.record.actor === "human" && e.record.events.some((x) => x.name === "LimitSet" && x.args["newLimit"] !== "0");
            if (s !== "ok" && next === "ok") expect(isRaise).toBe(true);
            s = next;
          }
        },
      ),
    );
  });

  test("appending advisory records or allow/cap decisions never moves held/blocked to ok", () => {
    fc.assert(
      fc.property(fc.array(anyDecisionEntry, { maxLength: 12 }), fc.array(loosening, { maxLength: 60 }), (prefix, suffix) => {
        const before = status(prefix);
        fc.pre(before === "held" || before === "blocked");
        const after = status([...prefix, ...suffix]);
        expect(after).toBe(before);
      }),
    );
  });

  test("advisory records never feed the fold", () => {
    fc.assert(
      fc.property(fc.array(anyDecisionEntry, { maxLength: 20 }), (entries) => {
        const enforcedOnly = entries.filter((e) => e.kind !== "record" || !("advisory" in e.record) || !e.record.advisory);
        expect(status(entries)).toBe(status(enforcedOnly));
      }),
    );
  });
});
