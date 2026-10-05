import type { CSSProperties, ReactNode } from 'react'
import { ArtTile } from '../home/Vignettes'
import { IconMinus, IconPlus } from '../icons'
import { cx } from '../ui'
import { fieldCheck } from '../../lib/automate/fieldCheck'
import type { SequenceForm } from '../../lib/create/sequenceDefaults'

/*
 * A limit, drawn around SequenceCreate's own labelled field (DESIGN-V2 §14.2,
 * automate.md §5.5.5). The field stays the one labelled control; what is added
 * is for a pointer only and hidden from assistive technology: a slider, a
 * stepper, preset chips (numbers only) and, for the number of positions, the
 * tiles. Every change goes through the creation's own `edit`, so the text in
 * the field is always what a person reads and what the review checks. A field
 * the creation would refuse gets a red ring and the creation's own reason.
 */

type Name = keyof SequenceForm
interface Shape {
  /** A slider from min to max (log: on a log scale), a − / + stepper, or neither. */
  kind: 'slider' | 'log' | 'stepper' | 'plain'
  min: number
  max: number
  step: number
  presets?: readonly string[]
}

const SHAPES: Record<Name, Shape> = {
  upsidePercent: { kind: 'log', min: 5, max: 300, step: 1, presets: ['25', '50', '100', '200'] },
  sequenceCap: { kind: 'stepper', min: 1, max: 255, step: 1 },
  triggerPercent: { kind: 'slider', min: 0, max: 20, step: 0.5 },
  maxOverlapPercent: { kind: 'slider', min: 0, max: 20, step: 0.5 },
  minimumIntervalMinutes: { kind: 'stepper', min: 1, max: 71582788, step: 1, presets: ['15', '60', '240', '1440'] },
  maxSlippagePercent: { kind: 'slider', min: 0, max: 5, step: 0.1 },
  maxPriceImpactPercent: { kind: 'slider', min: 0, max: 5, step: 0.1 },
  maxGasCostEth: { kind: 'plain', min: 0, max: 0, step: 0 },
  maxObservationAgeMinutes: { kind: 'stepper', min: 1, max: 71582788, step: 1 },
  forecastHorizonHours: { kind: 'stepper', min: 1, max: 1193046, step: 1, presets: ['24', '168', '720'] },
}

const SLIDER = 1000
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
/** A number as the field would hold it: whole, or with the step's decimals and no trailing zeros. */
const text = (value: number, step: number) => String(step >= 1 ? Math.round(value) : Math.round(value * 100) / 100)

function position(shape: Shape, value: number) {
  if (!Number.isFinite(value)) return 0
  if (shape.kind === 'log') return Math.round((Math.log(clamp(value, shape.min, shape.max) / shape.min) / Math.log(shape.max / shape.min)) * SLIDER)
  return Math.round(((clamp(value, shape.min, shape.max) - shape.min) / (shape.max - shape.min)) * SLIDER)
}

function valueAt(shape: Shape, at: number) {
  const share = at / SLIDER
  if (shape.kind === 'log') {
    const raw = shape.min * (shape.max / shape.min) ** share
    return String(raw < 10 ? Math.round(raw * 10) / 10 : Math.round(raw))
  }
  return text(shape.min + Math.round((share * (shape.max - shape.min)) / shape.step) * shape.step, shape.step)
}

/** The positions a sequence may hold, as tiles: the root solid, successors outlined, `+N` past twelve. New tiles pop in; none leave slowly. */
const PIPS: ReadonlyArray<readonly [number, number]> = [[3, 1], [1, 3], [2, 3], [3, 2], [0, 3], [3, 0], [2, 0], [0, 2]]
export function CapTiles({ cap }: { cap: number }) {
  const count = Number.isInteger(cap) && cap >= 1 ? Math.min(cap, 255) : 0
  const shown = Math.min(count, 12)
  return (
    <span className="dm-seq-caps" aria-hidden="true">
      {Array.from({ length: shown }, (_, index) => (
        <svg key={index} className={cx('dm-seq-cap', index === 0 && 'is-root')} width="0.875rem" height="1.53125rem" viewBox="0 0 14 24.5" focusable="false">
          <g className={index === 0 ? 'tile-solid' : 'tile-line'}>
            <ArtTile w={14} layout={PIPS[index % PIPS.length]} parts={index === 0 ? 'solid' : 'outline'} />
          </g>
        </svg>
      ))}
      {count > shown && <span className="dm-seq-caps-more">+{count - shown}</span>}
    </span>
  )
}

export function LimitControl({ name, value, onEdit, children }: { name: Name; value: string; onEdit: (value: string) => void; children: ReactNode }) {
  const shape = SHAPES[name]
  const reason = fieldCheck(name, value)
  const number = Number(value.trim())
  const at = position(shape, number)
  const step = (by: number) => onEdit(text(clamp((Number.isFinite(number) ? number : shape.min) + by, shape.min, shape.max), shape.step))
  return (
    <div className="dm-seq-limit" data-kind={shape.kind} data-invalid={reason ? '' : undefined}>
      {children}
      {(shape.kind === 'slider' || shape.kind === 'log') && (
        <input
          type="range"
          className="dm-seq-slider"
          name={`${name}-slider`}
          aria-hidden="true"
          tabIndex={-1}
          min={0}
          max={SLIDER}
          step={1}
          value={at}
          style={{ '--fill': `${at / (SLIDER / 100)}%` } as CSSProperties}
          onChange={(event) => onEdit(valueAt(shape, Number(event.target.value)))}
        />
      )}
      {(shape.kind === 'stepper' || shape.presets) && (
        <div className="dm-seq-limit-row" aria-hidden="true">
          {shape.kind === 'stepper' && (
            <span className="dm-seq-stepper">
              <button type="button" tabIndex={-1} disabled={number <= shape.min} onClick={() => step(-shape.step)}>
                <IconMinus />
              </button>
              <button type="button" tabIndex={-1} disabled={number >= shape.max} onClick={() => step(shape.step)}>
                <IconPlus />
              </button>
            </span>
          )}
          {name === 'sequenceCap' && <CapTiles cap={number} />}
          {shape.presets?.map((preset) => (
            <button key={preset} type="button" tabIndex={-1} className="dm-seq-preset" data-on={value.trim() === preset ? '' : undefined} onClick={() => onEdit(preset)}>
              {preset}
            </button>
          ))}
        </div>
      )}
      {reason && <p className="dm-seq-limit-why">{reason}</p>}
    </div>
  )
}
