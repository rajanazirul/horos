// Check request/response wire schema (FR-1, FR-2, AD-11, AD-17). Wire is snake_case.
import { z } from "zod";
import { jcs, keccakHex, utf8ByteLength } from "./jcs.js";
import {
  Address,
  Bytes32,
  HexSignature,
  PositiveUsdcAmount,
  UsdcAmount,
  UuidV7,
  WireTime,
  ZERO_BYTES32,
  type Hex,
} from "./primitives.js";

/**
 * The fixed system Customer id every advisory-public record carries (AD-25). Unauthenticated input is never
 * attributed to the named wallet's Customer.
 */
export const ADVISORY_PUBLIC_CUSTOMER_ID = "00000000-0000-7000-8000-000000000000";

/** Maximum UTF-8 byte length of the JCS form of a Declared Identity. */
export const DECLARED_IDENTITY_MAX_BYTES = 1024;

/** Self-declared Counterparty identity. Always unverified; never logged. */
export const DeclaredIdentity = z
  .strictObject({
    name: z.string().min(1).max(200).exactOptional(),
    domain: z.string().min(1).max(253).exactOptional(),
    business_type: z.string().min(1).max(100).exactOptional(),
    purpose: z.string().min(1).max(500).exactOptional(),
  })
  .superRefine((value, ctx) => {
    if (Object.values(value).every((v) => v === undefined)) {
      ctx.addIssue({ code: "custom", message: "declared_identity needs at least one field" });
      return;
    }
    let size: number;
    try {
      size = utf8ByteLength(jcs(value));
    } catch (err) {
      ctx.addIssue({ code: "custom", message: `declared_identity is not canonicalisable: ${String(err)}` });
      return;
    }
    if (size > DECLARED_IDENTITY_MAX_BYTES) {
      ctx.addIssue({
        code: "custom",
        message: `declared_identity canonical form exceeds ${DECLARED_IDENTITY_MAX_BYTES} bytes`,
      });
    }
  });
export type DeclaredIdentity = z.output<typeof DeclaredIdentity>;

/**
 * keccak256 of the JCS form of a (validated) Declared Identity, or `ZERO_BYTES32` when absent.
 * This is the `declaredIdentityHash` field of the signed Check struct.
 */
export function declaredIdentityHash(identity?: DeclaredIdentity): Hex {
  if (identity === undefined) return ZERO_BYTES32;
  return keccakHex(jcs(DeclaredIdentity.parse(identity)));
}

/** EIP-712 authentication envelope of a Check (AD-11). */
export const CheckAuth = z.strictObject({
  nonce: Bytes32,
  // Signed as uint64 unix seconds: must be a whole second at or after the unix epoch.
  expiry: WireTime.refine(
    (s) => s.endsWith(".000Z") && Date.parse(s) >= 0,
    "expiry must be a whole second (.000Z) at or after 1970-01-01T00:00:00.000Z",
  ),
  signature: HexSignature,
});
export type CheckAuth = z.output<typeof CheckAuth>;

/** `POST /check` request body. */
export const CheckRequest = z.strictObject({
  policy_wallet: Address,
  counterparty: Address,
  amount: PositiveUsdcAmount,
  declared_identity: DeclaredIdentity.exactOptional(),
  auth: CheckAuth.exactOptional(),
});
export type CheckRequest = z.output<typeof CheckRequest>;
export type CheckRequestInput = z.input<typeof CheckRequest>;

export const Decision = z.enum(["allow", "cap", "hold", "block"]);
export type Decision = z.output<typeof Decision>;

export const LimitWrite = z.enum(["pending", "coalesced", "confirmed", "failed", "none"]);
export type LimitWrite = z.output<typeof LimitWrite>;

export const ChainState = z.enum(["live", "stale"]);
export type ChainState = z.output<typeof ChainState>;

/**
 * One answered Graded Judgment question in a response. Provisional shape: Epic 4 owns the
 * Judge. `confidence` is omitted on advisory responses (no per-question probabilities).
 */
export const QuestionResult = z.object({
  id: z.string().min(1),
  answer: z.union([z.boolean(), z.string(), z.int()]),
  confidence: z.number().min(0).max(1).exactOptional(),
});
export type QuestionResult = z.output<typeof QuestionResult>;

/** `POST /check` success response (FR-2). `payable_amount` is present iff `decision` is `cap`. */
export const CheckResponse = z
  .object({
    decision: Decision,
    effective_limit: UsdcAmount,
    remaining: UsdcAmount,
    reason: z.string().min(1).max(600),
    confidence: z.number().min(0).max(1),
    judge: z.string().min(1).exactOptional(),
    record_id: UuidV7,
    simulated: z.boolean(),
    advisory: z.boolean(),
    tx_hash: Bytes32.exactOptional(),
    limit_write: LimitWrite,
    chain_state: ChainState,
    payable_amount: UsdcAmount.exactOptional(),
    questions: z.array(QuestionResult).exactOptional(),
  })
  .superRefine((value, ctx) => {
    if (value.decision === "cap" && value.payable_amount === undefined) {
      ctx.addIssue({ code: "custom", path: ["payable_amount"], message: "payable_amount is required when decision is cap" });
    }
    if (value.decision !== "cap" && value.payable_amount !== undefined) {
      ctx.addIssue({ code: "custom", path: ["payable_amount"], message: "payable_amount is only allowed when decision is cap" });
    }
    if (value.advisory) {
      value.questions?.forEach((q, i) => {
        if (q.confidence !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["questions", i, "confidence"],
            message: "advisory responses carry no per-question probabilities",
          });
        }
      });
    }
  });
export type CheckResponse = z.output<typeof CheckResponse>;
