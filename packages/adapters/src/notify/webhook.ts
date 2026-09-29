// Webhook Notifier (AD-21): POSTs the alert (`{kind, source, message}` for list alerts) as JSON to a configured URL. The URL may
// embed a token, so it is never echoed into errors. Alerts carry no secrets and no Declared Identity.
import type { FounderAlert, Notifier } from "@horos/core";

export interface WebhookNotifierOptions {
  readonly url: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export class WebhookNotifier implements Notifier {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: WebhookNotifierOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async notify(alert: FounderAlert): Promise<void> {
    const body = JSON.stringify(alert);
    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
    } catch {
      // The rejection may quote the (tokenised) URL; never let it reach logs or job rows.
      throw new Error("alert webhook request failed");
    }
    if (!res.ok) throw new Error(`alert webhook responded ${res.status}`);
  }
}
