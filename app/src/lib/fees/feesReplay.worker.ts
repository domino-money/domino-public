/**
 * The fees replay worker (DESIGN-V2 §15.5): the pipeline of pipeline.ts,
 * driven by messages, off the page's main thread. It reads the relay's
 * compact logs, replays them day by day, and posts back only results: the
 * verified history, the hourly closes and a checkpoint, never raw logs. Since
 * 2026-09-25 it reads them from the chain's public RPC itself, with the
 * relay's own code (logs.ts logsWith), through one paced lane shared by
 * every run (a position page's first; a refusal ends the run), and keeps the
 * relay's units in its own memory for as long as it lives.
 *
 *   in   { type: 'run', id, state, growth, budgetBytes, checkpoint }   a new run for `id` (any earlier one is dropped)
 *        { type: 'cancel', id }                                        stop the run for `id`
 *   out  { type: 'progress', id, bytes, daysDone, daysTotal }
 *        { type: 'estimate', id, history, prices }                   2026-09-25: a busy pool's estimated history, first
 *        { type: 'done', id, result, wait }                          2026-09-27: `wait`, the lane's rest (ms) left
 *
 * A classic worker (Vite's default iife format), same-origin, spawned only by
 * spawn.ts. Its only requests are logs.ts's, to the chain's RPC, which its
 * own CSP names in connect-src (functions/_middleware.ts WORKER_CSP).
 */
import { chainLane, chainDeps, memoryCache } from '../chain/browser'
import { logsOnChain } from '../../../functions/_lib/fees'
import { pathLogsOnChain } from '../../../functions/_lib/feesPath'
import { logsWith } from './logs'
import { BUDGET_BYTES, BUDGET_MS } from './constants'
import { runPipeline } from './pipeline'
import type { FromWorker, ToWorker, WorkerResult } from './types'

interface WorkerScope {
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null
  postMessage(message: FromWorker): void
}

const scope = self as unknown as WorkerScope
/** Every run's reads share this one lane to the RPC (lib/chain/browser.ts chainLane): one request in flight, paced. */
const lane = chainLane()
/** The relay's units this worker has read, kept in its memory as the relay kept them, for as long as it lives. */
const cache = memoryCache()
const code = { chainDeps, logsOnChain, pathLogsOnChain }
const runs = new Map<string, AbortController>()

/** A pause that ends early when the run is dropped. */
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done) => {
    if (signal.aborted) return done()
    const timer = setTimeout(finish, ms)
    function finish() {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      done()
    }
    signal.addEventListener('abort', finish, { once: true })
  })

scope.onmessage = (event) => {
  const message = event.data
  // A dropped run's read on its way is stopped too, not only its next one.
  runs.get(message.id)?.abort()
  runs.delete(message.id)
  if (message.type !== 'run') return
  const run = new AbortController()
  runs.set(message.id, run)
  // A run with more than the list's budget is a position page's: its reads go before the list's in the lane.
  const urgent = message.budgetBytes > BUDGET_BYTES.list
  let deadline = Date.now() + (urgent ? BUDGET_MS.page : BUDGET_MS.list)
  const post = (out: FromWorker) => {
    if (!run.signal.aborted) scope.postMessage(out)
  }
  runPipeline(
    {
      logs: (request) => logsWith(code, cache, request, { signal: run.signal, lane, urgent, until: deadline }),
      sleep: (ms) => pause(ms, run.signal),
      progress: (report) => post({ type: 'progress', id: message.id, ...report }),
      cancelled: () => run.signal.aborted,
      timeUp: () => Date.now() >= deadline,
      // 2026-09-25: a position page's busy-pool history is drawn estimated first, then read on to its exact one.
      estimate: urgent ? (partial) => post({ type: 'estimate', id: message.id, ...partial }) : undefined,
      extend: urgent ? (ms) => void (deadline = Math.max(deadline, Date.now() + ms)) : undefined,
    },
    message,
  )
    .catch((): WorkerResult => ({ ok: false, reason: 'rpc_unavailable', prices: null, checkpoint: null, bytes: 0 }))
    .then((result) => {
      // 2026-09-27: with the lane's wait (its rest after a refusal): the store asks a failed run again once it is over.
      if (result) post({ type: 'done', id: message.id, result, wait: lane.wait() })
    })
    .finally(() => {
      if (runs.get(message.id) === run) runs.delete(message.id)
    })
}
