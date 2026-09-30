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
 * 2026-09-25, EIP-5792: the batch simulation Create position falls back to
 * when the wallet does not carry eth_simulateV1 (browser.ts simulateOnChain).
 * 2026-09-27: the owned scan's paced call, for a position's automation vault's ExecutionCompleted logs
 * (lib/automationImpact.ts): one eth_getLogs, no new code.
 * 2026-09-28: the runtime sends through the page's router (lib/chain/failover.ts) to the chain's own RPC or, while it
 * cannot be reached, to its public fallbacks (lib/chain/endpoints.ts); nothing new is exported.
 */
export { ChainError, paced } from '../../../functions/_lib/owned'
export { scanWallet, tokenDetails } from '../../../functions/_lib/walletPositions'
export { logsOnChain, stateOnChain } from '../../../functions/_lib/fees'
export { scanAutomation } from '../../../functions/_lib/automation'
// 2026-09-28: the list's read holds the lanes (holdReads).
export { chainDeps, chainRetryAt, holdReads, memoryCache, simulateOnChain } from './browser'
