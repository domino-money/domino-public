import { useState } from 'react'
import { previewPosition } from 'core/position'
import { RANGES, UNIT, type RangeKey } from '../lib/scenario'
import { cx } from './ui'

/**
 * The idea in one box: pick a range, see what a position would hold at the
 * price it opens at. No amount, no pair and no market figure: the split comes
 * from the same maths the product runs, in relative terms only.
 */
export function HeroWidget() {
  const [range, setRange] = useState<RangeKey>('standard')
  const p = previewPosition({ amount: UNIT, lower: RANGES[range].lower, upper: RANGES[range].upper, startingPrice: 1, scenarioPrice: 1 })
  const tokenPct = Math.round(p.tokenShare * 100)

  return (
    <div className="dm-glow mx-auto w-full max-w-[460px] rounded-[20px] border bg-surface-2 p-2">
      <div className="rounded-[14px] bg-surface-1 p-4">
        <div className="flex items-center justify-between">
          <span className="text-[12px] text-fg-muted">Choose a range</span>
          <div className="flex gap-1 rounded-[var(--radius-pill)] border bg-surface-2 p-0.5">
            {(Object.keys(RANGES) as RangeKey[]).map((key) => (
              <button
                key={key}
                onClick={() => setRange(key)}
                aria-pressed={range === key}
                className={cx('rounded-[var(--radius-pill)] px-2.5 py-1 text-[11px] transition', range === key ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:text-fg')}
              >
                {RANGES[key].label.replace(' range', '')}
              </button>
            ))}
          </div>
        </div>
        <p className="tnum mt-3 font-mono text-[22px] leading-tight">{RANGES[range].hint}</p>
        <p className="mt-1 text-[11px] text-fg-subtle">Prices as multiples of the one the position opens at.</p>
      </div>

      <div className="relative -my-3 flex justify-center">
        <span className="z-10 flex h-8 w-8 items-center justify-center rounded-[10px] border bg-surface-2 text-[14px] text-fg-muted">↓</span>
      </div>

      <div className="rounded-[14px] bg-surface-1 p-4">
        <span className="text-[12px] text-fg-muted">At that price the position holds</span>
        <div className="mt-3 grid grid-cols-2 gap-3">
          {(
            [
              ['Token', `${tokenPct}%`],
              ['Stablecoin', `${100 - tokenPct}%`],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="rounded-[10px] border bg-surface-2 px-3 py-2.5">
              <p className="text-[11px] text-fg-subtle">{label}</p>
              <p className="tnum mt-0.5 font-mono text-[18px]">{value}</p>
            </div>
          ))}
        </div>
        <p className="mt-2.5 text-[11px] text-fg-subtle">Shares of the value, not a 50/50 guess. The mix shifts as the price moves.</p>
      </div>

      <a
        href="#/#pools"
        className="mt-2 flex w-full items-center justify-center rounded-[var(--radius-pill)] bg-primary py-3 text-[14px] font-medium text-primary-fg transition hover:brightness-[1.06]"
      >
        See the selected pools
      </a>
    </div>
  )
}
