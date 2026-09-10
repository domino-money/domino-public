import { useRef, useState } from 'react'
import { addPracticePosition } from 'core/practice'
import type { BookUpdate } from 'core/local-workspace'
import { previewPosition, usd, qty } from 'core/position'
import type { PositionPreview } from 'core/position'
import { PAIR, RANGES, feeTier, type RangeKey } from '../lib/pair'
import { Callout, Receipt, StepDialog } from './StepDialog'
import { MixBar } from './MixBar'
import { PriceSlider } from './PriceSlider'
import { RangeChart, useComposition } from './RangeChart'
import { clampLower, clampUpper, domainFor } from '../lib/geometry'
import type { Domain } from '../lib/geometry'
import { TokenIcon, TokenPair } from './TokenIcon'
import { Pill, cx } from './ui'

const STEPS = ['Pair', 'Range', 'Explore', 'Review']

const TITLES = [
  'Start with a token you know.',
  'Give your token room to move.',
  'What if the price moves?',
  'Your position, ready to try.',
]

const DESCRIPTIONS = [
  `Try ${PAIR.label} with a hypothetical starting value.`,
  'Your position can earn trading fees while the price is in this range.',
  'Move the price to see how your two assets change.',
  'Check the setup. This creates a local practice card.',
]

type RangeMode = RangeKey | 'custom'


/** Editable price bound with steppers, the way an exchange lays out Min and Max. */
function BoundField({ label, value, onChange, clamp, id }: { label: string; value: number; onChange: (v: number) => void; clamp: (v: number) => number; id: string }) {
  const [text, setText] = useState(value.toFixed(2))
  const [editing, setEditing] = useState(false)
  const shown = editing ? text : value.toFixed(2)
  const step = value < 1 ? 0.01 : 0.05

  const commit = () => {
    setEditing(false)
    const n = Number(text)
    if (Number.isFinite(n) && n > 0) onChange(clamp(n))
  }

  return (
    <div className="rounded-[var(--radius)] border bg-surface-1 p-3">
      <label htmlFor={id} className="text-[11px] text-fg-subtle">{label}</label>
      <div className="mt-1 flex items-center gap-2">
        <button type="button" aria-label={`Decrease ${label}`} onClick={() => onChange(clamp(value - step))} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-surface-2 text-[16px] leading-none text-fg-muted transition hover:text-fg">−</button>
        <div className="flex min-w-0 flex-1 items-baseline gap-1">
          <span className="font-mono text-[14px] text-fg-subtle">$</span>
          <input
            id={id}
            inputMode="decimal"
            value={shown}
            onFocus={() => { setText(value.toFixed(2)); setEditing(true) }}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
            className="tnum w-full min-w-0 bg-transparent font-mono text-[20px] leading-none outline-none"
          />
        </div>
        <button type="button" aria-label={`Increase ${label}`} onClick={() => onChange(clamp(value + step))} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-surface-2 text-[16px] leading-none text-fg-muted transition hover:text-fg">+</button>
      </div>
      <p className="mt-1.5 text-[10px] text-fg-subtle">{PAIR.stable} per {PAIR.token}</p>
    </div>
  )
}

export function CreatePositionFlow({ open, onClose, saveBook }: { open: boolean; onClose: () => void; saveBook: (update: BookUpdate) => void }) {
  const [step, setStep] = useState(0)
  const [amount, setAmount] = useState('1000')
  const [mode, setMode] = useState<RangeMode>('standard')
  const [lower, setLower] = useState<number>(RANGES.standard.lower)
  const [upper, setUpper] = useState<number>(RANGES.standard.upper)
  const [price, setPrice] = useState<number>(PAIR.startPrice)
  const [understood, setUnderstood] = useState(false)
  const [error, setError] = useState('')
  const saving = useRef(false)

  const amountOk = /^\d{1,7}(\.\d{1,2})?$/.test(amount.trim())

  // The chart maps pointer X through the domain. Recomputing it while a bound is
  // being dragged moves the mapping under the pointer, so a stationary X keeps
  // producing a larger bound. The domain is captured when a drag starts and
  // released when it ends.
  const [heldDomain, setHeldDomain] = useState<Domain | null>(null)
  const liveDomain = domainFor(lower, upper)
  const domain = heldDomain ?? liveDomain
  const holdDomain = (active: boolean) => setHeldDomain(active ? liveDomain : null)
  const samples = useComposition(amountOk ? Number(amount) : 1000, lower, upper, domain)

  let result: PositionPreview | null = null
  try {
    result = amountOk ? previewPosition({ amount: Number(amount), lower, upper, startingPrice: PAIR.startPrice, scenarioPrice: price }) : null
  } catch {
    result = null
  }

  const pickPreset = (key: RangeKey) => {
    setMode(key)
    setLower(RANGES[key].lower)
    setUpper(RANGES[key].upper)
    setUnderstood(false)
  }

  const setBounds = (l: number, u: number) => {
    setMode('custom')
    setLower(clampLower(l))
    setUpper(clampUpper(u))
    setUnderstood(false)
  }

  function reset() {
    setStep(0)
    setUnderstood(false)
    setPrice(PAIR.startPrice)
    setError('')
  }

  function close() {
    reset()
    onClose()
  }

  function create() {
    if (!result || !understood || saving.current) return
    saving.current = true
    try {
      saveBook((previous) =>
        addPracticePosition(
          previous,
          {
            id: 'practice-' + crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            amount: Number(amount),
            lower,
            upper,
            enabled: true,
            reservesUsd: '0.000000',
            feesAddedUsd: '0.000000',
            netAddedUsd: '0.000000',
            servicePaidUsd: '0.000000',
          },
          crypto.randomUUID(),
        ),
      )
      close()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save this practice position.')
    } finally {
      saving.current = false
    }
  }

  return (
    <StepDialog
      open={open}
      onClose={close}
      eyebrow="New position · Practice"
      title={TITLES[step]}
      description={DESCRIPTIONS[step]}
      steps={STEPS}
      step={step}
      onBack={() => (step ? setStep(step - 1) : close())}
      backLabel={step ? 'Back' : 'Close'}
      onNext={() => (step === 3 ? create() : setStep(step + 1))}
      nextLabel={step === 3 ? 'Create practice card' : 'Continue'}
      nextDisabled={!result || (step === 3 && !understood)}
      error={error}
    >
      {step === 0 && (
        <>
          <div className="rounded-[var(--radius)] border bg-surface-1 p-4">
            <p className="text-[11px] text-fg-subtle">Select pair</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {[PAIR.token, PAIR.stable].map((sym) => (
                <div key={sym} className="flex items-center gap-2.5 rounded-[var(--radius)] border bg-surface-2 px-3 py-2.5">
                  <TokenIcon symbol={sym} size={24} />
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium">{sym}</p>
                    <p className="text-[10px] text-fg-subtle">Robinhood Chain</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center justify-between">
              <span className="text-[11px] text-fg-subtle">Fee tier</span>
              <span className="rounded-[6px] bg-surface-3 px-2 py-0.5 font-mono text-[11px]">{feeTier(PAIR.feePips)}</span>
            </div>
            <p className="mt-2 text-[11px] text-fg-subtle">Example pair. {PAIR.token} starts at {usd(PAIR.startPrice)}.</p>
          </div>

          <div>
            <label htmlFor="amount" className="text-[13px] text-fg-muted">Total starting value</label>
            <div className={cx('mt-1.5 flex items-center gap-2 rounded-[var(--radius)] border bg-surface-1 px-4 py-3', !result && 'border-[var(--money-out)]')}>
              <span className="font-mono text-[20px] text-fg-subtle">$</span>
              <input
                id="amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
                aria-describedby="amount-hint"
                aria-invalid={!result}
                className="tnum w-full bg-transparent font-mono text-[26px] outline-none"
              />
              <span className="font-mono text-[13px] text-fg-subtle">USD</span>
            </div>
            <p id="amount-hint" className="mt-1.5 text-[12px]" style={{ color: result ? 'var(--fg-subtle)' : 'var(--money-out)' }}>
              {result ? 'The combined value of both assets, before setup costs.' : 'Enter an amount between $10 and $1,000,000.'}
            </p>
          </div>

          <Callout title="Two assets. One position.">
            You provide {PAIR.token} and {PAIR.stable} for others to trade between. Your share of trading fees can be reinvested.
          </Callout>
        </>
      )}

      {step === 1 && (
        <>
          <div role="radiogroup" aria-label="Price range" className="flex gap-1 rounded-[var(--radius-pill)] border bg-surface-1 p-1">
            {(Object.keys(RANGES) as RangeKey[]).map((key) => (
              <button key={key} role="radio" aria-checked={mode === key} onClick={() => pickPreset(key)} className={cx('flex-1 rounded-[var(--radius-pill)] px-3 py-2 text-[12px] transition', mode === key ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:text-fg')}>
                {RANGES[key].label.replace(' range', '')}
                <span className="ml-1.5 hidden font-mono text-fg-subtle sm:inline">{RANGES[key].hint}</span>
              </button>
            ))}
            <button role="radio" aria-checked={mode === 'custom'} onClick={() => setMode('custom')} className={cx('flex-1 rounded-[var(--radius-pill)] px-3 py-2 text-[12px] transition', mode === 'custom' ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:text-fg')}>
              Custom
            </button>
          </div>

          <div className="rounded-[var(--radius)] border bg-surface-1 p-4">
            <p className="mb-3 text-[12px] text-fg-muted">Drag either edge of the shaded band, or type the prices below.</p>
            <RangeChart samples={samples} lower={lower} upper={upper} price={PAIR.startPrice} onBounds={setBounds} onGesture={holdDomain} domain={domain} height={130} compact />
            <div className="mt-6 grid grid-cols-2 gap-2">
              <BoundField id="min-price" label="Min price" value={lower} clamp={clampLower} onChange={(v) => setBounds(v, upper)} />
              <BoundField id="max-price" label="Max price" value={upper} clamp={clampUpper} onChange={(v) => setBounds(lower, v)} />
            </div>
            <p className="mt-2 font-mono text-[11px] text-fg-subtle">Current price {usd(PAIR.startPrice)} · range {usd(lower)} to {usd(upper)}</p>
          </div>

          <p className="text-[12px] leading-relaxed text-fg-subtle">
            A wider range covers more prices and spreads your liquidity further. A closer one earns a bigger share while the price stays inside. Neither guarantees a return.
          </p>

          <Callout title="Your starting mix">
            <span className="tnum font-mono">
              {result ? qty(result.initialToken) : '0'} {PAIR.token} + {result ? qty(result.initialStable) : '0'} {PAIR.stable}
            </span>
            <p className="mt-1 text-[12px]">A live setup would show any required swap and its cost before you sign.</p>
          </Callout>
        </>
      )}

      {step === 2 && result && (
        <>
          <div className="rounded-[var(--radius)] border bg-surface-1 p-4">
            <RangeChart samples={samples} lower={lower} upper={upper} price={price} onPrice={setPrice} domain={domain} height={120} compact />
            <PriceSlider id="scenario-price" label={`${PAIR.token} scenario price`} min={domain[0]} max={domain[1]} value={price} onChange={setPrice} lower={lower} upper={upper} />
          </div>

          <MixBar tokenShare={result.tokenShare} tokenAmount={qty(result.token)} stableAmount={qty(result.stable)} />

          <p className="text-[13px] leading-relaxed text-fg-muted">
            {result.status === 'inside'
              ? `In range. As the price rises, ${PAIR.token} becomes ${PAIR.stable}; as it falls, ${PAIR.stable} becomes ${PAIR.token}.`
              : result.status === 'above'
                ? `Above your range. Your position is all ${PAIR.stable} and earns no trading fees until the price returns.`
                : `Below your range. Your position is all ${PAIR.token} and earns no trading fees until the price returns.`}
          </p>

          <Receipt rows={[{ label: 'Position value', value: usd(result.value) }, { label: 'Holding the initial assets', value: usd(result.holdValue) }]} />

          <p className="text-[12px] leading-relaxed text-fg-subtle">
            Price-only illustration, {PAIR.stable} = $1. Fees, gas, swaps and reinvestment are excluded. Exploring a price does not change your $1 starting price.
          </p>
        </>
      )}

      {step === 3 && result && (
        <>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <TokenPair base={PAIR.token} quote={PAIR.stable} size={32} />
              <div>
                <h3 className="text-[16px] font-medium">{PAIR.label}</h3>
                <p className="text-[12px] text-fg-subtle">{feeTier(PAIR.feePips)} fee tier · {PAIR.note}</p>
              </div>
            </div>
            <Pill tone="wait">Practice</Pill>
          </div>

          <Receipt
            rows={[
              { label: 'Starting value', value: usd(Number(amount)) },
              { label: 'Range', value: `${usd(lower)} to ${usd(upper)}${mode === 'custom' ? ' (custom)' : ''}` },
              { label: 'Starting mix', value: (<>{qty(result.initialToken)} {PAIR.token}<br />{qty(result.initialStable)} {PAIR.stable}</>) },
              { label: 'Service fee on reinvestment', value: '2% of fees used' },
            ]}
          />

          <label htmlFor="risk-consent" className="flex cursor-pointer items-start gap-3 rounded-[var(--radius)] border bg-surface-1 p-4">
            <input id="risk-consent" type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--primary)]" />
            <span className="text-[13px] leading-relaxed text-fg-muted">I understand the token mix changes with price, losses are possible, and fees stop outside the range.</span>
          </label>

          <p className="text-[12px] leading-relaxed text-fg-subtle">No deposit, wallet signature or service charge. Reinvestment scenarios are run manually in practice mode.</p>
        </>
      )}
    </StepDialog>
  )
}
