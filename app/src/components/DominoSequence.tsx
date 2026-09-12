import { useState } from 'react'
import { times } from '../lib/scenario'
import { Pill, cx } from './ui'

/**
 * Interactive schematic of the Domino sequence.
 *
 * Each row is a position in the same pool, with its own range. Once the price
 * climbs into the top part of a range, that position stops reinvesting into
 * itself and its earned fees open the next position instead.
 *
 * A diagram of the rule, not a projection. It shows when a successor opens,
 * never how much anything would earn. Prices are multiples of the first
 * position's start price. Domino is not part of the alpha, and says so.
 */

const LADDER = [
  { lower: 0.7, upper: 1.5 },
  { lower: 1.35, upper: 2.2 },
  { lower: 2.0, upper: 3.1 },
  { lower: 2.85, upper: 4.2 },
]

const MIN = 0.6
const MAX = 4.4
const TRIGGER = 0.8

const pos = (v: number) => ((v - MIN) / (MAX - MIN)) * 100

export function DominoSequence() {
  const [price, setPrice] = useState(1.0)

  const state = LADDER.map((r, i) => {
    const triggerPrice = r.lower + (r.upper - r.lower) * TRIGGER
    const previous = LADDER[i - 1]
    const opensAt = previous ? previous.lower + (previous.upper - previous.lower) * TRIGGER : MIN
    const exists = price >= opensAt
    const inRange = price >= r.lower && price < r.upper
    const carrying = exists && price >= triggerPrice && price < r.upper
    const passed = price >= r.upper
    return { ...r, i, triggerPrice, exists, inRange, carrying, passed }
  })

  const open = state.filter((s) => s.exists)
  const carrying = state.find((s) => s.carrying)

  return (
    <div className="rounded-[var(--radius)] border bg-surface-1 p-5">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <span className="text-[12px] text-fg-muted">{'Price'}</span>
          <strong className="tnum font-mono text-[20px]">{times(price)}</strong>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={carrying ? 'accent' : 'neutral'}>
            {open.length} of {LADDER.length} positions open
          </Pill>
          <Pill tone="neutral">Not available in the alpha</Pill>
        </div>
      </div>

      <div className="grid gap-2.5">
        {[...state].reverse().map((s) => (
          <div key={s.i} className="flex items-center gap-3">
            <div className="w-[118px] shrink-0">
              <p className="text-[12px]" style={{ color: s.exists ? 'var(--fg)' : 'var(--fg-subtle)' }}>
                Position {s.i + 1}
              </p>
              <p className="font-mono text-[10px] text-fg-subtle">
                {times(s.lower)} to {times(s.upper)}
              </p>
            </div>

            <div className="relative h-7 flex-1 rounded-[6px] bg-surface-3">
              <div
                className="absolute inset-y-0 rounded-[6px] transition-all duration-300"
                style={{
                  left: `${pos(s.lower)}%`,
                  width: `${pos(s.upper) - pos(s.lower)}%`,
                  background: s.exists ? 'var(--accent)' : 'var(--surface-3)',
                  opacity: s.exists ? 1 : 0.4,
                  border: s.inRange ? '1px solid var(--primary)' : '1px solid transparent',
                }}
              />
              {s.exists && (
                <div
                  className="absolute inset-y-0 transition-all duration-300"
                  style={{
                    left: `${pos(s.triggerPrice)}%`,
                    width: `${pos(s.upper) - pos(s.triggerPrice)}%`,
                    background: 'var(--primary)',
                    opacity: s.carrying ? 0.55 : 0.18,
                    borderRadius: '0 6px 6px 0',
                  }}
                />
              )}
              <div className="absolute inset-y-[-4px] w-[2px] rounded-full" style={{ left: `${pos(price)}%`, background: 'var(--fg)' }} />
            </div>

            <span
              className={cx('w-[96px] shrink-0 text-right text-[10.5px]')}
              style={{ color: s.carrying ? 'var(--primary)' : s.inRange ? 'var(--money-in)' : 'var(--fg-subtle)' }}
            >
              {!s.exists ? 'not open yet' : s.carrying ? 'funding the next' : s.inRange ? 'earning' : s.passed ? 'above range' : 'below range'}
            </span>
          </div>
        ))}
      </div>

      <label htmlFor="ladder-price" className="sr-only">Price across the sequence</label>
      <input
        id="ladder-price"
        type="range"
        min={MIN}
        max={MAX}
        step={0.01}
        value={price}
        onChange={(e) => setPrice(Number(e.target.value))}
        className="mt-5 w-full accent-[var(--primary)]"
      />

      <p className="mt-4 text-[12px] leading-relaxed text-fg-muted">
        {carrying ? (
          <>
            Position {carrying.i + 1} has reached the top {Math.round((1 - TRIGGER) * 100)}% of its
            range. Its earned fees now go to opening the next position instead of back into itself.
          </>
        ) : open.length === LADDER.length ? (
          <>The whole sequence is open. Each position was paid for by the fees of the one below it.</>
        ) : (
          <>
            Drag the price upward. Each position hands its fees to the next once the price reaches
            the top {Math.round((1 - TRIGGER) * 100)}% of its range.
          </>
        )}
      </p>

      <div className="mt-3 flex flex-wrap gap-4 border-t border-dashed pt-3 text-[11px] text-fg-subtle">
        <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm" style={{ background: 'var(--accent)' }} />range</span>
        <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm" style={{ background: 'var(--primary)', opacity: 0.55 }} />hand-off zone</span>
        <span className="flex items-center gap-1.5"><i className="h-2.5 w-[2px] rounded-sm" style={{ background: 'var(--fg)' }} />price</span>
        <span className="ml-auto">Schematic, not a projection</span>
      </div>
    </div>
  )
}
