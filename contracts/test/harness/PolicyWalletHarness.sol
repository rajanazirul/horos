// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {PolicyWallet} from "../../src/PolicyWallet.sol";
import {RollingWindow} from "../../src/lib/RollingWindow.sol";

/// @dev Test-only subclass exposing the internal Story 1.3 hooks. Never deployed.
contract PolicyWalletHarness is PolicyWallet {
    constructor(Roles memory roles, Policy memory policy_, bool roleIsContract_)
        PolicyWallet(roles, policy_, roleIsContract_)
    {}

    function exposedRecordSpend(address a, uint256 amount) external {
        _recordSpend(a, amount);
    }

    function exposedRecordNewPayee() external {
        _recordNewPayee();
    }

    function rawCounterparty(address a) external view returns (Counterparty memory) {
        return _counterparties[a];
    }

    function rawSetCounterparty(address a, Counterparty calldata c) external {
        _counterparties[a] = c;
    }

    /// @dev Write a slot at its canonical index `dayIndex % RING_SIZE` (the invariant `record` keeps).
    function rawSetCpSlot(address a, uint32 dayIndex, uint224 amount) external {
        _cpSpend[a].slots[dayIndex % RollingWindow.RING_SIZE] = RollingWindow.Slot(dayIndex, amount);
    }

    function rawSetWalletSlot(uint32 dayIndex, uint224 amount) external {
        _walletSpend.slots[dayIndex % RollingWindow.RING_SIZE] = RollingWindow.Slot(dayIndex, amount);
    }

    function rawSetNewPayeeSlot(uint32 dayIndex, uint224 amount) external {
        _newPayees.slots[dayIndex % RollingWindow.RING_SIZE] = RollingWindow.Slot(dayIndex, amount);
    }

    function cpSlot(address a, uint256 index) external view returns (uint32, uint224) {
        RollingWindow.Slot memory s = _cpSpend[a].slots[index];
        return (s.dayIndex, s.amount);
    }

    function newPayeeSlot(uint256 index) external view returns (uint32, uint224) {
        RollingWindow.Slot memory s = _newPayees.slots[index];
        return (s.dayIndex, s.amount);
    }

    function walletSlot(uint256 index) external view returns (uint32, uint224) {
        RollingWindow.Slot memory s = _walletSpend.slots[index];
        return (s.dayIndex, s.amount);
    }
}
