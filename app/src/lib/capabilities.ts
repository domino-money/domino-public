/**
 * What this build can and cannot do, in the same shape the workbench serves
 * from GET /api/v1/capabilities. Kept as a module here because this app has no
 * server; the values are identical so the Settings screen tells the truth.
 */
export const CAPABILITIES = {
  version: 1,
  mode: 'practice',
  chainId: 4663,
  signingEnabled: false,
  walletFundingEnabled: false,
  // True only in the bridge-test build, which vite.config.ts refuses to write
  // into dist. The deployed build folds this to false and ships no read code.
  liveDataEnabled: __DOMINO_READ_MODE__ === 'bridge',
  swapsEnabled: false,
  simulation: {
    protocolFeeBps: 200,
    reinvestmentPolicyVersion: 2,
    fixedReserveBps: 0,
    maxLiquidityIncreaseBps: null as number | null,
    gasBufferBps: 1500,
  },
  features: ['position-preview', 'compound-preview', 'local-practice-workspace'],
} as const

export type Availability = 'practice' | 'planned' | 'not-connected'

/** The roadmap rows the workbench shows in Settings. */
export const ROADMAP: Array<{ name: string; status: Availability; note: string }> = [
  { name: 'Compound', status: 'practice', note: 'Run fee scenarios by hand on practice cards.' },
  { name: 'Fee-balancing swaps', status: 'planned', note: 'Bounded swaps so uneven fees can still be reinvested.' },
  { name: 'Domino', status: 'planned', note: 'Fees from one position open the next one higher up.' },
  { name: 'Wallet permissions', status: 'not-connected', note: 'No wallet connection exists in this build.' },
  { name: 'Service pricing', status: 'planned', note: 'Shown at the moment a real position is created. Final rate table pending.' },
]
