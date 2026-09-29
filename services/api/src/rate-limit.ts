// In-memory fixed-window rate limiter (Story 2.9). One api replica, so process memory is the right store;
// a restart resets the windows, which only ever lets a few more Checks through. Expired windows are pruned on the
// first call of each new window, and the number of keys per window is capped: when full, a new key is refused.

export const DEFAULT_MAX_KEYS = 50_000;

export class FixedWindowLimiter {
  private readonly windows = new Map<string, { readonly start: number; count: number }>();
  private lastSweep = 0;

  /**
   * @param limit    requests allowed per key per window
   * @param windowMs window length (default one minute)
   * @param maxKeys  keys tracked at once (default 50,000); a new key beyond it is refused until the window ends
   */
  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly maxKeys = DEFAULT_MAX_KEYS,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new RangeError("windowMs must be a positive integer");
    if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) throw new RangeError("maxKeys must be a positive integer");
  }

  /** Keys currently tracked (tests and diagnostics). */
  get size(): number {
    return this.windows.size;
  }

  /** Count one request for `key` at `nowMs`. False when the key is over its limit in the current window. */
  take(key: string, nowMs: number): boolean {
    const start = nowMs - (nowMs % this.windowMs);
    this.sweep(start);
    const w = this.windows.get(key);
    if (w === undefined || w.start !== start) {
      // Fail closed on a flood of distinct keys rather than grow without bound.
      if (w === undefined && this.windows.size >= this.maxKeys) return false;
      this.windows.set(key, { start, count: 1 });
      return true;
    }
    if (w.count >= this.limit) return false;
    w.count++;
    return true;
  }

  /** Milliseconds from `nowMs` until the current window ends (every key's count resets then). */
  msUntilReset(nowMs: number): number {
    return this.windowMs - (nowMs % this.windowMs);
  }

  /** Drop windows that ended. Every stored window belongs to the current one until the clock crosses a boundary, so
   * the scan runs only on the first call of each new window. */
  private sweep(currentStart: number): void {
    if (currentStart === this.lastSweep) return;
    this.lastSweep = currentStart;
    for (const [k, w] of this.windows) if (w.start < currentStart) this.windows.delete(k);
  }
}
