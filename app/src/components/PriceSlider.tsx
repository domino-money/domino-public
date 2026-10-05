import { times } from '../lib/scenario'

/**
 * A price control you can actually grab (DESIGN-V2 §4.8).
 *
 * A native range input sits invisibly over the whole control, so clicking or
 * dragging anywhere on it works, the keyboard works and screen readers get a
 * real slider. The visuals underneath follow its value: a slim track, the
 * active range filled (`tone="quiet"` fills it at 55 %), a round thumb, and a
 * chip above it with the value written on it (a multiple of the start price by
 * default). The chip is the first `.pointer-events-none` element here and
 * carries its position as `style.left`; the thumb carries the ring (inside the
 * band Tangerine, outside it neutral) and, when the input has keyboard focus,
 * the focus ring. Hover and drag grow the thumb a little.
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
  tone = 'primary',
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
  /** primary: the band in full Tangerine (the Home simulator). quiet: at 55 % (a range's Min and Max cards). */
  tone?: 'primary' | 'quiet'
}) {
  const pct = (v: number) => ((v - min) / (max - min)) * 100
  const band = lower !== undefined && upper !== undefined
  // Both edges count as the band's own, so a range's Min and Max handles, each on its edge, look the same.
  const inside = band && value >= lower && value <= upper
  // Inside the range (or with no range drawn) the thumb's ring is the informational Tangerine; outside it, a neutral line.
  const ring = inside || !band ? 'var(--primary-ink)' : 'var(--fg-faint)'

  return (
    <div className="relative select-none pb-1 pt-[2.125rem]">
      <div className="relative h-1 rounded-[var(--radius-pill)] bg-surface-3">
        {band && (
          <div
            className="absolute inset-y-0 rounded-[var(--radius-pill)] bg-primary-line transition-[left,width] duration-[var(--dur-step)] ease-enter"
            style={{
              left: `${pct(lower)}%`,
              width: `${pct(upper) - pct(lower)}%`,
              opacity: tone === 'quiet' ? 0.55 : 1,
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

      {/* the value chip: the first .pointer-events-none here, placed by its inline left */}
      <div
        className="pointer-events-none absolute top-0 flex h-[1.375rem] -translate-x-1/2 items-center whitespace-nowrap rounded-[var(--radius-pill)] bg-surface-3 px-2 text-caption font-medium text-fg"
        style={{ left: `${pct(value)}%` }}
      >
        <span className="tnum">{format(value)}</span>
      </div>

      {/* thumb: never a .pointer-events-none element (the chip stays the only one), it lets pointers through by its own class */}
      <div
        className="dm-slider-thumb absolute top-[2.25rem] size-5 -translate-x-1/2 -translate-y-1/2 rounded-[var(--radius-pill)] bg-card transition-[scale] duration-[var(--dur-press)] peer-hover:scale-[1.12] peer-active:scale-[1.12] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--ring)]"
        style={{ left: `${pct(value)}%`, boxShadow: `inset 0 0 0 1.5px ${ring}, var(--elev-button)` }}
      />

      <div className="mt-5 flex justify-between text-caption text-fg-subtle">
        <span className="tnum">{format(min)}</span>
        <span className="tnum">{format(max)}</span>
      </div>
    </div>
  )
}
