/**
 * What a Set up automation link asks of the vault's flow (Domino V2 integration, 2026-10-02): V1's `#/sequence/<mode>/<id>`
 * is read by V1 (lib/create/sequenceDefaults.ts sequenceIntent); the vault's own option, Auto-exit (once Protection only), is
 * `#/sequence/protection[/<id>]`, which V1's reading leaves out. A link only names the person's own choice: nothing is
 * chosen for them (decision #12). Pure.
 */
import { chainHasDex } from '../../v2/chains'
import { parseV2PositionParam, v2PositionHref, type V2PositionRef } from '../route'

export type SetupMode = 'compound' | 'domino' | 'protection'
export type SetupIntent = { mode: SetupMode | null; tokenId: string | null; position: V2PositionRef | null }
export const setupKey = (ref: V2PositionRef): string => `${ref.chainId}:${ref.dex}:${ref.tokenId}`

/** Numeric links retain their original Robinhood v4 identity. New links name the NFT's network and manager. */
export function setupIntent(hash: string): SetupIntent {
  const [, route, first = '', second = ''] = hash.replace(/^#/, '').split(/[?#]/)[0].split('/')
  if (route !== 'sequence') return { mode: null, tokenId: null, position: null }
  const isMode = (value: string): value is SetupMode => ['compound', 'domino', 'protection'].includes(value)
  const mode = isMode(first) ? first : isMode(second) ? second : null
  const param = isMode(first) ? second : first
  const named = parseV2PositionParam(param) ?? (/^[1-9]\d{0,28}$/.test(param) && BigInt(param) < 1n << 96n
    ? { chainId: 4663 as const, dex: 4 as const, tokenId: BigInt(param) } : null)
  // Never a setup for a version its network lacks (v3 on a chain with v4 alone).
  const position = named && chainHasDex(named.chainId, named.dex) ? named : null
  return { mode, tokenId: position?.tokenId.toString() ?? null, position }
}

export function setupHref(ref: V2PositionRef, mode: SetupMode | null = null): string {
  const param = ref.chainId === 4663 && ref.dex === 4 ? ref.tokenId.toString() : v2PositionHref(ref).split('/').at(-1)!
  return `#/sequence/${mode ? `${mode}/` : ''}${param}`
}

/** Keep the established Robinhood v4 return link; all other managers use the qualified detail route. */
export const setupPositionHref = (ref: V2PositionRef): string => ref.chainId === 4663 && ref.dex === 4 ? `#/positions/${ref.tokenId}` : v2PositionHref(ref)

/** `#/sequence/protection[/<id>]`: Auto-exit, and the position the link names (a canonical decimal NFT id). */
export function protectionIntent(hash: string): { mode: SetupMode; tokenId: string | null } | null {
  const route = hash.replace(/^#/, '')
  const cut = route.indexOf('#')
  const [, first, second, third] = (cut === -1 ? route : route.slice(0, cut)).split('/')
  if (first !== 'sequence' || second !== 'protection') return null
  return { mode: 'protection', tokenId: third !== undefined && /^[1-9]\d{0,77}$/.test(third) ? third : null }
}
