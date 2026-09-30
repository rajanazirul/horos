// TypeScript port of the PolicyWallet's rolling-window arithmetic (Story 3.4, AD-7): `RollingWindow.record`,
// `windowSum`, `satSub` and `PolicyWallet._remaining`, reproduced exactly so the shadow virtual ledger computes the
// same `remaining(a)` the contract would. A ring has 91 day-tagged slots indexed by `dayIndex % 91`; the window is
// `[today - min(n, 90), today]` (lower bound floored at 0); every amount saturates at `uint224`; reads never throw.
// Pure: no I/O and no clock. It must pass the Foundry-generated vectors in `contracts/test-vectors` (both files).
// Lives in adapters, not core: core never does bucket arithmetic (AD-7).

/** Widest supported window, in days (the contract's `MAX_WINDOW_DAYS`). */
export const MAX_WINDOW_DAYS = 90;
/** Slots per ring (`MAX_WINDOW_DAYS + 1`). */
export const RING_SIZE = MAX_WINDOW_DAYS + 1;
/** `type(uint224).max`: the saturation bound of a slot. */
export const UINT224_MAX = (1n << 224n) - 1n;
/** `type(uint32).max`: the largest recordable day index. */
export const UINT32_MAX = 0xffff_ffff;
const SECONDS_PER_DAY = 86_400n;

/** One day bucket. */
export interface Slot {
  readonly dayIndex: number;
  readonly amount: bigint;
}

/**
 * A ring: slot index → slot. Missing indexes are the untouched zero slot `(0, 0)`. Invariant kept by `record`: the
 * slot at index `i` has `dayIndex % RING_SIZE === i`.
 */
export type Ring = ReadonlyMap<number, Slot>;

/** Thrown by `record` when `today` does not fit the uint32 day tag (the contract's `DayIndexOverflow`). */
export class DayIndexOverflowError extends RangeError {
  override readonly name = "DayIndexOverflowError";
}

/** `floor(unixSeconds / 86400)`, the contract's `block.timestamp / 1 days`. */
export function dayIndexOf(unixSeconds: bigint): bigint {
  if (unixSeconds < 0n) throw new RangeError("timestamp must be non-negative");
  return unixSeconds / SECONDS_PER_DAY;
}

/** The day index of a JS time (whole seconds, rounded down). */
export function dayIndexAt(now: Date): number {
  return Number(dayIndexOf(BigInt(Math.floor(now.getTime() / 1000))));
}

/** The slot index of a day. */
export function slotIndexOf(dayIndex: number | bigint): number {
  return Number(BigInt(dayIndex) % BigInt(RING_SIZE));
}

function slotAt(ring: Ring, index: number): Slot {
  return ring.get(index) ?? { dayIndex: 0, amount: 0n };
}

/**
 * The slot `RollingWindow.record(ring, today, amount)` writes: overwrite when the slot holds another day, else add;
 * saturating at `uint224`. Returns `[index, slot]`; the ring itself is not modified.
 */
export function recordSlot(ring: Ring, today: number | bigint, amount: bigint): readonly [number, Slot] {
  const day = BigInt(today);
  if (day < 0n || amount < 0n) throw new RangeError("today and amount must be non-negative");
  if (day > BigInt(UINT32_MAX)) throw new DayIndexOverflowError("day index does not fit uint32");
  const index = slotIndexOf(day);
  const s = slotAt(ring, index);
  let next: bigint;
  if (BigInt(s.dayIndex) !== day) {
    next = amount > UINT224_MAX ? UINT224_MAX : amount;
  } else {
    const cur = s.amount;
    next = amount >= UINT224_MAX - cur ? UINT224_MAX : cur + amount;
  }
  return [index, { dayIndex: Number(day), amount: next }];
}

/** `RollingWindow.record`: a new ring with `amount` added to today's bucket. */
export function record(ring: Ring, today: number | bigint, amount: bigint): Ring {
  const [index, slot] = recordSlot(ring, today, amount);
  const next = new Map(ring);
  next.set(index, slot);
  return next;
}

/**
 * `RollingWindow.windowSum`: the sum of every slot whose day lies in `[today - n, today]` (lower bound floored at 0),
 * with `n` clamped to 90. Never throws for non-negative inputs.
 */
export function windowSum(ring: Ring, today: number | bigint, n: number | bigint): bigint {
  const t = BigInt(today);
  let days = BigInt(n);
  if (t < 0n || days < 0n) throw new RangeError("today and n must be non-negative");
  if (days > BigInt(MAX_WINDOW_DAYS)) days = BigInt(MAX_WINDOW_DAYS);
  const lo = t > days ? t - days : 0n;
  let s = 0n;
  for (let d = lo; d <= t; d++) {
    const x = slotAt(ring, slotIndexOf(d));
    if (BigInt(x.dayIndex) === d) s += x.amount;
  }
  return s;
}

/** `RollingWindow.satSub`: `a - b`, or 0 when `b >= a`. */
export function satSub(a: bigint, b: bigint): bigint {
  return a > b ? a - b : 0n;
}

/** The on-chain Policy values `_remaining` reads. Amounts in 6-dp USDC base units; `newPayeeCap` is a count. */
export interface WindowPolicy {
  readonly firstContactCeiling: bigint;
  readonly walletPeriodCap: bigint;
  readonly newPayeeCap: bigint;
  readonly policyPeriodDays: bigint;
}

/** The per-Counterparty state `_remaining` reads. */
export interface CounterpartyWindowState {
  readonly limit: bigint;
  readonly registered: boolean;
  readonly pinned: boolean;
  readonly humanSet: boolean;
  readonly humanEpoch: bigint;
}

/** The three rings of one wallet as seen by one Counterparty. */
export interface WindowRings {
  readonly counterparty: Ring;
  readonly wallet: Ring;
  readonly newPayees: Ring;
}

/** `remaining(a)`: the contract's `Remaining` struct (the `ChainView` shape). */
export interface RemainingView {
  readonly cpRemaining: bigint;
  readonly walletRemaining: bigint;
  readonly newPayeeRemaining: bigint;
  readonly limit: bigint;
  readonly pinned: boolean;
  readonly registered: boolean;
  readonly humanSet: boolean;
  readonly humanEpoch: bigint;
}

export const UNKNOWN_COUNTERPARTY: CounterpartyWindowState = Object.freeze({
  limit: 0n,
  registered: false,
  pinned: false,
  humanSet: false,
  humanEpoch: 0n,
});

/**
 * `PolicyWallet._remaining(a)` at day `today`:
 * `cpRemaining = satSub(effectiveLimit, cpWindowSum)` with `effectiveLimit = humanSet || limit <= ceiling ? limit : ceiling`,
 * `walletRemaining = satSub(walletPeriodCap, walletWindowSum)`, `newPayeeRemaining = satSub(newPayeeCap, newPayeeWindowSum)`.
 */
export function remainingView(cp: CounterpartyWindowState, rings: WindowRings, policy: WindowPolicy, today: number | bigint): RemainingView {
  const n = policy.policyPeriodDays;
  const effectiveLimit = cp.humanSet || cp.limit <= policy.firstContactCeiling ? cp.limit : policy.firstContactCeiling;
  return {
    cpRemaining: satSub(effectiveLimit, windowSum(rings.counterparty, today, n)),
    walletRemaining: satSub(policy.walletPeriodCap, windowSum(rings.wallet, today, n)),
    newPayeeRemaining: satSub(policy.newPayeeCap, windowSum(rings.newPayees, today, n)),
    limit: cp.limit,
    pinned: cp.pinned,
    registered: cp.registered,
    humanSet: cp.humanSet,
    humanEpoch: cp.humanEpoch,
  };
}
