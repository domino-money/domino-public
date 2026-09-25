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

/** The /state reads on their way, by id set: a position page and its fees card ask the same ids at once, and share one read. */
const statesAsked = new Map<string, Promise<RelayAnswer<StateResponse>>>()

/**
 * Up to eight positions at one block (head − 2), read from the chain. Two
 * askers of the same ids while a read is on its way share it (2026-09-25: each
 * read is three calls from the visitor's own address, under the RPC's limit);
 * a read that has answered is never reused, so a page reading again after an
 * action gets the chain as it is then.
 */
export async function chainState(tokenIds: readonly string[], signal?: AbortSignal): Promise<RelayAnswer<StateResponse>> {
  if (!chainRead() || signal?.aborted) return UNAVAILABLE
  const key = [...tokenIds].sort().join(',')
  let read = statesAsked.get(key)
  if (!read) {
    read = chainCode()
      .then((code) => code.stateOnChain({ deps: code.chainDeps(), cache: (cache ??= code.memoryCache()) }, tokenIds))
      .then((answer) => checked(answer, isStateResponse), (): RelayAnswer<StateResponse> => UNAVAILABLE)
      .finally(() => statesAsked.delete(key))
    statesAsked.set(key, read)
  }
  return unlessDropped(read, signal, UNAVAILABLE)
}
