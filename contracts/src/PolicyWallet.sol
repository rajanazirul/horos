// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {RollingWindow} from "./lib/RollingWindow.sol";

/// @title PolicyWallet
/// @notice Customer-owned, non-upgradeable wallet that holds native USDC on Arc and
///         enforces who may hold which role and who may move funds out.
/// @dev Story 1.2 slice: four grantable single-holder role slots plus the Human owner,
///      two-step ownership, deposits
///      via `receive()` and a Human-only full-balance `withdraw`.
///      Story 1.3 slice: Human-only Policy setters, per-Counterparty state (AD-6), the three
///      AD-7 day-bucket rings and the never-reverting `remaining()` view.
///      Story 1.4 slice: Registrar-only `register` (First-Contact Ceiling, New-Payee Cap, payee
///      sanity) and Payment-only `pay`, the single non-Human value exit. `pay` checks `_remaining`,
///      records spend in the Counterparty and wallet rings, then moves funds only through the
///      ERC-20 `transfer` on `USDC`.
///      Story 1.5 slice: the rest of the AD-6 state machine. Model/Rules `tighten` (epoch-checked,
///      only lowers), Rules `pin` / `releasePin`, Human `setLimit` (bumps the epoch, the only way
///      to make a contract payee payable; `pin` may register one, but only at 0 and pinned) and the Human two-step `requestUnpin` / `executeUnpin`,
///      which a Rules re-pin vetoes during the Unpin Delay.
///      There is deliberately no fallback, execute, delegatecall, approve, permit,
///      ERC-1271, multicall, proxy, initializer or renounceOwnership.
contract PolicyWallet {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /// @notice Grantable role slots. Human is not a slot: it is the owner.
    enum Role {
        Payment,
        Registrar,
        Model,
        Rules
    }

    /// @notice Initial role holders passed to the constructor.
    struct Roles {
        address human;
        address payment;
        address registrar;
        address model;
        address rules;
    }

    /// @notice On-chain Policy values. Amounts are 6-dp USDC base units.
    struct Policy {
        uint256 firstContactCeiling;
        uint256 walletPeriodCap;
        uint256 newPayeeCap;
        uint256 policyPeriodDays;
        uint256 unpinDelay;
    }

    /// @notice Which Policy value a `PolicyChanged` event refers to.
    enum PolicyField {
        FirstContactCeiling,
        WalletPeriodCap,
        NewPayeeCap,
        PolicyPeriodDays,
        UnpinDelay
    }

    /// @notice Per-Counterparty state (AD-6). Packed: flags and the two uint64 fields share one slot.
    struct Counterparty {
        bool registered;
        bool pinned;
        bool humanSet;
        uint64 humanEpoch;
        /// @dev Time of the pending Human unpin request; 0 is the "no request" sentinel, so a request
        ///      at timestamp 0 is unrepresentable (unreachable on a live chain).
        uint64 unpinRequestedAt;
        uint256 limit;
    }

    /// @notice Result of `remaining(a)`: the single shared budget number set.
    /// @dev The window counts day buckets in `[today - N, today]`, i.e. N + 1 calendar days
    ///      (N = policyPeriodDays, today = block.timestamp / 1 days). The view does NOT combine
    ///      `cpRemaining` and `walletRemaining`: a payment must fit both, so the caller takes the min.
    struct Remaining {
        /// @dev `satSub(effectiveLimit, cp window spend)`, 6-dp USDC base units, where
        ///      `effectiveLimit = humanSet ? limit : min(limit, firstContactCeiling)`.
        uint256 cpRemaining;
        /// @dev `satSub(walletPeriodCap, wallet window spend)`, 6-dp USDC base units.
        uint256 walletRemaining;
        /// @dev `satSub(newPayeeCap, new Registrations in the window)`, a count (not an amount).
        uint256 newPayeeRemaining;
        /// @dev The raw stored limit, 6-dp USDC base units, before the First-Contact Ceiling is applied.
        uint256 limit;
        /// @dev Stored pin flag.
        bool pinned;
        /// @dev Stored Registration flag.
        bool registered;
        /// @dev True if the Human set the limit (the First-Contact Ceiling then does not apply).
        bool humanSet;
        /// @dev Stored Human epoch, widened from the uint64 storage field.
        uint256 humanEpoch;
    }

    // ---------------------------------------------------------------------
    // Constants and immutables
    // ---------------------------------------------------------------------

    /// @notice Arc native USDC (ERC-20 interface) address.
    address public constant USDC = 0x3600000000000000000000000000000000000000;

    /// @notice Upper bound for the Policy Period, in days (sizes the bucket rings).
    uint256 public constant MAX_POLICY_PERIOD_DAYS = RollingWindow.MAX_WINDOW_DAYS;

    /// @notice Lower bound for the Unpin Delay.
    uint256 public constant MIN_UNPIN_DELAY = 1 hours;

    /// @notice When false, every role-gated caller must have no code (rejects EIP-7702 delegation).
    bool public immutable roleIsContract;

    uint256 private constant ROLE_COUNT = 4;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    /// @notice Current Human (owner).
    address public human;

    /// @notice Proposed Human awaiting `acceptOwnership`, or `address(0)`.
    address public pendingHuman;

    address[ROLE_COUNT] private _roleHolders;

    Policy internal _policy;

    /// @dev AD-6 per-Counterparty state. Written by `register`, `tighten`, `pin`, `releasePin`,
    ///      `setLimit`, `requestUnpin` and `executeUnpin`.
    mapping(address => Counterparty) internal _counterparties;

    /// @dev Per-Counterparty spend ring (AD-7).
    mapping(address => RollingWindow.Ring) internal _cpSpend;

    /// @dev Wallet-wide spend ring (AD-7).
    RollingWindow.Ring internal _walletSpend;

    /// @dev New-payee count ring (AD-7).
    RollingWindow.Ring internal _newPayees;

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    /// @notice A role account is invalid or collides with another holder, or a withdraw target is zero.
    error RoleConflict();
    /// @notice Caller is not the role holder, or has code while `roleIsContract` is false.
    error Unauthorized();
    /// @notice A Policy value is out of bounds.
    error InvalidPolicy();
    /// @notice The role slot is already vacant.
    error RoleVacant();
    /// @notice The native value transfer in `withdraw` failed.
    error WithdrawFailed();
    /// @notice The Counterparty is already Registered.
    error AlreadyRegistered();
    /// @notice A Registration limit exceeds the First-Contact Ceiling.
    error CeilingExceeded();
    /// @notice The New-Payee Cap for the rolling Policy Period is used up.
    error NewPayeeCapReached();
    /// @notice The payee has code (only the Human may make a contract payee payable).
    error PayeeIsContract();
    /// @notice The Counterparty is pinned.
    error Pinned();
    /// @notice The payee is zero, this wallet, USDC, a precompile or a system address.
    error InvalidPayee();
    /// @notice The payee is not Registered.
    error NotRegistered();
    /// @notice The payment exceeds the Counterparty's remaining Effective Limit.
    error LimitExceeded();
    /// @notice The payment exceeds the remaining Wallet Period Cap.
    error WalletCapExceeded();
    /// @notice A payment amount of zero.
    error InvalidAmount();
    /// @notice `expectedEpoch` does not match the Counterparty's current Human epoch.
    error StaleEpoch();
    /// @notice The Counterparty is not pinned.
    error NotPinned();
    /// @notice No Human unpin request is pending (never requested, or vetoed by a Rules re-pin).
    error UnpinNotRequested();
    /// @notice The Unpin Delay has not elapsed since the unpin request.
    error UnpinDelayPending();

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /// @notice A role slot was assigned.
    event RoleGranted(Role role, address account, bytes32 recordHash);
    /// @notice A role slot holder was removed (revoked or replaced).
    event RoleRevoked(Role role, address account, bytes32 recordHash);
    /// @notice Human proposed a new Human.
    event OwnershipTransferStarted(address from, address to, bytes32 recordHash);
    /// @notice The pending Human accepted ownership.
    event OwnershipTransferred(address from, address to, bytes32 recordHash);
    /// @notice Human swept the wallet balance.
    event Withdrawn(address to, uint256 amount, bytes32 recordHash);
    /// @notice Human changed a Policy value (emitted even when `newValue == oldValue`).
    event PolicyChanged(PolicyField field, uint256 oldValue, uint256 newValue, bytes32 recordHash);
    /// @notice The Registrar registered a Counterparty at `limit` (6-dp USDC base units).
    event CounterpartyRegistered(address counterparty, uint256 limit, bytes32 recordHash);
    /// @notice The Payment key paid `amount` (6-dp USDC base units) to a Counterparty.
    event Paid(address counterparty, uint256 amount, bytes32 recordHash);
    /// @notice Model or Rules tightened a limit (emitted even when `newLimit == oldLimit`).
    event LimitTightened(address counterparty, uint256 oldLimit, uint256 newLimit, bytes32 recordHash);
    /// @notice Rules pinned a Counterparty (limit 0, any pending unpin cancelled). Also emitted on a re-pin.
    /// @dev Named `CounterpartyPinned` because `Pinned` is already the error identifier.
    event CounterpartyPinned(address counterparty, bytes32 recordHash);
    /// @notice A pin was released (Rules `releasePin` or Human `executeUnpin`); the limit stays 0.
    event PinReleased(address counterparty, bytes32 recordHash);
    /// @notice The Human set a limit; `humanEpoch` is the new epoch after the bump.
    event LimitSet(address counterparty, uint256 oldLimit, uint256 newLimit, uint256 humanEpoch, bytes32 recordHash);
    /// @notice The Human requested an unpin, executable from `executableAt` (saturated at max uint256).
    /// @dev `executableAt` is an estimate made with the current Unpin Delay: `executeUnpin` checks
    ///      against the Unpin Delay in force at execution time, so a later `setUnpinDelay` moves it.
    event UnpinRequested(address counterparty, uint256 executableAt, bytes32 reasonHash);

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /// @notice Deploy a PolicyWallet with five distinct role holders and a Policy.
    /// @param roles Initial Human, Payment, Registrar, Model and Rules holders; all valid and pairwise distinct.
    /// @param policy_ Initial Policy values (1 <= policyPeriodDays <= 90, unpinDelay >= 1 hour).
    /// @param roleIsContract_ Whether role holders may be contracts (false in v1).
    constructor(Roles memory roles, Policy memory policy_, bool roleIsContract_) {
        address[5] memory all = [roles.human, roles.payment, roles.registrar, roles.model, roles.rules];
        for (uint256 i; i < 5; ++i) {
            _requireValidAccount(all[i], roleIsContract_);
            for (uint256 j = i + 1; j < 5; ++j) {
                // forge-lint: disable-next-line(require-revert-in-loop) -- fixed 5x5 bound; any collision must abort the deploy
                if (all[i] == all[j]) revert RoleConflict();
            }
        }
        _requireValidPolicyPeriod(policy_.policyPeriodDays);
        _requireValidUnpinDelay(policy_.unpinDelay);

        roleIsContract = roleIsContract_;
        human = roles.human;
        _roleHolders[uint8(Role.Payment)] = roles.payment;
        _roleHolders[uint8(Role.Registrar)] = roles.registrar;
        _roleHolders[uint8(Role.Model)] = roles.model;
        _roleHolders[uint8(Role.Rules)] = roles.rules;
        _policy = policy_;
    }

    // ---------------------------------------------------------------------
    // Custody
    // ---------------------------------------------------------------------

    /// @notice Accept native USDC deposits from anyone. The only payable entry point.
    receive() external payable {}

    /// @notice Sweep the entire native balance (including sub-micro dust) to `to`.
    /// @dev Human-only. No state is changed before the call, so reentrancy cannot
    ///      observe an inconsistent state; a reentrant withdraw finds a zero balance.
    /// @param to Recipient; must not be `address(0)`.
    /// @param recordHash Off-chain evidence record hash, emitted.
    function withdraw(address to, bytes32 recordHash) external {
        _onlyHolder(human);
        if (to == address(0)) revert RoleConflict();

        uint256 amount = address(this).balance;
        emit Withdrawn(to, amount, recordHash);

        // forge-lint: disable-next-line(arbitrary-send-eth) -- Human-only sweep; the Human chooses the destination by design
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert WithdrawFailed();
    }

    // ---------------------------------------------------------------------
    // Roles
    // ---------------------------------------------------------------------

    /// @notice Assign `account` to `role`, replacing any current holder.
    /// @dev Human-only. `account` must be valid and distinct from Human, the pending
    ///      Human and every other slot. A replaced holder gets `RoleRevoked` first.
    /// @param role Slot to assign.
    /// @param account New holder.
    /// @param recordHash Off-chain evidence record hash, emitted.
    function grantRole(Role role, address account, bytes32 recordHash) external {
        _onlyHolder(human);
        _requireValidAccount(account, roleIsContract);
        if (account == human || account == pendingHuman) revert RoleConflict();
        for (uint256 i; i < ROLE_COUNT; ++i) {
            // forge-lint: disable-next-line(require-revert-in-loop) -- fixed 4-slot bound; a collision must abort
            if (i != uint8(role) && _roleHolders[i] == account) revert RoleConflict();
        }

        address old = _roleHolders[uint8(role)];
        _roleHolders[uint8(role)] = account;
        if (old != address(0)) emit RoleRevoked(role, old, recordHash);
        emit RoleGranted(role, account, recordHash);
    }

    /// @notice Vacate `role` (sets its holder to `address(0)`).
    /// @dev Human-only. Reverts with `RoleVacant` if the slot is already empty.
    /// @param role Slot to vacate.
    /// @param recordHash Off-chain evidence record hash, emitted.
    function revokeRole(Role role, bytes32 recordHash) external {
        _onlyHolder(human);
        address old = _roleHolders[uint8(role)];
        if (old == address(0)) revert RoleVacant();
        _roleHolders[uint8(role)] = address(0);
        emit RoleRevoked(role, old, recordHash);
    }

    /// @notice Current holder of `role`, or `address(0)` if vacant.
    /// @param role Slot to read.
    /// @return The holder address.
    function roleHolder(Role role) external view returns (address) {
        return _roleHolders[uint8(role)];
    }

    // ---------------------------------------------------------------------
    // Ownership (two-step, no renounce)
    // ---------------------------------------------------------------------

    /// @notice Propose `newHuman` as the next Human. Overwrites any earlier proposal.
    /// @dev Human-only. `newHuman` must be valid and distinct from Human and every slot.
    /// @param newHuman Proposed Human.
    /// @param recordHash Off-chain evidence record hash, emitted.
    // forge-lint: disable-next-line(missing-zero-check) -- zero is rejected by _requireValidAccount
    function transferOwnership(address newHuman, bytes32 recordHash) external {
        _onlyHolder(human);
        _requireValidAccount(newHuman, roleIsContract);
        if (newHuman == human) revert RoleConflict();
        _requireNotInSlots(newHuman);

        pendingHuman = newHuman;
        emit OwnershipTransferStarted(msg.sender, newHuman, recordHash);
    }

    /// @notice Accept a pending ownership transfer. Callable only by `pendingHuman`.
    /// @dev Re-checks disjointness against every slot before taking over.
    /// @param recordHash Off-chain evidence record hash, emitted.
    function acceptOwnership(bytes32 recordHash) external {
        address newHuman = pendingHuman;
        _onlyHolder(newHuman);
        _requireNotInSlots(newHuman);

        address old = human;
        human = newHuman;
        pendingHuman = address(0);
        emit OwnershipTransferred(old, newHuman, recordHash);
    }

    // ---------------------------------------------------------------------
    // Policy
    // ---------------------------------------------------------------------

    /// @notice The on-chain Policy values.
    /// @return The current Policy.
    function policy() external view returns (Policy memory) {
        return _policy;
    }

    /// @notice Set the First-Contact Ceiling (cap on a non-Human-set Effective Limit).
    /// @dev Human-only. May raise or lower; any value is accepted.
    /// @param value New ceiling, 6-dp USDC base units.
    /// @param recordHash Off-chain evidence record hash, emitted.
    function setFirstContactCeiling(uint256 value, bytes32 recordHash) external {
        _onlyHolder(human);
        emit PolicyChanged(PolicyField.FirstContactCeiling, _policy.firstContactCeiling, value, recordHash);
        _policy.firstContactCeiling = value;
    }

    /// @notice Set the Wallet Period Cap (total spend allowed per rolling Policy Period).
    /// @dev Human-only. May raise or lower; any value is accepted. Lowering below the current
    ///      window sum makes `walletRemaining` 0, it never reverts. The cap applies to spend in
    ///      day buckets `[today - N, today]`, i.e. N + 1 calendar days for a Policy Period of N.
    /// @param value New cap, 6-dp USDC base units.
    /// @param recordHash Off-chain evidence record hash, emitted.
    function setWalletPeriodCap(uint256 value, bytes32 recordHash) external {
        _onlyHolder(human);
        emit PolicyChanged(PolicyField.WalletPeriodCap, _policy.walletPeriodCap, value, recordHash);
        _policy.walletPeriodCap = value;
    }

    /// @notice Set the New-Payee Cap (new Registrations allowed per rolling Policy Period).
    /// @dev Human-only. May raise or lower; any value is accepted.
    /// @param value New cap, a count.
    /// @param recordHash Off-chain evidence record hash, emitted.
    function setNewPayeeCap(uint256 value, bytes32 recordHash) external {
        _onlyHolder(human);
        emit PolicyChanged(PolicyField.NewPayeeCap, _policy.newPayeeCap, value, recordHash);
        _policy.newPayeeCap = value;
    }

    /// @notice Set the Policy Period N, which sizes the rolling window.
    /// @dev Human-only. Requires `1 <= days_ <= MAX_POLICY_PERIOD_DAYS`, else `InvalidPolicy`.
    ///      The counted window is day buckets `[today - N, today]`, i.e. N + 1 calendar days
    ///      (a bounded over-approximation of N days, accepted by AD-7). Takes effect immediately
    ///      for all three rings; shortening drops older spend from the window, lengthening
    ///      re-counts retained buckets.
    /// @param days_ New period in days.
    /// @param recordHash Off-chain evidence record hash, emitted.
    function setPolicyPeriod(uint256 days_, bytes32 recordHash) external {
        _onlyHolder(human);
        _requireValidPolicyPeriod(days_);
        emit PolicyChanged(PolicyField.PolicyPeriodDays, _policy.policyPeriodDays, days_, recordHash);
        _policy.policyPeriodDays = days_;
    }

    /// @notice Set the Unpin Delay.
    /// @dev Human-only. Requires `seconds_ >= MIN_UNPIN_DELAY`, else `InvalidPolicy`.
    /// @param seconds_ New delay in seconds.
    /// @param recordHash Off-chain evidence record hash, emitted.
    function setUnpinDelay(uint256 seconds_, bytes32 recordHash) external {
        _onlyHolder(human);
        _requireValidUnpinDelay(seconds_);
        emit PolicyChanged(PolicyField.UnpinDelay, _policy.unpinDelay, seconds_, recordHash);
        _policy.unpinDelay = seconds_;
    }

    // ---------------------------------------------------------------------
    // Registration and payment
    // ---------------------------------------------------------------------

    /// @notice Register Counterparty `a` with limit `l`.
    /// @dev Registrar-only. Checks, in order, reverting on the first failure: invalid payee
    ///      (`InvalidPayee`), pinned (`Pinned`), already Registered (`AlreadyRegistered`), has code
    ///      (`PayeeIsContract`), `l > firstContactCeiling` (`CeilingExceeded`), and for `l > 0` a used-up
    ///      New-Payee Cap (`NewPayeeCapReached`). A Registration at `l == 0` does not count against
    ///      the New-Payee Cap. Contract payees can only be registered by the Human (`setLimit`).
    /// @param a Counterparty address.
    /// @param l Limit, 6-dp USDC base units; at most the First-Contact Ceiling.
    /// @param recordHash Off-chain evidence record hash, emitted.
    function register(address a, uint256 l, bytes32 recordHash) external {
        _onlyHolder(_roleHolders[uint8(Role.Registrar)]);
        if (_isInvalidPayee(a)) revert InvalidPayee();
        Counterparty storage c = _counterparties[a];
        if (c.pinned) revert Pinned();
        if (c.registered) revert AlreadyRegistered();
        if (a.code.length != 0) revert PayeeIsContract();
        if (l > _policy.firstContactCeiling) revert CeilingExceeded();
        if (l > 0 && _remaining(a).newPayeeRemaining == 0) revert NewPayeeCapReached();

        c.registered = true;
        c.limit = l;
        if (l > 0) _recordNewPayee();
        emit CounterpartyRegistered(a, l, recordHash);
    }

    /// @notice Pay `amount` of USDC to Registered Counterparty `a`. The only non-Human value exit.
    /// @dev Payment-only. Checks, in order, reverting on the first failure: `amount == 0`
    ///      (`InvalidAmount`), not Registered (`NotRegistered`), pinned (`Pinned`), a payee with code
    ///      whose limit the Human did not set (`PayeeIsContract`), `amount > cpRemaining`
    ///      (`LimitExceeded`), `amount > walletRemaining` (`WalletCapExceeded`), all from `_remaining(a)`.
    ///      Then records the spend in both rings and transfers via the ERC-20 `transfer` on `USDC`.
    ///      A token revert (insufficient balance, blacklist) bubbles up and rolls back the record.
    /// @param a Counterparty address.
    /// @param amount Amount, 6-dp USDC base units.
    /// @param recordHash Off-chain evidence record hash, emitted.
    function pay(address a, uint256 amount, bytes32 recordHash) external {
        _onlyHolder(_roleHolders[uint8(Role.Payment)]);
        if (amount == 0) revert InvalidAmount();
        Remaining memory r = _remaining(a);
        if (!r.registered) revert NotRegistered();
        if (r.pinned) revert Pinned();
        if (a.code.length != 0 && !r.humanSet) revert PayeeIsContract();
        if (amount > r.cpRemaining) revert LimitExceeded();
        if (amount > r.walletRemaining) revert WalletCapExceeded();

        _recordSpend(a, amount);
        SafeERC20.safeTransfer(IERC20(USDC), a, amount);
        // forge-lint: disable-next-line(reentrancy-events) -- the callee is the fixed Arc USDC system token and the spend is recorded before the call
        emit Paid(a, amount, recordHash);
    }

    // ---------------------------------------------------------------------
    // Tighten and pin (automated roles: can only lower)
    // ---------------------------------------------------------------------

    /// @notice Lower Counterparty `a`'s limit to `min(limit, l)`.
    /// @dev Model or Rules only. Reverts with `StaleEpoch` if `expectedEpoch` is not the current
    ///      Human epoch, so a write computed before a Human `setLimit` cannot land. Never reverts for a
    ///      looser `l` (the limit is simply kept) and always emits `LimitTightened`. Does not register
    ///      an unregistered `a`: its limit is 0 and stays 0.
    /// @param a Counterparty address.
    /// @param l Proposed limit, 6-dp USDC base units.
    /// @param expectedEpoch The Human epoch the caller's decision was based on.
    /// @param recordHash Off-chain evidence record hash, emitted.
    function tighten(address a, uint256 l, uint256 expectedEpoch, bytes32 recordHash) external {
        _onlyModelOrRules();
        Counterparty storage c = _counterparties[a];
        if (expectedEpoch != uint256(c.humanEpoch)) revert StaleEpoch();

        uint256 oldLimit = c.limit;
        uint256 newLimit = l < oldLimit ? l : oldLimit;
        c.limit = newLimit;
        emit LimitTightened(a, oldLimit, newLimit, recordHash);
    }

    /// @notice Pin Counterparty `a`: limit 0, payments blocked, any pending Human unpin vetoed.
    /// @dev Rules only. No epoch check and no payee-validity or code check, so sanctioned contracts
    ///      are pinnable. An unregistered `a` becomes Registered at 0 (not counted against the
    ///      New-Payee Cap, emits `CounterpartyRegistered(a, 0, recordHash)`). Emits
    ///      `CounterpartyPinned`, including on a re-pin.
    /// @param a Counterparty address.
    /// @param recordHash Off-chain evidence record hash, emitted.
    function pin(address a, bytes32 recordHash) external {
        _onlyHolder(_roleHolders[uint8(Role.Rules)]);
        Counterparty storage c = _counterparties[a];
        if (!c.registered) {
            c.registered = true;
            emit CounterpartyRegistered(a, 0, recordHash);
        }
        c.limit = 0;
        c.pinned = true;
        c.unpinRequestedAt = 0;
        emit CounterpartyPinned(a, recordHash);
    }

    /// @notice Release Rules' pin on Counterparty `a`. The limit stays 0 and the epoch is unchanged.
    /// @dev Rules only. Reverts with `NotPinned` if `a` is not pinned. Also clears any pending unpin.
    /// @param a Counterparty address.
    /// @param recordHash Off-chain evidence record hash, emitted.
    function releasePin(address a, bytes32 recordHash) external {
        _onlyHolder(_roleHolders[uint8(Role.Rules)]);
        Counterparty storage c = _counterparties[a];
        if (!c.pinned) revert NotPinned();
        c.pinned = false;
        c.unpinRequestedAt = 0;
        emit PinReleased(a, recordHash);
    }

    // ---------------------------------------------------------------------
    // Human limit and the two-step unpin
    // ---------------------------------------------------------------------

    /// @notice Set Counterparty `a`'s limit to `l` (may raise or lower).
    /// @dev Human-only. Reverts with `InvalidPayee` if `a` is an invalid payee, then with `Pinned` if
    ///      `a` is pinned. Sets `humanSet` (the First-Contact Ceiling no longer applies) and bumps
    ///      `humanEpoch`, which makes any in-flight `tighten` stale. An unregistered `a` becomes
    ///      Registered, even if it has code (by design: the only way to make a contract payee payable), with no
    ///      New-Payee Cap and no ceiling, and emits `CounterpartyRegistered(a, l, recordHash)`.
    /// @param a Counterparty address.
    /// @param l New limit, 6-dp USDC base units.
    /// @param recordHash Off-chain evidence record hash, emitted.
    function setLimit(address a, uint256 l, bytes32 recordHash) external {
        _onlyHolder(human);
        if (_isInvalidPayee(a)) revert InvalidPayee();
        Counterparty storage c = _counterparties[a];
        if (c.pinned) revert Pinned();

        uint256 oldLimit = c.limit;
        if (!c.registered) {
            c.registered = true;
            emit CounterpartyRegistered(a, l, recordHash);
        }
        c.limit = l;
        c.humanSet = true;
        uint64 epoch = c.humanEpoch + 1;
        c.humanEpoch = epoch;
        emit LimitSet(a, oldLimit, l, epoch, recordHash);
    }

    /// @notice Request release of the pin on Counterparty `a`, executable after the Unpin Delay.
    /// @dev Human-only. Reverts with `NotPinned` if `a` is not pinned. A repeated request restarts
    ///      the timer. A Rules re-pin during the delay cancels the request (the veto).
    ///      `executableAt` saturates at max uint256 for a huge Unpin Delay, and is an estimate:
    ///      `executeUnpin` uses the Unpin Delay in force at execution time. Stores `block.timestamp`
    ///      in `unpinRequestedAt`, whose 0 value means "no request".
    /// @param a Counterparty address.
    /// @param reasonHash Decision Record hash for this call, emitted.
    function requestUnpin(address a, bytes32 reasonHash) external {
        _onlyHolder(human);
        Counterparty storage c = _counterparties[a];
        if (!c.pinned) revert NotPinned();

        // forge-lint: disable-next-line(unsafe-typecast) -- a uint64 timestamp lasts ~584 billion years
        c.unpinRequestedAt = uint64(block.timestamp);
        uint256 delay = _policy.unpinDelay;
        uint256 executableAt = type(uint256).max;
        // forge-lint: disable-next-line(block-timestamp) -- overflow guard only; saturates the reported time
        if (delay <= type(uint256).max - block.timestamp) executableAt = block.timestamp + delay;
        emit UnpinRequested(a, executableAt, reasonHash);
    }

    /// @notice Execute a pending unpin of Counterparty `a` once the Unpin Delay has elapsed.
    /// @dev Human-only. Reverts, in order: `NotPinned`, `UnpinNotRequested` (never requested or
    ///      vetoed by a Rules re-pin), `UnpinDelayPending` (elapsed time, by subtraction, is below the
    ///      current Policy Unpin Delay). Unpins, clears the request and bumps `humanEpoch`; the limit
    ///      stays 0 until the Human calls `setLimit`.
    /// @param a Counterparty address.
    /// @param recordHash Off-chain evidence record hash, emitted.
    function executeUnpin(address a, bytes32 recordHash) external {
        _onlyHolder(human);
        Counterparty storage c = _counterparties[a];
        if (!c.pinned) revert NotPinned();
        uint256 requestedAt = c.unpinRequestedAt;
        if (requestedAt == 0) revert UnpinNotRequested();
        // forge-lint: disable-next-line(block-timestamp) -- the delay is hours; validator drift of seconds is immaterial
        if (block.timestamp - requestedAt < _policy.unpinDelay) revert UnpinDelayPending();

        c.pinned = false;
        c.unpinRequestedAt = 0;
        c.humanEpoch += 1;
        emit PinReleased(a, recordHash);
    }

    // ---------------------------------------------------------------------
    // Budget view
    // ---------------------------------------------------------------------

    /// @notice Remaining budget for Counterparty `a` and the wallet, over the rolling Policy Period.
    /// @dev Never reverts. The only budget arithmetic anyone should use (AD-7).
    ///      Every window counts day buckets `[today - N, today]` (lower bound floored at 0), i.e.
    ///      N + 1 calendar days for Policy Period N. `cpRemaining` and `walletRemaining` are
    ///      returned separately; a payment must fit both.
    ///      `cpRemaining = satSub(effectiveLimit, cpWindowSum)` where
    ///      `effectiveLimit = humanSet ? limit : min(limit, firstContactCeiling)`.
    /// @param a Counterparty address (any address; unknown ones return zero Counterparty fields).
    /// @return The remaining amounts and the Counterparty's state.
    function remaining(address a) external view returns (Remaining memory) {
        return _remaining(a);
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    /// @dev Shared implementation of `remaining`; also the only budget arithmetic used by `register` and `pay`.
    function _remaining(address a) internal view returns (Remaining memory r) {
        Counterparty storage c = _counterparties[a];
        uint256 today = block.timestamp / 1 days;
        uint256 n = _policy.policyPeriodDays;

        uint256 limit = c.limit;
        bool humanSet = c.humanSet;
        uint256 ceiling = _policy.firstContactCeiling;
        uint256 effectiveLimit = (humanSet || limit <= ceiling) ? limit : ceiling;

        r.cpRemaining = RollingWindow.satSub(effectiveLimit, RollingWindow.windowSum(_cpSpend[a], today, n));
        r.walletRemaining =
            RollingWindow.satSub(_policy.walletPeriodCap, RollingWindow.windowSum(_walletSpend, today, n));
        r.newPayeeRemaining = RollingWindow.satSub(_policy.newPayeeCap, RollingWindow.windowSum(_newPayees, today, n));
        r.limit = limit;
        r.pinned = c.pinned;
        r.registered = c.registered;
        r.humanSet = humanSet;
        r.humanEpoch = c.humanEpoch;
    }

    /// @dev Record a payment of `amount` to `a` today, into both its Counterparty ring and the wallet ring.
    function _recordSpend(address a, uint256 amount) internal {
        uint256 today = block.timestamp / 1 days;
        RollingWindow.record(_cpSpend[a], today, amount);
        RollingWindow.record(_walletSpend, today, amount);
    }

    /// @dev Record one new Registration today into the new-payee ring.
    function _recordNewPayee() internal {
        RollingWindow.record(_newPayees, block.timestamp / 1 days, 1);
    }

    /// @dev Invalid payee (shared with `setLimit`): zero, this wallet, USDC, any address
    ///      `<= 0xffff` (EVM precompiles, including P256 at `0x100`), the Arc system precompile range
    ///      (top two bytes `0x1800`, e.g. NativeCoinAuthority) and the EIP system address `0xff..fe`.
    ///      `register` rejects Arc system contracts with code by its separate code check. Human
    ///      `setLimit` skips that check by design and may register a code-bearing address.
    function _isInvalidPayee(address a) internal view returns (bool) {
        uint160 v = uint160(a);
        return a == address(this) || a == USDC || v <= 0xffff || (v >> 144) == 0x1800
            || a == 0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE;
    }

    function _requireValidPolicyPeriod(uint256 days_) private pure {
        if (days_ == 0 || days_ > MAX_POLICY_PERIOD_DAYS) revert InvalidPolicy();
    }

    function _requireValidUnpinDelay(uint256 seconds_) private pure {
        if (seconds_ < MIN_UNPIN_DELAY) revert InvalidPolicy();
    }

    /// @dev Same rule as `_onlyHolder`, satisfied by either the Model or the Rules holder.
    function _onlyModelOrRules() private view {
        address m = _roleHolders[uint8(Role.Model)];
        address r = _roleHolders[uint8(Role.Rules)];
        if ((msg.sender != m || m == address(0)) && (msg.sender != r || r == address(0))) revert Unauthorized();
        if (!roleIsContract && msg.sender.code.length != 0) revert Unauthorized();
    }

    function _onlyHolder(address holder) private view {
        if (msg.sender != holder || holder == address(0)) revert Unauthorized();
        if (!roleIsContract && msg.sender.code.length != 0) revert Unauthorized();
    }

    /// @dev Invalid: zero, this wallet, USDC, or an account with code while contracts are not allowed
    ///      (such a holder could never pass `_onlyHolder`, locking funds or bricking the slot).
    function _requireValidAccount(address account, bool allowContract) private view {
        // forge-lint: disable-next-line(require-revert-in-loop) -- reached from the bounded 5-iteration constructor loop
        if (account == address(0) || account == address(this) || account == USDC) revert RoleConflict();
        // forge-lint: disable-next-line(require-revert-in-loop) -- reached from the bounded 5-iteration constructor loop
        if (!allowContract && account.code.length != 0) revert RoleConflict();
    }

    function _requireNotInSlots(address account) private view {
        for (uint256 i; i < ROLE_COUNT; ++i) {
            // forge-lint: disable-next-line(require-revert-in-loop) -- fixed 4-slot bound; a collision must abort
            if (_roleHolders[i] == account) revert RoleConflict();
        }
    }
}
