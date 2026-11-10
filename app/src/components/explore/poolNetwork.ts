/**
 * A pool on Base or Arbitrum One (added 2026-11-06, the owner's replica rule: Robinhood Chain's pool page on every
 * network): `#/pool/network/<chain>/<pool>/<token>`, the network beside the pool's key and the token its pools were read
 * for, the shape Markets' and New position's network links already take (./routes.ts). Every Robinhood Chain link
 * (`#/pool/<id>`, `#/pool/<id>/<token>`) is untouched. The key is a v4 pool's id or a v3 pool's address as a 32-byte
 * word; both are untrusted text, used only when the network's own pools read lists exactly that pool for that token.
 *
 * A module of its own, apart from ./routes.ts, which the entry every visitor downloads carries: only the screens that open
 * these pages (Markets' network token page, the pool screen) load it. Pure; its one import is the chain list's literals
 * (config/chainIdentity.ts), so tests load this file with that one.
 *
 * Changed on purpose 2026-11-07 (Elysium's screens): the network is any of config/chainIdentity.ts OTHER_V2_CHAIN_IDS (Base,
 * Arbitrum One, and Elysium where the build serves it), written as its plain decimal id; it read 8453 and 42161 alone.
 */
import { isOtherV2ChainId, type OtherV2ChainIdOf } from '../../config/chainIdentity'

/** The route and its in-page section after a second `#`, as ./routes.ts hashParts reads them. */
const POOL_NETWORK = /^#?\/pool\/network\/([1-9][0-9]{0,9})\/(0x[0-9a-fA-F]{64})\/(0x[0-9a-fA-F]{40})(?:#.*)?$/

export interface PoolNetworkLocation {
  /** One of the V2 chains beside Robinhood Chain (config/chainIdentity.ts OTHER_V2_CHAIN_IDS). */
  chainId: OtherV2ChainIdOf
  /** Lowercase. */
  pool: string
  /** Exactly as written. */
  token: string
}

export function parsePoolNetworkHash(hash: string): PoolNetworkLocation | null {
  const found = POOL_NETWORK.exec(hash)
  const chainId = found ? Number(found[1]) : null
  return found && isOtherV2ChainId(chainId) ? { chainId, pool: found[2].toLowerCase(), token: found[3] } : null
}

export const poolNetworkHref = (chainId: PoolNetworkLocation['chainId'], pool: string, token: string) => `/pool/network/${chainId}/${pool}/${token}`
