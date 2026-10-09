/**
 * This browser's own reads of a position's unclaimed fees (2026-10-02, RPC-SPEC §11.4): measured points for its Fees
 * earned chart between its settlements (lib/fees/ledger.ts). Each is a block, its time and the exact unclaimed figure the
 * state read gave there; with the ledger's settlements up to that block it is exactly what the position had earned then.
 *
 * Each new block is available immediately in a bounded live buffer. Compact hourly anchors (and measured past
 * period starts) are kept 30 days, at most MAX_READINGS per NFT and MAX_NFTS NFTs, in this browser's storage
 * per chain and PositionManager: public chain data, no wallet address. Every read and write is behind try/catch; anything
 * that does not validate is let go. Pure apart from the storage handed in.
 */
import { POSITION_MANAGER } from './constants'

export const READINGS_KEY = 'domino:fee-readings:1'
/** At most one reading per NFT this often (seconds of chain time). */
export const READING_EVERY_SECONDS = 3_600
/** How long a reading is kept (seconds of chain time). */
export const READING_MAX_AGE_SECONDS = 30 * 86_400
export const MAX_READINGS = 720
export const MAX_NFTS = 32
/** Recent confirmed blocks stay in memory without writing browser storage on every refresh. */
export const MAX_LIVE_READINGS = 240
const IDENTITY = `1:4663:${POSITION_MANAGER}`
const ID = /^[1-9]\d{0,77}$/
const UINT = /^(?:0|[1-9]\d{0,77})$/

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>

/** One read: its block, its time (Unix seconds) and the unclaimed fees there. */
export interface Reading {
  block: number
  t: number
  unclaimed: readonly [bigint, bigint]
}

export interface Readings {
  /** `id`'s readings, oldest first. */
  get(id: string): Reading[]
  /** Keeps each new confirmed block in memory; persists compact hourly anchors. */
  note(id: string, reading: Reading): boolean
  /**
   * 2026-10-02 (the chart's periods, lib/fees/pastReads.ts): keeps a read of `id` at a PAST block in its place among the
   * others (block order, one per block), under the same caps: none `now` (chain time, Unix seconds) shows older than 30
   * days, at most MAX_READINGS. True when it is kept (or one at its block already was); false when it cannot be (older
   * than the readings keep, or not a reading), so its reader holds it in memory for the visit instead.
   */
  insert(id: string, reading: Reading, now: number): boolean
}

type Row = [block: number, t: number, unclaimed0: string, unclaimed1: string]

const isRow = (value: unknown): value is Row =>
  Array.isArray(value) && value.length === 4 && Number.isSafeInteger(value[0]) && value[0] > 0 && Number.isSafeInteger(value[1]) && value[1] > 0 && typeof value[2] === 'string' && UINT.test(value[2]) && typeof value[3] === 'string' && UINT.test(value[3])

export function createReadings(storage: () => Storage | null): Readings {
  let memory: Map<string, Row[]> | null = null
  const live = new Map<string, Row[]>()
  const load = (): Map<string, Row[]> => {
    if (memory) return memory
    memory = new Map()
    try {
      const text = storage()?.getItem(READINGS_KEY)
      const root = text ? (JSON.parse(text) as { identity?: unknown; nfts?: unknown }) : null
      if (root && root.identity === IDENTITY && root.nfts && typeof root.nfts === 'object' && !Array.isArray(root.nfts)) {
        for (const [id, rows] of Object.entries(root.nfts as Record<string, unknown>).slice(0, MAX_NFTS)) {
          if (!ID.test(id) || !Array.isArray(rows)) continue
          const valid = rows.filter(isRow).slice(-MAX_READINGS)
          if (valid.length > 0) memory.set(id, valid)
        }
      }
    } catch {
      memory = new Map()
    }
    return memory
  }
  const save = () => {
    try {
      if (!memory) return
      // The NFTs read most recently first, at most MAX_NFTS.
      const nfts = [...memory.entries()].sort((a, b) => (b[1].at(-1)?.[1] ?? 0) - (a[1].at(-1)?.[1] ?? 0)).slice(0, MAX_NFTS)
      memory = new Map(nfts)
      storage()?.setItem(READINGS_KEY, JSON.stringify({ identity: IDENTITY, nfts: Object.fromEntries(nfts) }))
    } catch {
      // Storage may be full, private or blocked: readings are a convenience.
    }
  }
  return {
    get(id) {
      const rows = new Map<number, Row>()
      for (const row of [...(load().get(id) ?? []), ...(live.get(id) ?? [])]) rows.set(row[0], row)
      return [...rows.values()].sort((a, b) => a[0] - b[0]).map(([block, t, a, b]) => ({ block, t, unclaimed: [BigInt(a), BigInt(b)] as const }))
    },
    note(id, reading) {
      if (!ID.test(id) || !Number.isSafeInteger(reading.block) || reading.block <= 0 || !Number.isSafeInteger(reading.t) || reading.t <= 0) return false
      if (reading.unclaimed[0] < 0n || reading.unclaimed[1] < 0n) return false
      const all = load()
      const rows = all.get(id) ?? []
      const last = rows.at(-1)
      const recent = live.get(id) ?? []
      const newest = recent.at(-1) ?? last
      if (newest && (reading.block <= newest[0] || reading.t < newest[1])) return false
      const row: Row = [reading.block, reading.t, reading.unclaimed[0].toString(), reading.unclaimed[1].toString()]
      live.delete(id)
      live.set(id, [...recent.filter((one) => reading.t - one[1] < READING_MAX_AGE_SECONDS), row].slice(-MAX_LIVE_READINGS))
      while (live.size > MAX_NFTS) live.delete(live.keys().next().value!)
      if (last && reading.t - last[1] < READING_EVERY_SECONDS) return true
      const kept = [...rows.filter((row) => reading.t - row[1] < READING_MAX_AGE_SECONDS), [reading.block, reading.t, reading.unclaimed[0].toString(), reading.unclaimed[1].toString()] as Row].slice(-MAX_READINGS)
      all.set(id, kept)
      save()
      return true
    },
    insert(id, reading, now) {
      if (!ID.test(id) || !Number.isSafeInteger(reading.block) || reading.block <= 0 || !Number.isSafeInteger(reading.t) || reading.t <= 0 || !Number.isSafeInteger(now)) return false
      if (reading.unclaimed[0] < 0n || reading.unclaimed[1] < 0n || now - reading.t >= READING_MAX_AGE_SECONDS) return false
      const all = load()
      const rows = all.get(id) ?? []
      if (rows.some((row) => row[0] === reading.block)) return true
      const row: Row = [reading.block, reading.t, reading.unclaimed[0].toString(), reading.unclaimed[1].toString()]
      const kept = [...rows.filter((one) => now - one[1] < READING_MAX_AGE_SECONDS), row].sort((a, b) => a[0] - b[0]).slice(-MAX_READINGS)
      if (!kept.includes(row)) return false
      all.set(id, kept)
      save()
      return true
    },
  }
}
