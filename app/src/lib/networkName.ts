/**
 * A network a wallet is on, by its chain id, in the words a person knows it by (audit E6, 2026-10-01): the dialog said
 * "Your wallet is on network 8453", a number nobody reads. The common ones by name, any other as "another network".
 * Chain ids are public, fixed by each network. Pure data: its one import is the chain registry's literals
 * (config/chainIdentity.ts, no import of its own), so the wallet's chunk takes nothing else with it.
 * Changed on purpose 2026-10-01 (integration pass 3, after the chain2 workstream's G3): Robinhood Chain's id and name are
 * the registry's, not one more copy. The section's testnet is not named here: on domino.money it is off.
 * Changed on purpose 2026-10-06 (the owner: one name for one network, never two on one screen): Base and Arbitrum One are
 * the registry's too, so the wallet dialog says "Arbitrum One" as New position, Positions and the bring card do.
 * Changed on purpose 2026-10-06 (the final check, F3: "BNB Chain" in the wallet dialog, "BNB" in the bring card): this is
 * the app's one table of network names; the bring card takes every name it holds before the origins listing's
 * (v2/crosschain/present.ts OWN_NETWORK_NAMES), so the two can never disagree again.
 */
import { ARBITRUM_ID, ARBITRUM_NAME, BASE_ID, BASE_NAME, ROBINHOOD_ID, ROBINHOOD_NAME } from '../config/chainIdentity'

export const NETWORK_NAMES: Readonly<Record<number, string>> = Object.freeze({
  1: 'Ethereum',
  10: 'OP Mainnet',
  56: 'BNB Chain',
  137: 'Polygon',
  [ROBINHOOD_ID]: ROBINHOOD_NAME,
  [BASE_ID]: BASE_NAME,
  [ARBITRUM_ID]: ARBITRUM_NAME,
  43114: 'Avalanche',
  59144: 'Linea',
})

/** "Base" for 8453, "another network" for a chain this table does not name (or none). */
export function networkName(chainId: number | null | undefined): string {
  return typeof chainId === 'number' && Object.hasOwn(NETWORK_NAMES, chainId) ? NETWORK_NAMES[chainId] : 'another network'
}
