/**
 * What this build can and cannot do, for the Settings screen.
 *
 * The invited read-only alpha reads public data and nothing else: no
 * signing, no wallet funding, no swaps. These are constants of the build.
 * Whether a live read is enabled is the server's answer to the capabilities
 * GET, never a flag here, and no sign-in state is derived from these values.
 */
export const CAPABILITIES = {
  version: 1,
  chainId: 4663,
  signingEnabled: false,
  walletFundingEnabled: false,
  // Every build that can be deployed carries the read path. Whether any read
  // is enabled is the server's call, in its capabilities answer, never this flag.
  liveReadsBuilt: true,
  swapsEnabled: false,
} as const

export type Availability = 'not-in-alpha' | 'planned' | 'not-connected'

/** What Settings lists, and where each stands in this alpha. */
export const ROADMAP: Array<{ name: string; status: Availability; note: string }> = [
  { name: 'Compound', status: 'not-in-alpha', note: 'Earned fees go back into the same position.' },
  { name: 'Fee-balancing swaps', status: 'not-in-alpha', note: 'Bounded swaps so uneven fees can still be reinvested.' },
  { name: 'Domino', status: 'not-in-alpha', note: 'Fees from one position open the next one higher up.' },
  { name: 'Wallet permissions', status: 'not-connected', note: 'No wallet connection exists in this build.' },
  { name: 'Service pricing', status: 'planned', note: 'Shown when a position is created. Final rate table pending.' },
]
