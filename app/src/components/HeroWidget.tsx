import { useState } from 'react'
import { previewPosition, qty, usd } from 'core/position'
import type { PositionPreview } from 'core/position'
import { PAIR, RANGES, type RangeKey } from '../lib/pair'
import { TokenAvatars } from './StepDialog'
import { Button, cx } from './ui'

/**
 * The product, in one box. Same idea as a swap widget on an exchange: type an
 * amount, pick a range, see what you'd hold. The maths is the real one.
 */
export function HeroWidget() {
  const [amount, setAmount] = useState('1000')
  const [range, setRange] = useState<RangeKey>('standard')

  let preview: PositionPreview | null = null
  try {
    preview = previewPosition({
      amount: Number(amount),
      lower: RANGES[range].lower,
      upper: RANGES[range].upper,
      startingPrice: PAIR.startPrice,
      scenarioPrice: PAIR.startPrice,
    })
  } catch {
    preview = null
  }

  return (
    <div className="dm-glow mx-auto w-full max-w-[460px] rounded-[20px] border bg-surface-2 p-2">
      <div className="rounded-[14px] bg-surface-1 p-4">
        <div className="flex items-center justify-between">
          <span className="text-[12px] text-fg-muted">You provide</span>
          <span className="flex items-center gap-2 rounded-[var(--radius-pill)] border bg-surface-2 py-1 pl-1.5 pr-3 text-[12px]">
            <TokenAvatars size={20} />
            {PAIR.label}
          </span>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="font-mono text-[28px] text-fg-subtle">$</span>
          <input
            id="hero-amount"
            name="amount"
            aria-label="Total starting value in USD"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="tnum w-full bg-transparent font-mono text-[34px] leading-none outline-none"
          />
        </div>
        <p className="mt-1 text-[11px] text-fg-subtle">
          {preview ? 'Total across both assets' : 'Enter between $10 and $1,000,000'}
        </p>
      </div>

      <div className="relative -my-3 flex justify-center">
        <span className="z-10 flex h-8 w-8 items-center justify-center rounded-[10px] border bg-surface-2 text-[14px] text-fg-muted">
          ↓
        </span>
      </div>

      <div className="rounded-[14px] bg-surface-1 p-4">
        <div className="flex items-center justify-between">
          <span className="text-[12px] text-fg-muted">You would hold at {usd(PAIR.startPrice)}</span>
          <div className="flex gap-1 rounded-[var(--radius-pill)] border bg-surface-2 p-0.5">
            {(Object.keys(RANGES) as RangeKey[]).map((key) => (
              <button
                key={key}
                onClick={() => setRange(key)}
                aria-pressed={range === key}
                className={cx(
                  'rounded-[var(--radius-pill)] px-2.5 py-1 text-[11px] transition',
                  range === key ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:text-fg',
                )}
              >
                {RANGES[key].label.replace(' range', '')}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          {[
            [PAIR.token, preview ? qty(preview.initialToken) : '0'],
            [PAIR.stable, preview ? qty(preview.initialStable) : '0'],
          ].map(([sym, val]) => (
            <div key={sym} className="rounded-[10px] border bg-surface-2 px-3 py-2.5">
              <p className="text-[11px] text-fg-subtle">{sym}</p>
              <p className="tnum mt-0.5 font-mono text-[18px]">{val}</p>
            </div>
          ))}
        </div>
        <p className="mt-2.5 text-[11px] text-fg-subtle">
          Range {RANGES[range].hint}. The mix shifts as the price moves.
        </p>
      </div>

      <Button
        className="mt-2 w-full py-3 text-[14px]"
        onClick={() => (window.location.hash = '#/app')}
        disabled={!preview}
      >
        Try it in the workspace
      </Button>
    </div>
  )
}
