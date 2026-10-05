/**
 * The address of a position the read-v6 portfolio lists on any V2 chain, inside the existing positions route (Domino V2
 * integration, 2026-10-02): `#/positions/<slug>-v<dex>-<tokenId>`, e.g. `#/positions/base-v3-123456`,
 * `#/positions/arbitrum-v4-77`, `#/positions/robinhood-v3-5`. V1's `#/positions/<digits>` (Robinhood Chain, v4, V1's own
 * reads) is unchanged, so the two never collide. No "v2" in the URL. Shared by the lists and the position page.
 *
 * Pure, no imports: the slugs are the chain profiles' (api-contracts/v2/chains).
 */
const SLUGS: Readonly<Record<number, string>> = Object.freeze({ 4663: 'robinhood', 8453: 'base', 42161: 'arbitrum' })
const CHAINS: Readonly<Record<string, number>> = Object.freeze({ robinhood: 4663, base: 8453, arbitrum: 42161 })
const MAX = (1n << 256n) - 1n
const PARAM = /^(robinhood|base|arbitrum)-v([34])-([1-9][0-9]{0,77})$/

export interface V2PositionRef {
  chainId: 4663 | 8453 | 42161
  dex: 3 | 4
  tokenId: bigint
}

export function v2PositionHref(ref: V2PositionRef): string {
  const slug = SLUGS[ref.chainId]
  if (!slug || (ref.dex !== 3 && ref.dex !== 4) || ref.tokenId < 1n || ref.tokenId > MAX) throw new Error('invalid_position_ref')
  return `#/positions/${slug}-v${ref.dex}-${ref.tokenId.toString(10)}`
}

/** The position a `#/positions/<param>` names, or null for anything else (V1's digits-only ids included). */
export function parseV2PositionParam(param: string | null | undefined): V2PositionRef | null {
  const match = typeof param === 'string' ? PARAM.exec(param) : null
  if (!match) return null
  const tokenId = BigInt(match[3])
  if (tokenId > MAX) return null
  return Object.freeze({ chainId: CHAINS[match[1]] as V2PositionRef['chainId'], dex: Number(match[2]) as 3 | 4, tokenId })
}
