// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {PolicyWallet} from "../src/PolicyWallet.sol";

/// @dev Rejects every native transfer, to exercise `WithdrawFailed`.
contract RejectingReceiver {
    receive() external payable {
        revert();
    }
}

contract PolicyWalletTest is Test {
    PolicyWallet internal wallet;

    address internal human = makeAddr("human");
    address internal payment = makeAddr("payment");
    address internal registrar = makeAddr("registrar");
    address internal model = makeAddr("model");
    address internal rules = makeAddr("rules");
    address internal stranger = makeAddr("stranger");

    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    bytes32 internal constant RH = keccak256("record");

    event RoleGranted(PolicyWallet.Role role, address account, bytes32 recordHash);
    event RoleRevoked(PolicyWallet.Role role, address account, bytes32 recordHash);
    event OwnershipTransferStarted(address from, address to, bytes32 recordHash);
    event OwnershipTransferred(address from, address to, bytes32 recordHash);
    event Withdrawn(address to, uint256 amount, bytes32 recordHash);

    function _roles() internal view returns (PolicyWallet.Roles memory) {
        return PolicyWallet.Roles({human: human, payment: payment, registrar: registrar, model: model, rules: rules});
    }

    /// Standard Preset: 500 USDC / 5,000 USDC / 10 payees / 30 days / 24h.
    function _preset() internal pure returns (PolicyWallet.Policy memory) {
        return PolicyWallet.Policy({
            firstContactCeiling: 500e6,
            walletPeriodCap: 5_000e6,
            newPayeeCap: 10,
            policyPeriodDays: 30,
            unpinDelay: 24 hours
        });
    }

    function _rolesArray(PolicyWallet.Roles memory r) internal pure returns (address[5] memory) {
        return [r.human, r.payment, r.registrar, r.model, r.rules];
    }

    function _rolesFrom(address[5] memory a) internal pure returns (PolicyWallet.Roles memory) {
        return PolicyWallet.Roles({human: a[0], payment: a[1], registrar: a[2], model: a[3], rules: a[4]});
    }

    function _deploy(PolicyWallet.Roles memory r, PolicyWallet.Policy memory p, bool rc)
        internal
        returns (PolicyWallet)
    {
        return new PolicyWallet(r, p, rc);
    }

    function setUp() public {
        wallet = _deploy(_roles(), _preset(), false);
    }

    // ------------------------------------------------------------------
    // Deploy
    // ------------------------------------------------------------------

    function test_deploy_gettersReturnInputs() public view {
        assertEq(wallet.human(), human);
        assertEq(wallet.pendingHuman(), address(0));
        assertEq(wallet.roleHolder(PolicyWallet.Role.Payment), payment);
        assertEq(wallet.roleHolder(PolicyWallet.Role.Registrar), registrar);
        assertEq(wallet.roleHolder(PolicyWallet.Role.Model), model);
        assertEq(wallet.roleHolder(PolicyWallet.Role.Rules), rules);
        assertFalse(wallet.roleIsContract());
        assertEq(wallet.USDC(), USDC);
        assertEq(wallet.MAX_POLICY_PERIOD_DAYS(), 90);

        PolicyWallet.Policy memory p = wallet.policy();
        assertEq(p.firstContactCeiling, 500e6);
        assertEq(p.walletPeriodCap, 5_000e6);
        assertEq(p.newPayeeCap, 10);
        assertEq(p.policyPeriodDays, 30);
        assertEq(p.unpinDelay, 24 hours);
    }

    function test_deploy_roleIsContractStored() public {
        PolicyWallet w = _deploy(_roles(), _preset(), true);
        assertTrue(w.roleIsContract());
    }

    function test_deploy_policyBoundsAccepted() public {
        PolicyWallet.Policy memory p = _preset();
        p.policyPeriodDays = 1;
        p.unpinDelay = 1 hours;
        _deploy(_roles(), p, false);
        p.policyPeriodDays = 90;
        _deploy(_roles(), p, false);
    }

    function test_deploy_duplicateRole_everyPair() public {
        uint256 pairs;
        for (uint256 i; i < 5; ++i) {
            for (uint256 j = i + 1; j < 5; ++j) {
                address[5] memory a = _rolesArray(_roles());
                a[j] = a[i];
                vm.expectRevert(PolicyWallet.RoleConflict.selector);
                this.deployExternal(_rolesFrom(a), _preset());
                ++pairs;
            }
        }
        assertEq(pairs, 10);
    }

    function test_deploy_invalidRole_eachSlot() public {
        for (uint256 b; b < 3; ++b) {
            for (uint256 i; i < 5; ++i) {
                // Re-predict every attempt: a failed CREATE may still bump the nonce.
                address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
                address[3] memory bad = [address(0), USDC, predicted];
                address[5] memory a = _rolesArray(_roles());
                a[i] = bad[b];
                vm.expectRevert(PolicyWallet.RoleConflict.selector);
                new PolicyWallet(_rolesFrom(a), _preset(), false);
            }
        }
    }

    function test_deploy_badPolicy() public {
        PolicyWallet.Policy memory p = _preset();
        p.policyPeriodDays = 0;
        vm.expectRevert(PolicyWallet.InvalidPolicy.selector);
        this.deployExternal(_roles(), p);

        p.policyPeriodDays = 91;
        vm.expectRevert(PolicyWallet.InvalidPolicy.selector);
        this.deployExternal(_roles(), p);

        p = _preset();
        p.unpinDelay = 1 hours - 1;
        vm.expectRevert(PolicyWallet.InvalidPolicy.selector);
        this.deployExternal(_roles(), p);
    }

    function deployExternal(PolicyWallet.Roles memory r, PolicyWallet.Policy memory p) external returns (PolicyWallet) {
        return new PolicyWallet(r, p, false);
    }

    // ------------------------------------------------------------------
    // Deposits and payable surface
    // ------------------------------------------------------------------

    function test_deposit_anyoneCanSend() public {
        vm.deal(stranger, 5 ether);
        vm.prank(stranger);
        (bool ok,) = address(wallet).call{value: 2 ether}("");
        assertTrue(ok);
        assertEq(address(wallet).balance, 2 ether);

        vm.deal(payment, 1 ether);
        vm.prank(payment);
        (ok,) = address(wallet).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(wallet).balance, 3 ether);
    }

    function test_payableProbe_unknownSelectorReverts() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(wallet).call{value: 1}(abi.encodeWithSelector(bytes4(0xdeadbeef)));
        assertFalse(ok);
    }

    function test_payableProbe_withdrawNotPayable() public {
        vm.deal(human, 1 ether);
        vm.prank(human);
        (bool ok,) = address(wallet).call{value: 1}(abi.encodeCall(PolicyWallet.withdraw, (human, RH)));
        assertFalse(ok);
    }

    function test_payableProbe_mutatorsNotPayable() public {
        address next = makeAddr("nextHuman");
        vm.deal(human, 1 ether);
        vm.startPrank(human);
        (bool ok,) = address(wallet).call{value: 1}(
            abi.encodeCall(PolicyWallet.grantRole, (PolicyWallet.Role.Model, stranger, RH))
        );
        assertFalse(ok);
        (ok,) = address(wallet).call{value: 1}(abi.encodeCall(PolicyWallet.revokeRole, (PolicyWallet.Role.Model, RH)));
        assertFalse(ok);
        (ok,) = address(wallet).call{value: 1}(abi.encodeCall(PolicyWallet.transferOwnership, (next, RH)));
        assertFalse(ok);
        wallet.transferOwnership(next, RH);
        vm.stopPrank();

        vm.deal(next, 1 ether);
        vm.prank(next);
        (ok,) = address(wallet).call{value: 1}(abi.encodeCall(PolicyWallet.acceptOwnership, (RH)));
        assertFalse(ok);

        // Same calls without value succeed, so the failures above are due to value.
        vm.prank(next);
        wallet.acceptOwnership(RH);
        assertEq(wallet.human(), next);
        assertEq(address(wallet).balance, 0);
    }

    function test_payableProbe_constructorNotPayable() public {
        bytes memory initCode =
            abi.encodePacked(type(PolicyWallet).creationCode, abi.encode(_roles(), _preset(), false));
        vm.deal(address(this), 1 ether);
        address withValue;
        address withoutValue;
        assembly {
            withValue := create(1, add(initCode, 0x20), mload(initCode))
            withoutValue := create(0, add(initCode, 0x20), mload(initCode))
        }
        assertEq(withValue, address(0));
        assertTrue(withoutValue != address(0));
    }

    function testFuzz_payableProbe_nonEmptyDataReverts(uint256 v, bytes calldata data) public {
        vm.assume(data.length > 0);
        v = bound(v, 1, 1_000 ether);
        vm.deal(stranger, v);
        vm.prank(stranger);
        (bool ok,) = address(wallet).call{value: v}(data);
        assertFalse(ok);
        assertEq(address(wallet).balance, 0);
    }

    function test_surface_forbiddenSelectorsRevert() public {
        bytes[] memory calls = new bytes[](7);
        calls[0] = abi.encodeWithSignature("approve(address,uint256)", stranger, 1);
        calls[1] = abi.encodeWithSignature("execute(address,uint256,bytes)", stranger, 0, "");
        calls[2] = abi.encodeWithSignature("isValidSignature(bytes32,bytes)", RH, "");
        calls[3] = abi.encodeWithSignature("renounceOwnership()");
        calls[4] = abi.encodeWithSignature(
            "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)", human, stranger, 1, 1, 27, RH, RH
        );
        calls[5] = abi.encodeWithSignature("multicall(bytes[])", new bytes[](0));
        calls[6] = abi.encodeWithSignature("upgradeToAndCall(address,bytes)", stranger, "");
        for (uint256 i; i < calls.length; ++i) {
            vm.prank(human);
            (bool ok,) = address(wallet).call(calls[i]);
            assertFalse(ok);
        }
    }

    // ------------------------------------------------------------------
    // Withdraw
    // ------------------------------------------------------------------

    function test_withdraw_sweepsWholeBalanceIncludingDust() public {
        uint256 amount = 7e18 + 123;
        vm.deal(address(wallet), amount);
        address to = makeAddr("sink");

        vm.expectEmit(address(wallet));
        emit Withdrawn(to, amount, RH);
        vm.prank(human);
        wallet.withdraw(to, RH);

        assertEq(to.balance, amount);
        assertEq(address(wallet).balance, 0);
    }

    function test_withdraw_zeroTargetReverts() public {
        vm.deal(address(wallet), 1 ether);
        vm.prank(human);
        vm.expectRevert(PolicyWallet.RoleConflict.selector);
        wallet.withdraw(address(0), RH);
    }

    function test_withdraw_failedCallReverts() public {
        RejectingReceiver r = new RejectingReceiver();
        vm.deal(address(wallet), 1 ether);
        vm.prank(human);
        vm.expectRevert(PolicyWallet.WithdrawFailed.selector);
        wallet.withdraw(address(r), RH);
        assertEq(address(wallet).balance, 1 ether);
    }

    function test_withdraw_byOtherRolesReverts() public {
        vm.deal(address(wallet), 1 ether);
        address[5] memory others = [payment, registrar, model, rules, stranger];
        for (uint256 i; i < 5; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(PolicyWallet.Unauthorized.selector);
            wallet.withdraw(others[i], RH);
        }
        assertEq(address(wallet).balance, 1 ether);
    }

    function testFuzz_depositThenWithdraw_leavesZero(uint256 a, uint256 b) public {
        a = bound(a, 0, 1e30);
        b = bound(b, 0, 1e30);
        vm.deal(stranger, a + b);
        vm.startPrank(stranger);
        (bool ok,) = address(wallet).call{value: a}("");
        assertTrue(ok);
        (ok,) = address(wallet).call{value: b}("");
        assertTrue(ok);
        vm.stopPrank();

        address to = makeAddr("sink");
        vm.prank(human);
        wallet.withdraw(to, RH);
        assertEq(address(wallet).balance, 0);
        assertEq(to.balance, a + b);
    }

    // ------------------------------------------------------------------
    // Non-Human callers (fuzz)
    // ------------------------------------------------------------------

    function testFuzz_nonHumanCannotMutate(address caller, address account, uint8 r) public {
        vm.assume(caller != human);
        assumeNotForgeAddress(caller);
        PolicyWallet.Role role = PolicyWallet.Role(bound(r, 0, 3));
        vm.deal(address(wallet), 1 ether);

        vm.startPrank(caller);
        vm.expectRevert(PolicyWallet.Unauthorized.selector);
        wallet.withdraw(caller, RH);
        vm.expectRevert(PolicyWallet.Unauthorized.selector);
        wallet.grantRole(role, account, RH);
        vm.expectRevert(PolicyWallet.Unauthorized.selector);
        wallet.revokeRole(role, RH);
        vm.expectRevert(PolicyWallet.Unauthorized.selector);
        wallet.transferOwnership(account, RH);
        vm.expectRevert(PolicyWallet.Unauthorized.selector);
        wallet.acceptOwnership(RH);
        vm.stopPrank();

        assertEq(address(wallet).balance, 1 ether);
        assertEq(wallet.human(), human);
    }

    // ------------------------------------------------------------------
    // grantRole / revokeRole
    // ------------------------------------------------------------------

    function test_grant_conflictWithOtherHolderOrHuman() public {
        vm.startPrank(human);
        vm.expectRevert(PolicyWallet.RoleConflict.selector);
        wallet.grantRole(PolicyWallet.Role.Model, payment, RH);
        vm.expectRevert(PolicyWallet.RoleConflict.selector);
        wallet.grantRole(PolicyWallet.Role.Model, human, RH);
        vm.expectRevert(PolicyWallet.RoleConflict.selector);
        wallet.grantRole(PolicyWallet.Role.Model, rules, RH);
        vm.stopPrank();
    }

    function test_grant_invalidAccounts() public {
        address[3] memory bad = [address(0), USDC, address(wallet)];
        vm.startPrank(human);
        for (uint256 i; i < 3; ++i) {
            vm.expectRevert(PolicyWallet.RoleConflict.selector);
            wallet.grantRole(PolicyWallet.Role.Payment, bad[i], RH);
        }
        vm.stopPrank();
    }

    function test_grant_replacesHolderWithTwoEvents() public {
        address fresh = makeAddr("freshModel");
        vm.expectEmit(address(wallet));
        emit RoleRevoked(PolicyWallet.Role.Model, model, RH);
        vm.expectEmit(address(wallet));
        emit RoleGranted(PolicyWallet.Role.Model, fresh, RH);
        vm.prank(human);
        wallet.grantRole(PolicyWallet.Role.Model, fresh, RH);
        assertEq(wallet.roleHolder(PolicyWallet.Role.Model), fresh);

        // Old holder is now free to be granted elsewhere.
        vm.prank(human);
        wallet.revokeRole(PolicyWallet.Role.Rules, RH);
        vm.prank(human);
        wallet.grantRole(PolicyWallet.Role.Rules, model, RH);
        assertEq(wallet.roleHolder(PolicyWallet.Role.Rules), model);
    }

    function test_grant_intoVacantSlotEmitsOnlyGranted() public {
        vm.prank(human);
        wallet.revokeRole(PolicyWallet.Role.Registrar, RH);

        address fresh = makeAddr("freshRegistrar");
        vm.recordLogs();
        vm.prank(human);
        wallet.grantRole(PolicyWallet.Role.Registrar, fresh, RH);
        assertEq(vm.getRecordedLogs().length, 1);
        assertEq(wallet.roleHolder(PolicyWallet.Role.Registrar), fresh);
    }

    function test_revoke_thenRevokeAgainReverts() public {
        vm.expectEmit(address(wallet));
        emit RoleRevoked(PolicyWallet.Role.Registrar, registrar, RH);
        vm.prank(human);
        wallet.revokeRole(PolicyWallet.Role.Registrar, RH);
        assertEq(wallet.roleHolder(PolicyWallet.Role.Registrar), address(0));

        vm.prank(human);
        vm.expectRevert(PolicyWallet.RoleVacant.selector);
        wallet.revokeRole(PolicyWallet.Role.Registrar, RH);
    }

    function test_revokeAllRoles_humanStillOperates() public {
        vm.startPrank(human);
        for (uint8 i; i < 4; ++i) {
            wallet.revokeRole(PolicyWallet.Role(i), RH);
        }
        vm.stopPrank();
        vm.deal(address(wallet), 1 ether);
        vm.prank(human);
        wallet.withdraw(human, RH);
        assertEq(human.balance, 1 ether);
        vm.prank(human);
        wallet.grantRole(PolicyWallet.Role.Payment, payment, RH);
        assertEq(wallet.roleHolder(PolicyWallet.Role.Payment), payment);
    }

    // ------------------------------------------------------------------
    // Two-step ownership
    // ------------------------------------------------------------------

    function test_ownership_twoStep() public {
        address next = makeAddr("nextHuman");
        vm.expectEmit(address(wallet));
        emit OwnershipTransferStarted(human, next, RH);
        vm.prank(human);
        wallet.transferOwnership(next, RH);
        assertEq(wallet.pendingHuman(), next);
        assertEq(wallet.human(), human);

        vm.prank(stranger);
        vm.expectRevert(PolicyWallet.Unauthorized.selector);
        wallet.acceptOwnership(RH);

        vm.expectEmit(address(wallet));
        emit OwnershipTransferred(human, next, RH);
        vm.prank(next);
        wallet.acceptOwnership(RH);
        assertEq(wallet.human(), next);
        assertEq(wallet.pendingHuman(), address(0));

        // Old Human lost its powers.
        vm.deal(address(wallet), 1 ether);
        vm.prank(human);
        vm.expectRevert(PolicyWallet.Unauthorized.selector);
        wallet.withdraw(human, RH);
        vm.prank(human);
        vm.expectRevert(PolicyWallet.Unauthorized.selector);
        wallet.grantRole(PolicyWallet.Role.Model, stranger, RH);

        // New Human has them.
        vm.prank(next);
        wallet.withdraw(next, RH);
        assertEq(next.balance, 1 ether);
    }

    function test_ownership_acceptWithoutPendingReverts() public {
        vm.prank(human);
        vm.expectRevert(PolicyWallet.Unauthorized.selector);
        wallet.acceptOwnership(RH);
    }

    function test_ownership_transferConflicts() public {
        address[8] memory bad = [human, payment, registrar, model, rules, address(0), USDC, address(wallet)];
        vm.startPrank(human);
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(PolicyWallet.RoleConflict.selector);
            wallet.transferOwnership(bad[i], RH);
        }
        vm.stopPrank();
    }

    function test_ownership_pendingHasNoHumanPowers() public {
        address next = makeAddr("nextHuman");
        vm.prank(human);
        wallet.transferOwnership(next, RH);
        vm.deal(address(wallet), 1 ether);

        vm.startPrank(next);
        vm.expectRevert(PolicyWallet.Unauthorized.selector);
        wallet.withdraw(next, RH);
        vm.expectRevert(PolicyWallet.Unauthorized.selector);
        wallet.grantRole(PolicyWallet.Role.Model, stranger, RH);
        vm.stopPrank();
        assertEq(address(wallet).balance, 1 ether);
        assertEq(wallet.roleHolder(PolicyWallet.Role.Model), model);
    }

    function test_ownership_pendingCannotBeGrantedRole() public {
        address next = makeAddr("nextHuman");
        vm.prank(human);
        wallet.transferOwnership(next, RH);

        vm.prank(human);
        vm.expectRevert(PolicyWallet.RoleConflict.selector);
        wallet.grantRole(PolicyWallet.Role.Model, next, RH);
    }

    function test_ownership_proposalCanBeOverwritten() public {
        address a = makeAddr("a");
        address b = makeAddr("b");
        vm.startPrank(human);
        wallet.transferOwnership(a, RH);
        wallet.transferOwnership(b, RH);
        vm.stopPrank();
        assertEq(wallet.pendingHuman(), b);

        vm.prank(a);
        vm.expectRevert(PolicyWallet.Unauthorized.selector);
        wallet.acceptOwnership(RH);
    }

    // ------------------------------------------------------------------
    // Caller-code rule
    // ------------------------------------------------------------------

    function test_codeCaller_humanRejected() public {
        vm.etch(human, hex"00");
        vm.deal(address(wallet), 1 ether);

        vm.startPrank(human);
        vm.expectRevert(PolicyWallet.Unauthorized.selector);
        wallet.withdraw(human, RH);
        vm.expectRevert(PolicyWallet.Unauthorized.selector);
        wallet.grantRole(PolicyWallet.Role.Model, stranger, RH);
        vm.expectRevert(PolicyWallet.Unauthorized.selector);
        wallet.revokeRole(PolicyWallet.Role.Model, RH);
        vm.expectRevert(PolicyWallet.Unauthorized.selector);
        wallet.transferOwnership(stranger, RH);
        vm.stopPrank();
    }

    function test_codeCaller_pendingHumanRejected() public {
        address next = makeAddr("nextHuman");
        vm.prank(human);
        wallet.transferOwnership(next, RH);
        vm.etch(next, hex"00");

        vm.prank(next);
        vm.expectRevert(PolicyWallet.Unauthorized.selector);
        wallet.acceptOwnership(RH);
    }

    function test_codeAccount_constructorHumanRejected() public {
        vm.etch(human, hex"00");
        vm.expectRevert(PolicyWallet.RoleConflict.selector);
        this.deployExternal(_roles(), _preset());
        // Allowed when role holders may be contracts.
        PolicyWallet w = _deploy(_roles(), _preset(), true);
        assertEq(w.human(), human);
    }

    function test_codeAccount_grantTargetRejected() public {
        address c = makeAddr("contractModel");
        vm.etch(c, hex"00");
        vm.prank(human);
        vm.expectRevert(PolicyWallet.RoleConflict.selector);
        wallet.grantRole(PolicyWallet.Role.Model, c, RH);
        assertEq(wallet.roleHolder(PolicyWallet.Role.Model), model);
    }

    function test_codeAccount_transferTargetRejected() public {
        address c = makeAddr("contractHuman");
        vm.etch(c, hex"00");
        vm.prank(human);
        vm.expectRevert(PolicyWallet.RoleConflict.selector);
        wallet.transferOwnership(c, RH);
        assertEq(wallet.pendingHuman(), address(0));
    }

    function test_codeAccount_allowedWhenRoleIsContract() public {
        PolicyWallet w = _deploy(_roles(), _preset(), true);
        address cModel = makeAddr("contractModel");
        address cHuman = makeAddr("contractHuman");
        vm.etch(cModel, hex"00");
        vm.etch(cHuman, hex"00");
        vm.startPrank(human);
        w.grantRole(PolicyWallet.Role.Model, cModel, RH);
        w.transferOwnership(cHuman, RH);
        vm.stopPrank();
        assertEq(w.roleHolder(PolicyWallet.Role.Model), cModel);
        vm.prank(cHuman);
        w.acceptOwnership(RH);
        assertEq(w.human(), cHuman);
    }

    function test_codeCaller_allowedWhenRoleIsContract() public {
        PolicyWallet w = _deploy(_roles(), _preset(), true);
        vm.etch(human, hex"00");
        vm.deal(address(w), 1 ether);
        address to = makeAddr("sink");
        vm.prank(human);
        w.withdraw(to, RH);
        assertEq(to.balance, 1 ether);
    }
}
