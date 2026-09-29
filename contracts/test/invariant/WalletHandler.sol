// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {PolicyWallet} from "../../src/PolicyWallet.sol";
import {PolicyWalletHarness} from "../harness/PolicyWalletHarness.sol";

interface IBalanceOf {
    function balanceOf(address) external view returns (uint256);
}

interface IMintable {
    function mint(address, uint256) external;
}

// Ghost properties. Each one has its own flag and its own `invariant_*` function.
/// @dev No non-Human call raised a limit or changed the Policy (a first Registration up to the ceiling excepted).
uint256 constant P_NO_RAISE = 0;
/// @dev An automated `register` never stored a limit above the ceiling in force.
uint256 constant P_CEILING = 1;
/// @dev After each `pay`, the Counterparty and wallet window spends are within the Effective Limit and the cap.
uint256 constant P_WINDOW = 2;
/// @dev Balances fall only through `pay` (by exactly `amount`) and `withdraw` (native to 0).
uint256 constant P_BALANCE_EXITS = 3;
/// @dev A successful `tighten` always carried the current Human epoch.
uint256 constant P_STALE_EPOCH = 4;
/// @dev No non-Human call changed `humanEpoch` or `humanSet`.
uint256 constant P_HUMAN_EPOCH = 5;
/// @dev `pinned` / `unpinRequestedAt` move only by `pin` / `releasePin` on the target; `pin` leaves limit 0.
uint256 constant P_PIN = 6;
/// @dev `registered` flips only by `register` / `pin` on the target.
uint256 constant P_REGISTERED = 7;
/// @dev New (limit > 0) Registrations in the window never exceed the New-Payee Cap.
uint256 constant P_NEW_PAYEE_CAP = 8;
/// @dev A caller without the role never succeeds.
uint256 constant P_UNAUTHORIZED = 9;
/// @dev `register` stores exactly the requested limit; `tighten` stores exactly `min(before, requested)`.
uint256 constant P_EXACT = 10;
uint256 constant PROP_COUNT = 11;

/// @dev Story 1.6 invariant handler. Drives every role of one `PolicyWalletHarness` plus arbitrary
///      callers, and checks the FR-20 transition properties right after each call (see the spec's
///      "Ghost checks"). A check failure never reverts: it sets that property's flag and records the
///      first reason, which the matching `invariant_*` reports. Every call is a low-level call, so a
///      revert is never a failure (`fail_on_revert = false`).
///      Works with the MockUSDC etched at `0x3600…` (upstream Foundry, `realUsdc = false`) or with
///      the real Arc USDC on a fork (arc-forge, `realUsdc = true`). On Arc the native balance and
///      the ERC-20 `balanceOf` are one ledger; in mock mode `deposit` mints the matching 6-dp
///      tokens so the two ledgers move together in the same way.
contract WalletHandler is CommonBase, StdCheats, StdUtils {
    // ------------------------------------------------------------------
    // Actions. IDs 0..17 are the wallet mutators; `arbitrary` reuses them.
    // ------------------------------------------------------------------

    uint256 internal constant REGISTER = 0;
    uint256 internal constant PAY = 1;
    uint256 internal constant TIGHTEN = 2;
    uint256 internal constant PIN = 3;
    uint256 internal constant RELEASE_PIN = 4;
    uint256 internal constant SET_LIMIT = 5; // first Human action
    uint256 internal constant REQUEST_UNPIN = 6;
    uint256 internal constant EXECUTE_UNPIN = 7;
    uint256 internal constant SET_CEILING = 8;
    uint256 internal constant SET_WALLET_CAP = 9;
    uint256 internal constant SET_NEW_PAYEE_CAP = 10;
    uint256 internal constant SET_POLICY_PERIOD = 11;
    uint256 internal constant SET_UNPIN_DELAY = 12;
    uint256 internal constant WITHDRAW = 13;
    uint256 internal constant GRANT_ROLE = 14;
    uint256 internal constant REVOKE_ROLE = 15;
    uint256 internal constant TRANSFER_OWNERSHIP = 16; // last Human action
    uint256 internal constant ACCEPT_OWNERSHIP = 17;
    uint256 internal constant MUTATOR_COUNT = 18;
    uint256 internal constant DEPOSIT = 18;
    uint256 internal constant WARP = 19;
    uint256 internal constant ARBITRARY = 20;
    uint256 public constant ACTION_COUNT = 21;

    uint256 internal constant POOL_SIZE = 8;
    uint256 public constant TRACKED_COUNT = 12; // 8 EOAs, 1 contract payee, 0, the wallet, USDC
    uint256 internal constant MAX_FORMER = 16;

    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    bytes32 internal constant RH = keccak256("invariant-record");

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------

    PolicyWalletHarness public immutable wallet;
    bool public immutable realUsdc;
    address public immutable stranger;
    address public immutable depositor;
    address public immutable sink;

    address[TRACKED_COUNT] internal _tracked;
    address[] internal _former;
    uint256 internal _freshNonce;

    bool[PROP_COUNT] internal _violated;
    string[PROP_COUNT] internal _violation;

    string[ACTION_COUNT] internal _names;
    uint256[ACTION_COUNT] internal _successes;

    /// @dev Ghost ledgers for `invariant_balancesCoverGhost` (native 18-dp, token 6-dp).
    uint256 public ghostNativeIn;
    uint256 public ghostNativeOut;
    uint256 public ghostTokenIn;
    uint256 public ghostTokenOut;

    struct PayRecord {
        uint256 day;
        address cp;
        uint256 amount;
    }

    PayRecord[] internal _ledger;

    /// @dev Day index of every successful `register` with `l > 0`.
    uint256[] internal _newPayeeDays;

    struct Snap {
        PolicyWallet.Counterparty[TRACKED_COUNT] cps;
        PolicyWallet.Policy policy;
        uint256 native;
        uint256 token;
    }

    struct Args {
        address a;
        uint256 x;
        uint256 y;
    }

    /// @param wallet_ The wallet under test; its roles must be EOAs.
    /// @param realUsdc_ True on an Arc fork (real USDC), false with the etched MockUSDC.
    /// @param contractPayee A code-bearing payee (only the Human can make it payable).
    /// @param initialFunding USDC to fund the wallet with, 6-dp base units.
    constructor(PolicyWalletHarness wallet_, bool realUsdc_, address contractPayee, uint256 initialFunding) {
        wallet = wallet_;
        realUsdc = realUsdc_;
        stranger = makeAddr("handler-stranger");
        depositor = makeAddr("handler-depositor");
        sink = makeAddr("handler-sink");

        for (uint256 i; i < POOL_SIZE; ++i) {
            _tracked[i] = makeAddr(string.concat("pool-", vm.toString(i)));
        }
        _tracked[8] = contractPayee;
        _tracked[9] = address(0);
        _tracked[10] = address(wallet_);
        _tracked[11] = USDC;

        _names = [
            "register",
            "pay",
            "tighten",
            "pin",
            "releasePin",
            "setLimit",
            "requestUnpin",
            "executeUnpin",
            "setFirstContactCeiling",
            "setWalletPeriodCap",
            "setNewPayeeCap",
            "setPolicyPeriod",
            "setUnpinDelay",
            "withdraw",
            "grantRole",
            "revokeRole",
            "transferOwnership",
            "acceptOwnership",
            "deposit",
            "warp",
            "arbitrary (rejected)"
        ];

        // Whatever the address already holds (a fork) counts as funded, so the ledgers start exact.
        ghostNativeIn = address(wallet_).balance;
        ghostTokenIn = IBalanceOf(USDC).balanceOf(address(wallet_));
        if (realUsdc_) {
            vm.deal(address(wallet_), address(wallet_).balance + initialFunding * 1e12);
            ghostNativeIn += initialFunding * 1e12;
        } else {
            IMintable(USDC).mint(address(wallet_), initialFunding);
        }
        ghostTokenIn += initialFunding;
    }

    // ------------------------------------------------------------------
    // Views for the invariant contract
    // ------------------------------------------------------------------

    function tracked(uint256 i) external view returns (address) {
        return _tracked[i];
    }

    function actionName(uint256 i) external view returns (string memory) {
        return _names[i];
    }

    function successes(uint256 i) external view returns (uint256) {
        return _successes[i];
    }

    function violated(uint256 p) external view returns (bool) {
        return _violated[p];
    }

    function violation(uint256 p) external view returns (string memory) {
        return _violation[p];
    }

    // ------------------------------------------------------------------
    // Registrar, Payment, Model and Rules
    // ------------------------------------------------------------------

    function register(uint256 cpSeed, uint256 limitSeed) external {
        uint256 ceiling = wallet.policy().firstContactCeiling;
        uint256 l = limitSeed % 10 == 0 ? ceiling + 1 : _bound(limitSeed, 0, ceiling);
        _step(REGISTER, wallet.roleHolder(PolicyWallet.Role.Registrar), Args(_target(cpSeed), l, 0));
    }

    /// @dev Biased toward success: pays a Registered, unpinned, payable pool payee with budget left,
    ///      registering one through the Registrar if there is none. 1 in 20 calls pays a random target
    ///      instead, and 1 in 20 pays one unit more than the budget.
    function pay(uint256 cpSeed, uint256 amountSeed) external {
        address a = amountSeed % 20 == 0 ? _target(cpSeed) : _payablePayee(cpSeed);
        if (a == address(0)) a = _registerForPay(cpSeed);
        if (a == address(0)) a = _target(cpSeed);

        PolicyWallet.Remaining memory r = wallet.remaining(a);
        uint256 max = r.cpRemaining < r.walletRemaining ? r.cpRemaining : r.walletRemaining;
        uint256 bal = IBalanceOf(USDC).balanceOf(address(wallet));
        if (bal < max) max = bal;
        uint256 amount = max == 0 ? 1 : (amountSeed % 20 == 19 ? max + 1 : _bound(amountSeed, 1, max));
        _step(PAY, wallet.roleHolder(PolicyWallet.Role.Payment), Args(a, amount, 0));
    }

    function tighten(uint256 cpSeed, uint256 limitSeed, uint256 epochSeed, bool byRules) external {
        address a = _target(cpSeed);
        PolicyWallet.Counterparty memory c = wallet.rawCounterparty(a);
        uint256 cur = c.humanEpoch;
        uint256 epoch = cur;
        uint256 mode = epochSeed % 4;
        if (mode == 0) epoch = cur + 1;
        else if (mode == 1) epoch = cur == 0 ? cur + 1 : cur - 1;
        uint256 l = _bound(limitSeed, 0, c.limit * 2 + 1);
        address caller = wallet.roleHolder(byRules ? PolicyWallet.Role.Rules : PolicyWallet.Role.Model);
        _step(TIGHTEN, caller, Args(a, l, epoch));
    }

    function pin(uint256 cpSeed) external {
        _step(PIN, wallet.roleHolder(PolicyWallet.Role.Rules), Args(_target(cpSeed), 0, 0));
    }

    function releasePin(uint256 cpSeed) external {
        _step(RELEASE_PIN, wallet.roleHolder(PolicyWallet.Role.Rules), Args(_target(cpSeed), 0, 0));
    }

    // ------------------------------------------------------------------
    // Human
    // ------------------------------------------------------------------

    function setLimit(uint256 cpSeed, uint256 limitSeed) external {
        _step(SET_LIMIT, wallet.human(), Args(_target(cpSeed), _bound(limitSeed, 0, 2_000e6), 0));
    }

    function requestUnpin(uint256 cpSeed) external {
        _step(REQUEST_UNPIN, wallet.human(), Args(_target(cpSeed), 0, 0));
    }

    function executeUnpin(uint256 cpSeed) external {
        _step(EXECUTE_UNPIN, wallet.human(), Args(_target(cpSeed), 0, 0));
    }

    function setFirstContactCeiling(uint256 seed) external {
        _step(SET_CEILING, wallet.human(), Args(address(0), _bound(seed, 0, 1_000e6), 0));
    }

    function setWalletPeriodCap(uint256 seed) external {
        _step(SET_WALLET_CAP, wallet.human(), Args(address(0), _bound(seed, 0, 10_000e6), 0));
    }

    function setNewPayeeCap(uint256 seed) external {
        _step(SET_NEW_PAYEE_CAP, wallet.human(), Args(address(0), _bound(seed, 0, 12), 0));
    }

    function setPolicyPeriod(uint256 seed) external {
        uint256 d = seed % 10 == 0 ? (seed % 20 == 0 ? 0 : 91) : _bound(seed, 1, 90);
        _step(SET_POLICY_PERIOD, wallet.human(), Args(address(0), d, 0));
    }

    function setUnpinDelay(uint256 seed) external {
        uint256 s = seed % 10 == 0 ? 1 hours - 1 : _bound(seed, 1 hours, 3 days);
        _step(SET_UNPIN_DELAY, wallet.human(), Args(address(0), s, 0));
    }

    function withdraw(uint256 seed) external {
        _step(WITHDRAW, wallet.human(), Args(seed % 10 == 0 ? address(0) : sink, 0, 0));
    }

    /// @dev Grants a fresh EOA; fills a vacant slot first so revocations do not starve the run.
    function grantRole(uint256 roleSeed) external {
        uint256 role = roleSeed % 4;
        for (uint256 i; i < 4; ++i) {
            if (wallet.roleHolder(PolicyWallet.Role(uint8(i))) == address(0)) {
                role = i;
                break;
            }
        }
        address old = wallet.roleHolder(PolicyWallet.Role(uint8(role)));
        if (_step(GRANT_ROLE, wallet.human(), Args(_fresh(), role, 0))) _retire(old);
    }

    function revokeRole(uint256 roleSeed) external {
        uint256 role = roleSeed % 4;
        address old = wallet.roleHolder(PolicyWallet.Role(uint8(role)));
        if (_step(REVOKE_ROLE, wallet.human(), Args(address(0), role, 0))) _retire(old);
    }

    function transferOwnership() external {
        _step(TRANSFER_OWNERSHIP, wallet.human(), Args(_fresh(), 0, 0));
    }

    function acceptOwnership() external {
        address old = wallet.human();
        if (_step(ACCEPT_OWNERSHIP, wallet.pendingHuman(), Args(address(0), 0, 0))) _retire(old);
    }

    // ------------------------------------------------------------------
    // Anyone, time, and arbitrary callers
    // ------------------------------------------------------------------

    /// @dev On a fork the amount is a whole number of 6-dp units, so the token ledger stays exact.
    function deposit(uint256 seed) external {
        uint256 v = _bound(seed, 0, 5_000 ether);
        if (realUsdc) v -= v % 1e12;
        Snap memory pre = _snap();
        vm.deal(depositor, v);
        vm.prank(depositor);
        (bool ok,) = address(wallet).call{value: v}("");
        if (ok) {
            ++_successes[DEPOSIT];
            ghostNativeIn += v;
            uint256 tokens = v / 1e12;
            if (!realUsdc && tokens != 0) IMintable(USDC).mint(address(wallet), tokens);
            ghostTokenIn += tokens;
        }
        _check(pre, DEPOSIT, ok, Args(address(0), v, 0));
    }

    function warp(uint256 seed) external {
        Snap memory pre = _snap();
        vm.warp(block.timestamp + _bound(seed, 0, 40 days));
        ++_successes[WARP];
        _check(pre, WARP, true, Args(address(0), 0, 0));
    }

    /// @dev A caller that does not hold the target mutator's role calls it with otherwise valid
    ///      arguments. A success is a violation. The counter counts only `Unauthorized` rejections;
    ///      a revert for another reason did not exercise the role check.
    function arbitrary(uint256 fnSeed, uint256 callerSeed, uint256 cpSeed) external {
        uint256 fn = fnSeed % MUTATOR_COUNT;
        address caller = _pickCaller(callerSeed);
        if (_holds(fn, caller)) caller = stranger;

        address a = _target(cpSeed);
        Args memory args = Args(a, 1, wallet.rawCounterparty(a).humanEpoch);
        if (fn == GRANT_ROLE || fn == TRANSFER_OWNERSHIP) args.a = _fresh();
        else if (fn == WITHDRAW) args.a = sink;
        else if (fn == SET_POLICY_PERIOD) args.x = 30;
        else if (fn == SET_UNPIN_DELAY) args.x = 2 hours;

        Snap memory pre = _snap();
        (bool ok, bytes4 sel) = _invoke(fn, caller, args);
        if (ok) {
            _flag(
                P_UNAUTHORIZED,
                string.concat("arbitrary caller ", vm.toString(caller), " succeeded at ", _names[fn]),
                ARBITRARY
            );
        } else if (sel == PolicyWallet.Unauthorized.selector) {
            ++_successes[ARBITRARY];
        }
        _check(pre, ARBITRARY, ok, args);
    }

    // ------------------------------------------------------------------
    // Call plumbing
    // ------------------------------------------------------------------

    function _step(uint256 action, address caller, Args memory args) internal returns (bool ok) {
        Snap memory pre = _snap();
        (ok,) = _invoke(action, caller, args);
        if (ok) ++_successes[action];
        _check(pre, action, ok, args);
    }

    /// @dev Pranks `caller` and calls mutator `fn`. Returns false and the revert selector on a revert.
    function _invoke(uint256 fn, address caller, Args memory g) internal returns (bool ok, bytes4 sel) {
        bytes memory data = _calldata(fn, g);
        vm.prank(caller);
        bytes memory ret;
        (ok, ret) = address(wallet).call(data);
        if (!ok && ret.length >= 4) sel = bytes4(ret);
    }

    function _calldata(uint256 fn, Args memory g) internal pure returns (bytes memory) {
        PolicyWallet.Role role = PolicyWallet.Role(uint8(g.x % 4));
        if (fn == REGISTER) return abi.encodeCall(PolicyWallet.register, (g.a, g.x, RH));
        if (fn == PAY) return abi.encodeCall(PolicyWallet.pay, (g.a, g.x, RH));
        if (fn == TIGHTEN) return abi.encodeCall(PolicyWallet.tighten, (g.a, g.x, g.y, RH));
        if (fn == PIN) return abi.encodeCall(PolicyWallet.pin, (g.a, RH));
        if (fn == RELEASE_PIN) return abi.encodeCall(PolicyWallet.releasePin, (g.a, RH));
        if (fn == SET_LIMIT) return abi.encodeCall(PolicyWallet.setLimit, (g.a, g.x, RH));
        if (fn == REQUEST_UNPIN) return abi.encodeCall(PolicyWallet.requestUnpin, (g.a, RH));
        if (fn == EXECUTE_UNPIN) return abi.encodeCall(PolicyWallet.executeUnpin, (g.a, RH));
        if (fn == SET_CEILING) return abi.encodeCall(PolicyWallet.setFirstContactCeiling, (g.x, RH));
        if (fn == SET_WALLET_CAP) return abi.encodeCall(PolicyWallet.setWalletPeriodCap, (g.x, RH));
        if (fn == SET_NEW_PAYEE_CAP) return abi.encodeCall(PolicyWallet.setNewPayeeCap, (g.x, RH));
        if (fn == SET_POLICY_PERIOD) return abi.encodeCall(PolicyWallet.setPolicyPeriod, (g.x, RH));
        if (fn == SET_UNPIN_DELAY) return abi.encodeCall(PolicyWallet.setUnpinDelay, (g.x, RH));
        if (fn == WITHDRAW) return abi.encodeCall(PolicyWallet.withdraw, (g.a, RH));
        if (fn == GRANT_ROLE) return abi.encodeCall(PolicyWallet.grantRole, (role, g.a, RH));
        if (fn == REVOKE_ROLE) return abi.encodeCall(PolicyWallet.revokeRole, (role, RH));
        if (fn == TRANSFER_OWNERSHIP) return abi.encodeCall(PolicyWallet.transferOwnership, (g.a, RH));
        return abi.encodeCall(PolicyWallet.acceptOwnership, (RH));
    }

    // ------------------------------------------------------------------
    // Ghost checks
    // ------------------------------------------------------------------

    function _snap() internal view returns (Snap memory s) {
        for (uint256 i; i < TRACKED_COUNT; ++i) {
            s.cps[i] = wallet.rawCounterparty(_tracked[i]);
        }
        s.policy = wallet.policy();
        s.native = address(wallet).balance;
        s.token = IBalanceOf(USDC).balanceOf(address(wallet));
    }

    function _check(Snap memory pre, uint256 action, bool ok, Args memory g) internal {
        _checkBalances(pre, action, ok, g.x);
        bool human = action >= SET_LIMIT && action <= TRANSFER_OWNERSHIP;
        // A reverted call changes nothing, so the non-Human checks hold for it too.
        if (human && ok) return;
        _checkNonHuman(pre, action, g.a);
        if (!ok) return;

        if (action == REGISTER) {
            _checkRegister(pre, g);
        } else if (action == TIGHTEN) {
            PolicyWallet.Counterparty memory b = pre.cps[_indexOf(g.a)];
            if (g.y != b.humanEpoch) _flag(P_STALE_EPOCH, "tighten succeeded with a stale epoch", action);
            uint256 want = g.x < b.limit ? g.x : b.limit;
            if (wallet.rawCounterparty(g.a).limit != want) {
                _flag(P_EXACT, "tighten did not store min(before, requested)", action);
            }
        } else if (action == PIN) {
            PolicyWallet.Counterparty memory c = wallet.rawCounterparty(g.a);
            if (!c.pinned || c.limit != 0) _flag(P_PIN, "pin did not leave the target pinned at 0", action);
        } else if (action == PAY) {
            _checkPayWindow(g.a, g.x);
        }
    }

    function _checkRegister(Snap memory pre, Args memory g) internal {
        PolicyWallet.Counterparty memory c = wallet.rawCounterparty(g.a);
        if (c.limit > pre.policy.firstContactCeiling) {
            _flag(P_CEILING, "register stored a limit above the ceiling", REGISTER);
        }
        if (!c.registered || c.limit != g.x) {
            _flag(P_EXACT, "register did not store registered and the requested limit", REGISTER);
        }
        if (g.x == 0) return;

        uint256 today = block.timestamp / 1 days;
        _newPayeeDays.push(today);
        uint256 lo = today > pre.policy.policyPeriodDays ? today - pre.policy.policyPeriodDays : 0;
        uint256 count;
        uint256 len = _newPayeeDays.length;
        for (uint256 i; i < len; ++i) {
            uint256 d = _newPayeeDays[i];
            if (d >= lo && d <= today) ++count;
        }
        if (count > pre.policy.newPayeeCap) {
            _flag(P_NEW_PAYEE_CAP, "new Registrations in the window exceed the New-Payee Cap", REGISTER);
        }
    }

    /// @dev Only `pay` and `withdraw` may lower a balance; `pay` lowers the token balance by exactly
    ///      `amount` and `withdraw` sweeps the native balance to 0.
    function _checkBalances(Snap memory pre, uint256 action, bool ok, uint256 amount) internal {
        uint256 n = address(wallet).balance;
        uint256 t = IBalanceOf(USDC).balanceOf(address(wallet));
        if (ok && action == PAY) {
            if (t > pre.token || pre.token - t != amount) {
                _flag(P_BALANCE_EXITS, "pay moved a token amount other than amount", action);
            }
            if (realUsdc) {
                if (n != pre.native - amount * 1e12) {
                    _flag(P_BALANCE_EXITS, "pay moved a native amount other than amount", action);
                }
                ghostNativeOut += amount * 1e12;
            } else if (n < pre.native) {
                _flag(P_BALANCE_EXITS, "pay lowered the native balance", action);
            }
            ghostTokenOut += amount;
        } else if (ok && action == WITHDRAW) {
            if (n != 0) _flag(P_BALANCE_EXITS, "withdraw left a native balance", action);
            ghostNativeOut += pre.native;
            if (realUsdc) {
                if (t != 0) _flag(P_BALANCE_EXITS, "withdraw left a token balance", action);
                ghostTokenOut += pre.token;
            } else if (t < pre.token) {
                _flag(P_BALANCE_EXITS, "withdraw lowered the mock token balance", action);
            }
        } else {
            if (n < pre.native) _flag(P_BALANCE_EXITS, "native balance fell outside pay/withdraw", action);
            if (t < pre.token) _flag(P_BALANCE_EXITS, "token balance fell outside pay/withdraw", action);
        }
    }

    /// @dev Transition rules for every non-Human call (and every reverted call).
    function _checkNonHuman(Snap memory pre, uint256 action, address target) internal {
        for (uint256 i; i < TRACKED_COUNT; ++i) {
            PolicyWallet.Counterparty memory b = pre.cps[i];
            PolicyWallet.Counterparty memory c = wallet.rawCounterparty(_tracked[i]);
            bool isTarget = _tracked[i] == target;
            string memory who = string.concat(", tracked #", vm.toString(i));
            if (c.limit > b.limit) {
                bool allowed =
                    action == REGISTER && isTarget && !b.registered && c.limit <= pre.policy.firstContactCeiling;
                if (!allowed) _flag(P_NO_RAISE, string.concat("non-Human call raised a limit", who), action);
            }
            if (c.humanEpoch != b.humanEpoch || c.humanSet != b.humanSet) {
                _flag(P_HUMAN_EPOCH, string.concat("non-Human call changed humanEpoch/humanSet", who), action);
            }
            if (!b.pinned && c.pinned && !(action == PIN && isTarget)) {
                _flag(P_PIN, string.concat("pinned set by a call other than pin", who), action);
            }
            if (b.pinned && !c.pinned && !(action == RELEASE_PIN && isTarget)) {
                _flag(P_PIN, string.concat("pin cleared by a non-Human call other than releasePin", who), action);
            }
            if (c.unpinRequestedAt != b.unpinRequestedAt) {
                bool cleared = (action == PIN || action == RELEASE_PIN) && isTarget && c.unpinRequestedAt == 0;
                if (!cleared) _flag(P_PIN, string.concat("non-Human call changed unpinRequestedAt", who), action);
            }
            if (c.registered != b.registered) {
                bool registration = (action == REGISTER || action == PIN) && isTarget && c.registered;
                if (!registration) {
                    _flag(P_REGISTERED, string.concat("registered flipped outside register/pin", who), action);
                }
            }
        }
        PolicyWallet.Policy memory p = wallet.policy();
        if (
            p.firstContactCeiling != pre.policy.firstContactCeiling || p.walletPeriodCap != pre.policy.walletPeriodCap
                || p.newPayeeCap != pre.policy.newPayeeCap || p.policyPeriodDays != pre.policy.policyPeriodDays
                || p.unpinDelay != pre.policy.unpinDelay
        ) _flag(P_NO_RAISE, "non-Human call changed the Policy", action);
    }

    /// @dev Window `[today - N, today]`: Counterparty spend <= Effective Limit and wallet spend <=
    ///      Wallet Period Cap, both at this moment.
    function _checkPayWindow(address a, uint256 amount) internal {
        uint256 today = block.timestamp / 1 days;
        _ledger.push(PayRecord(today, a, amount));
        PolicyWallet.Policy memory p = wallet.policy();
        uint256 lo = today > p.policyPeriodDays ? today - p.policyPeriodDays : 0;
        uint256 cpSum;
        uint256 total;
        uint256 len = _ledger.length;
        for (uint256 i; i < len; ++i) {
            PayRecord memory r = _ledger[i];
            if (r.day < lo || r.day > today) continue;
            total += r.amount;
            if (r.cp == a) cpSum += r.amount;
        }
        PolicyWallet.Counterparty memory c = wallet.rawCounterparty(a);
        uint256 eff = (c.humanSet || c.limit <= p.firstContactCeiling) ? c.limit : p.firstContactCeiling;
        if (cpSum > eff) _flag(P_WINDOW, "Counterparty window spend exceeds its Effective Limit", PAY);
        if (total > p.walletPeriodCap) _flag(P_WINDOW, "wallet window spend exceeds the Wallet Period Cap", PAY);
    }

    function _flag(uint256 prop, string memory reason, uint256 action) internal {
        if (_violated[prop]) return;
        _violated[prop] = true;
        _violation[prop] = string.concat(reason, " [action: ", _names[action], "]");
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @dev 80% pool EOAs, 5% the contract payee, 15% the invalid addresses (0, wallet, USDC).
    function _target(uint256 seed) internal view returns (address) {
        uint256 i = seed % 20;
        if (i < 16) return _tracked[i % POOL_SIZE];
        return _tracked[i - 8];
    }

    /// @dev First pool payee (8 EOAs and the contract payee, from `seed`) that `pay` would accept
    ///      for at least one unit; `address(0)` if none.
    function _payablePayee(uint256 seed) internal view returns (address) {
        for (uint256 k; k < POOL_SIZE + 1; ++k) {
            address t = _tracked[(seed % (POOL_SIZE + 1) + k) % (POOL_SIZE + 1)];
            PolicyWallet.Remaining memory r = wallet.remaining(t);
            if (!r.registered || r.pinned) continue;
            if (t.code.length != 0 && !r.humanSet) continue;
            if (r.cpRemaining == 0 || r.walletRemaining == 0) continue;
            return t;
        }
        return address(0);
    }

    /// @dev Registers the first unregistered pool EOA (from `seed`) at the ceiling through the
    ///      Registrar, as a normal checked `register` step; `address(0)` if that is not possible.
    function _registerForPay(uint256 seed) internal returns (address) {
        uint256 ceiling = wallet.policy().firstContactCeiling;
        if (ceiling == 0) return address(0);
        for (uint256 k; k < POOL_SIZE; ++k) {
            address t = _tracked[(seed % POOL_SIZE + k) % POOL_SIZE];
            if (wallet.rawCounterparty(t).registered) continue;
            if (_step(REGISTER, wallet.roleHolder(PolicyWallet.Role.Registrar), Args(t, ceiling, 0))) return t;
            return address(0);
        }
        return address(0);
    }

    function _indexOf(address a) internal view returns (uint256) {
        for (uint256 i; i < TRACKED_COUNT; ++i) {
            if (_tracked[i] == a) return i;
        }
        revert("untracked target");
    }

    function _pickCaller(uint256 seed) internal view returns (address) {
        uint256 i = seed % 20;
        if (i == 0) return wallet.human();
        if (i == 1) return wallet.pendingHuman();
        if (i < 6) return wallet.roleHolder(PolicyWallet.Role(uint8(i - 2)));
        if (i < 14) return _tracked[i - 6];
        if (i == 14) return _tracked[8];
        if (i == 15) return stranger;
        if (i == 16) return _former.length == 0 ? stranger : _former[(seed / 20) % _former.length];
        if (i == 17) return address(this);
        if (i == 18) return address(wallet);
        return address(uint160(seed >> 8));
    }

    function _holds(uint256 fn, address caller) internal view returns (bool) {
        if (fn == REGISTER) return caller == wallet.roleHolder(PolicyWallet.Role.Registrar);
        if (fn == PAY) return caller == wallet.roleHolder(PolicyWallet.Role.Payment);
        if (fn == TIGHTEN) {
            return caller == wallet.roleHolder(PolicyWallet.Role.Model)
                || caller == wallet.roleHolder(PolicyWallet.Role.Rules);
        }
        if (fn == PIN || fn == RELEASE_PIN) return caller == wallet.roleHolder(PolicyWallet.Role.Rules);
        if (fn == ACCEPT_OWNERSHIP) return caller == wallet.pendingHuman();
        return caller == wallet.human();
    }

    /// @dev A never-before-used EOA (keccak-derived, so no code on any chain in practice).
    function _fresh() internal returns (address) {
        return address(uint160(uint256(keccak256(abi.encode("horos-fresh-eoa", ++_freshNonce)))));
    }

    function _retire(address old) internal {
        if (old != address(0) && _former.length < MAX_FORMER) _former.push(old);
    }
}
