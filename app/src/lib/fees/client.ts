/**
 * The page's and the replay worker's reads for the fees history (DESIGN-V2
 * §15.4): a position NFT's state at one block, and one unit of a pool's or an
 * NFT's logs.
 *
 * 2026-09-25: read straight from the chain's public RPC, in this page or in
 * this worker, by the fees relay's own code (functions/_lib/fees.ts
 * stateOnChain and logsOnChain, through lib/chain/browser.ts), no longer
 * through the site's routes (functions/api/fees/v1/*): the RPC answers 429 to
 * every call from Cloudflare's edge, so the routes failed in production. The
 * reads, units, caps, splits and 429 waits are the relay's; the relay's
 * Workers cache is this context's memory. Every answer is checked here field
 * by field, as a route's reply was.
 *
 * Nothing is asked in a build that is not meant to reach the chain: the
 * fixture and bridge-test builds answer `unavailable` without a request (the
 * check is made inside each call, never when the module loads), and the
 * screens then show what they show without the history.
 *
 * The chain code itself (the relay's reads, the RPC runtime, Keccak) is
 * loaded on the first read (lib/chain/chainCode.ts): this module rides in the
 * entry every page loads with the fees hooks. The checks are answers.ts's;
 * a unit of logs is read by logs.ts, which the replay worker shares.
 */
import type { FeesCache } from '../../../functions/_lib/fees'
import { UNAVAILABLE, chainRead, checked, isStateResponse } from './answers'
import { logsWith, type LogsOptions } from './logs'
import { noteAutomation, parseAutomationAnswer } from '../automationState'
import { noteTokens } from '../chainTokens'
import type { LogsRequest, LogsResponse, RelayAnswer, StateResponse } from './types'

export { isLogsResponse, isStateResponse } from './answers'
export type { LogsOptions } from './logs'

/** The chain code (lib/chain/chainCode.ts), loaded on the first read. */
const chainCode = () => import('../chain/chainCode')

/** This page's relay cache, in memory for as long as the page lives: made on the first read. */
let cache: FeesCache | null = null
/** For tests: forget this context's relay cache (functions/_lib/fees.ts resetRelayMemory forgets the rest). */
export function forgetChainMemory(): void {
  cache = null
}

/** One unit of logs (a relay LogsRequest), read from the chain (logs.ts: the replay worker reads its own the same way). */
export async function chainLogs(request: LogsRequest, options: LogsOptions = {}): Promise<RelayAnswer<LogsResponse>> {
  if (!chainRead()) return UNAVAILABLE
  try {
    const code = await chainCode()
    return await logsWith(code, (cache ??= code.memoryCache()), request, options)
  } catch {
    return UNAVAILABLE
  }
}

/** Resolves with `work`'s answer, or with `fallback` as soon as `signal` aborts (the work itself goes on for whoever else waits on it). */
function unlessDropped<T>(work: Promise<T>, signal: AbortSignal | undefined, fallback: T): Promise<T> {
  if (!signal) return work
  return new Promise((resolve) => {
    const drop = () => resolve(fallback)
    signal.addEventListener('abort', drop, { once: true })
    void work.then((value) => {
      signal.removeEventListener('abort', drop)
      resolve(value)
    })
  })
}

/**
 * The /state reads on their way, by id set: a position page and its fees card ask the same ids at once, and share one
 * read. 2026-09-28 (speed wave B, item 43): with how many askers still wait for it (one with no signal waits for good),
 * and its own signal: once every asker has left, the read makes no further call.
 */
const statesAsked = new Map<string, { answer: Promise<RelayAnswer<StateResponse>>; waiting: number; stop: AbortController }>()

/**
 * The position's features a /state read carried (item 17), for the chips, badges and cards that show them, and its tokens
 * (item 25), for Receipts.
 */
function noted(answer: RelayAnswer<StateResponse>): RelayAnswer<StateResponse> {
  if (answer.ok) for (const position of answer.value.positions) if (position.ok) noteTokens(position.currencies)
  const features = answer.ok ? answer.value.automation : undefined
  const parsed = features && parseAutomationAnswer({ block: answer.ok && answer.value.block, positions: features }, features.map((one) => one.tokenId))
  parsed?.positions.forEach(noteAutomation)
  return answer
}

/**
 * Up to eight positions at one block (head − 2), read from the chain, each with its feature (item 17). Two askers of
 * the same ids while a read is on its way share it (2026-09-25: each read is three calls from the visitor's own
 * address, under the RPC's limit); a read that has answered is never reused, so a page reading again after an action
 * gets the chain as it is then.
 */
export async function chainState(tokenIds: readonly string[], signal?: AbortSignal): Promise<RelayAnswer<StateResponse>> {
  if (!chainRead() || signal?.aborted) return UNAVAILABLE
  const key = [...tokenIds].sort().join(',')
  let read = statesAsked.get(key)
  if (!read) {
    const stop = new AbortController()
    const answer = chainCode()
      .then((code) => code.stateOnChain({ deps: code.chainDeps(stop.signal), cache: (cache ??= code.memoryCache()) }, tokenIds, true))
      .then((answer) => checked(noted(answer), isStateResponse), (): RelayAnswer<StateResponse> => UNAVAILABLE)
      .finally(() => statesAsked.get(key) === read && statesAsked.delete(key))
    read = { answer, waiting: 0, stop }
    statesAsked.set(key, read)
  }
  const shared = read
  shared.waiting += 1
  signal?.addEventListener(
    'abort',
    () => {
      if (--shared.waiting > 0) return
      shared.stop.abort()
      if (statesAsked.get(key) === shared) statesAsked.delete(key)
    },
    { once: true },
  )
  return unlessDropped(shared.answer, signal, UNAVAILABLE)
}

/**
 * 2026-09-28 (speed wave B, item 24): a position page's first read, started by Positions as soon as the route names the
 * NFT, before the page's chunk is in; the page's first ask takes it (takeWarmState) rather than reading again.
 */
let warm: { id: string; answer: Promise<RelayAnswer<StateResponse>>; at: number } | null = null
export function warmState(tokenId: string): void {
  if (warm?.id !== tokenId) warm = { id: tokenId, answer: chainState([tokenId]), at: Date.now() }
}
/** The read warmState started for `tokenId`, if it is the last one and at most WARM_MS old; taken once. */
export function takeWarmState(tokenId: string): Promise<RelayAnswer<StateResponse>> | null {
  const found = warm?.id === tokenId && Date.now() - warm.at < WARM_MS ? warm.answer : null
  warm = null
  return found
}
const WARM_MS = 5_000
