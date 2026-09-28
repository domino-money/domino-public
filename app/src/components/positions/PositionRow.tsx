import type { ReactNode } from 'react'
import type { PositionState } from '../../lib/fees/types'
import { COPY } from '../../lib/read/screens/copy'
import { rangeBarScale } from '../../lib/read/screens/positions'
import type { LiveCard } from '../../lib/walletCards'
import { positionHref } from '../explore/routes'
import { TokenMarkPair } from '../TokenIcon'
import { IconChevronRight } from '../icons'
import { Chip, RangeBar, Skeleton } from '../ui'
import { Amount, PairName, PositionStatus, blockTitle } from './PositionFigures'
import { RowUsd } from './visual/PortfolioSummary'

/** The row's last cell: a chevron that nudges on hover. The word is for a screen reader. */
function Chevron() {
  return (
    <span className="dm-acct-nft-chev">
      <IconChevronRight size={16} />
      <span className="sr-only">Details</span>
    </span>
  )
}

/** Two stacked amounts under a column's name, which a screen reader hears and a phone shows. */
function Amounts({ label, children, title, cell }: { label: string; children: ReactNode; title?: string; cell?: 'principal' | 'fees' }) {
  return (
    <span className="dm-acct-nft-cell" title={title} data-cell={cell}>
      <span className="dm-acct-nft-label">{label}</span>
      <span className="dm-acct-nft-amounts">{children}</span>
    </span>
  )
}

/**
 * One of the wallet's positions as a row of Your positions: the pair with its
 * fee and NFT id, where its range sits against the pool's price and whether
 * the price is inside it, its principal and its unclaimed fees. The whole row
 * is the link to the position's own page. Every figure is from the wallet's
 * one chain read (POST /api/owned/v2/positions), whose block is the row's
 * title and data attribute; for a pair with USDG, `state` (the same read)
 * adds each column's USD, after the amounts in the DOM and drawn first.
 */
export function PositionRow({ card, block, state = null, tick }: { card: LiveCard; block: number; state?: PositionState | null; tick: number | null }) {
  const scale = rangeBarScale(card.range.tickLower, card.range.tickUpper, tick)
  const [base, quote] = card.currencies
  return (
    <a href={positionHref(card.tokenId)} className="dm-rows-item dm-own-row" data-position-row={card.tokenId} data-snapshot={block} title={blockTitle(block)}>
      <span className="dm-acct-nft-pool">
        <TokenMarkPair base={base} quote={quote} size={32} ring="var(--card)" />
        <span className="dm-acct-nft-name">
          <span className="dm-acct-nft-pair">
            <PairName card={card} />
          </span>
          <Chip className="dm-acct-nft-chip">
            <span className="dm-acct-nft-chip-text">
              <span data-fee="">{card.fee}</span> · #<span translate="no">{card.tokenId}</span>
            </span>
          </Chip>
        </span>
      </span>

      <span className="dm-acct-nft-range">
        <span className="dm-acct-nft-bar">
          <span aria-hidden="true" className="dm-acct-nft-minibar">
            <RangeBar lower={scale.lower} upper={scale.upper} current={scale.current} inRange={card.hasLiquidity ? card.inRange : null} />
          </span>
          <PositionStatus card={card} />
        </span>
      </span>

      <Amounts label={COPY.card.principal} cell="principal">
        <Amount amount={card.principal[0]} />
        <Amount amount={card.principal[1]} />
        <RowUsd card={card} state={state} which="principal" />
      </Amounts>

      <Amounts label="Fees ready to collect" cell="fees">
        <Amount amount={card.unsettledFees[0]} />
        <Amount amount={card.unsettledFees[1]} />
        <RowUsd card={card} state={state} which="unsettledFees" />
      </Amounts>

      <Chevron />
    </a>
  )
}

/** A row whose figures are on their way: the size of a row, bubbles where its figures will be, nothing to read yet. */
export function PendingRow({ tokenId }: { tokenId: string }) {
  return (
    <div className="dm-rows-item dm-own-row dm-own-row--wait" aria-hidden="true" data-position-pending={tokenId}>
      <span className="dm-acct-nft-pool">
        <Skeleton className="dm-own-skel-mark" />
        <span className="dm-own-skel-name">
          <Skeleton className="dm-own-skel-pair" />
          <Skeleton className="dm-own-skel-chip" />
        </span>
      </span>
      <span className="dm-acct-nft-range">
        <Skeleton className="dm-own-skel-bar" />
      </span>
      <span className="dm-acct-nft-cell" data-cell="principal">
        <span className="dm-own-skel-figs">
          <Skeleton className="dm-own-skel-fig" />
          <Skeleton className="dm-own-skel-fig dm-own-skel-fig--short" />
        </span>
      </span>
      <span className="dm-acct-nft-cell" data-cell="fees">
        <span className="dm-own-skel-figs">
          <Skeleton className="dm-own-skel-fig" />
          <Skeleton className="dm-own-skel-fig dm-own-skel-fig--short" />
        </span>
      </span>
      <span className="dm-acct-nft-chev" />
    </div>
  )
}

/**
 * Where the portfolio band's two figures will stand (Total value over its hero, Fees ready to collect over its figure), while
 * the list or its values are on their way: the band's own grid, so the rows under it never move when it fills in.
 */
export function PendingSummary() {
  return (
    <div className="dm-portfolio dm-own-skel-band" aria-hidden="true">
      <div className="dm-portfolio-fig">
        <Skeleton className="dm-own-skel-label" />
        <Skeleton className="dm-own-skel-hero" />
      </div>
      <div className="dm-portfolio-fig">
        <Skeleton className="dm-own-skel-label dm-own-skel-label--wide" />
        <Skeleton className="dm-own-skel-lg" />
      </div>
    </div>
  )
}

/**
 * The rows while the list is on its way: the column names the rows will have, then one row's bubbles (a longer list
 * grows under it, the way a list fills). `loading` marks the list's own read (`data-owned-loading`); the page's
 * stand-in while the chunk loads leaves it off.
 */
export function PendingRows({ loading = false }: { loading?: boolean }) {
  return (
    <div className="dm-rows dm-acct-nft-rows" aria-hidden="true" data-owned-loading={loading ? '' : undefined}>
      {/* The column names, as the loaded rows have them (for the eye only): the table keeps its frame while it fills. */}
      <div className="dm-rows-head dm-acct-nft-band">
        <span>Pool</span>
        <span>Range</span>
        <span>Value</span>
        <span>Fees ready to collect</span>
        <span />
      </div>
      <PendingRow tokenId="" />
    </div>
  )
}
