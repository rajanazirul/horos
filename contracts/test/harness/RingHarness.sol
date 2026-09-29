// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {RollingWindow} from "../../src/lib/RollingWindow.sol";

/// @dev Test-only holder of one bare ring, driving the real RollingWindow library.
contract RingHarness {
    RollingWindow.Ring internal _ring;

    function clear() external {
        delete _ring;
    }

    function setSlot(uint32 dayIndex, uint224 amount) external {
        _ring.slots[dayIndex % RollingWindow.RING_SIZE] = RollingWindow.Slot(dayIndex, amount);
    }

    function record(uint256 today, uint256 amount) external {
        RollingWindow.record(_ring, today, amount);
    }

    function windowSum(uint256 today, uint256 n) external view returns (uint256) {
        return RollingWindow.windowSum(_ring, today, n);
    }

    function slot(uint256 index) external view returns (uint32, uint224) {
        RollingWindow.Slot memory s = _ring.slots[index];
        return (s.dayIndex, s.amount);
    }

    /// @dev Straightforward reference: full 91-slot scan with the spec's range test (Design Notes).
    function referenceSum(uint256 today, uint256 n) external view returns (uint256 s) {
        uint256 lo = today > n ? today - n : 0;
        for (uint256 i; i < RollingWindow.RING_SIZE; ++i) {
            RollingWindow.Slot memory x = _ring.slots[i];
            if (x.dayIndex >= lo && x.dayIndex <= today) s += x.amount;
        }
    }
}
