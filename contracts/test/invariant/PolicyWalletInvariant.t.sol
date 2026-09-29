// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {console} from "forge-std/console.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {PolicyWallet} from "../../src/PolicyWallet.sol";
import {WalletFixture, ContractPayee} from "../base/WalletFixture.sol";
import {
    WalletHandler,
    IBalanceOf,
    P_NO_RAISE,
    P_CEILING,
    P_WINDOW,
    P_BALANCE_EXITS,
    P_STALE_EPOCH,
    P_HUMAN_EPOCH,
    P_PIN,
    P_REGISTERED,
    P_NEW_PAYEE_CAP,
    P_UNAUTHORIZED,
    P_EXACT,
    PROP_COUNT
} from "./WalletHandler.sol";

/// @dev Story 1.6: the Only-Tighten invariant suite (FR-20). The handler drives every role plus
///      arbitrary callers and checks transition properties after each call; the `invariant_*`
///      functions check end-state properties. Shared by the upstream suite (MockUSDC) and the Arc
///      fork suite (real USDC, `PolicyWalletForkInvariant.t.sol`).
abstract contract PolicyWalletInvariantBase is WalletFixture {
    uint256 internal constant INITIAL_FUNDING = 20_000e6;

    /// @dev The USDC balance view: the etched MockUSDC upstream, the real FiatToken on a fork.
    IBalanceOf internal constant TOKEN = IBalanceOf(0x3600000000000000000000000000000000000000);

    WalletHandler internal handler;

    function _startHandler(bool realUsdc) internal {
        ContractPayee payee = new ContractPayee();
        handler = new WalletHandler(wallet, realUsdc, address(payee), INITIAL_FUNDING);

        bytes4[] memory sels = new bytes4[](21);
        sels[0] = WalletHandler.register.selector;
        sels[1] = WalletHandler.pay.selector;
        sels[2] = WalletHandler.tighten.selector;
        sels[3] = WalletHandler.pin.selector;
        sels[4] = WalletHandler.releasePin.selector;
        sels[5] = WalletHandler.setLimit.selector;
        sels[6] = WalletHandler.requestUnpin.selector;
        sels[7] = WalletHandler.executeUnpin.selector;
        sels[8] = WalletHandler.setFirstContactCeiling.selector;
        sels[9] = WalletHandler.setWalletPeriodCap.selector;
        sels[10] = WalletHandler.setNewPayeeCap.selector;
        sels[11] = WalletHandler.setPolicyPeriod.selector;
        sels[12] = WalletHandler.setUnpinDelay.selector;
        sels[13] = WalletHandler.withdraw.selector;
        sels[14] = WalletHandler.grantRole.selector;
        sels[15] = WalletHandler.revokeRole.selector;
        sels[16] = WalletHandler.transferOwnership.selector;
        sels[17] = WalletHandler.acceptOwnership.selector;
        sels[18] = WalletHandler.deposit.selector;
        sels[19] = WalletHandler.warp.selector;
        sels[20] = WalletHandler.arbitrary.selector;

        targetContract(address(handler));
        // The handler pranks every role itself, so who calls it is irrelevant. A fixed EOA sender is
        // required on an Arc fork: forge's default sender set trips Arc's blocklist validation
        // ("transaction validation error: Blocked address") before the first run.
        targetSender(makeAddr("invariant-sender"));
        targetSelector(StdInvariant.FuzzSelector({addr: address(handler), selectors: sels}));
    }

    // ------------------------------------------------------------------
    // Invariants
    // ------------------------------------------------------------------

    // Transition properties: the handler checks each one right after every call and records the
    // first failure (with its reason and action) under that property's flag.

    function _assertHeld(uint256 prop) internal view {
        assertFalse(handler.violated(prop), handler.violation(prop));
    }

    /// @notice No non-Human call raised a limit or changed the Policy (a first Registration up to the
    ///         ceiling excepted), including from a pinned or zero pre-state.
    function invariant_noNonHumanRaise() public view {
        _assertHeld(P_NO_RAISE);
    }

    /// @notice An automated `register` never stored a limit above the First-Contact Ceiling in force.
    function invariant_registrationWithinCeiling() public view {
        _assertHeld(P_CEILING);
    }

    /// @notice After every `pay`, the Counterparty's window spend <= its Effective Limit and the wallet's
    ///         window spend <= the Wallet Period Cap (window `[today - N, today]`).
    function invariant_windowSpendWithinLimits() public view {
        _assertHeld(P_WINDOW);
    }

    /// @notice Balances fall only through `pay` (token by exactly `amount`) and `withdraw` (native to 0).
    function invariant_balanceExitsOnlyViaPayOrWithdraw() public view {
        _assertHeld(P_BALANCE_EXITS);
    }

    /// @notice A successful `tighten` always carried `expectedEpoch == humanEpoch`.
    function invariant_staleEpochRejected() public view {
        _assertHeld(P_STALE_EPOCH);
    }

    /// @notice No non-Human call changed `humanEpoch` or `humanSet`.
    function invariant_humanEpochOnlyByHuman() public view {
        _assertHeld(P_HUMAN_EPOCH);
    }

    /// @notice Only `pin` sets a pin, only `releasePin` clears one (among non-Human calls), both only on
    ///         their target, `unpinRequestedAt` moves only by their clearing it, and `pin` leaves limit 0.
    function invariant_pinStateOnlyByRules() public view {
        _assertHeld(P_PIN);
    }

    /// @notice Among non-Human calls, `registered` flips only by `register` / `pin` on the target.
    function invariant_registrationOnlyByRegisterOrPin() public view {
        _assertHeld(P_REGISTERED);
    }

    /// @notice New (limit > 0) Registrations in the window never exceed the New-Payee Cap.
    function invariant_newPayeeCapRespected() public view {
        _assertHeld(P_NEW_PAYEE_CAP);
    }

    /// @notice A caller without the role never succeeds at any mutator.
    function invariant_unauthorizedCallersRejected() public view {
        _assertHeld(P_UNAUTHORIZED);
    }

    /// @notice `register` stores exactly the requested limit and `tighten` exactly `min(before, requested)`.
    function invariant_transitionsExact() public view {
        _assertHeld(P_EXACT);
    }

    // End-state properties.

    /// @notice Human, pending Human and the four slots are pairwise distinct and never 0, the
    ///         wallet or USDC (vacant slots and no pending Human excepted).
    function invariant_rolesDistinctAndValid() public view {
        address[6] memory r = [
            wallet.human(),
            wallet.pendingHuman(),
            wallet.roleHolder(PolicyWallet.Role.Payment),
            wallet.roleHolder(PolicyWallet.Role.Registrar),
            wallet.roleHolder(PolicyWallet.Role.Model),
            wallet.roleHolder(PolicyWallet.Role.Rules)
        ];
        assertTrue(r[0] != address(0), "Human is never vacant");
        for (uint256 i; i < 6; ++i) {
            if (r[i] == address(0)) continue;
            assertTrue(r[i] != address(wallet) && r[i] != USDC, "role is the wallet or USDC");
            for (uint256 j = i + 1; j < 6; ++j) {
                assertTrue(r[i] != r[j], "two roles share a holder");
            }
        }
    }

    /// @notice `pinned => limit == 0` over the pool and the invalid addresses.
    function invariant_pinnedImpliesZeroLimit() public view {
        for (uint256 i; i < handler.TRACKED_COUNT(); ++i) {
            PolicyWallet.Counterparty memory c = wallet.rawCounterparty(handler.tracked(i));
            if (c.pinned) assertEq(c.limit, 0, "pinned Counterparty has a non-zero limit");
        }
    }

    /// @notice `remaining(a)` never reverts, for the pool and the invalid addresses.
    function invariant_remainingNeverReverts() public view {
        for (uint256 i; i < handler.TRACKED_COUNT(); ++i) {
            try wallet.remaining(handler.tracked(i)) {}
            catch {
                assertTrue(false, "remaining() reverted");
            }
        }
    }

    /// @notice Balances cover the ghost ledgers: native >= deposits - withdrawals, and the token
    ///         balance >= minted - paid.
    function invariant_balancesCoverGhost() public view {
        uint256 nIn = handler.ghostNativeIn();
        uint256 nOut = handler.ghostNativeOut();
        uint256 tIn = handler.ghostTokenIn();
        uint256 tOut = handler.ghostTokenOut();
        assertLe(nOut, nIn, "ghost native out exceeds in");
        assertLe(tOut, tIn, "ghost token out exceeds in");
        assertGe(address(wallet).balance, nIn - nOut, "native below ghost");
        assertGe(TOKEN.balanceOf(address(wallet)), tIn - tOut, "token below ghost");
    }

    /// @notice Per-action success counts (for `arbitrary`, the count of rejected calls).
    function afterInvariant() public view {
        console.log("WalletHandler successful calls per action:");
        for (uint256 i; i < handler.ACTION_COUNT(); ++i) {
            console.log("  %s: %d", handler.actionName(i), handler.successes(i));
        }
    }

    // ------------------------------------------------------------------
    // Vacuity guard
    // ------------------------------------------------------------------

    /// @notice Each of the 21 handler actions succeeds when driven once with valid inputs (for
    ///         `arbitrary`: is rejected with `Unauthorized`), with no property flagged. It proves the
    ///         handler can reach every action; the per-run counts come from `afterInvariant`.
    function test_handlerNotVacuous() public {
        handler.deposit(1 ether);
        handler.register(0, 100e6 + 1); // pool-0 at 100.000001 USDC
        handler.pay(0, 1);
        handler.tighten(0, 50e6, 2, false); // current epoch, by Model
        handler.setLimit(1, 200e6);
        handler.pin(2);
        handler.releasePin(2);
        handler.pin(2);
        handler.requestUnpin(2);
        handler.warp(2 days);
        handler.executeUnpin(2);
        handler.setFirstContactCeiling(600e6);
        handler.setWalletPeriodCap(6_000e6);
        handler.setNewPayeeCap(11);
        handler.setPolicyPeriod(31);
        handler.setUnpinDelay(2 hours + 1);
        handler.withdraw(1);
        handler.grantRole(0);
        handler.revokeRole(1);
        handler.transferOwnership();
        handler.acceptOwnership();
        handler.arbitrary(0, 15, 0); // the stranger calls register

        for (uint256 p; p < PROP_COUNT; ++p) {
            _assertHeld(p);
        }
        for (uint256 i; i < handler.ACTION_COUNT(); ++i) {
            assertGt(handler.successes(i), 0, handler.actionName(i));
        }
    }
}

/// @dev Upstream Foundry: MockUSDC etched at `0x3600…`, Standard Preset, runs at the
///      `[invariant]` defaults in `foundry.toml` (256 runs x depth 50).
contract PolicyWalletInvariantTest is PolicyWalletInvariantBase {
    function setUp() public override {
        super.setUp();
        _startHandler(false);
    }
}
