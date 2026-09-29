// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {PolicyWallet} from "../../src/PolicyWallet.sol";

interface IFiatToken {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
    function permit(address, address, uint256, uint256, uint8, bytes32, bytes32) external;
    function transferWithAuthorization(address, address, uint256, uint256, uint256, bytes32, uint8, bytes32, bytes32)
        external;
    function blacklister() external view returns (address);
    function blacklist(address) external;
    function isBlacklisted(address) external view returns (bool);
}

/// @dev Story 1.6: the AD-5 Arc facts (day-1 probe, `day-1-checks/ArcDay1.t.sol`) re-proven against a
///      real PolicyWallet on an Arc testnet fork. Needs Circle's arc-foundry; skipped unless
///      `ARC_FORK=true`: `ARC_FORK=true arc-forge test --network arc --match-path 'test/fork/*'`.
contract ArcSurfaceForkTest is Test {
    IFiatToken internal constant USDC = IFiatToken(0x3600000000000000000000000000000000000000);
    string internal constant RPC = "https://rpc.testnet.arc.network";
    bytes32 internal constant RH = keccak256("fork-surface-record");
    uint256 internal constant CEILING = 500e6;
    /// @dev ERC-1271 `isValidSignature(bytes32,bytes)`.
    bytes4 internal constant IS_VALID_SIGNATURE = 0x1626ba7e;
    /// @dev Arc's native blocklist rejects any value movement to a blacklisted address with this
    ///      reason, for the ERC-20 `transfer` and a plain native send alike (observed on the fork).
    bytes internal constant BLOCKED = abi.encodeWithSignature("Error(string)", "Blocked address");

    PolicyWallet internal wallet;
    address internal human = makeAddr("surface-human");
    address internal payment = makeAddr("surface-payment");
    address internal registrar = makeAddr("surface-registrar");
    address internal model = makeAddr("surface-model");
    address internal rules = makeAddr("surface-rules");
    address internal payee = makeAddr("surface-payee");

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
        vm.deal(address(wallet), 1_000 ether); // 1,000 USDC in 18-dp native units
    }

    /// @notice The wallet never grants an allowance: it has no approve, permit or Permit2 path.
    /// forge-config: default.fuzz.runs = 64
    function testFuzz_fork_allowanceAlwaysZero(address spender) public view {
        assertEq(USDC.allowance(address(wallet), spender), 0);
    }

    /// @notice The wallet has no ERC-1271: `isValidSignature` reverts with no data (no such function and
    ///         no fallback), so no signature can ever validate on its behalf.
    function test_fork_walletHasNoErc1271() public view {
        (bool ok, bytes memory ret) =
            address(wallet).staticcall(abi.encodeWithSelector(IS_VALID_SIGNATURE, keccak256("any"), bytes("")));
        assertFalse(ok, "isValidSignature must revert");
        assertEq(ret.length, 0, "empty revert: the function does not exist");
    }

    /// @notice A permit on behalf of the wallet cannot validate (the wallet has no key and no ERC-1271).
    function test_fork_permitOnBehalfOfWalletReverts() public {
        vm.expectRevert(bytes("EIP2612: invalid signature"));
        USDC.permit(
            address(wallet), address(this), 1e6, block.timestamp + 1, 27, bytes32(uint256(1)), bytes32(uint256(2))
        );
        assertEq(USDC.allowance(address(wallet), address(this)), 0);
    }

    /// @notice An EIP-3009 transfer out of the wallet cannot validate either.
    function test_fork_transferWithAuthorizationFromWalletReverts() public {
        uint256 before = USDC.balanceOf(address(wallet));
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        USDC.transferWithAuthorization(
            address(wallet),
            address(this),
            1e6,
            0,
            block.timestamp + 1,
            bytes32(uint256(9)),
            27,
            bytes32(uint256(1)),
            bytes32(uint256(2))
        );
        assertEq(USDC.balanceOf(address(wallet)), before);
    }

    /// @notice `balanceOf(wallet)` is the native balance at 6 dp (one ledger).
    function testFuzz_fork_balanceOfMirrorsNative(uint256 x) public {
        x = bound(x, 0, 1e36);
        vm.deal(address(wallet), x);
        assertEq(USDC.balanceOf(address(wallet)), address(wallet).balance / 1e12);
        assertEq(USDC.balanceOf(address(wallet)), x / 1e12);
    }

    /// @notice A blacklisted payee can be neither paid nor withdrawn to. The first `pay` is the
    ///         control: the same payee is payable before the blacklist. `pay` bubbles Arc's
    ///         "Blocked address"; `withdraw`'s failed native send surfaces as `WithdrawFailed`.
    function test_fork_blacklistedPayeeBlocksPayAndWithdraw() public {
        vm.prank(registrar);
        wallet.register(payee, CEILING, RH);
        vm.prank(payment);
        wallet.pay(payee, 1e6, RH);
        assertEq(USDC.balanceOf(payee), 1e6);

        vm.prank(USDC.blacklister());
        USDC.blacklist(payee);
        assertTrue(USDC.isBlacklisted(payee));

        uint256 native = address(wallet).balance;

        vm.prank(payment);
        vm.expectRevert(BLOCKED);
        wallet.pay(payee, 1e6, RH);

        vm.prank(human);
        vm.expectRevert(PolicyWallet.WithdrawFailed.selector);
        wallet.withdraw(payee, RH);

        assertEq(address(wallet).balance, native, "nothing left the wallet");
        assertEq(USDC.balanceOf(payee), 1e6, "payee received nothing more");
    }

    /// @notice The blocklist is Arc-wide, not wallet-specific: an ordinary EOA can send a blacklisted
    ///         address neither native value nor an ERC-20 `transfer`.
    function test_fork_eoaTransfersToBlacklistedRevert() public {
        address bad = makeAddr("surface-blacklisted");
        address eoa = makeAddr("surface-eoa");
        vm.deal(eoa, 10 ether);
        vm.prank(USDC.blacklister());
        USDC.blacklist(bad);

        vm.prank(eoa);
        (bool ok, bytes memory ret) = bad.call{value: 1 ether}("");
        assertFalse(ok, "native send to a blacklisted address must revert");
        assertEq(ret, BLOCKED);

        vm.prank(eoa);
        vm.expectRevert(BLOCKED);
        USDC.transfer(bad, 1e6);

        assertEq(eoa.balance, 10 ether, "the EOA kept everything");
        assertEq(bad.balance, 0);
    }

    /// @notice Control for the withdraw revert above: a Human withdraw to a clean address sweeps everything.
    function test_fork_withdrawToCleanAddressSweeps() public {
        address to = makeAddr("surface-clean");
        uint256 walletBefore = address(wallet).balance;
        uint256 toBefore = to.balance;
        uint256 toTokenBefore = USDC.balanceOf(to);

        vm.prank(human);
        wallet.withdraw(to, RH);

        assertEq(address(wallet).balance, 0, "wallet swept");
        assertEq(USDC.balanceOf(address(wallet)), 0, "token view swept");
        assertEq(to.balance - toBefore, walletBefore, "recipient gained the whole native balance");
        assertEq(USDC.balanceOf(to) - toTokenBefore, walletBefore / 1e12, "recipient token view mirrors it");
    }
}
