/** Build capabilities and connection status for Settings.
 * Wallet transactions are prepared locally and require a separate wallet
 * review. Runtime activation comes from the verified deployment/services;
 * these constants never authorize a transaction or establish a session.
 */
export const CAPABILITIES = {
  version: 1,
  chainId: 4663,
  // What this build switches on by itself: nothing that spends. Domino V1 is
  // deployed on Robinhood Chain (docs/V1_MAINNET_FRONTEND_HANDOFF_0XDECIMAL.md),
  // and the owner funds, swaps and mints in Setup and creates or manages a
  // sequence with their own wallet; those flows are admitted at run time by
  // the release endpoints (finance/release.ts), never by these flags. The
  // automated signing named here is the operator's, and that service does
  // not run: AUTOMATION_SERVICE below.
  signingEnabled: false,
  walletFundingEnabled: false,
  // Every deployable build carries wallet sign-in. Whether a session can be
  // established is the session service's call, never this flag.
  walletSignInBuilt: true,
  walletTransactionsBuilt: true,
  privateHistoryBuilt: true,
  // Every build that can be deployed carries the read path. Whether any read
  // is enabled is the server's call, in its capabilities answer, never this flag.
  liveReadsBuilt: true,
  // Setup's assisted swap is the owner's own wallet step, admitted like the
  // rest; the automation's balancing swaps belong to the cycle that does not run.
  swapsEnabled: false,
} as const

// The truth here will come from the service itself once it exists: private
// listeners that watch positions, qualified economic evidence, a publisher for
// the PriceGuard and a restricted operator signer
// (docs/V1_MAINNET_FRONTEND_HANDOFF_0XDECIMAL.md §8, docs/V4_AUTOMATION_CYCLE_POST_DEPLOY.md).
// A deployed address, a release flag or an operator the owner has authorised
// provisions none of that, so until the service reports its own availability
// this stays a constant. It only withholds an offer: no value here ever
// authorises a transaction.
/** Whether the service that decides and executes compounds is running. Read by the Sequence screen before offering activation. */
export const AUTOMATION_SERVICE: { readonly operational: boolean; readonly reason: string } = { operational: false, reason: 'This sequence stays paused: the service that runs automation is not in operation, so activation is not offered.' }

/**
 * Where a ROADMAP entry stands. `connected`: the owner's own wallet does it
 * here, one reviewed step at a time. `not-operational`: the contracts are
 * deployed and the owner can set it up, but the service that would run it
 * does not run (AUTOMATION_SERVICE). `not-connected`: nothing of it reaches
 * this app. `planned`: terms stated as they stand, nothing to connect.
 */
export type Availability = 'planned' | 'not-connected' | 'not-operational' | 'connected'

/**
 * The pill a status wears, where it wears one. A connected or planned entry
 * wears none: its note states its terms as they stand (the service fee is
 * stated as fact on Home and Automate), a "Planned" pill would call the
 * product unfinished and a "Connected" pill would be a claim. The words say
 * where it stands, never a colour.
 */
export const ROADMAP_PILL: Partial<Record<Availability, string>> = {
  'not-connected': 'Not connected',
  'not-operational': 'Not running',
}

/** What Settings lists, and where each stands today. */
export const ROADMAP: Array<{ name: string; status: Availability; note: string }> = [
  { name: 'Compound', status: 'not-operational', note: 'Earned fees go back into the same position. You can create the sequence now, and it starts paused; the service that compounds is not running.' },
  { name: 'Fee-balancing swaps', status: 'not-operational', note: 'Bounded swaps so uneven fees can still be reinvested. They belong to the automatic cycle, which is not running, and its fee covers them.' },
  { name: 'Domino', status: 'not-operational', note: 'Fees from one position open the next one higher up. You can create the sequence now, and it starts paused; the service that compounds is not running.' },
  {
    name: 'Wallet permissions',
    status: 'connected',
    note: 'Sign-in proves your address. Your wallet approves one position NFT to its own sequence, authorises or revokes the operator, and pauses or recovers. Each step shows its amounts and limits before your wallet requests transaction approval.',
  },
  {
    name: 'Service pricing',
    status: 'planned',
    note: 'Auto-compound uses 2% and Domino-compound 4% of consumed earned fees, once. No additional fee is charged for automation balancing swaps. Direct deposits have no Domino percentage fee. The assisted swap Create position makes when a wallet holds one of the two tokens charges 0.65% of the amount swapped, shown before signing.',
  },
]
