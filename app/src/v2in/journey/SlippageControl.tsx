import { useState } from 'react'
import { SlippagePresets } from '../../components/create/SlippagePresets'
import { CREATE } from '../../lib/create/copy'
import { SLIPPAGE_MARKS, SLIPPAGE_STEPS, slippageBpsFrom, slippageFromPercent, slippageIndex, slippageMark, slippagePercent, slippageValue, slippageWritten } from '../../lib/create/slippage'
import { JOURNEY_HIGH_SLIPPAGE_COPY, JOURNEY_SLIPPAGE_WARNING_ABOVE_BPS } from './constants'

/**
 * The slippage tolerance on Domino's new contracts, in today's control (components/create/SlippageSlider.tsx: the presets,
 * the track and the exact box, one value in whole basis points, 0.1% to 5%), with the owner's decision #2 for the zap:
 * 0.5% by default, and above 2% the proposed warning, "High slippage: you may receive noticeably less than quoted."
 *
 * Changed on purpose 2026-10-30 (QA round 2, N28, as today's control): a percentage the box refuses is kept as no
 * tolerance at all (''), so Continue holds with its reason (./model/state.ts canContinue) instead of going on with the
 * last good value unseen; the presets and the track keep drawing that last good value meanwhile. On a wide screen the
 * track is not drawn (N103, styles/v4-newposition.css: the presets and the box only); a phone keeps it.
 */
export function SlippageControl({ bps, onSlippage }: { bps: string; onSlippage: (text: string) => void }) {
  // The percentage while it is being typed, against the value it was typed for, and the last good value, which the
  // presets and the track go on drawing.
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
  const hintId = 'zap-slippage-exact-hint'
  const errorId = 'zap-slippage-exact-error'
  return (
    <div className="dm-flow-slip" data-slippage={value}>
      <div className="dm-flow-slip-head">
        <label htmlFor="zap-slippage" className="dm-label">
          {CREATE.amount.slippageLabel}
        </label>
        <span className="dm-flow-slip-value dm-fig-sm" data-slippage-percent="">
          {kept === null ? CREATE.page.notChosen : slippageWritten(kept)}
        </span>
      </div>
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
            id="zap-slippage"
            type="range"
            className="dm-flow-slip-input"
            min={0}
            max={last}
            step={1}
            value={slippageIndex(value)}
            aria-valuetext={slippageWritten(value)}
            onChange={(event) => change(SLIPPAGE_STEPS[Number(event.target.value)])}
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
          <label htmlFor="zap-slippage-exact" className="dm-flow-slip-exact-label">
            {CREATE.amount.slippageExact}
          </label>
          <div className="dm-flow-input" data-invalid={exact === null ? '' : undefined}>
            <input
              id="zap-slippage-exact"
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
      {kept !== null && kept > JOURNEY_SLIPPAGE_WARNING_ABOVE_BPS && (
        <p role="status" className="dm-flow-slip-warn" data-slippage-warning="">
          {JOURNEY_HIGH_SLIPPAGE_COPY}
        </p>
      )}
    </div>
  )
}
