import { useEffect, useRef, useState } from 'react'
import { COPY, failureText } from '../../lib/read/screens/copy'
import { cardPoolPrice, rangeBarScale, type CardPoolPrice, type CardPoolPriceProblem, type ChainPositionCard, type RangeBarScale } from '../../lib/read/screens/positions'
import { useReadSource } from '../../lib/read/screens/readContext'
import { readWithin } from '../../lib/read/screens/screenRead'
import { TokenLabel } from '../read/TokenLabel'
import { Button, RangeBar, cx } from '../ui'

type LiveCard = Extract<ChainPositionCard, { kind: 'live' }>

type PriceState = { phase: 'idle' } | { phase: 'loading' } | { phase: 'ready'; price: CardPoolPrice } | { phase: 'failed'; title: string; detail: string }

const PROBLEM: Record<CardPoolPriceProblem, string> = {
  ...COPY.range.problems,
  pool_mismatch: 'The reply describes another pool, so nothing from it is shown.',
}

const POSITION = { inside: 'inside this range', below: 'below this range', above: 'above this range' } as const

const NOT_READ = 'Current price not read'

export interface CardPrice {
  state: PriceState
  /** One lean pool-market read for this card; ignored while one runs or before the read source is there. */
  read: () => void
  /** False until the app's read source has loaded. */
  canRead: boolean
  /** Where the range and, once read, the pool's tick sit on the bar. */
  scale: RangeBarScale
}

/**
 * The pool's price for one card, only when asked: one lean pool-market read
 * per click, cancellable, and cancelled when the card leaves the page. Its
 * block is its own, not the card's. The row and its opened body share one of
 * these, so the bar in the row and the bar in the body always agree.
 */
export function useCardPrice(card: LiveCard): CardPrice {
  const source = useReadSource()
  const [state, setState] = useState<PriceState>({ phase: 'idle' })
  const running = useRef<AbortController | null>(null)
  useEffect(() => () => running.current?.abort(), [])

  const read = () => {
    if (!source || state.phase === 'loading') return
    running.current?.abort()
    const mine = new AbortController()
    running.current = mine
    setState({ phase: 'loading' })
    void readWithin(source, 'pool-market', { poolId: card.poolId }, { signal: mine.signal }).then((outcome) => {
      if (mine.signal.aborted || outcome.state === 'aborted') return
      if (running.current === mine) running.current = null
      if (outcome.state !== 'ok') {
        const text = failureText(outcome, 'pools')
        setState({ phase: 'failed', title: text.title, detail: text.detail })
        return
      }
      setState({ phase: 'ready', price: cardPoolPrice(card, outcome.data) })
    })
  }

  const usable = state.phase === 'ready' && state.price.state === 'usable' ? state.price : null
  const scale = rangeBarScale(card.range.tickLower, card.range.tickUpper, usable ? usable.tick : null)
  return { state, read, canRead: source !== null, scale }
}

/** Words for the bar itself: never a symbol, which is untrusted text and belongs in the page, not an attribute. */
export function rangeWords(card: LiveCard, price: CardPrice) {
  const usable = price.state.phase === 'ready' && price.state.price.state === 'usable' ? price.state.price : null
  const prices = card.range.prices
  const range = prices ? `${prices.lower} to ${prices.upper}` : `ticks ${card.range.tickLower} to ${card.range.tickUpper}`
  const marker = usable
    ? `pool price ${usable.text} at block ${usable.block}, ${POSITION[usable.position]}${price.scale.currentBeyond ? ', beyond the drawn axis' : ''}`
    : NOT_READ.toLowerCase()
  return `Price range ${range}; ${marker}`
}

/**
 * The card's range on a log price axis and, only when asked, the pool's price
 * at the block of one lean pool-market read.
 *
 * The card carries no current price of its own, so until someone asks the bar
 * has no marker and says so. The read itself lives in useCardPrice, shared
 * with the row above.
 */
export function PositionRange({ card, price }: { card: LiveCard; price: CardPrice }) {
  const { state, scale } = price
  const prices = card.range.prices
  const [base, quote] = card.currencies
  const title = rangeWords(card, price)
  const loading = state.phase === 'loading'
  const again = state.phase === 'ready' || state.phase === 'failed'

  return (
    <div className="dm-acct-range" data-range="">
      <div className="dm-acct-range-head">
        <span className="dm-acct-caps-label">{COPY.card.range}</span>
        <span className="dm-acct-range-now" data-current-price={currentState(state)}>
          <CurrentPrice state={state} card={card} beyond={scale.currentBeyond} />
          <Button type="button" variant="ghost" size="sm" aria-disabled={loading ? true : undefined} onClick={price.read} disabled={!price.canRead}>
            {loading ? COPY.range.rereading : again ? COPY.range.reread : 'Show current price'}
          </Button>
        </span>
      </div>
      <div className={cx('dm-acct-range-bar', !card.hasLiquidity && 'opacity-60')} title={title}>
        <RangeBar lower={scale.lower} upper={scale.upper} current={scale.current} inRange={card.hasLiquidity ? card.inRange : null} label={title} />
      </div>
      {prices ? (
        <div className="dm-acct-range-ends" data-prices="">
          <span className="tnum">Min {prices.lower}</span>
          <span className="dm-acct-range-unit">
            <TokenLabel token={quote} /> per <TokenLabel token={base} />
          </span>
          <span className="tnum text-right">Max {prices.upper}</span>
        </div>
      ) : (
        <div className="dm-acct-range-ends">
          <span className="tnum">Tick {card.range.tickLower}</span>
          <span className="dm-acct-range-unit" />
          <span className="tnum text-right">Tick {card.range.tickUpper}</span>
        </div>
      )}
    </div>
  )
}

function currentState(state: PriceState) {
  if (state.phase === 'ready') return state.price.state
  return state.phase === 'idle' ? 'not-read' : state.phase
}

/** The sentence beside the button: what is known about the pool's price, and from which block. */
function CurrentPrice({ state, card, beyond }: { state: PriceState; card: LiveCard; beyond: 'below' | 'above' | null }) {
  const [base, quote] = card.currencies
  switch (state.phase) {
    case 'idle':
      return <span>{NOT_READ}</span>
    case 'loading':
      return <span>{COPY.range.rereading}</span>
    case 'failed':
      return (
        <span>
          {state.title}
          {state.detail && <span className="text-fg-subtle"> · {state.detail}</span>}
        </span>
      )
    case 'ready': {
      const price = state.price
      if (price.state === 'unavailable') {
        return (
          <span>
            {COPY.range.unavailableTitle} at block <span className="tnum">{price.block}</span>
            <span className="text-fg-subtle"> · {PROBLEM[price.problem]}</span>
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
