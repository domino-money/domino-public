import type { ReactNode } from 'react'
import type { LedgerTrace } from '../../lib/fees/store'
import type { PositionState } from '../../lib/fees/types'
import { formatUsdFloor } from '../../lib/format/usd'
import type { LiveCard } from '../../lib/walletCards'
import { positionHref } from '../explore/routes'
import { TokenMarkPair } from '../TokenIcon'
import { IconChevronRight } from '../icons'
import { Skeleton, cx } from '../ui'
import { shortDate, shortTime } from '../../lib/format/time'
import type { RowApr } from './listApr'
import { useLoadMilestone } from '../../lib/useLoadMilestone'
import type { LoadQuality } from '../../lib/loadTiming'
import { Amount, PairName, PositionStatus } from './PositionFigures'
import { cardUsd } from './visual/PortfolioSummary'
import { positive, unitsText } from './visual/value'

/*
 * Your positions as one tidy row each (the owner, round 6, 2026-09-27: "Domino is for people who know nothing about
 * liquidity pools"; clean the table, add each position's APR): the pair and its fee over whether the price is in its
 * range, then Value, Fees ready to collect and Your APR, each one figure, then how its fees are used (a small badge, or
 * Automate for a plain position, beside the row: OwnedPositions.tsx) and the chevron. The two token amounts under Value
 * and Fees are one hover away (a pointer's; a screen reader reads them with the figure), and on a position's page. For
 * a pair without USDG there is no USD: its two amounts are the figure. The whole row is the link to the position's page.
 */

/** The columns' names, for the eye (each cell names itself for a screen reader and, on a phone, for the eye). */
export function RowsHead({ closed = false }: { closed?: boolean }) {
  return (
    <div className="dm-own-band" aria-hidden="true">
      <span>Pool</span>
      <span>Value</span>
      <span>Fees ready to collect</span>
      <span>{closed ? '' : 'Your APR'}</span>
      <span>{closed ? '' : 'Automation'}</span>
      <span />
    </div>
  )
}

/**
 * Value or Fees ready to collect: the USD figure (the list's own read, one block for amounts and price), its two
 * token amounts one hover away; without a USD figure, the two amounts themselves.
 */
function Money({ card, state, which, label }: { card: LiveCard; state: PositionState | null; which: 'principal' | 'unsettledFees'; label: string }) {
  const usd = cardUsd(card, state, which)
  const amounts = (
    <>
      <Amount amount={card[which][0]} />
      <Amount amount={card[which][1]} />
    </>
  )
  return (
    <span className="dm-own-cell" data-cell={which === 'principal' ? 'principal' : 'fees'}>
      <span className="dm-own-label">{label}</span>
      {usd ? (
        <>
          <span className={cx('dm-own-fig dm-arrive', which === 'unsettledFees' && positive(usd.units) && 'dm-fees-in')}>
            {formatUsdFloor(unitsText(usd.units))}
          </span>
          <span className="dm-own-split">{amounts}</span>
        </>
      ) : (
        <span className="dm-own-amounts">{amounts}</span>
      )}
    </span>
  )
}

/**
 * Your APR (listApr.ts): the page's own figure (2026-10-02, RPC-SPEC §11.4: each row's ledger is read with the list, eight
 * a request), a skeleton while one is read, and a dash with a short visible word otherwise (a title alone is not read on
 * a phone).
 */
function Apr({ apr, quality, ledger }: { apr: RowApr | null; quality: LoadQuality | null; ledger?: LedgerTrace | null }) {
  useLoadMilestone('positions', 'apr', apr?.kind === 'rate' ? quality : null)
  let figure: ReactNode = (
    <>
      <span className="dm-own-dash">—</span>
      <span className="dm-own-est">on its page</span>
    </>
  )
  let title: string | undefined = 'Shown on the position’s page'
  if (apr?.kind === 'loading') {
    figure = <Skeleton className="dm-own-skel-apr" />
    title = undefined
  } else if (apr?.kind === 'rate') {
    title = 'Since the position opened'
    // Changed on purpose 2026-10-01 (item D4): the page's UTC time, no block number.
    if (apr.saved) title = `A copy this browser saved, through ${shortDate(apr.saved.timestamp)} ${shortTime(apr.saved.timestamp)}. Not current.`
    figure = (
      <>
        <span className="dm-own-fig">{apr.text}</span>
        {apr.saved && <span className="dm-own-est">saved</span>}
      </>
    )
  } else if (apr?.kind === 'missing') {
    title = apr.words
    // 2026-10-02 (review of the rules, finding 11): its page has no figure either, so the row does not point to it. No dash:
    // the column keeps the width its band gives it from the first paint, so nothing beside it moves.
    if (apr.short) figure = <span className="dm-own-est">{apr.short}</span>
  }
  return (
    <span className="dm-own-cell" data-cell="apr" data-apr={apr?.kind === 'rate' ? 'ready' : (apr?.kind ?? 'none')} data-apr-source={apr?.kind === 'rate' && apr.saved ? 'saved-public-history' : undefined} data-ledger-asks={ledger ? ledger.asks : undefined} data-ledger-last={ledger?.last ?? undefined} title={title}>
      <span className="dm-own-label">Your APR</span>
      <span className="dm-own-aprs">{figure}</span>
    </span>
  )
}

/**
 * One of the wallet's positions as a row of Your positions. Every figure is from the wallet's one chain read, whose
 * block is the row's data attribute (no tooltip: a block number is no beginner's word, and the figures' own hover
 * shows their token amounts); `state` (the same read) values a pair with USDG. `automation`: its badge or
 * Automate, drawn over the row's Automation column as the row's sibling (a link holds no link).
 */
export function PositionRow({ card, block, state = null, apr = null, aprQuality = null, ledger = null, automation }: { card: LiveCard; block: number; state?: PositionState | null; apr?: RowApr | null; aprQuality?: LoadQuality | null; ledger?: LedgerTrace | null; automation?: ReactNode }) {
  const [base, quote] = card.currencies
  return (
    <div className="dm-own-item" data-position-item={card.tokenId}>
      <a href={positionHref(card.tokenId)} className="dm-own-row" data-position-row={card.tokenId} data-snapshot={block}>
        <span className="dm-own-pool">
          <TokenMarkPair base={base} quote={quote} size={32} ring="var(--card)" />
          <span className="dm-own-name">
            <span className="dm-own-title">
              <span className="dm-own-pair">
                <PairName card={card} />
              </span>
              <span className="dm-own-fee">
                <span data-fee="">{card.fee}</span> fee
              </span>
              <span className="sr-only">Position #{card.tokenId}</span>
            </span>
            <span className="dm-own-state">
              <PositionStatus card={card} />
            </span>
          </span>
        </span>
        <span className="dm-own-figs">
          <Money card={card} state={state} which="principal" label="Value" />
          <Money card={card} state={state} which="unsettledFees" label="Fees ready to collect" />
          {card.hasLiquidity && <Apr apr={apr} quality={aprQuality} ledger={ledger} />}
        </span>
        <span className="dm-own-chev">
          <IconChevronRight size={16} />
          <span className="sr-only">Details</span>
        </span>
      </a>
      {automation}
    </div>
  )
}

/** A row whose figures are on their way: the size of a row, bubbles where its figures will be, nothing to read yet. */
export function PendingRow({ tokenId }: { tokenId: string }) {
  return (
    <div className="dm-own-item dm-own-item--wait" aria-hidden="true" data-position-pending={tokenId}>
      <div className="dm-own-row">
        <span className="dm-own-pool">
          <Skeleton className="dm-own-skel-mark" />
          <span className="dm-own-skel-name">
            <Skeleton className="dm-own-skel-pair" />
            <Skeleton className="dm-own-skel-chip" />
          </span>
        </span>
        <span className="dm-own-figs">
          <span className="dm-own-cell" data-cell="principal">
            <Skeleton className="dm-own-skel-fig" />
          </span>
          <span className="dm-own-cell" data-cell="fees">
            <Skeleton className="dm-own-skel-fig dm-own-skel-fig--short" />
          </span>
          <span className="dm-own-cell" data-cell="apr">
            <Skeleton className="dm-own-skel-apr" />
          </span>
        </span>
        <span className="dm-own-chev" />
      </div>
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
    <div className="dm-own-list" aria-hidden="true" data-owned-loading={loading ? '' : undefined}>
      <RowsHead />
      <PendingRow tokenId="" />
    </div>
  )
}
