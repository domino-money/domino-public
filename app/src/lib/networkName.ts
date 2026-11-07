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
 * Changed on purpose 2026-11-06 (Elysium readiness): every chain V2 serves is named here with the words its screens say
 * (src/v2/chains.ts V2ChainFacts.name; tests/v2/chain-identity.test.mjs holds the two equal for every id of
 * config/chainIdentity.ts V2_CHAIN_IDS). Elysium's row, "Elysium" (lib/elysiumIdentity.ts), is added by its chain id on the
 * day it is one (docs/ELYSIUM_DAY9.md); until then no table here names it.
 * Changed on purpose 2026-11-06 (the Elysium surface): Elysium's row, by its mainnet id (99901) after Arbitrum One's, is
 * in the table exactly when the build's switch says Elysium is live (lib/elysiumIdentity.ts ELYSIUM_LIVE: every day-9
 * piece is in the repository, so V2 serves it; scripts/elysium-switch.mjs). Today it is not, and the table is what it was.
 * Its second import is that file's literals, which import nothing either.
 */
import { ARBITRUM_ID, ARBITRUM_NAME, BASE_ID, BASE_NAME, ROBINHOOD_ID, ROBINHOOD_NAME } from '../config/chainIdentity'
import { ELYSIUM_LIVE, ELYSIUM_NAME, ELYSIUM_V2_ID } from './elysiumIdentity'

/** Elysium's row, by its mainnet id, in a build where it is live; none otherwise. */
const ELYSIUM_ROW: Record<number, string> = ELYSIUM_LIVE ? { [ELYSIUM_V2_ID]: ELYSIUM_NAME } : {}

export const NETWORK_NAMES: Readonly<Record<number, string>> = Object.freeze({
  1: 'Ethereum',
  10: 'OP Mainnet',
  56: 'BNB Chain',
  137: 'Polygon',
  [ROBINHOOD_ID]: ROBINHOOD_NAME,
  [BASE_ID]: BASE_NAME,
  [ARBITRUM_ID]: ARBITRUM_NAME,
  ...ELYSIUM_ROW,
  43114: 'Avalanche',
  59144: 'Linea',
})

/** "Base" for 8453, "another network" for a chain this table does not name (or none). */
export function networkName(chainId: number | null | undefined): string {
  return typeof chainId === 'number' && Object.hasOwn(NETWORK_NAMES, chainId) ? NETWORK_NAMES[chainId] : 'another network'
}
