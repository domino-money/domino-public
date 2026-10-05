import type { CSSProperties, ReactNode } from 'react'
import { ArtTile } from '../home/Vignettes'
import { cx } from '../ui'
import { CREATE } from '../../lib/create/copy'
import { rem } from '../../lib/rootScale'
import type { SequenceForm } from '../../lib/create/sequenceDefaults'
import { signedPercent, successorPlan, type SuccessorPlan } from '../../lib/automate/successor'
import type { AxisRoot } from './types'

/*
 * The live successor axis (DESIGN-V2 §14.2, automate.md §5.5.5): the root
 * position and the next ranges the chain will accept, on a log-price axis
 * relative to the root's ceiling (0%), redrawn as the limits change. Root
 * band solid, successors outlined and fading, each successor's allowed floor
 * zone hatched, the trigger dashed. Everything is placed in percentages of the
 * axis's width, so nothing is measured; bands move by clip-path and markers by
 * translate (never width or left), and first arrive 60 ms apart.
 *
 * The drawing is decoration (aria-hidden) beside the labelled limits; its
 * legend of trigger, floor and ceiling went with the owner's simpler page
 * (2026-09-24), and how successors are placed is on the docs page. Only a
 * geometry the tick spacing cannot hold is said in words. Domino-compound only: an
 * Auto-compound position has no successor, and its root band alone would put
 * an unexplained negative percentage beside the choices.
 */

/**
 * The plot's height and its axis line; each successor stands RISE higher than the one before. Design px, written in rem
 * (changed on purpose 2026-10-03, lib/rootScale.ts); the 1px inset of a band's fill stays a hairline.
 */
const H = 160
const BASE = 132
const BAND = 28
const RISE = 18
const PAD = 5

/** One band as two clipped layers (its line, then its fill inset by 1 px), so corners and hatching never stretch. */
function Band({ kind, from, to, top, index, children }: { kind: 'root' | 'next' | 'zone'; from: number; to: number; top: number; index: number; children?: ReactNode }) {
  const clip = (inset: number) => ({ clipPath: `inset(calc(${rem(top)} + ${inset}px) calc(${100 - to}% + ${inset}px) calc(${rem(H - top - BAND)} + ${inset}px) calc(${from}% + ${inset}px) round calc(${rem(6)} - ${inset}px))` })
  return (
    <div className="dm-axis-band" data-kind={kind} style={{ '--i': index } as CSSProperties}>
      {kind !== 'zone' && <div className="dm-axis-line" style={clip(0)} />}
      <div className="dm-axis-fill" style={clip(kind === 'zone' ? 0 : 1)}>
        {children}
      </div>
    </div>
  )
}

/** A full-width layer moved by translate: whatever it holds stands at `at`% of the axis. */
function At({ at, top, index, className, children }: { at: number; top: number; index: number; className?: string; children: ReactNode }) {
  return (
    <div className={cx('dm-axis-at', className)} style={{ top: rem(top), translate: `${at}% 0`, '--i': index } as CSSProperties}>
      {children}
    </div>
  )
}

function Tile({ solid, layout }: { solid: boolean; layout: readonly [number, number] }) {
  return (
    <svg className={cx('dm-axis-tile', solid && 'tile-solid')} width="0.875rem" height="1.53125rem" viewBox="0 0 14 24.5" focusable="false">
      <ArtTile w={14} layout={layout} parts={solid ? 'solid' : 'outline'} />
    </svg>
  )
}

const LAYOUTS: ReadonlyArray<readonly [number, number]> = [[1, 3], [2, 3], [0, 3]]

function numbers(form: SequenceForm) {
  const read = (text: string) => (/^\d+(\.\d+)?$/.test(text.trim()) ? Number(text.trim()) : Number.NaN)
  return { upside: read(form.upsidePercent), overlap: read(form.maxOverlapPercent), trigger: read(form.triggerPercent), cap: read(form.sequenceCap) }
}

export function SuccessorAxis({ root, inverse, form }: { root: AxisRoot; inverse: boolean; form: SequenceForm }) {
  const geometry = { lower: root.lower, upper: root.upper, spacing: root.spacing }
  const plan: SuccessorPlan | null = successorPlan(geometry, numbers(form), inverse) ?? successorPlan(geometry, { upside: 50, overlap: 0, trigger: 0, cap: 1 }, inverse)
  if (!plan) return null
  const live = plan.steps.length > 0 && plan.steps.every((step) => step.feasible)
  const steps = live ? plan.steps : []
  const width = steps.length ? steps[0].ceiling - steps[0].anchor : -plan.floor
  const lo = Math.max(plan.floor, -3 * width)
  const hi = steps.length ? steps[steps.length - 1].ceiling : -plan.floor * 0.28
  const x = (rel: number) => PAD + ((rel - lo) / (hi - lo || 1)) * (100 - 2 * PAD)
  const cut = plan.floor < lo
  type Label = { at: number; text: string; edge?: 'start' | 'end' }
  const ticks: Label[] = [
    { at: x(Math.max(plan.floor, lo)), text: cut ? `…${signedPercent(plan.floor)}` : signedPercent(plan.floor), edge: 'start' },
    { at: x(0), text: signedPercent(0) },
    ...steps.map((step): Label => ({ at: x(step.ceiling), text: signedPercent(step.ceiling) })),
  ]
  // Labels never collide: one near the right edge is right-aligned, and a label too close to the one before it is left out.
  const labels: Label[] = []
  for (const tick of ticks) {
    const label = tick.at > 86 ? { ...tick, edge: 'end' as const } : tick
    const last = labels[labels.length - 1]
    if (!last || label.at - last.at >= (label.edge === 'end' ? 30 : 20)) labels.push(label)
  }
  return (
    <div className="dm-seq-axis">
      <div className="dm-auto-chart-heading"><h3>How the next ranges line up</h3><span>Illustration of your settings</span></div>
      <div className="dm-axis-plot" aria-hidden="true">
        <div className="dm-axis-base" style={{ top: rem(BASE) }} />
        <Band kind="root" from={x(Math.max(plan.floor, lo))} to={x(0)} top={BASE - BAND} index={0}>
          <span className={cx('dm-axis-nft', cut && 'is-cut')} style={{ left: `calc(${x(Math.max(plan.floor, lo))}% + ${rem(10)})`, top: rem(BASE - BAND + 7) }}>
            #{root.tokenId}
          </span>
        </Band>
        {steps.map((step, index) => (
          <div key={index} className="dm-axis-step" style={{ opacity: [1, 0.62, 0.36][index] }}>
            {step.floorMin < step.anchor && <Band kind="zone" from={x(step.floorMin)} to={x(step.anchor)} top={BASE - BAND - RISE * (index + 1)} index={index + 1} />}
            <Band kind="next" from={x(step.anchor)} to={x(step.ceiling)} top={BASE - BAND - RISE * (index + 1)} index={index + 1} />
            <At at={x(step.ceiling)} top={BASE - BAND - RISE * (index + 1) - 24.5} index={index + 1} className="dm-axis-tile-at">
              <Tile solid={false} layout={LAYOUTS[index]} />
            </At>
          </div>
        ))}
        <At at={x(0)} top={BASE - BAND - 24.5} index={0} className="dm-axis-tile-at">
          <Tile solid layout={[3, 1]} />
        </At>
        {live && (
          <At at={x(plan.trigger)} top={12} index={1} className="dm-axis-trigger">
            <span />
          </At>
        )}
        {labels.map((label) => (
          <At key={label.text} at={label.at} top={BASE + 6} index={0} className="dm-axis-tick">
            <span data-edge={label.edge}>{label.text}</span>
          </At>
        ))}
        {live && plan.more > 0 && <span className="dm-axis-more">+{plan.more}</span>}
      </div>
      <div className="dm-auto-chart-legend">
        <span><i data-kind="root" aria-hidden="true" />Your position</span>
        <span><i data-kind="next" aria-hidden="true" />Possible next ranges</span>
      </div>
      <p className="dm-auto-preview-note">Percentages are measured from the top of your current range. Earned fees can fund the next range when your limits allow.</p>
      {!live && plan.steps.some((step) => !step.feasible) && <p className="dm-axis-note">{CREATE.automation.infeasible}</p>}
    </div>
  )
}
