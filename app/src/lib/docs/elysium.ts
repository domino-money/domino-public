/**
 * Elysium in the docs (2026-11-06, the Elysium surface): named last wherever the pages name Domino's networks, in a build
 * where it is live (lib/elysiumIdentity.ts). Its Uniswap addresses come from its profile through the build
 * (scripts/elysium-switch.mjs): the docs carry no chain profile.
 * Added 2026-11-07 (Elysium's pre-launch): before it is live, What Domino is ends with a section of its own, "Elysium"
 * (ELYSIUM_PRELAUNCH, pages/introduction.ts), where Home's Elysium chip leads; every other page says today's words.
 */
import { ELYSIUM_EXPLORER, ELYSIUM_FUNDS_FROM, ELYSIUM_FUNDS_TO, ELYSIUM_LIVE, ELYSIUM_PRELAUNCH, ELYSIUM_V2_ID } from '../elysiumIdentity'

declare const __DOMINO_ELYSIUM_UNISWAP__: { positionManager: string | null; permit2: string | null } | null | undefined

export { ELYSIUM_FUNDS_FROM, ELYSIUM_FUNDS_TO, ELYSIUM_LIVE, ELYSIUM_PRELAUNCH, ELYSIUM_V2_ID }
/** 2026-11-09: live, and no bridge brings funds to Elysium yet (ELYSIUM_FUNDS_TO). */
export const NOT_BROUGHT_TO_ELYSIUM = ELYSIUM_LIVE && !ELYSIUM_FUNDS_TO
export const OTHERS = ELYSIUM_LIVE ? 'Base, Arbitrum One and Elysium' : 'Base and Arbitrum One'
export const NETWORKS = `Robinhood Chain, ${OTHERS}`
export const NETWORKS_OR = ELYSIUM_LIVE ? 'Robinhood Chain, Base, Arbitrum One or Elysium' : 'Robinhood Chain, Base or Arbitrum One'
/** 2026-11-07: a row links Elysium's explorer once it is known (lib/elysiumIdentity.ts). */
export const ELYSIUM_LINKED = ELYSIUM_LIVE && ELYSIUM_EXPLORER !== null
export const GAS_IN = ELYSIUM_LIVE ? 'in ETH, or in HYPE on Elysium' : 'in ETH'

const uniswap = ELYSIUM_LIVE && typeof __DOMINO_ELYSIUM_UNISWAP__ === 'object' ? __DOMINO_ELYSIUM_UNISWAP__ : null
const address = (value: string | null | undefined): string | null => (value && /^0x[0-9a-f]{40}$/.test(value) ? value : null)
export const ELYSIUM_POSITION_MANAGER = address(uniswap?.positionManager)
export const ELYSIUM_PERMIT2 = address(uniswap?.permit2)
