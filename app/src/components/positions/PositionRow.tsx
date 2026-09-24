import type { ReactNode } from 'react'
import { COPY } from '../../lib/read/screens/copy'
import { rangeBarScale, type Batch, type LookupFailure } from '../../lib/read/screens/positions'
import { failureCode, quietTitle } from '../../lib/read/screens/quietRead'
import type { LiveCard } from '../../lib/ownedPositions'
import { positionHref } from '../explore/routes'
import { TokenMarkPair } from '../TokenIcon'
import { IconChevronRight } from '../icons'
import { Chip, RangeBar, Skeleton } from '../ui'
import { Amount, PairName, PositionStatus, snapshotTitle } from './PositionFigures'

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
function Amounts({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <span className="dm-acct-nft-cell" title={title}>
      <span className="dm-acct-nft-label">{label}</span>
      <span className="dm-acct-nft-amounts">{children}</span>
    </span>
  )
}

/**
 * One of the wallet's positions as a row of Your positions: the pair with its
 * fee and NFT id, where its range sits and whether the price was inside it,
 * its principal and its unclaimed fees. The whole row is the link to the
 * position's own page. Every figure is from one nft-positions read, whose
 * block and age are the row's title and data attributes.
 */
export function PositionRow({ card, batch }: { card: LiveCard; batch: Batch }) {
  const scale = rangeBarScale(card.range.tickLower, card.range.tickUpper, null)
  const [base, quote] = card.currencies
  return (
    <a
      href={positionHref(card.tokenId)}
      className="dm-rows-item dm-own-row"
      data-position-row={card.tokenId}
      data-snapshot={batch.block.number}
      data-stale={batch.freshness.status === 'stale' ? '' : undefined}
      title={snapshotTitle(batch)}
    >
      <span className="dm-acct-nft-pool">
        <TokenMarkPair base={base} quote={quote} size={28} ring="var(--surface-2)" />
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
            <RangeBar lower={scale.lower} upper={scale.upper} current={null} inRange={card.hasLiquidity ? card.inRange : null} />
          </span>
          <PositionStatus card={card} />
        </span>
      </span>

      <Amounts label={COPY.card.principal}>
        <Amount amount={card.principal[0]} />
        <Amount amount={card.principal[1]} />
      </Amounts>

      <Amounts label="Unclaimed fees">
        <Amount amount={card.unsettledFees[0]} />
        <Amount amount={card.unsettledFees[1]} />
      </Amounts>

      <Chevron />
    </a>
  )
}

/** A row whose figures are on their way: the size of a row, nothing to read yet. */
export function PendingRow({ tokenId }: { tokenId: string }) {
  return (
    <div className="dm-rows-item dm-own-row dm-own-row--wait" aria-hidden="true" data-position-pending={tokenId}>
      <span className="dm-acct-nft-pool">
        <Skeleton className="size-7 shrink-0 rounded-full" />
        <Skeleton className="h-3 w-28" />
      </span>
      <Skeleton className="h-3 w-24" />
      <Skeleton className="ml-auto h-3 w-20" />
      <Skeleton className="ml-auto h-3 w-20" />
      <span />
    </div>
  )
}

/**
 * A row whose read failed: its NFT id, still a link to its page, and a dash
 * where each figure would be. Why is the row's title and data attribute.
 */
export function UnreadRow({ tokenId, failure }: { tokenId: string; failure: LookupFailure }) {
  return (
    <a href={positionHref(tokenId)} className="dm-rows-item dm-own-row" data-position-row={tokenId} data-row-reason={failureCode(failure)} title={quietTitle(failure, 'positions')}>
      <span className="dm-acct-nft-pool">
        <span aria-hidden="true" className="dm-acct-nft-nopair">
          <span className="dm-acct-nft-nomark" />
          <span className="dm-acct-nft-nomark" />
        </span>
        <span className="dm-acct-nft-name">
          <span className="dm-acct-nft-pair">
            Position #<span translate="no">{tokenId}</span>
          </span>
        </span>
      </span>
      <span className="dm-acct-nft-range text-fg-subtle">—</span>
      <Amounts label={COPY.card.principal}>
        <span className="text-fg-subtle">—</span>
      </Amounts>
      <Amounts label="Unclaimed fees">
        <span className="text-fg-subtle">—</span>
      </Amounts>
      <Chevron />
    </a>
  )
}
