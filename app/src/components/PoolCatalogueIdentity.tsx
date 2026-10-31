import { catalogueTokenLabel, type PoolCatalogueEntry } from '../config/selectedPoolCatalogue'
import { ROBINHOOD_ID } from '../config/chainIdentity'
import { FEE_VENUE, feeWords } from '../lib/format/fee'
import { networkName } from '../lib/networkName'
import { FEE_MEANING } from './explore/feeMeaning'
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
export function PoolCatalogueIdentity({ entry, compact = false, network = true }: { entry: PoolCatalogueEntry; compact?: boolean; network?: boolean }) {
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
      {/* The fee as every chip writes it (lib/format/fee.ts, audit E21): "Uniswap · 0.30% fee". V4 draws it as two joined
          segments (.tag), the "·" kept in the text and unseen; Home's phone rows still drop "Uniswap · ". QA round 2: the
          pool's network as the middle segment, as the read row draws it (Q23; every listed pool is Robinhood Chain's;
          Home's rows too, its phone tiles included since the final review, read-2), and what the fee is in the fee's own
          title (Q28). */}
      {!compact && (
        <span className="dm-chip mt-1 flex w-fit font-sans font-medium">
          <span className="dm-fee-venue">{FEE_VENUE}</span><span className="dm-fee-sep"> · </span>
          {network && <><span className="dm-fee-venue dm-fee-net" data-chain-chip={ROBINHOOD_ID}>{networkName(ROBINHOOD_ID)}</span><span className="dm-fee-sep"> · </span></>}
          <span className="dm-fee-value" title={FEE_MEANING}>{feeWords(entry.fee)}</span>
        </span>
      )}
    </span>
    {compact && <span className="tnum">{feeWords(entry.fee)}</span>}
  </>
}
