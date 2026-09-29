// A short-lived cache over a ChainReader for the api's Check path: `policy(wallet)` and `roles(wallet)` are read
// once per wallet per TTL, so a burst of Checks does not re-read them each time. Everything else passes through;
// in particular `remaining` (authoritative per payment, AD-3) and `hasCode` are never cached. A failed read is
// not cached, and concurrent reads of the same key share one request.
//
// Staleness: a role change (e.g. a Payment-key rotation, which the Check auth path compares the signer against)
// or a Policy change takes effect in the api within `ttlMs`.
import type { ChainReader, LivePolicy, WalletRoles } from "@horos/core";
import type { Hex } from "@horos/schema";

export interface CachedChainReaderOptions {
  /** How long a successful read is served from the cache. 0 or less disables caching. */
  readonly ttlMs: number;
  /** Clock in ms. Default `Date.now`. */
  readonly now?: () => number;
}

class TtlCache<T> {
  private readonly entries = new Map<string, { readonly at: number; readonly value: Promise<T> }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const t = this.now();
    const hit = this.entries.get(key);
    if (hit !== undefined && t - hit.at < this.ttlMs) return hit.value;
    const value = load();
    const entry = { at: t, value };
    this.entries.set(key, entry);
    value.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    // Drop expired entries now and then so the map stays bounded by the wallets seen within one TTL.
    if (this.entries.size > 1024) for (const [k, e] of this.entries) if (t - e.at >= this.ttlMs) this.entries.delete(k);
    return value;
  }
}

/** `reader` with `policy` and `roles` cached per wallet for `ttlMs`; `reader` itself when `ttlMs` ≤ 0. */
export function cachedChainReader(reader: ChainReader, opts: CachedChainReaderOptions): ChainReader {
  if (!(opts.ttlMs > 0)) return reader;
  const now = opts.now ?? Date.now;
  const policies = new TtlCache<LivePolicy>(opts.ttlMs, now);
  const roles = new TtlCache<WalletRoles>(opts.ttlMs, now);
  const key = (wallet: Hex) => wallet.toLowerCase();
  return {
    remaining: (w, cp) => reader.remaining(w, cp),
    roles: (w) => roles.get(key(w), () => reader.roles(w)),
    policy: (w) => policies.get(key(w), () => reader.policy(w)),
    hasCode: (a) => reader.hasCode(a),
    simulate: (w, call, from) => reader.simulate(w, call, from),
    latestBlock: () => reader.latestBlock(),
    logs: (w, from, to) => reader.logs(w, from, to),
    blockTimestamp: (b) => reader.blockTimestamp(b),
    txFrom: (h) => reader.txFrom(h),
    rolesAt: (w, b) => reader.rolesAt(w, b),
    hasCodeAt: (a, b) => reader.hasCodeAt(a, b),
  };
}
