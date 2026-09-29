// HTTP fetcher for OFAC SDN.CSV (AD-21): a conditional GET with `If-Modified-Since`. The URL comes from
// worker config (Story 2.10); tests inject a stub instead of hitting the real OFAC server.

/** Default published location of SDN.CSV. */
export const DEFAULT_SDN_CSV_URL = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV";

export type SdnFetchResult =
  | { readonly status: 304 }
  | { readonly status: 200; readonly body: string; readonly lastModified?: string }
  | { readonly status: number };

/** Fetch SDN.CSV, sending `If-Modified-Since` when known. Network failures reject. */
export type FetchSdn = (ifModifiedSince: string | undefined) => Promise<SdnFetchResult>;

export interface HttpSdnFetcherOptions {
  readonly url?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export function httpSdnFetcher(opts: HttpSdnFetcherOptions = {}): FetchSdn {
  const url = opts.url ?? DEFAULT_SDN_CSV_URL;
  const fetchImpl = opts.fetch ?? fetch;
  return async (ifModifiedSince) => {
    const headers: Record<string, string> = {};
    if (ifModifiedSince !== undefined) headers["if-modified-since"] = ifModifiedSince;
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000) });
    if (res.status === 304) return { status: 304 };
    if (res.status !== 200) {
      await res.body?.cancel();
      return { status: res.status };
    }
    const body = await res.text();
    const lastModified = res.headers.get("last-modified");
    return lastModified === null ? { status: 200, body } : { status: 200, body, lastModified };
  };
}
