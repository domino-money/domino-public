/**
 * ABI words, Multicall3's aggregate3, a bounded reader and Keccak-256 for the second chain's code (2026-10-01, the chain2
 * workstream): copies of functions/_lib/owned.ts's (hex, word, addressWord, encodeAggregate3, reader, decodeAggregate3,
 * asAddress, asInt24, ChainError, keccak256), held equal to them by tests/elysium-chain.test.mjs on the same vectors.
 *
 * Why copies and not imports: owned.ts lives in Robinhood Chain's lazy chunk (lib/chain/chainCode.ts). The Elysium
 * section is a lazy chunk of its own; importing owned.ts from it would make the bundler split owned.ts out of
 * Robinhood's chunk into a shared one, changing what Robinhood's Positions path loads. With these copies the section
 * shares nothing with it. Part B may move owned.ts onto this module instead (one implementation, then re-measured).
 *
 * Pure: no DOM, no build flag, no network.
 */

/** A read that cannot be trusted: the call's data is not what its getter returns. */
export class ChainError extends Error {
  constructor(
    readonly kind: 'fatal',
    message: string,
  ) {
    super(message)
  }
}

/** Multicall3 aggregate3((address,bool,bytes)[]), without 0x. */
export const AGGREGATE3 = '82ad56cb'

export const hex = (n: number | bigint) => `0x${n.toString(16)}`
/** A uint256 (or a negative int, two's complement) as one ABI word. */
export const word = (n: bigint) => BigInt.asUintN(256, n).toString(16).padStart(64, '0')
export const addressWord = (address: string) => address.slice(2).toLowerCase().padStart(64, '0')

/** One aggregate3 call: its target and its calldata without 0x. */
export interface SubCall {
  target: string
  data: string
}

/** aggregate3((address target, bool allowFailure, bytes callData)[]) calldata, every call allowed to fail. */
export function encodeAggregate3(calls: readonly SubCall[]): string {
  const tuples = calls.map(({ target, data }) => {
    const padded = data.padEnd(Math.ceil(data.length / 64) * 64, '0')
    return addressWord(target) + word(1n) + word(0x60n) + word(BigInt(data.length / 2)) + padded
  })
  let offset = BigInt(calls.length * 32)
  const offsets: string[] = []
  for (const tuple of tuples) {
    offsets.push(word(offset))
    offset += BigInt(tuple.length / 2)
  }
  return `0x${AGGREGATE3}${word(0x20n)}${word(BigInt(calls.length))}${offsets.join('')}${tuples.join('')}`
}

/** A bounds-checked reader over ABI-encoded return data. */
export function reader(data: string) {
  const body = data.startsWith('0x') ? data.slice(2) : data
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(body)) throw new ChainError('fatal', 'invalid_return_data')
  const bytes = body.length / 2
  const at = (byte: bigint | number): bigint => {
    const start = Number(byte)
    if (!Number.isSafeInteger(start) || start < 0 || start + 32 > bytes) throw new ChainError('fatal', 'invalid_return_data')
    return BigInt(`0x${body.slice(start * 2, start * 2 + 64)}`)
  }
  const slice = (byte: bigint | number, length: bigint | number): string => {
    const start = Number(byte)
    const size = Number(length)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || start < 0 || size < 0 || start + size > bytes) throw new ChainError('fatal', 'invalid_return_data')
    return body.slice(start * 2, (start + size) * 2)
  }
  return { at, slice, bytes }
}

/** aggregate3's (bool success, bytes returnData)[], as returned. */
export function decodeAggregate3(data: string): { success: boolean; data: string }[] {
  const r = reader(data)
  const base = r.at(0)
  const count = r.at(base)
  if (count > 10_000n) throw new ChainError('fatal', 'invalid_return_data')
  const head = base + 32n
  const out: { success: boolean; data: string }[] = []
  for (let i = 0n; i < count; i++) {
    const tuple = head + r.at(head + 32n * i)
    const flag = r.at(tuple)
    if (flag > 1n) throw new ChainError('fatal', 'invalid_return_data')
    const at = tuple + r.at(tuple + 32n)
    out.push({ success: flag === 1n, data: r.slice(at + 32n, r.at(at)) })
  }
  return out
}

/** A 32-byte word as an address, refusing anything with bits above 160. */
export function asAddress(value: bigint): string {
  if (value >> 160n !== 0n) throw new ChainError('fatal', 'invalid_return_data')
  return `0x${value.toString(16).padStart(40, '0')}`
}

/** int24 from its two's-complement word. */
export function asInt24(value: bigint): number {
  const signed = value >> 255n === 1n ? value - (1n << 256n) : value
  if (signed < -(1n << 23n) || signed >= 1n << 23n) throw new ChainError('fatal', 'invalid_return_data')
  return Number(signed)
}

// ---------------------------------------------------------------------------
// Keccak-256 (the original Keccak padding, as Solidity's keccak256), on 64-bit lanes: owned.ts's, copied for the
// second chain's signer (a contract's code hash against its pin), held equal to it and to viem by the tests.
// ---------------------------------------------------------------------------


const MASK64 = (1n << 64n) - 1n
const ROUND_CONSTANTS = [
  '0000000000000001', '0000000000008082', '800000000000808a', '8000000080008000', '000000000000808b', '0000000080000001',
  '8000000080008081', '8000000000008009', '000000000000008a', '0000000000000088', '0000000080008009', '000000008000000a',
  '000000008000808b', '800000000000008b', '8000000000008089', '8000000000008003', '8000000000008002', '8000000000000080',
  '000000000000800a', '800000008000000a', '8000000080008081', '8000000000008080', '0000000080000001', '8000000080008008',
].map((value) => BigInt(`0x${value}`))
const ROTATIONS = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44].map(BigInt)
const LANES = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1]

const rotl = (x: bigint, n: bigint) => ((x << n) | (x >> (64n - n))) & MASK64

function permute(state: bigint[]) {
  const c: bigint[] = [0n, 0n, 0n, 0n, 0n]
  for (const constant of ROUND_CONSTANTS) {
    for (let x = 0; x < 5; x++) c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20]
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1n)
      for (let y = 0; y < 25; y += 5) state[y + x] ^= d
    }
    let carried = state[1]
    for (let i = 0; i < 24; i++) {
      const lane = LANES[i]
      const next = state[lane]
      state[lane] = rotl(carried, ROTATIONS[i])
      carried = next
    }
    for (let y = 0; y < 25; y += 5) {
      const row = state.slice(y, y + 5)
      for (let x = 0; x < 5; x++) state[y + x] = row[x] ^ (~row[(x + 1) % 5] & MASK64 & row[(x + 2) % 5])
    }
    state[0] ^= constant
  }
}

/** keccak256 of the bytes `data` (hex, with or without 0x), as 0x-prefixed lowercase hex. */
export function keccak256(data: string): string {
  const body = data.startsWith('0x') ? data.slice(2) : data
  const bytes: number[] = []
  for (let i = 0; i < body.length; i += 2) bytes.push(Number.parseInt(body.slice(i, i + 2), 16))
  const rate = 136
  bytes.push(0x01)
  while (bytes.length % rate !== 0) bytes.push(0)
  bytes[bytes.length - 1] |= 0x80
  const state: bigint[] = Array.from({ length: 25 }, () => 0n)
  for (let block = 0; block < bytes.length; block += rate) {
    for (let lane = 0; lane < rate / 8; lane++) {
      let value = 0n
      for (let b = 7; b >= 0; b--) value = (value << 8n) | BigInt(bytes[block + lane * 8 + b])
      state[lane] ^= value
    }
    permute(state)
  }
  let out = ''
  for (let lane = 0; lane < 4; lane++) {
    for (let b = 0; b < 8; b++) out += Number((state[lane] >> BigInt(8 * b)) & 0xffn).toString(16).padStart(2, '0')
  }
  return `0x${out}`
}
