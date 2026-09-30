// The Horos client (AD-11, AD-17): `check()` signs a Check envelope with the Payment key, POSTs it to `/v1/check`,
// resends the byte-identical body on retryable errors until the envelope is about to expire, and returns the parsed
// `CheckResponse`. Without a signer the client is advisory: `check()` sends no `auth` and the api answers from the
// advisory-public Scope (nothing is written on-chain). The read methods (`listRecords`, `getRecord`,
// `listCounterparties`, `getCounterparty`) send a signed ReadAccess when there is a signer and no auth headers
// otherwise, which the api accepts only for its public demo Scope. With an `apiKey` (Shadow Mode, Story 3.4) `check()`
// goes to `/v1/shadow/check` and every read sends the key instead of a signature: advisory answers from the Customer's
// shadow Scope, nothing on-chain, no signer needed. Thin over `@horos/schema`: every wire type, EIP-712
// domain and error code comes from there. Declared Identity is never logged or put in an error.
import {
  accountDomain,
  Address,
  API_KEY_HEADER,
  CHECK_PRIMARY_TYPE,
  CHECK_TYPES,
  checkDomain,
  checkMessageFromRequest,
  CheckRequest,
  CheckResponse,
  CounterpartyStatusPage,
  CounterpartyStatusView,
  DeclaredIdentity,
  MAX_ACCOUNT_EXPIRY_SECONDS,
  MAX_CHECK_EXPIRY_SECONDS,
  READ_ACCESS_HEADERS,
  READ_ACCESS_PRIMARY_TYPE,
  READ_ACCESS_TYPES,
  READ_PAGE_MAX,
  readAccessMessage,
  RecordDetail,
  RecordPage,
  Scope,
  ShadowApiKey,
  ShadowCheckRequest,
  ShadowCheckResponse,
  ShadowSummary,
  type ShadowOutcome,
  toBaseUnits,
  UuidV7,
  type Hex,
} from "@horos/schema";
import { createTransport, describe, expiryAt, invalid, parseBaseUrl, randomBytes32, RETRY_EXPIRY_MARGIN_MS, signVerified, type FetchLike } from "./internal.js";
import type { CheckSigner, SignableTypedData } from "./signer.js";

export { RETRY_EXPIRY_MARGIN_MS, RETRY_INITIAL_BACKOFF_MS, RETRY_MAX_BACKOFF_MS, type FetchLike } from "./internal.js";

/** Default lifetime of a signed Check envelope, in seconds. */
export const DEFAULT_CHECK_EXPIRY_SECONDS = 120;
/** The `policyWallet` of an advisory (signer-less) client. */
export const ZERO_ADDRESS: Hex = "0x0000000000000000000000000000000000000000";
/** Lifetime of a signed ReadAccess, in seconds. */
export const READ_ACCESS_EXPIRY_SECONDS = 60;

export interface HorosOptions {
  /** The Horos api origin, e.g. `https://api.example.com`. */
  readonly baseUrl: string;
  /** Chain id of the PolicyWallet (Arc testnet: 5042002). */
  readonly chainId: number;
  /**
   * The Customer's PolicyWallet address (the Check domain's `verifyingContract`). Required with a `signer`; without
   * one it defaults to the zero address (advisory Checks are bound to no wallet).
   */
  readonly policyWallet?: string;
  /**
   * The Payment key: `fromViemAccount(...)` or `circleDcwSigner(...)`. Optional: without it every Check is advisory
   * (nothing is written, the answer is not enforcement) and reads work only for the api's public demo Scope.
   */
  readonly signer?: CheckSigner;
  /**
   * A Shadow Mode API key (from `shadowSignup`). Exclusive with `signer`: `check()` then runs advisory shadow Checks
   * against the Customer's virtual ledger (nothing on-chain), and reads send the key. Keep it out of the repo and logs.
   */
  readonly apiKey?: string;
  /** The default Scope id for the read methods (`enforced:<uuid>` from onboarding, or the public demo Scope). */
  readonly scope?: string;
  /** Lifetime of each signed Check, in whole seconds. Default 120; at most `MAX_CHECK_EXPIRY_SECONDS` (300). */
  readonly expirySeconds?: number;
  readonly fetch?: FetchLike;
  /** Current time in unix milliseconds. Default `Date.now`. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** A Check's answer; a Shadow Mode Check also carries its `outcome` label (`advisory` | `would-have-caught`). */
export type CheckResult = CheckResponse & { readonly outcome?: ShadowOutcome };

/** Why a failed Shadow Check (no nonce, so never blindly resent) may still have been recorded. */
export const SHADOW_CHECK_UNCERTAIN =
  "the shadow Check may or may not have been recorded (it is not retried, to avoid a duplicate record); check the shadow Decision Log before resending";

export interface CheckInput {
  readonly counterparty: string;
  /** USDC in 6-dp base units (1 USDC = 1_000_000n). */
  readonly amount: bigint;
  /** Self-declared, unverified Counterparty identity. Hashed into the signed envelope; never logged. */
  readonly declaredIdentity?: DeclaredIdentity;
}

export interface GetRecordOptions {
  /** Overrides the client's `scope`. */
  readonly scope?: string;
}

export interface ListRecordsOptions {
  /** Overrides the client's `scope`. */
  readonly scope?: string;
  /** The `nextCursor` of the previous page (a record seq). */
  readonly after?: number;
  /** Page size, 1..100 (the api's default is 50). */
  readonly limit?: number;
}

export interface ListCounterpartiesOptions {
  /** Overrides the client's `scope`. */
  readonly scope?: string;
  /** The `nextCursor` of the previous page (a Counterparty address). */
  readonly after?: string;
  /** Page size, 1..100 (the api's default is 50). */
  readonly limit?: number;
}

export type GetCounterpartyOptions = GetRecordOptions;

export interface HorosClient {
  readonly policyWallet: Hex;
  /** The Payment key's address; undefined for an advisory (signer-less) client. */
  readonly address: Hex | undefined;
  /** Whether Checks and reads are signed with a Payment key. */
  readonly signed: boolean;
  /** Whether the client runs Shadow Mode Checks with an API key (always advisory). */
  readonly shadow: boolean;
  /**
   * Send one Check: signed with the Payment key when the client has a signer, unsigned (advisory) otherwise.
   * Throws `HorosError` on invalid input or when the api refuses it.
   */
  check(input: CheckInput): Promise<CheckResult>;
  /** Read one page of a Scope's Decision Records, oldest first. */
  listRecords(opts?: ListRecordsOptions): Promise<RecordPage>;
  /** Read one Decision Record (with its `recordHash` for `PolicyWallet.pay`) and its write receipts. */
  getRecord(recordId: string, opts?: GetRecordOptions): Promise<RecordDetail>;
  /** Read one page of a Scope's Counterparty statuses (enforced Scopes only; other Scopes return an empty page). */
  listCounterparties(opts?: ListCounterpartiesOptions): Promise<CounterpartyStatusPage>;
  /** Read one Counterparty's status in an enforced Scope. */
  getCounterparty(counterparty: string, opts?: GetCounterpartyOptions): Promise<CounterpartyStatusView>;
  /** A shadow Scope's Decision counts: `advisory` and `would_have_caught`. */
  getShadowSummary(opts?: GetRecordOptions): Promise<ShadowSummary>;
}

export function createHoros(options: HorosOptions): HorosClient {
  const baseUrl = parseBaseUrl(options.baseUrl);
  if (!Number.isSafeInteger(options.chainId) || options.chainId <= 0) throw invalid("chainId must be a positive integer");
  const signer = options.signer;
  let apiKey: string | undefined;
  if (options.apiKey !== undefined) {
    if (signer !== undefined) throw invalid("apiKey and signer are exclusive: an API key runs Shadow Mode, a signer runs enforced Checks");
    // Never echo the key itself.
    if (!ShadowApiKey.safeParse(options.apiKey).success) throw invalid("apiKey must be an hsk_ key from shadowSignup");
    apiKey = options.apiKey;
  }
  let policyWallet: Hex;
  if (options.policyWallet === undefined) {
    if (signer !== undefined) throw invalid("policyWallet is required with a signer");
    policyWallet = ZERO_ADDRESS;
  } else {
    const wallet = Address.safeParse(options.policyWallet);
    if (!wallet.success) throw invalid(`policyWallet: ${describe(wallet.error)}`);
    policyWallet = wallet.data;
  }
  const expirySeconds = options.expirySeconds ?? DEFAULT_CHECK_EXPIRY_SECONDS;
  // The retry deadline is the expiry minus a 5 s margin: at least one second must be left to send in.
  const minExpirySeconds = (RETRY_EXPIRY_MARGIN_MS + 1000) / 1000 + 1;
  if (!Number.isSafeInteger(expirySeconds) || expirySeconds < minExpirySeconds || expirySeconds > MAX_CHECK_EXPIRY_SECONDS) {
    throw invalid(`expirySeconds must be a whole number in [${minExpirySeconds}, ${MAX_CHECK_EXPIRY_SECONDS}]`);
  }
  let configuredScope: Scope | undefined;
  if (options.scope !== undefined) {
    const s = Scope.safeParse(options.scope);
    if (!s.success) throw invalid("scope must be a Scope id (enforced:<uuid>, shadow:<uuid> or advisory-public)");
    configuredScope = s.data;
  }
  let signerAddress: Hex | undefined;
  if (signer !== undefined) {
    const signerParsed = Address.safeParse(signer.address);
    if (!signerParsed.success) throw invalid(`signer.address: ${describe(signerParsed.error)}`);
    signerAddress = signerParsed.data;
  }
  const transport = createTransport(options);
  const now = transport.now;
  const sign = (by: CheckSigner, address: Hex, typedData: SignableTypedData): Promise<Hex> => signVerified(by, address, typedData);
  const sendWithRetry = <T>(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
    parse: (json: unknown) => { success: true; data: T } | { success: false },
    deadlineMs: number,
    giveUpReason: string,
  ) => transport.sendWithRetry(url, init, parse, deadlineMs, giveUpReason);

  function scopeFor(method: string, raw: string | undefined): Scope {
    const scopeRaw = raw ?? configuredScope;
    if (scopeRaw === undefined) throw invalid(`${method} needs a Scope id: pass \`scope\` to createHoros or ${method}`);
    const scope = Scope.safeParse(scopeRaw);
    if (!scope.success) throw invalid("scope must be a Scope id (enforced:<uuid>, shadow:<uuid> or advisory-public)");
    return scope.data;
  }

  function pageLimit(limit: number | undefined): number | undefined {
    if (limit === undefined) return undefined;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > READ_PAGE_MAX) throw invalid(`limit must be an integer in 1..${READ_PAGE_MAX}`);
    return limit;
  }

  /** GET a read route: signed ReadAccess headers with a signer, none otherwise (public demo Scope only). */
  async function read<T>(path: string, query: Record<string, string>, parse: (json: unknown) => { success: true; data: T } | { success: false }): Promise<T> {
    const qs = new URLSearchParams(query).toString();
    const url = `${baseUrl}${path}${qs === "" ? "" : `?${qs}`}`;
    const expiry = expiryAt(now(), Math.min(READ_ACCESS_EXPIRY_SECONDS, MAX_ACCOUNT_EXPIRY_SECONDS));
    const headers: Record<string, string> = {};
    if (apiKey !== undefined) headers[API_KEY_HEADER] = apiKey;
    if (signer !== undefined && signerAddress !== undefined) {
      const signature = await sign(signer, signerAddress, {
        domain: accountDomain(options.chainId),
        types: READ_ACCESS_TYPES,
        primaryType: READ_ACCESS_PRIMARY_TYPE,
        message: { ...readAccessMessage(policyWallet, expiry.wire) },
      });
      headers[READ_ACCESS_HEADERS.wallet] = policyWallet;
      headers[READ_ACCESS_HEADERS.expiry] = expiry.wire;
      headers[READ_ACCESS_HEADERS.signature] = signature;
    }
    return sendWithRetry(
      url,
      { method: "GET", headers },
      parse,
      expiry.ms - RETRY_EXPIRY_MARGIN_MS,
      signer === undefined ? "the retry budget is spent" : "the signed ReadAccess is about to expire",
    );
  }

  const scopePath = (scope: Scope) => `/v1/scopes/${encodeURIComponent(scope)}`;

  return {
    policyWallet,
    address: signerAddress,
    signed: signer !== undefined,
    shadow: apiKey !== undefined,

    async check(input) {
      const cp = Address.safeParse(input.counterparty);
      if (!cp.success) throw invalid(`counterparty: ${describe(cp.error)}`);
      if (typeof input.amount !== "bigint" || input.amount <= 0n) throw invalid("amount must be a bigint of USDC base units greater than 0");
      let amount: string;
      try {
        amount = toBaseUnits(input.amount);
      } catch {
        throw invalid("amount is out of range");
      }
      let identity: DeclaredIdentity | undefined;
      if (input.declaredIdentity !== undefined) {
        const parsed = DeclaredIdentity.safeParse(input.declaredIdentity);
        if (!parsed.success) throw invalid(`declaredIdentity: ${describe(parsed.error)}`);
        identity = parsed.data;
      }

      const expiry = expiryAt(now(), expirySeconds);
      if (apiKey !== undefined) {
        // Shadow Mode: no wallet and no signature; the API key names the Customer and its shadow Scope.
        const parsed = ShadowCheckRequest.safeParse({ counterparty: cp.data, amount, ...(identity === undefined ? {} : { declared_identity: identity }) });
        if (!parsed.success) throw invalid(describe(parsed.error));
        // A shadow Check has no nonce: only an explicit retryable error envelope (sent before any write) is retried.
        return transport.sendRetryingEnvelopesOnly(
          `${baseUrl}/v1/shadow/check`,
          { method: "POST", headers: { "content-type": "application/json", [API_KEY_HEADER]: apiKey }, body: JSON.stringify(parsed.data) },
          (json) => ShadowCheckResponse.safeParse(json),
          expiry.ms - RETRY_EXPIRY_MARGIN_MS,
          "the retry budget is spent",
          SHADOW_CHECK_UNCERTAIN,
        );
      }
      const base = {
        policy_wallet: policyWallet,
        counterparty: cp.data,
        amount,
        ...(identity === undefined ? {} : { declared_identity: identity }),
      };
      let request: CheckRequest;
      if (signer === undefined || signerAddress === undefined) {
        // Advisory: no `auth`, so the api answers from the advisory-public Scope and writes nothing on-chain.
        const parsed = CheckRequest.safeParse(base);
        if (!parsed.success) throw invalid(describe(parsed.error));
        request = parsed.data;
      } else {
        const nonce = randomBytes32();
        const unsigned = CheckRequest.safeParse({ ...base, auth: { nonce, expiry: expiry.wire, signature: `0x${"0".repeat(130)}` } });
        if (!unsigned.success) throw invalid(describe(unsigned.error));
        const signature = await sign(signer, signerAddress, {
          domain: checkDomain(options.chainId, policyWallet),
          types: CHECK_TYPES,
          primaryType: CHECK_PRIMARY_TYPE,
          message: { ...checkMessageFromRequest(unsigned.data) },
        });
        request = { ...unsigned.data, auth: { nonce, expiry: expiry.wire, signature } };
      }
      // Serialised once: every retry resends these exact bytes (same nonce, same signature).
      const body = JSON.stringify(request);
      return sendWithRetry(
        `${baseUrl}/v1/check`,
        { method: "POST", headers: { "content-type": "application/json" }, body },
        (json) => CheckResponse.safeParse(json),
        expiry.ms - RETRY_EXPIRY_MARGIN_MS,
        signer === undefined ? "the retry budget is spent" : "the signed envelope is about to expire",
      );
    },

    async listRecords(opts = {}) {
      const scope = scopeFor("listRecords", opts.scope);
      const limit = pageLimit(opts.limit);
      if (opts.after !== undefined && (!Number.isSafeInteger(opts.after) || opts.after < 0)) throw invalid("after must be a non-negative integer record seq");
      const query: Record<string, string> = {};
      if (opts.after !== undefined) query.after = String(opts.after);
      if (limit !== undefined) query.limit = String(limit);
      return read(`${scopePath(scope)}/records`, query, (json) => RecordPage.safeParse(json));
    },

    async getRecord(recordId, opts = {}) {
      const id = UuidV7.safeParse(recordId);
      if (!id.success) throw invalid("recordId must be a lowercase UUIDv7");
      const scope = scopeFor("getRecord", opts.scope);
      return read(`${scopePath(scope)}/records/${id.data}`, {}, (json) => RecordDetail.safeParse(json));
    },

    async listCounterparties(opts = {}) {
      const scope = scopeFor("listCounterparties", opts.scope);
      const limit = pageLimit(opts.limit);
      const query: Record<string, string> = {};
      if (opts.after !== undefined) {
        const after = Address.safeParse(opts.after);
        if (!after.success) throw invalid(`after: ${describe(after.error)}`);
        query.after = after.data;
      }
      if (limit !== undefined) query.limit = String(limit);
      return read(`${scopePath(scope)}/counterparties`, query, (json) => CounterpartyStatusPage.safeParse(json));
    },

    async getCounterparty(counterparty, opts = {}) {
      const cp = Address.safeParse(counterparty);
      if (!cp.success) throw invalid(`counterparty: ${describe(cp.error)}`);
      const scope = scopeFor("getCounterparty", opts.scope);
      return read(`${scopePath(scope)}/counterparties/${cp.data}`, {}, (json) => CounterpartyStatusView.safeParse(json));
    },

    async getShadowSummary(opts = {}) {
      const scope = scopeFor("getShadowSummary", opts.scope);
      if (!scope.startsWith("shadow:")) throw invalid("getShadowSummary needs a shadow:<customerId> Scope");
      return read(`${scopePath(scope)}/shadow-summary`, {}, (json) => ShadowSummary.safeParse(json));
    },
  };
}
