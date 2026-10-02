/**
 * A network a wallet is on, by its chain id, in the words a person knows it by (audit E6, 2026-10-01): the dialog said
 * "Your wallet is on network 8453", a number nobody reads. The common ones by name, any other as "another network".
 * Chain ids are public, fixed by each network. Pure data: its one import is the chain registry's literals
 * (config/chainIdentity.ts, no import of its own), so the wallet's chunk takes nothing else with it.
 * Changed on purpose 2026-10-01 (integration pass 3, after the chain2 workstream's G3): Robinhood Chain's id and name are
 * the registry's, not one more copy. The section's testnet is not named here: on domino.money it is off.
 */
import { ROBINHOOD_ID, ROBINHOOD_NAME } from '../config/chainIdentity'

const NAMES: Readonly<Record<number, string>> = Object.freeze({
  1: 'Ethereum',
  10: 'OP Mainnet',
  56: 'BNB Chain',
  137: 'Polygon',
  [ROBINHOOD_ID]: ROBINHOOD_NAME,
  8453: 'Base',
  42161: 'Arbitrum',
  43114: 'Avalanche',
  59144: 'Linea',
})

/** "Base" for 8453, "another network" for a chain this table does not name (or none). */
export function networkName(chainId: number | null | undefined): string {
  return typeof chainId === 'number' && Object.hasOwn(NAMES, chainId) ? NAMES[chainId] : 'another network'
}
