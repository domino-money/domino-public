/**
 * Bounded, origin-local public history snapshots, NOT replay checkpoints.
 * The only writer is a successful replay. Restores remain `cached`, even if
 * structurally valid: local storage cannot prove canonical chain history.
 * Neither owner/wallet membership nor a session, growth or action state is saved.
 */
import { POOL_MANAGER, POSITION_MANAGER, STATE_VIEW } from './constants'
import type { CachedFeeHistory, FeeDisplayState, FeeHistory, FeeHistoryView, PositionState } from './types'

export const HISTORY_CACHE_KEY = 'domino:public-fee-history:1'
export const HISTORY_MAX_AGE_MS = 24 * 60 * 60 * 1_000
export const HISTORY_MAX_ENTRIES = 6
export const HISTORY_MAX_ENTRY_CHARS = 240_000
export const HISTORY_MAX_CHARS = 900_000
const IDENTITY = `1:4663:${POSITION_MANAGER}:${POOL_MANAGER}:${STATE_VIEW}`
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const UINT = /^(0|[1-9][0-9]{0,77})$/
const SIGNED = /^-?(0|[1-9][0-9]{0,77})$/
const U256 = (1n << 256n) - 1n
type RecordValue = Record<string, unknown>
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>
type Verified = Extract<FeeHistoryView, { phase: 'verified' }>
export interface HistoryCache {
  load(id: string): CachedFeeHistory | null
  save(id: string, view: Verified): void
  remove(id: string): void
}
interface Stored { id: string; snapshot: CachedFeeHistory }
const object = (v: unknown): v is RecordValue => !!v && typeof v === 'object' && !Array.isArray(v)
const integer = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max
const tick = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= 887272
const only = (v: RecordValue, names: string[]) => Object.keys(v).every((key) => names.includes(key))
const idOk = (id: unknown): id is string => typeof id === 'string' && UINT.test(id) && BigInt(id) <= U256
/** Validation failures are caught locally; no user-facing error detail or input is exposed. */
function invalid(): never { throw new Error('Invalid public history snapshot') }
function raw(v: unknown, signed = false): bigint {
  if (typeof v !== 'string' || !(signed ? SIGNED : UINT).test(v)) invalid()
  const n = BigInt(v)
  if (n > U256 || n < (signed ? -U256 : 0n)) invalid()
  return n
}
function pair(v: unknown): readonly [bigint, bigint] {
  if (!Array.isArray(v) || v.length !== 2) invalid()
  return [raw(v[0]), raw(v[1])]
}
function requireObject(v: unknown, keys: string[]): RecordValue {
  if (!object(v) || !only(v, keys)) invalid()
  return v
}
function number(v: unknown, max?: number): number {
  if (!integer(v, max)) invalid()
  return v
}
function price(v: unknown): bigint {
  const n = raw(v)
  if (n <= 0n || n >= (1n << 160n)) invalid()
  return n
}
function atTick(v: unknown): number { if (!tick(v)) invalid(); return v }
function text(v: unknown, regex: RegExp): string { if (typeof v !== 'string' || !regex.test(v)) invalid(); return v }
function array(v: unknown, max: number): unknown[] { if (!Array.isArray(v) || v.length > max) invalid(); return v }
function state(v: unknown): FeeDisplayState {
  const s = requireObject(v, ['block', 'timestamp', 'unclaimed', 'sqrtPriceX96', 'tick', 'tickLower', 'tickUpper', 'liquidity', 'poolId', 'currencies', 'protocolFee'])
  const currencies = array(s.currencies, 2).map((v) => {
    const c = requireObject(v, ['address', 'symbol', 'decimals'])
    if (c.symbol !== null && (typeof c.symbol !== 'string' || c.symbol.length > 64 || [...c.symbol].some((char) => char.charCodeAt(0) < 32))) invalid()
    if (c.decimals !== null && !integer(c.decimals, 255)) invalid()
    return { address: text(c.address, ADDRESS), symbol: c.symbol as string | null, decimals: c.decimals as number | null }
  })
  if (currencies.length !== 2 || currencies[0].address === currencies[1].address) invalid()
  const out: FeeDisplayState = {
    block: number(s.block), timestamp: number(s.timestamp), unclaimed: pair(s.unclaimed), sqrtPriceX96: price(s.sqrtPriceX96),
    tick: atTick(s.tick), tickLower: atTick(s.tickLower), tickUpper: atTick(s.tickUpper), liquidity: raw(s.liquidity),
    poolId: text(s.poolId, HASH), currencies: [currencies[0], currencies[1]],
    ...(s.protocolFee === undefined ? {} : { protocolFee: number(s.protocolFee, 0xffffff) }),
  }
  if (!out.block || !out.timestamp || out.tickLower >= out.tickUpper || out.liquidity >= (1n << 128n)) invalid()
  return out
}
function snapshot(v: unknown, now: number): CachedFeeHistory {
  const s = requireObject(v, ['phase', 'state', 'history', 'prices', 'savedAt', 'source'])
  if (s.phase !== 'cached' || s.source !== 'public-chain-replay' || !integer(s.savedAt) || s.savedAt > now || now - s.savedAt >= HISTORY_MAX_AGE_MS) invalid()
  const st = state(s.state)
  // Age is from the actual chain snapshot as well as the save, never reset by a restore.
  if (st.timestamp * 1_000 > s.savedAt + 60_000 || now - st.timestamp * 1_000 >= HISTORY_MAX_AGE_MS) invalid()
  const h = requireObject(s.history, ['mintedAt', 'earned', 'collected', 'timeInRange', 'hourly', 'events', 'checks', 'near'])
  const mint = requireObject(h.mintedAt, ['block', 'timestamp'])
  const mintedAt = { block: number(mint.block, st.block), timestamp: number(mint.timestamp, st.timestamp) }
  const span = requireObject(h.timeInRange, ['inSeconds', 'totalSeconds'])
  const timeInRange = { inSeconds: number(span.inSeconds), totalSeconds: number(span.totalSeconds, st.timestamp - mintedAt.timestamp) }
  if (timeInRange.inSeconds > timeInRange.totalSeconds) invalid()
  const earned = pair(h.earned), collected = pair(h.collected)
  if (earned.some((n, i) => n !== collected[i] + st.unclaimed[i])) invalid()
  let lastAnchor = -1, lastTime = mintedAt.timestamp
  const hourly = array(h.hourly, 4096).map((v) => {
    const r = requireObject(v, ['anchor', 't', 'earned', 'collected', 'inRangeSeconds', 'sqrtPriceX96Close', 'tickClose'])
    const anchor = number(r.anchor), t = number(r.t, st.timestamp)
    if (anchor <= lastAnchor || t < lastTime) invalid()
    lastAnchor = anchor; lastTime = t
    return { anchor, t, earned: pair(r.earned), collected: pair(r.collected), inRangeSeconds: number(r.inRangeSeconds, st.timestamp - mintedAt.timestamp), sqrtPriceX96Close: price(r.sqrtPriceX96Close), tickClose: atTick(r.tickClose) }
  })
  if (!hourly.length || hourly.at(-1)!.t !== st.timestamp || hourly.at(-1)!.earned.some((n, i) => n !== earned[i]) || hourly.at(-1)!.collected.some((n, i) => n !== collected[i])) invalid()
  let previousBlock = mintedAt.block, previousTime = mintedAt.timestamp
  const events = array(h.events, 2048).map((v) => {
    const e = requireObject(v, ['kind', 'block', 'timestamp', 'tx', 'fees', 'liquidityDelta'])
    if (!['mint', 'collect', 'increase', 'decrease', 'close'].includes(String(e.kind))) invalid()
    const block = number(e.block, st.block), timestamp = number(e.timestamp, st.timestamp)
    if (block < previousBlock || timestamp < previousTime) invalid()
    previousBlock = block; previousTime = timestamp
    return { kind: e.kind as FeeHistory['events'][number]['kind'], block, timestamp, tx: text(e.tx, HASH), fees: pair(e.fees), liquidityDelta: raw(e.liquidityDelta, true) }
  })
  const checks = requireObject(h.checks, ['swaps', 'steps', 'tickMismatch', 'liquidityMismatch', 'swapFeeMismatch', 'inconsistentLastStep'])
  const verifiedChecks = { swaps: number(checks.swaps), steps: number(checks.steps), tickMismatch: number(checks.tickMismatch, 0), liquidityMismatch: number(checks.liquidityMismatch, 0), swapFeeMismatch: number(checks.swapFeeMismatch, 0), inconsistentLastStep: number(checks.inconsistentLastStep, 0) }
  if (h.near !== undefined && h.near !== true) invalid()
  const prices = requireObject(s.prices, ['hours'])
  lastAnchor = -1; lastTime = mintedAt.timestamp
  const hours = array(prices.hours, 4096).map((v) => {
    const p = requireObject(v, ['anchor', 't', 'sqrtPriceX96Close', 'tickClose'])
    const anchor = number(p.anchor), t = number(p.t, st.timestamp)
    if (anchor <= lastAnchor || t < lastTime) invalid()
    lastAnchor = anchor; lastTime = t
    return { anchor, t, sqrtPriceX96Close: price(p.sqrtPriceX96Close), tickClose: atTick(p.tickClose) }
  })
  return { phase: 'cached', source: 'public-chain-replay', savedAt: s.savedAt, state: st, history: { mintedAt, earned, collected, timeInRange, hourly, events, checks: verifiedChecks, ...(h.near === true ? { near: true } : {}) }, prices: { hours } }
}
const encode = (v: unknown) => JSON.stringify(v, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value)

/** Reject a saved end ahead of the RPC, changed pool/range/currencies/liquidity, or conflicting same-block state. */
export function savedHistoryMatches(saved: CachedFeeHistory, live: PositionState): boolean {
  const old = saved.state
  return live.block >= old.block && live.timestamp >= old.timestamp && live.poolId === old.poolId && live.tickLower === old.tickLower && live.tickUpper === old.tickUpper && live.liquidity === old.liquidity &&
    live.currencies.every((c, i) => c.address === old.currencies[i].address && c.decimals === old.currencies[i].decimals) &&
    live.unclaimed.every((n, i) => n >= old.unclaimed[i]) &&
    (live.block !== old.block || (live.timestamp === old.timestamp && live.sqrtPriceX96 === old.sqrtPriceX96 && live.tick === old.tick && live.unclaimed.every((n, i) => n === old.unclaimed[i])))
}

export function createHistoryCache(storage: () => Storage | null, now: () => number = Date.now): HistoryCache {
  function read(): Stored[] {
    try {
      const text = storage()?.getItem(HISTORY_CACHE_KEY)
      if (!text) return []
      if (text.length > HISTORY_MAX_CHARS) invalid()
      const root = requireObject(JSON.parse(text), ['identity', 'entries'])
      if (root.identity !== IDENTITY) invalid()
      const ids = new Set<string>()
      return array(root.entries, HISTORY_MAX_ENTRIES).flatMap((value): Stored[] => {
        try {
          const entry = requireObject(value, ['id', 'snapshot'])
          if (!idOk(entry.id) || ids.has(entry.id) || encode(entry).length > HISTORY_MAX_ENTRY_CHARS) return []
          ids.add(entry.id)
          return [{ id: entry.id, snapshot: snapshot(entry.snapshot, now()) }]
        } catch { return [] }
      })
    } catch { return [] }
  }
  function write(entries: Stored[]): void {
    try {
      const target = storage()
      if (!target) return
      let kept = entries.slice(0, HISTORY_MAX_ENTRIES)
      let text = encode({ identity: IDENTITY, entries: kept })
      while (kept.length && text.length > HISTORY_MAX_CHARS) { kept = kept.slice(0, -1); text = encode({ identity: IDENTITY, entries: kept }) }
      if (!kept.length) target.removeItem(HISTORY_CACHE_KEY)
      else {
        // Quota/private-mode failures never interrupt a live read. Drop old cache rather than retry a write loop.
        try { target.setItem(HISTORY_CACHE_KEY, text) } catch { target.removeItem(HISTORY_CACHE_KEY) }
      }
    } catch { /* Storage may be unavailable or blocked entirely. */ }
  }
  return {
    load(id) { return idOk(id) ? read().find((entry) => entry.id === id)?.snapshot ?? null : null },
    save(id, view) {
      if (!idOk(id) || view.phase !== 'verified') return
      try {
        const { owner: _owner, ...publicState } = view.state
        const candidate = { id, snapshot: { phase: 'cached', source: 'public-chain-replay', savedAt: now(), state: publicState, history: view.history, prices: view.prices } }
        const text = encode(candidate)
        if (text.length > HISTORY_MAX_ENTRY_CHARS) return
        const safe = snapshot(JSON.parse(text).snapshot, now())
        write([{ id, snapshot: safe }, ...read().filter((entry) => entry.id !== id)])
      } catch { /* Oversized or incompatible histories are live-only. */ }
    },
    remove(id) { if (idOk(id)) write(read().filter((entry) => entry.id !== id)) },
  }
}
