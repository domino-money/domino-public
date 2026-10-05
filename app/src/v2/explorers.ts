import { ROBINHOOD_EXPLORER } from '../config/chainIdentity'
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
 */
const TX: Readonly<Record<V2ChainId, string>> = Object.freeze({
  4663: ROBINHOOD_EXPLORER,
  8453: 'https://basescan.org',
  42161: 'https://arbiscan.io',
})
const CONTRACT: Readonly<Record<V2ChainId, string>> = Object.freeze({
  4663: 'https://robin.etherscan.io',
  8453: 'https://basescan.org',
  42161: 'https://arbiscan.io',
})

/** A V2 chain's page of a transaction, or null for another chain or a malformed hash. */
export function v2TxUrl(chainId: number, hash: string): string | null {
  return isV2ChainId(chainId) && /^0x[0-9a-fA-F]{64}$/.test(hash) ? `${TX[chainId]}/tx/${hash.toLowerCase()}` : null
}

/** A V2 chain's page of a contract (Domino's, verified), or null for another chain or a malformed address. */
export function v2ContractUrl(chainId: number, address: string): string | null {
  return isV2ChainId(chainId) && /^0x[0-9a-fA-F]{40}$/.test(address) ? `${CONTRACT[chainId]}/address/${address.toLowerCase()}` : null
}
