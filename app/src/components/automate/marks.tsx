import type { CSSProperties } from 'react'
import { TokenIcon } from '../TokenIcon'
import { unreadToken } from '../../lib/read/project'
import { tokenHue } from '../../lib/format/tokenHue'
import { rem } from '../../lib/rootScale'

/**
 * A currency's mark from its address alone: the bundled artwork of a
 * documented token (USDG, ETH…), otherwise the calm address-hue disc. It asks
 * no provider for artwork, so the automation page makes no request of its own.
 */
export function AddressMark({ address, size = 24 }: { address: string; size?: number }) {
  const artwork = unreadToken(address).artwork
  if (artwork) return <TokenIcon symbol={artwork} size={size} />
  return <span className="dm-token-disc" style={{ width: rem(size), height: rem(size), borderRadius: '50%', display: 'inline-block', flexShrink: 0, '--mark-h': tokenHue(address) } as CSSProperties} />
}
