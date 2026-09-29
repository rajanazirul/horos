import { describe, expect, test } from "vitest";
import { WebhookNotifier } from "./webhook.js";

const alert = { kind: "list-quarantined", source: "ofac-sdn", message: "3 of 10 addresses removed" } as const;

function stub(status: number) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("WebhookNotifier", () => {
  test("POSTs exactly {kind, source, message} as JSON", async () => {
    const { f, calls } = stub(204);
    await new WebhookNotifier({ url: "https://hooks.example.invalid/x", fetch: f }).notify(alert);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://hooks.example.invalid/x");
    expect(calls[0]?.init.method).toBe("POST");
    expect(new Headers(calls[0]?.init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(alert);
  });

  test("a fetch rejection becomes a generic error without the URL or cause text", async () => {
    const url = "https://hooks.example.invalid/secret-token";
    const f = (async () => {
      throw new TypeError(`Failed to parse URL from ${url}`);
    }) as unknown as typeof fetch;
    const err = await new WebhookNotifier({ url, fetch: f }).notify(alert).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("alert webhook request failed");
    expect((err as Error).cause).toBeUndefined();
  });

  test("a non-2xx response rejects without leaking the URL", async () => {
    const { f } = stub(500);
    const err = await new WebhookNotifier({ url: "https://hooks.example.invalid/secret-token", fetch: f })
      .notify(alert)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toContain("500");
    expect(String((err as Error).message)).not.toContain("secret-token");
  });
});
