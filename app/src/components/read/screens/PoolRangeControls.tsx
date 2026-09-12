import { useEffect, useRef, useState } from 'react'
import { RANGES, type RangeKey } from '../../../lib/ranges'
import { verifyCandidate } from '../../../lib/read/screens/catalogueSession'
import { COPY, failureText } from '../../../lib/read/screens/copy'
import type { AddressKey } from '../../../lib/read/screens/identity'
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
  type PracticeRange,
  type RangeMode,
} from '../../../lib/read/screens/poolRange'
import type { PoolOption } from '../../../lib/read/screens/poolsList'
import type { ReadSource } from '../../../lib/read/types'
import { PriceSlider } from '../../PriceSlider'
import { Button, Pill, cx } from '../../ui'
import { Address } from './Address'
import { ScreenStatus, type StatusLine } from './ScreenStatus'
import { SymbolText } from './SymbolText'

type Usable = Extract<PoolPrice, { state: 'usable' }>

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
  range: PracticeRange
  price: Usable
  bounds: { min: number; max: number }
  onRange: (next: PracticeRange) => void
}) {
  const label = which === 'lower' ? COPY.range.minPrice : COPY.range.maxPrice
  const tick = range[which]
  const id = `range-${which}`
  const spoken = (t: number) => `${priceOrWords(t, price)}, ${fromPoolPrice(t, price.tick)} from the pool price, tick ${t}`
  return (
    <div className="rounded-[var(--radius)] border bg-surface-1 p-3" data-range-bound={which}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={`Lower the ${label.toLowerCase()} by one tick spacing`}
          onClick={() => onRange(stepBound(range, which, -1, price.tickSpacing))}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-surface-2 text-[16px] leading-none text-fg-muted transition hover:text-fg"
        >
          −
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] text-fg-subtle">{label}</p>
          <p className="tnum truncate font-mono text-[16px] leading-tight" data-bound-price="">
            {priceOrWords(tick, price)}
          </p>
          <p className="text-[10px] text-fg-subtle">
            <Units price={price} /> · tick <span className="tnum font-mono" data-bound-tick="">{tick}</span>
          </p>
        </div>
        <button
          type="button"
          aria-label={`Raise the ${label.toLowerCase()} by one tick spacing`}
          onClick={() => onRange(stepBound(range, which, 1, price.tickSpacing))}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-surface-2 text-[16px] leading-none text-fg-muted transition hover:text-fg"
        >
          +
        </button>
      </div>
      <PriceSlider
        id={id}
        label={label}
        min={bounds.min}
        max={bounds.max}
        step={price.tickSpacing}
        value={tick}
        onChange={(v) => onRange(moveBound(range, which, v, price.tickSpacing))}
        lower={range.lower}
        upper={range.upper}
        format={(t) => fromPoolPrice(t, price.tick)}
        valueText={spoken}
      />
    </div>
  )
}

/**
 * The range view of the Pair step's chain data (#3, S-PL7): the chosen
 * pool's price as read, and range controls drawn on it. With no
 * usable price there are no controls. Nothing here reads anything by itself;
 * "Read the price again" is one pools read of this pool id, on request.
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
  range: PracticeRange | null
  onRange: (range: PracticeRange) => void
}) {
  const now = useStaleClock(option.readAt)
  const price = poolPrice(option, now)
  // Only a tie-break and an explicit "Custom"; the checked width is derived from the range below.
  const [picked, setPicked] = useState<RangeMode | null>(null)
  const [line, setLine] = useState<StatusLine | null>(null)
  const [busy, setBusy] = useState(false)
  const running = useRef<AbortController | null>(null)
  useEffect(() => () => running.current?.abort(), [])

  const usable = price.state === 'usable' ? price : null
  // Derived each render from the range and the price as read now, so reopening a kept range
  // or reading the price again never leaves a preset checked that no longer describes it.
  const mode = usable && range ? rangeMode(range, usable.tick, usable.tickSpacing, picked) : null

  const reread = () => {
    if (busy) return
    running.current?.abort()
    const mine = new AbortController()
    running.current = mine
    setBusy(true)
    setLine({ code: 'loading', title: COPY.range.rereading, detail: '' })
    void verifyCandidate(source, token, paired, option.key, { signal: mine.signal }).then((result) => {
      if (mine.signal.aborted) return
      setBusy(false)
      if (result.failure) {
        setLine(result.failure.state === 'aborted' ? null : failureText(result.failure, 'pools'))
      } else if (result.option) {
        setLine({ code: 'ok', title: `Read again at block ${result.option.block}.`, detail: '' })
        onOption(result.option)
      } else {
        setLine({ code: 'not_found', title: 'Not updated', detail: COPY.range.notReturned })
      }
    })
  }

  const pick = (key: RangeKey) => {
    if (!usable) return
    setPicked(key)
    onRange(presetRange(usable.tick, usable.tickSpacing, key))
  }
  const custom = (next: PracticeRange) => {
    setPicked(null)
    onRange(next)
  }

  const position = usable && range ? rangePosition(range, usable.tick) : null
  const bounds = usable && range ? sliderWindow(usable.tick, usable.tickSpacing, range) : null

  return (
    <div className="grid gap-4" data-picker="range" data-price-state={price.state === 'usable' ? (price.stale ? 'stale' : price.partial ? 'partial' : 'usable') : 'unavailable'}>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone="wait">{COPY.range.pill}</Pill>
        {usable?.partial && <Pill>{COPY.range.partialPill}</Pill>}
        {usable?.stale && <Pill tone="out">{COPY.range.stalePill}</Pill>}
      </div>

      <section aria-labelledby="range-price-heading" className="grid gap-1.5 rounded-[var(--radius)] border bg-surface-1 p-3" data-pool-price="">
        <h3 id="range-price-heading" className="text-[13px] font-medium">
          {COPY.range.priceHeading}
        </h3>
        <p className="text-[12px] text-fg-muted">
          <SymbolText token={option.currencies[0]} /> / <SymbolText token={option.currencies[1]} />
          <span className="font-mono"> · {option.fee}</span>
        </p>
        <Address value={option.key} />
        {usable ? (
          <>
            <p className="tnum break-all font-mono text-[20px] leading-tight" data-pool-price-text="">
              {usable.text}
            </p>
            <p className="text-[12px] text-fg-muted">
              <Units price={usable} /> at block {usable.block} · tick {usable.tick} · tick spacing {usable.tickSpacing}
            </p>
            <p className="text-[11px] text-fg-subtle">{COPY.range.checked}</p>
            {usable.partial && (
              <div className="grid gap-0.5 text-[12px] text-money-wait" data-price-partial="">
                <p>{COPY.range.partial}</p>
                <p className="text-fg-muted">
                  <SymbolText token={usable.base} /> <Address value={usable.base.address ?? ''} />
                </p>
                <p className="text-fg-muted">
                  <SymbolText token={usable.quote} /> <Address value={usable.quote.address ?? ''} />
                </p>
              </div>
            )}
            {usable.stale && (
              <div className="grid gap-2" data-price-stale="">
                <p className="text-[12px] text-money-out">{COPY.range.stale}</p>
                <Button type="button" variant="outline" className="justify-self-start" aria-disabled={busy ? true : undefined} onClick={reread}>
                  {busy ? COPY.range.rereading : COPY.range.reread}
                </Button>
              </div>
            )}
            <ScreenStatus line={line} className="mt-1" />
          </>
        ) : (
          <div role="status" className="mt-1 rounded-[14px] border border-dashed px-4 py-3" data-price-unavailable={price.state === 'unavailable' ? price.problem : ''}>
            <p className="text-[14px] font-medium">{COPY.range.unavailableTitle}</p>
            {price.state === 'unavailable' && <p className="mt-0.5 text-[13px] text-fg-muted">{COPY.range.problems[price.problem]}</p>}
            <p className="mt-0.5 text-[13px] text-fg-muted">{COPY.range.noControls}</p>
          </div>
        )}
      </section>

      {usable && range && bounds && (
        <section aria-label="Range controls" className="grid gap-3" data-range-controls="">
          <div role="radiogroup" aria-label={COPY.range.width} className="flex gap-1 rounded-[var(--radius-pill)] border bg-surface-1 p-1">
            {(Object.keys(RANGES) as RangeKey[]).map((key) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={mode === key}
                onClick={() => pick(key)}
                className={cx('flex-1 rounded-[var(--radius-pill)] px-3 py-2 text-[12px] transition', mode === key ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:text-fg')}
              >
                {RANGES[key].label.replace(' range', '')}
              </button>
            ))}
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'custom'}
              onClick={() => setPicked('custom')}
              className={cx('flex-1 rounded-[var(--radius-pill)] px-3 py-2 text-[12px] transition', mode === 'custom' ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:text-fg')}
            >
              {COPY.range.custom}
            </button>
          </div>
          <div className="grid gap-2">
            <BoundControl which="lower" range={range} price={usable} bounds={bounds} onRange={custom} />
            <BoundControl which="upper" range={range} price={usable} bounds={bounds} onRange={custom} />
          </div>
          <p className="text-[11px] text-fg-subtle">
            {COPY.range.spacingHint} {COPY.range.thumbHint}
          </p>
          <p role="status" aria-live="polite" className={cx('text-[13px]', position === 'inside' ? 'text-money-in' : 'text-money-wait')} data-range-position={position ?? ''}>
            {position === 'inside' ? COPY.range.inside : position === 'below' ? COPY.range.below : COPY.range.above}
          </p>
          <p className="text-[12px] text-fg-muted" data-range-text="">
            {priceOrWords(range.lower, usable)} to {priceOrWords(range.upper, usable)} <Units price={usable} /> · ticks {range.lower} to {range.upper}
          </p>
        </section>
      )}

      <p className="rounded-[var(--radius)] border border-dashed p-3 text-[12px] leading-relaxed text-fg-muted" data-range-note="">
        {COPY.range.note}
      </p>
    </div>
  )
}
