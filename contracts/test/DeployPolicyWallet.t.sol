// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {PolicyWallet} from "../src/PolicyWallet.sol";
import {DeployPolicyWallet} from "../script/DeployPolicyWallet.s.sol";

/// @dev Story 1.7: runs the deploy script's `run()` in-process on the local chain id, and pins the
///      Demo-wallet fixture's codehash to the current build.
contract DeployPolicyWalletTest is Test {
    DeployPolicyWallet internal script;

    address internal human = makeAddr("human");
    address internal payment = makeAddr("payment");
    address internal registrar = makeAddr("registrar");
    address internal model = makeAddr("model");
    address internal rules = makeAddr("rules");

    /// @dev Env-free: tests other than `test_run_scenarios` must not touch `HOROS_*`.
    function setUp() public {
        script = new DeployPolicyWallet();
    }

    function _setRoles(address h, address p, address reg, address m, address r) internal {
        vm.setEnv("HOROS_HUMAN", vm.toString(h));
        vm.setEnv("HOROS_PAYMENT", vm.toString(p));
        vm.setEnv("HOROS_REGISTRAR", vm.toString(reg));
        vm.setEnv("HOROS_MODEL", vm.toString(m));
        vm.setEnv("HOROS_RULES", vm.toString(r));
    }

    /// @dev Called at the start of every scenario: valid distinct roles on the local chain id.
    function _reset() internal {
        vm.chainId(31_337);
        _setRoles(human, payment, registrar, model, rules);
    }

    /// @dev Environment variables are process-global and forge runs tests in parallel, so every
    ///      scenario that calls `run()` (and therefore reads or writes `HOROS_*`) is sequenced in
    ///      this one test instead of racing across several.
    function test_run_scenarios() public {
        _happyPath();
        _arcTestnetChainIdAllowed();
        _revertsOnWrongChain();
        _revertsOnDuplicateRole();
        _revertsWhenHumanDuplicatesRole();
        _revertsWhenDeployerHoldsRole();
        _revertsOnEmptyEnv();
        _revertsOnMalformedEnv();
    }

    function test_standardPreset_values() public view {
        PolicyWallet.Policy memory p = script.standardPreset();
        assertEq(p.firstContactCeiling, 500e6);
        assertEq(p.walletPeriodCap, 5_000e6);
        assertEq(p.newPayeeCap, 10);
        assertEq(p.policyPeriodDays, 30);
        assertEq(p.unpinDelay, 24 hours);
    }

    /// @dev A source or compiler change that alters the runtime code breaks the recorded Demo-wallet
    ///      evidence; this fails first. Runtime code is independent of the role addresses because
    ///      the only immutable, `roleIsContract`, is false.
    function test_fixtureCodehash_matchesBuild() public {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../fixtures/horos-demo-wallet.json"));
        PolicyWallet w = new PolicyWallet(
            PolicyWallet.Roles({human: human, payment: payment, registrar: registrar, model: model, rules: rules}),
            script.standardPreset(),
            false
        );
        assertEq(address(w).codehash, vm.parseJsonBytes32(json, ".codehash"));
    }

    function _happyPath() internal {
        _reset();
        PolicyWallet wallet = script.run();

        assertGt(address(wallet).code.length, 0);
        assertEq(wallet.human(), human);
        assertEq(wallet.roleHolder(PolicyWallet.Role.Payment), payment);
        assertEq(wallet.roleHolder(PolicyWallet.Role.Registrar), registrar);
        assertEq(wallet.roleHolder(PolicyWallet.Role.Model), model);
        assertEq(wallet.roleHolder(PolicyWallet.Role.Rules), rules);
        assertFalse(wallet.roleIsContract());
        assertEq(wallet.pendingHuman(), address(0));

        PolicyWallet.Policy memory p = wallet.policy();
        assertEq(p.firstContactCeiling, 500e6);
        assertEq(p.walletPeriodCap, 5_000e6);
        assertEq(p.newPayeeCap, 10);
        assertEq(p.policyPeriodDays, 30);
        assertEq(p.unpinDelay, 24 hours);
    }

    function _arcTestnetChainIdAllowed() internal {
        _reset();
        vm.chainId(5_042_002);
        PolicyWallet wallet = script.run();
        assertEq(wallet.human(), human);
    }

    function _revertsOnWrongChain() internal {
        _reset();
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(DeployPolicyWallet.UnsupportedChain.selector, uint256(1)));
        script.run();
    }

    function _revertsOnDuplicateRole() internal {
        _reset();
        _setRoles(human, payment, registrar, model, payment);
        vm.expectRevert(PolicyWallet.RoleConflict.selector);
        script.run();
        // Broadcast state is not journaled: the revert happened inside the script's broadcast.
        vm.stopBroadcast();
    }

    function _revertsWhenHumanDuplicatesRole() internal {
        _reset();
        _setRoles(human, payment, registrar, human, rules);
        vm.expectRevert(PolicyWallet.RoleConflict.selector);
        script.run();
        vm.stopBroadcast();
    }

    /// @dev In-process, `run()`'s msg.sender (the broadcaster) is this test contract.
    function _revertsWhenDeployerHoldsRole() internal {
        _reset();
        _setRoles(human, payment, registrar, model, address(this));
        vm.expectRevert(DeployPolicyWallet.DeployerHoldsRole.selector);
        script.run();
        vm.stopBroadcast();
    }

    function _revertsOnEmptyEnv() internal {
        _reset();
        vm.setEnv("HOROS_RULES", "");
        _expectEnvParseError();
    }

    function _revertsOnMalformedEnv() internal {
        _reset();
        vm.setEnv("HOROS_RULES", "0x123");
        _expectEnvParseError();
    }

    /// @dev The cheatcode error ends in a multi-line parser detail, so match its stable prefix.
    function _expectEnvParseError() internal {
        try script.run() {
            fail();
        } catch (bytes memory err) {
            assertTrue(
                vm.indexOf(string(err), "vm.envAddress: failed parsing $HOROS_RULES as type `address`")
                    != type(uint256).max,
                "unexpected revert reason"
            );
        }
    }
}
