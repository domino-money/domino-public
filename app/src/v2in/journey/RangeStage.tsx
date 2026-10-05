import { useState, type KeyboardEvent } from 'react'
import { IconMinus, IconPlus } from '../../components/icons'
import { PriceSlider } from '../../components/PriceSlider'
import { SymbolText } from '../../components/read/screens/SymbolText'
import { IconButton } from '../../components/ui'
import { CREATE } from '../../lib/create/copy'
import { awayFrom, awayShort, plainFigure } from '../../lib/create/plain'
import { RANGES, type RangeKey } from '../../lib/ranges'
import { editablePrice, priceInputToTick } from '../../lib/read/screens/RangePriceInput'
import { boundPrice, moveBound, presetFor, rangeMode, shownPosition, shownPrice, shownRange, sliderWindow, stepBound, type RangeMode } from '../../lib/read/screens/poolRange'
import { JOURNEY } from './copy'
import type { JourneyPrice, JourneyPriceState } from './model/price'
import type { JourneyState, TickRange } from './model/state'

/** The three widths, in order: the two presets (lib/ranges.ts), then your own prices, as today's range step offers them. */
const WIDTHS: readonly RangeMode[] = [...(Object.keys(RANGES) as RangeKey[]), 'custom']
const widthName = (mode: RangeMode) => (mode === 'custom' ? 'Custom' : RANGES[mode].label.replace(' range', ''))

/** "1 ETH = 2,499.91 USDC": the price as the page writes it, the symbols as untrusted text. */
function OneFor({ price, figure }: { price: JourneyPrice; figure: string }) {
  return (
    <>
      1 <SymbolText token={price.base} /> = <span className="dm-flow-fig">{plainFigure(figure)}</span> <SymbolText token={price.quote} />
    </>
  )
}

/** How far a bound sits from the price, in words. */
function awayWords(tick: number, price: JourneyPrice): string {
  const away = awayFrom(tick, price.tick)
  return away.side === 'at' ? CREATE.amount.atToday : away.side === 'below' ? CREATE.amount.below(away.percent) : CREATE.amount.above(away.percent)
}

/**
 * One end of the range, as today's range step draws it (components/create/RangeStep.tsx Bound): its price for one of the
 * priced token and how far it is from the price; with Custom chosen, typed (applied on Enter or when the field is left),
 * stepped by the pool's smallest step, or dragged; typed prices move outward to the nearest price the pool allows.
 */
function Bound({ which, range, price, editing, onRange }: { which: 'lower' | 'upper'; range: TickRange; price: JourneyPrice; editing: boolean; onRange: (next: TickRange) => void }) {
  const label = which === 'lower' ? CREATE.amount.lowest : CREATE.amount.highest
  const tick = range[which]
  const id = `zap-range-${which}`
  const written = boundPrice(tick, price)
  const displayed = editablePrice(written)
  const [draft, setDraft] = useState<{ tick: number; text: string } | null>(null)
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
 * Step 2, Range, on Domino's new contracts: today's range step (components/create/RangeStep.tsx) on a pool of any of the
 * three networks, in the page's frame (lib/read/orientation.ts's rule, made per chain: model/price.ts), kept in the pool's
 * own ticks on its spacing. For a new pool the price is the starting price typed (§2.6.5: the range and the minimum are
 * computed at it). Its only data is the pool's price as it was read; a price that cannot be written (a token whose
 * decimals were never read) shows the range in ticks.
 */
export function RangeStage({ state, price, onRange }: { state: JourneyState; price: JourneyPriceState | null; onRange: (range: TickRange) => void }) {
  const usable = price && price.state === 'usable' ? price : null
  const inverted = usable?.inverted === true
  const shown = usable ? shownPrice(usable) : null
  const [picked, setPicked] = useState<RangeMode | null>(null)
  const range = state.range
  const view = range ? shownRange(range, inverted) : null
  const mode = shown && view ? rangeMode(view, shown.tick, shown.tickSpacing, picked) : null
  const pick = (key: RangeMode) => {
    if (!usable) return
    setPicked(key)
    if (key !== 'custom') onRange(presetFor(usable, key))
    else if (!range) onRange(presetFor(usable, 'standard'))
  }
  const custom = (next: TickRange) => {
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
  const starting = state.pool !== null && !state.pool.initialized
  return (
    <div className="dm-flow-stack" data-stage="range" data-zap-range={range ? `${range.lower}:${range.upper}` : ''} data-price-state={usable ? (usable.stale ? 'stale' : 'usable') : 'unavailable'}>
      <div className="dm-flow-now" data-pool-price="">
        <span className="dm-flow-now-label">{starting ? JOURNEY.range.start : CREATE.amount.now}</span>
        <span className="dm-flow-now-price tnum" data-pool-price-text="" title={usable?.stale ? CREATE.review.stale : undefined}>
          {usable ? <OneFor price={usable} figure={usable.text} /> : '—'}
        </span>
      </div>
      {usable && (
        <div className="grid gap-2">
          <div role="radiogroup" tabIndex={-1} aria-label={CREATE.amount.widths} className="dm-seg dm-flow-widths" onKeyDown={arrows}>
            {WIDTHS.map((key) => (
              <button key={key} type="button" role="radio" aria-checked={mode === key} tabIndex={mode === key || (mode === null && key === 'standard') ? 0 : -1} className="dm-seg-item" data-width={key} onClick={() => pick(key)}>
                {widthName(key)}
              </button>
            ))}
          </div>
          {mode && <p className="dm-flow-width-line">{CREATE.amount.widthLines[mode]}</p>}
        </div>
      )}
      {shown && view ? (
        <div className="dm-flow-bounds" data-range-controls="">
          <Bound key={mode === 'custom' ? 'lower-edit' : 'lower'} which="lower" range={view} price={shown} editing={mode === 'custom'} onRange={custom} />
          <Bound key={mode === 'custom' ? 'upper-edit' : 'upper'} which="upper" range={view} price={shown} editing={mode === 'custom'} onRange={custom} />
        </div>
      ) : range ? (
        <p className="text-body" data-range-ticks="">
          {JOURNEY.range.ticksOnly} {CREATE.review.summary.rangeTicks(range.lower, range.upper)}
        </p>
      ) : null}
      {mode === 'custom' && <p className="dm-hint">{CREATE.amount.customHint}</p>}
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
