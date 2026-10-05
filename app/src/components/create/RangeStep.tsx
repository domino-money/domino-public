import { useEffect, useState, type KeyboardEvent } from 'react'
import { CREATE } from '../../lib/create/copy'
import type { JourneyState, TickRange } from '../../lib/create/journey'
import { awayFrom, awayShort, plainFigure } from '../../lib/create/plain'
import { RANGES, type RangeKey } from '../../lib/ranges'
import {
  PRICE_STALE_MS,
  boundPrice,
  moveBound,
  poolPrice,
  presetFor,
  rangeMode,
  shownPosition,
  shownPrice,
  shownRange,
  shownTick,
  sliderWindow,
  stepBound,
  type PoolPrice,
  type RangeMode,
} from '../../lib/read/screens/poolRange'
import type { AddressKey } from '../../lib/read/screens/identity'
import type { PoolOption } from '../../lib/read/screens/poolsList'
import { editablePrice, priceInputToTick } from '../../lib/read/screens/RangePriceInput'
import type { ReadSource } from '../../lib/read/types'
import { IconMinus, IconPlus } from '../icons'
import { PriceSlider } from '../PriceSlider'
import { useStalePriceRead } from '../read/screens/PoolRangeControls'
import { SymbolText } from '../read/screens/SymbolText'
import { IconButton } from '../ui'

type Usable = Extract<PoolPrice, { state: 'usable' }>

/** The three widths, in order: the two presets (lib/ranges.ts), then your own prices. */
const WIDTHS: readonly RangeMode[] = [...(Object.keys(RANGES) as RangeKey[]), 'custom']
const widthName = (mode: RangeMode) => (mode === 'custom' ? 'Custom' : RANGES[mode].label.replace(' range', ''))

/**
 * The time a price is judged at: its own arrival until PRICE_STALE_MS have passed on this page, then that moment.
 * One timer per reading; state changes only in its callback (as the pool page's range controls judge it).
 */
function useStaleClock(readAt: number | null): number {
  const [turned, setTurned] = useState<number | null>(null)
  useEffect(() => {
    if (readAt === null) return
    const timer = setTimeout(() => setTurned(readAt), Math.max(0, readAt + PRICE_STALE_MS - Date.now()) + 1)
    return () => clearTimeout(timer)
  }, [readAt])
  if (readAt === null) return 0
  return turned === readAt ? readAt + PRICE_STALE_MS : readAt
}

/** "1 ETH = 2,499.91 USDG": the price as the page writes it (lib/read/orientation.ts), the symbols as untrusted text. */
export function OneFor({ price, figure }: { price: Usable; figure: string }) {
  return (
    <>
      1 <SymbolText token={price.base} /> = <span className="dm-flow-fig">{plainFigure(figure)}</span> <SymbolText token={price.quote} />
    </>
  )
}

/** How far a bound sits from today's price, in words. */
function awayWords(tick: number, price: Usable): string {
  const away = awayFrom(tick, price.tick)
  return away.side === 'at' ? CREATE.amount.atToday : away.side === 'below' ? CREATE.amount.below(away.percent) : CREATE.amount.above(away.percent)
}


/**
 * One end of the range: its price for one of the priced token and how far it is from today's. With Custom
 * chosen, the price can be typed (applied on Enter or when the field is left), stepped by the pool's smallest step,
 * or dragged; typed prices move outward to the nearest price the pool allows. `range` and `price` are in the page's
 * frame (poolRange.ts shownPrice): its lower end is the lowest price of the priced token, whichever way the pool is.
 */
function Bound({ which, range, price, inverted, editing, onRange }: { which: 'lower' | 'upper'; range: TickRange; price: Usable; inverted: boolean; editing: boolean; onRange: (next: TickRange) => void }) {
  const label = which === 'lower' ? CREATE.amount.lowest : CREATE.amount.highest
  const tick = range[which]
  const id = `range-${which}`
  const written = boundPrice(tick, price)
  const displayed = editablePrice(written)
  const [draft, setDraft] = useState<{ tick: number; text: string } | null>(null)
  // A refused price belongs to the bound it was typed for, as the draft does: once the bound moves, by a width, a step
  // or the slider, it is said no more. Fixed 2026-09-28 (round 6 review): a refused Custom price stayed on screen, red,
  // under Closer's range after Closer was chosen.
  const [refused, setRefused] = useState<{ tick: number; text: string } | null>(null)
  const value = draft?.tick === tick ? draft.text : displayed
  const error = editing && refused?.tick === tick ? refused.text : null
  const change = (next: TickRange) => {
    setRefused(null)
    setDraft(null)
    onRange(next)
  }
  const apply = () => {
    if (value === displayed) return setRefused(null)
    // A price typed the way the page writes one ("1,747.65") is read without its thousands separators.
    const typed = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(value.trim()) ? value.trim().replace(/,/g, '') : value
    const parsed = priceInputToTick(typed, which, range, price)
    if (!parsed.ok) return setRefused({ tick, text: CREATE.amount.priceErrors[parsed.message] ?? parsed.message })
    change({ ...range, [which]: parsed.tick })
  }
  const span = sliderWindow(price.tick, price.tickSpacing, range)
  return (
    <div className="dm-flow-bound" data-range-bound={which} data-editing={editing ? '' : undefined}>
      <div className="dm-flow-bound-head">
        <span className="dm-flow-bound-label" id={`${id}-label`}>
          {label}
        </span>
        <span className="dm-flow-bound-away">{awayWords(tick, price)}</span>
      </div>
      {editing ? (
        <div className="dm-flow-bound-edit">
          <span className="dm-flow-bound-unit">
            1 <SymbolText token={price.base} /> =
          </span>
          <input
            id={`${id}-price`}
            aria-labelledby={`${id}-label`}
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            className="dm-flow-bound-input tnum"
            value={value}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(event) => {
              setDraft({ tick, text: event.target.value })
              setRefused(null)
            }}
            onBlur={apply}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              apply()
            }}
          />
          <span className="dm-flow-bound-unit">
            <SymbolText token={price.quote} />
          </span>
          <span className="dm-flow-bound-steps">
            <IconButton label={CREATE.amount.lowerBy(label)} icon={<IconMinus size={14} />} variant="round" size="sm" onClick={() => change(stepBound(range, which, -1, price.tickSpacing))} />
            <IconButton label={CREATE.amount.raiseBy(label)} icon={<IconPlus size={14} />} variant="round" size="sm" onClick={() => change(stepBound(range, which, 1, price.tickSpacing))} />
          </span>
        </div>
      ) : (
        <p className="dm-flow-bound-price tnum" data-bound-price="">
          {written ? <OneFor price={price} figure={written} /> : CREATE.review.summary.beyondDisplay}
        </p>
      )}
      {/* The pool's own tick for this end (the page's frame turned back). */}
      <span className="sr-only" data-bound-tick="">
        {shownTick(tick, inverted)}
      </span>
      {error && (
        <p id={`${id}-error`} role="alert" className="dm-error">
          {error}
        </p>
      )}
      {editing && (
        <PriceSlider
          id={id}
          label={label}
          min={span.min}
          max={span.max}
          step={price.tickSpacing}
          value={tick}
          onChange={(next) => change(moveBound(range, which, next, price.tickSpacing))}
          lower={range.lower}
          upper={range.upper}
          format={(next) => awayShort(next, price.tick)}
          valueText={(next) => `${plainFigure(boundPrice(next, price) ?? CREATE.review.summary.beyondDisplay)}, ${awayWords(next, price)}`}
          tone="quiet"
        />
      )}
    </div>
  )
}

/**
 * Step 2, Range, made for someone who has never set one (round 6, 2026-09-27, the owner): today's price in plain
 * words, one choice of width (Closer, Wider or Custom) with a line saying what it means, and the lowest and highest
 * price as "1 ETH = 1,747.65 USDG", each with how far it is from today's. Only Custom opens the fields, the steps and
 * the sliders; the ticks stay out of sight.
 *
 * Its only read is the price again: once it is more than 5 minutes old, the next change to the range reads it, one
 * pools read of this pool at a time (useStalePriceRead, shared with the pool page's range controls). There is no
 * control to press for it.
 *
 * Changed on purpose 2026-09-28 (one-sided, the owner: "the range is upside down"): the prices read the app's one way
 * round (lib/read/orientation.ts), "1 MANY = 0.0025 USDG" in a pool whose first token is USDG, so a range above
 * today's price is one where MANY is dearer. The step draws and edits the range in that frame and keeps it in the
 * pool's own ticks (shownRange), and the presets are 0.7× to 1.5× of the price as written (presetFor).
 */
export function RangeStep({
  source,
  state,
  pool,
  token,
  onRange,
  onPool,
  reread = null,
}: {
  source: ReadSource
  state: JourneyState
  pool: PoolOption
  token: AddressKey
  onRange: (range: TickRange) => void
  onPool: (option: PoolOption) => void
  /** Another network's pool (2026-10-05): its price read again there, through the wallet; null for every other pool. */
  reread?: ((signal: AbortSignal) => Promise<PoolOption | null>) | null
}) {
  const now = useStaleClock(pool.readAt)
  const price = poolPrice(pool, now)
  const usable = price.state === 'usable' ? price : null
  // The price and the range in the page's frame: the lower end is the priced token's lowest price, whichever way the
  // pool is. Everything drawn or edited here is in that frame; a range goes back to the pool's ticks before it is kept.
  const inverted = usable?.inverted === true
  const shown = usable ? shownPrice(usable) : null
  // Only a tie-break and an explicit "Custom"; the checked width is derived from the range on the price as read now.
  const [picked, setPicked] = useState<RangeMode | null>(null)
  const { said, readIfStale } = useStalePriceRead(source, token, state.paired?.key ?? null, pool.key, onPool, reread)
  const range = state.range
  const view = range ? shownRange(range, inverted) : null
  const mode = shown && view ? rangeMode(view, shown.tick, shown.tickSpacing, picked) : null

  const pick = (key: RangeMode) => {
    if (!usable) return
    readIfStale(usable.stale)
    setPicked(key)
    if (key !== 'custom') onRange(presetFor(usable, key))
    else if (!range) onRange(presetFor(usable, 'standard'))
  }
  /** A range from the controls, in the page's frame: kept in the pool's own ticks. */
  const custom = (next: TickRange) => {
    readIfStale(usable?.stale === true)
    setPicked('custom')
    onRange(shownRange(next, inverted))
  }
  const arrows = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const at = WIDTHS.indexOf(mode ?? 'standard')
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? WIDTHS.length - 1 : (at + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + WIDTHS.length) % WIDTHS.length
    pick(WIDTHS[index])
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[index]?.focus()
  }

  const position = usable && range ? shownPosition(range, usable) : null
  const priceState = price.state === 'usable' ? (price.stale ? 'stale' : price.partial ? 'partial' : 'usable') : 'unavailable'
  return (
    <div className="dm-flow-stack" data-stage="range" data-picker="range" data-price-state={priceState} data-price-read={said?.code}>
      <p role="status" aria-live="polite" className="sr-only">
        {said?.text ?? ''}
      </p>
      <div className="dm-flow-now" data-pool-price="">
        <span className="dm-flow-now-label">{CREATE.amount.now}</span>
        <span className="dm-flow-now-price tnum" data-pool-price-text="" title={usable?.stale ? CREATE.review.stale : undefined}>
          {usable ? <OneFor price={usable} figure={usable.text} /> : '—'}
        </span>
      </div>
      {usable && (
        <div className="grid gap-2">
          <div role="radiogroup" tabIndex={-1} aria-label={CREATE.amount.widths} className="dm-seg dm-flow-widths" onKeyDown={arrows}>
            {WIDTHS.map((key) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={mode === key}
                tabIndex={mode === key || (mode === null && key === 'standard') ? 0 : -1}
                className="dm-seg-item"
                data-width={key}
                onClick={() => pick(key)}
              >
                <span className="dm-flow-width-art" data-width-art={key} aria-hidden="true"><span /></span>
                <span>{widthName(key)}</span>
              </button>
            ))}
          </div>
          {mode && <p className="dm-flow-width-line">{CREATE.amount.widthLines[mode]}</p>}
        </div>
      )}
      {shown && view && (
        <div className="dm-flow-bounds" data-range-controls="">
          {/* Keyed by Custom: leaving it for Closer or Wider drops a half-typed or refused price with its fields. */}
          <Bound key={mode === 'custom' ? 'lower-edit' : 'lower'} which="lower" range={view} price={shown} inverted={inverted} editing={mode === 'custom'} onRange={custom} />
          <Bound key={mode === 'custom' ? 'upper-edit' : 'upper'} which="upper" range={view} price={shown} inverted={inverted} editing={mode === 'custom'} onRange={custom} />
        </div>
      )}
      {mode === 'custom' && <p className="dm-hint">{CREATE.amount.customHint}</p>}
      {/* Only when there is something to warn about: a range that does not hold today's price earns nothing until it does. */}
      {(position === 'below' || position === 'above') && (
        <p role="status" className="dm-flow-position" data-tone="neutral" data-range-position={position}>
          {CREATE.amount.rangeOut[position]}
        </p>
      )}
      {position === 'inside' && (
        <span className="sr-only" data-range-position="inside">
          {CREATE.amount.rangeIn}
        </span>
      )}
    </div>
  )
}
