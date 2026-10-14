/**
 * Fixed, bounded public receipt reads. Uses the existing node transport and secret; no RPC configuration changes.
 *
 * Changed on purpose 2026-10-14 (incident C4, the 429 on this route of 2026-10-13). A question cost the node three POSTs
 * whatever the transaction's state, nothing was kept, and the transport's rest went straight to the browser. Now:
 *   - a transaction and its receipt are ONE POST (a JSON-RPC batch; rugged97's rule 5 counts a batch as one request), and
 *     the block's header is a second POST only once there is a receipt;
 *   - the finalized block is read once for everyone: fresh FINALITY_FRESH_SECONDS, then served up to
 *     FINALITY_STALE_SECONDS old while ONE refresh runs (sharedWork.ts's three rules);
 *   - a receipt is kept, for good, only when its block is at or below a finalized number the edge ALREADY held when it
 *     began to read the transaction, and its header named the receipt's own block hash. A block that was final before the
 *     read began cannot change after it, so a wrong "final" cannot be kept. Anything else is never kept (only reads in
 *     flight are shared, chainRoutes.ts), so a pending answer never delays the screen;
 *   - a rest of the transport of REST_WAIT_MS or less is waited out inside the question, once (FINALITY_REST_WAIT_MS for
 *     the finalized block's question, which the page gives 2 s in all); a longer one is the 429 it always was;
 *   - the question has a second shape, {v: 2, chainId, hash | finality}, beside the first, which tabs opened before the
 *     deploy still send. Its states (pending, included, busy, not_served) come in a 200 (secondShape, notServed).
 * What the node is asked did not change: the same two reads by hash, one header by number, the finalized header.
 */
import { FINAL_SECONDS } from './fees'
import { CHAIN_ID, RPC_URL, type AnswerCache, type ChainInit } from './owned'
import { SHARED_STALE_MS } from './sharedWork'

const HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/
const DATA = /^0x(?:[0-9a-f]{2})*$/
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
/** One node call's reply, read no further; the pair's POST carries two calls, so twice that. */
const CALL_REPLY_BYTES = 262_144
/** The most bytes an answer may take (src/lib/edge/chainRoutes.ts REPLY_BYTES.confirmation). */
const ANSWER_BYTES = 262_144

/**
 * The chains whose receipts this edge reads: the one its node is on (localRpc.ts checks the node's chain id). A question
 * of the second shape for any other chain is `not_served`, and the page reads through the person's wallet there.
 */
export const CONFIRMATION_CHAINS: readonly number[] = Object.freeze([CHAIN_ID])
/** The finalized block: asked of the node at most once per this long for everyone, and served no older than the second. */
export const FINALITY_FRESH_SECONDS = 15
export const FINALITY_STALE_SECONDS = 60
/** The longest rest of the node's transport a question waits out itself, once (the first stage of LOCAL_RPC_REST, or its pace). */
export const REST_WAIT_MS = 2_000
/**
 * The same for the finalized block's question. Changed on purpose 2026-10-14 (C4 review): the page gives that question
 * 2 s in all (src/lib/edge/confirmation.ts, and tabs opened before the deploy the same), so a wait of REST_WAIT_MS ended
 * after the page had gone and held the request for nothing. A second's wait and one POST fit; a longer rest is its busy,
 * or its 429, at once. A receipt's question has 10 s in the page and keeps REST_WAIT_MS.
 */
export const FINALITY_REST_WAIT_MS = 1_000
/**
 * The kept entries' format; bumping it retires every one.
 *
 * 2026-10-14 (C4 review): a receipt is kept for a year in each data centre on the strength of the node's own
 * "finalized" tag, with the finalized block, the receipt and its header read from the node behind LOCAL_RPC_URL as one
 * view of the chain. Whenever that node is replaced or resynced, or put behind several backends (one of which could
 * answer from an older fork), bump this and deploy: what was kept on the old node's word is then retired at once.
 */
const CACHE_VERSION = 'c1'
const STORED_AT = 'X-Confirmation-Stored-At'

/** The first shape, as tabs opened before 2026-10-14 ask it, and the second, which names its chain. */
export type ConfirmationRequest = { hash: string } | { finality: true } | { v: 2; chainId: number; hash: string } | { v: 2; chainId: number; finality: true }
export type SecondConfirmationRequest = Extract<ConfirmationRequest, { v: 2 }>
export function confirmationRequestOf(body: Record<string, unknown>): ConfirmationRequest | null {
  const keys = Object.keys(body).length
  if (body.v === 2) {
    const chainId = body.chainId
    if (keys !== 3 || typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId <= 0) return null
    if (typeof body.hash === 'string' && HASH.test(body.hash)) return { v: 2, chainId, hash: body.hash }
    return body.finality === true ? { v: 2, chainId, finality: true } : null
  }
  if (keys !== 1) return null
  if (typeof body.hash === 'string' && HASH.test(body.hash)) return { hash: body.hash }
  return body.finality === true ? { finality: true } : null
}

/** What one isolate keeps for this route between invocations: the refresh of the finalized block on its way, and when it began. */
export interface ConfirmationMemory {
  refresh: { started: number } | null
}
export const confirmationMemory = (): ConfirmationMemory => ({ refresh: null })

/** What the kept answers and the short wait need from the route (chainRoutes.ts); a caller that hands none keeps nothing. */
export interface ConfirmationEdge {
  /** The request's own origin: the kept entries' keys are under it. */
  origin?: string
  cache?: AnswerCache | null
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  waitUntil?: (work: Promise<unknown>) => void
  memory?: ConfirmationMemory
  /** True once nobody waits for the answer any more: a rest is then not waited out. */
  cancelled?: () => boolean
}

type Block = { number: string; hash: string }
type Finality = { finalized: Block | null }

function blockOf(raw: unknown): Block | null {
  if (raw === null) return null
  if (!object(raw) || typeof raw.number !== 'string' || !QUANTITY.test(raw.number) || typeof raw.hash !== 'string' || !HASH.test(raw.hash)) throw new Error('invalid_confirmation')
  return { number: raw.number, hash: raw.hash }
}

/** A kept finalized block, checked as the node's own is; null when it is not one. */
function finalityOf(value: unknown): Finality | null {
  try {
    return object(value) && 'finalized' in value ? { finalized: blockOf(value.finalized) } : null
  } catch {
    return null
  }
}

/** The transport's 429 (the isolate resting, or its pace), with its wait in whole seconds. */
class Resting {
  constructor(readonly seconds: number) {}
}
/** A Retry-After as whole seconds, 1 to 300; 5 when it names none. */
function waitOf(value: string | null): number {
  const asked = Number(value ?? Number.NaN)
  return Number.isFinite(asked) && asked >= 0 ? Math.max(1, Math.min(300, Math.ceil(asked))) : 5
}

/** One JSON-RPC reply's result under `id`; a reply of another shape, or the node's error, is no answer. */
function resultOf(body: unknown, id: number): unknown {
  if (!object(body) || body.id !== id || body.jsonrpc !== '2.0' || !('result' in body) || body.error) throw new Error('confirmation_unavailable')
  return body.result
}

/**
 * Only the fields the closed transaction clients verify; no upstream URLs, errors, or unrelated block data. Always the
 * first shape's answer ({v: 1, …}, or its 429): the route draws the second shape's from it (secondShape), so a question
 * of either shape about the same transaction shares one read of the node.
 */
export async function confirmationOnNode(fetchChain: (input: string, init: RequestInit) => Promise<Response>, asked: ConfirmationRequest, edge: ConfirmationEdge = {}): Promise<Response> {
  const now = edge.now ?? (() => Date.now())
  const sleep = edge.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  const cache = edge.cache && edge.origin ? edge.cache : null
  const memory = edge.memory ?? confirmationMemory()
  const base = `${edge.origin ?? ''}/api/chain/v1/cache/confirmation/${CACHE_VERSION}/${CHAIN_ID}`
  const finalityUrl = `${base}/finality`
  /** A kept JSON value and its age (checked here, so the rules do not depend on the cache's own max-age). */
  const kept = async (url: string): Promise<{ value: unknown; ageMs: number } | null> => {
    if (!cache) return null
    const entry = await cache.match(new Request(url)).catch(() => undefined)
    if (!entry) return null
    const at = Number(entry.headers.get(STORED_AT))
    if (!Number.isSafeInteger(at)) return null
    try {
      return { value: (await entry.json()) as unknown, ageMs: Math.max(0, now() - at) }
    } catch {
      return null
    }
  }
  const keep = async (url: string, value: unknown, seconds: number): Promise<void> => {
    if (!cache) return
    const entry = new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${seconds}`, [STORED_AT]: String(now()) } })
    const stored = cache.put(new Request(url), entry).catch(() => undefined)
    if (edge.waitUntil) edge.waitUntil(stored)
    else await stored
  }
  // One POST to the node. A rest of REST_WAIT_MS or less (FINALITY_REST_WAIT_MS for the finalized block's question) is
  // waited out here, once per question, and the POST made again; a longer one, or a second one, ends the question
  // (Resting). During a rest the transport sends nothing, so the POST after the wait is the one the page's own retry
  // would have made.
  let waited = false
  const longest = 'finality' in asked ? FINALITY_REST_WAIT_MS : REST_WAIT_MS
  const post = async (payload: unknown, replyBytes: number): Promise<unknown> => {
    for (;;) {
      const init: ChainInit = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), replyBytes }
      const response = await fetchChain(RPC_URL, init)
      if (response.status === 200) return (await response.json()) as unknown
      if (response.status !== 429) throw response
      const seconds = waitOf(response.headers.get('Retry-After'))
      await response.body?.cancel().catch(() => undefined)
      if (waited || seconds * 1000 > longest || edge.cancelled?.()) throw new Resting(seconds)
      waited = true
      await sleep(seconds * 1000)
    }
  }
  const read = async (method: string, params: unknown[]) => resultOf(await post({ jsonrpc: '2.0', id: 1, method, params }, CALL_REPLY_BYTES), 1)
  /** The transaction and its receipt in one POST. */
  const pair = async (hash: string): Promise<[unknown, unknown]> => {
    const body = await post(
      [
        { jsonrpc: '2.0', id: 0, method: 'eth_getTransactionByHash', params: [hash] },
        { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash] },
      ],
      2 * CALL_REPLY_BYTES,
    )
    if (!Array.isArray(body) || body.length !== 2) throw new Error('confirmation_unavailable')
    return [resultOf(body[0], 0), resultOf(body[1], 1)]
  }
  /** The finalized block from the node, kept for everyone as long as it may be served. */
  const readFinality = async (): Promise<Finality> => {
    const value: Finality = { finalized: blockOf(await read('eth_getBlockByNumber', ['finalized', false])) }
    await keep(finalityUrl, value, FINALITY_STALE_SECONDS)
    return value
  }
  /**
   * One refresh of the finalized block at a time per isolate, behind the answers (sharedWork.ts's three rules): handed to
   * the question's waitUntil, cleared by its own settling, and dated, so one whose request was cut off stops counting
   * after its bound. Nobody waits on it: the kept block answers meanwhile.
   */
  const refresh = (): void => {
    const running = memory.refresh
    if (running && now() - running.started <= SHARED_STALE_MS) return
    const entry = { started: now() }
    memory.refresh = entry
    const clear = () => {
      if (memory.refresh === entry) memory.refresh = null
    }
    const work = readFinality().then(clear, clear)
    edge.waitUntil?.(work)
  }
  const answer = (result: Record<string, unknown>): Response => {
    const text = JSON.stringify({ v: 1, ...result })
    if (new TextEncoder().encode(text).byteLength > ANSWER_BYTES) throw new Error('invalid_confirmation')
    return new Response(text, { headers: JSON_HEADERS })
  }
  try {
    if ('finality' in asked) {
      const held = await kept(finalityUrl)
      const value = held && finalityOf(held.value)
      if (held && value && held.ageMs < FINALITY_FRESH_SECONDS * 1000) return answer(value)
      if (held && value && held.ageMs < FINALITY_STALE_SECONDS * 1000) {
        refresh()
        return answer(value)
      }
      return answer(await readFinality())
    }
    const receiptUrl = `${base}/receipt/${asked.hash}`
    // Both are looked up BEFORE the node is asked about the transaction. The finalized number in hand is then older than
    // the read it judges: a block at or below it was final before the read began and cannot differ after it. A number
    // that arrives while the read is on its way vouches for nothing here (the next question holds it from the start).
    const [final, mark] = await Promise.all([kept(receiptUrl), kept(finalityUrl)])
    if (final && object(final.value) && object(final.value.transaction) && object(final.value.receipt) && object(final.value.block)) {
      return answer({ transaction: final.value.transaction, receipt: final.value.receipt, block: final.value.block })
    }
    const finalized = mark ? (finalityOf(mark.value)?.finalized ?? null) : null
    const [tx, receipt] = await pair(asked.hash)
    let transaction: Record<string, unknown> | null = null
    let included: Record<string, unknown> | null = null
    let block: Block | null = null
    if (tx !== null) {
      if (!object(tx) || tx.hash !== asked.hash || typeof tx.from !== 'string' || !ADDRESS.test(tx.from) || typeof tx.to !== 'string' || !ADDRESS.test(tx.to) || typeof tx.input !== 'string' || !DATA.test(tx.input) || tx.input.length > 65_538 || ![tx.value, tx.nonce].every(v=>typeof v === 'string' && QUANTITY.test(v))) throw new Error('invalid_confirmation')
      transaction = { hash: tx.hash, from: tx.from, to: tx.to, input: tx.input, value: tx.value, nonce: tx.nonce, chainId: tx.chainId }
    }
    if (receipt !== null) {
      if (!object(receipt) || receipt.transactionHash !== asked.hash || typeof receipt.blockHash !== 'string' || !HASH.test(receipt.blockHash) || ![receipt.blockNumber, receipt.gasUsed, receipt.effectiveGasPrice].every(v=>typeof v === 'string' && QUANTITY.test(v)) || !['0x0','0x1'].includes(String(receipt.status)) || typeof receipt.from !== 'string' || !ADDRESS.test(receipt.from) || !Array.isArray(receipt.logs) || receipt.logs.length > 512) throw new Error('invalid_confirmation')
      const logs = receipt.logs.map((log: unknown) => {
        if (!object(log) || typeof log.address !== 'string' || !ADDRESS.test(log.address) || !Array.isArray(log.topics) || log.topics.length > 4 || !log.topics.every(t=>typeof t==='string'&&HASH.test(t)) || typeof log.data !== 'string' || !DATA.test(log.data) || log.data.length > 32_770 || typeof log.logIndex !== 'string' || !QUANTITY.test(log.logIndex) || (log.removed !== undefined && log.removed !== false)) throw new Error('invalid_confirmation')
        return { address: log.address, topics: log.topics, data: log.data, logIndex: log.logIndex }
      })
      included = { transactionHash: receipt.transactionHash, from: receipt.from, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, status: receipt.status, logs }
      block = blockOf(await read('eth_getBlockByNumber', [receipt.blockNumber, false]))
      const response = answer({ transaction, receipt: included, block })
      // Final, and so immutable: this exact transaction, in the block its own header names, at or below the finalized
      // number held before the read. A reverted one is as final. Never a receipt without its transaction or its header.
      if (transaction && block && finalized && block.hash === receipt.blockHash && BigInt(block.number) === BigInt(receipt.blockNumber as string) && BigInt(block.number) <= BigInt(finalized.number)) {
        await keep(receiptUrl, { transaction, receipt: included, block }, FINAL_SECONDS)
      }
      return response
    }
    return answer({ transaction, receipt: included, block })
  } catch (error) {
    if (!(error instanceof Resting)) throw error
    return new Response(JSON.stringify({ v: 1, error: 'rate_limited' }), { status: 429, headers: { ...JSON_HEADERS, 'Retry-After': String(error.seconds) } })
  }
}

const secondText = (body: Record<string, unknown>): string => JSON.stringify({ v: 2, ...body })
const second = (text: string): Response => new Response(text, { status: 200, headers: JSON_HEADERS })

/** The second shape's answer for a chain this edge has no node for (CONFIRMATION_CHAINS): said at once, nothing read. */
export const notServed = (): Response => second(secondText({ state: 'not_served' }))

/**
 * The second shape's own answer, drawn from the read both shapes share (`done`: confirmationOnNode's answer as the route
 * holds it), and whether it is the calm "busy". An expected state is not an error status (2026-10-14):
 *   - in no block yet, or its block's header not there yet: `pending`; in a block: `included`, with the same three fields;
 *   - the node's transport resting longer than a question waits: `busy` with the wait, a 200, so the browser's console
 *     stays clean and the page waits as it would after a 429;
 *   - the finalized block: {v: 2, finalized}.
 * null: the route's own failure stands as it is (a 502, a 503), in the routes' one error body.
 */
export function secondShape(asked: SecondConfirmationRequest, done: { status: number; headers: readonly (readonly [string, string])[]; text: string }): { response: Response; busy: boolean } | null {
  if (done.status === 429) {
    const named = done.headers.find(([name]) => name.toLowerCase() === 'retry-after')?.[1] ?? null
    return { response: second(secondText({ state: 'busy', retryAfterMs: waitOf(named) * 1000 })), busy: true }
  }
  if (done.status !== 200) return null
  try {
    const value: unknown = JSON.parse(done.text)
    if (!object(value)) throw new Error('invalid_confirmation')
    const text = secondText('finality' in asked ? { finalized: value.finalized } : { state: object(value.receipt) && object(value.block) ? 'included' : 'pending', transaction: value.transaction, receipt: value.receipt, block: value.block })
    if (new TextEncoder().encode(text).byteLength > ANSWER_BYTES) throw new Error('invalid_confirmation')
    return { response: second(text), busy: false }
  } catch {
    return { response: new Response(JSON.stringify({ v: 1, error: 'rpc_unavailable' }), { status: 502, headers: { ...JSON_HEADERS, 'Retry-After': '5' } }), busy: false }
  }
}
