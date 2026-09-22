import { useState } from 'react'
import { previewPosition } from 'core/position'
import { RANGES, SCENARIO_MAX, SCENARIO_MIN, UNIT, change, ofStart, times, type RangeKey } from '../lib/scenario'
import { RoadmapPill } from '../screens/Automate'
import { Display, KeyValue, KeyValueList, Pill, Segmented, cx } from './ui'
import { MixBar } from './MixBar'
import { PriceSlider } from './PriceSlider'
import { RangeChart, useComposition } from './RangeChart'

/**
 * Move the price, watch what a position holds. The maths is the product's
 * own (core/position), run on a position of no particular size: every figure
 * is a multiple of the start price or a share of the starting value, so
 * nothing here names a pair, quotes an amount or promises an outcome.
 *
 * The chart, the slider, the mix and the state stay in view; the figure list
 * and the comparison with the other range sit in one disclosure.
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
    <div className="dm-card p-5 sm:p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between lg:gap-8">
        <div className="min-w-0">
          <Display as="h2" className="dm-display-card">
            Move the price. Watch what you own.
          </Display>
        </div>
        <Segmented
          label="Range width"
          value={range}
          onChange={setRange}
          className="shrink-0 self-start lg:self-auto"
          items={(Object.keys(RANGES) as RangeKey[]).map((key) => ({
            key,
            label: (
              <>
                {RANGES[key].label.replace(' range', '')}
                <span className="tnum text-fg-subtle">
                  {times(RANGES[key].lower)} to {times(RANGES[key].upper)}
                </span>
              </>
            ),
          }))}
        />
      </div>

      <div className="mt-2 grid gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <RangeChart curve={curve} lower={lower} upper={upper} price={price} onPrice={setPrice} />
          <div className="mt-4">
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
          <div className="mt-5">
            <MixBar tokenShare={p.tokenShare} />
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-3 lg:pt-8">
          {/* Where the position stands at this price: the in-tone inside the range, neutral outside it. */}
          <div className="dm-inset p-4">
            <Pill tone={inRange ? 'in' : 'neutral'} dot>
              {inRange ? 'Collecting trading fees' : p.status === 'above' ? 'Paused above the range' : 'Paused below the range'}
            </Pill>
            <p className="mt-3 text-body text-fg-muted">
              {inRange
                ? 'While the price sits in the range, a share of every swap fee lands in the position, trade after trade.'
                : p.status === 'above'
                  ? 'The position now holds the stablecoin only, so the rise is locked in. Fees resume the moment the price comes back into range.'
                  : 'The position now holds the token only, bought on the way down. Fees resume the moment the price comes back into range.'}
            </p>
          </div>

          {/* Where Domino would step in: near the top of the range. */}
          <div className={cx('rounded-[var(--radius)] p-4 transition-colors duration-200', nearTop ? 'bg-accent' : 'dm-inset')}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className={cx('text-body font-medium', nearTop ? 'text-accent-fg' : 'text-fg')}>
                {nearTop ? 'This is where Domino steps in' : `Above ${times(triggerFrom)}, Domino steps in`}
              </p>
              {/* ROADMAP's pill while Domino does not run here; nothing once it does. */}
              <RoadmapPill name="Domino" />
            </div>
            <p className={cx('mt-1.5 text-body', nearTop ? 'text-accent-fg' : 'text-fg-muted')}>
              Near the top of the range, the fees a position has collected open the next position higher up instead of going back into this one. The deposit stays
              exactly where it is.
            </p>
          </div>
        </div>
      </div>

      <div className="mt-6 border-t border-line pt-3">
        <details className="dm-details -mx-3">
          <summary>Figures, and the other range</summary>
          <div className="grid gap-x-10 gap-y-6 lg:grid-cols-2">
            <div className="min-w-0">
              <KeyValueList className="px-0">
                <KeyValue label="Token share of the value">{tokenPct}%</KeyValue>
                <KeyValue label="Stablecoin share">{100 - tokenPct}%</KeyValue>
                <KeyValue label="Value against the start">{ofStart(p.value / UNIT)}</KeyValue>
                <KeyValue label="Same assets, just held">{ofStart(p.holdValue / UNIT)}</KeyValue>
                <KeyValue label="Against just holding">{change(p.difference / UNIT)}</KeyValue>
              </KeyValueList>
              <p className="mt-2 px-1 text-caption text-fg-subtle">
                Fees are left out on purpose, so you see the price effect on its own. Fee income has to cover that gap before a position is ahead of simply holding.
              </p>
            </div>

            <div className="dm-inset min-w-0 self-start p-4">
              <p className="text-body font-medium text-fg">If you had picked the {other.label.replace(' range', '').toLowerCase()} range instead</p>
              <div className="mt-3 grid grid-cols-3 gap-3 text-caption">
                {(
                  [
                    ['Token share', `${tokenPct}%`, `${Math.round(o.tokenShare * 100)}%`],
                    ['Value against the start', ofStart(p.value / UNIT), ofStart(o.value / UNIT)],
                    ['Status', inRange ? 'Earning' : 'Paused', o.status === 'inside' ? 'Earning' : 'Paused'],
                  ] as const
                ).map(([label, mine, theirs]) => (
                  <div key={label} className="min-w-0">
                    <p className="text-fg-subtle">{label}</p>
                    <p className="tnum mt-1 font-medium text-primary-ink">{mine}</p>
                    <p className="tnum text-fg-muted">{theirs}</p>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-caption text-fg-subtle">
                {range === 'standard'
                  ? 'A closer range puts the same money into a narrower band. You collect a bigger share of every swap while the price stays inside, and you step out sooner when it leaves.'
                  : 'A wider range keeps you collecting across more prices. The same money is spread thinner, so your share of each swap is smaller.'}
              </p>
            </div>
          </div>
        </details>
      </div>
    </div>
  )
}
