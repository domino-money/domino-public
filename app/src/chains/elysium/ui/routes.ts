/**
 * The second chain's section routes (2026-10-01, the chain2 workstream, audit item G5): `#/<chain key>/…`, the key the
 * registry gives the chain ("elysium"), so a link names its chain and the app's existing links (no chain segment) stay
 * Robinhood's. The section reads the whole hash itself: App.tsx's parser keeps two segments, and a pool's or a
 * position's page needs a third.
 *
 *   #/elysium                     Markets (the chain's pools)
 *   #/elysium/pool/<address>      one pool
 *   #/elysium/positions           the connected wallet's positions
 *   #/elysium/position/<id>       one position (an NFT of the source's position manager)
 *   #/elysium/new[/<address>]     New position, in a pool when one is named
 *   #/elysium/receipts            the transactions this browser sent here
 *
 * Every parameter is untrusted text: the screen that takes it checks it (chains/types.ts poolRef, positionRef).
 */
import type { ChainConfig } from '../../../config/chainKit'

export type SectionScreen = 'markets' | 'pool' | 'positions' | 'position' | 'new' | 'receipts'

export interface SectionRoute {
  readonly screen: SectionScreen
  readonly param: string
}

const SCREENS: Readonly<Record<string, SectionScreen>> = { '': 'markets', markets: 'markets', pool: 'pool', positions: 'positions', position: 'position', new: 'new', receipts: 'receipts' }

/** The section's route in a hash, or null when the hash is not this chain's section. */
export function parseSectionHash(hash: string, chain: ChainConfig): SectionRoute | null {
  const route = hash.replace(/^#/, '').split('#')[0]
  const [, key = '', screen = '', param = ''] = route.split('/')
  if (key !== chain.key) return null
  return { screen: Object.hasOwn(SCREENS, screen) ? SCREENS[screen] : 'markets', param: param.slice(0, 80) }
}

/**
 * The tab's name for a screen of the section (fix round 1, 2026-10-01, item E11): every routed screen names its tab and
 * a move to it is announced (lib/routeTitle.ts); the section's screens did neither.
 */
export function sectionTitle(chain: ChainConfig, route: SectionRoute): string {
  const name: Record<SectionScreen, string> = { markets: 'Markets', pool: 'Pool', positions: 'Positions', position: 'Position', new: 'New position', receipts: 'Receipts' }
  return `${name[route.screen]} on ${chain.name}`
}

export const sectionHref = (chain: ChainConfig, screen: SectionScreen = 'markets', param = ''): string =>
  `#/${chain.key}${screen === 'markets' ? '' : `/${screen}`}${param ? `/${encodeURIComponent(param)}` : ''}`
