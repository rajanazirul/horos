// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

/// @title RollingWindow
/// @notice Day-tagged bucket ring (AD-7) used for every rolling budget in the PolicyWallet:
///         per-Counterparty spend, wallet spend and the new-payee count.
/// @dev A ring has `RING_SIZE = MAX_WINDOW_DAYS + 1` slots of `(uint32 dayIndex, uint224 amount)`,
///      indexed by `dayIndex % RING_SIZE`, where `today = block.timestamp / 1 days`.
///      The widest window `[today - 90, today]` spans exactly 91 days, so every counted day has
///      its own slot and a slot is reused only after its day has left every possible window.
///      Invariant maintained by `record`: a slot at index `i` always has `dayIndex % RING_SIZE == i`
///      (or is the untouched zero slot, which adds 0). `windowSum` relies on it.
///      All arithmetic saturates; `windowSum` and `satSub` never revert.
library RollingWindow {
    /// @notice Widest supported window, in days (equals the PolicyWallet's MAX_POLICY_PERIOD_DAYS).
    uint256 internal constant MAX_WINDOW_DAYS = 90;

    /// @notice Number of slots in a ring.
    uint256 internal constant RING_SIZE = MAX_WINDOW_DAYS + 1;

    /// @notice One day bucket. Packs into a single storage word.
    struct Slot {
        uint32 dayIndex;
        uint224 amount;
    }

    /// @notice A fixed ring of day buckets.
    struct Ring {
        Slot[RING_SIZE] slots;
    }

    /// @notice `today` does not fit the uint32 day tag (after year 11,000,000 AD). Recording would
    ///         otherwise truncate the tag and silently drop the amount from every window.
    error DayIndexOverflow();

    /// @notice Add `amount` to the bucket for `today`.
    /// @dev Overwrites the slot if it holds another day, otherwise adds; saturates at `type(uint224).max`.
    /// @param r Ring to write.
    /// @param today Current day index (`block.timestamp / 1 days`).
    /// @param amount Amount to add (6-dp base units, or a count).
    function record(Ring storage r, uint256 today, uint256 amount) internal {
        if (today > type(uint32).max) revert DayIndexOverflow();
        Slot storage s = r.slots[today % RING_SIZE];
        // forge-lint: disable-next-line(unsafe-typecast) -- bounded by the uint32 check above
        uint32 day = uint32(today);
        uint256 max = type(uint224).max;
        uint256 next;
        if (s.dayIndex != day) {
            next = amount > max ? max : amount;
        } else {
            uint256 cur = s.amount;
            next = amount >= max - cur ? max : cur + amount;
        }
        s.dayIndex = day;
        // forge-lint: disable-next-line(unsafe-typecast) -- next <= type(uint224).max by construction
        s.amount = uint224(next);
    }

    /// @notice Sum of every slot whose `dayIndex` lies in `[today - n, today]` (lower bound floored at 0).
    /// @dev Never reverts. `n` is clamped to `MAX_WINDOW_DAYS` because the ring holds no older data.
    ///      Visits only the `n + 1` in-window days (one storage read each) instead of all 91 slots;
    ///      thanks to the index invariant this equals a full scan with the range test. Slots with a
    ///      future `dayIndex` never match an in-window day, so they never count.
    ///      The sum is at most 91 * (2^224 - 1) < 2^256, so it cannot overflow.
    /// @param r Ring to read.
    /// @param today Current day index.
    /// @param n Window length in days (the Policy Period).
    /// @return s The window sum.
    function windowSum(Ring storage r, uint256 today, uint256 n) internal view returns (uint256 s) {
        if (n > MAX_WINDOW_DAYS) n = MAX_WINDOW_DAYS;
        uint256 lo = today > n ? today - n : 0;
        uint256 count = today - lo + 1; // n + 1 (or today + 1 when today < n), so 1..91
        uint256 d = lo;
        for (uint256 k; k < count; ++k) {
            Slot memory x = r.slots[d % RING_SIZE];
            if (x.dayIndex == d) s += x.amount;
            unchecked {
                ++d;
            }
        }
    }

    /// @notice Saturating subtraction: `a - b`, or 0 if `b >= a`.
    /// @param a Minuend.
    /// @param b Subtrahend.
    /// @return The saturated difference.
    function satSub(uint256 a, uint256 b) internal pure returns (uint256) {
        unchecked {
            return a > b ? a - b : 0;
        }
    }
}
