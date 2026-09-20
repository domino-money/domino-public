import { SLIPPAGE_PRESETS, slippageWritten } from '../../lib/create/slippage'

/**
 * The three presets as one row of buttons, 0.1%, 0.5% and 1%, with the one
 * taken pressed. Shared by the amount step's slider (SlippageSlider.tsx) and
 * Setup's compact choice (SlippageChoice.tsx), so a preset means the same
 * basis points everywhere. Toggle buttons rather than radios: a value between
 * the presets, typed or dragged, leaves none pressed, which a radio group
 * cannot say.
 */
export function SlippagePresets({ value, onChoose, disabled, label }: { value: number | null; onChoose: (bps: number) => void; disabled?: boolean; label: string }) {
  return (
    <div className="dm-seg dm-slip-presets" role="group" aria-label={label} data-slippage-presets="">
      {SLIPPAGE_PRESETS.map((preset) => (
        <button key={preset} type="button" className="dm-seg-item tnum" aria-pressed={preset === value} disabled={disabled} data-slippage-preset={preset} onClick={() => onChoose(preset)}>
          {slippageWritten(preset)}
        </button>
      ))}
    </div>
  )
}
