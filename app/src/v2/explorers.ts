import { ROBINHOOD_EXPLORER } from '../config/chainIdentity'
import { ELYSIUM_EXPLORER, ELYSIUM_LIVE, ELYSIUM_V2_ID } from '../lib/elysiumIdentity'
import { isV2ChainId } from './chains'
import type { V2ChainId } from './types'

/**
 * Where a V2 transaction or contract is shown (rugged97's delta of 4 Oct §1, "Exploradores"; added 2026-10-04): links
 * only, never a read. The app reads Base and Arbitrum One through the wallet's provider and Domino's API alone (spec §6.1),
 * and the registry names no explorer for them (config/chainIdentity.ts): these hosts are for a person's own click.
 *
 *   - transactions: Robinhood Chain's Blockscout, as everywhere else in the app; Basescan; Arbiscan;
 *   - Domino V2's contracts: Robinhood Chain's Blockscout has not imported their Sourcify verification and shows them as
 *     bytecode, so a contract there opens Robin Etherscan (13 of 13 verified), as the delta asks; Basescan and Arbiscan.
 *
 * Changed on purpose 2026-11-06 (Elysium readiness): a chain may have no explorer (null), and then no link is drawn,
 * quietly, as for a malformed hash. Every chain of the app's one list has its row (the type asks for it): Elysium's is
 * its published explorer, or null while it has none (docs/ELYSIUM_DAY9.md).
 * Changed on purpose 2026-11-07 (Elysium as a fourth V2 chain): Elysium's row, where it is live, is lib/elysiumIdentity.ts
 * ELYSIUM_EXPLORER for both, null today: no link until its explorer is known.
 */
const ELYSIUM_ROW: Partial<Record<V2ChainId, string | null>> = ELYSIUM_LIVE ? { [ELYSIUM_V2_ID]: ELYSIUM_EXPLORER } : {}
const TX: Readonly<Record<V2ChainId, string | null>> = Object.freeze({
  4663: ROBINHOOD_EXPLORER,
  8453: 'https://basescan.org',
  42161: 'https://arbiscan.io',
  ...ELYSIUM_ROW,
} as Record<V2ChainId, string | null>)
const CONTRACT: Readonly<Record<V2ChainId, string | null>> = Object.freeze({
  4663: 'https://robin.etherscan.io',
  8453: 'https://basescan.org',
  42161: 'https://arbiscan.io',
  ...ELYSIUM_ROW,
} as Record<V2ChainId, string | null>)

/** A V2 chain's page of a transaction, or null for another chain, a chain without an explorer or a malformed hash. */
export function v2TxUrl(chainId: number, hash: string): string | null {
  const host = isV2ChainId(chainId) ? TX[chainId] : null
  return host && /^0x[0-9a-fA-F]{64}$/.test(hash) ? `${host}/tx/${hash.toLowerCase()}` : null
}

/** A V2 chain's page of a contract (Domino's, verified), or null for another chain, a chain without an explorer or a malformed address. */
export function v2ContractUrl(chainId: number, address: string): string | null {
  const host = isV2ChainId(chainId) ? CONTRACT[chainId] : null
  return host && /^0x[0-9a-fA-F]{40}$/.test(address) ? `${host}/address/${address.toLowerCase()}` : null
}
