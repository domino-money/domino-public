import { useEffect, useState, type KeyboardEvent } from 'react'
import { endPrice } from '../../components/create/valuation'
import { IconMinus, IconPlus } from '../../components/icons'
import { PriceSlider } from '../../components/PriceSlider'
import { SymbolText } from '../../components/read/screens/SymbolText'
import { IconButton } from '../../components/ui'
import { CREATE } from '../../lib/create/copy'
import { awayFrom, awayShort, plainFigure } from '../../lib/create/plain'
import { RANGES, type RangeKey } from '../../lib/ranges'
import { editablePrice } from '../../lib/read/screens/RangePriceInput'
import { typedPriceToTick } from '../../lib/create/typedPrice'
import { moveBound, presetFor, rangeMode, shownPosition, shownPrice, shownRange, sliderWindow, stepBound, usableTicks, type RangeMode } from '../../lib/read/screens/poolRange'
import { JOURNEY } from './copy'
import type { JourneyPrice, JourneyPriceState } from './model/price'
import type { JourneyState, TickRange } from './model/state'

/**
 * The widths, in order: the two presets (lib/ranges.ts), then your own prices, as today's range step offers them
 * (components/create/RangeStep.tsx). A Full range width added 2026-10-30 (QA round 2, N73) was removed the same day
 * (the owner, after seeing it on the preview: as it was before).
 */
type Width = RangeMode
const WIDTHS: readonly Width[] = [...(Object.keys(RANGES) as RangeKey[]), 'custom']
const widthName = (mode: Width) => (mode === 'custom' ? 'Custom' : RANGES[mode].label.replace(' range', ''))

/** An end at the pool's usable tick limit: every price below it (0) or above it (∞), as a position's card writes it. */
const atLimit = (tick: number, which: 'lower' | 'upper', spacing: number) => {
  const { min, max } = usableTicks(spacing)
  return which === 'lower' ? tick <= min : tick >= max
}

/** "1 ETH = 2,499.91 USDC": the price as the page writes it, the symbols as untrusted text. */
function OneFor({ price, figure }: { price: JourneyPrice; figure: string }) {
  return (
    <>
      1 <SymbolText token={price.base} /> = <span className="dm-flow-fig">{plainFigure(figure)}</span> <SymbolText token={price.quote} />
    </>
  )
}

/** How far a bound sits from the price, in words; nothing for an end at the pool's limit, which has no distance to say. */
function awayWords(tick: number, price: JourneyPrice, which: 'lower' | 'upper' | null = null): string {
  if (which && atLimit(tick, which, price.tickSpacing)) return ''
  const away = awayFrom(tick, price.tick)
  return away.side === 'at' ? CREATE.amount.atToday : away.side === 'below' ? CREATE.amount.below(away.percent) : away.far ? CREATE.amount.farAbove(away.percent) : CREATE.amount.above(away.percent)
}

/**
 * One end of the range, as today's range step draws it (components/create/RangeStep.tsx Bound): its price for one of the
 * priced token and how far it is from the price; with Custom chosen, typed (applied on Enter or when the field is left),
 * stepped by the pool's smallest step, or dragged; typed prices move outward, to the closest price the pool allows beyond
 * them. An end at the pool's usable tick limit reads 0 or ∞ (N73).
 *
 * Changed on purpose 2026-10-30 (QA round 2, Q18, as today's range step): a price typed but not applied yet is checked as
 * it is typed, and one that would be refused, or was refused, is reported up (`onBlock`) so Continue holds with the reason
 * until the field is fixed or left for a preset. The error under the field still appears on Enter or when it is left.
 */
function Bound({ which, range, price, editing, onRange, onBlock }: { which: 'lower' | 'upper'; range: TickRange; price: JourneyPrice; editing: boolean; onRange: (next: TickRange) => void; onBlock?: (which: 'lower' | 'upper', reason: string | null) => void }) {
  const label = which === 'lower' ? CREATE.amount.lowest : CREATE.amount.highest
  const tick = range[which]
  const id = `zap-range-${which}`
  const written = endPrice(tick, which, price)
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
    const parsed = typedPriceToTick(value, which, range, price)
    if (!parsed.ok) return setRefused({ tick, text: CREATE.amount.priceErrors[parsed.message] ?? parsed.message })
    change({ ...range, [which]: parsed.tick })
  }
  // What Continue must wait for: the error on screen, or the text in the field that applying would refuse.
  const live = editing && value !== displayed ? typedPriceToTick(value, which, range, price) : null
  const block = error ?? (live && !live.ok ? (CREATE.amount.priceErrors[live.message] ?? live.message) : null)
  // The field's name leads the reason, unless the reason already names the field ("The lowest price must stay below the
  // highest price.").
  useEffect(() => {
    onBlock?.(which, block === null ? null : /^The (lowest|highest) price/.test(block) ? block : `${label}: ${block.charAt(0).toLowerCase()}${block.slice(1)}`)
  }, [onBlock, which, label, block])
  // A field that goes (a preset chosen, the step left) holds nothing back.
  useEffect(() => () => onBlock?.(which, null), [onBlock, which])
  const span = sliderWindow(price.tick, price.tickSpacing, range)
  return (
    <div className="dm-flow-bound" data-range-bound={which} data-editing={editing ? '' : undefined}>
      <div className="dm-flow-bound-head">
        <span className="dm-flow-bound-label" id={`${id}-label`}>
          {label}
        </span>
        <span className="dm-flow-bound-away">{awayWords(tick, price, which)}</span>
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
          valueText={(next) => [plainFigure(endPrice(next, which, price) ?? CREATE.review.summary.beyondDisplay), awayWords(next, price, which)].filter(Boolean).join(', ')}
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
 *
 * Changed on purpose 2026-10-30 (QA round 2, as today's range step): a width chosen, or
 * shown first, stays checked while the range is still the one it made, so a price read again never flips it to Custom
 * under the person (N18); and a Custom price that would be refused holds Continue with its reason (`onBlock`, Q18).
 */
export function RangeStage({ state, price, onRange, onBlock }: { state: JourneyState; price: JourneyPriceState | null; onRange: (range: TickRange) => void; onBlock?: (which: 'lower' | 'upper', reason: string | null) => void }) {
  const usable = price && price.state === 'usable' ? price : null
  const inverted = usable?.inverted === true
  const shown = usable ? shownPrice(usable) : null
  const [picked, setPicked] = useState<{ mode: Width; range: TickRange | null } | null>(null)
  const range = state.range
  const view = range ? shownRange(range, inverted) : null
  const held = picked !== null && picked.mode !== 'custom' && picked.range !== null && range !== null && picked.range.lower === range.lower && picked.range.upper === range.upper
  const derived: Width | null = shown && view ? rangeMode(view, shown.tick, shown.tickSpacing, picked?.mode === 'custom' ? 'custom' : null) : null
  const mode: Width | null = held && picked ? picked.mode : derived
  // The width shown first is remembered with its range, as one chosen is (React's "a value from the previous render").
  if (picked === null && derived !== null && derived !== 'custom' && range !== null) setPicked({ mode: derived, range })
  const pick = (key: Width) => {
    if (!usable) return
    if (key === 'custom') {
      setPicked({ mode: 'custom', range: null })
      if (!range) onRange(presetFor(usable, 'standard'))
      return
    }
    const next = presetFor(usable, key)
    setPicked({ mode: key, range: next })
    onRange(next)
  }
  /** A range from the controls, in the page's frame: kept in the pool's own ticks. */
  const custom = (next: TickRange) => {
    setPicked({ mode: 'custom', range: null })
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
        {/* No title about the price's age (QA round 2, SWEEP: no stale notices); data-price-state keeps the state. */}
        <span className="dm-flow-now-price tnum" data-pool-price-text="">
          {usable ? <OneFor price={usable} figure={usable.text} /> : '—'}
        </span>
      </div>
      {usable && (
        <div className="grid gap-2">
          <div role="radiogroup" tabIndex={-1} aria-label={CREATE.amount.widths} className="dm-seg dm-flow-widths" onKeyDown={arrows}>
            {WIDTHS.map((key) => (
              <button key={key} type="button" role="radio" aria-checked={mode === key} tabIndex={mode === key || (mode === null && key === 'standard') ? 0 : -1} className="dm-seg-item" data-width={key} onClick={() => pick(key)}>
                <span className="dm-flow-width-art" data-width-art={key} aria-hidden="true"><span /></span>
                <span>{widthName(key)}</span>
              </button>
            ))}
          </div>
          {mode && <p className="dm-flow-width-line">{CREATE.amount.widthLines[mode]}</p>}
        </div>
      )}
      {shown && view ? (
        <div className="dm-flow-bounds" data-range-controls="">
          {/* Keyed by Custom: leaving it for a preset drops a half-typed or refused price with its fields. */}
          <Bound key={mode === 'custom' ? 'lower-edit' : 'lower'} which="lower" range={view} price={shown} editing={mode === 'custom'} onRange={custom} onBlock={onBlock} />
          <Bound key={mode === 'custom' ? 'upper-edit' : 'upper'} which="upper" range={view} price={shown} editing={mode === 'custom'} onRange={custom} onBlock={onBlock} />
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
