/**
 * What a Set up automation link asks of the vault's flow (Domino V2 integration, 2026-10-02): V1's `#/sequence/<mode>/<id>`
 * is read by V1 (lib/create/sequenceDefaults.ts sequenceIntent); the vault's own option, Protection only, is
 * `#/sequence/protection[/<id>]`, which V1's reading leaves out. A link only names the person's own choice: nothing is
 * chosen for them (decision #12). Pure.
 */
export type SetupMode = 'compound' | 'domino' | 'protection'

/** `#/sequence/protection[/<id>]`: Protection only, and the position the link names (a canonical decimal NFT id). */
export function protectionIntent(hash: string): { mode: SetupMode; tokenId: string | null } | null {
  const route = hash.replace(/^#/, '')
  const cut = route.indexOf('#')
  const [, first, second, third] = (cut === -1 ? route : route.slice(0, cut)).split('/')
  if (first !== 'sequence' || second !== 'protection') return null
  return { mode: 'protection', tokenId: third !== undefined && /^[1-9]\d{0,77}$/.test(third) ? third : null }
}
