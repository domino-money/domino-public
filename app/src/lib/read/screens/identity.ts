/**
 * Identity for chain data on the read screens: chain 4663 plus an address, a
 * pool id or an NFT token id. Never a symbol, which is untrusted text.
 *
 * Addresses a person types are checked exactly as typed, with no trimming, and
 * sent exactly as typed: request-boundaries.json refuses a trailing line break
 * or CRLF, and so does this. Response addresses are lowercase already; keys are
 * always lowercase, so a typed mixed-case address and the reply about it meet.
 */

import { ROBINHOOD_ID } from '../../../config/chainIdentity'

declare const addressBrand: unique symbol
declare const poolIdBrand: unique symbol

/** A lowercase 40-hex address on chain 4663. Only this module mints one. */
export type AddressKey = string & { readonly [addressBrand]: true }
/** A lowercase 64-hex pool id on chain 4663. Only this module mints one. */
export type PoolIdKey = string & { readonly [poolIdBrand]: true }

/** Changed on purpose 2026-10-01 (the chain2 workstream, part B, audit item G3): the chain registry's id, the same 4663. */
export const CHAIN_ID = ROBINHOOD_ID
export const NATIVE_CURRENCY = '0x0000000000000000000000000000000000000000' as AddressKey

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const POOL_ID = /^0x[0-9a-fA-F]{64}$/
const HEX = /^[0-9a-fA-F]*$/

export type AddressProblem = 'empty' | 'line_break' | 'whitespace' | 'prefix' | 'hex' | 'length'

export type AddressInput = { ok: true; wire: string; key: AddressKey } | { ok: false; reason: AddressProblem }

/**
 * A typed or pasted contract address. Accepts exactly `^0x[0-9a-fA-F]{40}$`:
 * no trimming, a lowercase `0x` prefix, upper-case hex digits allowed. `wire`
 * is the string as typed, which is what gets sent; `key` is its lowercase form.
 */
export function parseAddressInput(raw: string): AddressInput {
  if (raw === '') return { ok: false, reason: 'empty' }
  if (/[\r\n]/.test(raw)) return { ok: false, reason: 'line_break' }
  if (/\s/.test(raw)) return { ok: false, reason: 'whitespace' }
  if (!raw.startsWith('0x')) return { ok: false, reason: 'prefix' }
  if (!HEX.test(raw.slice(2))) return { ok: false, reason: 'hex' }
  if (!ADDRESS.test(raw)) return { ok: false, reason: 'length' }
  return { ok: true, wire: raw, key: raw.toLowerCase() as AddressKey }
}

/**
 * Checks clipboard text before the browser flattens it. An `<input>` drops
 * line breaks from pasted text, which could silently join two fragments into
 * one valid-looking address; a paste with any line break is refused instead.
 */
export function screenPaste(clipboardText: string): { ok: true } | { ok: false; reason: 'line_break' } {
  return /[\r\n]/.test(clipboardText) ? { ok: false, reason: 'line_break' } : { ok: true }
}

/** The key of an address from a validated payload. Throws on anything else. */
export function addressKey(address: string): AddressKey {
  if (!ADDRESS.test(address)) throw new Error('not an address')
  return address.toLowerCase() as AddressKey
}

/** The key of a pool id from a validated payload. Throws on anything else. */
export function poolIdKey(poolId: string): PoolIdKey {
  if (!POOL_ID.test(poolId)) throw new Error('not a pool id')
  return poolId.toLowerCase() as PoolIdKey
}

export const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** `0x1234…abcd`: for tight places only. The full address is always shown or reachable beside it. */
export const shortAddress = (value: string) => (value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value)

/**
 * Narrows loaded rows by address text. Hex only, so a query can never match a
 * symbol: "TOKEN" finds nothing, "0x1111" finds the rows whose address holds it.
 */
export function searchByAddress<T extends { key: string }>(items: readonly T[], query: string): T[] {
  if (query === '') return [...items]
  const needle = (query.toLowerCase().startsWith('0x') ? query.slice(2) : query).toLowerCase()
  if (!HEX.test(needle)) return []
  return items.filter((item) => item.key.slice(2).includes(needle))
}
