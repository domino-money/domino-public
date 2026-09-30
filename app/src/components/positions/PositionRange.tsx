import type { ReactNode } from 'react'
import { COPY } from '../../lib/read/screens/copy'
import {
  chainPoolPrice,
  rangeBarScale,
  rangePricesProblem,
  shownCardRange,
  shownCardTick,
  type CardPoolPrice,
  type CardPoolPriceProblem,
  type RangeBarScale,
  type RangeEnd,
} from '../../lib/read/screens/positions'
import type { LiveCard } from '../../lib/walletCards'
import { TokenLabel } from '../read/TokenLabel'
import { Button, RangeBar, cx } from '../ui'
import { PriceVsRange, RangeFactsContext, rangeFacts } from './visual/PriceVsRange'

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
 * the read service's pool-market read is no longer asked). The bar is drawn the
 * app's one way round (2026-09-28): its left end is the lowest price of the
 * priced token, whichever way the pool is.
 */
export function chainCardPrice(card: LiveCard, price: { sqrtPriceX96: string | null; tick: number | null; block: number }): CardPrice {
  const ready: CardPoolPrice = chainPoolPrice(card, price)
  const usable = ready.state === 'usable' ? ready : null
  const { ticks } = shownCardRange(card)
  const scale = rangeBarScale(ticks.lower, ticks.upper, usable ? shownCardTick(usable) : null)
  return { state: { phase: 'ready', price: ready }, read: () => undefined, canRead: false, scale, auto: true }
}

/** Words for the bar itself: never a symbol, which is untrusted text and belongs in the page, not an attribute. */
export function rangeWords(card: LiveCard, price: CardPrice) {
  const usable = price.state.phase === 'ready' && price.state.price.state === 'usable' ? price.state.price : null
  const { low, high } = shownCardRange(card)
  const word = (end: RangeEnd, tick: number) => (end.kind === 'tick' ? `tick ${tick}` : end.text)
  const range = card.range.fullRange ? 'full range, 0 to ∞' : `${word(low.end, low.tick)} to ${word(high.end, high.tick)}`
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
 *
 * 2026-09-27: on a position's page the price chart (PriceVsRange) names the range, its ends, the price now and in
 * range or out itself, from this card's own read (RangeFactsContext), at once and in its final box: `chart`, the
 * chart with the pool's hourly line, takes the same place when the history arrives. The head's sentence stays for a
 * screen reader. Without a usable price or a decimal the bar and its ends stand in, as on the list.
 */
export function PositionRange({ card, price, variant = 'bar', chart }: { card: LiveCard; price: CardPrice; variant?: 'bar' | 'page'; chart?: ReactNode }) {
  const { state, scale } = price
  // The app's one way round (2026-09-28): the priced token, the one it is priced in, and the range's lowest and highest price.
  const { base, quote, low, high } = shownCardRange(card)
  const title = rangeWords(card, price)
  const writesPrice = low.end.kind !== 'tick' || high.end.kind !== 'tick'
  const problem = rangePricesProblem(card.range)
  const asking = state.phase === 'idle' || state.phase === 'loading'
  const page = variant === 'page'
  const facts = page ? rangeFacts(card, state.phase === 'ready' ? state.price : null) : null
  const charted = facts !== null
  const unit = writesPrice && (
    <>
      <TokenLabel token={quote} /> per <TokenLabel token={base} />
    </>
  )

  return (
    <RangeFactsContext value={facts}>
      <div className={cx('dm-acct-range', page && 'dm-pos-range')} data-range="" data-charted={charted ? '' : undefined}>
        <div className="dm-acct-range-head">
          <span className="dm-acct-caps-label">{COPY.card.range}</span>
          {/* On a position's page the sentence is for a screen reader and the title: the chart and the status pill show it (§0.3). */}
          <span className={cx('dm-acct-range-now', page && 'dm-provenance')} data-current-price={currentState(state)}>
            <CurrentPrice state={state} card={card} beyond={scale.currentBeyond} />
            {asking && !price.auto && (
              <Button type="button" variant="ghost" size="sm" aria-disabled={state.phase === 'loading' ? true : undefined} onClick={price.read} disabled={!price.canRead}>
                {state.phase === 'loading' ? COPY.range.rereading : 'Show current price'}
              </Button>
            )}
          </span>
        </div>
        {!charted && (
          <div className={cx('dm-acct-range-bar', !card.hasLiquidity && 'opacity-60')} title={title}>
            <RangeBar lower={scale.lower} upper={scale.upper} current={scale.current} inRange={card.hasLiquidity ? card.inRange : null} label={title} />
          </div>
        )}
        {!charted && (
          <div
            className={cx('dm-acct-range-ends', page && 'dm-pos-ends')}
            data-prices={card.range.prices ? '' : undefined}
            data-full-range={card.range.fullRange ? '' : undefined}
            data-range-problem={problem ?? undefined}
            title={problem === 'beyond_display' ? COPY.card.pricesBeyondDisplay : problem === 'decimals_unknown' ? COPY.card.pricesUnavailable : undefined}
          >
            {page ? (
              <>
                <EndText end={low.end} tick={low.tick} word="Min" />
                <span className="dm-acct-range-unit">{unit}</span>
                <EndText end={high.end} tick={high.tick} word="Max" />
              </>
            ) : (
              <>
                <span className="tnum">{low.end.kind === 'tick' ? `Tick ${low.tick}` : `Min ${low.end.text}`}</span>
                <span className="dm-acct-range-unit">{unit}</span>
                <span className="tnum text-right">{high.end.kind === 'tick' ? `Tick ${high.tick}` : `Max ${high.end.text}`}</span>
              </>
            )}
          </div>
        )}
        {/* One place for the chart, with or without its line, so the line fills in where the chart already stands. */}
        {charted
          ? chart || (
              <div className="dm-pos-chart">
                <PriceVsRange series={null} />
              </div>
            )
          : null}
      </div>
    </RangeFactsContext>
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

function currentState(state: PriceState) {
  if (state.phase === 'ready') return state.price.state
  return state.phase === 'idle' ? 'not-read' : state.phase
}

/** The words beside the button: the pool's price and its block once read, or a dash whose reason is its title. */
function CurrentPrice({ state, card, beyond }: { state: PriceState; card: LiveCard; beyond: 'below' | 'above' | null }) {
  const { base, quote } = shownCardRange(card)
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
