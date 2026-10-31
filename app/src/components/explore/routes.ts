/**
 * The parts of a hash route Markets and the pool page read for themselves,
 * and the links every screen writes.
 *
 * App.tsx hands a screen only the second segment. Markets takes a token
 * address there (`#/markets/<token>`; the older `#/explore/<token>` still
 * reads), the pool page a pool id there and a token after it
 * (`#/pool/<id>/<token>`), which every list writes (2026-09-26). Both are
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

/**
 * New position's link to a pool, `#/new/<id>/<token>` (round 6, 2026-09-27): the token is what the pool page verified
 * an unlisted pool with, so New position verifies it the same way instead of against USDG, which such a pool may not
 * hold. The same shapes as the pool page's own link, and as untrusted.
 */
export function parseNewHash(hash: string): PoolLocation {
  const { segments } = hashParts(hash)
  const [page = '', id = '', third = ''] = segments
  if (page !== 'new') return { poolId: null, token: null }
  return { poolId: POOL_ID.test(id) ? id.toLowerCase() : null, token: ADDRESS.test(third) ? third : null }
}

/** Markets, or a token's view on it. */
export const exploreHref = (token: string | null = null) => (token ? `#/markets/${token}` : '#/markets')

/** The same link under the page's own name. */
export const marketsHref: typeof exploreHref = exploreHref

/** A cross-network token is always identified by both network and address. Existing address-only links stay on Robinhood. */
export interface NetworkTokenLocation {
  chainId: 8453 | 42161
  token: string
  /**
   * QA round 2, N5: New position's pool proposed by a token page's row (`#/new/network/<chain>/<token>/<pool>`), lowercase.
   * A hint only, never trusted: New position chooses it only when that network's own pools read lists exactly that pool.
   * Present only on a New position link that carries one.
   */
  pool?: string
}

function networkLocation(hash: string, page: 'markets' | 'new'): NetworkTokenLocation | null {
  const { segments } = hashParts(hash)
  const [route = '', network = '', chain = '', token = '', pool = ''] = segments
  // Changed on purpose 2026-10-30 (QA round 2, N5): New position's link may carry a fifth segment, a pool id's shape only;
  // anything else after the token is still no route.
  const proposed = page === 'new' && segments.length === 5 && POOL_ID.test(pool)
  if (route !== page || network !== 'network' || (segments.length !== 4 && !proposed) || !ADDRESS.test(token)) return null
  if (chain !== '8453' && chain !== '42161') return null
  return { chainId: Number(chain) as NetworkTokenLocation['chainId'], token, ...(proposed ? { pool: pool.toLowerCase() } : {}) }
}

export const parseMarketsNetworkHash = (hash: string): NetworkTokenLocation | null => networkLocation(hash, 'markets')
export const parseNewNetworkHash = (hash: string): NetworkTokenLocation | null => networkLocation(hash, 'new')
export const marketsNetworkHref = (chainId: NetworkTokenLocation['chainId'], token: string) => `#/markets/network/${chainId}/${token}`
/**
 * Handoff is a token, never a trusted pool selection; New position reads its metadata and pools on the named network again.
 * `pool` (QA round 2, N5): the pool a token page's row proposes, a hint New position checks against its own read.
 */
export const newNetworkHref = (chainId: NetworkTokenLocation['chainId'], token: string, pool: string | null = null) => `#/new/network/${chainId}/${token}${pool ? `/${pool}` : ''}`

export const poolHref = (poolId: string, token: string | null = null) => (token ? `#/pool/${poolId}/${token}` : `#/pool/${poolId}`)

/** New position, or New position with a pool chosen; `token` is one of the pool's tokens to verify it with (parseNewHash). */
export const newPositionHref = (poolId: string | null = null, token: string | null = null) => (poolId ? (token ? `#/new/${poolId}/${token}` : `#/new/${poolId}`) : '#/new')

export const positionsHref = '#/positions' as const

/** One position NFT's own page. */
export const positionHref = (tokenId: string) => `#/positions/${tokenId}`

/** Auto-compound set up on one position NFT (Sequence reads the mode and the id from the link). */
export const compoundHref = (tokenId: string) => `#/sequence/compound/${tokenId}`

/**
 * The automation page with one of the wallet's positions preselected (2026-09-24, the three features joined up):
 * with a mode, that mode is chosen too (`#/sequence/<mode>/<id>`); without one, the page asks which.
 */
export const sequenceHref = (tokenId: string, mode: 'compound' | 'domino' | null = null) => (mode ? `#/sequence/${mode}/${tokenId}` : `#/sequence/${tokenId}`)

export const automateHref = '#/automate' as const

/**
 * The docs, one of their pages, or a section of that page. A section link
 * always carries its route: a bare `#<id>` would open Home.
 */
export const docsHref = (slug: string | null = null, section: string | null = null) => `#/docs${slug ? `/${slug}` : ''}${section ? `#${section}` : ''}`
