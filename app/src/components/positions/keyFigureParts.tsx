import type { ReactNode } from 'react'
import { StackedBar } from '../figures'
import { RangeBar } from '../ui'
import { TokenLabel } from '../read/TokenLabel'
import { rangeFacts, readablePrice, statusWords } from '../../lib/chart/priceFacts'
import { shownCardRange, shownCardTick, type RangeEnd } from '../../lib/read/screens/positions'
import type { LiveCard } from '../../lib/walletCards'
import { Amount } from './PositionFigures'
import { rangeWords, type CardPrice } from './PositionRange'

/*
 * The parts of a position's key figures (./KeyFigures.tsx), on their own (changed on purpose 2026-11-06, the owner: every
 * chain the same as Robinhood Chain): Robinhood Chain's page draws them in KeyFigures, and the page of a position on Base
 * or Arbitrum One (src/v2in/position/PositionPage.tsx) draws the same parts with read-v6's figures. Nothing here reads
 * anything: no fee history, no chain read.
 */

/** The four tiles' words, one place for both pages. */
export const KEY_FIGURES_COPY = {
  value: 'Position value',
  valueInfo: 'What your position is worth now, at the pool’s price. Fees not included.',
  fees: 'Fees to collect',
  feesInfo: 'Fees this position earned and has not collected yet.',
  tokenAmounts: 'Token amounts',
  price: 'Current price',
  priceInfo: 'The position earns fees while this price is inside its range.',
} as const

/**
 * A price or range end without its "≈": the page writes plain figures (six significant digits, every one in a title).
 * Changed on purpose 2026-10-03 (the owner's point 10: tokens from $0.001 to $1,000,000): a tiny or huge one as DEX
 * screens write it ("0.0₆7101", "2.5B"), the same way the Price range chart writes it (lib/chart/priceRange.ts).
 */
const plain = (text: string) => readablePrice(text.startsWith('≈') ? text.slice(1) : text)
const endText = (end: RangeEnd, tick: number) => (end.kind === 'tick' ? `Tick ${tick}` : plain(end.text))

/** Both amounts of the principal or the fees, one line each. */
export function Amounts({ card, which }: { card: LiveCard; which: 'principal' | 'unsettledFees' }) {
  return (
    <span className="dm-pos-amounts" data-stat={which === 'principal' ? 'principal' : 'fees'}>
      <Amount amount={card[which][0]} />
      <Amount amount={card[which][1]} />
    </span>
  )
}

/** On the position page (`active`), the tile's token amounts under a closed "Token amounts"; elsewhere as they are. */
export function FigureDetail({ active, label, children }: { active: boolean; label: string; children: ReactNode }) {
  return active ? <details className="dm-position-figure-detail"><summary>{label}</summary>{children}</details> : children
}

/**
 * The principal's split between its two tokens, by value. Neutral inks: on this page Tangerine means the fees series, so
 * the tokens' split never borrows it. A position all in one token has nothing to split: no bar.
 */
export function ValueSplit({ shares }: { shares: readonly [number, number] | null }) {
  return shares && shares[0] > 0 && shares[1] > 0 ? <StackedBar className="dm-pos-split" height={4} parts={[{ share: shares[0], tone: 'neutral' }, { share: shares[1], tone: 'muted' }]} /> : null
}

/**
 * The current price leads; its quote unit directly below keeps the orientation explicit without crowding the figure.
 * The app's one way round is unchanged. A dash whose reason is its title remains when a price cannot be written.
 */
export function PriceNow({ price, card }: { price: CardPrice; card: LiveCard }) {
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
    // Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): the dash has no title ("The pool’s price could not be written with this position’s tokens.").
    <span className="dm-fig-lg text-fg-subtle" data-current-price={code}>
      —
    </span>
  )
}

/**
 * The position's range as one bar from its lower end to its upper end, the price now a dot on it (outside its end when
 * the price is beyond it), the two ends under it and, while it holds liquidity, whether it earns fees now.
 */
export function RangeLine({ price, card, cached = false }: { price: CardPrice; card: LiveCard; cached?: boolean }) {
  const { fullRange } = card.range
  // The app's one way round (2026-09-28): the lowest price of the priced token at the bar's left.
  const { low, high, ticks } = shownCardRange(card)
  const usable = price.state.phase === 'ready' && price.state.price.state === 'usable' ? price.state.price : null
  // The band from 5% to 95% of the bar; a price beyond it sits in the room outside its end.
  const share = usable ? (shownCardTick(usable) - ticks.lower) / Math.max(1, ticks.upper - ticks.lower) : null
  const at = share === null ? null : share < 0 ? 0.015 : share > 1 ? 0.985 : 0.05 + 0.9 * share
  const live = !cached && card.hasLiquidity ? card.inRange : null
  // (QA round 2, N68) In range, the Price range card's own status words say when the price is close to an end and what
  // happens past it (lib/chart/priceFacts.ts statusWords `move`); the bar's state line says the same to a screen reader.
  const facts = live ? rangeFacts(card, usable) : null
  const near = facts && facts.where === 'inside' ? statusWords(facts).move : null
  return (
    <div className="dm-pos-span" data-stat="range" data-full-range={fullRange ? '' : undefined} data-ember-rest={at !== null && live !== null ? undefined : ''}>
      {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): a kept read is drawn as it is, never "Last known range". */}
      <RangeBar lower={0.05} upper={0.95} current={at} inRange={live} label={rangeWords(card, price)} />
      {/* Where the light rests (EmberLight reads [data-ember-rest], here its centre): on the price now, as the approved page
          puts it, the bar being drawn wider than the tile's text by its 5% margins (v4-position.css). Decoration only. */}
      {at !== null && live !== null && <span aria-hidden="true" className="dm-pos-span-rest" data-ember-rest="0,0" style={{ left: `${(at * 100 - 5) / 0.9}%` }} />}
      <span className="dm-pos-span-ends" data-range-kept={cached ? '' : undefined}>
        <span>{endText(low.end, low.tick)}</span>
        <span className="dm-pos-span-word">{card.hasLiquidity ? 'Your range' : 'Closed range'}</span>
        <span>{endText(high.end, high.tick)}</span>
      </span>
      {live !== null && (
        <span className="sr-only" data-in={String(live)}>
          {live ? `In range: earning fees${near ? `. ${near}` : ''}` : 'Out of range: not earning fees'}
        </span>
      )}
    </div>
  )
}
