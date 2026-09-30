// Account onboarding wire schema and the "Horos Account" EIP-712 domain (AD-11, AD-15, AD-25).
// Onboard / Bind are signed by the Customer's Payment key; WebhookUpdate by the live Payment role holder.
import { z } from "zod";
import { CheckAuth } from "./check.js";
import { EIP712_VERSION } from "./eip712.js";
import { Address, type Hex } from "./primitives.js";

// The WHATWG URL global (Node and browsers). Declared locally: the schema build ships without DOM or Node types.
interface WhatwgUrl {
  readonly protocol: string;
  readonly hostname: string;
  readonly username: string;
  readonly password: string;
  readonly origin: string;
  readonly pathname: string;
}
declare const URL: new (input: string) => WhatwgUrl;

export const ACCOUNT_DOMAIN_NAME = "Horos Account";

/** A signed account request may expire at most this many seconds after it is received. */
export const MAX_ACCOUNT_EXPIRY_SECONDS = 300;

/** Maximum length of a webhook URL. */
export const WEBHOOK_URL_MAX_LENGTH = 2048;

export interface AccountDomain {
  readonly name: typeof ACCOUNT_DOMAIN_NAME;
  readonly version: typeof EIP712_VERSION;
  readonly chainId: number;
}

/** `{name: "Horos Account", version: "1", chainId}`; no verifyingContract (the wallet may not exist yet). */
export function accountDomain(chainId: number): AccountDomain {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new RangeError("chainId must be a positive integer");
  return { name: ACCOUNT_DOMAIN_NAME, version: EIP712_VERSION, chainId };
}

export const ONBOARD_PRIMARY_TYPE = "Onboard";
export const ONBOARD_TYPES = {
  Onboard: [
    { name: "paymentAddress", type: "address" },
    { name: "webhookUrl", type: "string" },
    { name: "nonce", type: "bytes32" },
    { name: "expiry", type: "uint64" },
  ],
} as const;

export const BIND_PRIMARY_TYPE = "Bind";
export const BIND_TYPES = {
  Bind: [
    { name: "paymentAddress", type: "address" },
    { name: "policyWallet", type: "address" },
    { name: "nonce", type: "bytes32" },
    { name: "expiry", type: "uint64" },
  ],
} as const;

export const WEBHOOK_UPDATE_PRIMARY_TYPE = "WebhookUpdate";
export const WEBHOOK_UPDATE_TYPES = {
  WebhookUpdate: [
    { name: "policyWallet", type: "address" },
    { name: "webhookUrl", type: "string" },
    { name: "nonce", type: "bytes32" },
    { name: "expiry", type: "uint64" },
  ],
} as const;

/** Shadow Mode sign-up (Story 3.4, FR-28, AD-25), signed by the Customer's Payment key. */
export const SHADOW_SIGNUP_PRIMARY_TYPE = "ShadowSignup";
export const SHADOW_SIGNUP_TYPES = {
  ShadowSignup: [
    { name: "paymentAddress", type: "address" },
    { name: "nonce", type: "bytes32" },
    { name: "expiry", type: "uint64" },
  ],
} as const;

export interface ShadowSignupMessage {
  paymentAddress: Hex;
  nonce: Hex;
  expiry: bigint;
}

/** Read access to an enforced Scope's records and statuses (Story 2.8), signed by the live Payment role holder. */
export const READ_ACCESS_PRIMARY_TYPE = "ReadAccess";
export const READ_ACCESS_TYPES = {
  ReadAccess: [
    { name: "policyWallet", type: "address" },
    { name: "expiry", type: "uint64" },
  ],
} as const;

export interface ReadAccessMessage {
  policyWallet: Hex;
  expiry: bigint;
}

/** Headers carrying a signed ReadAccess: the wallet, the expiry (wire time, whole seconds) and the signature. */
export const READ_ACCESS_HEADERS = {
  wallet: "x-horos-wallet",
  expiry: "x-horos-expiry",
  signature: "x-horos-signature",
} as const;

/** The ReadAccess message for a wallet and a wire-time expiry. */
export function readAccessMessage(policyWallet: Hex, expiry: string): ReadAccessMessage {
  return { policyWallet, expiry: unixSeconds(expiry) };
}

export interface OnboardMessage {
  paymentAddress: Hex;
  webhookUrl: string;
  nonce: Hex;
  expiry: bigint;
}

export interface BindMessage {
  paymentAddress: Hex;
  policyWallet: Hex;
  nonce: Hex;
  expiry: bigint;
}

export interface WebhookUpdateMessage {
  policyWallet: Hex;
  webhookUrl: string;
  nonce: Hex;
  expiry: bigint;
}

function isAllowedWebhookUrl(s: string): boolean {
  let url: WhatwgUrl;
  try {
    url = new URL(s);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  if (url.protocol === "https:") return url.hostname !== "";
  return url.protocol === "http:" && url.hostname === "localhost";
}

/** A webhook URL: `https:` (or `http://localhost` for dev), at most 2048 characters, no credentials. */
export const WebhookUrl = z
  .string()
  .min(1)
  .max(WEBHOOK_URL_MAX_LENGTH, `at most ${WEBHOOK_URL_MAX_LENGTH} characters`)
  .refine(isAllowedWebhookUrl, "webhook_url must be https: (or http://localhost), without credentials");
export type WebhookUrl = z.output<typeof WebhookUrl>;

/** A webhook URL, or `""` for none. */
export const WebhookUrlOrEmpty = z.union([z.literal(""), WebhookUrl]);
export type WebhookUrlOrEmpty = z.output<typeof WebhookUrlOrEmpty>;

/**
 * `origin + pathname` of a URL: the only form that may reach logs or error messages (the query string
 * or fragment may carry a token). Returns `""` for `""` and `"(invalid url)"` for anything unparseable.
 */
export function redactUrl(url: string): string {
  if (url === "") return "";
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "(invalid url)";
  }
}

/**
 * Replace every `http(s)://…` URL inside free text (e.g. an RPC error message) with its origin only, so
 * paths and query strings that may carry API keys never reach logs, rows or alerts.
 */
export function redactUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>()]+/giu, (m) => {
    try {
      return new URL(m).origin;
    } catch {
      return "(invalid url)";
    }
  });
}

/** The signed envelope of an account request (same shape as a Check's). */
export const AccountAuth = CheckAuth;
export type AccountAuth = z.output<typeof AccountAuth>;

/** `POST /v1/onboarding`. `auth` may be omitted only with the admin bearer token. */
export const OnboardingRequest = z.strictObject({
  payment_address: Address,
  webhook_url: WebhookUrlOrEmpty.exactOptional(),
  auth: AccountAuth.exactOptional(),
});
export type OnboardingRequest = z.output<typeof OnboardingRequest>;

/** `POST /v1/onboarding/bind`. `auth` may be omitted only with the admin bearer token. */
export const BindRequest = z.strictObject({
  payment_address: Address,
  policy_wallet: Address,
  auth: AccountAuth.exactOptional(),
});
export type BindRequest = z.output<typeof BindRequest>;

/** `PUT /v1/webhook`, signed by the live Payment role holder. `""` clears the webhook. */
export const WebhookUpdateRequest = z.strictObject({
  policy_wallet: Address,
  webhook_url: WebhookUrlOrEmpty,
  auth: AccountAuth,
});
export type WebhookUpdateRequest = z.output<typeof WebhookUpdateRequest>;

export const OnboardingStatus = z.enum(["provisioning", "provisioned", "bound"]);
export type OnboardingStatus = z.output<typeof OnboardingStatus>;

/** Onboarding / bind response. Role addresses are null while the worker is still provisioning keys. */
export const OnboardingResponse = z.strictObject({
  customerId: z.string(),
  scope: z.string(),
  status: OnboardingStatus,
  registrar: Address.nullable(),
  model: Address.nullable(),
  rules: Address.nullable(),
  policyWallet: Address.exactOptional(),
});
export type OnboardingResponse = z.output<typeof OnboardingResponse>;

function unixSeconds(expiry: string): bigint {
  return BigInt(Date.parse(expiry) / 1000);
}

function authOf(req: { readonly auth?: AccountAuth }): AccountAuth {
  if (req.auth === undefined) throw new TypeError("request has no auth envelope");
  return req.auth;
}

export function onboardMessageFromRequest(req: OnboardingRequest): OnboardMessage {
  const auth = authOf(req);
  return { paymentAddress: req.payment_address, webhookUrl: req.webhook_url ?? "", nonce: auth.nonce, expiry: unixSeconds(auth.expiry) };
}

export function bindMessageFromRequest(req: BindRequest): BindMessage {
  const auth = authOf(req);
  return { paymentAddress: req.payment_address, policyWallet: req.policy_wallet, nonce: auth.nonce, expiry: unixSeconds(auth.expiry) };
}

/** The ShadowSignup message of a signed `POST /v1/shadow` body. Throws without `auth`. */
export function shadowSignupMessageFromRequest(req: { readonly payment_address: Hex; readonly auth?: AccountAuth }): ShadowSignupMessage {
  const auth = authOf(req);
  return { paymentAddress: req.payment_address, nonce: auth.nonce, expiry: unixSeconds(auth.expiry) };
}

export function webhookUpdateMessageFromRequest(req: WebhookUpdateRequest): WebhookUpdateMessage {
  return { policyWallet: req.policy_wallet, webhookUrl: req.webhook_url, nonce: req.auth.nonce, expiry: unixSeconds(req.auth.expiry) };
}

/** True when `expiry` (a whole-second wire time) is in the future and at most 300s after `now`. */
export function accountExpiryValid(expiry: string, now: Date): boolean {
  const ms = Date.parse(expiry);
  const nowMs = now.getTime();
  return Number.isFinite(ms) && ms > nowMs && ms - nowMs <= MAX_ACCOUNT_EXPIRY_SECONDS * 1000;
}
