/**
 * The fees history's reads, as the page and the replay worker take them
 * (DESIGN-V2 §15.4): whether a build reads the chain at all, and every answer
 * checked field by field, as a route's reply was. Split out of client.ts on
 * 2026-09-25 so the replay worker, which cannot load code lazily (a classic
 * worker is one file), shares them with the page, which loads the chain code
 * lazily (lib/chain/chainCode.ts).
 */
import type { CompactLog, LogsRequest, LogsResponse, LogsUnit, RelayAnswer, StatePosition, StateResponse } from './types'

export const UNAVAILABLE = { ok: false, failure: 'unavailable', retryAfterMs: 0 } as const

/** Whether this build reads the chain: the deployable builds, and the wallet test builds whose browsers answer the RPC with a fake chain. */
export function chainRead(): boolean {
  return __DOMINO_DEPLOYABLE__ || __DOMINO_TEST_HOOKS__
}

const HASH = /^0x[0-9a-f]{64}$/
const HEX = /^0x(?:[0-9a-f]{64})*$/
const ID = /^(?:0|[1-9][0-9]{0,77})$/
const DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/
const ADDRESS = /^0x[0-9a-f]{40}$/

const block = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const int24 = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= -8_388_608 && value < 8_388_608

function compactLog(value: unknown): value is CompactLog {
  if (!Array.isArray(value) || value.length !== 6) return false
  const [at, index, event, tx, topics, data] = value as unknown[]
  return block(at) && block(index) && typeof event === 'number' && Number.isInteger(event) && event >= 0 && event <= 5 && typeof tx === 'string' && HASH.test(tx)
    && Array.isArray(topics) && topics.length <= 3 && topics.every((topic) => typeof topic === 'string' && HASH.test(topic)) && typeof data === 'string' && HEX.test(data)
}

function unit(value: unknown): value is LogsUnit {
  if (!value || typeof value !== 'object') return false
  const u = value as Record<string, unknown>
  return (u.unit === null || block(u.unit)) && block(u.from) && block(u.to) && u.from <= u.to && typeof u.final === 'boolean' && Array.isArray(u.logs) && u.logs.every(compactLog)
}

/** A /logs answer of the kind asked, checked field by field. */
export function isLogsResponse(value: unknown, kind: LogsRequest['kind']): value is LogsResponse {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  if (r.v !== 1 || r.kind !== kind) return false
  if (r.behind === true) return Object.keys(r).length === 3
  if (!block(r.head)) return false
  switch (kind) {
    case 'swapBefore':
      return r.log === null || compactLog(r.log)
    case 'headers':
      return Array.isArray(r.headers) && r.headers.every((pair) => Array.isArray(pair) && pair.length === 2 && block(pair[0]) && block(pair[1]))
    default:
      return Array.isArray(r.units) && r.units.every(unit) && (r.next === null || block(r.next))
  }
}

function currency(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const c = value as Record<string, unknown>
  return typeof c.address === 'string' && ADDRESS.test(c.address) && (c.symbol === null || typeof c.symbol === 'string') && (c.decimals === null || (typeof c.decimals === 'number' && Number.isInteger(c.decimals) && c.decimals >= 0 && c.decimals <= 255))
}

function position(value: unknown): value is StatePosition {
  if (!value || typeof value !== 'object') return false
  const p = value as Record<string, unknown>
  if (typeof p.tokenId !== 'string' || !ID.test(p.tokenId)) return false
  if (p.ok === false) return p.reason === 'not_found' || p.reason === 'rpc_unavailable' || p.reason === 'hooked_pool'
  if (p.ok !== true) return false
  const key = p.poolKey as Record<string, unknown> | undefined
  const decimals = ['liquidity', 'sqrtPriceX96', 'feeGrowthInside0X128', 'feeGrowthInside1X128', 'feeGrowthInside0LastX128', 'feeGrowthInside1LastX128', 'unclaimed0', 'unclaimed1']
  return typeof p.owner === 'string' && ADDRESS.test(p.owner) && typeof p.poolId === 'string' && HASH.test(p.poolId)
    && !!key && typeof key === 'object' && typeof key.currency0 === 'string' && ADDRESS.test(key.currency0) && typeof key.currency1 === 'string' && ADDRESS.test(key.currency1)
    && typeof key.fee === 'number' && Number.isInteger(key.fee) && int24(key.tickSpacing) && typeof key.hooks === 'string' && ADDRESS.test(key.hooks)
    && Array.isArray(p.currencies) && p.currencies.length === 2 && p.currencies.every(currency)
    && int24(p.tickLower) && int24(p.tickUpper) && int24(p.tick) && decimals.every((name) => typeof p[name] === 'string' && DECIMAL.test(p[name] as string))
}

/** A /state answer, checked field by field. */
export function isStateResponse(value: unknown): value is StateResponse {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return r.v === 1 && block(r.block) && block(r.timestamp) && Array.isArray(r.positions) && r.positions.every(position)
}

/** A read's answer taken only when it is exactly what the relay sends; anything else is `unavailable`. */
export function checked<T>(answer: RelayAnswer<T>, check: (value: unknown) => value is T): RelayAnswer<T> {
  return !answer.ok || check(answer.value) ? answer : UNAVAILABLE
}
