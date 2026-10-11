import type { BlockRef, PositionLive } from 'api-contracts/read-v6/types'
import type { PriceHistory, PricePoint } from '../../lib/chart/priceRange'
import { priceFigure } from '../../lib/chart/priceRange'

/** Display-only observations. Neither a fee ledger nor evidence of ownership, finality or lifetime returns. */
export interface PositionReading {
  snapshot: BlockRef
  sqrtPriceX96: string
  fees: readonly [string, string]
}
const EMPTY: readonly PositionReading[] = Object.freeze([])
const STORAGE = 'domino:position-readings:v1'
const KEEP = 86_400
const HASH = /^0x[0-9a-f]{64}$/i
const UINT = /^(0|[1-9][0-9]{0,77})$/
const valid = (row: PositionReading, now: number) => !!row && typeof row === 'object'
  && !!row.snapshot && Number.isSafeInteger(row.snapshot.number) && row.snapshot.number > 0 && HASH.test(row.snapshot.hash)
  && Number.isSafeInteger(row.snapshot.timestamp) && row.snapshot.timestamp > now - KEEP && row.snapshot.timestamp <= now + 60
  && typeof row.sqrtPriceX96 === 'string' && UINT.test(row.sqrtPriceX96) && BigInt(row.sqrtPriceX96) > 0n && BigInt(row.sqrtPriceX96) < (1n << 160n)
  && Array.isArray(row.fees) && row.fees.length === 2 && row.fees.every(value => typeof value === 'string' && UINT.test(value) && BigInt(value) < (1n << 256n))

/** Bounded to sixteen identities and sixty-four measured blocks each, scoped to this browser session. */
export function createPositionReadings(storage: Pick<Storage, 'getItem' | 'setItem'> | null, now = () => Math.floor(Date.now() / 1000)) {
  const all = new Map<string, readonly PositionReading[]>()
  const rejected = new Map<string, readonly string[]>()
  const listeners = new Map<string, Set<() => void>>()
  try {
    const text = storage?.getItem(STORAGE)
    const raw = text && text.length <= 350_000 ? JSON.parse(text) : null
    if (Array.isArray(raw) && raw.length <= 16) for (const entry of raw) {
      if (!Array.isArray(entry) || (entry.length !== 2 && entry.length !== 3) || typeof entry[0] !== 'string' || entry[0].length > 512 || !Array.isArray(entry[1]) || entry[1].length > 64) continue
      const hashes = Array.isArray(entry[2]) ? entry[2].filter(value => typeof value === 'string' && HASH.test(value)).slice(-128).map(value => value.toLowerCase()) : []
      rejected.set(entry[0], hashes)
      const rows = entry[1].filter(row => valid(row, now())).sort((a, b) => a.snapshot.number - b.snapshot.number)
      all.set(entry[0], rows.filter((row, index) => !hashes.includes(row.snapshot.hash.toLowerCase()) && (index === 0 || row.snapshot.number > rows[index - 1].snapshot.number && row.snapshot.timestamp > rows[index - 1].snapshot.timestamp)))
    }
  } catch { /* Storage is optional; the live figures never depend on it. */ }
  const save = () => { try { storage?.setItem(STORAGE, JSON.stringify([...all].map(([key, rows]) => [key, rows, rejected.get(key) ?? []]))) } catch { /* Best effort display cache. */ } }
  const get = (key: string) => all.get(key) ?? EMPTY
  const notify = (key: string) => { for (const listener of listeners.get(key) ?? []) listener() }
  return {
    get,
    subscribe(key: string, listener: () => void) {
      const group = listeners.get(key) ?? new Set<() => void>()
      group.add(listener); listeners.set(key, group)
      return () => { group.delete(listener); if (!group.size) listeners.delete(key) }
    },
    observe(key: string, state: PositionLive | null, fresh: boolean): readonly PositionReading[] {
      const old = get(key)
      if (!fresh || !state) return old
      const row: PositionReading = { snapshot: { ...state.snapshot }, sqrtPriceX96: state.sqrtPriceX96, fees: [state.feesOwed[0], state.feesOwed[1]] }
      if (!valid(row, now()) || rejected.get(key)?.includes(row.snapshot.hash.toLowerCase())) return old
      const last = old.at(-1)
      if (last && (last.snapshot.number > row.snapshot.number || last.snapshot.number === row.snapshot.number && last.snapshot.hash === row.snapshot.hash)) return old
      // A replacement hash at the same height removes its old branch; a response cannot move time backwards.
      const kept = old.filter(item => valid(item, now()) && item.snapshot.number < row.snapshot.number && item.snapshot.timestamp < row.snapshot.timestamp)
      const next = [...kept, row].slice(-64)
      all.delete(key); all.set(key, next)
      while (all.size > 16) { const first = all.keys().next().value as string; all.delete(first); rejected.delete(first) }
      save()
      notify(key)
      return next
    },
    rollback(key: string, blockHash: string, fromBlock?: number): readonly PositionReading[] {
      const old = get(key), index = old.findIndex(row => row.snapshot.hash.toLowerCase() === blockHash.toLowerCase() || (fromBlock !== undefined && row.snapshot.number >= fromBlock))
      // A cached portfolio response can arrive after rollback (or a remount). Never re-add its orphaned snapshot.
      const hashes = [...new Set([...(rejected.get(key) ?? []), blockHash.toLowerCase(), ...(index < 0 ? [] : old.slice(index).map(row => row.snapshot.hash.toLowerCase()))])].slice(-128)
      rejected.set(key, hashes)
      const next = index < 0 ? old : old.slice(0, index)
      while (all.size >= 16 && !all.has(key)) { const first = all.keys().next().value as string; all.delete(first); rejected.delete(first) }
      all.set(key, next); save(); notify(key)
      return next
    },
  }
}

/** Every run is a single observed point: no synthetic mint, held-forward price, or line through unobserved time. */
export function recordedPriceHistory(rows: readonly PositionReading[], decimals: readonly [number | null, number | null], inverted: boolean, range: { lower: number; upper: number }): PriceHistory | null {
  if (decimals.some(value => value === null || !Number.isInteger(value) || value < 0 || value > 77)) return null
  const points: PricePoint[] = rows.flatMap(row => {
    const ratio = (Number(row.sqrtPriceX96) / 2 ** 96) ** 2 * 10 ** (decimals[0]! - decimals[1]!)
    const price = inverted ? 1 / ratio : ratio
    return price > 0 && Number.isFinite(price) ? [{ t: row.snapshot.timestamp, price, text: priceFigure(price), exact: price.toPrecision(12), inRange: price >= range.lower && price < range.upper }] : []
  })
  if (!points.length) return null
  return { start: points[0].t, end: points.at(-1)!.t, points, runs: points.map(point => [point]), missing: true, stale: false, observed: true }
}
