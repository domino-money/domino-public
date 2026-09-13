/**
 * The parts of a hash route Markets and the pool page read for themselves,
 * and the links every screen writes.
 *
 * App.tsx hands a screen only the second segment. Markets takes a token
 * address there (`#/markets/<token>`; the older `#/explore/<token>` still
 * reads), the pool page a pool id there and a token after it
 * (`#/pool/<id>/<token>`) for a pool outside the selected six. Both are
 * untrusted text from the address bar: a segment is used only when it has
 * exactly the shape of an address or a pool id, and every read made with it
 * is still bound to it by the read pipeline. Older links put a pool id in the
 * section part, `#/pools#<id>`; Markets forwards those.
 *
 * Pure string functions only, with no imports: tests load this file alone.
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const POOL_ID = /^0x[0-9a-fA-F]{64}$/

/** The route's segments after the leading slash, and the in-page section after a second `#`. */
export function hashParts(hash: string): { segments: string[]; section: string } {
  const raw = hash.replace(/^#/, '')
  const cut = raw.indexOf('#')
  const route = cut === -1 ? raw : raw.slice(0, cut)
  const section = cut === -1 ? '' : raw.slice(cut + 1)
  return { segments: route.split('/').slice(1), section }
}

export interface ExploreLocation {
  /** The token to search, exactly as written in the hash, when it is an address. */
  token: string | null
  /** A pool id an older link put in the section part, lowercase, to forward to the pool page. */
  linkedPool: string | null
}

/** The first route segments that open Markets: the canonical one and the two older spellings. */
const MARKETS_PAGES: ReadonlySet<string> = new Set(['markets', 'explore', 'pools'])

export function parseExploreHash(hash: string): ExploreLocation {
  const { segments, section } = hashParts(hash)
  const [page = '', second = ''] = segments
  if (!MARKETS_PAGES.has(page)) return { token: null, linkedPool: null }
  return { token: ADDRESS.test(second) ? second : null, linkedPool: POOL_ID.test(section) ? section.toLowerCase() : null }
}

export interface PoolLocation {
  /** Lowercase, or null when the segment is not the shape of a pool id. */
  poolId: string | null
  /** The token to verify an unlisted pool with, exactly as written, when it is an address. */
  token: string | null
}

export function parsePoolHash(hash: string): PoolLocation {
  const { segments } = hashParts(hash)
  const [page = '', id = '', third = ''] = segments
  if (page !== 'pool') return { poolId: null, token: null }
  return { poolId: POOL_ID.test(id) ? id.toLowerCase() : null, token: ADDRESS.test(third) ? third : null }
}

/** Markets, or a token's view on it. */
export const exploreHref = (token: string | null = null) => (token ? `#/markets/${token}` : '#/markets')

/** The same link under the page's own name. */
export const marketsHref: typeof exploreHref = exploreHref

export const poolHref = (poolId: string, token: string | null = null) => (token ? `#/pool/${poolId}/${token}` : `#/pool/${poolId}`)

export const newPositionHref = (poolId: string | null = null) => (poolId ? `#/new/${poolId}` : '#/new')

export const positionsHref = '#/positions' as const

export const automateHref = '#/automate' as const

export const settingsHref = '#/settings' as const
