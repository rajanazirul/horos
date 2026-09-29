// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {PolicyWallet} from "../../src/PolicyWallet.sol";
import {PolicyWalletHarness} from "../harness/PolicyWalletHarness.sol";
import {PolicyWalletInvariantBase} from "../invariant/PolicyWalletInvariant.t.sol";

/// @dev Story 1.6: the same handler and invariants over the real Arc USDC on a testnet fork, so
///      `pay` runs the real transfer (NativeCoinAuthority precompile). Needs Circle's arc-foundry;
///      skipped unless `ARC_FORK=true`:
///      `ARC_FORK=true arc-forge test --network arc --match-path 'test/fork/*'`.
/// forge-config: default.invariant.runs = 8
/// forge-config: default.invariant.depth = 25
contract PolicyWalletForkInvariantTest is PolicyWalletInvariantBase {
    string internal constant RPC = "https://rpc.testnet.arc.network";

    function setUp() public override {
        string memory flag = vm.envOr("ARC_FORK", string(""));
        bool enabled = keccak256(bytes(flag)) == keccak256("true") || keccak256(bytes(flag)) == keccak256("1");
        if (!enabled) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(RPC);
        wallet = new PolicyWalletHarness(
            PolicyWallet.Roles({human: human, payment: payment, registrar: registrar, model: model, rules: rules}),
            _preset(),
            false
        );
        _startHandler(true);
    }
}
