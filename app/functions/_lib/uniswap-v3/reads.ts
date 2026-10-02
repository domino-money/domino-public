/**
 * The second chain's reads, from its public RPC (2026-10-01, the chain2 workstream, audit items G7 and G8): pools and
 * their state, a pool's swaps, positions held by a wallet or by a Domino vault, the vaults a wallet owns, and a vault's
 * own events, each at one block whose number and time come back with the figures.
 *
 * Why here: rugged97's read API (uniswap-v3-read-v1) has no pool list, no TVL, volume or USD, and no search of vaults by
 * owner; the chain answers all of these to anyone (its RPC allows CORS from any origin), so the page reads them itself,
 * like it reads Robinhood Chain (functions/_lib/owned.ts, walletPositions.ts, fees.ts: chain code the page imports).
 *
 * - Every state read is one Multicall3 aggregate3 eth_call, every sub-call allowed to fail, with Nitro's
 *   ArbSys.arbBlockNumber() and Multicall3.getCurrentBlockTimestamp() among its sub-calls: the figures and the block and
 *   time they are shown with come from the same call (on Nitro, block.number is the parent chain's).
 * - The reader is handed in (src/lib/chain/client.ts createChainClient): it reaches only the chain's own RPC, checks the
 *   chain id, paces every call and reads logs in windows. Nothing here knows a URL.
 * - What is read is checked as strictly as it is decoded (abi.ts): a pool whose tokens are out of order, or not the
 *   tokens its factory registered, a vault whose pool is not its tokens', a position whose ticks are reversed, is refused,
 *   not shown. A sub-call that failed is null, never zero.
 *
 * Pure, Node-safe: no DOM, no build flag, no storage, no network of its own.
 */
import type { ChainConfig } from '../../../src/config/chainKit'
import { ChainError, decodeAggregate3, encodeAggregate3, hex, type SubCall } from './words'
import {
  V3_SELECTOR as S,
  V3_TOPIC,
  VAULT_TOPIC,
  addressArg,
  calldata,
  decodeAddress,
  decodeBool,
  decodeDecimals,
  decodeInt24,
  decodeNfpmPosition,
  decodePoolCreated,
  decodeSlot0,
  decodeSwap,
  decodeSymbol,
  decodeTick,
  decodeUint,
  decodeVaultDeployment,
  decodeVaultPolicy,
  decodeVaultPosition,
  int24Arg,
  uintArg,
  vaultEventOf,
  type NfpmPosition,
  type PoolCreated,
  type Slot0,
  type TickInfo,
  type VaultDeployment,
  type VaultEventName,
  type VaultPolicy,
  type VaultPositionState,
} from './abi'

/** A log as the chain reader returns it (src/lib/chain/client.ts RawLog). */
export interface ChainLog {
  address: string
  topics: string[]
  data: string
  blockNumber: number
  blockHash: string
  transactionHash: string
  transactionIndex: number
  logIndex: number
}

/** What these reads need of the chain: one JSON-RPC call, and logs over a range. */
export interface ChainReader {
  call(method: string, params: readonly unknown[], signal?: AbortSignal): Promise<unknown>
  logs(filter: { address: string | readonly string[]; topics: ReadonlyArray<string | readonly string[] | null> }, from: number, to: number | 'latest', signal?: AbortSignal): Promise<ChainLog[]>
}

/** The block a set of figures was read at, and its time (seconds). */
export interface Stamp {
  block: number
  timestamp: number
}

/** The most sub-calls one aggregate3 carries (well under the RPC's reply cap). */
export const MAX_SUBCALLS = 120
/** The most positions read for one owner, and the most vault positions read per vault (its MAX_HISTORY is 32). */
export const MAX_WALLET_POSITIONS = 50
export const MAX_VAULT_POSITIONS = 32
/** The most vaults whose owner is asked in one read. */
export const MAX_VAULTS = 500

const ADDRESS = /^0x[0-9a-f]{40}$/
const ZERO = '0x0000000000000000000000000000000000000000'
const invalid = (what: string) => new ChainError('fatal', `invalid_${what}`)
const lower = (address: string) => address.toLowerCase()

export function checkAddress(address: string, what = 'address'): string {
  const value = lower(address)
  if (!ADDRESS.test(value) || value === ZERO) throw invalid(what)
  return value
}

/** One aggregate3 at `block`, every sub-call allowed to fail: one result per sub-call, data without 0x. */
export async function aggregate(reader: ChainReader, chain: ChainConfig, calls: readonly SubCall[], block: number | 'latest', signal?: AbortSignal) {
  if (calls.length === 0) return []
  if (calls.length > MAX_SUBCALLS) throw invalid('call_count')
  const result = await reader.call('eth_call', [{ to: chain.multicall3, data: encodeAggregate3(calls) }, block === 'latest' ? 'latest' : hex(block)], signal)
  if (typeof result !== 'string') throw invalid('call_result')
  const decoded = decodeAggregate3(result)
  if (decoded.length !== calls.length) throw invalid('call_result')
  return decoded
}

/**
 * `calls` read in one aggregate3 with the block and its time among them (the chain's ArbSys, or nothing where the chain
 * has none: then the stamp is null and the figures are refused, since a figure must show its block).
 */
export async function stamped(reader: ChainReader, chain: ChainConfig, calls: readonly SubCall[], block: number | 'latest', signal?: AbortSignal) {
  if (!chain.arbSys) throw invalid('chain_without_block_source')
  const all = [...calls, { target: chain.arbSys, data: S.arbBlockNumber }, { target: chain.multicall3, data: S.getCurrentBlockTimestamp }]
  const results = await aggregate(reader, chain, all, block, signal)
  const [number, time] = results.slice(-2)
  if (!number.success || !time.success) throw invalid('stamp')
  const stamp: Stamp = { block: Number(decodeUint(number.data, 64)), timestamp: Number(decodeUint(time.data, 64)) }
  if (!Number.isSafeInteger(stamp.block) || !Number.isSafeInteger(stamp.timestamp) || stamp.block <= 0 || stamp.timestamp <= 0) throw invalid('stamp')
  return { results: results.slice(0, -2), stamp }
}

/** A sub-call's result decoded, or null when it failed or does not decode. */
function maybe<T>(result: { success: boolean; data: string } | undefined, decode: (data: string) => T): T | null {
  if (!result?.success) return null
  try {
    return decode(result.data)
  } catch {
    return null
  }
}

/** A sub-call's result decoded, refusing the whole read when it failed or does not decode. */
function must<T>(result: { success: boolean; data: string } | undefined, decode: (data: string) => T, what: string): T {
  const value = maybe(result, decode)
  if (value === null) throw invalid(what)
  return value
}

// --- Tokens ---------------------------------------------------------------------------------------------------------

export interface TokenMeta {
  address: string
  symbol: string | null
  decimals: number | null
}

/** Each token's symbol and decimals, in one aggregate3; a token that answers neither keeps nulls. */
export async function readTokens(reader: ChainReader, chain: ChainConfig, addresses: readonly string[], signal?: AbortSignal): Promise<Map<string, TokenMeta>> {
  const tokens = [...new Set(addresses.map((address) => checkAddress(address, 'token')))]
  const out = new Map<string, TokenMeta>()
  for (let at = 0; at < tokens.length; at += MAX_SUBCALLS / 2) {
    const slice = tokens.slice(at, at + MAX_SUBCALLS / 2)
    const results = await aggregate(reader, chain, slice.flatMap((target) => [{ target, data: S.symbol }, { target, data: S.decimals }]), 'latest', signal)
    slice.forEach((address, i) => out.set(address, { address, symbol: maybe(results[i * 2], decodeSymbol), decimals: maybe(results[i * 2 + 1], decodeDecimals) }))
  }
  return out
}

// --- Pools ----------------------------------------------------------------------------------------------------------

export interface PoolRead {
  address: string
  factory: string
  token0: TokenMeta
  token1: TokenMeta
  fee: number
  tickSpacing: number
  slot0: Slot0
  liquidity: bigint
  feeGrowthGlobal0X128: bigint
  feeGrowthGlobal1X128: bigint
  /** The pool's own token balances: what it holds, liquidity and uncollected fees together. Null where unread. */
  balance0: bigint | null
  balance1: bigint | null
  stamp: Stamp
}

const POOL_CALLS = 9

/** Each pool's identity and state at one block, then its tokens. A pool that does not answer as a v3 pool is refused. */
export async function readPools(reader: ChainReader, chain: ChainConfig, pools: readonly string[], signal?: AbortSignal): Promise<PoolRead[]> {
  const addresses = [...new Set(pools.map((pool) => checkAddress(pool, 'pool')))]
  if (addresses.length === 0) return []
  if (addresses.length * POOL_CALLS > MAX_SUBCALLS - 2) throw invalid('pool_count')
  const { results, stamp } = await stamped(
    reader,
    chain,
    addresses.flatMap((target) => [
      { target, data: S.factory },
      { target, data: S.token0 },
      { target, data: S.token1 },
      { target, data: S.fee },
      { target, data: S.tickSpacing },
      { target, data: S.slot0 },
      { target, data: S.liquidity },
      { target, data: S.feeGrowthGlobal0X128 },
      { target, data: S.feeGrowthGlobal1X128 },
    ]),
    'latest',
    signal,
  )
  const raw = addresses.map((address, i) => {
    const r = results.slice(i * POOL_CALLS, (i + 1) * POOL_CALLS)
    const token0 = must(r[1], decodeAddress, 'pool')
    const token1 = must(r[2], decodeAddress, 'pool')
    if (token0 >= token1) throw invalid('pool')
    return {
      address,
      factory: must(r[0], decodeAddress, 'pool'),
      token0,
      token1,
      fee: Number(must(r[3], (data) => decodeUint(data, 24), 'pool')),
      tickSpacing: must(r[4], decodeInt24, 'pool'),
      slot0: must(r[5], decodeSlot0, 'pool'),
      liquidity: must(r[6], (data) => decodeUint(data, 128), 'pool'),
      feeGrowthGlobal0X128: must(r[7], (data) => decodeUint(data), 'pool'),
      feeGrowthGlobal1X128: must(r[8], (data) => decodeUint(data), 'pool'),
    }
  })
  // The balances at the same block as the state, and every token's metadata.
  const balances = await aggregate(reader, chain, raw.flatMap((pool) => [{ target: pool.token0, data: calldata(S.balanceOf, addressArg(pool.address)) }, { target: pool.token1, data: calldata(S.balanceOf, addressArg(pool.address)) }]), stamp.block, signal)
  const tokens = await readTokens(reader, chain, raw.flatMap((pool) => [pool.token0, pool.token1]), signal)
  return raw.map((pool, i) => ({
    ...pool,
    token0: tokens.get(pool.token0) ?? { address: pool.token0, symbol: null, decimals: null },
    token1: tokens.get(pool.token1) ?? { address: pool.token1, symbol: null, decimals: null },
    balance0: maybe(balances[i * 2], (data) => decodeUint(data)),
    balance1: maybe(balances[i * 2 + 1], (data) => decodeUint(data)),
    stamp,
  }))
}

/** A factory's pools, from its PoolCreated logs since `fromBlock`, oldest first. */
export async function discoverPools(reader: ChainReader, factory: string, fromBlock: number, signal?: AbortSignal): Promise<PoolCreated[]> {
  const logs = await reader.logs({ address: checkAddress(factory, 'factory'), topics: [V3_TOPIC.PoolCreated] }, fromBlock, 'latest', signal)
  return logs.map((log) => decodePoolCreated(log))
}

export interface PoolActivity {
  swaps: number
  /** What swappers paid into the pool, per token, raw. */
  in0: bigint
  in1: bigint
  fromBlock: number
  toBlock: number
  /** The first and last swap's blocks, or null with none. */
  first: number | null
  last: number | null
}

/** A pool's swaps over [fromBlock, toBlock]: how many, and what was paid in of each token. */
export async function poolActivity(reader: ChainReader, pool: string, fromBlock: number, toBlock: number, signal?: AbortSignal): Promise<PoolActivity> {
  const logs = await reader.logs({ address: checkAddress(pool, 'pool'), topics: [V3_TOPIC.Swap] }, fromBlock, toBlock, signal)
  let in0 = 0n
  let in1 = 0n
  for (const log of logs) {
    const swap = decodeSwap(log)
    if (swap.amount0 > 0n) in0 += swap.amount0
    if (swap.amount1 > 0n) in1 += swap.amount1
  }
  return { swaps: logs.length, in0, in1, fromBlock, toBlock, first: logs[0]?.blockNumber ?? null, last: logs.at(-1)?.blockNumber ?? null }
}

/** The pool a factory registered for two tokens and a fee, or null. */
export async function poolFor(reader: ChainReader, chain: ChainConfig, factory: string, tokenA: string, tokenB: string, fee: number, signal?: AbortSignal): Promise<string | null> {
  const [a, b] = [checkAddress(tokenA, 'token'), checkAddress(tokenB, 'token')].sort()
  const [result] = await aggregate(reader, chain, [{ target: checkAddress(factory, 'factory'), data: calldata(S.getPool, addressArg(a), addressArg(b), uintArg(fee)) }], 'latest', signal)
  const pool = maybe(result, decodeAddress)
  return pool && pool !== ZERO ? pool : null
}

// --- Positions --------------------------------------------------------------------------------------------------------

export interface PositionRead {
  tokenId: bigint
  owner: string | null
  manager: string
  position: NfpmPosition
  pool: string
  slot0: Slot0
  feeGrowthGlobal0X128: bigint
  feeGrowthGlobal1X128: bigint
  lower: TickInfo
  upper: TickInfo
  stamp: Stamp
}

/**
 * One position NFT and what its fees and amounts need, at one block: the manager's position, its owner, the pool's
 * price, fee growth and both range ticks. The pool is the factory's for the position's tokens and fee, read first.
 */
export async function readPosition(reader: ChainReader, chain: ChainConfig, manager: string, tokenId: bigint, signal?: AbortSignal): Promise<PositionRead> {
  const nfpm = checkAddress(manager, 'manager')
  if (tokenId <= 0n) throw invalid('token_id')
  const id = uintArg(tokenId)
  const first = await aggregate(reader, chain, [{ target: nfpm, data: calldata(S.positions, id) }, { target: nfpm, data: calldata(S.ownerOf, id) }, { target: nfpm, data: S.factory }], 'latest', signal)
  const position = must(first[0], decodeNfpmPosition, 'position')
  const owner = maybe(first[1], decodeAddress)
  const factory = must(first[2], decodeAddress, 'manager')
  const pool = await poolFor(reader, chain, factory, position.token0, position.token1, position.fee, signal)
  if (!pool) throw invalid('position_pool')
  const { results, stamp } = await stamped(
    reader,
    chain,
    [
      { target: nfpm, data: calldata(S.positions, id) },
      { target: pool, data: S.slot0 },
      { target: pool, data: S.feeGrowthGlobal0X128 },
      { target: pool, data: S.feeGrowthGlobal1X128 },
      { target: pool, data: calldata(S.ticks, int24Arg(position.tickLower)) },
      { target: pool, data: calldata(S.ticks, int24Arg(position.tickUpper)) },
    ],
    'latest',
    signal,
  )
  // The position again, at the stamped block: the fees are worked out from one block's state, never two.
  return {
    tokenId,
    owner,
    manager: nfpm,
    position: must(results[0], decodeNfpmPosition, 'position'),
    pool,
    slot0: must(results[1], decodeSlot0, 'pool'),
    feeGrowthGlobal0X128: must(results[2], (data) => decodeUint(data), 'pool'),
    feeGrowthGlobal1X128: must(results[3], (data) => decodeUint(data), 'pool'),
    lower: must(results[4], decodeTick, 'tick'),
    upper: must(results[5], decodeTick, 'tick'),
    stamp,
  }
}

/** The position NFTs a wallet holds itself (ERC-721 enumerable), newest index last, at most MAX_WALLET_POSITIONS. */
export async function walletTokenIds(reader: ChainReader, chain: ChainConfig, manager: string, owner: string, signal?: AbortSignal): Promise<bigint[]> {
  const nfpm = checkAddress(manager, 'manager')
  const who = checkAddress(owner, 'owner')
  const [count] = await aggregate(reader, chain, [{ target: nfpm, data: calldata(S.balanceOf, addressArg(who)) }], 'latest', signal)
  const total = Number(must(count, (data) => decodeUint(data, 64), 'balance'))
  const n = Math.min(total, MAX_WALLET_POSITIONS)
  if (n === 0) return []
  const ids = await aggregate(reader, chain, Array.from({ length: n }, (_, i) => ({ target: nfpm, data: calldata(S.tokenOfOwnerByIndex, addressArg(who), uintArg(i)) })), 'latest', signal)
  return ids.map((result) => must(result, (data) => decodeUint(data), 'token_id'))
}

// --- Vaults -----------------------------------------------------------------------------------------------------------

/** Of `vaults`, the ones whose owner() is `owner` (the owner is public and immutable in the vault). */
export async function vaultsOwnedBy(reader: ChainReader, chain: ChainConfig, vaults: readonly string[], owner: string, signal?: AbortSignal): Promise<string[]> {
  const who = checkAddress(owner, 'owner')
  const list = [...new Set(vaults.map((vault) => checkAddress(vault, 'vault')))]
  if (list.length > MAX_VAULTS) throw invalid('vault_count')
  const mine: string[] = []
  for (let at = 0; at < list.length; at += MAX_SUBCALLS) {
    const slice = list.slice(at, at + MAX_SUBCALLS)
    const results = await aggregate(reader, chain, slice.map((target) => ({ target, data: S.owner })), 'latest', signal)
    slice.forEach((vault, i) => {
      if (maybe(results[i], decodeAddress) === who) mine.push(vault)
    })
  }
  return mine
}

export interface VaultRead {
  address: string
  owner: string
  pool: string
  token0: string
  token1: string
  fee: number
  tickSpacing: number
  paused: boolean
  operator: string
  policy: VaultPolicy | null
  policyVersion: bigint
  deployment: VaultDeployment
  /** The vault's positions (their NFTs stay in the vault's custody while active), oldest first. */
  positions: Array<{ tokenId: bigint; state: VaultPositionState }>
  /** Its capital not in a position, per token (the vault's `capital`). */
  capital0: bigint | null
  capital1: bigint | null
  stamp: Stamp
}

const VAULT_CALLS = 12

/** A vault's settings and positions at one block. A vault whose pool is not the factory's for its tokens is refused. */
export async function readVault(reader: ChainReader, chain: ChainConfig, vault: string, signal?: AbortSignal): Promise<VaultRead> {
  const target = checkAddress(vault, 'vault')
  const { results, stamp } = await stamped(
    reader,
    chain,
    [
      { target, data: S.owner },
      { target, data: S.pool },
      { target, data: S.token0 },
      { target, data: S.token1 },
      { target, data: S.poolFee },
      { target, data: S.tickSpacing },
      { target, data: S.paused },
      { target, data: S.operator },
      { target, data: S.policy },
      { target, data: S.policyVersion },
      { target, data: S.deployment },
      { target, data: S.positionCount },
    ],
    'latest',
    signal,
  )
  if (results.length !== VAULT_CALLS) throw invalid('vault')
  const base = {
    address: target,
    owner: must(results[0], decodeAddress, 'vault'),
    pool: must(results[1], decodeAddress, 'vault'),
    token0: must(results[2], decodeAddress, 'vault'),
    token1: must(results[3], decodeAddress, 'vault'),
    fee: Number(must(results[4], (data) => decodeUint(data, 24), 'vault')),
    tickSpacing: must(results[5], decodeInt24, 'vault'),
    paused: must(results[6], decodeBool, 'vault'),
    operator: must(results[7], decodeAddress, 'vault'),
    policy: maybe(results[8], decodeVaultPolicy),
    policyVersion: must(results[9], (data) => decodeUint(data, 64), 'vault'),
    deployment: must(results[10], decodeVaultDeployment, 'vault'),
  }
  if (base.token0 >= base.token1) throw invalid('vault')
  const count = Math.min(Number(must(results[11], (data) => decodeUint(data, 64), 'vault')), MAX_VAULT_POSITIONS)
  // The positions' ids and states, and the capital, at the same block; the pool is the factory's for the vault's tokens.
  const second = await aggregate(
    reader,
    chain,
    [
      { target: base.deployment.factory, data: calldata(S.getPool, addressArg(base.token0), addressArg(base.token1), uintArg(base.fee)) },
      { target, data: calldata(S.capital, addressArg(base.token0)) },
      { target, data: calldata(S.capital, addressArg(base.token1)) },
      ...Array.from({ length: count }, (_, i) => ({ target, data: calldata(S.positionIds, uintArg(i)) })),
    ],
    stamp.block,
    signal,
  )
  if (must(second[0], decodeAddress, 'vault_pool') !== base.pool) throw invalid('vault_pool')
  const ids = second.slice(3).map((result) => must(result, (data) => decodeUint(data), 'vault_position'))
  const states = ids.length ? await aggregate(reader, chain, ids.map((id) => ({ target, data: calldata(S.positions, uintArg(id)) })), stamp.block, signal) : []
  return {
    ...base,
    positions: ids.map((tokenId, i) => ({ tokenId, state: must(states[i], decodeVaultPosition, 'vault_position') })),
    capital0: maybe(second[1], (data) => decodeUint(data)),
    capital1: maybe(second[2], (data) => decodeUint(data)),
    stamp,
  }
}

export interface VaultEvent {
  kind: VaultEventName
  block: number
  transactionHash: string
  logIndex: number
  /** The position NFT the event names, where it names one (indexed). */
  tokenId: bigint | null
}

/** A vault's own events over [fromBlock, toBlock], oldest first; an event this app does not name is left out. */
export async function vaultEvents(reader: ChainReader, vault: string, fromBlock: number, toBlock: number | 'latest', signal?: AbortSignal): Promise<VaultEvent[]> {
  const logs = await reader.logs({ address: checkAddress(vault, 'vault'), topics: [Object.values(VAULT_TOPIC)] }, fromBlock, toBlock, signal)
  const out: VaultEvent[] = []
  for (const log of logs) {
    const kind = vaultEventOf(log.topics[0] ?? '')
    if (!kind) continue
    const named = ['PositionOpened', 'FeesCollected', 'Compounded', 'PositionReleased', 'CapitalReduced', 'UnmanagedNFTRecovered'].includes(kind)
    // Compounded indexes the intent, the plan hash and then the token id.
    const topic = kind === 'Compounded' ? log.topics[3] : log.topics[1]
    out.push({ kind, block: log.blockNumber, transactionHash: log.transactionHash, logIndex: log.logIndex, tokenId: named && topic ? BigInt(topic) : null })
  }
  return out
}
