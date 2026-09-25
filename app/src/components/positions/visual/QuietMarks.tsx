import type { CSSProperties } from 'react'
import { TokenIcon } from '../../TokenIcon'
import { tokenHue } from '../../../lib/format/tokenHue'
import { unreadToken } from '../../../lib/read/project'

/**
 * A token's mark from its address alone, with no request: the bundled
 * artwork of a curated token, or the calm disc its address gives (§3.8).
 * For places that hold only an address (held deposits), where a lookup of
 * remote artwork would be a new request.
 */
export function QuietMark({ address, size = 24, ring, style }: { address: string; size?: number; ring?: string; style?: CSSProperties }) {
  const token = unreadToken(address)
  if (token.artwork) return <TokenIcon symbol={token.artwork} size={size} ring={ring} style={style} />
  const disc = { width: size, height: size, borderRadius: '50%', border: ring ? `2px solid ${ring}` : undefined, display: 'inline-block', flexShrink: 0, '--mark-h': tokenHue(address), ...style } as CSSProperties
  return <span aria-hidden="true" data-token-mark="unknown" className="dm-token-disc" style={disc} />
}

/** Two quiet marks, the second overlapping the first by 30 %. */
export function QuietMarkPair({ addresses, size = 28, ring = 'var(--card)' }: { addresses: readonly [string, string]; size?: number; ring?: string }) {
  return (
    <span className="inline-flex shrink-0 items-center" aria-hidden="true">
      <QuietMark address={addresses[0]} size={size} ring={ring} />
      <QuietMark address={addresses[1]} size={size} ring={ring} style={{ marginLeft: -size * 0.3 }} />
    </span>
  )
}
