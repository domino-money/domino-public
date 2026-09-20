import { useState } from 'react'
import { CREATE } from '../../lib/create/copy'
import {
  SLIPPAGE_MARKS,
  SLIPPAGE_STEPS,
  slippageFromPercent,
  slippageIndex,
  slippageMark,
  slippagePercent,
  slippageValue,
  slippageWritten,
} from '../../lib/create/slippage'
import { TextField } from './fields'

/**
 * The slippage tolerance, dragged: the percentage in full size over a track
 * marked at 0.1%, 0.5% and 1%, and a box under it for a percentage between
 * the marks. What is kept is still whole basis points; the percentage is only
 * how it is chosen and written (create/slippage.ts).
 *
 * The native range input carries the position, so the pointer, the keyboard
 * and assistive technology all drive the same control; the track, the marks
 * and the thumb under it only draw where that position is.
 */
export function SlippageSlider({ bps, onSlippage }: { bps: string; onSlippage: (text: string) => void }) {
  // The percentage while it is being typed, against the value it was typed
  // for, so the box keeps its text until the kept value moves under it.
  const [draft, setDraft] = useState<{ bps: string; text: string } | null>(null)
  const value = slippageValue(bps)
  const typed = draft?.bps === bps ? draft.text : slippagePercent(value)
  const exact = slippageFromPercent(typed)
  const last = SLIPPAGE_STEPS.length - 1
  const at = (position: number) => `${(position * 100) / last}%`

  const change = (next: number) => {
    setDraft(null)
    onSlippage(String(next))
  }

  const type = (text: string) => {
    const next = slippageFromPercent(text)
    setDraft({ bps: next === null ? bps : String(next), text })
    if (next !== null) onSlippage(String(next))
  }

  return (
    <div className="dm-flow-slip" data-slippage={value}>
      <div className="dm-flow-slip-head">
        <label htmlFor="create-slippage" className="dm-label">
          {CREATE.amount.slippageLabel}
        </label>
        <span className="dm-flow-slip-value tnum" data-slippage-percent="">
          {slippageWritten(value)}
        </span>
      </div>
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
      <TextField
        id="create-slippage-exact"
        className="dm-flow-slip-exact"
        label={CREATE.amount.slippageExact}
        inputMode="decimal"
        value={typed}
        onChange={(event) => type(event.target.value)}
        hint={CREATE.amount.slippageHint}
        error={exact === null ? CREATE.amount.slippageExactInvalid : null}
        trailing="%"
      />
    </div>
  )
}
