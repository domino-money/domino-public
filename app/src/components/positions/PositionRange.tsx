import { useEffect, useRef, useState } from 'react'
import { COPY } from '../../lib/read/screens/copy'
import {
  cardPoolPrice,
  rangeBarScale,
  rangePricesProblem,
  type CardPoolPrice,
  type CardPoolPriceProblem,
  type ChainPositionCard,
  type RangeBarScale,
  type RangeEnd,
} from '../../lib/read/screens/positions'
import { failureCode, quietTitle, reaskDelayMs, whenVisibleAfter } from '../../lib/read/screens/quietRead'
import { useReadSource } from '../../lib/read/screens/readContext'
import { readWithin } from '../../lib/read/screens/screenRead'
import { TokenLabel } from '../read/TokenLabel'
import { Button, RangeBar, cx } from '../ui'

type LiveCard = Extract<ChainPositionCard, { kind: 'live' }>

type PriceState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; price: CardPoolPrice }
  /** The read failed: a dash on screen, the reason only in the title and data attribute. A passing failure is asked again on its own. */
  | { phase: 'failed'; code: string; reason: string }

const PROBLEM: Record<CardPoolPriceProblem, string> = {
  ...COPY.range.problems,
  pool_mismatch: 'The reply describes another pool, so nothing from it is shown.',
}

const POSITION = { inside: 'inside this range', below: 'below this range', above: 'above this range' } as const

const NOT_READ = 'Current price not read'

export interface CardPrice {
  state: PriceState
  /** One lean pool-market read for this card, when asked; ignored while one runs, once one answered, or before the read source is there. */
  read: () => void
  /** False until the app's read source has loaded. */
  canRead: boolean
  /** Where the range and, once read, the pool's tick sit on the bar. */
  scale: RangeBarScale
}

/**
 * The pool's price for one card, only when asked: one lean pool-market read,
 * cancellable, and cancelled when the card leaves the page. Its block is its
 * own, not the card's. A read that failed only for the moment (busy, a
 * transient answer) is asked again on its own, a few times, while the page
 * is visible; nothing else is. The row and its opened body share one of
 * these, so the bar in the row and the bar in the body always agree.
 */
export function useCardPrice(card: LiveCard): CardPrice {
  const source = useReadSource()
  const [state, setState] = useState<PriceState>({ phase: 'idle' })
  const running = useRef<AbortController | null>(null)
  const quiet = useRef<{ attempts: number; cancel: (() => void) | null }>({ attempts: 0, cancel: null })
  useEffect(
    () => () => {
      running.current?.abort()
      quiet.current.cancel?.()
    },
    [],
  )

  const ask = () => {
    if (!source) return
    running.current?.abort()
    const mine = new AbortController()
    running.current = mine
    void readWithin(source, 'pool-market', { poolId: card.poolId }, { signal: mine.signal }).then((outcome) => {
      if (mine.signal.aborted || outcome.state === 'aborted') return
      if (running.current === mine) running.current = null
      if (outcome.state === 'ok') {
        setState({ phase: 'ready', price: cardPoolPrice(card, outcome.data) })
        return
      }
      setState({ phase: 'failed', code: failureCode(outcome), reason: quietTitle(outcome, 'pools') })
      const wait = reaskDelayMs(outcome, quiet.current.attempts)
      if (wait === null) return
      quiet.current.cancel = whenVisibleAfter(wait, () => {
        quiet.current.cancel = null
        quiet.current.attempts += 1
        ask()
      })
    })
  }

  const read = () => {
    // Asked once: a price that answered, or failed for good, is not asked for again from here.
    if (!source || state.phase !== 'idle') return
    setState({ phase: 'loading' })
    ask()
  }

  const usable = state.phase === 'ready' && state.price.state === 'usable' ? state.price : null
  const scale = rangeBarScale(card.range.tickLower, card.range.tickUpper, usable ? usable.tick : null)
  return { state, read, canRead: source !== null, scale }
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
 * The card's range on a log price axis and, only when asked, the pool's price
 * at the block of one lean pool-market read.
 *
 * Each end of the range is written on its own: 0 or ∞ at the pool's usable
 * tick limits (a full-range position covers every price), a price when both
 * decimals are known and it can be written as a plain number, otherwise its
 * tick. The card carries no current price of its own, so until someone asks
 * the bar has no marker and says so. The read itself lives in useCardPrice,
 * shared with the row above.
 */
export function PositionRange({ card, price }: { card: LiveCard; price: CardPrice }) {
  const { state, scale } = price
  const [base, quote] = card.currencies
  const title = rangeWords(card, price)
  const { ends } = card.range
  const writesPrice = ends.lower.kind !== 'tick' || ends.upper.kind !== 'tick'
  const problem = rangePricesProblem(card.range)
  const asking = state.phase === 'idle' || state.phase === 'loading'

  return (
    <div className="dm-acct-range" data-range="">
      <div className="dm-acct-range-head">
        <span className="dm-acct-caps-label">{COPY.card.range}</span>
        <span className="dm-acct-range-now" data-current-price={currentState(state)}>
          <CurrentPrice state={state} card={card} beyond={scale.currentBeyond} />
          {asking && (
            <Button type="button" variant="ghost" size="sm" aria-disabled={state.phase === 'loading' ? true : undefined} onClick={price.read} disabled={!price.canRead}>
              {state.phase === 'loading' ? COPY.range.rereading : 'Show current price'}
            </Button>
          )}
        </span>
      </div>
      <div className={cx('dm-acct-range-bar', !card.hasLiquidity && 'opacity-60')} title={title}>
        <RangeBar lower={scale.lower} upper={scale.upper} current={scale.current} inRange={card.hasLiquidity ? card.inRange : null} label={title} />
      </div>
      <div
        className="dm-acct-range-ends"
        data-prices={card.range.prices ? '' : undefined}
        data-full-range={card.range.fullRange ? '' : undefined}
        data-range-problem={problem ?? undefined}
        title={problem === 'beyond_display' ? COPY.card.pricesBeyondDisplay : problem === 'decimals_unknown' ? COPY.card.pricesUnavailable : undefined}
      >
        <span className="tnum">{ends.lower.kind === 'tick' ? `Tick ${card.range.tickLower}` : `Min ${ends.lower.text}`}</span>
        <span className="dm-acct-range-unit">
          {writesPrice && (
            <>
              <TokenLabel token={quote} /> per <TokenLabel token={base} />
            </>
          )}
        </span>
        <span className="tnum text-right">{ends.upper.kind === 'tick' ? `Tick ${card.range.tickUpper}` : `Max ${ends.upper.text}`}</span>
      </div>
    </div>
  )
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
