// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {PolicyWallet} from "../src/PolicyWallet.sol";
import {RollingWindow} from "../src/lib/RollingWindow.sol";
import {PolicyWalletHarness} from "./harness/PolicyWalletHarness.sol";
import {RingHarness} from "./harness/RingHarness.sol";

contract RemainingTest is Test {
    PolicyWalletHarness internal wallet;

    address internal human = makeAddr("human");
    address internal payment = makeAddr("payment");
    address internal registrar = makeAddr("registrar");
    address internal model = makeAddr("model");
    address internal rules = makeAddr("rules");
    address internal cp = makeAddr("counterparty");

    bytes32 internal constant RH = keccak256("record");
    uint256 internal constant CEILING = 500e6;
    uint256 internal constant WALLET_CAP = 5_000e6;
    uint256 internal constant NEW_PAYEE_CAP = 10;
    uint256 internal constant PERIOD = 30;

    /// A realistic start: 2026-09-25 12:00 UTC (day index 20,721).
    uint256 internal constant T0 = 20_721 days + 12 hours;

    function _preset() internal pure returns (PolicyWallet.Policy memory) {
        return PolicyWallet.Policy({
            firstContactCeiling: CEILING,
            walletPeriodCap: WALLET_CAP,
            newPayeeCap: NEW_PAYEE_CAP,
            policyPeriodDays: PERIOD,
            unpinDelay: 24 hours
        });
    }

    function setUp() public {
        vm.warp(T0);
        wallet = new PolicyWalletHarness(
            PolicyWallet.Roles({human: human, payment: payment, registrar: registrar, model: model, rules: rules}),
            _preset(),
            false
        );
    }

    function _cp(uint256 limit, bool humanSet) internal pure returns (PolicyWallet.Counterparty memory) {
        return PolicyWallet.Counterparty({
            registered: true, pinned: false, humanSet: humanSet, humanEpoch: 0, unpinRequestedAt: 0, limit: limit
        });
    }

    function _today() internal view returns (uint256) {
        return vm.getBlockTimestamp() / 1 days;
    }

    // ------------------------------------------------------------------
    // Constants and ABI shape
    // ------------------------------------------------------------------

    function test_ringSizeMatchesMaxPeriod() public view {
        assertEq(RollingWindow.RING_SIZE, wallet.MAX_POLICY_PERIOD_DAYS() + 1);
        assertEq(RollingWindow.RING_SIZE, 91);
    }

    // ------------------------------------------------------------------
    // Unknown counterparty
    // ------------------------------------------------------------------

    function test_remaining_unknownCounterparty() public {
        PolicyWallet.Remaining memory r = wallet.remaining(makeAddr("fresh"));
        assertEq(r.cpRemaining, 0);
        assertEq(r.walletRemaining, WALLET_CAP);
        assertEq(r.newPayeeRemaining, NEW_PAYEE_CAP);
        assertEq(r.limit, 0);
        assertFalse(r.pinned);
        assertFalse(r.registered);
        assertFalse(r.humanSet);
        assertEq(r.humanEpoch, 0);
    }

    function test_remaining_zeroAddressAndSelfDoNotRevert() public view {
        wallet.remaining(address(0));
        wallet.remaining(address(wallet));
        wallet.remaining(wallet.USDC());
    }

    function test_remaining_atTimestampZero() public {
        vm.warp(0);
        PolicyWallet.Remaining memory r = wallet.remaining(cp);
        assertEq(r.walletRemaining, WALLET_CAP);
    }

    function test_remaining_copiesStateFields() public {
        wallet.rawSetCounterparty(
            cp,
            PolicyWallet.Counterparty({
                registered: true, pinned: true, humanSet: true, humanEpoch: 7, unpinRequestedAt: 123, limit: 0
            })
        );
        PolicyWallet.Remaining memory r = wallet.remaining(cp);
        assertTrue(r.registered);
        assertTrue(r.pinned);
        assertTrue(r.humanSet);
        assertEq(r.humanEpoch, 7);
        assertEq(r.limit, 0);
        assertEq(r.cpRemaining, 0);
    }

    // ------------------------------------------------------------------
    // Ceiling and humanSet
    // ------------------------------------------------------------------

    function test_ceilingApplies_whenNotHumanSet() public {
        wallet.rawSetCounterparty(cp, _cp(800e6, false));
        assertEq(wallet.remaining(cp).cpRemaining, 500e6);
        wallet.exposedRecordSpend(cp, 100e6);
        PolicyWallet.Remaining memory r = wallet.remaining(cp);
        assertEq(r.cpRemaining, 400e6);
        assertEq(r.limit, 800e6);
        assertEq(r.walletRemaining, WALLET_CAP - 100e6);
    }

    function test_humanSetLiftsCeiling() public {
        wallet.rawSetCounterparty(cp, _cp(800e6, true));
        wallet.exposedRecordSpend(cp, 100e6);
        assertEq(wallet.remaining(cp).cpRemaining, 700e6);
    }

    function test_ceilingLowered_humanSetUnaffected() public {
        wallet.rawSetCounterparty(cp, _cp(800e6, true));
        wallet.exposedRecordSpend(cp, 100e6);
        assertEq(wallet.remaining(cp).cpRemaining, 700e6);
        vm.prank(human);
        wallet.setFirstContactCeiling(50e6, RH);
        assertEq(wallet.remaining(cp).cpRemaining, 700e6);
    }

    function test_limitBelowCeiling_usesLimit() public {
        wallet.rawSetCounterparty(cp, _cp(200e6, false));
        wallet.exposedRecordSpend(cp, 50e6);
        assertEq(wallet.remaining(cp).cpRemaining, 150e6);
    }

    function test_ceilingLowered_tightensLiveView() public {
        wallet.rawSetCounterparty(cp, _cp(800e6, false));
        vm.prank(human);
        wallet.setFirstContactCeiling(100e6, RH);
        assertEq(wallet.remaining(cp).cpRemaining, 100e6);
    }

    function test_spendIsPerCounterparty() public {
        address other = makeAddr("other");
        wallet.rawSetCounterparty(cp, _cp(400e6, false));
        wallet.rawSetCounterparty(other, _cp(400e6, false));
        wallet.exposedRecordSpend(cp, 300e6);
        assertEq(wallet.remaining(cp).cpRemaining, 100e6);
        assertEq(wallet.remaining(other).cpRemaining, 400e6);
        assertEq(wallet.remaining(other).walletRemaining, WALLET_CAP - 300e6);
    }

    // ------------------------------------------------------------------
    // Saturation
    // ------------------------------------------------------------------

    function test_saturation_spentAboveLimitAndCap() public {
        wallet.rawSetCounterparty(cp, _cp(800e6, true));
        wallet.exposedRecordSpend(cp, 900e6);
        wallet.exposedRecordSpend(cp, 5_000e6);
        PolicyWallet.Remaining memory r = wallet.remaining(cp);
        assertEq(r.cpRemaining, 0);
        assertEq(r.walletRemaining, 0);
    }

    function test_saturation_uint224Max() public {
        wallet.rawSetCounterparty(cp, _cp(type(uint256).max, true));
        wallet.exposedRecordSpend(cp, type(uint256).max);
        (uint32 d, uint224 amt) = wallet.cpSlot(cp, _today() % 91);
        assertEq(d, _today());
        assertEq(amt, type(uint224).max);
        wallet.exposedRecordSpend(cp, 1);
        (, amt) = wallet.cpSlot(cp, _today() % 91);
        assertEq(amt, type(uint224).max);
        PolicyWallet.Remaining memory r = wallet.remaining(cp);
        assertEq(r.cpRemaining, type(uint256).max - type(uint224).max);
        assertEq(r.walletRemaining, 0);
    }

    function test_saturation_exactlyToMax() public {
        wallet.exposedRecordSpend(cp, type(uint224).max - 5);
        wallet.exposedRecordSpend(cp, 5);
        (, uint224 amt) = wallet.walletSlot(_today() % 91);
        assertEq(amt, type(uint224).max);
    }

    function test_capLoweredBelowSpend() public {
        wallet.exposedRecordSpend(cp, 3_000e6);
        vm.prank(human);
        wallet.setWalletPeriodCap(1_000e6, RH);
        assertEq(wallet.remaining(cp).walletRemaining, 0);
    }

    function test_exactSpendLeavesZero_oneLessLeavesOne() public {
        wallet.exposedRecordSpend(cp, WALLET_CAP - 1);
        assertEq(wallet.remaining(cp).walletRemaining, 1);
        wallet.exposedRecordSpend(cp, 1);
        assertEq(wallet.remaining(cp).walletRemaining, 0);
    }

    // ------------------------------------------------------------------
    // New-payee ring
    // ------------------------------------------------------------------

    function test_newPayee_countsAndSaturates() public {
        for (uint256 i; i < 3; ++i) {
            wallet.exposedRecordNewPayee();
        }
        assertEq(wallet.remaining(cp).newPayeeRemaining, 7);
        for (uint256 i; i < 8; ++i) {
            wallet.exposedRecordNewPayee();
        }
        assertEq(wallet.remaining(cp).newPayeeRemaining, 0);
    }

    function test_newPayee_rollsOffAfterWindow() public {
        wallet.exposedRecordNewPayee();
        vm.warp(vm.getBlockTimestamp() + PERIOD * 1 days);
        assertEq(wallet.remaining(cp).newPayeeRemaining, NEW_PAYEE_CAP - 1);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        assertEq(wallet.remaining(cp).newPayeeRemaining, NEW_PAYEE_CAP);
    }

    // ------------------------------------------------------------------
    // Window edges
    // ------------------------------------------------------------------

    function test_windowEdge_todayMinusNCounts_minusNMinus1Excluded() public {
        wallet.rawSetCounterparty(cp, _cp(400e6, false));
        wallet.exposedRecordSpend(cp, 100e6);
        uint256 spendDay = _today();

        // Last second of day spendDay + N: the spend is at today - N, so it counts.
        vm.warp((spendDay + PERIOD + 1) * 1 days - 1);
        assertEq(_today(), spendDay + PERIOD);
        PolicyWallet.Remaining memory r = wallet.remaining(cp);
        assertEq(r.cpRemaining, 300e6);
        assertEq(r.walletRemaining, WALLET_CAP - 100e6);

        // First second of the next day: the spend is at today - N - 1, excluded.
        vm.warp((spendDay + PERIOD + 1) * 1 days);
        r = wallet.remaining(cp);
        assertEq(r.cpRemaining, 400e6);
        assertEq(r.walletRemaining, WALLET_CAP);
    }

    function test_windowEdge_sameDaySpendsAccumulate() public {
        wallet.exposedRecordSpend(cp, 100e6);
        vm.warp((_today() + 1) * 1 days - 1); // last second of the same day
        wallet.exposedRecordSpend(cp, 200e6);
        (uint32 d, uint224 amt) = wallet.walletSlot(_today() % 91);
        assertEq(d, _today());
        assertEq(amt, 300e6);
        assertEq(wallet.remaining(cp).walletRemaining, WALLET_CAP - 300e6);
    }

    function test_window_multipleDaysSum() public {
        for (uint256 i; i < 5; ++i) {
            wallet.exposedRecordSpend(cp, 10e6);
            vm.warp(vm.getBlockTimestamp() + 1 days);
        }
        assertEq(wallet.remaining(cp).walletRemaining, WALLET_CAP - 50e6);
    }

    function test_futureSlotExcluded() public {
        uint32 tomorrow = uint32(_today() + 1);
        wallet.rawSetWalletSlot(tomorrow, 1_000e6);
        wallet.rawSetNewPayeeSlot(tomorrow, 5);
        wallet.rawSetCpSlot(cp, tomorrow, 1);
        wallet.rawSetCounterparty(cp, _cp(10, true));
        PolicyWallet.Remaining memory r = wallet.remaining(cp);
        assertEq(r.walletRemaining, WALLET_CAP);
        assertEq(r.newPayeeRemaining, NEW_PAYEE_CAP);
        assertEq(r.cpRemaining, 10);
    }

    function test_timeGoesBackwards_recordedSlotsBecomeFutureAndExcluded() public {
        wallet.exposedRecordSpend(cp, 100e6);
        vm.warp(vm.getBlockTimestamp() - 1 days);
        assertEq(wallet.remaining(cp).walletRemaining, WALLET_CAP);
    }

    // ------------------------------------------------------------------
    // Ring reuse
    // ------------------------------------------------------------------

    function test_ringReuse_overwritesStaleSlot() public {
        vm.prank(human);
        wallet.setPolicyPeriod(90, RH);
        wallet.exposedRecordSpend(cp, 700e6);
        uint256 d0 = _today();

        vm.warp(vm.getBlockTimestamp() + 91 days);
        assertEq(_today() % 91, d0 % 91);
        // Stale slot at the same ring index as today is excluded even before being overwritten.
        assertEq(wallet.remaining(cp).walletRemaining, WALLET_CAP);

        wallet.exposedRecordSpend(cp, 50e6);
        (uint32 d, uint224 amt) = wallet.walletSlot(d0 % 91);
        assertEq(d, _today());
        assertEq(amt, 50e6);
        (d, amt) = wallet.cpSlot(cp, d0 % 91);
        assertEq(d, _today());
        assertEq(amt, 50e6);
        assertEq(wallet.remaining(cp).walletRemaining, WALLET_CAP - 50e6);
    }

    function test_ringReuse_90DayWindowFullyRetained() public {
        vm.prank(human);
        wallet.setPolicyPeriod(90, RH);
        for (uint256 i; i < 91; ++i) {
            wallet.exposedRecordSpend(cp, 1e6);
            vm.warp(vm.getBlockTimestamp() + 1 days);
        }
        vm.warp(vm.getBlockTimestamp() - 1 days); // back to the day of the 91st spend
        assertEq(wallet.remaining(cp).walletRemaining, WALLET_CAP - 91e6);
        vm.warp(vm.getBlockTimestamp() + 1 days); // the first spend leaves the window
        assertEq(wallet.remaining(cp).walletRemaining, WALLET_CAP - 90e6);
    }

    // ------------------------------------------------------------------
    // Period changes
    // ------------------------------------------------------------------

    function test_periodShortened_oldSpendNoLongerCounts() public {
        wallet.rawSetCounterparty(cp, _cp(2_000e6, true));
        wallet.exposedRecordSpend(cp, 1_000e6);
        wallet.exposedRecordNewPayee();
        vm.warp(vm.getBlockTimestamp() + 10 days);
        PolicyWallet.Remaining memory r = wallet.remaining(cp);
        assertEq(r.walletRemaining, WALLET_CAP - 1_000e6);
        assertEq(r.cpRemaining, 1_000e6);
        assertEq(r.newPayeeRemaining, NEW_PAYEE_CAP - 1);
        vm.prank(human);
        wallet.setPolicyPeriod(5, RH);
        r = wallet.remaining(cp);
        assertEq(r.walletRemaining, WALLET_CAP);
        assertEq(r.cpRemaining, 2_000e6);
        assertEq(r.newPayeeRemaining, NEW_PAYEE_CAP);
    }

    function test_periodLengthened_retainedSpendCountsAgain() public {
        wallet.rawSetCounterparty(cp, _cp(2_000e6, true));
        wallet.exposedRecordSpend(cp, 1_000e6);
        wallet.exposedRecordNewPayee();
        vm.warp(vm.getBlockTimestamp() + 40 days);
        PolicyWallet.Remaining memory r = wallet.remaining(cp);
        assertEq(r.walletRemaining, WALLET_CAP);
        assertEq(r.cpRemaining, 2_000e6);
        assertEq(r.newPayeeRemaining, NEW_PAYEE_CAP);
        vm.prank(human);
        wallet.setPolicyPeriod(60, RH);
        r = wallet.remaining(cp);
        assertEq(r.walletRemaining, WALLET_CAP - 1_000e6);
        assertEq(r.cpRemaining, 1_000e6);
        assertEq(r.newPayeeRemaining, NEW_PAYEE_CAP - 1);
    }

    function test_periodOne_coversTodayAndYesterday() public {
        vm.prank(human);
        wallet.setPolicyPeriod(1, RH);
        wallet.exposedRecordSpend(cp, 100e6);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        assertEq(wallet.remaining(cp).walletRemaining, WALLET_CAP - 100e6);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        assertEq(wallet.remaining(cp).walletRemaining, WALLET_CAP);
    }

    // ------------------------------------------------------------------
    // Library-level edge cases
    // ------------------------------------------------------------------

    function test_record_revertsBeyondUint32Day() public {
        RingHarness h = new RingHarness();
        h.record(type(uint32).max, 1);
        vm.expectRevert(RollingWindow.DayIndexOverflow.selector);
        h.record(uint256(type(uint32).max) + 1, 1);
    }

    function test_windowSum_hugeTodayDoesNotRevert() public {
        RingHarness h = new RingHarness();
        h.record(5, 10);
        assertEq(h.windowSum(type(uint256).max, 90), 0);
        assertEq(h.windowSum(type(uint256).max / 1 days, 90), 0);
    }

    function test_windowSum_nAboveMaxClamped() public {
        RingHarness h = new RingHarness();
        h.setSlot(1000, 7);
        h.setSlot(1009, 9);
        // n above 90 is clamped to 90: the ring retains no older days.
        assertEq(h.windowSum(1100, 90), 0);
        assertEq(h.windowSum(1100, type(uint256).max), 0);
        assertEq(h.windowSum(1090, type(uint256).max), 16);
        assertEq(h.windowSum(1099, 1_000), 9);
    }

    function test_record_overwriteCapsFreshAmount() public {
        RingHarness h = new RingHarness();
        h.record(10, 5);
        h.record(101, type(uint256).max); // same index, different day
        (uint32 d, uint224 amt) = h.slot(10);
        assertEq(d, 101);
        assertEq(amt, type(uint224).max);
    }

    // ------------------------------------------------------------------
    // Fuzz
    // ------------------------------------------------------------------

    /// `remaining` never reverts and every field stays within its cap/limit, over arbitrary
    /// recorded spends/new-payees at arbitrary days, arbitrary Policy values and Counterparty
    /// state, and an arbitrary final timestamp (including before the records).
    function testFuzz_remaining_neverRevertsAndBounded(
        uint256[6] memory amounts,
        uint256[6] memory dayGaps,
        uint256 period,
        uint256 ceiling,
        uint256 walletCap,
        uint256 newPayeeCap,
        uint256 limit,
        bool humanSet,
        bool pinned,
        uint64 epoch,
        uint256 finalTs
    ) public {
        period = bound(period, 1, 90);
        vm.startPrank(human);
        wallet.setPolicyPeriod(period, RH);
        wallet.setFirstContactCeiling(ceiling, RH);
        wallet.setWalletPeriodCap(walletCap, RH);
        wallet.setNewPayeeCap(newPayeeCap, RH);
        vm.stopPrank();
        wallet.rawSetCounterparty(
            cp,
            PolicyWallet.Counterparty({
                registered: true,
                pinned: pinned,
                humanSet: humanSet,
                humanEpoch: epoch,
                unpinRequestedAt: 0,
                limit: limit
            })
        );

        uint256 ts = bound(dayGaps[0], 0, 400_000 days);
        for (uint256 i; i < 6; ++i) {
            ts += bound(dayGaps[i], 0, 120) * 1 days;
            vm.warp(ts);
            wallet.exposedRecordSpend(cp, amounts[i]);
            if (amounts[i] % 2 == 0) wallet.exposedRecordNewPayee();
        }

        // Mostly land near the records so the window is non-trivial; sometimes anywhere at all.
        if (finalTs % 4 != 0) finalTs = bound(finalTs, 0, ts + 200 days);
        vm.warp(finalTs);
        PolicyWallet.Remaining memory r = wallet.remaining(cp);

        {
            (uint256 cpSum, uint256 walletSum, uint256 payeeSum) = _referenceSums(finalTs / 1 days, period);
            uint256 eff = humanSet ? limit : (limit < ceiling ? limit : ceiling);
            assertEq(r.cpRemaining, RollingWindow.satSub(eff, cpSum));
            assertEq(r.walletRemaining, RollingWindow.satSub(walletCap, walletSum));
            assertEq(r.newPayeeRemaining, RollingWindow.satSub(newPayeeCap, payeeSum));
        }

        uint256 effective = humanSet ? limit : (limit < ceiling ? limit : ceiling);
        assertLe(r.cpRemaining, effective);
        assertLe(r.cpRemaining, limit);
        assertLe(r.walletRemaining, walletCap);
        assertLe(r.newPayeeRemaining, newPayeeCap);
        assertEq(r.limit, limit);
        assertEq(r.humanSet, humanSet);
        assertEq(r.pinned, pinned);
        assertEq(r.humanEpoch, epoch);
        assertTrue(r.registered);
    }

    /// Full 91-slot scan with the spec's range test, over the harness wallet's three rings.
    function _referenceSums(uint256 today, uint256 n)
        internal
        view
        returns (uint256 cpSum, uint256 walletSum, uint256 payeeSum)
    {
        uint256 lo = today > n ? today - n : 0;
        for (uint256 i; i < RollingWindow.RING_SIZE; ++i) {
            (uint32 d, uint224 a) = wallet.cpSlot(cp, i);
            if (d >= lo && d <= today) cpSum += a;
            (d, a) = wallet.walletSlot(i);
            if (d >= lo && d <= today) walletSum += a;
            (d, a) = wallet.newPayeeSlot(i);
            if (d >= lo && d <= today) payeeSum += a;
        }
    }

    /// The optimized windowSum equals the reference full scan for any reachable ring state.
    function testFuzz_windowSum_matchesReference(
        uint256[8] memory amounts,
        uint256[8] memory dayGaps,
        uint256 start,
        uint256 today,
        uint256 n
    ) public {
        RingHarness h = new RingHarness();
        uint256 day = bound(start, 0, 1_000_000);
        for (uint256 i; i < 8; ++i) {
            day += bound(dayGaps[i], 0, 60);
            h.record(day, amounts[i]);
        }
        today = bound(today, 0, day + 200);
        n = bound(n, 0, 90);
        assertEq(h.windowSum(today, n), h.referenceSum(today, n));
    }
}
