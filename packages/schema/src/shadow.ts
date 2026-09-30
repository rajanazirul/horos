// Shadow Mode wire schema (Story 3.4, FR-28, AD-7, AD-25). A Customer with no PolicyWallet in the payment path signs
// up with its Payment key, receives an API key once, and runs advisory Checks in its `shadow:<customerId>` Scope.
// Nothing reaches the chain. Shadow Decisions are counted only as "advisory" or "would-have-caught".
import { z } from "zod";
import { AccountAuth } from "./account.js";
import { CheckResponse, DeclaredIdentity } from "./check.js";
import { Address, PositiveUsdcAmount, UUID_V7_PATTERN, UuidV7 } from "./primitives.js";

/** The header carrying a shadow API key. The key is a secret: never logged, stored only as its sha256. */
export const API_KEY_HEADER = "x-horos-api-key";

/** The shadow API key prefix; the rest is 32 random bytes in unpadded base64url (43 characters). */
export const SHADOW_API_KEY_PREFIX = "hsk_";

/** `hsk_<base64url(32 random bytes)>`. */
export const ShadowApiKey = z.string().regex(/^hsk_[A-Za-z0-9_-]{43}$/, "expected an hsk_ API key");
export type ShadowApiKey = z.output<typeof ShadowApiKey>;

/** A `shadow:<customerId>` Scope id. */
export const ShadowScope = z.string().regex(new RegExp(`^shadow:${UUID_V7_PATTERN}$`), "expected a shadow:<uuidv7> scope");
export type ShadowScope = z.output<typeof ShadowScope>;

/** `POST /v1/shadow`. `auth` (a "Horos Account" ShadowSignup signed by the Payment key) may be omitted only with the admin bearer. */
export const ShadowSignupRequest = z.strictObject({
  payment_address: Address,
  auth: AccountAuth.exactOptional(),
});
export type ShadowSignupRequest = z.output<typeof ShadowSignupRequest>;

/** `POST /v1/shadow` response. `apiKey` is shown once; a later sign-up revokes it and issues a new one. */
export const ShadowSignupResponse = z.strictObject({
  customerId: UuidV7,
  scope: ShadowScope,
  apiKey: ShadowApiKey,
});
export type ShadowSignupResponse = z.output<typeof ShadowSignupResponse>;

/** `POST /v1/shadow/check` body, authenticated by the API key header. No `policy_wallet` and no `auth`. */
export const ShadowCheckRequest = z.strictObject({
  counterparty: Address,
  amount: PositiveUsdcAmount,
  declared_identity: DeclaredIdentity.exactOptional(),
});
export type ShadowCheckRequest = z.output<typeof ShadowCheckRequest>;
export type ShadowCheckRequestInput = z.input<typeof ShadowCheckRequest>;

/** The only two labels a shadow Decision ever carries. */
export const ShadowOutcome = z.enum(["advisory", "would-have-caught"]);
export type ShadowOutcome = z.output<typeof ShadowOutcome>;

/** `POST /v1/shadow/check` response: every `CheckResponse` field plus the Decision's outcome label. */
export const ShadowCheckResponse = z.intersection(CheckResponse, z.object({ outcome: ShadowOutcome }));
export type ShadowCheckResponse = z.output<typeof ShadowCheckResponse>;

/** `GET /v1/scopes/:scope/shadow-summary`: Decision counts per outcome label. */
export const ShadowSummary = z.strictObject({
  advisory: z.int().nonnegative(),
  would_have_caught: z.int().nonnegative(),
});
export type ShadowSummary = z.output<typeof ShadowSummary>;
