import { times } from '../lib/scenario'

/**
 * A price control you can actually grab.
 *
 * A native range input sits invisibly over the whole control, so clicking or
 * dragging anywhere on it works, the keyboard works and screen readers get a
 * real slider. The visuals underneath follow its value: a slim track, the
 * active range shaded, and a thumb with the value written on it (a multiple of
 * the start price by default). The thumb is the first `.pointer-events-none`
 * element here and carries its position as `style.left`; when the input has
 * keyboard focus, the thumb shows the focus ring.
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
  const band = lower !== undefined && upper !== undefined
  // Both edges count as the band's own, so a range's Min and Max handles, each on its edge, look the same.
  const inside = band && value >= lower && value <= upper
  // Inside the range (or with no range drawn) the thumb's ring is the informational Tangerine; outside it, a neutral line.
  const ring = inside || !band ? 'var(--primary-ink)' : 'var(--fg-faint)'

  return (
    <div className="relative select-none pb-1 pt-4">
      <div className="relative h-1.5 rounded-[var(--radius-pill)] bg-surface-3">
        {band && (
          <div
            className="absolute inset-y-0 rounded-[var(--radius-pill)] transition-[left,width] duration-300 ease-enter"
            style={{
              left: `${pct(lower)}%`,
              width: `${pct(upper) - pct(lower)}%`,
              background: 'color-mix(in srgb, var(--primary-ink) 55%, transparent)',
            }}
          />
        )}
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
        className="peer absolute inset-0 h-full w-full cursor-ew-resize opacity-0"
      />

      {/* thumb */}
      <div
        className="pointer-events-none absolute top-[19px] flex h-7 -translate-x-1/2 -translate-y-1/2 items-center whitespace-nowrap rounded-[var(--radius-pill)] bg-surface-2 px-2.5 text-caption font-medium text-fg peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--ring)]"
        style={{ left: `${pct(value)}%`, boxShadow: `var(--elev-button), inset 0 0 0 1.5px ${ring}` }}
      >
        <span className="tnum">{format(value)}</span>
      </div>

      <div className="mt-5 flex justify-between text-caption text-fg-subtle">
        <span className="tnum">{format(min)}</span>
        <span className="tnum">{format(max)}</span>
      </div>
    </div>
  )
}
