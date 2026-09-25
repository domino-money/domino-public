/**
 * The fees replay worker (DESIGN-V2 §15.5): the pipeline of pipeline.ts,
 * driven by messages, off the page's main thread. It downloads the relay's
 * compact logs, replays them day by day, and posts back only results: the
 * verified history, the hourly closes and a checkpoint, never raw logs.
 *
 *   in   { type: 'run', id, state, growth, budgetBytes, checkpoint }   a new run for `id` (any earlier one is dropped)
 *        { type: 'cancel', id }                                        stop the run for `id`
 *   out  { type: 'progress', id, bytes, daysDone, daysTotal }
 *        { type: 'done', id, result }
 *
 * A classic worker (Vite's default iife format), same-origin, spawned only by
 * spawn.ts. Its only requests are client.ts's.
 */
import { postLogs } from './client'
import { runPipeline } from './pipeline'
import type { FromWorker, ToWorker } from './types'

interface WorkerScope {
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null
  postMessage(message: FromWorker): void
}

const scope = self as unknown as WorkerScope
const runs = new Map<string, { cancelled: boolean }>()

scope.onmessage = (event) => {
  const message = event.data
  const earlier = runs.get(message.id)
  if (earlier) earlier.cancelled = true
  runs.delete(message.id)
  if (message.type !== 'run') return
  const token = { cancelled: false }
  runs.set(message.id, token)
  const post = (out: FromWorker) => {
    if (!token.cancelled) scope.postMessage(out)
  }
  runPipeline(
    {
      logs: (request) => postLogs(request),
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      progress: (report) => post({ type: 'progress', id: message.id, ...report }),
      cancelled: () => token.cancelled,
    },
    message,
  )
    .then((result) => {
      if (result) post({ type: 'done', id: message.id, result })
    })
    .catch(() => post({ type: 'done', id: message.id, result: { ok: false, reason: 'rpc_unavailable', prices: null, checkpoint: null, bytes: 0 } }))
    .finally(() => {
      if (runs.get(message.id) === token) runs.delete(message.id)
    })
}
