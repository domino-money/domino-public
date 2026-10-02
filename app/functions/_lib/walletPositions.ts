/**
 * POST /api/owned/v2/positions: the positions one wallet created through
 * Domino's own contracts, and the DominoSetupV1 deposits it has not turned
 * into a position (the owner's rule, 2026-09-24: connecting the wallet shows
 * its positions, nothing is typed, nothing is kept in the browser, and the
 * read service is not needed). Read since 2026-10-01 (RPC-SPEC, the owner's
 * rule: nothing is read from a public RPC) from Domino's own Robinhood Chain
 * node, at the edge (functions/_lib/chainRoutes.ts, localRpc.ts): the ids from
 * DominoSetupV1's state (D4, wideLogs false), the mint blocks from a log walk
 * kept per owner (functions/_lib/ownedMints.ts).
 *
 *   1. The head every other answer is pinned to, and the owner's
 *      DominoSetupV1.ownerNonce at it: 2026-09-28 (speed wave B, item 23), one
 *      aggregate3 at 'latest' of ArbSys.arbBlockNumber and ownerNonce, in
 *      place of an eth_blockNumber (and of the nonce in the first read). The
 *      head is ArbSys's, never Multicall3.getBlockNumber: on Robinhood Chain
 *      (Arbitrum Nitro) that is block.number, the parent chain's block
 *      (26,079,411 when eth_blockNumber and ArbSys said 75,212,459; see
 *      contracts/src/DominoL2Block.sol), and a head below DominoSetupV1's
 *      deployment block is refused as unread. A
 *      wallet whose nonce is 0 never opened a setup operation, so it has no
 *      SetupMinted log and no held deposit, and its empty answer is that one
 *      call (it paid the whole scan before, three calls in a row). The runtime
 *      is told the head (OwnedDeps.head; the page's router of 2026-09-28,
 *      retired 2026-10-01, routed its fallbacks' numbered reads by it).
 *   2. eth_getLogs of DominoSetupV1's SetupMinted events for the owner (topic
 *      2), newest first, from the head back to the contract's deployment
 *      block. A range the RPC refuses as too large or too slow is split in
 *      halves, the newer half asked first; a 429 is waited out and asked
 *      again. The walk stops at the MAX_POSITIONS most recently minted ids.
 *      NFTs the wallet holds that were minted elsewhere are never named.
 *      The page's later scans of the same wallet (2026-09-25) start shortly
 *      before its last scan's block instead (MintedMemory).
 *      2026-09-28: while the runtime cannot read wide log ranges
 *      (OwnedDeps.wideLogs false: then the page's, on the chain's public
 *      fallbacks; since 2026-10-01 always the edge's, RPC-SPEC D4), the same
 *      ids come from DominoSetupV1's own state instead (operationIds): no log
 *      is read at all.
 *   3. One Multicall3 aggregate3 at the head (per IDS_PER_CALL ids): per id
 *      ownerOf, getPositionLiquidity and getPoolAndPositionInfo (2026-09-28,
 *      item 17, the page's scan: and its PositionManager subscriber, whose
 *      vault's reads join the second aggregate, automation.ts). An id burned (ownerOf reverts) or
 *      sent away since is dropped; held with liquidity is open, without it
 *      closed. The packed PositionInfo gives the range and the pool id's top
 *      25 bytes, which must match the pool key read with it.
 *   4. One more aggregate3 at the same block: StateView getSlot0 per pool;
 *      per position getFeeGrowthInside and getPositionInfo (the unclaimed
 *      fees, exactly as v4 computes them, mod 2^256); symbol() and
 *      decimals() per ERC-20 (native ETH is 'ETH', 18); and operation(id) and
 *      recoveryStarted(id) for every one of the owner's setup operations, the
 *      RECENT_OPERATIONS (128) most recent at most (8 before 2026-09-25). A third,
 *      only for a held deposit's tokens not read already.
 *   The principal is what removing all of the liquidity pays at the pool's
 *   price at that block, before fees (v4's own rounding).
 *
 * What this is not: a general RPC proxy. The caller chooses the owner and
 * nothing else; the endpoint, every method, contract, topic, block range and
 * calldata are fixed here, the ids come from the logs, and the RPC calls and
 * bytes one answer may cost are capped (functions/_lib/owned.ts). Per owner,
 * an answer is kept 25 seconds (owned.ts CACHE_SECONDS; 5 for a fresh question) and a failure 12.
 */
import {
  ChainError,
  HASH,
  MAX_LOG_BYTES,
  MIN_SPLIT_BLOCKS,
  POSITION_MANAGER,
  RECENT_OPERATIONS,
  SELECTOR,
  SETUP_CONTRACT,
  SETUP_DEPLOY_BLOCK,
  SETUP_MINTED_TOPIC,
  addressWord,
  aggregate,
  answerOwner,
  asAddress,
  asInt24,
  decodeOperation,
  hex,
  limitsOf,
  operationId,
  paced,
  quantity,
  reader,
  resultWord,
  word,
  type AnswerCache,
  type Budget,
  type OwnedDeps,
  type OwnerScan,
  type SubCall,
} from './owned'
import { SELECTOR as STATE_SELECTOR, STATE_VIEW, decodeSymbol, poolIdOf } from './fees'
import { automationsOf, subscriberCall, subscriberOf, vaultCalls, vaultsOf } from './automation'
import type { AutomationAnswer } from '../../src/lib/automationState'
import type { WalletAnswer, WalletDeposit, WalletPosition, WalletToken } from '../../src/lib/walletPositions'

/**
 * Arbitrum's ArbSys precompile, whose arbBlockNumber() is the chain's own (L2) block, the one eth_blockNumber names
 * (the scan's head, item 23). Kept here, not in owned.ts: the page's bundle has no bytes to spare for another export.
 */
const ARB_SYS = '0x0000000000000000000000000000000000000064'

/** The most positions one answer lists: the most recently minted ones. */
export const MAX_POSITIONS = 100
/**
 * How far back of an earlier scan's block a later one reads the logs again (about two minutes of blocks): a log a node
 * behind the head had not shown yet is found by the next scan.
 */
export const REREAD_BLOCKS = 1_200

/**
 * What an earlier scan of the same owner found (2026-09-25): every id DominoSetupV1 minted to it up to `block`, most
 * recent first. SetupMinted logs are history that only grows, so a later scan in the same page reads the logs from
 * shortly before `block` only, and still reads every position's state, fresh, at its own head: the page's second and
 * later reads of a wallet no longer scan the chain from the contract's deployment (a log scan of millions of blocks,
 * after which the public RPC refuses the visitor's next reads).
 */
export interface MintedMemory {
  block: number
  ids: readonly bigint[]
}
/** 2026-10-01 (fees item A1): an NFT's SetupMinted log, its mint's block and transaction. */
export interface MintedAt {
  id: string
  block: number
  tx: string
}
/**
 * Positions per aggregate3 call in the first read (three sub-calls each, four with the feature). Changed on purpose
 * 2026-10-02 (rugged97's rule 5: at most 50 calls in one multicall): 12, so 48 sub-calls at most; it was 50 (200).
 */
export const IDS_PER_CALL = 12
/** Sub-calls per aggregate3 call in the second read. Changed on purpose 2026-10-02 (rule 5): 50, was 150. */
export const CALLS_PER_AGGREGATE = 50

const ZERO = '0x0000000000000000000000000000000000000000'
const U256 = (1n << 256n) - 1n

// ---------------------------------------------------------------------------
// v4 amounts: copies of src/finance/position.ts sqrtPriceAtTick, amount0ForLiquidity, amount1ForLiquidity and
// principalAt (a Function carries no viem, and finance/ imports it), checked against lib/read/screens/poolRange.ts over a
// tick sweep in tests/owned.test.mjs.
// ---------------------------------------------------------------------------

const Q96 = 1n << 96n
export const MIN_TICK = -887272
export const MAX_TICK = 887272
const FACTORS: ReadonlyArray<readonly [number, bigint]> = [
  [0x2, 0xfff97272373d413259a46990580e213an], [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn], [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n], [0x20, 0xff973b41fa98c081472e6896dfb254c0n], [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n], [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n], [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n], [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n], [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n], [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n], [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n], [0x20000, 0x5d6af8dedb81196699c329225ee604n], [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
]

/** sqrt(1.0001^tick) × 2^96, rounded up, exactly as v4-core computes it. Throws outside MIN_TICK..MAX_TICK. */
export function sqrtPriceAtTick(tick: number): bigint {
  if (!Number.isSafeInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new ChainError('fatal', 'invalid_tick')
  const abs = Math.abs(tick)
  let price = abs & 0x1 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 1n << 128n
  for (const [bit, factor] of FACTORS) if (abs & bit) price = (price * factor) >> 128n
  if (tick > 0) price = U256 / price
  return (price + 0xffffffffn) >> 32n
}

const amount0 = (low: bigint, high: bigint, liquidity: bigint) => (low === 0n || high === low ? 0n : (liquidity * Q96 * (high - low)) / high / low)
const amount1 = (low: bigint, high: bigint, liquidity: bigint) => (liquidity * (high - low)) / Q96

/** What removing all of `liquidity` pays at the pool's price, before fees; branches on the tick as v4-core's Pool.modifyLiquidity does. */
export function principalAt(sqrtPriceX96: bigint, tick: number, tickLower: number, tickUpper: number, liquidity: bigint): readonly [bigint, bigint] {
  const lower = sqrtPriceAtTick(tickLower)
  const upper = sqrtPriceAtTick(tickUpper)
  if (tick < tickLower) return [amount0(lower, upper, liquidity), 0n]
  if (tick < tickUpper) return [amount0(sqrtPriceX96, upper, liquidity), amount1(lower, sqrtPriceX96, liquidity)]
  return [0n, amount1(lower, upper, liquidity)]
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/** The first `count` words of ABI return data, bounds-checked. */
function words(data: string, count: number): bigint[] {
  const r = reader(data)
  if (r.bytes < count * 32) throw new ChainError('fatal', 'invalid_return_data')
  return Array.from({ length: count }, (_, i) => r.at(i * 32))
}

function bounded(value: bigint, bits: bigint): bigint {
  if (value >> bits !== 0n) throw new ChainError('fatal', 'invalid_return_data')
  return value
}

/**
 * The NFT id a SetupMinted log names. The RPC was asked for exactly these
 * events for exactly this owner: a log that is anything else is a reply that
 * cannot be trusted, and fails the answer. A removed log (a reorg) names nothing.
 */
function mintedId(log: unknown, ownerTopic: string): bigint | null {
  const entry = (log ?? {}) as { address?: unknown; topics?: unknown; removed?: unknown; data?: unknown }
  if (entry.removed === true) return null
  const topics = Array.isArray(entry.topics) ? entry.topics.map((topic) => String(topic).toLowerCase()) : null
  if (typeof entry.address !== 'string' || entry.address.toLowerCase() !== SETUP_CONTRACT || !topics || topics.length !== 4) throw new ChainError('fatal', 'invalid_log')
  if (topics[0] !== SETUP_MINTED_TOPIC || topics[2] !== ownerTopic || !HASH.test(topics[1]) || !HASH.test(topics[3])) throw new ChainError('fatal', 'invalid_log')
  if (typeof entry.data !== 'string' || !/^0x[0-9a-fA-F]{192}$/.test(entry.data)) throw new ChainError('fatal', 'invalid_log')
  const id = BigInt(topics[3])
  if (id === 0n) throw new ChainError('fatal', 'invalid_log')
  return id
}

/**
 * The ids DominoSetupV1 minted to the owner, most recent first, at most
 * MAX_POSITIONS. Ranges are asked newest first; one the RPC refuses as too
 * large or too slow is split in two, down to MIN_SPLIT_BLOCKS, its newer half
 * asked first. `capped` says the walk stopped before the deployment block.
 * 2026-10-02 (review finding 13): `incomplete` says it stopped on its byte budget, before reading every window up to
 * `head`: its ids may then leave out some within MAX_POSITIONS. A walk capped by MAX_POSITIONS alone is complete: newest
 * first, its ids are exactly the newest MAX_POSITIONS up to `head`, and a later walk from `head` merges onto them.
 * 2026-09-28 (owned.ts LOG_BLOCKS_ONE, merged with speed wave B's scan): a walk
 * wider than the RPC serves for one filter at all is asked in windows of that
 * width, newest first, rather than refused first and halved.
 */
export async function mintedIds(deps: OwnedDeps, budget: Budget, owner: string, head: number, known: MintedMemory | null = null): Promise<{ ids: bigint[]; capped: boolean; mints: MintedAt[]; incomplete: boolean }> {
  const ownerTopic = `0x${addressWord(owner)}`
  const start = known ? Math.max(SETUP_DEPLOY_BLOCK, known.block - REREAD_BLOCKS + 1) : SETUP_DEPLOY_BLOCK
  // 2026-10-01 (RPC-SPEC §2.6): in the runtime's windows (the edge's are wider: its node transport splits them).
  const { one } = limitsOf(deps)
  const queue: [number, number][] = []
  for (let top = head; top >= start; top -= one) queue.push([Math.max(start, top - one + 1), top])
  const ids: bigint[] = []
  const seen = new Set<bigint>()
  // 2026-10-01 (fees item A1): each SetupMinted log's block and transaction, the NFT's own mint: a hint for its history.
  const mints: MintedAt[] = []
  while (queue.length > 0) {
    if (budget.logBytes >= MAX_LOG_BYTES) return { ids, capped: true, mints, incomplete: true }
    const [from, to] = queue.shift() as [number, number]
    let logs: unknown
    try {
      logs = await paced(deps, budget, 'eth_getLogs', [{ address: SETUP_CONTRACT, fromBlock: hex(from), toBlock: hex(to), topics: [SETUP_MINTED_TOPIC, null, ownerTopic] }])
    } catch (error) {
      if (error instanceof ChainError && error.kind === 'bytes') return { ids, capped: true, mints, incomplete: true }
      if (error instanceof ChainError && error.kind === 'range' && to - from + 1 >= 2 * MIN_SPLIT_BLOCKS) {
        const middle = from + Math.floor((to - from) / 2)
        queue.unshift([middle + 1, to], [from, middle])
        continue
      }
      throw error
    }
    if (!Array.isArray(logs)) throw new ChainError('fatal', 'invalid_logs')
    for (let i = logs.length - 1; i >= 0; i--) {
      const id = mintedId(logs[i], ownerTopic)
      if (id === null || seen.has(id)) continue
      if (ids.length === MAX_POSITIONS) return { ids, capped: true, mints, incomplete: false }
      seen.add(id)
      ids.push(id)
      const { blockNumber, transactionHash } = logs[i] as { blockNumber?: unknown; transactionHash?: unknown }
      if (typeof blockNumber === 'string' && /^0x[0-9a-f]{1,16}$/i.test(blockNumber) && typeof transactionHash === 'string' && HASH.test(transactionHash)) mints.push({ id: id.toString(), block: Number(BigInt(blockNumber)), tx: transactionHash.toLowerCase() })
    }
    if (ids.length === MAX_POSITIONS && queue.length > 0) return { ids, capped: true, mints, incomplete: false }
  }
  if (!known) return { ids, capped: false, mints, incomplete: false }
  // The newer logs' ids first, then the ones the earlier scan found and these did not name again.
  const merged = [...ids, ...known.ids.filter((id) => !seen.has(id))]
  return { ids: merged.slice(0, MAX_POSITIONS), capped: merged.length > MAX_POSITIONS, mints, incomplete: false }
}

/**
 * How many of the owner's most recent setup operations operationIds reads (two aggregate3 calls at most): an owner with
 * more has its older ones left out, and the answer says so (`capped`), as the log walk does past MAX_POSITIONS.
 */
export const MINTED_OPERATIONS = 2 * 150

/**
 * The ids DominoSetupV1 minted to the owner, most recent operation first, at most MAX_POSITIONS, read from the
 * contract's own state at `head` rather than from its SetupMinted logs (2026-09-28: then while the chain's own RPC could
 * not be reached and its public fallbacks read logs only a few thousand blocks at a time; since 2026-10-01, RPC-SPEC D4,
 * always at the edge, the mint blocks coming from a log walk kept per owner, functions/_lib/ownedMints.ts).
 *
 * The same set as the log walk's, by the contract's own rules (contracts/src/DominoSetup.sol): every operation of an
 * owner is operationId(owner, n) for n below ownerNonce(owner), since open() takes only nextOperationId(msg.sender) and
 * records msg.sender as its owner; mint() is the only SetupMinted, it names the operation's owner, and it records the
 * NFT id in the operation's tokenId and closes it, so an operation mints at most once and keeps that id. So the ids of
 * the owner's operations whose tokenId is not zero are exactly the ids its SetupMinted logs name. An operation that is
 * not the owner's (a reply that cannot be trusted) fails the answer, as a log that is not the one asked for does.
 */
export async function operationIds(deps: OwnedDeps, budget: Budget, owner: string, head: number, known: bigint | null = null): Promise<{ ids: bigint[]; capped: boolean }> {
  const nonce = known ?? resultWord((await aggregate(deps, budget, [{ target: SETUP_CONTRACT, data: SELECTOR.ownerNonce + addressWord(owner) }], head))[0])
  if (nonce === null) throw new ChainError('fatal', 'nonce_unread')
  const oldest = nonce > BigInt(MINTED_OPERATIONS) ? nonce - BigInt(MINTED_OPERATIONS) : 0n
  const operations: string[] = []
  for (let n = nonce - 1n; n >= oldest; n--) operations.push(operationId(owner, n))
  const results = operations.length > 0 ? await aggregateAll(deps, budget, operations.map((id) => ({ target: SETUP_CONTRACT, data: SELECTOR.operation + id.slice(2) })), head) : []
  const ids: bigint[] = []
  for (const call of results) {
    if (!call.success) throw new ChainError('fatal', 'operation_unread')
    const operation = decodeOperation(call.data)
    if (operation.owner !== owner) throw new ChainError('fatal', 'invalid_operation')
    if (operation.tokenId === 0n) continue
    if (ids.length === MAX_POSITIONS) return { ids, capped: true }
    ids.push(operation.tokenId)
  }
  return { ids, capped: oldest > 0n }
}

/** Several aggregate3 calls of at most `per` sub-calls each, at one block; their results in order. */
async function aggregateAll(deps: OwnedDeps, budget: Budget, calls: SubCall[], block: number | 'latest', per = CALLS_PER_AGGREGATE) {
  const out: { success: boolean; data: string }[] = []
  for (let i = 0; i < calls.length; i += per) out.push(...(await aggregate(deps, budget, calls.slice(i, i + per), block)))
  return out
}

/** Each ERC-20's symbol() and decimals() (native ETH is 'ETH', 18): a page's Receipts, in one read (2026-09-28, speed wave B, item 25). */
export async function tokenDetails(deps: OwnedDeps, addresses: readonly string[]): Promise<WalletToken[]> {
  const results = await aggregateAll(deps, { calls: 0, started: deps.now(), logBytes: 0 }, addresses.flatMap((address) => [{ target: address, data: STATE_SELECTOR.symbol }, { target: address, data: STATE_SELECTOR.decimals }]), 'latest')
  return addresses.map((address, i) => tokenOf(address, results[2 * i], results[2 * i + 1]))
}

/** A token from its symbol() and decimals() answers; native ETH is 'ETH', 18. */
function tokenOf(address: string, symbolCall: { success: boolean; data: string }, decimalsCall: { success: boolean; data: string }): WalletToken {
  if (address === ZERO) return { address, symbol: 'ETH', decimals: 18 }
  const decimals = resultWord(decimalsCall)
  return { address, symbol: symbolCall.success ? decodeSymbol(symbolCall.data) : null, decimals: decimals !== null && decimals <= 255n ? Number(decimals) : null }
}

interface PoolKey {
  currency0: string
  currency1: string
  fee: number
  tickSpacing: number
  hooks: string
}

interface Held {
  id: bigint
  key: PoolKey
  poolId: string
  tickLower: number
  tickUpper: number
  liquidity: bigint
}

/**
 * The positions and held deposits of one owner (a lowercase 0x address), at the head. `earlier`: what an earlier scan of
 * this owner found (the page's own, 2026-09-25), so only the logs since are read; `minted` is what the next may reuse,
 * null when this one stopped at a cap. `automation` (the page's, 2026-09-28, item 17): each listed position's feature,
 * read in the same calls (automation.ts), as `automation`.
 */
export async function scanWallet(deps: OwnedDeps, owner: string, earlier: MintedMemory | null = null, automation = false): Promise<OwnerScan & { body: WalletAnswer; minted: MintedMemory | null; automation?: AutomationAnswer; mints?: MintedAt[] }> {
  const budget: Budget = { calls: 0, started: deps.now(), logBytes: 0 }
  // The head (ArbSys's L2 block, never Multicall3's parent-chain block.number) and the owner's setup nonce at it (item
  // 23 above): one aggregate3 at the RPC's own head. A head before DominoSetupV1 existed is not one.
  const [top, asked] = await aggregate(deps, budget, [{ target: ARB_SYS, data: SELECTOR.arbBlockNumber }, { target: SETUP_CONTRACT, data: SELECTOR.ownerNonce + addressWord(owner) }], 'latest')
  const tip = resultWord(top)
  const nonce = resultWord(asked)
  const head = tip === null ? 0 : quantity(hex(tip))
  if (nonce === null || head < SETUP_DEPLOY_BLOCK) throw new ChainError('fatal', 'nonce_unread')
  deps.head?.(head)
  // No setup operation ever: nothing minted, nothing held.
  if (nonce === 0n) return { body: { owner, block: head, positions: [], deposits: [] }, capped: false, minted: { block: head, ids: [] }, automation: automation ? { block: head, positions: [] } : undefined }
  // A node behind the earlier scan's block reads the logs from where it stands; the earlier ids are kept. 2026-09-28: a
  // runtime that cannot read wide log ranges now (the page's, on the chain's public fallbacks) reads the ids from
  // DominoSetupV1's state instead, whatever an earlier scan found: every one of them, at this head.
  const { ids, capped, mints } =
    deps.wideLogs?.() === false
      ? { ...(await operationIds(deps, budget, owner, head, nonce)), mints: [] as MintedAt[] }
      : await mintedIds(deps, budget, owner, head, earlier && earlier.block <= head ? earlier : earlier ? { block: head, ids: earlier.ids } : null)

  // First read: which ids the owner still holds, their pool keys, ranges and liquidity (and their subscribers).
  const held: Held[] = []
  const subscribers: string[] = []
  const per = automation ? 4 : 3
  for (let chunk = 0; chunk * IDS_PER_CALL < ids.length; chunk++) {
    const part = ids.slice(chunk * IDS_PER_CALL, (chunk + 1) * IDS_PER_CALL)
    const calls: SubCall[] = []
    for (const id of part) {
      calls.push({ target: POSITION_MANAGER, data: SELECTOR.ownerOf + word(id) })
      calls.push({ target: POSITION_MANAGER, data: SELECTOR.getPositionLiquidity + word(id) })
      calls.push({ target: POSITION_MANAGER, data: SELECTOR.getPoolAndPositionInfo + word(id) })
      if (automation) calls.push(subscriberCall(id))
    }
    const results = await aggregate(deps, budget, calls, head)
    let at = 0
    for (const id of part) {
      const [holder, liquidityCall, infoCall, subscribed] = [results[at], results[at + 1], results[at + 2], results[at + 3]]
      at += per
      // Burned (ownerOf reverts): not listed.
      if (!holder.success) continue
      const holderWord = resultWord(holder)
      if (holderWord === null) throw new ChainError('fatal', 'invalid_return_data')
      // Sent away since: not the owner's position any more.
      if (asAddress(holderWord) !== owner) continue
      if (!liquidityCall.success || !infoCall.success) throw new ChainError('fatal', 'position_unread')
      const w = words(infoCall.data, 6)
      const key: PoolKey = { currency0: asAddress(w[0]), currency1: asAddress(w[1]), fee: Number(bounded(w[2], 24n)), tickSpacing: asInt24(w[3]), hooks: asAddress(w[4]) }
      const poolId = poolIdOf(key)
      // The packed PositionInfo carries the pool id's top 25 bytes: they must match the key read with it.
      if (BigInt(poolId) >> 56n !== w[5] >> 56n) throw new ChainError('fatal', 'pool_mismatch')
      const tickLower = Number(BigInt.asIntN(24, w[5] >> 8n))
      const tickUpper = Number(BigInt.asIntN(24, w[5] >> 32n))
      if (tickLower >= tickUpper || tickLower < MIN_TICK || tickUpper > MAX_TICK) throw new ChainError('fatal', 'invalid_range')
      held.push({ id, key, poolId, tickLower, tickUpper, liquidity: bounded(words(liquidityCall.data, 1)[0], 128n) })
      if (automation) subscribers.push(subscriberOf(subscribed))
    }
  }

  // Second read, at the same block: the pools' prices, each position's fee growth, the tokens, the held deposits.
  const operations: string[] = []
  for (let n = nonce - 1n; n >= 0n && n >= nonce - BigInt(RECENT_OPERATIONS); n--) operations.push(operationId(owner, n))
  const pools = [...new Set(held.map((p) => p.poolId))]
  const tokens = [...new Set(held.flatMap((p) => [p.key.currency0, p.key.currency1]))].filter((address) => address !== ZERO)
  const tick = (value: number) => word(BigInt(value))
  const second: SubCall[] = [
    ...pools.map((poolId) => ({ target: STATE_VIEW, data: STATE_SELECTOR.getSlot0 + poolId.slice(2) })),
    ...held.flatMap((p) => [
      { target: STATE_VIEW, data: STATE_SELECTOR.getFeeGrowthInside + p.poolId.slice(2) + tick(p.tickLower) + tick(p.tickUpper) },
      { target: STATE_VIEW, data: STATE_SELECTOR.getPositionInfo + p.poolId.slice(2) + addressWord(POSITION_MANAGER) + tick(p.tickLower) + tick(p.tickUpper) + word(p.id) },
    ]),
    ...tokens.flatMap((address) => [
      { target: address, data: STATE_SELECTOR.symbol },
      { target: address, data: STATE_SELECTOR.decimals },
    ]),
    ...operations.flatMap((id) => [
      { target: SETUP_CONTRACT, data: SELECTOR.operation + id.slice(2) },
      { target: SETUP_CONTRACT, data: SELECTOR.recoveryStarted + id.slice(2) },
    ]),
  ]
  const vaultsAt = second.length
  second.push(...vaultCalls(vaultsOf(subscribers)))
  const results = second.length > 0 ? await aggregateAll(deps, budget, second, head) : []

  const slot0 = new Map<string, { sqrtPriceX96: bigint; tick: number } | null>()
  pools.forEach((poolId, i) => {
    const call = results[i]
    if (!call.success) return void slot0.set(poolId, null)
    const [price, current] = words(call.data, 2)
    slot0.set(poolId, price === 0n ? null : { sqrtPriceX96: bounded(price, 160n), tick: asInt24(current) })
  })
  const known = new Map<string, WalletToken>()
  const readTokens = (addresses: readonly string[], from: readonly { success: boolean; data: string }[], at: number) =>
    addresses.forEach((address, i) => known.set(address, tokenOf(address, from[at + 2 * i], from[at + 2 * i + 1])))
  const tokensAt = pools.length + held.length * 2
  readTokens(tokens, results, tokensAt)

  interface Kept {
    operationId: string
    key: PoolKey
    balance0: bigint
    balance1: bigint
  }
  const kept: Kept[] = []
  const opsAt = tokensAt + tokens.length * 2
  operations.forEach((id, i) => {
    const [op, recovery] = [results[opsAt + 2 * i], results[opsAt + 2 * i + 1]]
    if (!op.success || resultWord(recovery) !== 0n) return
    const value = decodeOperation(op.data)
    if (value.owner !== owner || value.closed || (value.balance0 === 0n && value.balance1 === 0n)) return
    kept.push({ operationId: id, key: { currency0: value.currency0, currency1: value.currency1, fee: value.fee, tickSpacing: value.tickSpacing, hooks: value.hooks }, balance0: value.balance0, balance1: value.balance1 })
  })
  // A third read only for a held deposit's tokens that are not known yet.
  const missing = [...new Set(kept.flatMap((d) => [d.key.currency0, d.key.currency1]))].filter((address) => address !== ZERO && !known.has(address))
  if (missing.length > 0) {
    const third = await aggregateAll(deps, budget, missing.flatMap((address) => [{ target: address, data: STATE_SELECTOR.symbol }, { target: address, data: STATE_SELECTOR.decimals }]), head)
    readTokens(missing, third, 0)
  }
  const currency = (address: string): WalletToken => (address === ZERO ? { address, symbol: 'ETH', decimals: 18 } : (known.get(address) ?? { address, symbol: null, decimals: null }))
  const positions: WalletPosition[] = held.map((p, i) => {
    const [insideCall, lastCall] = [results[pools.length + 2 * i], results[pools.length + 2 * i + 1]]
    const pool = slot0.get(p.poolId) ?? null
    let unclaimed: readonly [string, string] | null = null
    if (insideCall.success && lastCall.success) {
      const inside = words(insideCall.data, 2)
      const [coreLiquidity, last0, last1] = words(lastCall.data, 3)
      // The PositionManager's liquidity and the core position's are one number; two answers mean a misread.
      if (coreLiquidity === p.liquidity) {
        const owed = (now: bigint, before: bigint) => ((((now - before) & U256) * coreLiquidity) >> 128n).toString()
        unclaimed = [owed(inside[0], last0), owed(inside[1], last1)]
      }
    }
    const principal = pool ? principalAt(pool.sqrtPriceX96, pool.tick, p.tickLower, p.tickUpper, p.liquidity) : null
    return {
      tokenId: p.id.toString(),
      status: p.liquidity > 0n ? 'open' : 'closed',
      poolId: p.poolId,
      currencies: [currency(p.key.currency0), currency(p.key.currency1)],
      fee: p.key.fee,
      tickSpacing: p.key.tickSpacing,
      hooks: p.key.hooks,
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
      liquidity: p.liquidity.toString(),
      sqrtPriceX96: pool ? pool.sqrtPriceX96.toString() : null,
      tick: pool ? pool.tick : null,
      unclaimedFees: unclaimed,
      principal: principal ? [principal[0].toString(), principal[1].toString()] : null,
    }
  })

  const deposits: WalletDeposit[] = kept.map((d) => ({
    operationId: d.operationId,
    currency0: d.key.currency0,
    currency1: d.key.currency1,
    fee: d.key.fee,
    tickSpacing: d.key.tickSpacing,
    hooks: d.key.hooks,
    balance0: d.balance0.toString(),
    balance1: d.balance1.toString(),
    currencies: [currency(d.key.currency0), currency(d.key.currency1)],
  }))

  // Open first, then closed; the newest NFT first within each.
  positions.sort((a, b) => (a.status === b.status ? (BigInt(a.tokenId) > BigInt(b.tokenId) ? -1 : 1) : a.status === 'open' ? -1 : 1))
  return {
    body: { owner, block: head, positions, deposits },
    capped,
    minted: capped ? null : { block: head, ids },
    automation: automation ? { block: head, positions: automationsOf(held.map((p) => p.id), subscribers, results.slice(vaultsAt)) } : undefined,
    ...(mints.length ? { mints } : {}),
  }
}

/** POST /api/owned/v2/positions with {"owner": "0x…"} (and optionally "fresh": true): the owner's answer, as JSON. */
export function answerWalletPositions(request: Request, deps: OwnedDeps, cache: AnswerCache | null = null, waitUntil?: (work: Promise<unknown>) => void): Promise<Response> {
  return answerOwner(request, deps, 'v2', scanWallet, cache, waitUntil)
}
