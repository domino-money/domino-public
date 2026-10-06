import { useState } from 'react'
import { CREATE } from '../../lib/create/copy'
import { slippageBpsFrom, slippageFromPercent, slippagePercent, slippageWarns } from '../../lib/create/slippage'
import { SlippagePresets } from './SlippagePresets'

/**
 * The slippage limit as a compact choice, for Setup's deposit draft and its
 * balancing swap: the presets as buttons and a box for an exact percentage
 * between them, over the same bound as New position's slider
 * (SlippageSlider.tsx, create/slippage.ts). `bps` is the form's kept text,
 * whole basis points, or '' once something outside the bound was typed, so a
 * form never carries a number it cannot send: `onChange` gets the basis
 * points of a valid choice and '' for anything else, and the reason stays on
 * the box. Above 2% a line warns (create/slippage.ts SLIPPAGE_WARN_ABOVE_BPS;
 * Changed on purpose 2026-10-06, the owner's point 4: one rule and one
 * sentence everywhere, here too: Setup, its swap and V1's Close position).
 */
export function SlippageChoice({ id, label, bps, onChange, disabled }: { id: string; label: string; bps: string; onChange: (text: string) => void; disabled?: boolean }) {
  // The percentage while it is being typed, against the value it was typed
  // for, so the box keeps its text until the kept value moves under it.
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

  const warns = value !== null && slippageWarns(value)
  return (
    <div className="dm-acct-lf dm-slip-choice" data-slippage-choice="" data-slippage-bps={value ?? ''}>
      <span className="dm-label" id={`${id}-label`}>
        {label}
      </span>
      <SlippagePresets value={value} onChoose={choose} disabled={disabled} label={`${label}: ${CREATE.amount.slippagePresets.toLowerCase()}`} />
      <label className="dm-label dm-acct-lf" htmlFor={exactId}>
        {CREATE.amount.slippageExact}
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
          {CREATE.amount.slippageExactInvalid}
        </p>
      )}
      {warns && (
        <p id={warningId} role="status" className="dm-hint" data-slippage-warning="">
          {CREATE.amount.slippageWarning}
        </p>
      )}
    </div>
  )
}
