import { useState } from 'react'
import { previewPosition, usd, qty } from 'core/position'
import { PAIR, RANGES, SCENARIO_MAX, SCENARIO_MIN, feeTier, type RangeKey } from '../lib/pair'
import { Card, Display, Eyebrow, cx } from './ui'
import { MixBar } from './MixBar'
import { PriceSlider } from './PriceSlider'
import { RangeChart, useComposition } from './RangeChart'
import { TokenPair } from './TokenIcon'

const AMOUNT = 1000

export function RangeSimulator() {
  const [range, setRange] = useState<RangeKey>('standard')
  const [price, setPrice] = useState(1)

  const { lower, upper } = RANGES[range]
  const samples = useComposition(AMOUNT, lower, upper)
  const p = previewPosition({ amount: AMOUNT, lower, upper, startingPrice: 1, scenarioPrice: price })

  const other = range === 'standard' ? RANGES.wide : RANGES.standard
  const o = previewPosition({ amount: AMOUNT, lower: other.lower, upper: other.upper, startingPrice: 1, scenarioPrice: price })

  const triggerFrom = lower + (upper - lower) * 0.8
  const nearTop = price >= triggerFrom && price <= upper
  const inRange = p.status === 'inside'

  // The price effect alone is never positive, so the useful number for a
  // beginner is the other side of it: how much fee income puts them ahead.
  const toBeatHolding = Math.max(0, -p.difference)

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-5 border-b p-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Eyebrow>Try it</Eyebrow>
          <Display className="mt-2 text-[30px]">Move the price. Watch what you own.</Display>
          <p className="mt-2 max-w-[54ch] text-[14px] leading-relaxed text-fg-muted">
            {usd(AMOUNT)} opened at {usd(1)} in the {PAIR.label} pool. Drag the chart or the handle
            below it. The numbers come from the same maths the product runs.
          </p>
        </div>
        <div role="radiogroup" aria-label="Range width" className="flex shrink-0 gap-1 rounded-[var(--radius-pill)] border bg-surface-2 p-1">
          {(Object.keys(RANGES) as RangeKey[]).map((key) => (
            <button
              key={key}
              role="radio"
              aria-checked={range === key}
              onClick={() => setRange(key)}
              className={cx(
                'rounded-[var(--radius-pill)] px-4 py-2 text-[12px] transition',
                range === key ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:text-fg',
              )}
            >
              {RANGES[key].label.replace(' range', '')}
              <span className="ml-1.5 hidden font-mono text-fg-subtle sm:inline">{RANGES[key].hint}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-8 p-6 lg:grid-cols-[1.3fr_1fr]">
        <div>
          <RangeChart samples={samples} lower={lower} upper={upper} price={price} onPrice={setPrice} />
          <div className="mt-3">
            <PriceSlider
              id="sim-price"
              label={`${PAIR.token} scenario price`}
              min={SCENARIO_MIN}
              max={SCENARIO_MAX}
              value={price}
              onChange={setPrice}
              lower={lower}
              upper={upper}
            />
          </div>

          <div className="mt-4">
            <MixBar tokenShare={p.tokenShare} tokenAmount={qty(p.token)} stableAmount={qty(p.stable)} />
          </div>

          <div className="mt-6 rounded-[var(--radius)] border bg-surface-1 p-4">
            <p className="text-[12px] font-medium">
              If you had picked the {other.label.replace(' range', '').toLowerCase()} range instead
            </p>
            <div className="mt-2 grid grid-cols-3 gap-3 text-[12px]">
              {(
                [
                  [`${PAIR.token} share`, `${Math.round(p.tokenShare * 100)}%`, `${Math.round(o.tokenShare * 100)}%`],
                  ['Position value', usd(p.value), usd(o.value)],
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
            <div className="flex items-center gap-2">
              <TokenPair base={PAIR.token} quote={PAIR.stable} size={22} ring="transparent" />
              <span className="text-[13px] font-medium" style={{ color: inRange ? 'var(--money-in)' : 'var(--money-wait)' }}>
                {inRange ? 'Collecting trading fees' : p.status === 'above' ? 'Paused above the range' : 'Paused below the range'}
              </span>
            </div>
            <p className="mt-2 text-[13px] leading-relaxed" style={{ color: inRange ? 'var(--money-in)' : 'var(--money-wait)', opacity: 0.9 }}>
              {inRange
                ? `This pool charges ${feeTier(PAIR.feePips)} on every swap. While the price sits in your range, a share of that fee lands in your position, trade after trade.`
                : p.status === 'above'
                  ? `You now hold ${PAIR.stable} only, so the rise is locked in. Fees resume the moment the price comes back into range.`
                  : `You now hold ${PAIR.token} only, bought on the way down. Fees resume the moment the price comes back into range.`}
            </p>
          </div>

          <dl className="mt-5">
            {(
              [
                [`${PAIR.token} you hold`, qty(p.token)],
                [`${PAIR.stable} you hold`, qty(p.stable)],
                ['Position value', usd(p.value)],
                ['Same assets, just held', usd(p.holdValue)],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between border-b border-dashed py-2.5">
                <dt className="text-[13px] text-fg-muted">{label}</dt>
                <dd className="tnum font-mono text-[13px]">{value}</dd>
              </div>
            ))}
            <div className="flex items-baseline justify-between py-2.5">
              <dt className="text-[13px] text-fg-muted">Fees that put you ahead of holding</dt>
              <dd className="tnum font-mono text-[13px]" style={{ color: toBeatHolding === 0 ? 'var(--money-in)' : 'var(--fg)' }}>
                {toBeatHolding === 0 ? 'Already there' : `${usd(toBeatHolding)}+`}
              </dd>
            </div>
          </dl>

          <p className="mt-2 text-[12px] leading-relaxed text-fg-subtle">
            That last figure is the bar your fee income has to clear at this price. Fees are left out
            of the preview on purpose, so you can see the price effect on its own.
          </p>

          <div
            className="mt-5 rounded-[var(--radius)] border p-4 transition-colors"
            style={nearTop ? { background: 'var(--accent)', borderColor: 'transparent' } : undefined}
          >
            <p className="text-[12px] font-medium" style={{ color: nearTop ? 'var(--accent-fg)' : 'var(--fg-muted)' }}>
              {nearTop ? 'This is where Domino steps in' : `Above ${usd(triggerFrom)}, Domino steps in`}
            </p>
            <p className="mt-1 text-[12px] leading-relaxed" style={{ color: nearTop ? 'var(--accent-fg)' : 'var(--fg-subtle)' }}>
              Near the top of the range, the fees you have collected open the next position higher up
              instead of going back into this one. Your {usd(AMOUNT)} stays exactly where it is.
            </p>
          </div>
        </div>
      </div>
    </Card>
  )
}
