import type { ReactNode } from 'react'
import { COPY } from '../../../lib/read/screens/copy'
import { utcTime } from '../../../lib/read/screens/figures'
import { rangePricesProblem, type AmountView, type Batch, type ChainPositionCard as Card } from '../../../lib/read/screens/positions'
import { NATIVE_CURRENCY, shortAddress } from '../../../lib/read/screens/identity'
import { Figure } from '../../positions/Figure'
import { PositionRange, rangeWords, useCardPrice } from '../../positions/PositionRange'
import { TokenMarkPair } from '../../TokenIcon'
import { IconChevronRight } from '../../icons'
import { Chip, Pill, RangeBar } from '../../ui'
import { TokenLabel } from '../TokenLabel'
import { Address } from './Address'

type LiveCard = Extract<Card, { kind: 'live' }>
type EmptyCard = Extract<Card, { kind: 'empty' }>

/** The block, time and freshness of the read every figure in a row is from: the row's title, never a line on it. */
export function snapshotText(batch: Batch) {
  const fresh = batch.freshness.status === 'stale' ? `stale, ${batch.freshness.ageSeconds} s old when read` : `fresh, ${batch.freshness.ageSeconds} s old when read`
  return `Block ${batch.block.number} · ${utcTime(batch.block.timestamp)} · ${fresh}`
}

/** The snapshot as data attributes on a row: its block, its age when read, and whether it was stale. */
const snapshotData = (batch: Batch) => ({
  'data-snapshot': batch.block.number,
  'data-snapshot-age': batch.freshness.ageSeconds,
  'data-stale': batch.freshness.status === 'stale' ? '' : undefined,
})

/** One fact in the opened row: label left, value right (`.dm-kv`, two columns from 768px). */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

/** An amount in its token's units to six significant digits, every digit in its title; a dash, with the raw amount in its title, when the token's decimals were not read. */
function Amount({ amount }: { amount: AmountView }) {
  const symbol = (
    <span className="dm-acct-amount-symbol">
      <TokenLabel token={amount.token} />
    </span>
  )
  if (amount.kind === 'raw') {
    return (
      <span className="dm-acct-amount" data-amount="raw" title={`Raw amount ${amount.raw}: the token’s decimals were not read`}>
        <span className="text-fg-subtle">—</span> {symbol}
      </span>
    )
  }
  return (
    <span className="dm-acct-amount" data-amount={amount.kind} title={amount.kind === 'units' ? (amount.exact ?? undefined) : undefined}>
      <Figure text={amount.text} /> {symbol}
    </span>
  )
}

/** The producer's own answer at the snapshot block, as the pill a person scans for. The qualifier is read out, not drawn. */
function StatusPill({ card }: { card: LiveCard }) {
  const qualifier = <span className="sr-only"> at this block</span>
  if (!card.hasLiquidity) return <Pill dot>No liquidity{qualifier}</Pill>
  if (card.inRange) {
    return (
      <Pill dot tone="in">
        In range{qualifier}
      </Pill>
    )
  }
  return (
    <Pill dot tone="out">
      Out of range{qualifier}
    </Pill>
  )
}

/** The row's last cell: a chevron that turns when the row is open. The word is for a screen reader. */
function Chevron() {
  return (
    <span className="dm-acct-nft-chev">
      <IconChevronRight size={16} />
      <span className="sr-only">Details</span>
    </span>
  )
}

/**
 * What stays on the row whether it is open or not: the notes that change how
 * the row's figures read, in normal type. Nothing when there are none; the
 * block every figure is from, and whether it was stale, are the row's title
 * and data attributes, never a line or a coloured pill.
 */
function RowMeta({ children }: { children?: ReactNode }) {
  return children ? <span className="dm-acct-nft-meta">{children}</span> : null
}

/** The owner at the snapshot block, and what that is: public data that proves nothing about who is looking. */
const ownerTitle = (card: LiveCard, batch: Batch) => `${card.owner.address}: the NFT’s owner at block ${batch.block.number}, public data. ${COPY.card.ownerNote}`

function LiveRow({ card, batch, index }: { card: LiveCard; batch: Batch; index: number }) {
  const titleId = `chain-card-${index}`
  const price = useCardPrice(card)
  const { scale } = price
  const [base, quote] = card.currencies
  const problem = rangePricesProblem(card.range)
  const notes = !card.hasLiquidity || problem === 'decimals_unknown'
  return (
    <article aria-labelledby={titleId} className="dm-acct-nft" data-chain-card="live" {...snapshotData(batch)}>
      <details>
        {/* The whole row is the summary: it holds no button and no link, and opening it shows the facts under it. Its title is the snapshot every figure is from. */}
        <summary title={snapshotText(batch)}>
          <span className="dm-acct-nft-pool">
            <TokenMarkPair base={base} quote={quote} size={28} ring="var(--surface-2)" />
            <span className="dm-acct-nft-name">
              <h3 id={titleId} className="dm-acct-nft-pair">
                <TokenLabel token={base} /> / <TokenLabel token={quote} />
              </h3>
              <Chip className="dm-acct-nft-chip">
                <span className="dm-acct-nft-chip-text">
                  Uniswap · <span data-fee="">{card.fee}</span> · NFT #<span translate="no">{shortAddress(card.tokenId)}</span>
                </span>
              </Chip>
            </span>
          </span>

          <span className="dm-acct-nft-range">
            <span className="dm-acct-nft-bar">
              <span aria-hidden="true" className="dm-acct-nft-minibar">
                <RangeBar lower={scale.lower} upper={scale.upper} current={scale.current} inRange={card.hasLiquidity ? card.inRange : null} label={rangeWords(card, price)} />
              </span>
              <span data-in-range={card.inRange ? 'yes' : 'no'}>
                <StatusPill card={card} />
              </span>
            </span>
            <span className="dm-acct-nft-ticks tnum">
              {card.range.fullRange && <span data-full-range="">{COPY.card.fullRange} · </span>}
              Ticks {card.range.tickLower} to {card.range.tickUpper}
            </span>
          </span>

          <span className="dm-acct-nft-cell">
            <span className="dm-acct-nft-label">{COPY.card.principal}</span>
            <span className="dm-acct-nft-amounts">
              <Amount amount={card.principal[0]} />
              <Amount amount={card.principal[1]} />
            </span>
          </span>

          <span className="dm-acct-nft-cell" data-fee-history="unavailable" title={COPY.card.noHistory}>
            <span className="dm-acct-nft-label">{COPY.card.unsettled}</span>
            <span className="dm-acct-nft-amounts">
              <Amount amount={card.unsettledFees[0]} />
              <Amount amount={card.unsettledFees[1]} />
            </span>
          </span>

          <Chevron />

          {notes && (
            <RowMeta>
              {!card.hasLiquidity && <span data-no-liquidity="">{COPY.card.noLiquidity}</span>}
              {/* Only an unread decimal is said: an end beyond display already reads "Tick N", and a full-range end needs no decimals. */}
              {problem === 'decimals_unknown' && <span data-range-problem={problem}>{COPY.card.pricesUnavailable}</span>}
            </RowMeta>
          )}
        </summary>

        <div className="dm-inset dm-acct-nft-body">
          <PositionRange card={card} price={price} />
          <dl className="dm-kv dm-kv--two dm-acct-nft-facts">
            <Fact label="NFT id">
              <Address value={card.tokenId} />
            </Fact>
            <Fact label={COPY.card.pool}>
              <Address value={card.poolId} />
            </Fact>
            <Fact label={COPY.card.manager}>
              <Address value={card.positionManager} />
            </Fact>
            <Fact label={COPY.card.hooks}>{card.hooks === NATIVE_CURRENCY ? <span className="dm-acct-mono">{COPY.card.noHooks}</span> : <Address value={card.hooks} />}</Fact>
            <Fact label={COPY.card.tickSpacing}>
              <span className="tnum">{card.tickSpacing}</span>
            </Fact>
            <Fact label={COPY.card.range}>
              <span className="tnum" data-ticks="">
                Ticks {card.range.tickLower} to {card.range.tickUpper}
              </span>
            </Fact>
            <Fact label={COPY.card.owner}>
              {/* The owner at the block, as public data, is said in the title: nothing on the row says who is looking. */}
              <span data-owner-basis={card.owner.basis} title={ownerTitle(card, batch)}>
                <Address value={card.owner.address} />
              </span>
            </Fact>
            <Fact label={COPY.card.value}>
              {/* No value to show is a dash; why is the title, and the closed reason a data attribute. */}
              <span className="text-fg-subtle" data-valuation="unavailable" data-valuation-reason={card.valuation.reason} title={COPY.card.valueUnavailable}>
                —
              </span>
            </Fact>
          </dl>
        </div>
      </details>
    </article>
  )
}

function EmptyRow({ card, batch, index }: { card: EmptyCard; batch: Batch; index: number }) {
  const titleId = `chain-card-${index}`
  return (
    <article aria-labelledby={titleId} className="dm-acct-nft" data-chain-card="empty" {...snapshotData(batch)}>
      <details>
        <summary title={snapshotText(batch)}>
          <span className="dm-acct-nft-pool">
            {/* Where the pair's marks would be: no currencies at this block, so two empty discs. */}
            <span aria-hidden="true" className="dm-acct-nft-nopair">
              <span className="dm-acct-nft-nomark" />
              <span className="dm-acct-nft-nomark" />
            </span>
            <span className="dm-acct-nft-name">
              <h3 id={titleId} className="dm-acct-nft-pair">
                Position NFT #<span translate="no">{shortAddress(card.tokenId)}</span>
              </h3>
            </span>
          </span>
          <span className="dm-acct-nft-empty" data-empty-at-snapshot="">
            {COPY.card.empty}
          </span>
          <Chevron />
        </summary>

        <div className="dm-inset dm-acct-nft-body">
          <dl className="dm-kv dm-acct-nft-facts">
            <Fact label="NFT id">
              <Address value={card.tokenId} />
            </Fact>
          </dl>
        </div>
      </details>
    </article>
  )
}

/**
 * One position NFT as public chain data, as one row of the Position NFTs
 * list: the pair and its fee, the producer's range state, the principal and
 * the fees not collected. The whole row is the summary of a disclosure whose
 * body holds the range against the pool's price (read only on request) and
 * the facts behind the row. Where the figures come from (the block, its time
 * and age, public data) is the row's title and data attributes, never a
 * caption or a pill. No control on it can sign or move anything, and no
 * sentence says the viewer owns it: the owner is the NFT's owner at the
 * snapshot block, public data that proves nothing about who is looking.
 */
export function ChainPositionCard({ card, batch, index }: { card: Card; batch: Batch; index: number }) {
  return card.kind === 'live' ? <LiveRow card={card} batch={batch} index={index} /> : <EmptyRow card={card} batch={batch} index={index} />
}
