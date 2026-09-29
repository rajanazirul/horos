// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {PolicyWallet} from "../../src/PolicyWallet.sol";
import {PolicyWalletHarness} from "../harness/PolicyWalletHarness.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// @dev Has code, so it can stand in for a contract payee.
contract ContractPayee {
    receive() external payable {}
}

/// @dev Shared setup for the Story 1.4 unit tests: a harness wallet on the Standard Preset and
///      a MockUSDC etched at the Arc USDC address.
abstract contract WalletFixture is Test {
    PolicyWalletHarness internal wallet;
    MockUSDC internal usdc;

    address internal human = makeAddr("human");
    address internal payment = makeAddr("payment");
    address internal registrar = makeAddr("registrar");
    address internal model = makeAddr("model");
    address internal rules = makeAddr("rules");
    address internal stranger = makeAddr("stranger");
    address internal cp = makeAddr("counterparty");

    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    bytes32 internal constant RH = keccak256("record");
    uint256 internal constant CEILING = 500e6;
    uint256 internal constant WALLET_CAP = 5_000e6;
    uint256 internal constant NEW_PAYEE_CAP = 10;
    uint256 internal constant PERIOD = 30;

    /// 2026-09-25 12:00 UTC (day index 20,721).
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

    function setUp() public virtual {
        vm.warp(T0);
        wallet = new PolicyWalletHarness(
            PolicyWallet.Roles({human: human, payment: payment, registrar: registrar, model: model, rules: rules}),
            _preset(),
            false
        );
        vm.etch(USDC, address(new MockUSDC()).code);
        usdc = MockUSDC(USDC);
    }

    function _cp(uint256 limit, bool pinned, bool humanSet) internal pure returns (PolicyWallet.Counterparty memory) {
        return PolicyWallet.Counterparty({
            registered: true, pinned: pinned, humanSet: humanSet, humanEpoch: 0, unpinRequestedAt: 0, limit: limit
        });
    }

    function _register(address a, uint256 l) internal {
        vm.prank(registrar);
        wallet.register(a, l, RH);
    }

    function _pay(address a, uint256 amount) internal {
        vm.prank(payment);
        wallet.pay(a, amount, RH);
    }

    function _fund(uint256 amount) internal {
        usdc.mint(address(wallet), amount);
    }

    function _today() internal view returns (uint256) {
        return vm.getBlockTimestamp() / 1 days;
    }
}
