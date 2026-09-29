import { describe, expect, test } from "vitest";
import { DEFAULT_SDN_CSV_URL, httpSdnFetcher } from "./fetch.js";

function stub(res: () => Response) {
  const seen: { url: string; headers: Headers }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: new Headers(init.headers) });
    return res();
  }) as unknown as typeof fetch;
  return { f, seen };
}

describe("httpSdnFetcher", () => {
  test("sends If-Modified-Since and maps 200 with Last-Modified", async () => {
    const { f, seen } = stub(() => new Response("a,b", { status: 200, headers: { "last-modified": "Fri, 25 Sep 2026 12:00:00 GMT" } }));
    const r = await httpSdnFetcher({ fetch: f })("Thu, 24 Sep 2026 12:00:00 GMT");
    expect(seen[0]?.url).toBe(DEFAULT_SDN_CSV_URL);
    expect(seen[0]?.headers.get("if-modified-since")).toBe("Thu, 24 Sep 2026 12:00:00 GMT");
    expect(r).toEqual({ status: 200, body: "a,b", lastModified: "Fri, 25 Sep 2026 12:00:00 GMT" });
  });

  test("omits the header on first fetch; maps 304 and other statuses", async () => {
    const a = stub(() => new Response(null, { status: 304 }));
    expect(await httpSdnFetcher({ fetch: a.f, url: "https://x.invalid/sdn.csv" })(undefined)).toEqual({ status: 304 });
    expect(a.seen[0]?.headers.has("if-modified-since")).toBe(false);
    const b = stub(() => new Response("oops", { status: 503 }));
    expect(await httpSdnFetcher({ fetch: b.f })(undefined)).toEqual({ status: 503 });
  });
});
