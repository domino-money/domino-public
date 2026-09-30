/** Opportunistic APR warming, not a replay of the wallet: one visible position at a time, at most two per list visit. */
export const APR_PREFETCH = { attempts: 2, quietMs: 1_500, betweenMs: 2_000, timeoutMs: 8_000 } as const

type Cancel = () => void
export type PrefetchEnd = 'ready' | 'failed' | 'yielded'
export interface AprPrefetchDeps {
  /** A current history is already drawn. A persisted display copy does not qualify. */
  ready(id: string): boolean
  /** Returns null when foreground work owns the store; never waits for or delays that work. */
  start(id: string, done: (result: PrefetchEnd) => void): Cancel | null
  later(ms: number, run: () => void): Cancel
}

/** Clock/store independent so cancellation, budget and ordering are exercised without a real RPC or wallet. */
export function createAprPrefetchQueue(deps: AprPrefetchDeps) {
  let visible: readonly string[] = []
  let allowed = false
  let stopped = false
  const attempted = new Set<string>()
  let pending: Cancel | null = null
  let active: { id: string; cancel: Cancel | null; timeout: Cancel | null } | null = null

  function release() {
    const job = active
    active = null // Ignore a completion emitted by cancellation itself.
    job?.timeout?.()
    job?.cancel?.()
  }
  function unschedule() {
    pending?.()
    pending = null
  }
  const candidate = () => visible.find((id) => !attempted.has(id) && !deps.ready(id))
  function schedule(ms: number) {
    if (stopped || !allowed || active || pending || attempted.size >= APR_PREFETCH.attempts || !candidate()) return
    pending = deps.later(ms, () => {
      pending = null
      if (stopped || !allowed || active) return
      const id = candidate()
      if (!id) return
      attempted.add(id)
      const job = { id, cancel: null as Cancel | null, timeout: null as Cancel | null }
      active = job
      const finish = (result: PrefetchEnd) => {
        if (active !== job) return
        // Failure, timeout or preemption ends this visit's background budget; no retry loop behind the list.
        if (result !== 'ready') stopped = true
        release()
        schedule(APR_PREFETCH.betweenMs)
      }
      job.timeout = deps.later(APR_PREFETCH.timeoutMs, () => finish('failed'))
      try {
        const cancel = deps.start(id, finish)
        if (active === job) {
          job.cancel = cancel
          if (!cancel) finish('yielded')
        } else cancel?.() // A cached answer or refusal can complete synchronously during subscription.
      } catch {
        finish('failed')
      }
    })
  }

  return {
    /** Ordered on-screen ids only. Hidden tab, offline, closed tab or wallet refresh pauses and releases immediately. */
    update(ids: readonly string[], enabled: boolean) {
      visible = [...new Set(ids)]
      allowed = enabled
      if (!allowed || (active && !visible.includes(active.id))) release()
      if (!allowed || visible.length === 0) unschedule()
      schedule(APR_PREFETCH.quietMs)
    },
    /** Navigation, wallet change or list unmount. The new foreground screen never waits for this queue. */
    dispose() {
      stopped = true
      unschedule()
      release()
    },
  }
}

export type AprPrefetchQueue = ReturnType<typeof createAprPrefetchQueue>
