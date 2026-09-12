import { times } from '../lib/scenario'

/**
 * A price control you can actually grab.
 *
 * A native range input sits invisibly over the whole track, so clicking or
 * dragging anywhere on it works, the keyboard works and screen readers get a
 * real slider. The visuals underneath follow its value: a wide track, the
 * active range shaded, and a large thumb with the price written on it as a
 * multiple of the start price.
 */
export function PriceSlider({
  id,
  label,
  min,
  max,
  step = 0.01,
  value,
  onChange,
  lower,
  upper,
  format = times,
  valueText,
}: {
  id: string
  label: string
  min: number
  max: number
  step?: number
  value: number
  onChange: (v: number) => void
  lower?: number
  upper?: number
  /** How a position on the track reads. Multiples of the start price by default; a pool screen passes its own price. */
  format?: (v: number) => string
  /** What a screen reader says for the current value, when the written figure alone would not be enough. */
  valueText?: (v: number) => string
}) {
  const pct = (v: number) => ((v - min) / (max - min)) * 100
  const inside = lower !== undefined && upper !== undefined && value >= lower && value < upper

  return (
    <div className="relative select-none py-3">
      <div className="relative h-3 rounded-full bg-surface-3">
        {lower !== undefined && upper !== undefined && (
          <div
            className="absolute inset-y-0 rounded-full"
            style={{
              left: `${pct(lower)}%`,
              width: `${pct(upper) - pct(lower)}%`,
              background: 'var(--accent)',
              boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--primary) 45%, transparent)',
            }}
          />
        )}
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${pct(value)}%`, background: 'var(--primary)', opacity: 0.35 }}
        />
      </div>

      {/* thumb */}
      <div
        className="pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
        style={{ left: `${pct(value)}%` }}
      >
        <div
          className="flex h-8 items-center justify-center rounded-[var(--radius-pill)] border-2 bg-surface-2 px-2.5 font-mono text-[12px] shadow-[0_4px_16px_-4px_rgba(0,0,0,0.45)]"
          style={{ borderColor: inside || lower === undefined ? 'var(--primary)' : 'var(--money-wait)' }}
        >
          <span className="tnum">{format(value)}</span>
        </div>
      </div>

      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        // The raw value can be a tick, which says nothing out loud. A screen
        // that knows what its numbers mean passes the words for them.
        aria-valuetext={valueText ? valueText(value) : undefined}
        className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0"
      />

      <div className="mt-2 flex justify-between font-mono text-[11px] text-fg-subtle">
        <span>{format(min)}</span>
        <span>{format(max)}</span>
      </div>
    </div>
  )
}
