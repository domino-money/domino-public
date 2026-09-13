/** Build capabilities and connection status for Settings.
 * Wallet transactions are prepared locally and require a separate wallet
 * review. Runtime activation comes from the verified deployment/services;
 * these constants never authorize a transaction or establish a session.
 */
export const CAPABILITIES = {
  version: 1,
  chainId: 4663,
  // No backend execution or funded deployment is activated by this build.
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
  swapsEnabled: false,
} as const

export type Availability = 'not-in-alpha' | 'planned' | 'not-connected'

/** What Settings lists, and where each stands in this alpha. */
export const ROADMAP: Array<{ name: string; status: Availability; note: string }> = [
  { name: 'Compound', status: 'not-connected', note: 'Earned fees go back into the same position.' },
  { name: 'Fee-balancing swaps', status: 'not-connected', note: 'Bounded swaps so uneven fees can still be reinvested.' },
  { name: 'Domino', status: 'not-connected', note: 'Fees from one position open the next one higher up.' },
  {
    name: 'Wallet permissions',
    status: 'not-connected',
    note: 'Sign-in proves your address. Each deposit step separately shows its amounts and limits before your wallet requests transaction approval.',
  },
  { name: 'Service pricing', status: 'planned', note: 'Automation uses 2% of consumed earned fees. Direct deposits have no Domino percentage fee. An assisted swap shows its separate tariff before approval.' },
]
