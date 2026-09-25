/**
 * The chain code the page runs (2026-09-25), gathered in one chunk that is
 * loaded on the page's first read of the chain (a wallet's positions, a
 * position's state): the site's routes' own scan and relay reads
 * (functions/_lib/walletPositions.ts, fees.ts, owned.ts) and the page's
 * runtime for them (browser.ts). Loaded this way, the entry every page loads
 * (Home, Markets) carries neither the RPC client, nor Keccak, nor the ABI
 * code, and the automation page's picker does not add them to the financial
 * screens' own closure. The replay worker imports the same modules into its
 * own file. 2026-09-25, later: a position's feature (plain, Auto-compound or
 * Domino-compound) joins, the automation route's own scan
 * (functions/_lib/automation.ts), read here for lib/automationState.ts.
 */
export { ChainError } from '../../../functions/_lib/owned'
export { scanWallet } from '../../../functions/_lib/walletPositions'
export { logsOnChain, stateOnChain } from '../../../functions/_lib/fees'
export { scanAutomation } from '../../../functions/_lib/automation'
export { chainDeps, memoryCache } from './browser'
