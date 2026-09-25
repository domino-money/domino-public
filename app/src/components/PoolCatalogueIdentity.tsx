import { catalogueTokenLabel, type PoolCatalogueEntry } from '../config/selectedPoolCatalogue'
import type { TokenDisplay } from '../lib/read/types'
import { TokenLabel } from './read/TokenLabel'
import { TokenIcon, TokenMark } from './TokenIcon'
import { unreadToken } from '../lib/read/project'

export function PoolTokenLabel({ token }: { token: TokenDisplay }) {
  const label = catalogueTokenLabel(token)
  return label === null ? <TokenLabel token={token} /> : <bdi title="Catalogue label; token metadata unavailable">{label}</bdi>
}

/**
 * Catalogue labels only. Never passed to a token selector or a transaction.
 * Full size in a table row or a pool heading (pair over a "Uniswap · fee" chip);
 * compact in the ticker (small marks, pair, fee).
 */
export function PoolCatalogueIdentity({ entry, compact = false }: { entry: PoolCatalogueEntry; compact?: boolean }) {
  const size = compact ? 16 : 30
  const ring = compact ? 'var(--bg)' : 'var(--card)'
  return <>
    <span className="inline-flex shrink-0 items-center" aria-hidden="true">
      {entry.artwork.map((artwork, index) => {
        const style = { marginLeft: index ? -size * 0.3 : 0 }
        return artwork
          ? <TokenIcon key={index} symbol={artwork} size={size} ring={ring} style={style} />
          : entry.addresses ? <TokenMark key={index} token={unreadToken(entry.addresses[index])} size={size} ring={ring} style={style} />
            : <span key={index} className="inline-block rounded-full bg-surface-3" style={{ width: size, height: size, boxShadow: `0 0 0 2px ${ring}`, ...style }} />
      })}
    </span>
    <span className={compact ? 'font-medium text-fg' : 'min-w-0 font-medium'}><bdi>{entry.labels[0]}</bdi>/<bdi>{entry.labels[1]}</bdi>
      {!compact && <span className="dm-chip mt-1 flex w-fit font-sans font-medium">Uniswap · {entry.fee}</span>}
    </span>
    {compact && <span className="tnum">{entry.fee}</span>}
  </>
}
