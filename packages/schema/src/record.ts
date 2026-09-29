// DecisionRecord v1, ExternalRecord v1 (the ScopeRecord union) and their canonical hash (AD-9, AD-10, FR-26). Record-internal fields are camelCase.
import { z } from "zod";
import { ChainState, Decision, DeclaredIdentity } from "./check.js";
import { jcs, keccakHex } from "./jcs.js";
import { Address, Bytes32, UUID_V7_PATTERN, UsdcAmount, UuidV7, WireTime, ZERO_BYTES32, type Hex } from "./primitives.js";

/** `enforced:<policyWalletId>` | `shadow:<customerId>` | `advisory-public` (AD-25). */
export const Scope = z
  .string()
  .regex(new RegExp(`^(?:(?:enforced|shadow):${UUID_V7_PATTERN}|advisory-public)$`), "invalid scope");
export type Scope = z.output<typeof Scope>;

export const Trigger = z.enum(["check", "watch-daily", "watch-list-update", "human", "on-demand"]);
export type Trigger = z.output<typeof Trigger>;

export const RiskTier = z.enum(["low", "elevated", "high", "severe"]);
export type RiskTier = z.output<typeof RiskTier>;

export const ListSource = z.enum(["ofac-sdn", "horos-demo-list"]);
export type ListSource = z.output<typeof ListSource>;

/** Decision Confidence in records: fixed 4-dp string in [0, 1] (hash-stable). */
export const RecordConfidence = z.string().regex(/^(0\.[0-9]{4}|1\.0000)$/, "expected 0.dddd or 1.0000");
export type RecordConfidence = z.output<typeof RecordConfidence>;

const SafeNonNegativeInt = z.int().nonnegative();

export const HardRuleResult = z.strictObject({
  rule: z.string().min(1),
  source: ListSource,
  snapshotId: z.string().min(1),
  snapshotHash: Bytes32,
  matched: z.boolean(),
  entityNames: z.array(z.string().min(1)).exactOptional(),
});
export type HardRuleResult = z.output<typeof HardRuleResult>;

export const SignalResult = z.strictObject({
  id: z.string().min(1),
  value: z.union([z.boolean(), z.string(), z.int()]),
  tierContribution: RiskTier,
});
export type SignalResult = z.output<typeof SignalResult>;

/**
 * DecisionRecord v1. Strict: unknown keys, `null` and non-integer numbers are rejected.
 * Optionals are omitted when absent; adding new optional fields later never changes existing hashes.
 */
export const DecisionRecord = z.strictObject({
  schemaVersion: z.literal(1),
  id: UuidV7,
  scope: Scope,
  seq: SafeNonNegativeInt,
  prevHash: Bytes32,
  createdAt: WireTime,
  trigger: Trigger,
  customerId: UuidV7,
  policyWallet: Address.exactOptional(),
  counterparty: Address,
  amount: UsdcAmount.exactOptional(),
  declaredIdentity: z
    .strictObject({
      status: z.literal("unverified"),
      value: DeclaredIdentity,
    })
    .exactOptional(),
  hardRules: z.array(HardRuleResult),
  signals: z.array(SignalResult),
  skippedQuestions: z.array(z.string().min(1)),
  riskTier: RiskTier,
  confidence: RecordConfidence,
  questionSetVersion: z.string().min(1),
  policyVersionId: UuidV7,
  presetVersion: z.string().min(1),
  decision: Decision,
  reason: z.string().min(1).max(600),
  limitBefore: UsdcAmount.exactOptional(),
  targetLimit: UsdcAmount.exactOptional(),
  chainState: ChainState,
  simulated: z.boolean(),
  advisory: z.boolean(),
}).superRefine((r, ctx) => {
  // Cross-field invariants (AD-9, AD-10, AD-25). They only reject; valid records hash unchanged.
  const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
  if ((r.seq === 0) !== (r.prevHash === ZERO_BYTES32)) {
    issue("prevHash", "seq 0 must have prevHash ZERO_BYTES32 and only seq 0 may");
  }
  const enforced = r.scope.startsWith("enforced:");
  if (enforced && r.policyWallet === undefined) issue("policyWallet", "an enforced scope requires policyWallet");
  if (!enforced && !r.advisory) issue("advisory", "a non-enforced scope must be advisory");
  // advisory-public has no wallet. A shadow scope may name the Customer's wallet (golden `shadow-allow`).
  if (r.scope === "advisory-public" && r.policyWallet !== undefined) {
    issue("policyWallet", "an advisory-public record carries no policyWallet");
  }
  if (r.scope.startsWith("shadow:") && r.customerId !== r.scope.slice("shadow:".length)) {
    issue("customerId", "a shadow scope's record must belong to that scope's Customer");
  }
  if (r.hardRules.some((h) => h.matched) && r.decision !== "block") {
    issue("decision", "a matched Hard Rule requires decision block");
  }
  if ((r.decision === "hold" || r.decision === "block") && r.targetLimit !== undefined && r.targetLimit !== "0") {
    issue("targetLimit", "hold or block requires targetLimit absent or 0");
  }
});
export type DecisionRecord = z.output<typeof DecisionRecord>;
export type DecisionRecordInput = z.input<typeof DecisionRecord>;

/** Every PolicyWallet event name (contracts/src/PolicyWallet.sol), the vocabulary of `ExternalRecord.events`. */
export const POLICY_WALLET_EVENT_NAMES = [
  "RoleGranted",
  "RoleRevoked",
  "OwnershipTransferStarted",
  "OwnershipTransferred",
  "Withdrawn",
  "PolicyChanged",
  "CounterpartyRegistered",
  "Paid",
  "LimitTightened",
  "CounterpartyPinned",
  "PinReleased",
  "LimitSet",
  "UnpinRequested",
] as const;
export const PolicyWalletEventName = z.enum(POLICY_WALLET_EVENT_NAMES);
export type PolicyWalletEventName = z.output<typeof PolicyWalletEventName>;

/** Events only the Human can cause: an ExternalRecord holding one must have actor `human`. */
export const HUMAN_ONLY_EVENTS: readonly PolicyWalletEventName[] = [
  "LimitSet",
  "RoleGranted",
  "RoleRevoked",
  "OwnershipTransferStarted",
  "Withdrawn",
  "PolicyChanged",
  "UnpinRequested",
];

/** Who sent an observed transaction: a PolicyWallet role holder, the Human, or the pending Human. */
export const ExternalActor = z.enum(["human", "pending-human", "registrar", "model", "rules"]);
export type ExternalActor = z.output<typeof ExternalActor>;

/**
 * An event argument in canonical string form: an unsigned decimal (uint / enum index) or lowercase `0x`
 * hex (address, bytes32). Case is never normalised here, so a non-canonical value is rejected, not hidden.
 */
const EventArgValue = z.string().regex(/^(?:0|[1-9][0-9]*|0x[0-9a-f]+)$/, "expected an unsigned decimal or lowercase 0x hex");

export const ExternalEvent = z.strictObject({
  logIndex: SafeNonNegativeInt,
  name: PolicyWalletEventName,
  args: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]*$/, "expected a camelCase key"), EventArgValue),
});
export type ExternalEvent = z.output<typeof ExternalEvent>;

/** The fixed reason of every ExternalRecord (no evaluation happened). */
export const EXTERNAL_RECORD_REASON = "Observed on-chain; Horos did not originate or evaluate this change.";

/**
 * ExternalRecord v1 (AD-9/AD-23/AD-24 amendment 2026-09-27): one per state-changing PolicyWallet transaction
 * that resolves to no consistent record in the same enforced Scope. No evaluation fields; nothing fabricated.
 */
export const ExternalRecord = z
  .strictObject({
    schemaVersion: z.literal(1),
    recordType: z.literal("external"),
    id: UuidV7,
    scope: Scope,
    seq: SafeNonNegativeInt,
    prevHash: Bytes32,
    createdAt: WireTime,
    customerId: UuidV7,
    policyWallet: Address,
    actor: ExternalActor,
    actorAddress: Address,
    txHash: Bytes32,
    blockNumber: SafeNonNegativeInt,
    blockTimestamp: WireTime,
    /** The first unmatched event's recordHash (zero bytes for `UnpinRequested`). */
    carriedHash: Bytes32,
    events: z.array(ExternalEvent).min(1),
    counterparty: Address.exactOptional(),
    reason: z.string().min(1).max(600),
    simulated: z.literal(false),
    advisory: z.literal(false),
  })
  .superRefine((r, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (!r.scope.startsWith("enforced:")) issue("scope", "an external record belongs to an enforced scope");
    if ((r.seq === 0) !== (r.prevHash === ZERO_BYTES32)) {
      issue("prevHash", "seq 0 must have prevHash ZERO_BYTES32 and only seq 0 may");
    }
    for (let i = 1; i < r.events.length; i++) {
      const prev = r.events[i - 1];
      const cur = r.events[i];
      if (prev !== undefined && cur !== undefined && cur.logIndex <= prev.logIndex) {
        issue("events", "events must be in strictly increasing logIndex order");
        break;
      }
    }
    const cps = r.events.map((e) => e.args["counterparty"]);
    const first = cps[0];
    const shared = first !== undefined && cps.every((c) => c === first) ? first : undefined;
    if (shared === undefined ? r.counterparty !== undefined : r.counterparty !== shared) {
      issue("counterparty", "counterparty is present iff every event has the same counterparty arg, and then equals it");
    }
    const names = r.events.map((e) => e.name);
    if (names.some((n) => HUMAN_ONLY_EVENTS.includes(n)) && r.actor !== "human") {
      issue("actor", "a Human-only event requires actor human");
    }
    if (names.includes("OwnershipTransferred") && r.actor !== "pending-human" && r.actor !== "human") {
      issue("actor", "OwnershipTransferred requires actor pending-human or human");
    }
  });
export type ExternalRecord = z.output<typeof ExternalRecord>;
export type ExternalRecordInput = z.input<typeof ExternalRecord>;

/** Every record a Scope chain may hold. */
export const ScopeRecord = z.union([DecisionRecord, ExternalRecord]);
export type ScopeRecord = z.output<typeof ScopeRecord>;

export function isExternalRecord(record: ScopeRecord): record is ExternalRecord {
  return "recordType" in record && record.recordType === "external";
}

/**
 * The union member a raw record claims to be (by `recordType`), for precise validation errors: a union
 * failure only says "no member matched".
 */
export function scopeRecordMember(record: unknown): typeof DecisionRecord | typeof ExternalRecord {
  const t = typeof record === "object" && record !== null ? (record as { recordType?: unknown }).recordType : undefined;
  return t === undefined ? DecisionRecord : ExternalRecord;
}

/** Canonical JSON of a record after validation/normalisation. Throws `ZodError` when invalid. */
export function canonicalRecord(record: unknown): string {
  return jcs(ScopeRecord.parse(record));
}

/** `0x` + lowercase hex of keccak256(utf8(JCS(ScopeRecord.parse(record)))). Throws `ZodError` when invalid. */
export function recordHash(record: unknown): Hex {
  return keccakHex(canonicalRecord(record));
}
