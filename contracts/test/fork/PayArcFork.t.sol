// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {PolicyWallet} from "../../src/PolicyWallet.sol";

interface IFiatToken {
    function balanceOf(address) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/// @dev Runs `pay` against the real Arc USDC on a testnet fork. Every USDC `transfer` calls Arc's
///      NativeCoinAuthority precompile, which only Circle's arc-foundry implements, so these tests
///      are skipped unless `ARC_FORK=true`:
///      `ARC_FORK=true arc-forge test --network arc --match-path 'test/fork/*'`.
contract PayArcForkTest is Test {
    IFiatToken internal constant USDC = IFiatToken(0x3600000000000000000000000000000000000000);
    string internal constant RPC = "https://rpc.testnet.arc.network";
    bytes32 internal constant RH = keccak256("fork-record");
    uint256 internal constant CEILING = 500e6;

    PolicyWallet internal wallet;
    address internal human = makeAddr("fork-human");
    address internal payment = makeAddr("fork-payment");
    address internal registrar = makeAddr("fork-registrar");
    address internal model = makeAddr("fork-model");
    address internal rules = makeAddr("fork-rules");
    address internal payee = makeAddr("fork-payee");

    function setUp() public {
        string memory flag = vm.envOr("ARC_FORK", string(""));
        bool enabled = keccak256(bytes(flag)) == keccak256("true") || keccak256(bytes(flag)) == keccak256("1");
        if (!enabled) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(RPC);
        wallet = new PolicyWallet(
            PolicyWallet.Roles({human: human, payment: payment, registrar: registrar, model: model, rules: rules}),
            PolicyWallet.Policy({
                firstContactCeiling: CEILING,
                walletPeriodCap: 5_000e6,
                newPayeeCap: 10,
                policyPeriodDays: 30,
                unpinDelay: 24 hours
            }),
            false
        );
        vm.deal(address(wallet), 2_000 ether); // 2,000 USDC in 18-dp native units
        vm.prank(registrar);
        wallet.register(payee, CEILING, RH);
    }

    function test_fork_usdcIsSixDecimals() public view {
        assertEq(USDC.decimals(), 6);
        assertEq(USDC.balanceOf(address(wallet)), 2_000e6);
    }

    function test_fork_payExactRemainingThenOneMoreReverts() public {
        PolicyWallet.Remaining memory r = wallet.remaining(payee);
        uint256 amount = r.cpRemaining < r.walletRemaining ? r.cpRemaining : r.walletRemaining;
        assertEq(amount, CEILING);

        uint256 payeeBefore = USDC.balanceOf(payee);
        uint256 nativeBefore = address(wallet).balance;

        vm.expectEmit(address(wallet));
        emit PolicyWallet.Paid(payee, amount, RH);
        vm.prank(payment);
        wallet.pay(payee, amount, RH);

        PolicyWallet.Remaining memory after_ = wallet.remaining(payee);
        assertEq(after_.cpRemaining, r.cpRemaining - amount, "cpRemaining drops by amount");
        assertEq(after_.walletRemaining, r.walletRemaining - amount, "walletRemaining drops by amount");

        assertEq(USDC.balanceOf(payee), payeeBefore + amount, "payee USDC balanceOf rises by amount");
        assertEq(address(wallet).balance, nativeBefore - amount * 1e12, "wallet native balance falls by amount x 1e12");
        assertEq(USDC.balanceOf(address(wallet)), (nativeBefore - amount * 1e12) / 1e12, "6-dp view mirrors native");

        vm.prank(payment);
        vm.expectRevert(PolicyWallet.LimitExceeded.selector);
        wallet.pay(payee, 1, RH);
    }

    function test_fork_payUnregisteredReverts() public {
        vm.prank(payment);
        vm.expectRevert(PolicyWallet.NotRegistered.selector);
        wallet.pay(makeAddr("fork-unregistered"), 1, RH);
    }
}
