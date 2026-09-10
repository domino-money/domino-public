import { useState } from 'react'
import { previewCompound } from 'core/compound'
import type { CurrentCompoundDecision } from 'core/compound'
import { runPracticeCompound } from 'core/practice'
import type { PracticePosition } from 'core/practice'
import type { BookUpdate } from 'core/local-workspace'
import { usd } from 'core/position'
import { PAIR, isMoney } from '../lib/pair'
import { Callout, PairHeading, Receipt, StepDialog } from './StepDialog'
import { Button, Pill } from './ui'

type Stage = 'overview' | 'inputs' | 'review'

const TITLES: Record<Stage, string> = {
  overview: 'A closer look at your card.',
  inputs: 'Let your fees go further.',
  review: 'Here’s what would happen.',
}

const DESCRIPTIONS: Record<Stage, string> = {
  overview: 'Your local practice position, all in one place.',
  inputs: 'Try reinvesting fees at a hypothetical network cost.',
  review: 'Review the amounts before saving this simulation.',
}

function Field({
  id,
  label,
  value,
  onChange,
  describedBy,
}: {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  describedBy?: string
}) {
  return (
    <div>
      <label htmlFor={id} className="text-[13px] text-fg-muted">
        {label}
      </label>
      <input
        id={id}
        value={value}
        inputMode="decimal"
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value)}
        className="tnum mt-1.5 w-full rounded-[var(--radius)] border bg-surface-1 px-3 py-2.5 font-mono text-[15px] outline-none focus:outline-2 focus:outline-offset-1 focus:outline-[var(--ring)]"
      />
    </div>
  )
}

export function PositionDetailFlow({
  position,
  index,
  onClose,
  saveBook,
}: {
  position: PracticePosition | null
  index: number
  onClose: () => void
  saveBook: (update: BookUpdate) => void
}) {
  const [stage, setStage] = useState<Stage>('overview')
  const [fees, setFees] = useState('0')
  const [gas, setGas] = useState('0.25')
  const [error, setError] = useState('')

  if (!position) return null

  const wellFormed = isMoney(fees) && isMoney(gas)

  // The core engine rejects values that are correctly formatted but out of the
  // range it supports. Keep its reason instead of discarding it, so the input
  // step can say what is wrong rather than letting the user reach an empty review.
  let estimate: CurrentCompoundDecision | null = null
  let rejection = ''
  if (wellFormed) {
    try {
      estimate = previewCompound({
        availableFeesUsd: (Number(position.reservesUsd) + Number(fees)).toFixed(6),
        positionValueUsd: (position.amount + Number(position.netAddedUsd)).toFixed(6),
        gasUsd: Number(gas).toFixed(6),
      })
    } catch (error) {
      estimate = null
      rejection = error instanceof Error && error.message ? error.message : 'This scenario is outside the supported range.'
    }
  }
  const valid = wellFormed && estimate !== null

  function close() {
    setStage('overview')
    setFees('0')
    setError('')
    onClose()
  }

  function toggle() {
    if (!position) return
    saveBook((prev) => ({
      ...prev,
      positions: prev.positions.map((p) =>
        p.id === position.id ? { ...p, enabled: !p.enabled } : p,
      ),
      events: [
        {
          id: crypto.randomUUID(),
          positionId: position.id,
          at: new Date().toISOString(),
          kind: position.enabled ? ('paused' as const) : ('resumed' as const),
        },
        ...prev.events,
      ].slice(0, 300),
    }))
  }

  function record() {
    if (!position) return
    try {
      saveBook((prev) =>
        runPracticeCompound(
          prev,
          position.id,
          Number(fees).toFixed(6),
          Number(gas).toFixed(6),
          crypto.randomUUID(),
          new Date().toISOString(),
        ),
      )
      close()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record this scenario.')
    }
  }

  const next = () => {
    if (stage === 'overview') return setStage('inputs')
    if (stage === 'inputs') return setStage('review')
    return record()
  }

  const nextLabel =
    stage === 'overview' ? 'Run a fee scenario' : stage === 'inputs' ? 'See the result' : 'Record it'

  const blocked = !position.enabled && stage !== 'overview'

  return (
    <StepDialog
      open
      onClose={close}
      eyebrow={`Practice card ${index + 1} · ${PAIR.label}`}
      title={TITLES[stage]}
      description={DESCRIPTIONS[stage]}
      step={stage === 'overview' ? 0 : stage === 'inputs' ? 1 : 2}
      onBack={() =>
        stage === 'overview' ? close() : setStage(stage === 'review' ? 'inputs' : 'overview')
      }
      backLabel={stage === 'overview' ? 'Close' : 'Back'}
      onNext={next}
      nextLabel={nextLabel}
      nextDisabled={
        (stage === 'overview' && !position.enabled) ||
        (stage === 'inputs' && !valid) ||
        (stage === 'review' && !estimate)
      }
      error={error || (blocked ? 'This card is paused. Go back to its overview to resume.' : '')}
    >
      {stage === 'overview' && (
        <>
          <div className="flex items-center justify-between gap-3">
            <PairHeading />
            <Pill tone={position.enabled ? 'in' : 'wait'}>
              {position.enabled ? 'Practice on' : 'Paused'}
            </Pill>
          </div>

          <div className="rounded-[var(--radius)] border bg-surface-1 p-4">
            <span className="text-[12px] text-fg-muted">Value at starting price</span>
            <p className="tnum mt-1 font-mono text-[28px] leading-none">
              {usd(position.amount + Number(position.netAddedUsd))}
            </p>
          </div>

          <Receipt
            rows={[
              { label: 'Price range', value: `${usd(position.lower)} – ${usd(position.upper)}` },
              { label: 'Hypothetical fees added', value: usd(Number(position.feesAddedUsd)) },
              { label: 'Reinvested so far', value: usd(Number(position.netAddedUsd)) },
              { label: 'Fees waiting', value: usd(Number(position.reservesUsd)) },
              { label: 'Service fees simulated', value: usd(Number(position.servicePaidUsd)) },
            ]}
          />

          <div className="flex items-center justify-between gap-4 rounded-[var(--radius)] border bg-surface-1 p-4">
            <div>
              <strong className="block text-[13px]">
                {position.enabled ? 'Practice is on' : 'Practice is paused'}
              </strong>
              <p className="mt-0.5 text-[12px] text-fg-subtle">
                Scenarios run only when you record them.
              </p>
            </div>
            <Button variant="outline" onClick={toggle}>
              {position.enabled ? 'Pause' : 'Resume'}
            </Button>
          </div>

          <p className="text-[12px] leading-relaxed text-fg-subtle">
            Pausing reinvestment does not remove liquidity or token exposure in a live position.
          </p>
        </>
      )}

      {stage === 'inputs' && (
        <>
          <Callout title={`${usd(Number(position.reservesUsd))} already waiting`}>
            Included automatically. Leave new fees at $0 to recheck this balance.
          </Callout>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="fees"
              label="New hypothetical fees ($)"
              value={fees}
              onChange={setFees}
              describedBy="fees-hint"
            />
            <Field id="gas" label="Network cost ($)" value={gas} onChange={setGas} />
          </div>

          <p id="fees-hint" className="text-[12px] leading-relaxed text-fg-subtle">
            New fees are added to the waiting balance. This is not a reinvestment limit.
          </p>

          {!wellFormed && (
            <p role="alert" className="text-[13px]" style={{ color: 'var(--money-out)' }}>
              Enter valid non-negative decimal amounts, with at most six decimal places.
            </p>
          )}
          {wellFormed && rejection && (
            <p role="alert" className="text-[13px]" style={{ color: 'var(--money-out)' }}>
              {rejection}
            </p>
          )}

          <p className="text-[12px] leading-relaxed text-fg-subtle">
            This check assumes balanced assets and a constant price. Live quotes, swaps and
            automatic execution are not available in practice.
          </p>
        </>
      )}

      {stage === 'review' && estimate && (
        <>
          <div>
            <Pill tone={estimate.decision === 'eligible' ? 'in' : 'wait'}>
              {estimate.decision === 'eligible' ? 'Cost check passed' : 'Wait for more fees'}
            </Pill>
            <p className="mt-2.5 text-[13px] leading-relaxed text-fg-muted">
              {estimate.decision === 'eligible'
                ? 'All usable fees go into this action. No fixed reserve.'
                : `This cost estimate needs at least ${usd(Number(estimate.minimumFeesUsd))} in usable fees.`}
            </p>
          </div>

          <Receipt
            rows={[
              { label: 'Previously waiting', value: usd(Number(position.reservesUsd)) },
              { label: 'New fees you added', value: `+ ${usd(Number(fees))}` },
              {
                label: 'Total available',
                value: usd(Number(estimate.availableFeesUsd)),
                total: true,
              },
              {
                label: `Service fee · 2% of ${usd(Number(estimate.consumedFeesUsd))}`,
                value: usd(Number(estimate.serviceFeeUsd)),
              },
              { label: 'Reinvested in this card', value: usd(Number(estimate.reinvestedUsd)) },
              { label: 'Left waiting', value: usd(Number(estimate.reserveUsd)) },
            ]}
          />

          <p className="text-[12px] leading-relaxed text-fg-subtle">
            {estimate.decision === 'eligible'
              ? 'The service fee covers the network cost. Waiting fees are charged only when used.'
              : 'Nothing is charged while waiting. These fees remain available for the next check.'}{' '}
            Exact amounts and the calculation appear in Activity.
          </p>
        </>
      )}
    </StepDialog>
  )
}
