// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {PolicyWallet} from "../src/PolicyWallet.sol";
import {Vm} from "forge-std/Vm.sol";
import {WalletFixture, ContractPayee} from "./base/WalletFixture.sol";

/// @dev Story 1.5: Human `setLimit`, the two-step `requestUnpin` / `executeUnpin` with the Rules
///      veto, and payability probes for the six new mutators.
contract HumanLimitTest is WalletFixture {
    uint256 internal constant DELAY = 24 hours;

    function setUp() public override {
        super.setUp();
        _fund(1_000_000e6);
    }

    function _setLimit(address a, uint256 l) internal {
        vm.prank(human);
        wallet.setLimit(a, l, RH);
    }

    function _pin(address a) internal {
        vm.prank(rules);
        wallet.pin(a, RH);
    }

    function _requestUnpin(address a) internal {
        vm.prank(human);
        wallet.requestUnpin(a, RH);
    }

    function _executeUnpin(address a) internal {
        vm.prank(human);
        wallet.executeUnpin(a, RH);
    }

    function _warpBy(uint256 s) internal {
        vm.warp(vm.getBlockTimestamp() + s);
    }

    // ------------------------------------------------------------------
    // setLimit
    // ------------------------------------------------------------------

    function test_setLimit_raiseAboveCeiling() public {
        uint256 l = 2_000e6;
        _register(cp, 100e6);

        vm.expectEmit(address(wallet));
        emit PolicyWallet.LimitSet(cp, 100e6, l, 1, RH);
        _setLimit(cp, l);

        PolicyWallet.Remaining memory r = wallet.remaining(cp);
        assertEq(r.limit, l);
        assertTrue(r.humanSet);
        assertEq(r.humanEpoch, 1);
        assertEq(r.cpRemaining, l);

        _pay(cp, l);
        assertEq(usdc.balanceOf(cp), l);
        vm.prank(payment);
        vm.expectRevert(PolicyWallet.LimitExceeded.selector);
        wallet.pay(cp, 1, RH);
    }

    function test_setLimit_lowerAndEpochIncrements() public {
        _register(cp, CEILING);
        _setLimit(cp, 10e6);
        _setLimit(cp, 5e6);
        PolicyWallet.Remaining memory r = wallet.remaining(cp);
        assertEq(r.limit, 5e6);
        assertEq(r.humanEpoch, 2);
    }

    function test_setLimit_registersUnregistered() public {
        for (uint256 i; i < NEW_PAYEE_CAP; ++i) {
            _register(makeAddr(string.concat("p", vm.toString(i))), 1);
        }
        uint256 l = 10_000e6;

        vm.expectEmit(address(wallet));
        emit PolicyWallet.CounterpartyRegistered(cp, l, RH);
        vm.expectEmit(address(wallet));
        emit PolicyWallet.LimitSet(cp, 0, l, 1, RH);
        _setLimit(cp, l);

        PolicyWallet.Remaining memory r = wallet.remaining(cp);
        assertTrue(r.registered);
        assertTrue(r.humanSet);
        assertEq(r.limit, l);
        assertEq(r.newPayeeRemaining, 0);
    }

    function test_setLimit_doesNotCountAgainstCap() public {
        _setLimit(cp, 1e6);
        assertEq(wallet.remaining(cp).newPayeeRemaining, NEW_PAYEE_CAP);
    }

    function test_setLimit_registersContractPayee() public {
        address c = address(new ContractPayee());
        _setLimit(c, 50e6);

        PolicyWallet.Remaining memory r = wallet.remaining(c);
        assertTrue(r.registered);
        assertTrue(r.humanSet);
        assertEq(r.limit, 50e6);

        _pay(c, 50e6);
        assertEq(usdc.balanceOf(c), 50e6);
    }

    function test_setLimit_makesRegisteredContractPayable() public {
        address c = address(new ContractPayee());
        // A contract registered by the Human then paid; before setLimit a Registrar path is impossible.
        vm.prank(registrar);
        vm.expectRevert(PolicyWallet.PayeeIsContract.selector);
        wallet.register(c, 1, RH);
        _setLimit(c, 1);
        _pay(c, 1);
    }

    function test_setLimit_pinnedReverts() public {
        _register(cp, CEILING);
        _pin(cp);
        vm.prank(human);
        vm.expectRevert(PolicyWallet.Pinned.selector);
        wallet.setLimit(cp, 1, RH);
        assertEq(wallet.remaining(cp).humanEpoch, 0);
    }

    function test_setLimit_invalidPayeeReverts() public {
        address[9] memory bad = [
            address(0),
            address(0x1),
            address(0x100),
            address(0xffff),
            address(wallet),
            USDC,
            0x1800000000000000000000000000000000000000,
            0x1800FFfFfFFFFffFfFfFFfFFfFFFfFFFFfFFFFFf,
            0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE
        ];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(human);
            vm.expectRevert(PolicyWallet.InvalidPayee.selector);
            wallet.setLimit(bad[i], 1, RH);
        }
    }

    function test_setLimit_registeredEmitsOnlyLimitSet() public {
        _register(cp, CEILING);
        vm.recordLogs();
        _setLimit(cp, 1_000e6);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], PolicyWallet.LimitSet.selector);
        assertEq(logs[0].emitter, address(wallet));
    }

    function test_setLimit_invalidPayeeCheckedBeforePinned() public {
        _pin(USDC);
        vm.prank(human);
        vm.expectRevert(PolicyWallet.InvalidPayee.selector);
        wallet.setLimit(USDC, 1, RH);
    }

    function test_setLimit_unauthorized() public {
        address[5] memory callers = [payment, registrar, model, rules, stranger];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(PolicyWallet.Unauthorized.selector);
            wallet.setLimit(cp, 1, RH);
        }
    }

    function test_setLimit_makesInFlightTightenStale() public {
        _register(cp, CEILING);
        _setLimit(cp, 800e6);

        vm.prank(model);
        vm.expectRevert(PolicyWallet.StaleEpoch.selector);
        wallet.tighten(cp, 1, 0, RH);
        assertEq(wallet.remaining(cp).limit, 800e6);
    }

    // ------------------------------------------------------------------
    // Two-step unpin
    // ------------------------------------------------------------------

    function test_unpin_happyPath() public {
        _register(cp, CEILING);
        _pin(cp);

        vm.expectEmit(address(wallet));
        emit PolicyWallet.UnpinRequested(cp, vm.getBlockTimestamp() + DELAY, RH);
        _requestUnpin(cp);

        _warpBy(DELAY);
        vm.expectEmit(address(wallet));
        emit PolicyWallet.PinReleased(cp, RH);
        _executeUnpin(cp);

        PolicyWallet.Remaining memory r = wallet.remaining(cp);
        assertFalse(r.pinned);
        assertTrue(r.registered);
        assertEq(r.limit, 0);
        assertEq(r.humanEpoch, 1);

        // The pin is gone for good: a second execute is NotPinned, and the Human can now set a limit.
        vm.prank(human);
        vm.expectRevert(PolicyWallet.NotPinned.selector);
        wallet.executeUnpin(cp, RH);
        _setLimit(cp, 10e6);
        assertEq(wallet.remaining(cp).humanEpoch, 2);
        _pay(cp, 10e6);
    }

    function test_unpin_bumpsEpochSoOldTightenIsStale() public {
        _register(cp, CEILING);
        _pin(cp);
        _requestUnpin(cp);
        _warpBy(DELAY);
        _executeUnpin(cp);

        vm.prank(model);
        vm.expectRevert(PolicyWallet.StaleEpoch.selector);
        wallet.tighten(cp, 0, 0, RH);
    }

    function test_unpin_tooEarly() public {
        _pin(cp);
        _requestUnpin(cp);
        _warpBy(DELAY - 1);
        vm.prank(human);
        vm.expectRevert(PolicyWallet.UnpinDelayPending.selector);
        wallet.executeUnpin(cp, RH);
        assertTrue(wallet.remaining(cp).pinned);
    }

    function test_unpin_vetoedByRepin() public {
        _pin(cp);
        _requestUnpin(cp);
        _warpBy(DELAY / 2);
        _pin(cp);
        _warpBy(DELAY);

        vm.prank(human);
        vm.expectRevert(PolicyWallet.UnpinNotRequested.selector);
        wallet.executeUnpin(cp, RH);
        assertTrue(wallet.remaining(cp).pinned);
    }

    /// @dev FR-19: with a compromised Rules key vetoing, the Human revokes Rules and then unpins.
    function test_unpin_escapeHatchAfterRevokingRules() public {
        _register(cp, CEILING);
        _pin(cp);
        vm.prank(human);
        wallet.revokeRole(PolicyWallet.Role.Rules, RH);

        _requestUnpin(cp);
        vm.prank(rules);
        vm.expectRevert(PolicyWallet.Unauthorized.selector);
        wallet.pin(cp, RH);

        _warpBy(DELAY);
        _executeUnpin(cp);
        PolicyWallet.Remaining memory r = wallet.remaining(cp);
        assertFalse(r.pinned);
        assertEq(r.limit, 0);
        assertEq(r.humanEpoch, 1);
    }

    function test_unpin_freshRequestAfterVeto() public {
        _pin(cp);
        _requestUnpin(cp);
        _warpBy(DELAY / 2);
        _pin(cp);

        _requestUnpin(cp);
        _warpBy(DELAY - 1);
        vm.prank(human);
        vm.expectRevert(PolicyWallet.UnpinDelayPending.selector);
        wallet.executeUnpin(cp, RH);

        _warpBy(1);
        _executeUnpin(cp);
        assertFalse(wallet.remaining(cp).pinned);
    }

    function test_unpin_notRequested() public {
        _pin(cp);
        _warpBy(DELAY);
        vm.prank(human);
        vm.expectRevert(PolicyWallet.UnpinNotRequested.selector);
        wallet.executeUnpin(cp, RH);
    }

    function test_unpin_notPinned() public {
        _register(cp, CEILING);
        vm.startPrank(human);
        vm.expectRevert(PolicyWallet.NotPinned.selector);
        wallet.requestUnpin(cp, RH);
        vm.expectRevert(PolicyWallet.NotPinned.selector);
        wallet.executeUnpin(cp, RH);
        vm.stopPrank();
    }

    function test_unpin_repeatRequestRestartsTimer() public {
        _pin(cp);
        _requestUnpin(cp);
        _warpBy(DELAY - 10);
        _requestUnpin(cp);
        _warpBy(10);

        vm.prank(human);
        vm.expectRevert(PolicyWallet.UnpinDelayPending.selector);
        wallet.executeUnpin(cp, RH);

        _warpBy(DELAY - 10);
        _executeUnpin(cp);
        assertFalse(wallet.remaining(cp).pinned);
    }

    function test_unpin_usesCurrentDelay() public {
        _pin(cp);
        _requestUnpin(cp);
        vm.prank(human);
        wallet.setUnpinDelay(2 * DELAY, RH);
        _warpBy(DELAY);

        vm.prank(human);
        vm.expectRevert(PolicyWallet.UnpinDelayPending.selector);
        wallet.executeUnpin(cp, RH);

        _warpBy(DELAY);
        _executeUnpin(cp);
        assertFalse(wallet.remaining(cp).pinned);
    }

    function test_unpin_hugeDelayNoOverflow() public {
        vm.prank(human);
        wallet.setUnpinDelay(type(uint256).max, RH);
        _pin(cp);

        vm.expectEmit(address(wallet));
        emit PolicyWallet.UnpinRequested(cp, type(uint256).max, RH);
        _requestUnpin(cp);

        _warpBy(365 days * 100);
        vm.prank(human);
        vm.expectRevert(PolicyWallet.UnpinDelayPending.selector);
        wallet.executeUnpin(cp, RH);
    }

    function test_unpin_unauthorized() public {
        _pin(cp);
        address[5] memory callers = [payment, registrar, model, rules, stranger];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(PolicyWallet.Unauthorized.selector);
            wallet.requestUnpin(cp, RH);
        }
        _requestUnpin(cp);
        _warpBy(DELAY);
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(PolicyWallet.Unauthorized.selector);
            wallet.executeUnpin(cp, RH);
        }
        assertTrue(wallet.remaining(cp).pinned);
    }

    function testFuzz_unpin_delayBoundary(uint256 delay, uint256 elapsed) public {
        delay = bound(delay, 1 hours, 365 days);
        elapsed = bound(elapsed, 0, 2 * delay);
        vm.prank(human);
        wallet.setUnpinDelay(delay, RH);
        _pin(cp);
        _requestUnpin(cp);
        _warpBy(elapsed);

        vm.prank(human);
        if (elapsed < delay) {
            vm.expectRevert(PolicyWallet.UnpinDelayPending.selector);
            wallet.executeUnpin(cp, RH);
            assertTrue(wallet.remaining(cp).pinned);
        } else {
            wallet.executeUnpin(cp, RH);
            assertFalse(wallet.remaining(cp).pinned);
            assertEq(wallet.remaining(cp).limit, 0);
        }
    }

    // ------------------------------------------------------------------
    // Payability probes for the six new mutators
    // ------------------------------------------------------------------

    function test_payableProbe_story15MutatorsNotPayable() public {
        _register(cp, CEILING);
        vm.deal(model, 1 ether);
        vm.deal(rules, 1 ether);
        vm.deal(human, 1 ether);
        bool ok;

        vm.prank(model);
        (ok,) = address(wallet).call{value: 1}(abi.encodeCall(PolicyWallet.tighten, (cp, 1, 0, RH)));
        assertFalse(ok);

        vm.prank(rules);
        (ok,) = address(wallet).call{value: 1}(abi.encodeCall(PolicyWallet.pin, (cp, RH)));
        assertFalse(ok);

        vm.prank(human);
        (ok,) = address(wallet).call{value: 1}(abi.encodeCall(PolicyWallet.setLimit, (cp, 1, RH)));
        assertFalse(ok);

        // Same calls without value succeed, so the failures above are due to value.
        vm.prank(model);
        wallet.tighten(cp, 1, 0, RH);
        vm.prank(human);
        wallet.setLimit(cp, 1, RH);
        _pin(cp);

        vm.prank(rules);
        (ok,) = address(wallet).call{value: 1}(abi.encodeCall(PolicyWallet.releasePin, (cp, RH)));
        assertFalse(ok);

        vm.prank(human);
        (ok,) = address(wallet).call{value: 1}(abi.encodeCall(PolicyWallet.requestUnpin, (cp, RH)));
        assertFalse(ok);
        _requestUnpin(cp);
        _warpBy(DELAY);

        vm.prank(human);
        (ok,) = address(wallet).call{value: 1}(abi.encodeCall(PolicyWallet.executeUnpin, (cp, RH)));
        assertFalse(ok);

        _executeUnpin(cp);
        assertFalse(wallet.remaining(cp).pinned);

        _pin(cp);
        vm.prank(rules);
        wallet.releasePin(cp, RH);
        assertEq(address(wallet).balance, 0);
    }
}
