// Shadow Mode sign-up (Story 3.4, FR-28): the Payment key signs a "Horos Account" ShadowSignup, the api finds or
// creates the Customer and its `shadow:<customerId>` Scope, and returns an API key once (a repeat sign-up revokes
// the previous key). Pass the key to `createHoros({apiKey})` for advisory shadow Checks: nothing is written on-chain
// and the payment path is unchanged. Once the Customer's PolicyWallet is bound the api answers `shadow_closed`.
// The API key is a secret: keep it out of the repo and logs.
import {
  accountDomain,
  Address,
  MAX_ACCOUNT_EXPIRY_SECONDS,
  SHADOW_SIGNUP_PRIMARY_TYPE,
  SHADOW_SIGNUP_TYPES,
  shadowSignupMessageFromRequest,
  ShadowSignupRequest,
  ShadowSignupResponse,
  type Hex,
} from "@horos/schema";
import { HorosError } from "./errors.js";
import { createTransport, describe, expiryAt, invalid, parseBaseUrl, randomBytes32, RETRY_EXPIRY_MARGIN_MS, signVerified, type FetchLike } from "./internal.js";
import type { CheckSigner } from "./signer.js";

/** The advice when a sign-up's outcome is unknown: the old key may already be revoked. */
export const SHADOW_SIGNUP_UNCERTAIN = "the previous sign-up may have succeeded; sign up again to get a fresh key";

/** Lifetime of the signed ShadowSignup, in seconds (the api accepts at most 300). */
export const SHADOW_SIGNUP_EXPIRY_SECONDS = 120;

export interface ShadowSignupOptions {
  /** The Horos api origin. */
  readonly baseUrl: string;
  /** The chain id of the "Horos Account" domain (Arc testnet: 5042002). */
  readonly chainId: number;
  /** The Payment key (`fromViemAccount(...)` or `circleDcwSigner(...)`). Its address is the Customer's Payment address. */
  readonly signer: CheckSigner;
  readonly fetch?: FetchLike;
  /** Current time in unix milliseconds. Default `Date.now`. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ShadowSignupResult {
  readonly customerId: string;
  /** `shadow:<customerId>`: pass it as `scope` to read the shadow Decision Log. */
  readonly scope: string;
  /** Shown once. A later sign-up revokes it. */
  readonly apiKey: string;
}

/**
 * Sign up for Shadow Mode with the Payment key and get an API key. Throws `HorosError` (`shadow_closed` once the
 * Customer's PolicyWallet is bound; `unauthenticated` on a bad signature).
 */
export async function shadowSignup(options: ShadowSignupOptions): Promise<ShadowSignupResult> {
  const baseUrl = parseBaseUrl(options.baseUrl);
  if (!Number.isSafeInteger(options.chainId) || options.chainId <= 0) throw invalid("chainId must be a positive integer");
  const address = Address.safeParse(options.signer.address);
  if (!address.success) throw invalid(`signer.address: ${describe(address.error)}`);
  const transport = createTransport(options);
  const nonce = randomBytes32();
  const expiry = expiryAt(transport.now(), Math.min(SHADOW_SIGNUP_EXPIRY_SECONDS, MAX_ACCOUNT_EXPIRY_SECONDS));
  const unsigned = ShadowSignupRequest.safeParse({
    payment_address: address.data,
    auth: { nonce, expiry: expiry.wire, signature: `0x${"0".repeat(130)}` },
  });
  if (!unsigned.success) throw invalid(describe(unsigned.error));
  const signature: Hex = await signVerified(options.signer, address.data, {
    domain: accountDomain(options.chainId),
    types: SHADOW_SIGNUP_TYPES,
    primaryType: SHADOW_SIGNUP_PRIMARY_TYPE,
    message: { ...shadowSignupMessageFromRequest(unsigned.data) },
  });
  // The api consumes the nonce whenever it gets past authentication (a key issued, or `shadow_closed`), so a resend after
  // a lost response would only hit "nonce already used" while the old key is already revoked. Only a retryable error
  // envelope (sent before any write, e.g. 429) is resent; a transport failure throws at once.
  const body = JSON.stringify({ ...unsigned.data, auth: { nonce, expiry: expiry.wire, signature } });
  let res: ShadowSignupResponse;
  try {
    res = await transport.sendRetryingEnvelopesOnly(
      `${baseUrl}/v1/shadow`,
      { method: "POST", headers: { "content-type": "application/json" }, body },
      (json) => ShadowSignupResponse.safeParse(json),
      expiry.ms - RETRY_EXPIRY_MARGIN_MS,
      "the signed ShadowSignup is about to expire",
      SHADOW_SIGNUP_UNCERTAIN,
    );
  } catch (err) {
    if (err instanceof HorosError && err.code === "unauthenticated" && /nonce already used/i.test(err.message)) {
      throw new HorosError({
        code: "unauthenticated",
        message: `this sign-up was already used: ${SHADOW_SIGNUP_UNCERTAIN}`,
        retryable: false,
        ...(err.status === undefined ? {} : { status: err.status }),
        attempts: err.attempts,
      });
    }
    throw err;
  }
  return { customerId: res.customerId, scope: res.scope, apiKey: res.apiKey };
}
