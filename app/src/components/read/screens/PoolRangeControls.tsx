import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { RANGES, type RangeKey } from '../../../lib/ranges'
import { verifyCandidate } from '../../../lib/read/screens/catalogueSession'
import { COPY, failureText } from '../../../lib/read/screens/copy'
import type { AddressKey } from '../../../lib/read/screens/identity'
import { askAgainLater } from '../../../lib/read/screens/screenRead'
import {
  PRICE_STALE_MS,
  boundPrice,
  fromPoolPrice,
  moveBound,
  poolPrice,
  presetRange,
  rangeMode,
  rangePosition,
  sliderWindow,
  stepBound,
  type PoolPrice,
  type RangeMode,
} from '../../../lib/read/screens/poolRange'
import type { PoolOption } from '../../../lib/read/screens/poolsList'
import { editablePrice, priceInputToTick } from '../../../lib/read/screens/RangePriceInput'
import type { ReadSource } from '../../../lib/read/types'
import { PriceSlider } from '../../PriceSlider'
import { Button, IconButton, cx } from '../../ui'
import { Address } from './Address'
import { SymbolText } from './SymbolText'

type Usable = Extract<PoolPrice, { state: 'usable' }>
/** Two ticks on the pool's spacing, lower below upper. Nothing is saved or sent. */
type PlannedRange = { lower: number; upper: number }

/**
 * The time a price is judged at: its own arrival until PRICE_STALE_MS have
 * passed on this page, then that moment. One timer per reading; state changes
 * only in its callback.
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

/**
 * The sliding thumb behind the chosen width, measured from the chosen radio
 * and moved by translate and width (the Segmented look, DESIGN.md C.8). It is
 * placed again when anything resizes and once the web fonts arrive; until the
 * first placement the chosen radio carries the fill itself.
 */
function useWidthThumb(index: number) {
  const track = useRef<HTMLDivElement>(null)
  const thumb = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const root = track.current
    const mark = thumb.current
    if (!root || !mark) return
    const place = () => {
      const item = index < 0 ? null : root.querySelectorAll<HTMLElement>('[role="radio"]')[index]
      if (!item) {
        mark.style.opacity = '0'
        return
      }
      mark.style.width = `${item.offsetWidth}px`
      mark.style.translate = `${item.offsetLeft}px 0`
      mark.style.opacity = '1'
    }
    place()
    let alive = true
    let frame = 0
    if (!root.hasAttribute('data-thumb')) frame = requestAnimationFrame(() => root.setAttribute('data-thumb', ''))
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    observer?.observe(root)
    void document.fonts?.ready.then(() => {
      if (alive) place()
    })
    return () => {
      alive = false
      cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [index])
  return { track, thumb }
}

export function Units({ price }: { price: Usable }) {
  return (
    <>
      <SymbolText token={price.quote} /> per <SymbolText token={price.base} />
    </>
  )
}

/** A bound's price, or plain words when it cannot be written as a number. */
export const priceOrWords = (tick: number, price: Usable) => boundPrice(tick, price) ?? COPY.range.beyondDisplay

function BoundControl({
  which,
  range,
  price,
  bounds,
  onRange,
}: {
  which: 'lower' | 'upper'
  range: PlannedRange
  price: Usable
  bounds: { min: number; max: number }
  onRange: (next: PlannedRange) => void
}) {
  const label = which === 'lower' ? COPY.range.minPrice : COPY.range.maxPrice
  const tick = range[which]
  const id = `range-${which}`
  const displayed = editablePrice(boundPrice(tick, price))
  const [draft, setDraft] = useState<{ tick: number; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const value = draft?.tick === tick ? draft.text : displayed
  const change = (next: PlannedRange) => {
    setError(null)
    setDraft(null)
    onRange(next)
  }
  const apply = () => {
    if (value === displayed) { setError(null); return }
    const parsed = priceInputToTick(value, which, range, price)
    if (!parsed.ok) { setError(parsed.message); return }
    change({ ...range, [which]: parsed.tick })
  }
  const spoken = (t: number) => `${priceOrWords(t, price)}, ${fromPoolPrice(t, price.tick)} from the pool price, tick ${t}`
  return (
    <div className="dm-inset min-w-0 px-4 pt-3 pb-1" data-range-bound={which}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={`${id}-price`} className="text-caption font-medium text-fg-muted">{label}</label>
        <span className="tnum text-caption text-fg-subtle">{fromPoolPrice(tick, price.tick)}</span>
      </div>
      <div className="mt-1.5 flex min-w-0 items-center gap-1">
        <input
          id={`${id}-price`}
          aria-label={`${label} input`}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(event) => { setDraft({ tick, text: event.target.value }); setError(null) }}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); apply() } }}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : `${id}-unit`}
          className="dm-pool-bound-input tnum"
        />
        <IconButton
          label={`Lower the ${label.toLowerCase()} by one tick spacing`}
          icon={<span aria-hidden="true" className="dm-pool-step-glyph">−</span>}
          variant="ghost"
          size="sm"
          onClick={() => change(stepBound(range, which, -1, price.tickSpacing))}
        />
        <IconButton
          label={`Raise the ${label.toLowerCase()} by one tick spacing`}
          icon={<span aria-hidden="true" className="dm-pool-step-glyph">+</span>}
          variant="ghost"
          size="sm"
          onClick={() => change(stepBound(range, which, 1, price.tickSpacing))}
        />
      </div>
      <p id={`${id}-unit`} className="mt-0.5 text-caption text-fg-subtle"><Units price={price} /> · displayed approximately</p>
      <p className="sr-only" data-bound-price="">{priceOrWords(tick, price)}</p>
      <span className="sr-only" data-bound-tick="">{tick}</span>
      {value !== displayed && <Button type="button" variant="outline" size="sm" className="mt-2" onClick={apply}>Apply {label.toLowerCase()}</Button>}
      {error && <p id={`${id}-error`} role="alert" className="dm-error">{error}</p>}
      <PriceSlider
        id={id}
        label={label}
        min={bounds.min}
        max={bounds.max}
        step={price.tickSpacing}
        value={tick}
        onChange={(v) => change(moveBound(range, which, v, price.tickSpacing))}
        lower={range.lower}
        upper={range.upper}
        format={(t) => fromPoolPrice(t, price.tick)}
        valueText={spoken}
      />
    </div>
  )
}

/** A price interval on a logarithmic axis, not invented history or liquidity: the band, its two ends and the pool's price. */
function RangeInterval({ range, price, bounds }: { range: PlannedRange; price: Usable; bounds: { min: number; max: number } }) {
  const span = bounds.max - bounds.min
  const at = (tick: number) => (span > 0 ? Math.min(100, Math.max(0, ((tick - bounds.min) * 100) / span)) : 50)
  const lower = at(range.lower)
  const upper = at(range.upper)
  const pool = at(price.tick)
  return (
    <div className="grid gap-2" data-range-interval="">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-caption text-fg-subtle">
        <span>Selected price interval</span>
      </div>
      <div
        role="img"
        aria-label={`Selected interval from ${priceOrWords(range.lower, price)} to ${priceOrWords(range.upper, price)}. Pool price ${price.text}.`}
        className="dm-pool-interval dm-dots-chart"
      >
        <span className="dm-pool-interval-band" style={{ left: `${lower}%`, width: `${Math.max(0.5, upper - lower)}%` }} />
        <span className="dm-pool-interval-handle" style={{ left: `${lower}%` }} />
        <span className="dm-pool-interval-handle" style={{ left: `${upper}%` }} />
        <span className="dm-pool-interval-price" style={{ left: `${pool}%` }} />
        <span className="dm-pool-interval-label" style={{ left: `clamp(34px, ${pool}%, calc(100% - 34px))` }}>Pool price</span>
        <span className="dm-pool-interval-end dm-pool-interval-end--min tnum">{fromPoolPrice(bounds.min, price.tick)}</span>
        <span className="dm-pool-interval-end dm-pool-interval-end--max tnum">{fromPoolPrice(bounds.max, price.tick)}</span>
      </div>
    </div>
  )
}

type Said = { code: string; text: string }

/**
 * Reading a stale price again, for one pool: at most one read at a time, on
 * the next change a person makes to the range. A read the service was busy
 * for, or briefly could not answer, is asked again on its own by the quiet
 * re-ask policy (screenRead.ts): after its wait, a few times, only while the
 * page is shown, and changes to the range meanwhile send nothing. Once a read
 * has failed for good, or its re-asks are spent, or the pools route did not
 * return the pool, nothing is read again until the person leaves and comes
 * back. Leaving cancels whatever is reading or waiting.
 */
export function useStalePriceRead(source: ReadSource, token: AddressKey, paired: AddressKey | null, poolKey: PoolOption['key'], onOption: (option: PoolOption) => void) {
  const [said, setSaid] = useState<Said | null>(null)
  const question = useRef<{ busy: boolean; done: boolean; attempts: number; controller: AbortController } | null>(null)
  // The latest onOption, so an answer that lands after a re-render still reaches the page's own.
  const latest = useRef(onOption)
  useEffect(() => {
    latest.current = onOption
  }, [onOption])

  useEffect(() => {
    const current = { busy: false, done: false, attempts: 0, controller: new AbortController() }
    question.current = current
    return () => {
      current.controller.abort()
      if (question.current === current) question.current = null
    }
  }, [source, token, paired, poolKey])

  const read = (current: NonNullable<typeof question.current>) => {
    const { signal } = current.controller
    current.busy = true
    setSaid({ code: 'loading', text: COPY.range.rereading })
    void verifyCandidate(source, token, paired, poolKey, { signal }).then(async (result) => {
      if (signal.aborted) return
      if (result.failure) {
        if (result.failure.state === 'aborted') {
          current.busy = false
          setSaid(null)
          return
        }
        const text = failureText(result.failure, 'pools')
        setSaid({ code: text.code, text: [text.title, text.detail].filter(Boolean).join('. ') })
        // Still busy while it waits, so a range change meanwhile sends nothing.
        if (await askAgainLater(result.failure, current.attempts, signal)) {
          current.attempts += 1
          read(current)
          return
        }
        current.busy = false
        if (!signal.aborted) current.done = true
        return
      }
      current.busy = false
      current.attempts = 0
      if (result.option) {
        setSaid({ code: 'ok', text: `Price read again at block ${result.option.block}.` })
        latest.current(result.option)
      } else {
        current.done = true
        setSaid({ code: 'not_found', text: COPY.range.notReturned })
      }
    })
  }

  /** Reads the price again when it is stale and nothing is reading, waiting or finished for this pool. */
  const readIfStale = (stale: boolean) => {
    const current = question.current
    if (!stale || !current || current.busy || current.done) return
    read(current)
  }

  return { said, readIfStale }
}

/**
 * The range view of a chosen pool: its price as read, and range controls drawn
 * on it. With no usable price there are no controls, and the price is a dash
 * with the reason in its title. Nothing here reads by itself: a price read
 * more than 5 minutes ago on this page stays in normal type, marked stale in
 * its title and data only, and the next change a person makes to the range
 * reads it again, one pools read of this pool id at a time, asked again
 * quietly only when that read was busy or briefly out (useStalePriceRead).
 * There is no separate refresh control.
 */
export function PoolRangeControls({
  source,
  token,
  paired,
  option,
  onOption,
  range,
  onRange,
}: {
  source: ReadSource
  token: AddressKey
  paired: AddressKey | null
  option: PoolOption
  onOption: (option: PoolOption) => void
  range: PlannedRange | null
  onRange: (range: PlannedRange) => void
}) {
  const now = useStaleClock(option.readAt)
  const price = poolPrice(option, now)
  // Only a tie-break and an explicit "Custom"; the checked width is derived from the range below.
  const [picked, setPicked] = useState<RangeMode | null>(null)
  // What the last price read came to, for the live region and data only.
  const { said, readIfStale } = useStalePriceRead(source, token, paired, option.key, onOption)

  const usable = price.state === 'usable' ? price : null
  // Derived each render from the range and the price as read now, so reopening a kept range
  // or reading the price again never leaves a preset checked that no longer describes it.
  const mode = usable && range ? rangeMode(range, usable.tick, usable.tickSpacing, picked) : null
  const widths: RangeMode[] = [...(Object.keys(RANGES) as RangeKey[]), 'custom']
  const { track, thumb } = useWidthThumb(mode === null ? -1 : widths.indexOf(mode))

  /** A stale price is read again on the next change to the range; the range as drawn stays. */
  const readStalePrice = () => readIfStale(usable?.stale === true)

  const pick = (key: RangeKey) => {
    if (!usable) return
    readStalePrice()
    setPicked(key)
    onRange(presetRange(usable.tick, usable.tickSpacing, key))
  }
  const custom = (next: PlannedRange) => {
    readStalePrice()
    setPicked(null)
    onRange(next)
  }

  const position = usable && range ? rangePosition(range, usable.tick) : null
  const bounds = usable && range ? sliderWindow(usable.tick, usable.tickSpacing, range) : null
  const tone = position === 'inside' ? 'in' : 'out'
  const unavailable = price.state === 'unavailable' ? `${COPY.range.unavailableTitle}: ${COPY.range.problems[price.problem]} ${COPY.range.noControls}` : null

  return (
    <div className="grid gap-5" data-picker="range" data-price-state={price.state === 'usable' ? (price.stale ? 'stale' : price.partial ? 'partial' : 'usable') : 'unavailable'} data-price-read={said?.code}>
      <section aria-labelledby="range-price-heading" className="grid gap-1" data-pool-price="">
        <h3 id="range-price-heading" className="text-body font-medium text-fg">Pool price</h3>
        <p role="status" aria-live="polite" className="sr-only">{said?.text ?? ''}</p>
        {usable ? (
          <>
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5" {...(usable.stale ? { 'data-price-stale': '', title: COPY.range.stale } : {})}>
              <p className="tnum text-stat font-medium break-all" data-pool-price-text="">
                {usable.text}
              </p>
              <p className="text-caption text-fg-subtle">
                <Units price={usable} />
              </p>
            </div>
            {usable.partial && (
              <div className="mt-1 grid gap-0.5 text-caption text-fg-muted" data-price-partial="" title={COPY.range.partial}>
                <p>
                  <SymbolText token={usable.base} /> <Address value={usable.base.address ?? ''} />
                </p>
                <p>
                  <SymbolText token={usable.quote} /> <Address value={usable.quote.address ?? ''} />
                </p>
              </div>
            )}
          </>
        ) : (
          <div data-price-unavailable={price.state === 'unavailable' ? price.problem : ''} title={unavailable ?? undefined}>
            <p className="tnum text-stat font-medium text-fg-subtle">—</p>
            <p className="sr-only">{unavailable}</p>
          </div>
        )}
      </section>

      {usable && range && bounds && (
        <section aria-label="Range controls" className="grid gap-4" data-range-controls="">
          <div ref={track} role="radiogroup" tabIndex={-1} aria-label={COPY.range.width} className="dm-seg dm-pool-widths" onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const current = widths.indexOf(mode ?? 'custom')
            const index = event.key === 'Home' ? 0 : event.key === 'End' ? widths.length - 1 : (current + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + widths.length) % widths.length
            const next = widths[index]
            if (next === 'custom') setPicked('custom')
            else pick(next)
            event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[index]?.focus()
          }}>
            <span ref={thumb} aria-hidden="true" className="dm-seg-thumb" />
            {(Object.keys(RANGES) as RangeKey[]).map((key) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={mode === key}
                tabIndex={mode === key ? 0 : -1}
                onClick={() => pick(key)}
                className="dm-seg-item"
              >
                {RANGES[key].label.replace(' range', '')}
              </button>
            ))}
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'custom'}
              tabIndex={mode === 'custom' ? 0 : -1}
              onClick={() => setPicked('custom')}
              className="dm-seg-item"
            >
              {COPY.range.custom}
            </button>
          </div>
          <RangeInterval range={range} price={usable} bounds={bounds} />
          <div className="grid gap-3 sm:grid-cols-2">
            <BoundControl which="lower" range={range} price={usable} bounds={bounds} onRange={custom} />
            <BoundControl which="upper" range={range} price={usable} bounds={bounds} onRange={custom} />
          </div>
          <div className="grid gap-1.5">
            {/* Only when there is something to warn about: a range that does not
                hold the price earns no fees until the price moves into it. The
                ordinary case says nothing. */}
            {position !== 'inside' && (
              <p role="status" aria-live="polite" className="dm-pool-position" data-range-position={position ?? ''}>
                <span aria-hidden="true" className={cx('dm-pool-dot', `dm-pool-dot--${tone}`)} />
                {position === 'below' ? COPY.range.below : COPY.range.above}
              </p>
            )}
            {position === 'inside' && <span className="sr-only" data-range-position="inside">{COPY.range.inside}</span>}
            <p className="text-caption text-fg-subtle">
              Enter a price and apply, or drag a handle. Prices snap outward to the pool’s tick spacing.
            </p>
          </div>
        </section>
      )}

      {usable && !range && <Button type="button" onClick={() => pick('standard')}>Set a range</Button>}
    </div>
  )
}
