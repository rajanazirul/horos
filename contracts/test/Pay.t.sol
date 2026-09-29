// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {console} from "forge-std/Test.sol";
import {PolicyWallet} from "../src/PolicyWallet.sol";
import {RollingWindow} from "../src/lib/RollingWindow.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {WalletFixture, ContractPayee} from "./base/WalletFixture.sol";

contract PayTest is WalletFixture {
    address internal cp2 = makeAddr("counterparty2");

    function setUp() public override {
        super.setUp();
        _fund(1_000_000e6);
    }

    // ------------------------------------------------------------------
    // Success paths
    // ------------------------------------------------------------------

    function test_pay_exactRemainingThenOneMore() public {
        _register(cp, CEILING);
        uint256 walletBefore = usdc.balanceOf(address(wallet));

        vm.expectEmit(address(wallet));
        emit PolicyWallet.Paid(cp, CEILING, RH);
        _pay(cp, CEILING);

        assertEq(usdc.balanceOf(cp), CEILING);
        assertEq(usdc.balanceOf(address(wallet)), walletBefore - CEILING);
        PolicyWallet.Remaining memory r = wallet.remaining(cp);
        assertEq(r.cpRemaining, 0);
        assertEq(r.walletRemaining, WALLET_CAP - CEILING);

        vm.prank(payment);
        vm.expectRevert(PolicyWallet.LimitExceeded.selector);
        wallet.pay(cp, 1, RH);
    }

    function test_pay_partialThenRest() public {
        _register(cp, 300e6);
        _pay(cp, 100e6);
        _pay(cp, 200e6);
        assertEq(usdc.balanceOf(cp), 300e6);
        assertEq(wallet.remaining(cp).cpRemaining, 0);

        vm.prank(payment);
        vm.expectRevert(PolicyWallet.LimitExceeded.selector);
        wallet.pay(cp, 1, RH);
    }

    function test_pay_ceilingClampsRawLimit() public {
        wallet.rawSetCounterparty(cp, _cp(800e6, false, false));
        vm.prank(payment);
        vm.expectRevert(PolicyWallet.LimitExceeded.selector);
        wallet.pay(cp, CEILING + 1, RH);
        _pay(cp, CEILING);
        assertEq(usdc.balanceOf(cp), CEILING);
    }

    function test_pay_humanSetLimitIgnoresCeiling() public {
        wallet.rawSetCounterparty(cp, _cp(800e6, false, true));
        _pay(cp, 800e6);
        assertEq(usdc.balanceOf(cp), 800e6);
    }

    function test_pay_walletCap() public {
        wallet.rawSetCounterparty(cp, _cp(3_000e6, false, true));
        wallet.rawSetCounterparty(cp2, _cp(3_000e6, false, true));
        _pay(cp, 3_000e6);

        vm.prank(payment);
        vm.expectRevert(PolicyWallet.WalletCapExceeded.selector);
        wallet.pay(cp2, 2_000e6 + 1, RH);

        _pay(cp2, 2_000e6);
        assertEq(wallet.remaining(cp2).walletRemaining, 0);
    }

    function test_pay_rollingWindowRecovers() public {
        _register(cp, CEILING);
        _pay(cp, CEILING);

        vm.warp(vm.getBlockTimestamp() + PERIOD * 1 days);
        vm.prank(payment);
        vm.expectRevert(PolicyWallet.LimitExceeded.selector);
        wallet.pay(cp, 1, RH);

        vm.warp(vm.getBlockTimestamp() + 1 days);
        _pay(cp, CEILING);
        assertEq(usdc.balanceOf(cp), 2 * CEILING);
    }

    function test_pay_recordsBothRings() public {
        _register(cp, CEILING);
        _pay(cp, 123e6);
        uint256 idx = _today() % RollingWindow.RING_SIZE;
        (uint32 d1, uint224 a1) = wallet.cpSlot(cp, idx);
        (uint32 d2, uint224 a2) = wallet.walletSlot(idx);
        assertEq(d1, _today());
        assertEq(a1, 123e6);
        assertEq(d2, _today());
        assertEq(a2, 123e6);
    }

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    function test_pay_unregistered() public {
        vm.prank(payment);
        vm.expectRevert(PolicyWallet.NotRegistered.selector);
        wallet.pay(cp, 1, RH);
    }

    function test_pay_pinned() public {
        wallet.rawSetCounterparty(cp, _cp(CEILING, true, false));
        vm.prank(payment);
        vm.expectRevert(PolicyWallet.Pinned.selector);
        wallet.pay(cp, 1, RH);
    }

    function test_pay_zero() public {
        _register(cp, CEILING);
        vm.prank(payment);
        vm.expectRevert(PolicyWallet.InvalidAmount.selector);
        wallet.pay(cp, 0, RH);
    }

    function test_pay_registeredAtZero() public {
        _register(cp, 0);
        vm.prank(payment);
        vm.expectRevert(PolicyWallet.LimitExceeded.selector);
        wallet.pay(cp, 1, RH);
    }

    function test_pay_contractPayee_humanSetFalseThenTrue() public {
        address c = address(new ContractPayee());
        wallet.rawSetCounterparty(c, _cp(100e6, false, false));
        vm.prank(payment);
        vm.expectRevert(PolicyWallet.PayeeIsContract.selector);
        wallet.pay(c, 100e6, RH);

        wallet.rawSetCounterparty(c, _cp(100e6, false, true));
        _pay(c, 100e6);
        assertEq(usdc.balanceOf(c), 100e6);
    }

    function test_pay_tokenFailureRollsBack() public {
        _register(cp, CEILING);
        // Set the mock balance to 10 units below the payment.
        uint256 bal = 100e6 - 10;
        usdc.setBalance(address(wallet), bal);
        assertEq(usdc.balanceOf(address(wallet)), bal);

        vm.prank(payment);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.InsufficientBalance.selector, bal, 100e6));
        wallet.pay(cp, 100e6, RH);

        PolicyWallet.Remaining memory r = wallet.remaining(cp);
        assertEq(r.cpRemaining, CEILING);
        assertEq(r.walletRemaining, WALLET_CAP);
        (, uint224 a) = wallet.cpSlot(cp, _today() % RollingWindow.RING_SIZE);
        assertEq(a, 0);
        (, a) = wallet.walletSlot(_today() % RollingWindow.RING_SIZE);
        assertEq(a, 0);
        assertEq(usdc.balanceOf(cp), 0);
    }

    function test_pay_tokenReturnsFalseReverts() public {
        _register(cp, CEILING);
        usdc.setReturnFalse(true);
        uint256 walletBal = usdc.balanceOf(address(wallet));

        vm.prank(payment);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, USDC));
        wallet.pay(cp, 100e6, RH);

        PolicyWallet.Remaining memory r = wallet.remaining(cp);
        assertEq(r.cpRemaining, CEILING);
        assertEq(r.walletRemaining, WALLET_CAP);
        uint256 idx = _today() % RollingWindow.RING_SIZE;
        (uint32 d1, uint224 a1) = wallet.cpSlot(cp, idx);
        (uint32 d2, uint224 a2) = wallet.walletSlot(idx);
        assertEq(d1, 0);
        assertEq(a1, 0);
        assertEq(d2, 0);
        assertEq(a2, 0);
        assertEq(usdc.balanceOf(address(wallet)), walletBal);
        assertEq(usdc.balanceOf(cp), 0);
    }

    function test_pay_registeredEoaGainsCode() public {
        _register(cp, CEILING);
        vm.etch(cp, address(new ContractPayee()).code);
        vm.prank(payment);
        vm.expectRevert(PolicyWallet.PayeeIsContract.selector);
        wallet.pay(cp, 1, RH);
    }

    function test_pay_humanLowersCeilingClampsNextPay() public {
        _register(cp, CEILING);
        _pay(cp, 100e6);
        vm.prank(human);
        wallet.setFirstContactCeiling(300e6, RH);
        assertEq(wallet.remaining(cp).cpRemaining, 200e6);

        vm.prank(payment);
        vm.expectRevert(PolicyWallet.LimitExceeded.selector);
        wallet.pay(cp, 200e6 + 1, RH);
        _pay(cp, 200e6);
    }

    function test_pay_humanLowersWalletCapBelowSpend() public {
        _register(cp, CEILING);
        _pay(cp, 400e6);
        vm.prank(human);
        wallet.setWalletPeriodCap(300e6, RH);
        assertEq(wallet.remaining(cp).walletRemaining, 0);

        vm.prank(payment);
        vm.expectRevert(PolicyWallet.WalletCapExceeded.selector);
        wallet.pay(cp, 1, RH);
    }

    function test_pay_dayIndexOverflowReachable() public {
        wallet.rawSetCounterparty(cp, _cp(CEILING, false, false));
        vm.warp((uint256(type(uint32).max) + 1) * 1 days);
        vm.prank(payment);
        vm.expectRevert(RollingWindow.DayIndexOverflow.selector);
        wallet.pay(cp, 1, RH);
    }

    // ------------------------------------------------------------------
    // Check order when two failures coincide
    // ------------------------------------------------------------------

    function test_order_zeroBeforeUnregistered() public {
        vm.prank(payment);
        vm.expectRevert(PolicyWallet.InvalidAmount.selector);
        wallet.pay(cp, 0, RH);
    }

    function test_order_unregisteredBeforePinned() public {
        PolicyWallet.Counterparty memory c = _cp(CEILING, true, false);
        c.registered = false;
        wallet.rawSetCounterparty(cp, c);
        vm.prank(payment);
        vm.expectRevert(PolicyWallet.NotRegistered.selector);
        wallet.pay(cp, 1, RH);
    }

    function test_order_pinnedBeforeCode() public {
        address c = address(new ContractPayee());
        wallet.rawSetCounterparty(c, _cp(CEILING, true, false));
        vm.prank(payment);
        vm.expectRevert(PolicyWallet.Pinned.selector);
        wallet.pay(c, CEILING + 1, RH);
    }

    function test_order_codeBeforeLimit() public {
        address c = address(new ContractPayee());
        wallet.rawSetCounterparty(c, _cp(1, false, false));
        vm.prank(payment);
        vm.expectRevert(PolicyWallet.PayeeIsContract.selector);
        wallet.pay(c, 2, RH);
    }

    function test_order_limitBeforeWalletCap() public {
        vm.prank(human);
        wallet.setWalletPeriodCap(1, RH);
        _register(cp, CEILING);
        vm.prank(payment);
        vm.expectRevert(PolicyWallet.LimitExceeded.selector);
        wallet.pay(cp, CEILING + 1, RH);
        vm.prank(payment);
        vm.expectRevert(PolicyWallet.WalletCapExceeded.selector);
        wallet.pay(cp, 2, RH);
    }

    // ------------------------------------------------------------------
    // Auth
    // ------------------------------------------------------------------

    function test_pay_auth_everyOtherRole() public {
        _register(cp, CEILING);
        address[5] memory callers = [human, registrar, model, rules, stranger];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(PolicyWallet.Unauthorized.selector);
            wallet.pay(cp, 1, RH);
        }
    }

    function test_pay_auth_vacantSlot() public {
        _register(cp, CEILING);
        vm.prank(human);
        wallet.revokeRole(PolicyWallet.Role.Payment, RH);
        vm.prank(address(0));
        vm.expectRevert(PolicyWallet.Unauthorized.selector);
        wallet.pay(cp, 1, RH);
    }

    function test_pay_auth_paymentWithCode() public {
        _register(cp, CEILING);
        vm.etch(payment, hex"00");
        vm.prank(payment);
        vm.expectRevert(PolicyWallet.Unauthorized.selector);
        wallet.pay(cp, 1, RH);
    }

    // ------------------------------------------------------------------
    // Payability and surface probes
    // ------------------------------------------------------------------

    function test_payableProbe_registerAndPayNotPayable() public {
        vm.deal(registrar, 1 ether);
        vm.prank(registrar);
        (bool ok,) = address(wallet).call{value: 1}(abi.encodeCall(PolicyWallet.register, (cp, CEILING, RH)));
        assertFalse(ok);
        _register(cp, CEILING);

        vm.deal(payment, 1 ether);
        vm.prank(payment);
        (ok,) = address(wallet).call{value: 1}(abi.encodeCall(PolicyWallet.pay, (cp, 1, RH)));
        assertFalse(ok);

        // Same call without value succeeds, so the failure above is due to value.
        vm.prank(payment);
        (ok,) = address(wallet).call(abi.encodeCall(PolicyWallet.pay, (cp, 1, RH)));
        assertTrue(ok);
        assertEq(address(wallet).balance, 0);
    }

    function test_surface_noBatchOrArbitraryPay() public {
        _register(cp, CEILING);
        address[] memory to = new address[](1);
        to[0] = cp;
        uint256[] memory amts = new uint256[](1);
        amts[0] = 1;
        bytes[] memory calls = new bytes[](4);
        calls[0] = abi.encodeWithSignature("payBatch(address[],uint256[],bytes32)", to, amts, RH);
        calls[1] = abi.encodeWithSignature("batchPay(address[],uint256[],bytes32)", to, amts, RH);
        calls[2] = abi.encodeWithSignature("call(address,uint256,bytes)", cp, 1, "");
        calls[3] = abi.encodeWithSignature("transfer(address,uint256)", cp, 1);
        for (uint256 i; i < calls.length; ++i) {
            vm.prank(payment);
            (bool ok,) = address(wallet).call(calls[i]);
            assertFalse(ok);
        }
        assertEq(usdc.balanceOf(cp), 0);
    }

    // ------------------------------------------------------------------
    // Gas at N = 90 with all three rings fully populated (deferred from Story 1.3)
    // ------------------------------------------------------------------

    function test_gas_payAtMaxPeriodFullRings() public {
        vm.startPrank(human);
        wallet.setPolicyPeriod(90, RH);
        wallet.setWalletPeriodCap(type(uint128).max, RH);
        wallet.setNewPayeeCap(1_000, RH);
        vm.stopPrank();
        wallet.rawSetCounterparty(cp, _cp(1_000_000e6, false, true));

        uint256 today = _today();
        for (uint256 d = today - 90; d <= today; ++d) {
            // forge-lint: disable-next-line(unsafe-typecast) -- test day indices fit uint32
            uint32 day = uint32(d);
            wallet.rawSetCpSlot(cp, day, 1);
            wallet.rawSetWalletSlot(day, 1);
            wallet.rawSetNewPayeeSlot(day, 1);
        }
        PolicyWallet.Remaining memory r = wallet.remaining(cp);
        assertEq(r.cpRemaining, 1_000_000e6 - 91);
        assertEq(r.newPayeeRemaining, 1_000 - 91);

        vm.cool(address(wallet));
        vm.cool(USDC);
        vm.prank(payment);
        uint256 g = gasleft();
        wallet.pay(cp, 1e6, RH);
        g -= gasleft();
        console.log("pay gas at N=90, full rings:", g);
        assertLt(g, 1_000_000);
    }

    // ------------------------------------------------------------------
    // Fuzz: no window ever exceeds the effective limit or the wallet cap
    // ------------------------------------------------------------------

    struct Ledger {
        uint256[32] day;
        uint256[32] amount;
        uint8[32] payee;
        uint256 n;
    }

    function _windowSum(Ledger memory l, uint256 today, uint256 period, bool all, uint8 payee)
        internal
        pure
        returns (uint256 s)
    {
        uint256 lo = today > period ? today - period : 0;
        for (uint256 i; i < l.n; ++i) {
            if (l.day[i] >= lo && l.day[i] <= today && (all || l.payee[i] == payee)) s += l.amount[i];
        }
    }

    uint256 internal fzEff;
    uint256 internal fzCap;
    uint256 internal fzPeriod;

    function testFuzz_pay_windowsNeverExceedLimits(
        uint256 limit,
        uint256 cap,
        uint256 period,
        bool humanSet,
        uint256[32] calldata amounts,
        uint8[32] calldata warps
    ) public {
        limit = bound(limit, 1, 2_000e6);
        fzCap = bound(cap, 1, 3_000e6);
        fzPeriod = bound(period, 1, 90);
        vm.startPrank(human);
        wallet.setWalletPeriodCap(fzCap, RH);
        wallet.setPolicyPeriod(fzPeriod, RH);
        vm.stopPrank();

        wallet.rawSetCounterparty(cp, _cp(limit, false, humanSet));
        wallet.rawSetCounterparty(cp2, _cp(limit, false, humanSet));
        fzEff = humanSet || limit <= CEILING ? limit : CEILING;

        Ledger memory led;
        for (uint256 i; i < 32; ++i) {
            vm.warp(vm.getBlockTimestamp() + (uint256(warps[i]) % 8) * 1 days);
            _fuzzStep(led, uint8(i % 2), bound(amounts[i], 0, 2 * fzEff + 1));
        }
    }

    function _fuzzStep(Ledger memory led, uint8 p, uint256 amount) internal {
        uint256 today = _today();
        bool shouldPass;
        {
            uint256 cpLeft = fzEff - _windowSum(led, today, fzPeriod, false, p);
            uint256 wSum = _windowSum(led, today, fzPeriod, true, 0);
            shouldPass = amount > 0 && amount <= cpLeft && wSum < fzCap && amount <= fzCap - wSum;
        }
        vm.prank(payment);
        (bool ok,) = address(wallet).call(abi.encodeCall(PolicyWallet.pay, (p == 0 ? cp : cp2, amount, RH)));
        assertEq(ok, shouldPass, "pay outcome matches the model");
        if (ok) {
            led.day[led.n] = today;
            led.amount[led.n] = amount;
            led.payee[led.n] = p;
            ++led.n;
        }
        _fuzzAssert(led, p, today);
    }

    function _fuzzAssert(Ledger memory led, uint8 p, uint256 today) internal view {
        uint256 cpSum = _windowSum(led, today, fzPeriod, false, p);
        uint256 otherSum = _windowSum(led, today, fzPeriod, false, 1 - p);
        uint256 wSum = _windowSum(led, today, fzPeriod, true, 0);
        assertLe(cpSum, fzEff, "cp window within effective limit");
        assertLe(otherSum, fzEff, "other cp window within effective limit");
        assertLe(wSum, fzCap, "wallet window within cap");
        PolicyWallet.Remaining memory r = wallet.remaining(p == 0 ? cp : cp2);
        assertEq(r.cpRemaining, fzEff - cpSum, "cpRemaining matches model");
        assertEq(r.walletRemaining, fzCap - wSum, "walletRemaining matches model");
    }
}
