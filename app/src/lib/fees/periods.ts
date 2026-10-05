/**
 * The Fees earned chart's periods, 24H, 7D, 30D and All (restored on purpose 2026-10-02, the owner: "the chart had 24
 * hours, 7 days and all; that went missing"): which are offered, which one a card opens on, and where each one starts.
 *
 * A period starts at a MEASURED point, never at an estimate (the chart has measured points only, lib/fees/ledger.ts):
 * the measured point nearest its nominal start (now less 24 hours, 7 days or 30 days) inside its window, or the opened
 * point when the nominal start is at or before the mint. When the history has none there, a read of the position at a
 * past block gives one (lib/fees/pastReads.ts); until then the period has no start, and nothing is drawn for it.
 *
 * Your APR's last 24 hours start at the same point (lib/positionApr.ts), so the card's 24H and the tile's line agree.
 * Pure and Node-safe.
 */
import type { FeeHistory, FeePoint } from './types'

export type FeesPeriod = '24h' | '7d' | '30d' | 'all'
export type TimedPeriod = Exclude<FeesPeriod, 'all'>

const HOUR = 3_600
const DAY = 86_400

export interface PeriodRule {
  /** The period's length. */
  seconds: number
  /** How old (seconds before now) its start point may be, at the least and at the most. */
  window: { min: number; max: number }
  /** The block grid a past read for it is made on (about an hour, six hours and a day of blocks). */
  grid: number
}

export const PERIODS: Readonly<Record<TimedPeriod, PeriodRule>> = {
  '24h': { seconds: DAY, window: { min: 20 * HOUR, max: 28 * HOUR }, grid: 36_000 },
  '7d': { seconds: 7 * DAY, window: { min: 6.5 * DAY, max: 7.5 * DAY }, grid: 216_000 },
  '30d': { seconds: 30 * DAY, window: { min: 29 * DAY, max: 31.5 * DAY }, grid: 864_000 },
}

/**
 * 24H and 7D stay visible for new positions too: each starts at the mint, never before it. 30D joins after 8 days.
 * `on` false retains the fallback for callers with no measured period starts and no past-read route.
 */
export function periodsFor(span: number, on: boolean): FeesPeriod[] {
  if (!on) return ['all']
  const out: FeesPeriod[] = ['24h', '7d']
  if (span > 8 * DAY) out.push('30d')
  out.push('all')
  return out
}

/** The period a card opens on: All under a day of history, else 7D when offered, else 24H. */
export function defaultPeriodFor(span: number): FeesPeriod {
  if (span < DAY) return 'all'
  return span > 36 * HOUR ? '7d' : '24h'
}

/** The history's opened point (the mint, nothing earned), or null when it has none. */
export function openedOf(history: Pick<FeeHistory, 'points'>): FeePoint | null {
  return history.points.find((point) => point.kind === 'opened') ?? null
}

/**
 * Where `period` starts in `history`: the opened point for All and for a period that reaches back to the mint; else the
 * measured point (never now) nearest its nominal start inside its window; null when the history has none there.
 */
export function periodStart(history: Pick<FeeHistory, 'points' | 'mintedAt'>, period: FeesPeriod): FeePoint | null {
  const points = history.points
  if (points.length === 0) return null
  const opened = openedOf(history)
  if (period === 'all') return opened
  const end = points[points.length - 1].t
  const rule = PERIODS[period]
  if (end - rule.seconds <= history.mintedAt.timestamp) return opened
  const age = (point: FeePoint) => end - point.t
  const near = points
    .filter((point) => point.kind !== 'now' && age(point) >= rule.window.min && age(point) <= rule.window.max)
    .sort((a, b) => Math.abs(age(a) - rule.seconds) - Math.abs(age(b) - rule.seconds) || a.block - b.block)
  return near[0] ?? null
}
