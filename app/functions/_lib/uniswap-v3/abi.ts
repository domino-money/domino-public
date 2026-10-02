/**
 * Uniswap v3 and Domino's v3 vault, by hand (2026-10-01, the chain2 workstream, audit items G7 and G8): the selectors,
 * calldata and return decoders the second chain's reads need, and the topics of the events they read.
 *
 * Like functions/_lib/owned.ts (whose aggregate3 encoding and reader words.ts copies), this is chain code the page
 * imports: pure, Node-safe, no DOM, no build flag, no network. Every selector and topic is a hex literal checked against
 * viem in tests/elysium-chain.test.mjs. The v3 contracts are Uniswap's core 1.0.1 and periphery 1.4.4 (rugged97's
 * registry reference); the vault is rugged97's contracts-v3/src/DominoUniV3Vault.sol at 7d190690, whose public getters
 * these decode. Every decoder refuses data that is not exactly what the getter returns (a word past its type's bits,
 * a short reply), rather than reading a number out of something else.
 */
import { ChainError, addressWord, asAddress, asInt24, reader, word } from './words'

/** Function selectors, without 0x. */
export const V3_SELECTOR = {
  // UniswapV3Pool
  slot0: '3850c7bd',
  liquidity: '1a686502',
  token0: '0dfe1681',
  token1: 'd21220a7',
  fee: 'ddca3f43',
  tickSpacing: 'd0c93a7c',
  factory: 'c45a0155',
  feeGrowthGlobal0X128: 'f3058399',
  feeGrowthGlobal1X128: '46141319',
  ticks: 'f30dba93',
  // NonfungiblePositionManager (and the vault's own positions(uint256), the same selector over another struct)
  positions: '99fbab88',
  balanceOf: '70a08231',
  tokenOfOwnerByIndex: '2f745c59',
  ownerOf: '6352211e',
  // UniswapV3Factory
  getPool: '1698ee82',
  // ERC-20
  symbol: '95d89b41',
  decimals: '313ce567',
  // DominoUniV3Vault
  owner: '8da5cb5b',
  pool: '16f0115b',
  poolFee: '089fe6aa',
  paused: '5c975abb',
  operator: '570ca735',
  positionCount: 'e7702d05',
  positionIds: '939c5f7a',
  activePositions: '297add9d',
  capital: '7905c05f',
  policy: '0505c8c9',
  policyVersion: '58355ead',
  deployment: '2dde9aca',
  // Multicall3 and Nitro's ArbSys: the block a call at 'latest' ran at, and its time (block.number on Nitro is the parent's)
  getCurrentBlockTimestamp: '0f28c97d',
  arbBlockNumber: 'a3b1b31d',
} as const

/** keccak256 of each event signature (topic0). */
export const V3_TOPIC = {
  /** UniswapV3Factory PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool) */
  PoolCreated: '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118',
  /** UniswapV3Pool Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick) */
  Swap: '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
  /** ERC-721 Transfer(address indexed from, address indexed to, uint256 indexed tokenId) */
  Transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
} as const

/** The vault's events (DominoUniV3Vault.sol), by name. */
export const VAULT_TOPIC = {
  PositionOpened: '0x7d0e8724081800bb6e83f71bfba54e13232b60f41079333a15ece9c610966cb7',
  FeesCollected: '0x0b6bc262099857a8715e57a7296f19ea7d2fb73a7248b4dbc3dcb57a62f20226',
  FeesConsumed: '0x4f3d2c4ed84b60aeb1fafe31d1651c4129519488526480ebbc90f817ec4b6949',
  Converted: '0x1f72cde9726a647c7fa57d8a1096d9708f4b2ac7bd9603c4ed3f5d78142f4e57',
  Compounded: '0x0fdd397337df0e5d4aea58e96cf0eb935f157f9973ada9d3d585806f429d7637',
  PositionReleased: '0x94f5d78cc156f16b1ffeda83bcfb152755bb71ee7d310c45210963cdd503dc25',
  CapitalReduced: '0xe6a23dac501624b8f8a94a869f26b7de1b05330475eac4af5041d6e880f0f8f4',
  PolicyChanged: '0x2e62277ddf813aa39feaa4b8f6679956a99be6b3a7435a375dcc52a9c3f0b196',
  Paused: '0x0e2fb031ee032dc02d8011dc50b816eb450cf856abd8261680dac74f72165bd2',
  ReserveWithdrawn: '0x53cf382922e758ed63dfaea0dcd7e0fee5fc4b8aa32a775283f6a31f029faa54',
  CapitalWithdrawn: '0xfd282af50c2a0af33f26b6abcc27c8bae5fc57dc3f7ce9b71612b4cd6db59ca0',
  SurplusRecovered: '0x8d062d570e15e665f57873e5745c84e024c3b6a4c94cfcda6af54a9ccd416af7',
  UnmanagedNFTRecovered: '0x9ef6d787b73f367ac3324c6f4c47fe3cf8eb79e872ef25038473f5f78a576017',
} as const

export type VaultEventName = keyof typeof VAULT_TOPIC

const MAX_UINT = (bits: number) => (1n << BigInt(bits)) - 1n
const invalid = () => new ChainError('fatal', 'invalid_return_data')

/** Calldata, without 0x: a selector and its static arguments as words. */
export const calldata = (selector: string, ...args: string[]) => selector + args.join('')
export const uintArg = (n: bigint | number) => word(BigInt(n))
export const addressArg = (address: string) => addressWord(address)
/** An int24 as its two's-complement word. */
export const int24Arg = (n: number) => word(BigInt(n))

/** A word as an unsigned integer of `bits`, refusing anything above them. */
export function asUint(value: bigint, bits: number): bigint {
  if (value < 0n || value > MAX_UINT(bits)) throw invalid()
  return value
}

/** A word as a signed integer of `bits` (two's complement), refusing anything outside it. */
export function asInt(value: bigint, bits: number): bigint {
  const signed = value >> 255n === 1n ? value - (1n << 256n) : value
  const bound = 1n << BigInt(bits - 1)
  if (signed < -bound || signed >= bound) throw invalid()
  return signed
}

export function asBool(value: bigint): boolean {
  if (value > 1n) throw invalid()
  return value === 1n
}

/** The words of a static return, refusing a reply shorter than `count` of them. */
function words(data: string, count: number): bigint[] {
  const r = reader(data)
  if (r.bytes < count * 32) throw invalid()
  return Array.from({ length: count }, (_, i) => r.at(i * 32))
}

export const decodeUint = (data: string, bits = 256): bigint => asUint(words(data, 1)[0], bits)
export const decodeAddress = (data: string): string => asAddress(words(data, 1)[0])
export const decodeBool = (data: string): boolean => asBool(words(data, 1)[0])
export const decodeInt24 = (data: string): number => asInt24(words(data, 1)[0])

export interface Slot0 {
  sqrtPriceX96: bigint
  tick: number
  feeProtocol: number
  unlocked: boolean
}

/** UniswapV3Pool.slot0(): seven words, of which the price, the tick, the protocol fee and the lock are read. */
export function decodeSlot0(data: string): Slot0 {
  const w = words(data, 7)
  return { sqrtPriceX96: asUint(w[0], 160), tick: asInt24(w[1]), feeProtocol: Number(asUint(w[5], 8)), unlocked: asBool(w[6]) }
}

export interface TickInfo {
  liquidityGross: bigint
  liquidityNet: bigint
  feeGrowthOutside0X128: bigint
  feeGrowthOutside1X128: bigint
  initialized: boolean
}

/** UniswapV3Pool.ticks(int24): eight words. */
export function decodeTick(data: string): TickInfo {
  const w = words(data, 8)
  return {
    liquidityGross: asUint(w[0], 128),
    liquidityNet: asInt(w[1], 128),
    feeGrowthOutside0X128: w[2],
    feeGrowthOutside1X128: w[3],
    initialized: asBool(w[7]),
  }
}

export interface NfpmPosition {
  operator: string
  token0: string
  token1: string
  fee: number
  tickLower: number
  tickUpper: number
  liquidity: bigint
  feeGrowthInside0LastX128: bigint
  feeGrowthInside1LastX128: bigint
  tokensOwed0: bigint
  tokensOwed1: bigint
}

/** NonfungiblePositionManager.positions(uint256): twelve words. */
export function decodeNfpmPosition(data: string): NfpmPosition {
  const w = words(data, 12)
  asUint(w[0], 96)
  const position = {
    operator: asAddress(w[1]),
    token0: asAddress(w[2]),
    token1: asAddress(w[3]),
    fee: Number(asUint(w[4], 24)),
    tickLower: asInt24(w[5]),
    tickUpper: asInt24(w[6]),
    liquidity: asUint(w[7], 128),
    feeGrowthInside0LastX128: w[8],
    feeGrowthInside1LastX128: w[9],
    tokensOwed0: asUint(w[10], 128),
    tokensOwed1: asUint(w[11], 128),
  }
  if (position.tickLower >= position.tickUpper) throw invalid()
  return position
}

export interface VaultPositionState {
  known: boolean
  active: boolean
  generation: bigint
  parent: bigint
  tickLower: number
  tickUpper: number
  liquidity: bigint
}

/** DominoUniV3Vault.positions(uint256): the T.Position struct, ten words, of which the identity and sources are not read. */
export function decodeVaultPosition(data: string): VaultPositionState {
  const w = words(data, 10)
  return {
    known: asBool(w[0]),
    active: asBool(w[1]),
    generation: asUint(w[2], 64),
    parent: w[3],
    tickLower: asInt24(w[4]),
    tickUpper: asInt24(w[5]),
    liquidity: asUint(w[6], 128),
  }
}

export interface VaultPolicy {
  serviceFeeBps: number
  maxPositions: number
  allowSwap: boolean
  allowSuccessor: boolean
  validUntil: number
}

/** DominoUniV3Vault.policy(): the T.Policy struct, eleven words, of which what a person reads is kept. */
export function decodeVaultPolicy(data: string): VaultPolicy {
  const w = words(data, 11)
  return {
    serviceFeeBps: Number(asUint(w[0], 16)),
    maxPositions: Number(asUint(w[1], 16)),
    validUntil: Number(asUint(w[6], 64)),
    allowSwap: asBool(w[7]),
    allowSuccessor: asBool(w[8]),
  }
}

export interface VaultDeployment {
  factory: string
  manager: string
  router: string
  wrappedNative: string
  feeRecipient: string
  decimals0: number
  decimals1: number
}

/**
 * DominoUniV3Vault.deployment(): the T.Deployment struct, sixteen static words: six addresses (factory, the position
 * manager, router, price guard, wrapped native, fee recipient), eight code hashes, then both tokens' decimals.
 */
export function decodeVaultDeployment(data: string): VaultDeployment {
  const w = words(data, 16)
  const decimals0 = Number(asUint(w[14], 8))
  const decimals1 = Number(asUint(w[15], 8))
  if (decimals0 > 36 || decimals1 > 36) throw invalid()
  return { factory: asAddress(w[0]), manager: asAddress(w[1]), router: asAddress(w[2]), wrappedNative: asAddress(w[4]), feeRecipient: asAddress(w[5]), decimals0, decimals1 }
}

/** A token's symbol: an ABI string, or a bytes32 some old tokens return; null for anything else or past 32 characters. */
export function decodeSymbol(data: string): string | null {
  try {
    const r = reader(data)
    if (r.bytes === 32) return bytes32Text(r.slice(0, 32))
    const offset = r.at(0)
    const length = r.at(offset)
    if (length > 64n) return null
    return printable(hexToText(r.slice(offset + 32n, length)))
  } catch {
    return null
  }
}

function hexToText(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

/** A bytes32 symbol: its bytes up to the trailing zeros, as UTF-8. */
function bytes32Text(hex: string): string | null {
  const trimmed = hex.replace(/(?:00)+$/, '')
  if (trimmed.length === 0) return null
  try {
    return printable(hexToText(trimmed))
  } catch {
    return null
  }
}

/** Control characters, zero-width and bidirectional marks: never written on a page, even inside a symbol. */
function unprintable(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
}

/** A symbol a page may write: 1 to 32 printable characters, trimmed; else null. */
function printable(text: string): string | null {
  const trimmed = text.trim()
  const points = [...trimmed]
  if (points.length === 0 || points.length > 32 || points.some((point) => unprintable(point.codePointAt(0) ?? 0))) return null
  return trimmed
}

/** A token's decimals: uint8, at most 36 (rugged97's contracts refuse more); else null. */
export function decodeDecimals(data: string): number | null {
  try {
    const value = decodeUint(data, 8)
    return value <= 36n ? Number(value) : null
  } catch {
    return null
  }
}

// --- Events -----------------------------------------------------------------------------------------------------------

/** A topic as an address, refusing anything with bits above 160. */
export const topicAddress = (topic: string): string => asAddress(BigInt(topic))

export interface PoolCreated {
  token0: string
  token1: string
  fee: number
  tickSpacing: number
  pool: string
}

/** PoolCreated's indexed tokens and fee, and its data: the tick spacing and the pool. */
export function decodePoolCreated(log: { topics: readonly string[]; data: string }): PoolCreated {
  if (log.topics.length !== 4 || log.topics[0] !== V3_TOPIC.PoolCreated) throw invalid()
  const w = words(log.data, 2)
  return {
    token0: topicAddress(log.topics[1]),
    token1: topicAddress(log.topics[2]),
    fee: Number(asUint(BigInt(log.topics[3]), 24)),
    tickSpacing: asInt24(w[0]),
    pool: asAddress(w[1]),
  }
}

export interface SwapEvent {
  amount0: bigint
  amount1: bigint
  sqrtPriceX96: bigint
  liquidity: bigint
  tick: number
}

/** A pool's Swap: the signed amounts the pool received (positive) or paid (negative), and the price after it. */
export function decodeSwap(log: { topics: readonly string[]; data: string }): SwapEvent {
  if (log.topics.length !== 3 || log.topics[0] !== V3_TOPIC.Swap) throw invalid()
  const w = words(log.data, 5)
  return { amount0: asInt(w[0], 256), amount1: asInt(w[1], 256), sqrtPriceX96: asUint(w[2], 160), liquidity: asUint(w[3], 128), tick: asInt24(w[4]) }
}

/** The vault event a log is, by its topic, or null for one this app does not name. */
export function vaultEventOf(topic: string): VaultEventName | null {
  for (const [name, value] of Object.entries(VAULT_TOPIC)) if (value === topic.toLowerCase()) return name as VaultEventName
  return null
}
