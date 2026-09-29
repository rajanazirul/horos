// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {PolicyWallet} from "../src/PolicyWallet.sol";

/// @title DeployPolicyWallet
/// @notice Deploys a non-upgradeable PolicyWallet on the Standard Preset with `roleIsContract = false`.
/// @dev Role holders come from `HOROS_HUMAN`, `HOROS_PAYMENT`, `HOROS_REGISTRAR`, `HOROS_MODEL` and
///      `HOROS_RULES`. No sender is baked in: the signer is whatever `--account` the CLI passes, and it
///      only pays gas (the wallet has no owner, admin or factory besides the Human role).
///      Refuses to run on any chain except Arc testnet (5042002) and a local anvil chain (31337).
contract DeployPolicyWallet is Script {
    /// @notice Arc testnet chain id.
    uint256 public constant ARC_TESTNET_CHAIN_ID = 5_042_002;
    /// @notice Local anvil / forge test chain id.
    uint256 public constant LOCAL_CHAIN_ID = 31_337;

    /// @notice Standard Preset: First-Contact Ceiling, 500 USDC in 6-dp base units.
    uint256 public constant FIRST_CONTACT_CEILING = 500e6;
    /// @notice Standard Preset: Wallet Period Cap, 5,000 USDC in 6-dp base units.
    uint256 public constant WALLET_PERIOD_CAP = 5_000e6;
    /// @notice Standard Preset: New-Payee Cap per Policy Period.
    uint256 public constant NEW_PAYEE_CAP = 10;
    /// @notice Standard Preset: Policy Period in days.
    uint256 public constant POLICY_PERIOD_DAYS = 30;
    /// @notice Standard Preset: Unpin Delay in seconds.
    uint256 public constant UNPIN_DELAY = 24 hours;

    /// @notice The current chain is not Arc testnet or a local chain.
    error UnsupportedChain(uint256 chainId);
    /// @notice The broadcaster is one of the role holders; the deployer must only pay gas.
    error DeployerHoldsRole();
    /// @notice A value read back from the deployed wallet differs from the input.
    error ReadBackMismatch(string field);

    /// @notice The Standard Preset this script deploys with.
    /// @return The Policy values (amounts in 6-dp USDC base units).
    function standardPreset() public pure returns (PolicyWallet.Policy memory) {
        return PolicyWallet.Policy({
            firstContactCeiling: FIRST_CONTACT_CEILING,
            walletPeriodCap: WALLET_PERIOD_CAP,
            newPayeeCap: NEW_PAYEE_CAP,
            policyPeriodDays: POLICY_PERIOD_DAYS,
            unpinDelay: UNPIN_DELAY
        });
    }

    /// @notice Read the five role addresses from the environment, deploy, and check the read-backs.
    /// @return wallet The deployed PolicyWallet.
    function run() external returns (PolicyWallet wallet) {
        if (block.chainid != ARC_TESTNET_CHAIN_ID && block.chainid != LOCAL_CHAIN_ID) {
            revert UnsupportedChain(block.chainid);
        }

        PolicyWallet.Roles memory roles = PolicyWallet.Roles({
            human: vm.envAddress("HOROS_HUMAN"),
            payment: vm.envAddress("HOROS_PAYMENT"),
            registrar: vm.envAddress("HOROS_REGISTRAR"),
            model: vm.envAddress("HOROS_MODEL"),
            rules: vm.envAddress("HOROS_RULES")
        });
        PolicyWallet.Policy memory preset = standardPreset();

        vm.startBroadcast();
        if (
            msg.sender == roles.human || msg.sender == roles.payment || msg.sender == roles.registrar
                || msg.sender == roles.model || msg.sender == roles.rules
        ) revert DeployerHoldsRole();
        wallet = new PolicyWallet(roles, preset, false);
        vm.stopBroadcast();

        console2.log("PolicyWallet deployed at", address(wallet));

        _checkReadBacks(wallet, roles, preset);
    }

    function _checkReadBacks(PolicyWallet wallet, PolicyWallet.Roles memory roles, PolicyWallet.Policy memory preset)
        private
        view
    {
        if (address(wallet).code.length == 0) revert ReadBackMismatch("code");
        if (wallet.human() != roles.human) revert ReadBackMismatch("human");
        if (wallet.roleHolder(PolicyWallet.Role.Payment) != roles.payment) revert ReadBackMismatch("payment");
        if (wallet.roleHolder(PolicyWallet.Role.Registrar) != roles.registrar) revert ReadBackMismatch("registrar");
        if (wallet.roleHolder(PolicyWallet.Role.Model) != roles.model) revert ReadBackMismatch("model");
        if (wallet.roleHolder(PolicyWallet.Role.Rules) != roles.rules) revert ReadBackMismatch("rules");
        if (wallet.roleIsContract()) revert ReadBackMismatch("roleIsContract");
        if (wallet.pendingHuman() != address(0)) revert ReadBackMismatch("pendingHuman");

        PolicyWallet.Policy memory p = wallet.policy();
        if (p.firstContactCeiling != preset.firstContactCeiling) revert ReadBackMismatch("firstContactCeiling");
        if (p.walletPeriodCap != preset.walletPeriodCap) revert ReadBackMismatch("walletPeriodCap");
        if (p.newPayeeCap != preset.newPayeeCap) revert ReadBackMismatch("newPayeeCap");
        if (p.policyPeriodDays != preset.policyPeriodDays) revert ReadBackMismatch("policyPeriodDays");
        if (p.unpinDelay != preset.unpinDelay) revert ReadBackMismatch("unpinDelay");
    }
}
