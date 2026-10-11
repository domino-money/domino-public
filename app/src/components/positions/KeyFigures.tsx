import { useMemo, type ReactNode } from 'react'
import { LiveFigure, StackedBar, UsdText } from '../figures'
import { RangeBar, Skeleton, Stat, StatStrip, cx } from '../ui'
import { TokenLabel } from '../read/TokenLabel'
import { useFeeHistory } from '../../lib/fees/useFeeHistory'
import { usePastReads } from '../../lib/fees/usePastReads'
import { useLoadMilestone } from '../../lib/useLoadMilestone'
import { historyLoadQuality } from '../../lib/fees/freshness'
import { visibleAmountQuality } from './valueReadiness'
import type { PositionState } from '../../lib/fees/types'
import { formatUsdFloor } from '../../lib/format/usd'
import { shortDate, shortTime } from '../../lib/format/time'
import { readablePrice } from '../../lib/chart/priceFacts'
import { APR_MISSING, aprText, positionApr, spanText } from '../../lib/positionApr'
import { shownCardRange, shownCardTick, type RangeEnd } from '../../lib/read/screens/positions'
import type { LiveCard } from '../../lib/walletCards'
import { Amount, blockTitle } from './PositionFigures'
import { rangeWords, type CardPrice } from './PositionRange'
import { cardUsd } from './visual/PortfolioSummary'
import { basisOf, positive, rawPair, unitsText, usdgSide, valueShares } from './visual/value'

/*
 * A position's key figures (the owner, 2026-09-27: "Domino is for people who know nothing of liquidity pools"): four
 * tiles on one grid, each a label, one figure and what explains it, the figures on one line across the tiles:
 * what the position is worth now, the fees ready to collect, Your APR (this position's own fees as a yearly rate,
 * lib/positionApr.ts) and the price now against the position's range. Every figure but Your APR is from the page's
 * one chain read, at its block (the strip's title); Your APR is from the fees history the Fees earned card draws.
 */

/**
 * A price or range end without its "≈": the page writes plain figures (six significant digits, every one in a title).
 * Changed on purpose 2026-10-03 (the owner's point 10: tokens from $0.001 to $1,000,000): a tiny or huge one as DEX
 * screens write it ("0.0₆7101", "2.5B"), the same way the Price range chart writes it (lib/chart/priceRange.ts).
 */
const plain = (text: string) => readablePrice(text.startsWith('≈') ? text.slice(1) : text)
const endText = (end: RangeEnd, tick: number) => (end.kind === 'tick' ? `Tick ${tick}` : plain(end.text))

/** Both amounts of the principal or the fees, one line each. */
function Amounts({ card, which }: { card: LiveCard; which: 'principal' | 'unsettledFees' }) {
  return (
    <span className="dm-pos-amounts" data-stat={which === 'principal' ? 'principal' : 'fees'}>
      <Amount amount={card[which][0]} />
      <Amount amount={card[which][1]} />
    </span>
  )
}

function FigureDetail({ active, label, children }: { active: boolean; label: string; children: ReactNode }) {
  return active ? <details className="dm-position-figure-detail"><summary>{label}</summary>{children}</details> : children
}

/**
 * Your APR: the rate since the position opened, at today's prices, and over the last 24 hours when its chart has a
 * measured point about a day old (lib/positionApr.ts). A skeleton while its history is read; a dash with a few plain
 * words when no rate can be said. Changed on purpose 2026-10-02 (RPC-SPEC §11.4): no estimate any more, and the last
 * 24 hours only from a measured point. Since the chart's periods came back (the same day), that point is the card's 24H
 * start, read at a past block when the history has none a day old (lib/fees/pastReads.ts); the line's title says from
 * when and which block.
 */
function YourApr({ tokenId, compact = false }: { tokenId: string; compact?: boolean }) {
  const fees = useFeeHistory(tokenId)
  // Asks for the 24H start while the tile is shown (no read when the history has one, or for a saved copy); no fills.
  usePastReads(tokenId, '24h', false)
  const drawn = fees.phase === 'verified' || fees.phase === 'cached' ? fees : null
  const rates = useMemo(() => {
    if (!drawn) return null
    const into = usdgSide(drawn.state.currencies) ?? 1
    return { all: positionApr(drawn.history, drawn.state, into, 'all'), day: positionApr(drawn.history, drawn.state, into, '24h') }
  }, [drawn])
  const saved = fees.phase === 'cached' ? fees : null
  useLoadMilestone('position', 'apr', rates?.all.ok ? historyLoadQuality(fees) : null)
  let figure: ReactNode = <span className="text-fg-subtle">—</span>
  // 2026-10-01 (item A13): a history the chain would not give says so, apart from one that cannot be measured.
  const reason = fees.phase === 'unclaimed-only' || fees.phase === 'unavailable' ? fees.reason : null
  let sub: ReactNode = reason === 'rpc_unavailable' ? 'Couldn’t load yet' : reason === 'not_exact' ? 'Not measured for this position' : 'Not measured yet'
  if (fees.phase === 'idle' || fees.phase === 'loading') {
    figure = <Skeleton className="dm-pos-skel-fig" />
    sub = null
  } else if (rates && !rates.all.ok) sub = APR_MISSING[rates.all.reason]
  else if (rates?.all.ok) {
    const { all, day } = rates
    figure = (
      <>
        {aprText(all.rate)}
        {saved && <span className="sr-only"> · Last available history</span>}
      </>
    )
    sub = (
      <span className="dm-pos-lines">
        <span title={`Measured from ${shortDate(all.from.t)} ${shortTime(all.from.t)}, block ${all.from.block}, over ${spanText(all.seconds)}`}>Since opened ({spanText(all.seconds)})</span>
        {saved && <span className="sr-only">Through {shortDate(saved.state.timestamp)} {shortTime(saved.state.timestamp)} · not current</span>}
        {day.ok && (
          <span data-apr-day="" title={`Measured from ${shortDate(day.from.t)} ${shortTime(day.from.t)}, block ${day.from.block}, to now (${spanText(day.seconds)})`}>
            Last 24 hours: {aprText(day.rate)}
          </span>
        )}
      </span>
    )
  }
  return (
    <Stat
      label="Your APR"
      info="This position’s own fees so far, annualized at today’s prices over the money in it. Short periods can change quickly. Not a forecast of future earnings."
      className="dm-pos-stat"
      data-cell="apr"
      data-apr={rates ? (rates.all.ok ? 'ready' : rates.all.reason) : fees.phase}
      data-apr-source={saved ? 'saved-public-history' : undefined}
      title={saved ? 'A copy this browser saved of this position’s public history. Historical, not a current rate.' : undefined}
      sub={compact && rates?.all.ok ? <details className="dm-position-figure-detail"><summary>Period details</summary>{sub}</details> : sub}
    >
      <span className="dm-fig-lg dm-pos-apr">{figure}</span>
    </Stat>
  )
}

/**
 * The current price leads; its quote unit directly below keeps the orientation explicit without crowding the figure.
 * The app's one way round is unchanged. A dash whose reason is its title remains when a price cannot be written.
 */
function PriceNow({ price, card }: { price: CardPrice; card: LiveCard }) {
  const { base, quote } = shownCardRange(card)
  const { state } = price
  if (state.phase === 'ready' && state.price.state === 'usable') {
    return (
      <span className="dm-pos-price" data-current-price="usable" title={`Pool price at block ${state.price.block}: ${state.price.text}`}>
        <span className="dm-fig-lg">{plain(state.price.text)}</span>{' '}
        <span className="dm-pos-price-side dm-pos-price-unit">
          <TokenLabel token={quote} /> per <TokenLabel token={base} />
        </span>
      </span>
    )
  }
  const code = state.phase === 'ready' ? state.price.state : state.phase === 'failed' ? state.code : state.phase
  return (
    <span className="dm-fig-lg text-fg-subtle" title="The pool’s price could not be written with this position’s tokens." data-current-price={code}>
      —
    </span>
  )
}

/**
 * The position's range as one bar from its lower end to its upper end, the price now a dot on it (outside its end when
 * the price is beyond it), the two ends under it and, while it holds liquidity, whether it earns fees now.
 */
function RangeLine({ price, card, cached = false }: { price: CardPrice; card: LiveCard; cached?: boolean }) {
  const { fullRange } = card.range
  // The app's one way round (2026-09-28): the lowest price of the priced token at the bar's left.
  const { low, high, ticks } = shownCardRange(card)
  const usable = price.state.phase === 'ready' && price.state.price.state === 'usable' ? price.state.price : null
  // The band from 5% to 95% of the bar; a price beyond it sits in the room outside its end.
  const share = usable ? (shownCardTick(usable) - ticks.lower) / Math.max(1, ticks.upper - ticks.lower) : null
  const at = share === null ? null : share < 0 ? 0.015 : share > 1 ? 0.985 : 0.05 + 0.9 * share
  const live = !cached && card.hasLiquidity ? card.inRange : null
  return (
    <div className="dm-pos-span" data-stat="range" data-full-range={fullRange ? '' : undefined}>
      <RangeBar lower={0.05} upper={0.95} current={at} inRange={live} label={`${cached ? 'Last known range. ' : ''}${rangeWords(card, price)}`} />
      <span className="dm-pos-span-ends">
        <span>{endText(low.end, low.tick)}</span>
        <span className="dm-pos-span-word">{cached ? 'Last known range' : card.hasLiquidity ? 'Your range' : 'Closed range'}</span>
        <span>{endText(high.end, high.tick)}</span>
      </span>
      {live !== null && (
        <span className="sr-only" data-in={String(live)}>
          {live ? 'In range: earning fees' : 'Out of range: not earning fees'}
        </span>
      )}
    </div>
  )
}

/** `state`: the page's read as a valued state (a pair with USDG), null otherwise. */
export function KeyFigures({ card, state, price, block, cached = false, workspace = false }: { card: LiveCard; state: PositionState | null; price: CardPrice; block: number; cached?: boolean; workspace?: boolean }) {
  const principal = cardUsd(card, state, 'principal')
  const fees = cardUsd(card, state, 'unsettledFees')
  const principalText = principal ? formatUsdFloor(unitsText(principal.units)) : null
  const longPrincipal = !!principalText && principalText.length > 13
  const basis = state && principal ? basisOf(state) : null
  const raw = rawPair([card.principal[0].raw, card.principal[1].raw])
  const shares = basis && raw ? valueShares(basis, raw) : null
  const valueQuality = principal ? 'current' : visibleAmountQuality(card.principal)
  useLoadMilestone('position', 'value', valueQuality && cached ? 'cached' : valueQuality)
  return (
    <StatStrip layout="tiles" className="dm-pos-stats" title={blockTitle(block)} data-position-stats="" data-position-overview={workspace ? '' : undefined} data-valued={principal ? '' : undefined}>
      <Stat
        label="Position value"
        info="What your position is worth now, at the pool’s price. Fees not included."
        className="dm-pos-stat"
        data-cell="principal"
        data-long-value={longPrincipal ? '' : undefined}
        data-value-width={principalText && principalText.length > 11 ? 'wide' : principalText && principalText.length > 8 ? 'medium' : undefined}
        sub={
          principal && (
            <FigureDetail active={workspace} label="Token amounts">
              {/* Neutral inks: on this page Tangerine means the fees series, so the tokens' split never borrows it. A
                  position all in one token has nothing to split: no bar. */}
              {shares && shares[0] > 0 && shares[1] > 0 && <StackedBar className="dm-pos-split" height={4} parts={[{ share: shares[0], tone: 'neutral' }, { share: shares[1], tone: 'muted' }]} />}
              <Amounts card={card} which="principal" />
            </FigureDetail>
          )
        }
      >
        {principal ? (
          <span className="dm-arrive" title={`Pool price at block ${principal.block}`}>
            <LiveFigure value={principalText!} mode={longPrincipal ? 'whole' : 'digits'} dimCents className={cx('dm-fig-lg', longPrincipal && 'dm-position-long-figure')}>
              {longPrincipal && principalText!.split(/(?<=,)/).map((part, index) => <span className="dm-position-amount-group" key={index}>{part}</span>)}
            </LiveFigure>
          </span>
        ) : (
          <Amounts card={card} which="principal" />
        )}
      </Stat>
      <Stat
        label="Fees to collect"
        info="Fees this position earned and has not collected yet."
        className="dm-pos-stat"
        data-cell="fees"
        sub={fees && (workspace ? <details className="dm-position-figure-detail"><summary>Token amounts</summary><Amounts card={card} which="unsettledFees" /></details> : <Amounts card={card} which="unsettledFees" />)}
      >
        {fees ? <UsdText value={unitsText(fees.units)} block={fees.block} floor className={cx('dm-fig-lg dm-arrive', positive(fees.units) && 'dm-fees-in')} /> : <Amounts card={card} which="unsettledFees" />}
      </Stat>
      <YourApr tokenId={card.tokenId} compact={workspace} />
      <Stat
        label={cached ? 'Last known price' : 'Current price'}
        info="The position earns fees while this price is inside its range."
        className="dm-pos-stat"
        data-cell="price"
        sub={<RangeLine price={price} card={card} cached={cached} />}
      >
        <span data-stat="price">
          <PriceNow price={price} card={card} />
        </span>
      </Stat>
    </StatStrip>
  )
}
