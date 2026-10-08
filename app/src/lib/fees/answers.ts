/**
 * A position's fees reads, as the page takes them (DESIGN-V2 §15.4): whether a build reads the chain at all, and every
 * answer of the two routes (/api/fees/v1/state, /api/fees/v2/ledger) checked field by field.
 *
 * Changed on purpose 2026-10-02 (RPC-SPEC §11.4): the fees replay's log units are gone; a ledger answer is checked here.
 */
import type { LedgerEntry, LedgerPosition, LedgerResponse, LedgerWhy, RelayAnswer, StatePosition, StatePositionOk, StateResponse } from './types'

export const UNAVAILABLE = { ok: false, failure: 'unavailable', retryAfterMs: 0 } as const

/** Whether this build reads the chain: the deployable builds, and the wallet test builds whose browsers answer the routes with a fake chain. */
export function chainRead(): boolean {
  return __DOMINO_DEPLOYABLE__ || __DOMINO_TEST_HOOKS__
}

const HASH = /^0x[0-9a-f]{64}$/
const ID = /^(?:0|[1-9][0-9]{0,77})$/
const DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/
const SIGNED = /^-?(?:0|[1-9][0-9]{0,77})$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const KINDS: ReadonlySet<string> = new Set(['mint', 'collect', 'increase', 'decrease', 'close'])
const WHYS: ReadonlySet<string> = new Set<LedgerWhy>(['reading', 'before_floor', 'manual', 'shared', 'native', 'liquidity', 'unseen', 'too_many'])

const block = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const int24 = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= -8_388_608 && value < 8_388_608
const decimals = (value: unknown, n: number): boolean => Array.isArray(value) && value.length === n && value.every((one) => typeof one === 'string' && DECIMAL.test(one))

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
  const decimalFields = ['liquidity', 'sqrtPriceX96', 'feeGrowthInside0X128', 'feeGrowthInside1X128', 'feeGrowthInside0LastX128', 'feeGrowthInside1LastX128', 'unclaimed0', 'unclaimed1']
  return typeof p.owner === 'string' && ADDRESS.test(p.owner) && typeof p.poolId === 'string' && HASH.test(p.poolId)
    && !!key && typeof key === 'object' && typeof key.currency0 === 'string' && ADDRESS.test(key.currency0) && typeof key.currency1 === 'string' && ADDRESS.test(key.currency1)
    && typeof key.fee === 'number' && Number.isInteger(key.fee) && int24(key.tickSpacing) && typeof key.hooks === 'string' && ADDRESS.test(key.hooks)
    && Array.isArray(p.currencies) && p.currencies.length === 2 && p.currencies.every(currency)
    && int24(p.tickLower) && int24(p.tickUpper) && int24(p.tick) && decimalFields.every((name) => typeof p[name] === 'string' && DECIMAL.test(p[name] as string))
    && (p.protocolFee === undefined || (typeof p.protocolFee === 'number' && Number.isInteger(p.protocolFee) && p.protocolFee >= 0 && p.protocolFee < 16_777_216))
}

/** A /state answer, checked field by field. */
export function isStateResponse(value: unknown): value is StateResponse {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return r.v === 1 && block(r.block) && block(r.timestamp) && Array.isArray(r.positions) && r.positions.every(position) && (r.nextTokenId === undefined || (typeof r.nextTokenId === 'string' && DECIMAL.test(r.nextTokenId)))
}

function entry(value: unknown, through: number): value is LedgerEntry {
  if (!value || typeof value !== 'object') return false
  const e = value as Record<string, unknown>
  return block(e.block) && e.block <= through && block(e.index) && typeof e.tx === 'string' && HASH.test(e.tx) && block(e.t) && typeof e.kind === 'string' && KINDS.has(e.kind)
    && typeof e.delta === 'string' && SIGNED.test(e.delta) && (e.fees === null || decimals(e.fees, 2)) && (e.auto === undefined || e.auto === true)
    && (e.service === undefined || decimals(e.service, 2)) && (e.why === undefined || (typeof e.why === 'string' && WHYS.has(e.why)))
}

function ledgerPosition(value: unknown, head: number): value is LedgerPosition {
  if (!value || typeof value !== 'object') return false
  const p = value as Record<string, unknown>
  if (typeof p.tokenId !== 'string' || !ID.test(p.tokenId)) return false
  if (p.ok === false) return p.reason === 'not_found' || p.reason === 'rpc_unavailable' || p.reason === 'hooked_pool'
  if (p.ok !== true || !block(p.through) || p.through > head || !position(p.state) || (p.state as StatePositionOk).ok !== true || (p.state as StatePositionOk).tokenId !== p.tokenId) return false
  const mint = p.mint as Record<string, unknown> | null
  if (mint !== null && (!mint || typeof mint !== 'object' || !block(mint.block) || typeof mint.tx !== 'string' || !HASH.test(mint.tx) || !block(mint.t))) return false
  if (mint?.sqrtPriceX96 !== undefined && (typeof mint.sqrtPriceX96 !== 'string' || !DECIMAL.test(mint.sqrtPriceX96) || BigInt(mint.sqrtPriceX96) <= 0n || BigInt(mint.sqrtPriceX96) >= (1n << 160n))) return false
  if (!Array.isArray(p.entries) || !p.entries.every((one) => entry(one, p.through as number))) return false
  const entries = p.entries as LedgerEntry[]
  // Oldest first, never before the mint.
  if (entries.some((one, i) => i > 0 && (one.block < entries[i - 1].block || (one.block === entries[i - 1].block && one.index <= entries[i - 1].index)))) return false
  if (mint && entries.some((one) => one.block < (mint.block as number))) return false
  return typeof p.exact === 'boolean' && (p.why === undefined || (typeof p.why === 'string' && WHYS.has(p.why))) && (p.exact ? p.why === undefined : p.why !== undefined)
    && (p.vault === undefined || (typeof p.vault === 'string' && ADDRESS.test(p.vault)))
}

/** A ledger answer (POST /api/fees/v2/ledger), checked field by field. */
export function isLedgerResponse(value: unknown): value is LedgerResponse {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return r.v === 1 && block(r.block) && block(r.timestamp) && Array.isArray(r.positions) && r.positions.every((one) => ledgerPosition(one, r.block as number))
}

/** A read's answer taken only when it is exactly what the relay sends; anything else is `unavailable`. */
export function checked<T>(answer: RelayAnswer<T>, check: (value: unknown) => value is T): RelayAnswer<T> {
  return !answer.ok || check(answer.value) ? answer : UNAVAILABLE
}
