/**
 * The fees module's figures (DESIGN-V2 §13): verified histories (lib/fees)
 * valued at one price per position (value.ts) and cut into the selected
 * period's hours, buckets, events and in-range stretches. One position or
 * several (the Positions list's aggregate, §13.7): several are summed per
 * hourly anchor, each at its own pool's price. Pure: bigint arithmetic in
 * these module helpers, plain numbers only for geometry. Nothing here invents
 * a figure; an hour a history does not have carries its last value forward.
 */
import type { FeeHistory, FeeDisplayState as PositionState } from '../../../lib/fees/types'
import { type Basis, unitsNumber, valueUnits } from './value'

export type FeesPeriod = '24h' | '7d' | '30d' | 'all'

const HOUR = 3_600
const DAY = 86_400
const PERIOD_SECONDS: Readonly<Record<Exclude<FeesPeriod, 'all'>, number>> = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY }
const ZERO: readonly [bigint, bigint] = [0n, 0n]

/** One verified position: its id, its history, the state it was verified at and the basis its values are in. */
export interface FeesSource {
  id: string
  state: PositionState
  history: FeeHistory
  basis: Basis
}

/** One hour of the (summed) history: cumulative values since the mint at the hour's end. */
interface Hour {
  anchor: number
  /** The hour's end, Unix seconds. */
  t: number
  earned: bigint
  collected: bigint
  /** Cumulative token amounts (one position, or several of one pair); null otherwise. */
  tokens: readonly [bigint, bigint] | null
  collectedTokens: readonly [bigint, bigint] | null
  inRange: number
  seconds: number
}

export interface FeesBucket {
  start: number
  end: number
  /** Cumulative earned value at the bucket's end. */
  earned: bigint
  earnedIn: bigint
  tokensIn: readonly [bigint, bigint] | null
  collectedIn: bigint
  collectedTokensIn: readonly [bigint, bigint] | null
  inRange: number
  seconds: number
}

export interface FeesEvent {
  id: string
  kind: 'mint' | 'collect' | 'increase' | 'decrease' | 'close'
  timestamp: number
  tx: string
  fees: readonly [bigint, bigint]
  value: bigint
  basis: Basis
  source: FeesSource
}

export interface FeesPeriodView {
  period: FeesPeriod
  start: number
  end: number
  bucketSeconds: number
  /** Cumulative earned value at the period's start, and at its end. */
  base: bigint
  last: bigint
  /** The hourly cumulative line, from (start, base): `v` everything earned, `c` the part of it collected by then (2026-09-27). */
  points: ReadonlyArray<{ t: number; v: number; c: number }>
  buckets: ReadonlyArray<FeesBucket>
  events: ReadonlyArray<{ t: number; v: number; kind: FeesEvent['kind']; tx: string }>
  strip: ReadonlyArray<{ t0: number; t1: number; inRange: boolean }>
}

export interface FeesView {
  sources: ReadonlyArray<FeesSource>
  /** The basis every summed value is in (the first source's; the aggregate is USD-only). */
  basis: Basis
  /** Token amounts can be summed: one position, or several of one pair. */
  sameTokens: boolean
  earned: bigint
  collected: bigint
  unclaimed: bigint
  earnedTokens: readonly [bigint, bigint] | null
  collectedTokens: readonly [bigint, bigint] | null
  unclaimedTokens: readonly [bigint, bigint] | null
  /** Earned since the mint is zero in every token of every position. */
  zero: boolean
  /** 0..1 over the whole history; null when no second held liquidity. */
  timeInRange: number | null
  span: number
  periods: ReadonlyArray<FeesPeriod>
  defaultPeriod: FeesPeriod
  /** Newest first. */
  events: ReadonlyArray<FeesEvent>
  hours: ReadonlyArray<Hour>
  mintedAt: number
  /** 2026-09-25 (review): the collected amounts are a price path's, within its rounding of the chain's (FeeHistory.near). */
  near: boolean
}

const add = (a: readonly [bigint, bigint], b: readonly [bigint, bigint]): readonly [bigint, bigint] => [a[0] + b[0], a[1] + b[1]]
const sub = (a: readonly [bigint, bigint], b: readonly [bigint, bigint]): readonly [bigint, bigint] => [a[0] - b[0], a[1] - b[1]]
const pairKey = (source: FeesSource) => `${source.state.currencies[0].address}:${source.state.currencies[1].address}`.toLowerCase()

/** The periods worth offering (§13.2): 24H and All always, 7D past 36 h of history, 30D past 8 days. */
export function periodsForSpan(span: number): FeesPeriod[] {
  const out: FeesPeriod[] = ['24h']
  if (span > 36 * HOUR) out.push('7d')
  if (span > 8 * DAY) out.push('30d')
  out.push('all')
  return out
}

/** All under 24 h of history, else 7D when offered, else 24H. */
export function defaultPeriodForSpan(span: number): FeesPeriod {
  if (span < DAY) return 'all'
  return span > 36 * HOUR ? '7d' : '24h'
}

/** 24H hourly, 7D 6-hourly, 30D daily; All hourly to 48 h, 6-hourly to 14 days, daily to 90 days, weekly beyond. */
export function bucketSecondsForSpan(span: number, period: FeesPeriod): number {
  if (period === '24h') return HOUR
  if (period === '7d') return 6 * HOUR
  if (period === '30d') return DAY
  if (span <= 48 * HOUR) return HOUR
  if (span <= 14 * DAY) return 6 * HOUR
  if (span <= 90 * DAY) return DAY
  return 7 * DAY
}

/** The summed hourly timeline: every anchor any history has, each history carrying its last hour forward. */
function timeline(sources: ReadonlyArray<FeesSource>, sameTokens: boolean): Hour[] {
  const anchors = [...new Set(sources.flatMap((source) => source.history.hourly.map((hour) => hour.anchor)))].sort((a, b) => a - b)
  const cursor = sources.map(() => -1)
  const previousT = sources.map((source) => source.history.mintedAt.timestamp)
  const out: Hour[] = []
  for (const anchor of anchors) {
    let t = 0
    let earned = 0n
    let collected = 0n
    let tokens: readonly [bigint, bigint] = ZERO
    let collectedTokens: readonly [bigint, bigint] = ZERO
    let inRange = 0
    let seconds = 0
    sources.forEach((source, index) => {
      const hourly = source.history.hourly
      const next = hourly[cursor[index] + 1]
      if (next && next.anchor === anchor) {
        cursor[index] += 1
        inRange += next.inRangeSeconds
        seconds += Math.max(0, next.t - previousT[index])
        previousT[index] = next.t
        t = Math.max(t, next.t)
      }
      const hour = hourly[cursor[index]]
      if (!hour) return
      earned += valueUnits(source.basis, hour.earned)
      collected += valueUnits(source.basis, hour.collected)
      tokens = add(tokens, hour.earned)
      collectedTokens = add(collectedTokens, hour.collected)
    })
    out.push({ anchor, t, earned, collected, tokens: sameTokens ? tokens : null, collectedTokens: sameTokens ? collectedTokens : null, inRange, seconds })
  }
  return out
}

/** The whole view of one or more verified histories. Null when there is nothing to show (no source). */
export function feesView(sources: ReadonlyArray<FeesSource>): FeesView | null {
  if (sources.length === 0) return null
  const sameTokens = new Set(sources.map(pairKey)).size === 1
  const hours = timeline(sources, sameTokens)
  let earnedTokens: readonly [bigint, bigint] = ZERO
  let collectedTokens: readonly [bigint, bigint] = ZERO
  let earned = 0n
  let collected = 0n
  let unclaimed = 0n
  let inSeconds = 0
  let totalSeconds = 0
  let zero = true
  const events: FeesEvent[] = []
  for (const source of sources) {
    const { history, state, basis } = source
    earnedTokens = add(earnedTokens, history.earned)
    collectedTokens = add(collectedTokens, history.collected)
    earned += valueUnits(basis, history.earned)
    collected += valueUnits(basis, history.collected)
    unclaimed += valueUnits(basis, state.unclaimed)
    inSeconds += history.timeInRange.inSeconds
    totalSeconds += history.timeInRange.totalSeconds
    if (history.earned[0] !== 0n || history.earned[1] !== 0n) zero = false
    for (const event of history.events) {
      // A collect that settled nothing (two share one transaction in 2310187) is no event to a person.
      if (event.kind === 'collect' && event.fees[0] === 0n && event.fees[1] === 0n) continue
      events.push({ id: source.id, kind: event.kind, timestamp: event.timestamp, tx: event.tx, fees: event.fees, value: valueUnits(basis, event.fees), basis, source })
    }
  }
  events.sort((a, b) => b.timestamp - a.timestamp)
  const mintedAt = Math.min(...sources.map((source) => source.history.mintedAt.timestamp))
  const end = hours.length > 0 ? hours[hours.length - 1].t : mintedAt
  const span = Math.max(0, end - mintedAt)
  const unclaimedTokens = sameTokens ? sources.reduce<readonly [bigint, bigint]>((sum, source) => add(sum, source.state.unclaimed), ZERO) : null
  return {
    sources,
    basis: sources[0].basis,
    sameTokens,
    earned,
    collected,
    unclaimed,
    earnedTokens: sameTokens ? earnedTokens : null,
    collectedTokens: sameTokens ? collectedTokens : null,
    unclaimedTokens,
    zero,
    timeInRange: totalSeconds > 0 ? inSeconds / totalSeconds : null,
    span,
    periods: periodsForSpan(span),
    defaultPeriod: defaultPeriodForSpan(span),
    events,
    hours,
    mintedAt,
    near: sources.some((source) => source.history.near === true),
  }
}

/** The value (and tokens) of the timeline at time `t`: the last hour ending at or before it, zero before the first. */
function at(hours: ReadonlyArray<Hour>, t: number): Hour | null {
  let found: Hour | null = null
  for (const hour of hours) {
    if (hour.t > t) break
    found = hour
  }
  return found
}

/** The period's line, buckets, events and in-range strip. */
export function periodView(view: FeesView, period: FeesPeriod): FeesPeriodView {
  const { hours } = view
  const end = hours.length > 0 ? hours[hours.length - 1].t : view.mintedAt
  const start = period === 'all' ? view.mintedAt : Math.max(view.mintedAt, end - PERIOD_SECONDS[period])
  const baseHour = at(hours, start)
  const base = baseHour?.earned ?? 0n
  const inPeriod = hours.filter((hour) => hour.t > start)
  const last = inPeriod.length > 0 ? inPeriod[inPeriod.length - 1].earned : base
  const bucketSeconds = bucketSecondsForSpan(view.span, period)

  // Buckets aligned to multiples of their size in UTC (weeks from a Monday); an hour belongs to the bucket its end falls in.
  const offset = bucketSeconds === 7 * DAY ? 4 * DAY : 0
  const buckets: FeesBucket[] = []
  let earned = base
  let collected = baseHour?.collected ?? 0n
  let tokens = baseHour?.tokens ?? (view.sameTokens ? ZERO : null)
  let collectedTokens = baseHour?.collectedTokens ?? (view.sameTokens ? ZERO : null)
  for (const hour of inPeriod) {
    const bucketStart = Math.floor((hour.t - 1 - offset) / bucketSeconds) * bucketSeconds + offset
    let bucket = buckets[buckets.length - 1]
    if (!bucket || bucket.start !== bucketStart) {
      bucket = { start: bucketStart, end: bucketStart + bucketSeconds, earned, earnedIn: 0n, tokensIn: tokens && ZERO, collectedIn: 0n, collectedTokensIn: collectedTokens && ZERO, inRange: 0, seconds: 0 }
      buckets.push(bucket)
    }
    buckets[buckets.length - 1] = {
      ...bucket,
      end: Math.min(bucketStart + bucketSeconds, end),
      earned: hour.earned,
      earnedIn: bucket.earnedIn + hour.earned - earned,
      tokensIn: bucket.tokensIn && tokens && hour.tokens ? add(bucket.tokensIn, sub(hour.tokens, tokens)) : null,
      collectedIn: bucket.collectedIn + hour.collected - collected,
      collectedTokensIn: bucket.collectedTokensIn && collectedTokens && hour.collectedTokens ? add(bucket.collectedTokensIn, sub(hour.collectedTokens, collectedTokens)) : null,
      inRange: bucket.inRange + hour.inRange,
      seconds: bucket.seconds + hour.seconds,
    }
    earned = hour.earned
    collected = hour.collected
    tokens = hour.tokens
    collectedTokens = hour.collectedTokens
  }
  if (buckets.length > 0) buckets[0] = { ...buckets[0], start: Math.max(buckets[0].start, start) }

  const points = [
    { t: start, v: unitsNumber(base), c: unitsNumber(baseHour?.collected ?? 0n) },
    ...inPeriod.map((hour) => ({ t: hour.t, v: unitsNumber(hour.earned), c: unitsNumber(hour.collected) })),
  ]
  const events = view.events
    .filter((event) => event.timestamp >= start && event.timestamp <= end)
    .map((event) => {
      // On the line where it happened: the cumulative value at the end of the hour that holds it.
      const hour = inPeriod.find((candidate) => candidate.t >= event.timestamp)
      return { t: event.timestamp, v: unitsNumber(event.kind === 'mint' ? base : (hour?.earned ?? last)), kind: event.kind, tx: event.tx }
    })
    .reverse()

  // In range or not, hour by hour (an hour counts as in range when at least half of it was), merged into stretches.
  const strip: { t0: number; t1: number; inRange: boolean }[] = []
  let from = start
  for (const hour of inPeriod) {
    const inRange = hour.seconds > 0 && hour.inRange * 2 >= hour.seconds
    const previous = strip[strip.length - 1]
    if (previous && previous.inRange === inRange) previous.t1 = hour.t
    else strip.push({ t0: from, t1: hour.t, inRange })
    from = hour.t
  }
  return { period, start, end, bucketSeconds, base, last, points, buckets, events, strip }
}


const YEAR = 365 * DAY

/**
 * The realised Fee APR (§13.2-5), built and switched off until the owner says
 * yes (§21-3): the fees earned, each hour valued at that hour's pool price,
 * annualised over the time-weighted value of the principal at the same hourly
 * prices. A historical figure, never a forecast. USDG pairs only, one position,
 * and only with at least 24 hours of history; null otherwise. Plain numbers:
 * this is a rate, not an amount anyone is paid.
 */
export function realisedApr(view: FeesView): number | null {
  if (view.sources.length !== 1 || view.basis.kind !== 'usd' || view.span < DAY) return null
  const { history, state, basis } = view.sources[0]
  const [d0, d1] = basis.decimals
  const sqrtA = Math.pow(1.0001, state.tickLower / 2)
  const sqrtB = Math.pow(1.0001, state.tickUpper / 2)
  const events = [...history.events].sort((a, b) => a.timestamp - b.timestamp)
  let liquidity = 0
  let next = 0
  let previousT = history.mintedAt.timestamp
  let previousEarned: readonly [bigint, bigint] = ZERO
  let weighted = 0
  let seconds = 0
  let earned = 0
  for (const hour of history.hourly) {
    while (next < events.length && events[next].timestamp < hour.t) liquidity = Math.max(0, liquidity + Number(events[next++].liquidityDelta))
    const sqrtP = Number(hour.sqrtPriceX96Close) / 2 ** 96
    const p = Math.min(Math.max(sqrtP, sqrtA), sqrtB)
    const raw0 = sqrtP >= sqrtB ? 0 : (liquidity * (sqrtB - p)) / (p * sqrtB)
    const raw1 = sqrtP <= sqrtA ? 0 : liquidity * (p - sqrtA)
    // USDG per the other token at this hour's close, in whole tokens.
    const price = sqrtP * sqrtP * Math.pow(10, d0 - d1)
    const toUsd = (a0: number, a1: number) => (basis.into === 1 ? a1 + a0 * price : a0 + a1 / price)
    const span = Math.max(0, hour.t - previousT)
    weighted += toUsd(raw0 / 10 ** d0, raw1 / 10 ** d1) * span
    seconds += span
    earned += toUsd(Number(hour.earned[0] - previousEarned[0]) / 10 ** d0, Number(hour.earned[1] - previousEarned[1]) / 10 ** d1)
    previousT = hour.t
    previousEarned = hour.earned
  }
  const principal = seconds > 0 ? weighted / seconds : 0
  if (!(principal > 0) || !(seconds > 0)) return null
  return (earned / principal) * (YEAR / seconds)
}
