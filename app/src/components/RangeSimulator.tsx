import { useState } from 'react'
import { previewPosition } from 'core/position'
import { RANGES, SCENARIO_MAX, SCENARIO_MIN, UNIT, change, ofStart, times, type RangeKey } from '../lib/scenario'
import { Card, Display, Eyebrow, Pill, cx } from './ui'
import { MixBar } from './MixBar'
import { PriceSlider } from './PriceSlider'
import { RangeChart, useComposition } from './RangeChart'

/**
 * Move the price, watch what a position holds. The maths is the product's
 * own (core/position), run on a position of no particular size: every figure
 * is a multiple of the start price or a share of the starting value, so
 * nothing here names a pair, quotes an amount or promises an outcome.
 */
export function RangeSimulator() {
  const [range, setRange] = useState<RangeKey>('standard')
  const [price, setPrice] = useState(1)

  const { lower, upper } = RANGES[range]
  const curve = useComposition(lower, upper)
  const p = previewPosition({ amount: UNIT, lower, upper, startingPrice: 1, scenarioPrice: price })

  const other = range === 'standard' ? RANGES.wide : RANGES.standard
  const o = previewPosition({ amount: UNIT, lower: other.lower, upper: other.upper, startingPrice: 1, scenarioPrice: price })

  const triggerFrom = lower + (upper - lower) * 0.8
  const nearTop = price >= triggerFrom && price <= upper
  const inRange = p.status === 'inside'
  const tokenPct = Math.round(p.tokenShare * 100)

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-5 border-b p-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Eyebrow>Try it</Eyebrow>
          <Display className="mt-2 text-[30px]">Move the price. Watch what you own.</Display>
          <p className="mt-2 max-w-[54ch] text-[14px] leading-relaxed text-fg-muted">
            A position opened at the start price, in a pool of a token against a stablecoin. Drag the chart or the handle below it. Every figure is relative to
            that start, from the same maths the product runs.
          </p>
        </div>
        <div role="radiogroup" aria-label="Range width" className="flex shrink-0 gap-1 rounded-[var(--radius-pill)] border bg-surface-2 p-1">
          {(Object.keys(RANGES) as RangeKey[]).map((key) => (
            <button
              key={key}
              role="radio"
              aria-checked={range === key}
              onClick={() => setRange(key)}
              className={cx('rounded-[var(--radius-pill)] px-4 py-2 text-[12px] transition', range === key ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:text-fg')}
            >
              {RANGES[key].label.replace(' range', '')}
              <span className="ml-1.5 hidden font-mono text-fg-subtle sm:inline">
                {times(RANGES[key].lower)} to {times(RANGES[key].upper)}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-8 p-6 lg:grid-cols-[1.3fr_1fr]">
        <div>
          <RangeChart curve={curve} lower={lower} upper={upper} price={price} onPrice={setPrice} />
          <div className="mt-3">
            <PriceSlider
              id="sim-price"
              label="Scenario price, as a multiple of the start price"
              min={SCENARIO_MIN}
              max={SCENARIO_MAX}
              value={price}
              onChange={setPrice}
              lower={lower}
              upper={upper}
            />
          </div>

          <div className="mt-4">
            <MixBar tokenShare={p.tokenShare} />
          </div>

          <div className="mt-6 rounded-[var(--radius)] border bg-surface-1 p-4">
            <p className="text-[12px] font-medium">If you had picked the {other.label.replace(' range', '').toLowerCase()} range instead</p>
            <div className="mt-2 grid grid-cols-3 gap-3 text-[12px]">
              {(
                [
                  ['Token share', `${tokenPct}%`, `${Math.round(o.tokenShare * 100)}%`],
                  ['Value against the start', ofStart(p.value / UNIT), ofStart(o.value / UNIT)],
                  ['Status', inRange ? 'Earning' : 'Paused', o.status === 'inside' ? 'Earning' : 'Paused'],
                ] as const
              ).map(([label, mine, theirs]) => (
                <div key={label}>
                  <p className="text-fg-subtle">{label}</p>
                  <p className="tnum mt-0.5 font-mono" style={{ color: 'var(--primary)' }}>{mine}</p>
                  <p className="tnum font-mono text-fg-subtle">{theirs}</p>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[12px] leading-relaxed text-fg-subtle">
              {range === 'standard'
                ? 'A closer range puts the same money into a narrower band. You collect a bigger share of every swap while the price stays inside, and you step out sooner when it leaves.'
                : 'A wider range keeps you collecting across more prices. The same money is spread thinner, so your share of each swap is smaller.'}
            </p>
          </div>
        </div>

        <div>
          {/* Headline state */}
          <div
            className="rounded-[var(--radius)] border p-4"
            style={inRange ? { background: 'var(--money-in-bg)', borderColor: 'transparent' } : { background: 'var(--money-wait-bg)', borderColor: 'transparent' }}
          >
            <span className="text-[13px] font-medium" style={{ color: inRange ? 'var(--money-in)' : 'var(--money-wait)' }}>
              {inRange ? 'Collecting trading fees' : p.status === 'above' ? 'Paused above the range' : 'Paused below the range'}
            </span>
            <p className="mt-2 text-[13px] leading-relaxed" style={{ color: inRange ? 'var(--money-in)' : 'var(--money-wait)', opacity: 0.9 }}>
              {inRange
                ? 'While the price sits in the range, a share of every swap fee lands in the position, trade after trade.'
                : p.status === 'above'
                  ? 'The position now holds the stablecoin only, so the rise is locked in. Fees resume the moment the price comes back into range.'
                  : 'The position now holds the token only, bought on the way down. Fees resume the moment the price comes back into range.'}
            </p>
          </div>

          <dl className="mt-5">
            {(
              [
                ['Token share of the value', `${tokenPct}%`],
                ['Stablecoin share', `${100 - tokenPct}%`],
                ['Value against the start', ofStart(p.value / UNIT)],
                ['Same assets, just held', ofStart(p.holdValue / UNIT)],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between border-b border-dashed py-2.5">
                <dt className="text-[13px] text-fg-muted">{label}</dt>
                <dd className="tnum font-mono text-[13px]">{value}</dd>
              </div>
            ))}
            <div className="flex items-baseline justify-between py-2.5">
              <dt className="text-[13px] text-fg-muted">Against just holding</dt>
              <dd className="tnum font-mono text-[13px]">{change(p.difference / UNIT)}</dd>
            </div>
          </dl>

          <p className="mt-2 text-[12px] leading-relaxed text-fg-subtle">
            Fees are left out on purpose, so you see the price effect on its own. Fee income has to cover that gap before a position is ahead of simply holding.
          </p>

          <div className="mt-5 rounded-[var(--radius)] border p-4 transition-colors" style={nearTop ? { background: 'var(--accent)', borderColor: 'transparent' } : undefined}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[12px] font-medium" style={{ color: nearTop ? 'var(--accent-fg)' : 'var(--fg-muted)' }}>
                {nearTop ? 'This is where Domino steps in' : `Above ${times(triggerFrom)}, Domino steps in`}
              </p>
              <Pill tone="neutral">Not available in the alpha</Pill>
            </div>
            <p className="mt-1 text-[12px] leading-relaxed" style={{ color: nearTop ? 'var(--accent-fg)' : 'var(--fg-subtle)' }}>
              Near the top of the range, the fees a position has collected open the next position higher up instead of going back into this one. The deposit stays
              exactly where it is.
            </p>
          </div>
        </div>
      </div>
    </Card>
  )
}
