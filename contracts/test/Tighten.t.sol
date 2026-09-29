// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {PolicyWallet} from "../src/PolicyWallet.sol";
import {Vm} from "forge-std/Vm.sol";
import {PolicyWalletHarness} from "./harness/PolicyWalletHarness.sol";
import {WalletFixture, ContractPayee} from "./base/WalletFixture.sol";

/// @dev Story 1.5: Model/Rules `tighten`, Rules `pin` / `releasePin`, and the only-tighten fuzz.
contract TightenTest is WalletFixture {
    function _tighten(address caller, address a, uint256 l, uint256 epoch) internal {
        vm.prank(caller);
        wallet.tighten(a, l, epoch, RH);
    }

    function _pin(address a) internal {
        vm.prank(rules);
        wallet.pin(a, RH);
    }

    function _setLimit(address a, uint256 l) internal {
        vm.prank(human);
        wallet.setLimit(a, l, RH);
    }

    // ------------------------------------------------------------------
    // tighten
    // ------------------------------------------------------------------

    function test_tighten_lowerByModel() public {
        _register(cp, CEILING);
        vm.expectEmit(address(wallet));
        emit PolicyWallet.LimitTightened(cp, CEILING, 200e6, RH);
        _tighten(model, cp, 200e6, 0);

        PolicyWallet.Remaining memory r = wallet.remaining(cp);
        assertEq(r.limit, 200e6);
        assertEq(r.cpRemaining, 200e6);
        assertEq(r.humanEpoch, 0);
        assertFalse(r.humanSet);
        assertTrue(r.registered);
    }

    function test_tighten_lowerByRules() public {
        _register(cp, CEILING);
        _tighten(rules, cp, 1, 0);
        assertEq(wallet.remaining(cp).limit, 1);
    }

    function test_tighten_looserKeepsLimitAndEmits() public {
        _register(cp, CEILING);
        _tighten(model, cp, 200e6, 0);

        vm.expectEmit(address(wallet));
        emit PolicyWallet.LimitTightened(cp, 200e6, 200e6, RH);
        _tighten(rules, cp, 900e6, 0);
        assertEq(wallet.remaining(cp).limit, 200e6);
    }

    function test_tighten_equalEmitsUnchanged() public {
        _register(cp, CEILING);
        vm.expectEmit(address(wallet));
        emit PolicyWallet.LimitTightened(cp, CEILING, CEILING, RH);
        _tighten(model, cp, CEILING, 0);
        assertEq(wallet.remaining(cp).limit, CEILING);
    }

    function test_tighten_toZero() public {
        _register(cp, CEILING);
        _tighten(model, cp, 0, 0);
        PolicyWallet.Remaining memory r = wallet.remaining(cp);
        assertEq(r.limit, 0);
        assertTrue(r.registered);
        assertFalse(r.pinned);
    }

    function test_tighten_unregisteredStaysUnregistered() public {
        vm.expectEmit(address(wallet));
        emit PolicyWallet.LimitTightened(cp, 0, 0, RH);
        _tighten(model, cp, 1_000e6, 0);

        PolicyWallet.Remaining memory r = wallet.remaining(cp);
        assertFalse(r.registered);
        assertEq(r.limit, 0);
        assertEq(r.newPayeeRemaining, NEW_PAYEE_CAP);
    }

    function test_tighten_pinnedStaysZero() public {
        _register(cp, CEILING);
        _pin(cp);
        _tighten(model, cp, CEILING, 0);
        PolicyWallet.Remaining memory r = wallet.remaining(cp);
        assertEq(r.limit, 0);
        assertTrue(r.pinned);
    }

    function test_tighten_humanSetLimitAboveCeiling() public {
        _register(cp, CEILING);
        _setLimit(cp, 2_000e6);
        _tighten(model, cp, 1_000e6, 1);
        PolicyWallet.Remaining memory r = wallet.remaining(cp);
        assertEq(r.limit, 1_000e6);
        assertTrue(r.humanSet);
        assertEq(r.humanEpoch, 1);
    }

    function test_tighten_staleEpochReverts() public {
        _register(cp, CEILING);
        _setLimit(cp, CEILING);

        vm.prank(model);
        vm.expectRevert(PolicyWallet.StaleEpoch.selector);
        wallet.tighten(cp, 1, 0, RH);
        assertEq(wallet.remaining(cp).limit, CEILING);

        vm.prank(rules);
        vm.expectRevert(PolicyWallet.StaleEpoch.selector);
        wallet.tighten(cp, 1, 2, RH);
        assertEq(wallet.remaining(cp).limit, CEILING);
    }

    function test_tighten_futureEpochReverts() public {
        _register(cp, CEILING);
        vm.prank(model);
        vm.expectRevert(PolicyWallet.StaleEpoch.selector);
        wallet.tighten(cp, 1, 1, RH);
    }

    function test_tighten_epochAboveUint64Reverts() public {
        _register(cp, CEILING);
        vm.prank(model);
        vm.expectRevert(PolicyWallet.StaleEpoch.selector);
        wallet.tighten(cp, 1, uint256(type(uint64).max) + 1, RH);
    }

    function test_tighten_unauthorized() public {
        _register(cp, CEILING);
        address[4] memory callers = [payment, registrar, human, stranger];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(PolicyWallet.Unauthorized.selector);
            wallet.tighten(cp, 1, 0, RH);
        }
        assertEq(wallet.remaining(cp).limit, CEILING);
    }

    function test_tighten_revokedModelUnauthorized() public {
        _register(cp, CEILING);
        vm.prank(human);
        wallet.revokeRole(PolicyWallet.Role.Model, RH);

        vm.prank(model);
        vm.expectRevert(PolicyWallet.Unauthorized.selector);
        wallet.tighten(cp, 1, 0, RH);

        // Rules still works with Model vacant.
        _tighten(rules, cp, 1, 0);
        assertEq(wallet.remaining(cp).limit, 1);
    }

    function test_tighten_revokedRulesUnauthorized() public {
        _register(cp, CEILING);
        vm.prank(human);
        wallet.revokeRole(PolicyWallet.Role.Rules, RH);

        vm.prank(rules);
        vm.expectRevert(PolicyWallet.Unauthorized.selector);
        wallet.tighten(cp, 1, 0, RH);

        _tighten(model, cp, 2, 0);
        assertEq(wallet.remaining(cp).limit, 2);
    }

    function test_tighten_roleIsContractAllowsContractHolders() public {
        wallet = new PolicyWalletHarness(
            PolicyWallet.Roles({human: human, payment: payment, registrar: registrar, model: model, rules: rules}),
            _preset(),
            true
        );
        _register(cp, CEILING);
        vm.etch(model, hex"00");
        vm.etch(rules, hex"00");

        _tighten(model, cp, 300e6, 0);
        assertEq(wallet.remaining(cp).limit, 300e6);
        _tighten(rules, cp, 100e6, 0);
        assertEq(wallet.remaining(cp).limit, 100e6);
    }

    function test_tighten_rulesWithCodeUnauthorized() public {
        _register(cp, CEILING);
        vm.etch(rules, hex"00");
        vm.prank(rules);
        vm.expectRevert(PolicyWallet.Unauthorized.selector);
        wallet.tighten(cp, 1, 0, RH);
        assertEq(wallet.remaining(cp).limit, CEILING);
    }

    function test_tighten_bothRevokedUnauthorized() public {
        _register(cp, CEILING);
        vm.startPrank(human);
        wallet.revokeRole(PolicyWallet.Role.Model, RH);
        wallet.revokeRole(PolicyWallet.Role.Rules, RH);
        vm.stopPrank();

        address[2] memory former = [model, rules];
        for (uint256 i; i < former.length; ++i) {
            vm.prank(former[i]);
            vm.expectRevert(PolicyWallet.Unauthorized.selector);
            wallet.tighten(cp, 1, 0, RH);
        }
        assertEq(wallet.remaining(cp).limit, CEILING);
    }

    function test_tighten_belowSpentSaturatesRemaining() public {
        _fund(1_000e6);
        _register(cp, CEILING);
        _pay(cp, 300e6);
        _tighten(model, cp, 100e6, 0);

        PolicyWallet.Remaining memory r = wallet.remaining(cp);
        assertEq(r.limit, 100e6);
        assertEq(r.cpRemaining, 0);

        vm.prank(payment);
        vm.expectRevert(PolicyWallet.LimitExceeded.selector);
        wallet.pay(cp, 1, RH);
    }

    function test_tighten_callerWithCodeUnauthorized() public {
        _register(cp, CEILING);
        vm.etch(model, hex"00");
        vm.prank(model);
        vm.expectRevert(PolicyWallet.Unauthorized.selector);
        wallet.tighten(cp, 1, 0, RH);
    }

    // ------------------------------------------------------------------
    // pin
    // ------------------------------------------------------------------

    function test_pin_registered() public {
        _fund(1_000e6);
        _register(cp, CEILING);

        vm.expectEmit(address(wallet));
        emit PolicyWallet.CounterpartyPinned(cp, RH);
        _pin(cp);

        PolicyWallet.Remaining memory r = wallet.remaining(cp);
        assertTrue(r.pinned);
        assertTrue(r.registered);
        assertEq(r.limit, 0);
        assertEq(r.cpRemaining, 0);
        assertEq(r.humanEpoch, 0);

        vm.prank(payment);
        vm.expectRevert(PolicyWallet.Pinned.selector);
        wallet.pay(cp, 1, RH);

        vm.prank(registrar);
        vm.expectRevert(PolicyWallet.Pinned.selector);
        wallet.register(cp, 1, RH);
    }

    function test_pin_unregisteredWithCapExhausted() public {
        for (uint256 i; i < NEW_PAYEE_CAP; ++i) {
            _register(makeAddr(string.concat("p", vm.toString(i))), 1);
        }
        assertEq(wallet.remaining(cp).newPayeeRemaining, 0);

        vm.expectEmit(address(wallet));
        emit PolicyWallet.CounterpartyRegistered(cp, 0, RH);
        vm.expectEmit(address(wallet));
        emit PolicyWallet.CounterpartyPinned(cp, RH);
        _pin(cp);

        PolicyWallet.Remaining memory r = wallet.remaining(cp);
        assertTrue(r.registered);
        assertTrue(r.pinned);
        assertEq(r.limit, 0);
        assertEq(r.newPayeeRemaining, 0);
    }

    function test_pin_unregisteredDoesNotCountAgainstCap() public {
        _pin(cp);
        assertEq(wallet.remaining(cp).newPayeeRemaining, NEW_PAYEE_CAP);
    }

    function test_pin_contractAndInvalidPayeesPinnable() public {
        address c = address(new ContractPayee());
        _pin(c);
        assertTrue(wallet.remaining(c).pinned);
        _pin(USDC);
        assertTrue(wallet.remaining(USDC).pinned);
        _pin(address(0));
        assertTrue(wallet.remaining(address(0)).pinned);
    }

    function test_pin_ignoresEpoch() public {
        _register(cp, CEILING);
        _setLimit(cp, 1);
        _setLimit(cp, 2);
        _setLimit(cp, 3);
        assertEq(wallet.remaining(cp).humanEpoch, 3);

        _pin(cp);
        PolicyWallet.Remaining memory r = wallet.remaining(cp);
        assertTrue(r.pinned);
        assertEq(r.limit, 0);
        assertEq(r.humanEpoch, 3);
        assertTrue(r.humanSet);
    }

    function test_pin_repinEmits() public {
        _register(cp, CEILING);
        _pin(cp);
        vm.recordLogs();
        _pin(cp);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], PolicyWallet.CounterpartyPinned.selector);
        assertEq(logs[0].emitter, address(wallet));
        assertTrue(wallet.remaining(cp).pinned);
    }

    function test_pin_unauthorized() public {
        address[5] memory callers = [payment, registrar, model, human, stranger];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(PolicyWallet.Unauthorized.selector);
            wallet.pin(cp, RH);
        }
    }

    // ------------------------------------------------------------------
    // releasePin
    // ------------------------------------------------------------------

    function test_releasePin() public {
        _register(cp, CEILING);
        _setLimit(cp, CEILING);
        _pin(cp);

        vm.expectEmit(address(wallet));
        emit PolicyWallet.PinReleased(cp, RH);
        vm.prank(rules);
        wallet.releasePin(cp, RH);

        PolicyWallet.Remaining memory r = wallet.remaining(cp);
        assertFalse(r.pinned);
        assertTrue(r.registered);
        assertEq(r.limit, 0);
        assertEq(r.humanEpoch, 1);

        vm.prank(rules);
        vm.expectRevert(PolicyWallet.NotPinned.selector);
        wallet.releasePin(cp, RH);
    }

    function test_releasePin_notPinned() public {
        vm.prank(rules);
        vm.expectRevert(PolicyWallet.NotPinned.selector);
        wallet.releasePin(cp, RH);
    }

    function test_releasePin_clearsUnpinRequest() public {
        _pin(cp);
        vm.prank(human);
        wallet.requestUnpin(cp, RH);
        assertEq(wallet.rawCounterparty(cp).unpinRequestedAt, vm.getBlockTimestamp());

        vm.prank(rules);
        wallet.releasePin(cp, RH);
        assertEq(wallet.rawCounterparty(cp).unpinRequestedAt, 0);
        assertFalse(wallet.rawCounterparty(cp).pinned);
    }

    function test_releasePin_contractStaysUnpayable() public {
        _fund(1_000e6);
        address c = address(new ContractPayee());
        _pin(c);
        vm.prank(rules);
        wallet.releasePin(c, RH);

        PolicyWallet.Remaining memory r = wallet.remaining(c);
        assertTrue(r.registered);
        assertFalse(r.pinned);
        assertEq(r.limit, 0);

        vm.prank(payment);
        vm.expectRevert(PolicyWallet.PayeeIsContract.selector);
        wallet.pay(c, 1, RH);
        vm.prank(registrar);
        vm.expectRevert(PolicyWallet.AlreadyRegistered.selector);
        wallet.register(c, 1, RH);
    }

    /// @dev Hold after a false positive: a released pin leaves the EOA Registered at 0, and only the
    ///      Human can restore a limit.
    function test_releasePin_unregisteredEoaNeedsHuman() public {
        _fund(1_000e6);
        _pin(cp);
        vm.prank(rules);
        wallet.releasePin(cp, RH);

        PolicyWallet.Remaining memory r = wallet.remaining(cp);
        assertTrue(r.registered);
        assertFalse(r.pinned);
        assertEq(r.limit, 0);

        vm.prank(registrar);
        vm.expectRevert(PolicyWallet.AlreadyRegistered.selector);
        wallet.register(cp, 1, RH);
        vm.prank(payment);
        vm.expectRevert(PolicyWallet.LimitExceeded.selector);
        wallet.pay(cp, 1, RH);

        _setLimit(cp, 10e6);
        _pay(cp, 10e6);
        assertEq(usdc.balanceOf(cp), 10e6);
    }

    function test_releasePin_unauthorized() public {
        _pin(cp);
        address[5] memory callers = [payment, registrar, model, human, stranger];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(PolicyWallet.Unauthorized.selector);
            wallet.releasePin(cp, RH);
        }
        assertTrue(wallet.remaining(cp).pinned);
    }

    // ------------------------------------------------------------------
    // Only-tighten fuzz: Model/Rules sequences never raise, pinned => 0, epoch fixed
    // ------------------------------------------------------------------

    function testFuzz_onlyTighten_sequences(
        uint256 startLimit,
        bool humanSetStart,
        uint8[] calldata ops,
        uint256[] calldata vals
    ) public {
        startLimit = bound(startLimit, 0, type(uint128).max);
        if (humanSetStart) {
            _setLimit(cp, startLimit);
        } else {
            _register(cp, bound(startLimit, 0, CEILING));
        }

        PolicyWallet.Remaining memory before = wallet.remaining(cp);
        uint256 n = ops.length < 32 ? ops.length : 32;
        for (uint256 i; i < n; ++i) {
            uint256 v = i < vals.length ? vals[i] : i;
            (bool tightened, bool pinned) = _fuzzStep(ops[i], v, i, before.humanEpoch);
            before = _checkStep(before, v, tightened, pinned);
        }
    }

    /// @dev Bits 0-2 of `opByte` pick the op, bit 3 the caller, bit 4 current vs random epoch;
    ///      `v` (limit / warp) is independent of all three.
    function _fuzzStep(uint8 opByte, uint256 v, uint256 i, uint256 epoch)
        internal
        returns (bool tightened, bool pinned)
    {
        uint8 op = opByte % 6;
        bool second = (opByte >> 3) & 1 == 1;
        address caller = second ? rules : model;
        bool ok;
        if (op == 0) {
            vm.prank(caller);
            (ok,) = address(wallet).call(abi.encodeCall(PolicyWallet.tighten, (cp, v, epoch, RH)));
            assertTrue(ok, "tighten with current epoch must not revert");
            tightened = true;
        } else if (op == 1) {
            uint256 e = (opByte >> 4) & 1 == 1 ? epoch : uint256(keccak256(abi.encode(v, i)));
            vm.prank(caller);
            (ok,) = address(wallet).call(abi.encodeCall(PolicyWallet.tighten, (cp, v, e, RH)));
            assertEq(ok, e == epoch, "tighten succeeds only for the current epoch");
            tightened = ok;
        } else if (op == 2) {
            vm.prank(caller);
            (ok,) = address(wallet).call(abi.encodeCall(PolicyWallet.pin, (cp, RH)));
            assertEq(ok, caller == rules);
            pinned = ok;
        } else if (op == 3) {
            bool wasPinned = wallet.remaining(cp).pinned;
            vm.prank(caller);
            (ok,) = address(wallet).call(abi.encodeCall(PolicyWallet.releasePin, (cp, RH)));
            assertEq(ok, caller == rules && wasPinned);
        } else if (op == 4) {
            // Non-Model/Rules automated keys cannot write at all.
            vm.prank(second ? registrar : payment);
            (ok,) = address(wallet).call(abi.encodeCall(PolicyWallet.tighten, (cp, v, epoch, RH)));
            assertFalse(ok);
        } else {
            vm.warp(vm.getBlockTimestamp() + (v % 3 days));
        }
    }

    function _checkStep(PolicyWallet.Remaining memory before, uint256 v, bool tightened, bool pinned)
        internal
        view
        returns (PolicyWallet.Remaining memory r)
    {
        r = wallet.remaining(cp);
        assertLe(r.limit, before.limit, "limit increased");
        if (tightened) assertEq(r.limit, v < before.limit ? v : before.limit, "tighten != min");
        if (pinned) assertEq(r.limit, 0, "pin did not zero");
        if (!tightened && !pinned) assertEq(r.limit, before.limit, "limit changed without a write");
        if (r.pinned) assertEq(r.limit, 0, "pinned but limit != 0");
        uint256 eff = (before.humanSet || r.limit <= CEILING) ? r.limit : CEILING;
        assertEq(r.cpRemaining, eff, "cpRemaining != effective limit");
        assertEq(r.humanEpoch, before.humanEpoch, "epoch changed");
        assertEq(r.humanSet, before.humanSet, "humanSet changed");
        assertTrue(r.registered);
    }
}
