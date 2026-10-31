import { useState } from 'react'
import { CREATE } from '../../lib/create/copy'
import {
  SLIPPAGE_MARKS,
  SLIPPAGE_STEPS,
  slippageFromPercent,
  slippageIndex,
  slippageBpsFrom,
  slippageMark,
  slippagePercent,
  slippageValue,
  slippageWarns,
  slippageWritten,
} from '../../lib/create/slippage'
import { SlippagePresets } from './SlippagePresets'

/**
 * The slippage tolerance, chosen three ways that keep one value: the presets
 * as buttons, a track marked at the same 0.1%, 0.5% and 1%, and a box for a
 * percentage between the marks, on one line where the step is wide enough
 * (flow.css stacks them otherwise), with the percentage itself at the head.
 * Above 2% a line warns (2026-10-06, one rule everywhere). What is kept is still whole
 * basis points; the percentage is only how it is chosen and written
 * (create/slippage.ts).
 *
 * The native range input carries the position, so the pointer, the keyboard
 * and assistive technology all drive the same control; the track, the marks
 * and the thumb under it only draw where that position is. On a wide screen
 * the track is not drawn (QA round 2, N103: the approved desktop board has
 * the presets and the box only; styles/v4-newposition.css); a phone keeps it.
 *
 * Changed on purpose 2026-10-30 (QA round 2, N28): a percentage the box
 * refuses is kept as no tolerance at all (''), as Setup's control does
 * (SlippageChoice.tsx), so Continue holds with its reason instead of going on
 * with the last good value unseen. The presets and the track keep drawing that
 * last good value meanwhile.
 */
export function SlippageSlider({ bps, onSlippage }: { bps: string; onSlippage: (text: string) => void }) {
  // The percentage while it is being typed, against the value it was typed
  // for, so the box keeps its text until the kept value moves under it; and
  // the last good value, which the presets and the track go on drawing.
  const [draft, setDraft] = useState<{ bps: string; text: string; last: number } | null>(null)
  const kept = slippageBpsFrom(bps)
  const value = kept ?? (draft?.bps === bps ? draft.last : slippageValue(bps))
  const typed = draft?.bps === bps ? draft.text : kept === null ? '' : slippagePercent(kept)
  const exact = slippageFromPercent(typed)
  const last = SLIPPAGE_STEPS.length - 1
  const at = (position: number) => `${(position * 100) / last}%`

  const change = (next: number) => {
    setDraft(null)
    onSlippage(String(next))
  }

  const type = (text: string) => {
    const next = slippageFromPercent(text)
    const nextBps = next === null ? '' : String(next)
    setDraft({ bps: nextBps, text, last: next ?? value })
    onSlippage(nextBps)
  }

  const hintId = 'create-slippage-exact-hint'
  const errorId = 'create-slippage-exact-error'
  return (
    <div className="dm-flow-slip" data-slippage={value}>
      <div className="dm-flow-slip-head">
        <label htmlFor="create-slippage" className="dm-label">
          {CREATE.amount.slippageLabel}
        </label>
        <span className="dm-flow-slip-value dm-fig-sm" data-slippage-percent="">
          {kept === null ? CREATE.page.notChosen : slippageWritten(kept)}
        </span>
      </div>
      {/* One line on a wide step: the presets, the track between them and the exact box; stacked on a phone. */}
      <div className="dm-flow-slip-line">
        <SlippagePresets value={kept} onChoose={change} label={CREATE.amount.slippagePresets} />
        <div className="dm-flow-slip-rail">
          <span aria-hidden="true" className="dm-flow-slip-track">
            <span className="dm-flow-slip-fill" style={{ width: at(slippageIndex(value)) }} />
            {SLIPPAGE_MARKS.map((mark) => (
              <span key={mark} className="dm-flow-slip-mark" data-taken={mark === value ? '' : undefined} style={{ left: at(slippageIndex(mark)) }} />
            ))}
          </span>
          <input
            id="create-slippage"
            type="range"
            className="dm-flow-slip-input"
            min={0}
            max={last}
            step={1}
            value={slippageIndex(value)}
            // The position says nothing out loud, so the percentage behind it does.
            aria-valuetext={slippageWritten(value)}
            onChange={(event) => change(SLIPPAGE_STEPS[Number(event.target.value)])}
            // A mark is taken when the pointer is let go beside it. Snapping on
            // every change would hold the keyboard at a mark it steps away from.
            onPointerUp={() => {
              const mark = slippageMark(value)
              if (mark !== null) change(mark)
            }}
          />
          <span aria-hidden="true" className="dm-flow-slip-thumb" style={{ left: at(slippageIndex(value)) }} />
          <span aria-hidden="true" className="dm-flow-slip-scale">
            {SLIPPAGE_MARKS.map((mark) => (
              <span key={mark} style={{ left: at(slippageIndex(mark)) }}>
                {slippageWritten(mark)}
              </span>
            ))}
            <span className="dm-flow-slip-end">{slippageWritten(SLIPPAGE_STEPS[last])}</span>
          </span>
        </div>
        <div className="dm-flow-slip-exact">
          <label htmlFor="create-slippage-exact" className="dm-flow-slip-exact-label">
            {CREATE.amount.slippageExact}
          </label>
          <div className="dm-flow-input" data-invalid={exact === null ? '' : undefined}>
            <input
              id="create-slippage-exact"
              inputMode="decimal"
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              aria-invalid={exact === null ? true : undefined}
              aria-describedby={exact === null ? `${hintId} ${errorId}` : hintId}
              className="dm-flow-input-control tnum"
              value={typed}
              onChange={(event) => type(event.target.value)}
            />
            <span aria-hidden="true" className="dm-flow-input-unit">
              %
            </span>
          </div>
        </div>
      </div>
      <p id={hintId} className="dm-flow-slip-hint">
        {CREATE.amount.slippageHint}
      </p>
      {exact === null && (
        <p id={errorId} role="alert" className="dm-error">
          {CREATE.amount.slippageExactInvalid}
        </p>
      )}
      {kept !== null && slippageWarns(kept) && (
        <p role="status" className="dm-flow-slip-warn" data-slippage-warning="">
          {CREATE.amount.slippageWarning}
        </p>
      )}
    </div>
  )
}
