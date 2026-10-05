import { useState } from 'react'
import { SlippagePresets } from '../../components/create/SlippagePresets'
import { slippageBpsFrom, slippageFromPercent, slippagePercent } from '../../lib/create/slippage'
import { HIGH_SLIPPAGE_COPY, POSITION_SLIPPAGE_WARN_ABOVE_BPS } from './constants'
import { COPY } from './copy'

/**
 * The slippage tolerance of a position action, in the page's own look (components/create/SlippageChoice.tsx: the
 * presets as buttons and a box for an exact percentage, the same classes and the same bound, 0.1% to 5%), with
 * decision #2's warning: above 2%, "High slippage: you may receive noticeably less than quoted." `bps` is the kept text
 * (whole basis points, or '' once something outside the bound was typed), so the dialog never carries a value it cannot send.
 */
export function Slippage({ id, bps, onChange, disabled }: { id: string; bps: string; onChange: (text: string) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState<{ bps: string; text: string } | null>(null)
  const value = slippageBpsFrom(bps)
  const typed = draft?.bps === bps ? draft.text : value === null ? '' : slippagePercent(value)
  const exactId = `${id}-exact`
  const errorId = `${id}-error`
  const warningId = `${id}-warning`
  const choose = (next: number) => {
    setDraft(null)
    onChange(String(next))
  }
  const type = (text: string) => {
    const next = slippageFromPercent(text)
    setDraft({ bps: next === null ? '' : String(next), text })
    onChange(next === null ? '' : String(next))
  }
  const warns = value !== null && value > POSITION_SLIPPAGE_WARN_ABOVE_BPS
  return (
    <div className="dm-acct-lf dm-slip-choice" data-slippage-choice="" data-slippage-bps={value ?? ''}>
      <span className="dm-label" id={`${id}-label`}>
        {COPY.form.slippage}
      </span>
      <SlippagePresets value={value} onChoose={choose} disabled={disabled} label={`${COPY.form.slippage}: ${COPY.form.slippagePresets.toLowerCase()}`} />
      <label className="dm-label dm-acct-lf" htmlFor={exactId}>
        {COPY.form.slippageExact}
        <input
          id={exactId}
          className="dm-field dm-acct-mono-field"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          value={typed}
          aria-invalid={value === null ? true : undefined}
          aria-describedby={value === null ? errorId : warns ? warningId : undefined}
          onChange={(event) => type(event.target.value)}
        />
      </label>
      {value === null && (
        <p id={errorId} role="alert" className="dm-error">
          {COPY.form.slippageInvalid}
        </p>
      )}
      {warns && (
        <p id={warningId} role="status" className="dm-hint" data-slippage-warning="">
          {HIGH_SLIPPAGE_COPY}
        </p>
      )}
    </div>
  )
}
