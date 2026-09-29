// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {RollingWindow} from "../src/lib/RollingWindow.sol";
import {RingHarness} from "./harness/RingHarness.sol";

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
