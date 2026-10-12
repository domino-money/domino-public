/**
 * Date ticks for the positions charts: a UTC-aligned step (an hour to a
 * month) that gives at most `max` ticks inside the span, and at least three
 * when a finer step allows it (a lone date says little about a window),
 * labelled in the app's caption style: the time of day for steps under a
 * day, except at midnight, where the date says which day it is. Pure and
 * Node-safe.
 */
import { alignDown } from '../../../lib/chart/scale'
import { axisLabel } from '../../../lib/format/time'

const HOUR = 3_600
const DAY = 86_400
const STEPS = [60, 5 * 60, 15 * 60, 30 * 60, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 3 * DAY, 7 * DAY, 14 * DAY, 30 * DAY]
/** Fewer ticks than this read as a lone label; a finer step is taken while it keeps within one of `max`. */
const FEWEST = 3

function ticksAt(start: number, end: number, step: number): number[] {
  const out: number[] = []
  let t = alignDown(start, step)
  if (t <= start) t += step
  for (; t < end; t += step) out.push(t)
  return out
}

export function dateTicks(start: number, end: number, max: number): { t: number; label: string }[] {
  const span = end - start
  if (!(span > 0) || max < 1) return []
  let index = STEPS.findIndex((candidate) => span / candidate <= max)
  let step = index === -1 ? Math.ceil(span / max / (7 * DAY)) * 7 * DAY : STEPS[index]
  let ticks = ticksAt(start, end, step)
  while (index > 0 && ticks.length < FEWEST) {
    const finer = ticksAt(start, end, STEPS[index - 1])
    if (finer.length > max + 1) break
    index -= 1
    step = STEPS[index]
    ticks = finer
  }
  return ticks.map((t) => ({ t, label: axisLabel(t, step >= DAY || t % DAY === 0 ? 3 * DAY : 0) }))
}

/**
 * XAxis aligns labels near an edge instead of centring them. Keep actual label boxes apart after that alignment,
 * prioritising the first ("Opened", when present) and last labels. SVG design units scale with the chart's rem root.
 * The conservative width follows the axis font size, including the desktop workspace's larger 16-unit face,
 * without a measuring/re-rendering loop.
 */
export function spacedTimeTicks<T extends { x: number; label: string }>(ticks: readonly T[], left: number, right: number, fontSize = 12): T[] {
  if (ticks.length < 2) return [...ticks]
  const boxes = ticks.map((tick) => {
    const width = (tick.label.length * 7.5 + 4) * fontSize / 12
    const start = tick.x - left < 32 ? tick.x : right - tick.x < 32 ? tick.x - width : tick.x - width / 2
    return { tick, start, end: start + width }
  })
  const gap = 12
  const first = boxes[0]
  const last = boxes[boxes.length - 1]
  if (last.start - first.end < gap) return [first.tick]
  const kept = [first.tick]
  let edge = first.end
  for (const box of boxes.slice(1, -1)) {
    if (box.start - edge >= gap && last.start - box.end >= gap) {
      kept.push(box.tick)
      edge = box.end
    }
  }
  return [...kept, last.tick]
}
