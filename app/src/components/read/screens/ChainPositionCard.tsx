import type { ReactNode } from 'react'
import { COPY } from '../../../lib/read/screens/copy'
import { utcTime } from '../../../lib/read/screens/figures'
import type { AmountView, Batch, ChainPositionCard as Card } from '../../../lib/read/screens/positions'
import { NATIVE_CURRENCY, shortAddress } from '../../../lib/read/screens/identity'
import { PositionRange, rangeWords, useCardPrice } from '../../positions/PositionRange'
import { TokenMarkPair } from '../../TokenIcon'
import { IconChevronRight } from '../../icons'
import { Chip, Pill, RangeBar } from '../../ui'
import { TokenLabel } from '../TokenLabel'
import { Address } from './Address'

type LiveCard = Extract<Card, { kind: 'live' }>
type EmptyCard = Extract<Card, { kind: 'empty' }>

export function snapshotText(batch: Batch) {
  const fresh = batch.freshness.status === 'stale' ? `stale, ${batch.freshness.ageSeconds} s old when read` : `fresh, ${batch.freshness.ageSeconds} s old when read`
  return `Block ${batch.block.number} · ${utcTime(batch.block.timestamp)} · ${fresh}`
}

/** One fact in the opened row: label left, value right (`.dm-kv`, two columns from 768px). */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

/** A long figure may wrap, but only after a group separator or the decimal point, never inside a digit group. */
function Breakable({ text }: { text: string }) {
  const parts = text.split(/(?<=[,.])/)
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {part}
          {i < parts.length - 1 && <wbr />}
        </span>
      ))}
    </>
  )
}

function Amount({ amount }: { amount: AmountView }) {
  return (
    <span className="dm-acct-amount" data-amount={amount.kind}>
      <span className="tnum">
        <Breakable text={amount.text} />
      </span>{' '}
      <span className="dm-acct-amount-symbol">
        <TokenLabel token={amount.token} />
      </span>
      {amount.kind === 'raw' && <span className="dm-acct-amount-raw">raw units, decimals unknown</span>}
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
 * What stays on the row whether it is open or not: staleness, the notes that
 * change how the row's figures read, and the block every figure is from.
 */
function RowMeta({ batch, children }: { batch: Batch; children?: ReactNode }) {
  return (
    <span className="dm-acct-nft-meta">
      {batch.freshness.status === 'stale' && <Pill tone="wait">{COPY.card.stalePill}</Pill>}
      {children}
      <span data-snapshot="">
        {COPY.card.snapshot}: {snapshotText(batch)}
      </span>
    </span>
  )
}

/** Where the facts in the opened row come from: chain, public, and nothing about who is looking. */
function Provenance({ children }: { children?: ReactNode }) {
  return (
    <div className="dm-acct-nft-foot">
      <span className="dm-acct-nft-pills">
        <Pill>{COPY.card.chainPill}</Pill>
        <Pill>{COPY.card.publicPill}</Pill>
      </span>
      {children}
    </div>
  )
}

function LiveRow({ card, batch, index }: { card: LiveCard; batch: Batch; index: number }) {
  const titleId = `chain-card-${index}`
  const price = useCardPrice(card)
  const { scale } = price
  const [base, quote] = card.currencies
  return (
    <article aria-labelledby={titleId} className="dm-acct-nft" data-chain-card="live">
      <details>
        {/* The whole row is the summary: it holds no button and no link, and opening it shows the facts under it. */}
        <summary>
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

          <span className="dm-acct-nft-cell">
            <span className="dm-acct-nft-label">{COPY.card.unsettled}</span>
            <span className="dm-acct-nft-amounts">
              <Amount amount={card.unsettledFees[0]} />
              <Amount amount={card.unsettledFees[1]} />
            </span>
          </span>

          <Chevron />

          <RowMeta batch={batch}>
            {!card.hasLiquidity && <span data-no-liquidity="">{COPY.card.noLiquidity}</span>}
            {!card.range.prices && <span>{COPY.card.pricesUnavailable}</span>}
          </RowMeta>
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
              <Address value={card.owner.address} />
              <span className="dm-acct-nft-owner-note">{COPY.card.ownerNote}</span>
            </Fact>
            <Fact label={COPY.card.value}>
              <span className="text-fg-subtle" data-valuation="unavailable" title={`Reason: ${card.valuation.reason}`}>
                {COPY.card.valueUnavailable}
              </span>
            </Fact>
          </dl>
          <p className="dm-acct-nft-note">
            <span className="dm-acct-caps-label">{COPY.card.unsettled}</span> {COPY.card.noHistory}
          </p>
          <Provenance>
            <span className="dm-acct-nft-owner" title={`${card.owner.address} · ownerOf at block ${batch.block.number}, public data`}>
              <span>Owner</span> <Address value={card.owner.address} short /> <span>· owner at block {batch.block.number}</span>
            </span>
          </Provenance>
        </div>
      </details>
    </article>
  )
}

function EmptyRow({ card, batch, index }: { card: EmptyCard; batch: Batch; index: number }) {
  const titleId = `chain-card-${index}`
  return (
    <article aria-labelledby={titleId} className="dm-acct-nft" data-chain-card="empty">
      <details>
        <summary>
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
          <RowMeta batch={batch} />
        </summary>

        <div className="dm-inset dm-acct-nft-body">
          <dl className="dm-kv dm-acct-nft-facts">
            <Fact label="NFT id">
              <Address value={card.tokenId} />
            </Fact>
          </dl>
          <Provenance />
        </div>
      </details>
    </article>
  )
}

/**
 * One position NFT as public chain data, as one row of the Position NFTs
 * list: the pair and its fee, the producer's range state, the principal and
 * the fees not yet collected, and the block it was read at. The whole row is
 * the summary of a disclosure whose body holds the range against the pool's
 * price (read only on request) and the facts behind the row. No control on it
 * can sign or move anything, and no sentence says the viewer owns it: the
 * owner is the NFT's owner at the snapshot block, public data that proves
 * nothing about who is looking.
 */
export function ChainPositionCard({ card, batch, index }: { card: Card; batch: Batch; index: number }) {
  return card.kind === 'live' ? <LiveRow card={card} batch={batch} index={index} /> : <EmptyRow card={card} batch={batch} index={index} />
}
