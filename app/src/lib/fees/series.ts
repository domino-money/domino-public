/**
 * Cuts of a verified FeeHistory for the fees chart (DESIGN-V2 §13.2, §15.4):
 * a period's hours with the cumulative figures at its start, and buckets of
 * those hours. Token amounts only (bigint, raw units): nothing here values
 * anything in USD or in a quote token; that is the screens' (visual/value.ts).
 */
import type { FeeHistory, FeeHour } from './types'

export type FeesPeriod = '24h' | '7d' | '30d' | 'all'

const HOUR = 3_600
const DAY = 86_400

/** The length of each fixed period. */
export const PERIOD_SECONDS: Readonly<Record<Exclude<FeesPeriod, 'all'>, number>> = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY }

/** A period of the history: its time span, the cumulative figures at its start, and the hours that end inside it. */
export interface PeriodSlice {
  period: FeesPeriod
  /** Unix seconds: the period's start (the mint for `all`) and its end (the last hour's end). */
  start: number
  end: number
  /** Earned and collected since the mint, as of `start` (zero before the mint). */
  base: { earned: readonly [bigint, bigint]; collected: readonly [bigint, bigint] }
  hours: ReadonlyArray<FeeHour>
}

/** One bucket of hours: its span, the cumulative figures at its end, and what happened inside it. */
export interface FeeBucket {
  start: number
  end: number
  /** Earned since the mint, at the bucket's end. */
  earned: readonly [bigint, bigint]
  /** Earned within the bucket (never negative: earned only grows). */
  earnedIn: readonly [bigint, bigint]
  /** Settled (collected, or paid out with principal) within the bucket. */
  collectedIn: readonly [bigint, bigint]
  inRangeSeconds: number
  /** The seconds the bucket's hours cover. */
  seconds: number
}

const ZERO: readonly [bigint, bigint] = [0n, 0n]

/** How long the history runs, in seconds (mint to its last hour's end). */
export function historySpan(history: FeeHistory): number {
  const last = history.hourly[history.hourly.length - 1]
  return last ? Math.max(0, last.t - history.mintedAt.timestamp) : 0
}

/** The periods worth offering (§13.2): 24H and All always, 7D past 36 h of history, 30D past 8 days. */
export function periodsFor(history: FeeHistory): FeesPeriod[] {
  const span = historySpan(history)
  const out: FeesPeriod[] = ['24h']
  if (span > 36 * HOUR) out.push('7d')
  if (span > 8 * DAY) out.push('30d')
  out.push('all')
  return out
}

/** The period shown first (§13.2): All under 24 h of history, else 7D when offered, else 24H. */
export function defaultPeriodFor(history: FeeHistory): FeesPeriod {
  const span = historySpan(history)
  if (span < DAY) return 'all'
  return periodsFor(history).includes('7d') ? '7d' : '24h'
}

/** The bucket size of a period (§13.2): 24H hourly, 7D 6-hourly, 30D daily; All hourly to 48 h, 6-hourly to 14 days, daily to 90 days, weekly beyond. */
export function bucketSecondsFor(history: FeeHistory, period: FeesPeriod): number {
  if (period === '24h') return HOUR
  if (period === '7d') return 6 * HOUR
  if (period === '30d') return DAY
  const span = historySpan(history)
  if (span <= 48 * HOUR) return HOUR
  if (span <= 14 * DAY) return 6 * HOUR
  if (span <= 90 * DAY) return DAY
  return 7 * DAY
}

/** The hours of `period`, and the cumulative figures at its start. */
export function slicePeriod(history: FeeHistory, period: FeesPeriod): PeriodSlice {
  const hours = history.hourly
  const end = hours.length > 0 ? hours[hours.length - 1].t : history.mintedAt.timestamp
  const start = period === 'all' ? history.mintedAt.timestamp : Math.max(history.mintedAt.timestamp, end - PERIOD_SECONDS[period])
  let base: PeriodSlice['base'] = { earned: ZERO, collected: ZERO }
  for (const hour of hours) {
    if (hour.t > start) break
    base = { earned: hour.earned, collected: hour.collected }
  }
  return { period, start, end, base, hours: hours.filter((hour) => hour.t > start) }
}

/**
 * The slice's hours in buckets of `seconds`, aligned to multiples of it in
 * Unix time (UTC hours, days, weeks from 1970-01-05, a Monday, for weekly).
 * An hour belongs to the bucket its end falls in (an end exactly on a boundary
 * closes the bucket before it).
 */
export function bucketize(slice: PeriodSlice, seconds: number): FeeBucket[] {
  const offset = seconds === 7 * DAY ? 4 * DAY : 0
  const out: FeeBucket[] = []
  let earned = slice.base.earned
  let collected = slice.base.collected
  let previousT = slice.start
  for (const hour of slice.hours) {
    const index = Math.floor((hour.t - 1 - offset) / seconds)
    const bucketStart = index * seconds + offset
    let bucket = out[out.length - 1]
    if (!bucket || bucket.start !== bucketStart) {
      bucket = { start: bucketStart, end: bucketStart + seconds, earned, earnedIn: ZERO, collectedIn: ZERO, inRangeSeconds: 0, seconds: 0 }
      out.push(bucket)
    }
    const next: FeeBucket = {
      ...bucket,
      end: Math.min(bucketStart + seconds, slice.end),
      earned: hour.earned,
      earnedIn: [bucket.earnedIn[0] + hour.earned[0] - earned[0], bucket.earnedIn[1] + hour.earned[1] - earned[1]],
      collectedIn: [bucket.collectedIn[0] + hour.collected[0] - collected[0], bucket.collectedIn[1] + hour.collected[1] - collected[1]],
      inRangeSeconds: bucket.inRangeSeconds + hour.inRangeSeconds,
      seconds: bucket.seconds + Math.max(0, hour.t - previousT),
    }
    out[out.length - 1] = next
    earned = hour.earned
    collected = hour.collected
    previousT = hour.t
  }
  return out
}
