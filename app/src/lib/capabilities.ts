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
  // build itself never signs automation transactions. The external operator
  // is checked for each owner and sequence at run time, not by this flag.
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
  // rest; an automatic balancing swap belongs to an admitted sequence's cycle.
  swapsEnabled: false,
} as const

/**
 * Where a ROADMAP entry stands. `connected`: the owner's own wallet does it
 * here, one reviewed step at a time. `owner-scoped`: a sequence starts paused
 * and activation depends on the signed-in owner's live service check for that
 * exact vault. `not-connected`: nothing of it reaches this app. `planned`:
 * terms stated as they stand, nothing to connect.
 */
export type Availability = 'planned' | 'not-connected' | 'owner-scoped' | 'connected'

/**
 * The pill a status wears, where it wears one. A connected or planned entry
 * wears none: its note states its terms as they stand (the service fee is
 * stated as fact on Home and Automate), a "Planned" pill would call the
 * product unfinished and a "Connected" pill would be a claim. The words say
 * where it stands, never a colour.
 */
export const ROADMAP_PILL: Partial<Record<Availability, string>> = {
  'not-connected': 'Not connected',
  'owner-scoped': 'Per sequence',
}

/** What Settings lists, and where each stands today. */
export const ROADMAP: Array<{ name: string; status: Availability; note: string }> = [
  // Changed on purpose (2026-09-25, audit of 754014c): no screen of this site activates, pauses or withdraws any more.
  { name: 'Compound', status: 'owner-scoped', note: 'Earned fees go back into the same position. A new sequence starts paused; your wallet activates it on your sequence vault once the service confirms readiness. No Domino screen makes that transaction today.' },
  { name: 'Fee-balancing swaps', status: 'owner-scoped', note: 'Bounded swaps can balance uneven earned fees during an admitted sequence’s automatic cycle. Its service fee covers them; an unavailable service sends none.' },
  { name: 'Domino', status: 'owner-scoped', note: 'Fees from one position can open the next one higher up. A new sequence starts paused; activation requires a live owner-specific service check.' },
  {
    name: 'Wallet permissions',
    status: 'connected',
    note: 'Sign-in proves your address. Your wallet approves one position NFT to its own sequence vault and creates the sequence here. Authorising or revoking the operator, pausing and withdrawing are transactions it signs on that vault, which no Domino screen makes today. Each step shows its amounts and limits before your wallet requests transaction approval.',
  },
  {
    name: 'Service pricing',
    status: 'planned',
    note: 'Auto-compound uses 2% and Domino-compound 4% of consumed earned fees, once. No additional fee is charged for automation balancing swaps. Direct deposits have no Domino percentage fee. The assisted swap Create position makes when a wallet holds one of the two tokens charges 0.65% of the amount swapped, shown before signing.',
  },
]
