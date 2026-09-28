/**
 * The fees history's price-path reads (2026-09-25), for the page's replay
 * worker only (src/lib/fees/logs.ts): two kinds of LogsRequest the relay's
 * routes never answer, read from the chain's public RPC with the relay's own
 * code (fees.ts: the same RPC runtime, caps, 429 waits and log checks).
 *
 *   span         the pool's Swap and Donate logs in 1..MAX_SPANS spans of
 *                blocks, in one batch: a position's own swaps from its mint
 *                (not its pool's whole days), or small samples of them
 *   settlements  the NFT's own ModifyLiquidity logs (its mint, and every
 *                collect, increase or decrease): looked for in the mint's
 *                block and in every block where one of the pool's two
 *                currencies moved between the PoolManager and an owner of the
 *                NFT (a settlement pays the owner, or the owner pays in)
 *   modifies     (2026-09-27) the NFT's own ModifyLiquidity logs in 1..16
 *                spans of blocks, found among every ModifyLiquidity the
 *                PositionManager made in the pool there: a settlement that
 *                paid no owner and was paid by none (an Auto-compound collects
 *                the fees and adds them back inside the PoolManager, so no
 *                token moves to or from the owner: the owner's 3325113)
 *
 * Why: a position's fees are its liquidity times the price's path through its
 * range, times the fee (fees-path in src/lib/fees/replay.ts): with the swaps
 * of its own life and its own settlements, a busy pool's position needs
 * neither the pool's liquidity history from its creation (over 60 MB for
 * PONS/USDG, measured 2026-09-25) nor any archive state, which the RPC does
 * not keep past about ten minutes (measured the same day).
 *
 * Every method here is eth_blockNumber or eth_getLogs; every address, topic
 * and filter is fixed here, the caller names only a pool, a token id, blocks,
 * the NFT's owners and the pool's two currencies (checked as addresses).
 */
import { POSITION_MANAGER } from './owned'
import {
  HASH,
  POOL_MANAGER,
  RelayError,
  SAFE_DEPTH,
  SWAP_EVENTS,
  TOPIC,
  addressWord,
  blockNumber,
  compact,
  failedRead,
  headBlock,
  hex,
  keysAre,
  newBudget,
  paced,
  poolFilter,
  poolIdOk,
  post,
  quantity,
  resultOf,
  tokenIdOk,
  type Budget,
  type FeesRuntime,
} from './fees'
import type { CompactLog, LogsRequest, LogsResponse, RelayAnswer } from '../../src/lib/fees/types'

/** The most blocks one span covers: a day of the hourly grid. */
export const SPAN_BLOCKS = 864_000
/** The most spans one request reads (one batch of eth_getLogs). */
export const MAX_SPANS = 16
/**
 * The most bytes one span reply may take: well under the 670 kB reply after which the RPC refused the next call from the
 * same address (measured 2026-09-25). Past it the answer is too_large, and the worker asks a shorter span.
 */
export const SPAN_BYTES = 384 * 1024
/** The most blocks one settlements request covers (about thirty days, the most a history replays). */
export const SETTLE_SPAN = 30 * 864_000
/** The most owners one settlements request names (the NFT's owners since its mint). */
export const MAX_HOLDERS = 4
/** The most blocks a settlements request looks into: past it, the answer is too_large (the history stays an estimate at most). */
export const SETTLE_BLOCKS = 24
/** The shortest range a settlements request's transfers are split to when the node gives up on a longer one. */
const SETTLE_SPLIT_BLOCKS = 200_000
/** A settlements request's reply of transfers is capped here (each is about 700 bytes). */
const SETTLE_TRANSFER_BYTES = 128 * 1024
/**
 * 2026-09-27: a modifies request's reply is capped here (each ModifyLiquidity is about 820 bytes of the RPC's JSON): the
 * owner's USDG/UFG 4 % pool held 54 of them over his position's first day, 44 kB, where its whole history is 864 kB.
 */
export const MODIFIES_BYTES = 256 * 1024

type PathKind = 'span' | 'settlements' | 'modifies'
export type PathRequest = Extract<LogsRequest, { kind: PathKind }>

const ADDRESS = /^0x[0-9a-f]{40}$/
const addressOk = (value: unknown): value is string => typeof value === 'string' && ADDRESS.test(value)

/** 1..MAX_SPANS spans of blocks, sorted, disjoint and each at most SPAN_BLOCKS, as copies; null unless exactly that. */
function spansOf(value: unknown): Array<[number, number]> | null {
  if (!Array.isArray(value)) return null
  const spans: unknown[] = value
  if (spans.length < 1 || spans.length > MAX_SPANS) return null
  let after = -1
  for (const span of spans) {
    if (!Array.isArray(span) || span.length !== 2 || !blockNumber(span[0]) || !blockNumber(span[1])) return null
    const [from, to] = span as [number, number]
    if (from <= after || to < from || to - from >= SPAN_BLOCKS) return null
    after = to
  }
  return spans.map((span) => [...(span as [number, number])] as [number, number])
}

/** A path request as it is, or null unless it is exactly one (exact keys, safe integers, lowercase hex, sorted spans). */
export function pathRequestOf(body: Record<string, unknown>): PathRequest | null {
  if (body.kind === 'span') {
    if (!keysAre(body, ['kind', 'poolId', 'spans']) || !poolIdOk(body.poolId)) return null
    const spans = spansOf(body.spans)
    return spans ? { kind: 'span', poolId: body.poolId, spans } : null
  }
  if (body.kind === 'modifies') {
    if (!keysAre(body, ['kind', 'poolId', 'tokenId', 'spans']) || !poolIdOk(body.poolId) || !tokenIdOk(body.tokenId)) return null
    const spans = spansOf(body.spans)
    return spans ? { kind: 'modifies', poolId: body.poolId, tokenId: body.tokenId, spans } : null
  }
  if (body.kind === 'settlements') {
    if (!keysAre(body, ['kind', 'poolId', 'tokenId', 'holders', 'currencies', 'from', 'to']) || !poolIdOk(body.poolId) || !tokenIdOk(body.tokenId)) return null
    const { holders, currencies, from, to } = body
    if (!Array.isArray(holders) || holders.length < 1 || holders.length > MAX_HOLDERS || !holders.every(addressOk) || new Set(holders).size !== holders.length) return null
    if (!Array.isArray(currencies) || currencies.length !== 2 || !currencies.every(addressOk)) return null
    if (!blockNumber(from) || !blockNumber(to) || to < from || to - from >= SETTLE_SPAN) return null
    return { kind: 'settlements', poolId: body.poolId, tokenId: body.tokenId, holders: [...holders], currencies: [currencies[0], currencies[1]], from, to }
  }
  return null
}

/** One batch of eth_getLogs (one POST), each envelope's result in the order asked. */
async function logsBatch(rt: FeesRuntime, budget: Budget, filters: unknown[], byteLimit: number): Promise<unknown[]> {
  const reply = await paced(rt, budget, () => post(rt, budget, filters.map((filter, id) => ({ jsonrpc: '2.0', id, method: 'eth_getLogs', params: [filter] })), true, byteLimit))
  if (!Array.isArray(reply) || reply.length !== filters.length) throw new RelayError('fatal', 'invalid_batch')
  const out: unknown[] = Array.from({ length: filters.length })
  const seen = new Set<number>()
  for (const envelope of reply) {
    const id = (envelope as { id?: unknown } | null)?.id
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0 || id >= filters.length || seen.has(id)) throw new RelayError('fatal', 'invalid_batch')
    seen.add(id)
    const result = resultOf(envelope)
    if (!Array.isArray(result)) throw new RelayError('fatal', 'invalid_logs')
    out[id] = result
  }
  return out
}

const byPosition = (a: CompactLog, b: CompactLog) => a[0] - b[0] || a[1] - b[1]

/** Swap and Donate logs in each span, one batch; a reply past SPAN_BYTES is too_large (the caller asks shorter spans). */
async function spanLogs(rt: FeesRuntime, budget: Budget, poolId: string, spans: ReadonlyArray<[number, number]>): Promise<CompactLog[][]> {
  const filter = poolFilter(poolId, SWAP_EVENTS)
  const topics = [[...SWAP_EVENTS], poolId]
  let results: unknown[]
  try {
    results = await logsBatch(rt, budget, spans.map(([from, to]) => ({ address: POOL_MANAGER, fromBlock: hex(from), toBlock: hex(to), topics })), SPAN_BYTES)
  } catch (error) {
    if (error instanceof RelayError && (error.kind === 'bytes' || error.kind === 'range')) throw new RelayError('fatal', 'part_too_large')
    throw error
  }
  return results.map((result, i) => (result as unknown[]).map((raw) => compact(raw, filter, spans[i][0], spans[i][1])).sort(byPosition))
}

/** The blocks in [from, to] where one of `currencies` moved between the PoolManager and one of `holders`, in either direction. */
async function paidBlocks(rt: FeesRuntime, budget: Budget, holders: readonly string[], currencies: readonly string[], from: number, to: number): Promise<number[]> {
  const tokens = [...new Set(currencies)].filter((address) => BigInt(address) !== 0n)
  if (tokens.length === 0) return []
  const pool = `0x${addressWord(POOL_MANAGER)}`
  const owners = holders.map((address) => `0x${addressWord(address)}`)
  // Two filters, each with the owners in one place: an owner's topic is rare, so the node's log index finds its blocks
  // in about 250 ms (measured 2026-09-25); with the PoolManager allowed on both sides (it is in nearly every block) the
  // one query had to open every block, and timed out after 2.2 s ("log query timed out"). A range the node still gives
  // up on (twelve million blocks did, once, the same day) is asked in halves, down to SETTLE_SPLIT_BLOCKS.
  const filters = (a: number, b: number) => [
    { address: tokens, fromBlock: hex(a), toBlock: hex(b), topics: [TOPIC.Transfer, pool, owners] },
    { address: tokens, fromBlock: hex(a), toBlock: hex(b), topics: [TOPIC.Transfer, owners, pool] },
  ]
  const read = async (a: number, b: number): Promise<unknown[]> => {
    try {
      return (await logsBatch(rt, budget, filters(a, b), SETTLE_TRANSFER_BYTES)).flat()
    } catch (error) {
      if (error instanceof RelayError && error.kind === 'range' && b - a + 1 >= 2 * SETTLE_SPLIT_BLOCKS) {
        const middle = a + Math.floor((b - a) / 2)
        return [...(await read(a, middle)), ...(await read(middle + 1, b))]
      }
      if (error instanceof RelayError && (error.kind === 'bytes' || error.kind === 'range')) throw new RelayError('fatal', 'part_too_large')
      throw error
    }
  }
  const results = await read(from, to)
  const known = new Set(owners)
  const blocks = new Set<number>()
  for (const raw of results) {
    const log = raw as { address?: unknown; topics?: unknown; blockNumber?: unknown; removed?: unknown }
    if (!log || typeof log !== 'object' || log.removed === true) throw new RelayError('fatal', 'invalid_log')
    if (typeof log.address !== 'string' || !tokens.includes(log.address.toLowerCase())) throw new RelayError('fatal', 'invalid_log_address')
    const topics = Array.isArray(log.topics) ? log.topics.map((topic) => (typeof topic === 'string' ? topic.toLowerCase() : '')) : []
    // An ERC-20 Transfer: three topics (an ERC-721 one has four).
    if (topics.length !== 3 || topics[0] !== TOPIC.Transfer || !topics.every((topic) => HASH.test(topic))) throw new RelayError('fatal', 'invalid_log_topics')
    const block = quantity(log.blockNumber)
    if (block < from || block > to) throw new RelayError('fatal', 'log_out_of_range')
    const [, sender, receiver] = topics
    if (!((sender === pool && known.has(receiver)) || (receiver === pool && known.has(sender)))) throw new RelayError('fatal', 'invalid_log_topics')
    blocks.add(block)
  }
  return [...blocks].sort((a, b) => a - b)
}

/**
 * The NFT's own ModifyLiquidity logs in each of `ranges` (one batch, one read a range, the reply at most `byteLimit`), in
 * chain order: every ModifyLiquidity the PositionManager made in the pool there, each checked, the NFT's kept (its salt).
 */
async function ownModifiesIn(rt: FeesRuntime, budget: Budget, poolId: string, tokenId: string, ranges: ReadonlyArray<readonly [number, number]>, byteLimit: number): Promise<CompactLog[][]> {
  if (ranges.length === 0) return []
  const filter = poolFilter(poolId, [TOPIC.ModifyLiquidity])
  const sender = `0x${addressWord(POSITION_MANAGER)}`
  const salt = BigInt(tokenId)
  const results = await logsBatch(rt, budget, ranges.map(([from, to]) => ({ address: POOL_MANAGER, fromBlock: hex(from), toBlock: hex(to), topics: [TOPIC.ModifyLiquidity, poolId, sender] })), byteLimit)
  return results.map((result, i) => {
    const own: CompactLog[] = []
    for (const raw of result as unknown[]) {
      const log = compact(raw, filter, ranges[i][0], ranges[i][1])
      if (log[4][1] !== sender) throw new RelayError('fatal', 'invalid_log_topics')
      // Data: tickLower, tickUpper, liquidityDelta, salt.
      if (BigInt(`0x${log[5].slice(2 + 3 * 64, 2 + 4 * 64)}`) === salt) own.push(log)
    }
    return own.sort(byPosition)
  })
}

/** The NFT's own ModifyLiquidity logs in `blocks` (one batch of one-block reads), in chain order. */
async function ownModifies(rt: FeesRuntime, budget: Budget, poolId: string, tokenId: string, blocks: readonly number[]): Promise<CompactLog[]> {
  return (await ownModifiesIn(rt, budget, poolId, tokenId, blocks.map((block) => [block, block] as const), SETTLE_TRANSFER_BYTES)).flat().sort(byPosition)
}

/** 2026-09-27: the NFT's own ModifyLiquidity logs in each span, from every PositionManager ModifyLiquidity of the pool there; a reply past MODIFIES_BYTES is too_large. */
async function modifiesLogs(rt: FeesRuntime, budget: Budget, poolId: string, tokenId: string, spans: ReadonlyArray<readonly [number, number]>): Promise<CompactLog[][]> {
  try {
    return await ownModifiesIn(rt, budget, poolId, tokenId, spans, MODIFIES_BYTES)
  } catch (error) {
    if (error instanceof RelayError && (error.kind === 'bytes' || error.kind === 'range')) throw new RelayError('fatal', 'part_too_large')
    throw error
  }
}

/** The highest head this worker has read: the head only grows, so a request below it needs no call of its own. */
let seenHead = 0

async function readPath(rt: FeesRuntime, budget: Budget, asked: PathRequest): Promise<LogsResponse> {
  const last = asked.kind === 'settlements' ? asked.to : asked.spans[asked.spans.length - 1][1]
  // A span or settlements request names blocks up to the position's state block, which was at most the head then: one
  // eth_blockNumber a request (up to a second each, from Brazil, 2026-09-25) is spared once a head past it was seen.
  if (seenHead < last) seenHead = Math.max(seenHead, await headBlock(rt, budget, last))
  const head = seenHead
  if (head < last) return { v: 1, kind: asked.kind, behind: true }
  if (asked.kind === 'span' || asked.kind === 'modifies') {
    const logs = asked.kind === 'span' ? await spanLogs(rt, budget, asked.poolId, asked.spans) : await modifiesLogs(rt, budget, asked.poolId, asked.tokenId, asked.spans)
    return { v: 1, kind: asked.kind, head, units: asked.spans.map(([from, to], i) => ({ unit: null, from, to, final: to <= head - SAFE_DEPTH, logs: logs[i] })), next: null }
  }
  const paid = (await paidBlocks(rt, budget, asked.holders, asked.currencies, asked.from, asked.to)).filter((block) => block !== asked.from)
  if (paid.length + 1 > SETTLE_BLOCKS) throw new RelayError('fatal', 'part_too_large')
  const logs = await ownModifies(rt, budget, asked.poolId, asked.tokenId, [asked.from, ...paid])
  return { v: 1, kind: 'settlements', head, units: [{ unit: null, from: asked.from, to: asked.to, final: false, logs }], next: null }
}

/** A path request read from the chain, as logsOnChain reads the relay's own kinds. */
export async function pathLogsOnChain(rt: FeesRuntime, request: PathRequest): Promise<RelayAnswer<LogsResponse>> {
  const asked = pathRequestOf({ ...request })
  if (!asked) return { ok: false, failure: 'bad_request', retryAfterMs: 0 }
  const budget = newBudget(rt)
  try {
    const value = await readPath(rt, budget, asked)
    // 2026-09-27: a modifies answer carries the NFT's own logs only; what it cost is every ModifyLiquidity the RPC sent.
    return { ok: true, value, bytes: asked.kind === 'modifies' ? Math.max(budget.bytes, JSON.stringify(value).length) : JSON.stringify(value).length }
  } catch (error) {
    return failedRead(error, budget)
  }
}
