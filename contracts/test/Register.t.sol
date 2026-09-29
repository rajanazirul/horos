// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {console} from "forge-std/Test.sol";
import {PolicyWallet} from "../src/PolicyWallet.sol";
import {RollingWindow} from "../src/lib/RollingWindow.sol";
import {WalletFixture, ContractPayee} from "./base/WalletFixture.sol";

contract RegisterTest is WalletFixture {
    // ------------------------------------------------------------------
    // Success
    // ------------------------------------------------------------------

    function test_register_atCeiling() public {
        vm.expectEmit(address(wallet));
        emit PolicyWallet.CounterpartyRegistered(cp, CEILING, RH);
        _register(cp, CEILING);

        PolicyWallet.Remaining memory r = wallet.remaining(cp);
        assertTrue(r.registered);
        assertFalse(r.pinned);
        assertFalse(r.humanSet);
        assertEq(r.limit, CEILING);
        assertEq(r.cpRemaining, CEILING);
        assertEq(r.newPayeeRemaining, NEW_PAYEE_CAP - 1);
        assertEq(r.walletRemaining, WALLET_CAP);
    }

    function test_register_zeroDoesNotCountAgainstCap() public {
        _register(cp, 0);
        PolicyWallet.Remaining memory r = wallet.remaining(cp);
        assertTrue(r.registered);
        assertEq(r.limit, 0);
        assertEq(r.newPayeeRemaining, NEW_PAYEE_CAP);
    }

    function test_register_zeroSucceedsWithCapExhausted() public {
        for (uint256 i; i < NEW_PAYEE_CAP; ++i) {
            _register(makeAddr(string.concat("p", vm.toString(i))), 1);
        }
        assertEq(wallet.remaining(cp).newPayeeRemaining, 0);

        vm.expectEmit(address(wallet));
        emit PolicyWallet.CounterpartyRegistered(cp, 0, RH);
        _register(cp, 0);
        assertTrue(wallet.remaining(cp).registered);
        assertEq(wallet.remaining(cp).newPayeeRemaining, 0);
    }

    function test_register_capRecoversAfterWindow() public {
        for (uint256 i; i < NEW_PAYEE_CAP; ++i) {
            _register(makeAddr(string.concat("p", vm.toString(i))), 1);
        }
        vm.warp(vm.getBlockTimestamp() + (PERIOD + 1) * 1 days);
        _register(cp, 1);
        assertEq(wallet.remaining(cp).newPayeeRemaining, NEW_PAYEE_CAP - 1);
    }

    function test_register_boundaryAddressesValid() public {
        address[3] memory ok = [
            address(0x10000),
            address(0x17FFffFfFfffFFfFFfFfFFFfFffFFffFfFFFfFFf),
            address(0x1801000000000000000000000000000000000000)
        ];
        for (uint256 i; i < ok.length; ++i) {
            _register(ok[i], 1);
            assertTrue(wallet.remaining(ok[i]).registered);
        }
    }

    // ------------------------------------------------------------------
    // Errors, one per row
    // ------------------------------------------------------------------

    function test_register_alreadyRegistered() public {
        _register(cp, 1);
        vm.prank(registrar);
        vm.expectRevert(PolicyWallet.AlreadyRegistered.selector);
        wallet.register(cp, 1, RH);
    }

    function test_register_pinned() public {
        wallet.rawSetCounterparty(cp, _cp(0, true, false));
        vm.prank(registrar);
        vm.expectRevert(PolicyWallet.Pinned.selector);
        wallet.register(cp, 1, RH);
    }

    function test_register_registrarCannotRaiseZeroRegistration() public {
        _register(cp, 0);
        vm.prank(registrar);
        vm.expectRevert(PolicyWallet.AlreadyRegistered.selector);
        wallet.register(cp, CEILING, RH);
        assertEq(wallet.remaining(cp).limit, 0);
    }

    function test_register_ceilingPlusOne() public {
        vm.prank(registrar);
        vm.expectRevert(PolicyWallet.CeilingExceeded.selector);
        wallet.register(cp, CEILING + 1, RH);
    }

    function test_register_capUsedUp() public {
        for (uint256 i; i < NEW_PAYEE_CAP; ++i) {
            _register(makeAddr(string.concat("p", vm.toString(i))), 1);
        }
        vm.prank(registrar);
        vm.expectRevert(PolicyWallet.NewPayeeCapReached.selector);
        wallet.register(cp, 1, RH);
    }

    function test_register_capZeroPolicy() public {
        vm.prank(human);
        wallet.setNewPayeeCap(0, RH);
        vm.prank(registrar);
        vm.expectRevert(PolicyWallet.NewPayeeCapReached.selector);
        wallet.register(cp, 1, RH);
        _register(cp, 0);
    }

    function test_register_payeeWithCode() public {
        address c = address(new ContractPayee());
        vm.prank(registrar);
        vm.expectRevert(PolicyWallet.PayeeIsContract.selector);
        wallet.register(c, 1, RH);
    }

    function test_register_invalidPayeeClasses() public {
        address[12] memory bad = [
            address(0),
            address(wallet),
            USDC,
            address(0x1),
            address(0x9),
            address(0x100), // P256
            address(0xffff),
            address(0x1800000000000000000000000000000000000000), // NativeCoinAuthority
            address(0x1800000000000000000000000000000000000001),
            address(0x1800FFfFfFFFFffFfFfFFfFFfFFFfFFFFfFFFFFf),
            address(0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE), // EIP system address
            address(0x18000000000000000000000000000000000000Ff)
        ];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(registrar);
            vm.expectRevert(PolicyWallet.InvalidPayee.selector);
            wallet.register(bad[i], 0, RH);
        }
    }

    // ------------------------------------------------------------------
    // Check order when two failures coincide
    // ------------------------------------------------------------------

    function test_order_invalidBeforePinned() public {
        wallet.rawSetCounterparty(address(0x100), _cp(0, true, false));
        vm.prank(registrar);
        vm.expectRevert(PolicyWallet.InvalidPayee.selector);
        wallet.register(address(0x100), CEILING + 1, RH);
    }

    function test_order_pinnedBeforeCeiling() public {
        wallet.rawSetCounterparty(cp, _cp(0, true, false));
        vm.prank(registrar);
        vm.expectRevert(PolicyWallet.Pinned.selector);
        wallet.register(cp, CEILING + 1, RH);
    }

    function test_order_pinnedBeforeAlreadyRegisteredAndCode() public {
        address c = address(new ContractPayee());
        wallet.rawSetCounterparty(c, _cp(0, true, true));
        vm.prank(registrar);
        vm.expectRevert(PolicyWallet.Pinned.selector);
        wallet.register(c, 1, RH);
    }

    function test_order_alreadyRegisteredBeforeCode() public {
        address c = address(new ContractPayee());
        wallet.rawSetCounterparty(c, _cp(1, false, true));
        vm.prank(registrar);
        vm.expectRevert(PolicyWallet.AlreadyRegistered.selector);
        wallet.register(c, CEILING + 1, RH);
    }

    function test_order_codeBeforeCeiling() public {
        address c = address(new ContractPayee());
        vm.prank(registrar);
        vm.expectRevert(PolicyWallet.PayeeIsContract.selector);
        wallet.register(c, CEILING + 1, RH);
    }

    function test_order_ceilingBeforeCap() public {
        vm.prank(human);
        wallet.setNewPayeeCap(0, RH);
        vm.prank(registrar);
        vm.expectRevert(PolicyWallet.CeilingExceeded.selector);
        wallet.register(cp, CEILING + 1, RH);
    }

    // ------------------------------------------------------------------
    // Auth
    // ------------------------------------------------------------------

    function test_register_auth_everyOtherRole() public {
        address[5] memory callers = [human, payment, model, rules, stranger];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(PolicyWallet.Unauthorized.selector);
            wallet.register(cp, 1, RH);
        }
    }

    function test_register_auth_vacantSlot() public {
        vm.prank(human);
        wallet.revokeRole(PolicyWallet.Role.Registrar, RH);
        vm.prank(address(0));
        vm.expectRevert(PolicyWallet.Unauthorized.selector);
        wallet.register(cp, 1, RH);
    }

    function test_register_auth_registrarWithCode() public {
        vm.etch(registrar, hex"00");
        vm.prank(registrar);
        vm.expectRevert(PolicyWallet.Unauthorized.selector);
        wallet.register(cp, 1, RH);
    }

    // ------------------------------------------------------------------
    // Rolling-window edge
    // ------------------------------------------------------------------

    function test_register_dayIndexOverflowReachable() public {
        vm.warp((uint256(type(uint32).max) + 1) * 1 days);
        vm.prank(registrar);
        vm.expectRevert(RollingWindow.DayIndexOverflow.selector);
        wallet.register(cp, 1, RH);
        // A zero-limit Registration touches no ring, so it still succeeds.
        _register(cp, 0);
    }

    // ------------------------------------------------------------------
    // Gas at N = 90 with all three rings fully populated
    // ------------------------------------------------------------------

    function test_gas_registerAtMaxPeriodFullRings() public {
        vm.startPrank(human);
        wallet.setPolicyPeriod(90, RH);
        wallet.setNewPayeeCap(1_000, RH);
        vm.stopPrank();

        uint256 today = _today();
        for (uint256 d = today - 90; d <= today; ++d) {
            // forge-lint: disable-next-line(unsafe-typecast) -- test day indices fit uint32
            uint32 day = uint32(d);
            wallet.rawSetCpSlot(cp, day, 1);
            wallet.rawSetWalletSlot(day, 1);
            wallet.rawSetNewPayeeSlot(day, 1);
        }
        assertEq(wallet.remaining(cp).newPayeeRemaining, 1_000 - 91);

        vm.cool(address(wallet));
        vm.prank(registrar);
        uint256 g = gasleft();
        wallet.register(cp, CEILING, RH);
        g -= gasleft();
        console.log("register gas at N=90, full rings:", g);
        assertLt(g, 1_000_000);
        assertEq(wallet.remaining(cp).newPayeeRemaining, 1_000 - 92);
    }

    // ------------------------------------------------------------------
    // Fuzz
    // ------------------------------------------------------------------

    /// Register never stores a limit above the First-Contact Ceiling, and never lets the
    /// effective limit exceed it.
    function testFuzz_register_neverExceedsCeiling(uint256 ceiling, uint256 l) public {
        ceiling = bound(ceiling, 0, type(uint128).max);
        vm.prank(human);
        wallet.setFirstContactCeiling(ceiling, RH);

        vm.prank(registrar);
        if (l > ceiling) {
            vm.expectRevert(PolicyWallet.CeilingExceeded.selector);
            wallet.register(cp, l, RH);
            assertFalse(wallet.remaining(cp).registered);
        } else {
            wallet.register(cp, l, RH);
            PolicyWallet.Remaining memory r = wallet.remaining(cp);
            assertTrue(r.registered);
            assertLe(r.limit, ceiling);
            assertLe(r.cpRemaining, ceiling);
            assertEq(r.newPayeeRemaining, l > 0 ? NEW_PAYEE_CAP - 1 : NEW_PAYEE_CAP);
        }
    }
}
