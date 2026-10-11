import type { CSSProperties } from 'react'
import { TokenMark } from '../../TokenIcon'
import { unreadToken } from '../../../lib/read/project'
import { rem } from '../../../lib/rootScale'

/**
 * A Robinhood Chain mark for legacy deposits and reserves, whose records hold
 * addresses rather than token metadata. It shares the same bounded decoration
 * cache as the surrounding positions; missing artwork stays a neutral disc.
 */
export function QuietMark({ address, size = 24, ring, style }: { address: string; size?: number; ring?: string; style?: CSSProperties }) {
  const token = unreadToken(address)
  return <TokenMark token={token} size={size} ring={ring} style={style} />
}

/** Two quiet marks, the second overlapping the first by 30 %. */
export function QuietMarkPair({ addresses, size = 28, ring = 'var(--card)' }: { addresses: readonly [string, string]; size?: number; ring?: string }) {
  return (
    <span className="inline-flex shrink-0 items-center" aria-hidden="true">
      <QuietMark address={addresses[0]} size={size} ring={ring} />
      <QuietMark address={addresses[1]} size={size} ring={ring} style={{ marginLeft: rem(-size * 0.3) }} />
    </span>
  )
}
