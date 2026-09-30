// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {RollingWindow} from "../src/lib/RollingWindow.sol";
import {RingHarness} from "./harness/RingHarness.sol";
import {PolicyWallet} from "../src/PolicyWallet.sol";
import {PolicyWalletHarness} from "./harness/PolicyWalletHarness.sol";
import {WalletFixture} from "./base/WalletFixture.sol";

/// @notice Writes `test-vectors/remaining-window.json`, the fixture the TypeScript port of
///         `remaining()` (Epic 3, Story 3.4) must reproduce. Fixed cases only; no fuzz input,
///         so two runs produce byte-identical output. Keep the JSON shape stable.
contract RemainingVectorsTest is Test {
    string internal constant PATH = "./test-vectors/remaining-window.json";

    /// Day index of 2026-09-25.
    uint32 internal constant D = 20_721;
    uint256 internal constant NOON = 12 hours;
    uint224 internal constant MAX224 = type(uint224).max;

    struct Case {
        string name;
        uint256 timestamp;
        uint256 periodDays;
        uint256 cap;
        uint32[] dayIndexes;
        uint224[] amounts;
        uint256 expectedSum;
        uint256 expectedRemaining;
    }

    RingHarness internal ring;

    function setUp() public {
        ring = new RingHarness();
    }

    function _case(
        string memory name,
        uint256 ts,
        uint256 n,
        uint256 cap,
        uint256 expectedSum,
        uint256 expectedRemaining
    ) internal pure returns (Case memory c) {
        c.expectedRemaining = expectedRemaining;
        c.name = name;
        c.timestamp = ts;
        c.periodDays = n;
        c.cap = cap;
        c.expectedSum = expectedSum;
    }

    function _add(Case memory c, uint32 dayIndex, uint224 amount) internal pure returns (Case memory) {
        uint256 len = c.dayIndexes.length;
        uint32[] memory ds = new uint32[](len + 1);
        uint224[] memory as_ = new uint224[](len + 1);
        for (uint256 i; i < len; ++i) {
            ds[i] = c.dayIndexes[i];
            as_[i] = c.amounts[i];
        }
        ds[len] = dayIndex;
        as_[len] = amount;
        c.dayIndexes = ds;
        c.amounts = as_;
        return c;
    }

    function _cases() internal pure returns (Case[] memory cs) {
        cs = new Case[](18);
        uint256 t = uint256(D) * 1 days + NOON;

        cs[0] = _case("empty_ring", t, 30, 5_000e6, 0, 5_000e6);

        cs[1] = _add(_case("slot_at_lower_edge_counts", t, 30, 5_000e6, 100e6, 4_900e6), D - 30, 100e6);

        cs[2] = _add(_case("slot_below_lower_edge_excluded", t, 30, 5_000e6, 0, 5_000e6), D - 31, 100e6);

        cs[3] = _add(_case("slot_today", t, 30, 5_000e6, 250e6, 4_750e6), D, 250e6);

        cs[4] = _add(_add(_case("future_slot_excluded", t, 30, 5_000e6, 1e6, 4_999e6), D + 1, 999e6), D, 1e6);

        Case memory c = _case("today_less_than_n", 5 days + NOON, 30, 100, 60, 40);
        c = _add(_add(_add(c, 0, 10), 3, 20), 5, 30);
        cs[5] = _add(c, 6, 1); // future, excluded

        c = _case("period_one", t, 1, 5_000e6, 6, 5_000e6 - 6);
        cs[6] = _add(_add(_add(_add(c, D - 3, 100), D - 2, 1), D - 1, 2), D, 4);

        c = _case("period_ninety", t, 90, 5_000e6, 56, 5_000e6 - 56);
        cs[7] = _add(_add(_add(c, D - 90, 8), D - 45, 16), D, 32);

        c = _case("sum_above_cap", t, 30, 1_000e6, 1_200e6, 0);
        cs[8] = _add(_add(c, D - 1, 600e6), D, 600e6);

        c = _case(
            "near_uint224_max",
            t,
            30,
            type(uint256).max,
            3 * uint256(MAX224) - 1,
            type(uint256).max - (3 * uint256(MAX224) - 1)
        );
        cs[9] = _add(_add(_add(c, D - 2, MAX224), D - 1, MAX224), D, MAX224 - 1);

        cs[10] = _add(_case("stale_slot_same_index_as_today", t, 90, 5_000e6, 0, 5_000e6), D - 91, 500e6);

        c = _case("full_ring_n90", t, 90, 5_000, 4_186, 814); // amounts 1..91
        for (uint32 i; i < 91; ++i) {
            c = _add(c, D - 90 + i, i + 1);
        }
        cs[11] = c;

        c = _case("full_ring_n30", t, 30, 5_000, 2_356, 2_644); // days D-30..D carry 61..91
        for (uint32 i; i < 91; ++i) {
            c = _add(c, D - 90 + i, i + 1);
        }
        cs[12] = c;

        cs[13] = _add(_case("sum_equals_cap", t, 30, 500e6, 500e6, 0), D - 10, 500e6);

        cs[14] = _add(_case("sum_one_below_cap", t, 30, 500e6, 500e6 - 1, 1), D - 10, 500e6 - 1);

        cs[15] = _add(_case("zero_cap", t, 30, 0, 5, 0), D, 5);

        cs[16] = _add(_case("timestamp_zero", 0, 30, 10, 5, 5), 0, 5);

        // Last second of day D: today is still D, so the slot at D - 30 counts.
        cs[17] = _add(_case("last_second_of_day", uint256(D + 1) * 1 days - 1, 30, 5_000e6, 7, 5_000e6 - 7), D - 30, 7);
    }

    function _slotsJson(Case memory c) internal pure returns (string memory s) {
        s = "[";
        for (uint256 i; i < c.dayIndexes.length; ++i) {
            s = string.concat(
                s,
                i == 0 ? "" : ",",
                '{"dayIndex":',
                vm.toString(uint256(c.dayIndexes[i])),
                ',"amount":"',
                vm.toString(uint256(c.amounts[i])),
                '"}'
            );
        }
        s = string.concat(s, "]");
    }

    function _run(Case memory c) internal returns (uint256 sum, uint256 rem) {
        ring.clear();
        for (uint256 i; i < c.dayIndexes.length; ++i) {
            ring.setSlot(c.dayIndexes[i], c.amounts[i]);
        }
        uint256 today = c.timestamp / 1 days;
        sum = ring.windowSum(today, c.periodDays);
        assertEq(sum, ring.referenceSum(today, c.periodDays), c.name);
        assertEq(sum, c.expectedSum, c.name);
        rem = RollingWindow.satSub(c.cap, sum);
        assertEq(rem, c.expectedRemaining, c.name);
    }

    function test_writeRemainingWindowVectors() public {
        Case[] memory cs = _cases();
        assertGe(cs.length, 12);
        string memory json = string.concat('{"ringSize":', vm.toString(RollingWindow.RING_SIZE), ',"cases":[\n');
        for (uint256 k; k < cs.length; ++k) {
            Case memory c = cs[k];
            (uint256 sum, uint256 rem) = _run(c);
            json = string.concat(
                json,
                '  {"name":"',
                c.name,
                '","timestamp":',
                vm.toString(c.timestamp),
                ',"periodDays":',
                vm.toString(c.periodDays),
                ',"cap":"',
                vm.toString(c.cap),
                '","slots":',
                _slotsJson(c),
                string.concat(',"windowSum":"', vm.toString(sum), '","remaining":"', vm.toString(rem), '"}'),
                k + 1 < cs.length ? ",\n" : "\n"
            );
        }
        json = string.concat(json, "]}\n");
        vm.writeFile(PATH, json);

        // Round-trip: parse every case back and compare against the hand-computed values.
        // parseJsonString also pins that sums are encoded as decimal strings.
        string memory back = vm.readFile(PATH);
        assertEq(vm.parseJsonUint(back, ".ringSize"), 91);
        for (uint256 k; k < cs.length; ++k) {
            string memory key = string.concat(".cases[", vm.toString(k), "]");
            assertEq(vm.parseJsonString(back, string.concat(key, ".name")), cs[k].name);
            assertEq(
                vm.parseJsonString(back, string.concat(key, ".windowSum")), vm.toString(cs[k].expectedSum), cs[k].name
            );
            assertEq(
                vm.parseJsonString(back, string.concat(key, ".remaining")),
                vm.toString(cs[k].expectedRemaining),
                cs[k].name
            );
        }
    }
}

/// @notice Writes `test-vectors/remaining-composition.json` (Story 3.4), the second fixture the TypeScript
///         port must reproduce:
///         - `recordCases`: `RollingWindow.record` accumulation, overwrite and uint224 saturation;
///         - `windowCases`: `windowSum` with a Policy Period above 90 (clamped to the ring);
///         - `walletCases`: a real PolicyWallet driven through `register` / `pay` / `tighten` / `pin` / Human
///           `setLimit` and Policy setters, with `vm.warp` across day boundaries, recording `remaining(a)` for every
///           Counterparty of the case after each step (Counterparty / wallet / new-payee composition, the
///           ceiling vs `humanSet` limit selection).
///         Fixed cases only, so two runs produce byte-identical output. Keep the JSON shape stable.
contract RemainingVectorsCompositionTest is WalletFixture {
    string internal constant PATH = "./test-vectors/remaining-composition.json";

    uint32 internal constant D = 20_721;
    uint224 internal constant MAX224 = type(uint224).max;

    // Step ops (the JSON carries their names).
    uint8 internal constant WARP = 0;
    uint8 internal constant REGISTER = 1;
    uint8 internal constant PAY = 2;
    uint8 internal constant TIGHTEN = 3;
    uint8 internal constant SET_LIMIT = 4;
    uint8 internal constant PIN = 5;
    uint8 internal constant SET_POLICY_PERIOD = 6;
    uint8 internal constant SET_FIRST_CONTACT_CEILING = 7;
    uint8 internal constant SET_WALLET_PERIOD_CAP = 8;
    uint8 internal constant SET_NEW_PAYEE_CAP = 9;

    address internal constant A = 0x1000000000000000000000000000000000000001;
    address internal constant B = 0x1000000000000000000000000000000000000002;
    address internal constant C = 0x1000000000000000000000000000000000000003;

    RingHarness internal ring;
    string internal out;
    address[] internal cps;
    bool internal firstStep;

    function setUp() public override {
        super.setUp();
        ring = new RingHarness();
    }

    // ------------------------------------------------------------------
    // JSON helpers
    // ------------------------------------------------------------------

    function _u(uint256 v) internal pure returns (string memory) {
        return string.concat('"', vm.toString(v), '"');
    }

    function _b(bool v) internal pure returns (string memory) {
        return v ? "true" : "false";
    }

    function _addr(address a) internal pure returns (string memory) {
        return string.concat('"', vm.toLowercase(vm.toString(a)), '"');
    }

    // ------------------------------------------------------------------
    // record() cases
    // ------------------------------------------------------------------

    function _recordCase(
        string memory name,
        uint32[] memory initDays,
        uint224[] memory initAmounts,
        uint256[] memory recDays,
        uint256[] memory recAmounts,
        uint256 sumToday,
        uint256 sumN,
        bool last
    ) internal {
        ring.clear();
        string memory init = "[";
        for (uint256 i; i < initDays.length; ++i) {
            ring.setSlot(initDays[i], initAmounts[i]);
            init = string.concat(init, i == 0 ? "" : ",", '{"dayIndex":', vm.toString(uint256(initDays[i])), ',"amount":', _u(initAmounts[i]), "}");
        }
        init = string.concat(init, "]");
        string memory recs = "[";
        for (uint256 i; i < recDays.length; ++i) {
            ring.record(recDays[i], recAmounts[i]);
            recs = string.concat(recs, i == 0 ? "" : ",", '{"today":', vm.toString(recDays[i]), ',"amount":', _u(recAmounts[i]), "}");
        }
        recs = string.concat(recs, "]");
        // Every non-empty slot after the writes, in index order.
        string memory slots = "[";
        bool any;
        for (uint256 i; i < RollingWindow.RING_SIZE; ++i) {
            (uint32 d, uint224 amt) = ring.slot(i);
            if (d == 0 && amt == 0) continue;
            slots = string.concat(slots, any ? "," : "", '{"index":', vm.toString(i), ',"dayIndex":', vm.toString(uint256(d)), ',"amount":', _u(amt), "}");
            any = true;
        }
        slots = string.concat(slots, "]");
        uint256 sum = ring.windowSum(sumToday, sumN);
        assertEq(sum, ring.referenceSum(sumToday, sumN > 90 ? 90 : sumN), name);
        out = string.concat(
            out,
            '  {"name":"',
            name,
            '","initialSlots":',
            init,
            ',"records":',
            recs,
            ',"slots":',
            slots,
            string.concat(',"sumToday":', vm.toString(sumToday), ',"sumPeriodDays":', vm.toString(sumN), ',"windowSum":', _u(sum), "}"),
            last ? "\n" : ",\n"
        );
    }

    function _u32(uint32 a) internal pure returns (uint32[] memory r) {
        r = new uint32[](1);
        r[0] = a;
    }

    function _u224(uint224 a) internal pure returns (uint224[] memory r) {
        r = new uint224[](1);
        r[0] = a;
    }

    function _u256(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    function _u256(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        r[0] = a;
        r[1] = b;
    }

    function _u256(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory r) {
        r = new uint256[](3);
        r[0] = a;
        r[1] = b;
        r[2] = c;
    }

    function _recordCases() internal {
        uint32[] memory none32 = new uint32[](0);
        uint224[] memory none224 = new uint224[](0);
        _recordCase("accumulate_same_day", none32, none224, _u256(D, D, D), _u256(100e6, 50e6, 1), D, 30, false);
        _recordCase("overwrite_stale_slot_same_index", _u32(D - 91), _u224(500e6), _u256(D), _u256(7), D, 90, false);
        _recordCase("overwrite_future_tagged_slot", _u32(D + 91), _u224(9), _u256(D), _u256(3), D, 30, false);
        _recordCase("separate_days_separate_slots", none32, none224, _u256(D - 2, D - 1, D), _u256(1, 2, 4), D, 1, false);
        _recordCase("record_zero_claims_slot", _u32(D - 91), _u224(8), _u256(D), _u256(0), D, 90, false);
        _recordCase("saturate_on_accumulate", none32, none224, _u256(D, D), _u256(uint256(MAX224) - 1, 5), D, 30, false);
        _recordCase("saturate_exact_boundary", none32, none224, _u256(D, D), _u256(uint256(MAX224) - 5, 5), D, 30, false);
        _recordCase("saturate_single_oversized", none32, none224, _u256(D), _u256(uint256(MAX224) + 10), D, 30, false);
        _recordCase("oversized_after_stale_overwrite", _u32(D - 91), _u224(4), _u256(D), _u256(type(uint256).max), D, 30, false);
        _recordCase("day_zero", none32, none224, _u256(0, 0), _u256(2, 3), 0, 30, true);
    }

    // ------------------------------------------------------------------
    // windowSum clamp cases (a PolicyWallet rejects N > 90, but the library clamps)
    // ------------------------------------------------------------------

    function _windowCase(string memory name, uint256 n, bool last) internal {
        ring.clear();
        // One slot per day D-95 .. D (the ring keeps the latest 91), amounts 1..96.
        string memory slots = "[";
        for (uint32 i; i < 96; ++i) {
            ring.setSlot(D - 95 + i, i + 1);
            slots = string.concat(slots, i == 0 ? "" : ",", '{"dayIndex":', vm.toString(uint256(D - 95 + i)), ',"amount":', _u(i + 1), "}");
        }
        slots = string.concat(slots, "]");
        uint256 sum = ring.windowSum(D, n);
        assertEq(sum, ring.referenceSum(D, 90), name);
        out = string.concat(
            out,
            '  {"name":"',
            name,
            '","slots":',
            slots,
            ',"today":',
            vm.toString(uint256(D)),
            ',"periodDays":',
            _u(n),
            ',"windowSum":',
            _u(sum),
            last ? "}\n" : "},\n"
        );
    }

    // ------------------------------------------------------------------
    // PolicyWallet cases
    // ------------------------------------------------------------------

    function _opName(uint8 op) internal pure returns (string memory) {
        if (op == WARP) return "warp";
        if (op == REGISTER) return "register";
        if (op == PAY) return "pay";
        if (op == TIGHTEN) return "tighten";
        if (op == SET_LIMIT) return "setLimit";
        if (op == PIN) return "pin";
        if (op == SET_POLICY_PERIOD) return "setPolicyPeriod";
        if (op == SET_FIRST_CONTACT_CEILING) return "setFirstContactCeiling";
        if (op == SET_WALLET_PERIOD_CAP) return "setWalletPeriodCap";
        return "setNewPayeeCap";
    }

    function _snapshot() internal view returns (string memory s) {
        s = "[";
        for (uint256 i; i < cps.length; ++i) {
            PolicyWallet.Remaining memory r = wallet.remaining(cps[i]);
            s = string.concat(
                s,
                i == 0 ? "" : ",",
                string.concat('{"counterparty":', _addr(cps[i]), ',"cpRemaining":', _u(r.cpRemaining), ',"walletRemaining":', _u(r.walletRemaining)),
                string.concat(',"newPayeeRemaining":', _u(r.newPayeeRemaining), ',"limit":', _u(r.limit), ',"pinned":', _b(r.pinned)),
                string.concat(',"registered":', _b(r.registered), ',"humanSet":', _b(r.humanSet), ',"humanEpoch":', _u(r.humanEpoch), "}")
            );
        }
        s = string.concat(s, "]");
    }

    function _begin(string memory name, address[] memory who) internal {
        // A fresh wallet on the Standard Preset at T0, funded for every payment.
        vm.warp(T0);
        wallet = new PolicyWalletHarness(
            PolicyWallet.Roles({human: human, payment: payment, registrar: registrar, model: model, rules: rules}), _preset(), false
        );
        _fund(1_000_000e6);
        delete cps;
        string memory list = "[";
        for (uint256 i; i < who.length; ++i) {
            cps.push(who[i]);
            list = string.concat(list, i == 0 ? "" : ",", _addr(who[i]));
        }
        list = string.concat(list, "]");
        PolicyWallet.Policy memory p = wallet.policy();
        out = string.concat(
            out,
            '  {"name":"',
            name,
            '","timestamp":',
            vm.toString(block.timestamp),
            string.concat(',"policy":{"firstContactCeiling":', _u(p.firstContactCeiling), ',"walletPeriodCap":', _u(p.walletPeriodCap)),
            string.concat(',"newPayeeCap":', _u(p.newPayeeCap), ',"policyPeriodDays":', _u(p.policyPeriodDays), "}"),
            ',"counterparties":',
            list,
            ',"initial":',
            _snapshot(),
            ',"steps":[\n'
        );
        firstStep = true;
    }

    function _step(uint8 op, address a, uint256 value) internal {
        if (op == WARP) {
            vm.warp(value);
        } else if (op == REGISTER) {
            vm.prank(registrar);
            wallet.register(a, value, RH);
        } else if (op == PAY) {
            vm.prank(payment);
            wallet.pay(a, value, RH);
        } else if (op == TIGHTEN) {
            uint256 epoch = wallet.remaining(a).humanEpoch;
            vm.prank(model);
            wallet.tighten(a, value, epoch, RH);
        } else if (op == SET_LIMIT) {
            vm.prank(human);
            wallet.setLimit(a, value, RH);
        } else if (op == PIN) {
            vm.prank(rules);
            wallet.pin(a, RH);
        } else if (op == SET_POLICY_PERIOD) {
            vm.prank(human);
            wallet.setPolicyPeriod(value, RH);
        } else if (op == SET_FIRST_CONTACT_CEILING) {
            vm.prank(human);
            wallet.setFirstContactCeiling(value, RH);
        } else if (op == SET_WALLET_PERIOD_CAP) {
            vm.prank(human);
            wallet.setWalletPeriodCap(value, RH);
        } else {
            vm.prank(human);
            wallet.setNewPayeeCap(value, RH);
        }
        out = string.concat(
            out,
            firstStep ? "" : ",\n",
            '    {"op":"',
            _opName(op),
            '","counterparty":',
            op == WARP || op >= SET_POLICY_PERIOD ? "null" : _addr(a),
            ',"value":',
            op == PIN ? "null" : _u(value),
            ',"remaining":',
            _snapshot(),
            "}"
        );
        firstStep = false;
    }

    function _end(bool last) internal {
        out = string.concat(out, last ? "\n  ]}\n" : "\n  ]},\n");
    }

    function _two(address a, address b) internal pure returns (address[] memory r) {
        r = new address[](2);
        r[0] = a;
        r[1] = b;
    }

    function _three(address a, address b, address c) internal pure returns (address[] memory r) {
        r = new address[](3);
        r[0] = a;
        r[1] = b;
        r[2] = c;
    }

    function _walletCases() internal {
        uint256 day = 1 days;

        // Registration, spend accumulation, window roll-off and new-payee recovery.
        _begin("register_pay_accumulate_and_roll_off", _two(A, B));
        _step(REGISTER, A, 100e6);
        _step(PAY, A, 30e6);
        _step(PAY, A, 70e6);
        _step(WARP, address(0), T0 + day);
        _step(REGISTER, B, 50e6);
        _step(PAY, B, 20e6);
        _step(WARP, address(0), T0 + 30 * day);
        _step(WARP, address(0), T0 + 31 * day);
        _step(WARP, address(0), T0 + 32 * day);
        _end(false);

        // First-Contact Ceiling vs humanSet: the ceiling caps a Registrar limit, never a Human one.
        _begin("ceiling_vs_human_set", _two(A, B));
        _step(REGISTER, A, 500e6);
        _step(SET_LIMIT, A, 800e6);
        _step(REGISTER, B, 300e6);
        _step(SET_FIRST_CONTACT_CEILING, address(0), 200e6);
        _step(PAY, B, 150e6);
        _step(PAY, A, 700e6);
        _step(SET_LIMIT, B, 0);
        _end(false);

        // Tighten only lowers; pin zeroes, pins and registers an unknown address without a new payee.
        _begin("tighten_and_pin", _two(A, B));
        _step(REGISTER, A, 400e6);
        _step(PAY, A, 100e6);
        _step(TIGHTEN, A, 250e6);
        _step(TIGHTEN, A, 500e6);
        _step(TIGHTEN, A, 50e6);
        _step(PIN, A, 0);
        _step(PIN, B, 0);
        _end(false);

        // The wallet cap is shared across Counterparties: one payment lowers every walletRemaining.
        _begin("wallet_cap_across_counterparties", _three(A, B, C));
        _step(SET_WALLET_PERIOD_CAP, address(0), 700e6);
        _step(REGISTER, A, 500e6);
        _step(REGISTER, B, 500e6);
        _step(PAY, A, 400e6);
        _step(PAY, B, 300e6);
        _step(REGISTER, C, 10e6);
        _step(WARP, address(0), T0 + 31 * day);
        _end(false);

        // New-Payee Cap: a zero Registration does not count; the count leaves the window after N + 1 days.
        _begin("new_payee_cap", _three(A, B, C));
        _step(SET_NEW_PAYEE_CAP, address(0), 2);
        _step(REGISTER, A, 10e6);
        _step(REGISTER, B, 0);
        _step(REGISTER, C, 10e6);
        _step(WARP, address(0), T0 + 30 * day);
        _step(WARP, address(0), T0 + 31 * day);
        _end(false);

        // Policy Period 1: the window is [today - 1, today].
        _begin("period_one_window_edges", _two(A, B));
        _step(SET_POLICY_PERIOD, address(0), 1);
        _step(REGISTER, A, 300e6);
        _step(PAY, A, 100e6);
        _step(WARP, address(0), T0 + day);
        _step(PAY, A, 50e6);
        _step(WARP, address(0), T0 + 2 * day - 1);
        _step(WARP, address(0), T0 + 2 * day);
        _step(WARP, address(0), T0 + 3 * day);
        _end(false);

        // Lengthening the Policy Period re-counts retained buckets; shortening drops them.
        _begin("period_change_recounts", _two(A, B));
        _step(REGISTER, A, 500e6);
        _step(PAY, A, 200e6);
        _step(WARP, address(0), T0 + 40 * day);
        _step(SET_POLICY_PERIOD, address(0), 90);
        _step(PAY, A, 100e6);
        _step(WARP, address(0), T0 + 90 * day);
        _step(WARP, address(0), T0 + 91 * day);
        _step(SET_POLICY_PERIOD, address(0), 30);
        _end(true);
    }

    function test_writeRemainingCompositionVectors() public {
        out = string.concat('{"ringSize":', vm.toString(RollingWindow.RING_SIZE), ',"recordCases":[\n');
        _recordCases();
        out = string.concat(out, '],"windowCases":[\n');
        _windowCase("period_91_clamped_to_90", 91, false);
        _windowCase("period_1000_clamped_to_90", 1000, false);
        _windowCase("period_max_uint_clamped_to_90", type(uint256).max, true);
        out = string.concat(out, '],"walletCases":[\n');
        _walletCases();
        out = string.concat(out, "]}\n");
        vm.writeFile(PATH, out);

        // Round-trip: the file parses and carries the case names and counts.
        string memory back = vm.readFile(PATH);
        assertEq(vm.parseJsonUint(back, ".ringSize"), 91);
        assertEq(vm.parseJsonString(back, ".recordCases[0].name"), "accumulate_same_day");
        assertEq(vm.parseJsonString(back, ".recordCases[0].windowSum"), "150000001");
        assertEq(vm.parseJsonString(back, ".windowCases[2].windowSum"), vm.toString(uint256(4186 + 5 * 91)));
        assertEq(vm.parseJsonString(back, ".walletCases[6].name"), "period_change_recounts");
    }
}
