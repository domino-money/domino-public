import type { V2Receipt } from '../../finance/v2/transact'

export type FollowedReceipt = V2Receipt | { state: 'not-included' } | { state: 'batch-reverted' }
interface Follow {
  read: () => Promise<FollowedReceipt>
  available: () => 'ready' | 'paused' | 'gone'
  accept: (receipt: FollowedReceipt) => boolean
}

/**
 * A checked action keeps its receipt reader across route changes. No wallet switch, send or public fallback.
 *
 * Changed on purpose 2026-10-15 (pack 8, incident C5): for what waits on a block alone (a direct exit after its dialog
 * closed, an action looking for its new block after one left the chain) and for a close held on Base or Arbitrum One
 * until final (../lists/closeHold.ts, not moved in this package). Finality on Base and Arbitrum One is no longer followed here for New position and
 * automation: their one read at finality is the confirmation queue's (lib/confirmedOperations.ts), as on Robinhood Chain.
 */
export function createReceiptFollow(clock: { now: () => number; visible: () => boolean; set: (run: () => void, ms: number) => unknown; clear: (timer: unknown) => void }) {
  const jobs = new Map<string, Follow & { until: number; next: number; attempts: number; failures: number }>()
  let timer: unknown = null, busy = false
  const schedule = () => {
    if (timer !== null) clock.clear(timer)
    timer = null
    if (jobs.size) timer = clock.set(() => { timer = null; void tick() }, Math.max(0, Math.min(...[...jobs.values()].map(job => job.next)) - clock.now()))
  }
  async function tick() {
    if (busy) return
    busy = true
    try {
      for (const [key, job] of jobs) {
        if (clock.now() >= job.until || job.attempts >= 80 || job.available() === 'gone') { jobs.delete(key); continue }
        if (job.next > clock.now()) continue
        if (!clock.visible() || job.available() === 'paused') { job.next = clock.now() + 15_000; continue }
        job.attempts++
        job.next = clock.now() + (job.attempts < 6 ? 5_000 : job.attempts < 20 ? 15_000 : 30_000)
        try {
          const receipt = await job.read()
          if (jobs.get(key) !== job || job.available() !== 'ready') continue
          job.failures = 0
          if (job.accept(receipt)) jobs.delete(key)
        } catch (error) {
          job.failures++
          const retry = error && typeof error === 'object' && 'retryAfterMs' in error && typeof error.retryAfterMs === 'number' && Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 0
          job.next = clock.now() + Math.max(5_000, retry, Math.min(60_000, 5_000 * 2 ** Math.min(job.failures, 4)))
        }
      }
    } finally { busy = false; schedule() }
  }
  return {
    follow(key: string, follow: Follow) {
      if (jobs.has(key)) return
      jobs.set(key, { ...follow, until: clock.now() + 3_600_000, next: clock.now() + 5_000, attempts: 0, failures: 0 })
      while (jobs.size > 8) jobs.delete(jobs.keys().next().value as string)
      if (!busy) schedule()
    },
  }
}

export const RECEIPT_FOLLOW = createReceiptFollow({ now: Date.now, visible: () => typeof document === 'undefined' || !document.hidden,
  set: (run, ms) => setTimeout(run, ms), clear: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) })
