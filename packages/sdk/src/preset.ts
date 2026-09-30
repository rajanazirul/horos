// The standard Preset's on-chain Policy (`standard@1`), as the PolicyWallet constructor takes it. The Solidity source
// of truth is `standardPreset()` in contracts/script/DeployPolicyWallet.s.sol; a test pins these values to the Demo
// wallet fixture. Amounts are 6-dp USDC base units.
export interface OnchainPolicy {
  /** First-Contact Ceiling: the most a new Counterparty can be paid before a Check registers a Limit. */
  readonly firstContactCeiling: bigint;
  /** Wallet Period Cap: total outflow per Policy Period. */
  readonly walletPeriodCap: bigint;
  /** New-Payee Cap: new Counterparties per Policy Period (a count, not an amount). */
  readonly newPayeeCap: bigint;
  /** Policy Period, in days. */
  readonly policyPeriodDays: bigint;
  /** Unpin Delay, in seconds. */
  readonly unpinDelay: bigint;
}

/** The standard Preset the deploy helper uses: 500 USDC first contact, 5,000 USDC per 30 days, 10 new payees, 24 h unpin delay. */
export const STANDARD_PRESET: Readonly<{ version: "standard@1"; onchain: OnchainPolicy }> = Object.freeze({
  version: "standard@1",
  onchain: Object.freeze({
    firstContactCeiling: 500_000_000n,
    walletPeriodCap: 5_000_000_000n,
    newPayeeCap: 10n,
    policyPeriodDays: 30n,
    unpinDelay: 86_400n,
  }),
});
