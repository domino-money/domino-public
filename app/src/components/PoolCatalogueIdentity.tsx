import { catalogueTokenLabel, type PoolCatalogueEntry } from '../config/selectedPoolCatalogue'
import { FEE_VENUE_PREFIX, feeWords } from '../lib/format/fee'
import type { TokenDisplay } from '../lib/read/types'
import { TokenLabel } from './read/TokenLabel'
import { TokenIcon, TokenMark } from './TokenIcon'
import { unreadToken } from '../lib/read/project'
import { rem } from '../lib/rootScale'

export function PoolTokenLabel({ token }: { token: TokenDisplay }) {
  const label = catalogueTokenLabel(token)
  return label === null ? <TokenLabel token={token} /> : <bdi title="Catalogue label; token metadata unavailable">{label}</bdi>
}

/**
 * A list's label for one side of a pool: text only, in `<bdi>`, cut at 14ch as
 * TokenLabel cuts a read symbol. A featured list's labels are its symbols,
 * untrusted text from a service (lib/read/featuredList.ts), so they get the
 * same treatment as a read symbol.
 */
export function CatalogueLabel({ text }: { text: string }) {
  return <bdi className="inline-block max-w-[14ch] truncate align-bottom">{text}</bdi>
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
        const style = { marginLeft: index ? rem(-size * 0.3) : 0 }
        return artwork
          ? <TokenIcon key={index} symbol={artwork} size={size} ring={ring} style={style} />
          : entry.addresses ? <TokenMark key={index} token={unreadToken(entry.addresses[index])} size={size} ring={ring} style={style} />
            : <span key={index} className="inline-block rounded-full bg-surface-3" style={{ width: rem(size), height: rem(size), boxShadow: `0 0 0 2px ${ring}`, ...style }} />
      })}
    </span>
    <span className={compact ? 'font-medium text-fg' : 'min-w-0 font-medium'}><CatalogueLabel text={entry.labels[0]} />/<CatalogueLabel text={entry.labels[1]} />
      {/* The fee as every chip writes it (lib/format/fee.ts, audit E21); a phone keeps the fee and drops "Uniswap · ". */}
      {!compact && (
        <span className="dm-chip mt-1 flex w-fit font-sans font-medium">
          <span className="dm-fee-venue">{FEE_VENUE_PREFIX}</span>
          {feeWords(entry.fee)}
        </span>
      )}
    </span>
    {compact && <span className="tnum">{feeWords(entry.fee)}</span>}
  </>
}
