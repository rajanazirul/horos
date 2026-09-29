// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {PolicyWallet} from "../src/PolicyWallet.sol";

contract PolicyWalletPolicyTest is Test {
    PolicyWallet internal wallet;

    address internal human = makeAddr("human");
    address internal payment = makeAddr("payment");
    address internal registrar = makeAddr("registrar");
    address internal model = makeAddr("model");
    address internal rules = makeAddr("rules");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant RH = keccak256("record");

    event PolicyChanged(PolicyWallet.PolicyField field, uint256 oldValue, uint256 newValue, bytes32 recordHash);

    function _preset() internal pure returns (PolicyWallet.Policy memory) {
        return PolicyWallet.Policy({
            firstContactCeiling: 500e6,
            walletPeriodCap: 5_000e6,
            newPayeeCap: 10,
            policyPeriodDays: 30,
            unpinDelay: 24 hours
        });
    }

    function setUp() public {
        wallet = new PolicyWallet(
            PolicyWallet.Roles({human: human, payment: payment, registrar: registrar, model: model, rules: rules}),
            _preset(),
            false
        );
    }

    /// Encodes the setter for `field` with `value`.
    function _call(PolicyWallet.PolicyField field, uint256 value) internal pure returns (bytes memory) {
        if (field == PolicyWallet.PolicyField.FirstContactCeiling) {
            return abi.encodeCall(PolicyWallet.setFirstContactCeiling, (value, RH));
        }
        if (field == PolicyWallet.PolicyField.WalletPeriodCap) {
            return abi.encodeCall(PolicyWallet.setWalletPeriodCap, (value, RH));
        }
        if (field == PolicyWallet.PolicyField.NewPayeeCap) {
            return abi.encodeCall(PolicyWallet.setNewPayeeCap, (value, RH));
        }
        if (field == PolicyWallet.PolicyField.PolicyPeriodDays) {
            return abi.encodeCall(PolicyWallet.setPolicyPeriod, (value, RH));
        }
        return abi.encodeCall(PolicyWallet.setUnpinDelay, (value, RH));
    }

    function _read(PolicyWallet.PolicyField field) internal view returns (uint256) {
        PolicyWallet.Policy memory p = wallet.policy();
        if (field == PolicyWallet.PolicyField.FirstContactCeiling) return p.firstContactCeiling;
        if (field == PolicyWallet.PolicyField.WalletPeriodCap) return p.walletPeriodCap;
        if (field == PolicyWallet.PolicyField.NewPayeeCap) return p.newPayeeCap;
        if (field == PolicyWallet.PolicyField.PolicyPeriodDays) return p.policyPeriodDays;
        return p.unpinDelay;
    }

    /// A valid new value per field, different from the preset (a raise for some, a lower for others).
    function _valid(PolicyWallet.PolicyField field) internal pure returns (uint256) {
        if (field == PolicyWallet.PolicyField.FirstContactCeiling) return 250e6;
        if (field == PolicyWallet.PolicyField.WalletPeriodCap) return 20_000e6;
        if (field == PolicyWallet.PolicyField.NewPayeeCap) return 3;
        if (field == PolicyWallet.PolicyField.PolicyPeriodDays) return 7;
        return 48 hours;
    }

    function _field(uint256 i) internal pure returns (PolicyWallet.PolicyField) {
        return PolicyWallet.PolicyField(i);
    }

    // ------------------------------------------------------------------
    // Human sets each value
    // ------------------------------------------------------------------

    function test_setters_humanSetsEachValueAndEmits() public {
        for (uint256 i; i < 5; ++i) {
            PolicyWallet.PolicyField f = _field(i);
            uint256 old = _read(f);
            uint256 v = _valid(f);
            vm.expectEmit(address(wallet));
            emit PolicyChanged(f, old, v, RH);
            vm.prank(human);
            (bool ok,) = address(wallet).call(_call(f, v));
            assertTrue(ok);
            assertEq(_read(f), v);
        }
    }

    function test_setters_onlyTargetFieldChanges() public {
        vm.prank(human);
        wallet.setNewPayeeCap(3, RH);
        PolicyWallet.Policy memory p = wallet.policy();
        assertEq(p.firstContactCeiling, 500e6);
        assertEq(p.walletPeriodCap, 5_000e6);
        assertEq(p.newPayeeCap, 3);
        assertEq(p.policyPeriodDays, 30);
        assertEq(p.unpinDelay, 24 hours);
    }

    function test_setters_humanCanRaiseAndLower() public {
        vm.startPrank(human);
        wallet.setFirstContactCeiling(1_000e6, RH);
        assertEq(wallet.policy().firstContactCeiling, 1_000e6);
        wallet.setFirstContactCeiling(1, RH);
        assertEq(wallet.policy().firstContactCeiling, 1);
        wallet.setFirstContactCeiling(0, RH);
        assertEq(wallet.policy().firstContactCeiling, 0);
        wallet.setWalletPeriodCap(type(uint256).max, RH);
        assertEq(wallet.policy().walletPeriodCap, type(uint256).max);
        vm.stopPrank();
    }

    function test_setters_sameValueStillEmits() public {
        for (uint256 i; i < 5; ++i) {
            PolicyWallet.PolicyField f = _field(i);
            uint256 cur = _read(f);
            vm.expectEmit(address(wallet));
            emit PolicyChanged(f, cur, cur, RH);
            vm.prank(human);
            (bool ok,) = address(wallet).call(_call(f, cur));
            assertTrue(ok);
            assertEq(_read(f), cur);
        }
    }

    // ------------------------------------------------------------------
    // Non-Human callers
    // ------------------------------------------------------------------

    function test_setters_everyNonHumanRoleReverts() public {
        address[5] memory callers = [payment, registrar, model, rules, stranger];
        for (uint256 i; i < 5; ++i) {
            PolicyWallet.PolicyField f = _field(i);
            uint256 before = _read(f);
            for (uint256 j; j < callers.length; ++j) {
                vm.prank(callers[j]);
                (bool ok, bytes memory ret) = address(wallet).call(_call(f, _valid(f)));
                assertFalse(ok);
                assertEq(bytes4(ret), PolicyWallet.Unauthorized.selector);
            }
            assertEq(_read(f), before);
        }
    }

    function test_setters_pendingHumanReverts() public {
        address next = makeAddr("nextHuman");
        vm.prank(human);
        wallet.transferOwnership(next, RH);
        vm.prank(next);
        vm.expectRevert(PolicyWallet.Unauthorized.selector);
        wallet.setWalletPeriodCap(1, RH);
    }

    function test_setters_newHumanAfterTransferCanSet_oldCannot() public {
        address next = makeAddr("nextHuman");
        vm.prank(human);
        wallet.transferOwnership(next, RH);
        vm.prank(next);
        wallet.acceptOwnership(RH);

        vm.prank(human);
        vm.expectRevert(PolicyWallet.Unauthorized.selector);
        wallet.setWalletPeriodCap(1, RH);

        vm.prank(next);
        wallet.setWalletPeriodCap(1, RH);
        assertEq(wallet.policy().walletPeriodCap, 1);
    }

    function test_setters_humanWithCodeRejected() public {
        vm.etch(human, hex"00");
        vm.prank(human);
        vm.expectRevert(PolicyWallet.Unauthorized.selector);
        wallet.setNewPayeeCap(1, RH);
    }

    function testFuzz_setters_nonHumanReverts(address caller, uint8 fi, uint256 v) public {
        vm.assume(caller != human);
        PolicyWallet.PolicyField f = _field(bound(fi, 0, 4));
        vm.prank(caller);
        (bool ok, bytes memory ret) = address(wallet).call(_call(f, v));
        assertFalse(ok);
        assertEq(bytes4(ret), PolicyWallet.Unauthorized.selector);
    }

    // ------------------------------------------------------------------
    // Bounds
    // ------------------------------------------------------------------

    function test_setPolicyPeriod_bounds() public {
        vm.startPrank(human);
        vm.expectRevert(PolicyWallet.InvalidPolicy.selector);
        wallet.setPolicyPeriod(0, RH);
        vm.expectRevert(PolicyWallet.InvalidPolicy.selector);
        wallet.setPolicyPeriod(91, RH);
        vm.expectRevert(PolicyWallet.InvalidPolicy.selector);
        wallet.setPolicyPeriod(type(uint256).max, RH);

        wallet.setPolicyPeriod(1, RH);
        assertEq(wallet.policy().policyPeriodDays, 1);
        wallet.setPolicyPeriod(90, RH);
        assertEq(wallet.policy().policyPeriodDays, 90);
        vm.stopPrank();
    }

    function test_setUnpinDelay_bounds() public {
        vm.startPrank(human);
        vm.expectRevert(PolicyWallet.InvalidPolicy.selector);
        wallet.setUnpinDelay(1 hours - 1, RH);
        vm.expectRevert(PolicyWallet.InvalidPolicy.selector);
        wallet.setUnpinDelay(0, RH);

        wallet.setUnpinDelay(1 hours, RH);
        assertEq(wallet.policy().unpinDelay, 1 hours);
        wallet.setUnpinDelay(type(uint256).max, RH);
        assertEq(wallet.policy().unpinDelay, type(uint256).max);
        vm.stopPrank();
    }

    function test_bounds_nonHumanGetsUnauthorizedNotInvalidPolicy() public {
        // Authorization is checked before validation.
        vm.prank(rules);
        vm.expectRevert(PolicyWallet.Unauthorized.selector);
        wallet.setPolicyPeriod(0, RH);
    }

    function testFuzz_setPolicyPeriod(uint256 d) public {
        vm.prank(human);
        if (d == 0 || d > 90) {
            vm.expectRevert(PolicyWallet.InvalidPolicy.selector);
            wallet.setPolicyPeriod(d, RH);
            assertEq(wallet.policy().policyPeriodDays, 30);
        } else {
            wallet.setPolicyPeriod(d, RH);
            assertEq(wallet.policy().policyPeriodDays, d);
        }
    }

    function testFuzz_setUnpinDelay(uint256 s) public {
        vm.prank(human);
        if (s < 1 hours) {
            vm.expectRevert(PolicyWallet.InvalidPolicy.selector);
            wallet.setUnpinDelay(s, RH);
            assertEq(wallet.policy().unpinDelay, 24 hours);
        } else {
            wallet.setUnpinDelay(s, RH);
            assertEq(wallet.policy().unpinDelay, s);
        }
    }

    function test_setters_notPayable() public {
        vm.deal(human, 1 ether);
        for (uint256 i; i < 5; ++i) {
            PolicyWallet.PolicyField f = _field(i);
            vm.prank(human);
            (bool ok,) = address(wallet).call{value: 1}(_call(f, _valid(f)));
            assertFalse(ok);
        }
        assertEq(address(wallet).balance, 0);
    }
}
