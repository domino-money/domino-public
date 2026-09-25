/**
 * One unit of the fees history's logs (a relay LogsRequest), read from the
 * chain by the fees relay's own code (functions/_lib/fees.ts logsOnChain),
 * for the page (client.ts chainLogs, with the chain code it loads lazily) and
 * for the replay worker (feesReplay.worker.ts, with its own copy of it).
 *
 * In the worker it waits for its turn in the worker's lane (2026-09-25,
 * lib/chain/browser.ts chainLane): one request in flight for every history,
 * paced, and a refusal is the end of the run (`unavailable`: the card keeps
 * its unclaimed figure) rather than a wait and another try, so the page's own
 * reads never meet a refusal the fees logs caused.
 */
import type { FeesCache } from '../../../functions/_lib/fees'
import type { pathLogsOnChain } from '../../../functions/_lib/feesPath'
import type { ChainLane } from '../chain/browser'
import type * as ChainCodeModule from '../chain/chainCode'
import { UNAVAILABLE, chainRead, checked, isLogsResponse } from './answers'
import type { LogsRequest, LogsResponse, RelayAnswer } from './types'

/**
 * The chain code a context reads with (lib/chain/chainCode.ts). The replay worker's also reads the path kinds
 * (2026-09-25, functions/_lib/feesPath.ts), which the page never asks: without it they answer `unavailable`.
 */
export type ChainCode = Pick<typeof ChainCodeModule, 'chainDeps' | 'logsOnChain'> & { pathLogsOnChain?: typeof pathLogsOnChain }

/**
 * How a unit of logs is read: `lane` is the replay worker's, `urgent` a position page's run, `until` the time (as
 * Date.now gives it) the run's time budget ends (constants.ts BUDGET_MS): the unit stops there too.
 */
export interface LogsOptions {
  signal?: AbortSignal
  lane?: ChainLane
  urgent?: boolean
  until?: number
}

/** A unit stopped by its run's time budget: `too_large`, which ends the run as too_much_history, as its byte budget does. */
const TIME_SPENT = { ok: false, failure: 'too_large', retryAfterMs: 0 } as const

/** The cache keys' prefix only, never fetched: a scheme of its own, so the keys name no host. */
const KEY_ORIGIN = 'memory:'

/** One unit of logs, read with `code` and kept in `cache` (the context's memory, as the relay kept its units). */
export async function logsWith(code: ChainCode, cache: FeesCache, request: LogsRequest, options: LogsOptions = {}): Promise<RelayAnswer<LogsResponse>> {
  if (!chainRead()) return UNAVAILABLE
  const { signal, lane } = options
  const read = async (): Promise<RelayAnswer<LogsResponse>> => {
    try {
      const spent = () => options.until !== undefined && Date.now() >= options.until
      if (spent()) return TIME_SPENT
      if (lane && (signal?.aborted || lane.resting())) return UNAVAILABLE
      const deps = lane ? lane.deps(signal, options.until) : code.chainDeps(signal)
      const path = request.kind === 'span' || request.kind === 'settlements' ? request : null
      if (path && !code.pathLogsOnChain) return UNAVAILABLE
      const raw = path && code.pathLogsOnChain ? await code.pathLogsOnChain({ deps, cache }, path) : await code.logsOnChain({ deps, cache }, KEY_ORIGIN, request)
      const answer = checked(raw, (value): value is LogsResponse => isLogsResponse(value, request.kind))
      if (!answer.ok && spent() && !signal?.aborted) return TIME_SPENT
      return lane && !answer.ok && answer.failure === 'rate_limited' ? UNAVAILABLE : answer
    } catch {
      return UNAVAILABLE
    }
  }
  return lane ? lane.queue(read, options.urgent === true) : read()
}
