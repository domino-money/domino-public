import type { CSSProperties, ReactNode } from 'react'
import { rangeGeometry } from '../../lib/chart/range'
import { COPY } from '../../lib/read/screens/copy'
import { chainPoolPrice, rangeBarScale, rangePricesProblem, type CardPoolPrice, type CardPoolPriceProblem, type RangeBarScale, type RangeEnd } from '../../lib/read/screens/positions'
import type { LiveCard } from '../../lib/walletCards'
import { RangePreview } from '../charts/RangePreview'
import { TokenLabel } from '../read/TokenLabel'
import { Button, RangeBar, cx } from '../ui'

type PriceState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; price: CardPoolPrice }
  /** The read failed: a dash on screen, the reason only in the title and data attribute. A passing failure is asked again on its own. */
  | { phase: 'failed'; code: string; reason: string }

const PROBLEM: Record<CardPoolPriceProblem, string> = COPY.range.problems

const POSITION = { inside: 'inside this range', below: 'below this range', above: 'above this range' } as const

const NOT_READ = 'Current price not read'

export interface CardPrice {
  state: PriceState
  /** Asks for the price, where a price is asked for; a chain card's price comes with it, so this does nothing there. */
  read: () => void
  /** Whether `read` can ask anything. */
  canRead: boolean
  /** Where the range and, once read, the pool's tick sit on the bar. */
  scale: RangeBarScale
  /** Read on its own when the card arrives (a position's own page): no button asks for it. */
  auto: boolean
}

/**
 * The pool's price for a card, from the same chain read the card came from
 * (the wallet's list, or a position's /api/fees/v1/state answer): nothing is
 * read for it, so the page's range, bar and price always agree (2026-09-24:
 * the read service's pool-market read is no longer asked).
 */
export function chainCardPrice(card: LiveCard, price: { sqrtPriceX96: string | null; tick: number | null; block: number }): CardPrice {
  const ready: CardPoolPrice = chainPoolPrice(card, price)
  const usable = ready.state === 'usable' ? ready : null
  const scale = rangeBarScale(card.range.tickLower, card.range.tickUpper, usable ? usable.tick : null)
  return { state: { phase: 'ready', price: ready }, read: () => undefined, canRead: false, scale, auto: true }
}

/** Words for the bar itself: never a symbol, which is untrusted text and belongs in the page, not an attribute. */
export function rangeWords(card: LiveCard, price: CardPrice) {
  const usable = price.state.phase === 'ready' && price.state.price.state === 'usable' ? price.state.price : null
  const { ends, tickLower, tickUpper } = card.range
  const word = (end: RangeEnd, tick: number) => (end.kind === 'tick' ? `tick ${tick}` : end.text)
  const range = card.range.fullRange ? 'full range, 0 to ∞' : `${word(ends.lower, tickLower)} to ${word(ends.upper, tickUpper)}`
  const marker = usable
    ? `pool price ${usable.text} at block ${usable.block}, ${POSITION[usable.position]}${price.scale.currentBeyond ? ', beyond the drawn axis' : ''}`
    : NOT_READ.toLowerCase()
  return `Price range ${range}; ${marker}`
}

/**
 * The card's range on a log price axis and the pool's price at the block of
 * the chain read the card came from (chainCardPrice).
 *
 * Each end of the range is written on its own: 0 or ∞ at the pool's usable
 * tick limits (a full-range position covers every price), a price when both
 * decimals are known and it can be written as a plain number, otherwise its
 * tick. A price the read could not give leaves the bar with no marker, and
 * says why in its title.
 */
export function PositionRange({ card, price, variant = 'bar', chart }: { card: LiveCard; price: CardPrice; variant?: 'bar' | 'page'; chart?: ReactNode }) {
  const { state, scale } = price
  const [base, quote] = card.currencies
  const title = rangeWords(card, price)
  const { ends } = card.range
  const writesPrice = ends.lower.kind !== 'tick' || ends.upper.kind !== 'tick'
  const problem = rangePricesProblem(card.range)
  const asking = state.phase === 'idle' || state.phase === 'loading'
  const page = variant === 'page'
  const geometry = page ? previewGeometry(card, state) : null
  const placed = geometry ? endsPlacement(geometry) : null
  const unit = writesPrice && (
    <>
      <TokenLabel token={quote} /> per <TokenLabel token={base} />
    </>
  )

  return (
    <div className={cx('dm-acct-range', page && 'dm-pos-range')} data-range="">
      <div className="dm-acct-range-head">
        <span className="dm-acct-caps-label">{COPY.card.range}</span>
        {/* On a position's page the sentence is for a screen reader and the title: the preview and the status pill show it (§0.3). */}
        <span className={cx('dm-acct-range-now', page && 'dm-provenance')} data-current-price={currentState(state)}>
          <CurrentPrice state={state} card={card} beyond={scale.currentBeyond} />
          {asking && !price.auto && (
            <Button type="button" variant="ghost" size="sm" aria-disabled={state.phase === 'loading' ? true : undefined} onClick={price.read} disabled={!price.canRead}>
              {state.phase === 'loading' ? COPY.range.rereading : 'Show current price'}
            </Button>
          )}
        </span>
      </div>
      {geometry ? (
        // The ends are written once, as Min and Max right under it: the preview labels only the pool's price.
        <div className="dm-pos-preview-wrap" title={title}>
          <RangePreview
            className="dm-pos-preview"
            lower={geometry.lower}
            upper={geometry.upper}
            current={geometry.current}
            inRange={card.hasLiquidity ? card.inRange : false}
            labels={{ current: geometry.currentText && <Approx text={geometry.currentText} /> }}
          />
        </div>
      ) : (
        <div className={cx('dm-acct-range-bar', !card.hasLiquidity && 'opacity-60')} title={title}>
          <RangeBar lower={scale.lower} upper={scale.upper} current={scale.current} inRange={card.hasLiquidity ? card.inRange : null} label={title} />
        </div>
      )}
      <div
        className={cx('dm-acct-range-ends', page && 'dm-pos-ends')}
        // On a position's page Min and Max stand under the band's own edges (CSS, from 768px), the unit between them.
        style={placed ? ({ '--lo': placed.lower, '--hi': placed.upper } as CSSProperties) : undefined}
        data-placed={placed ? '' : undefined}
        data-prices={card.range.prices ? '' : undefined}
        data-full-range={card.range.fullRange ? '' : undefined}
        data-range-problem={problem ?? undefined}
        title={problem === 'beyond_display' ? COPY.card.pricesBeyondDisplay : problem === 'decimals_unknown' ? COPY.card.pricesUnavailable : undefined}
      >
        {page ? (
          <>
            <EndText end={ends.lower} tick={card.range.tickLower} word="Min" />
            <span className="dm-acct-range-unit">{unit}</span>
            <EndText end={ends.upper} tick={card.range.tickUpper} word="Max" />
          </>
        ) : (
          <>
            <span className="tnum">{ends.lower.kind === 'tick' ? `Tick ${card.range.tickLower}` : `Min ${ends.lower.text}`}</span>
            <span className="dm-acct-range-unit">{unit}</span>
            <span className="tnum text-right">{ends.upper.kind === 'tick' ? `Tick ${card.range.tickUpper}` : `Max ${ends.upper.text}`}</span>
          </>
        )}
      </div>
      {chart}
    </div>
  )
}

/** A figure that begins with `≈`, the `≈` dimmed (innerText unchanged, §6.3). */
export function Approx({ text }: { text: string }) {
  if (!text.startsWith('≈')) return <>{text}</>
  return (
    <>
      <span className="dm-approx">≈</span>
      {text.slice(1)}
    </>
  )
}

/** One end under the preview on a position's page: its word small, its figure large (the text reads as before: `Min ≈350.06`). */
function EndText({ end, tick, word }: { end: RangeEnd; tick: number; word: 'Min' | 'Max' }) {
  if (end.kind === 'tick') return <span className="dm-pos-end tnum" data-end={word}>{`Tick ${tick}`}</span>
  return (
    <span className="dm-pos-end" data-end={word}>
      <span className="dm-pos-end-word">{word}</span>{' '}
      <span className="dm-pos-end-fig">
        <Approx text={end.text} />
      </span>
    </span>
  )
}

/**
 * The preview's numbers from the card's ticks and decimals (plain numbers, for
 * geometry only): an end at the pool's limit is 0 or ∞, the current price is
 * the pool's tick when read. Null when an end has no price (decimals unknown,
 * beyond display): the bar is drawn instead.
 */
function previewGeometry(card: LiveCard, state: PriceState): { lower: number; upper: number; current: number | null; currentText: string | null } | null {
  const [base, quote] = card.currencies
  const { ends } = card.range
  if (base.decimals === null || quote.decimals === null || ends.lower.kind === 'tick' || ends.upper.kind === 'tick') return null
  const shift = Math.pow(10, base.decimals - quote.decimals)
  const at = (tick: number) => Math.pow(1.0001, tick) * shift
  const usable = state.phase === 'ready' && state.price.state === 'usable' ? state.price : null
  return {
    lower: ends.lower.kind === 'limit' ? 0 : at(card.range.tickLower),
    upper: ends.upper.kind === 'limit' ? Infinity : at(card.range.tickUpper),
    current: usable ? at(usable.tick) : null,
    currentText: usable ? usable.text : null,
  }
}

/**
 * Where the preview draws the band's two edges, as shares of its width (the preview's own geometry, so the labels
 * under it always meet its edges). Null for a band too narrow for Min and Max to stand inside its edges: the three
 * columns under the preview are kept then.
 */
function endsPlacement(geometry: { lower: number; upper: number; current: number | null }): { lower: number; upper: number } | null {
  const at = rangeGeometry(geometry.lower, geometry.upper, geometry.current, 1)
  if (!(at.upper - at.lower >= 0.45)) return null
  return { lower: Math.round(at.lower * 10_000) / 10_000, upper: Math.round(at.upper * 10_000) / 10_000 }
}

function currentState(state: PriceState) {
  if (state.phase === 'ready') return state.price.state
  return state.phase === 'idle' ? 'not-read' : state.phase
}

/** The words beside the button: the pool's price and its block once read, or a dash whose reason is its title. */
function CurrentPrice({ state, card, beyond }: { state: PriceState; card: LiveCard; beyond: 'below' | 'above' | null }) {
  const [base, quote] = card.currencies
  switch (state.phase) {
    case 'idle':
      return <span>{NOT_READ}</span>
    case 'loading':
      // The button beside it says so.
      return null
    case 'failed':
      return (
        <span title={state.reason} data-price-reason={state.code}>
          Pool price —
        </span>
      )
    case 'ready': {
      const price = state.price
      if (price.state === 'unavailable') {
        return (
          <span title={`${PROBLEM[price.problem]} Block ${price.block}.`} data-price-problem={price.problem}>
            Pool price —
          </span>
        )
      }
      return (
        <span className="text-fg">
          Pool price <span className="tnum">{price.text}</span> <TokenLabel token={quote} /> per <TokenLabel token={base} /> at block{' '}
          <span className="tnum">{price.block}</span>
          <span className="text-fg-muted">
            {' '}
            · {POSITION[price.position]}
            {beyond && ', beyond the drawn axis'}
          </span>
        </span>
      )
    }
    default:
      return state satisfies never
  }
}
