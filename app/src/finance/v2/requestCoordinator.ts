/**
 * One budget for the authenticated preparation routes. The service counts
 * origins, quotes, position plans and transfer status against the same account.
 * This is load coordination, never authentication or permission to spend.
 */
export type RequestPriority = 'tracking' | 'action' | 'preview'
export interface RequestBudget { asked: number[]; blockedUntil: number }
export interface RequestBudgetStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}
export interface RequestCoordinatorClock {
  now(): number
  setTimer(callback: () => void, milliseconds: number): () => void
}
export type RequestBudgetLock = <T>(key: string, work: () => T) => Promise<T>
export interface ScheduledRequest {
  owner: string
  priority: RequestPriority
  signal?: AbortSignal
  /** Rechecked immediately before admission; queued work never follows a new account/session. */
  isCurrent(): boolean
}
export type ScheduledResult<T> = { kind: 'completed'; value: T } | { kind: 'aborted' } | { kind: 'timeout' }

const PREFIX = 'domino.request-budget.v1.'
const WINDOW_MS = 60_000
const ACCOUNT_LIMIT = 10
// Leave room for a sent transfer or an explicit action while previews are busy.
const PREVIEW_LIMIT = 8
const PRIORITY: Record<RequestPriority, number> = { tracking: 0, action: 1, preview: 2 }
const MAX_IN_FLIGHT = 2
const MAX_QUEUE_MS = 120_000

function budgetOf(raw: string | null, now: number): RequestBudget {
  try {
    const value: unknown = raw === null ? null : JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return { asked: [], blockedUntil: 0 }
    const { asked, blockedUntil } = value as Partial<RequestBudget>
    if (!Array.isArray(asked) || asked.length > ACCOUNT_LIMIT || !asked.every((at) => typeof at === 'number' && Number.isFinite(at))) {
      return { asked: [], blockedUntil: 0 }
    }
    return {
      asked: asked.filter((at) => at > now - WINDOW_MS && at <= now + WINDOW_MS).sort((a, b) => a - b),
      blockedUntil: typeof blockedUntil === 'number' && Number.isFinite(blockedUntil) && blockedUntil > now
        ? Math.min(blockedUntil, now + 300_000) : 0,
    }
  } catch { return { asked: [], blockedUntil: 0 } }
}

export function authenticatedRequestPriority(path: string): RequestPriority | null {
  if (path === '/api/crosschain/v1/status') return 'tracking'
  if (path === '/api/position-plan/v1/plan') return 'action'
  if (path === '/api/crosschain/v1/origins' || path === '/api/crosschain/v1/quote') return 'preview'
  // Public reads and capabilities have different limits; never block them here.
  return null
}

/** A missing/malformed Retry-After uses the service's one-minute window. */
export function authenticatedRetryDelay(header: string | null, now: number): number {
  const seconds = header !== null && /^\d+$/.test(header) ? Number(header) : NaN
  const date = header !== null && !Number.isFinite(seconds) ? Date.parse(header) : NaN
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? date - now : WINDOW_MS
  return Number.isFinite(delay) && delay > 0 ? Math.min(delay, 300_000) : WINDOW_MS
}

/**
 * Added 2026-10-30 (launch capacity, CAP-6): how long a "busy" refusal holds, before the next ask. The services answer
 * every capacity-busy code (position_plan_capacity_busy, crosschain_capacity_busy, session_capacity_busy,
 * onboarding_capacity_busy) with Retry-After 60, while the slot they wait for frees in a few seconds (the planner's p50
 * is 3.8 s). So a capacity-busy refusal is asked again after CAPACITY_BUSY_WAIT_MS and up to a quarter more at random
 * (so the tabs it reached do not all come back in the same second), never later than its Retry-After; the callers ask
 * again quietly at most twice. A rate limit (*_rate_limited) keeps its Retry-After.
 */
export const CAPACITY_BUSY_WAIT_MS = 4_000

/** Whether a refusal's code is a capacity-busy one (a worker slot taken), not a rate limit. */
export const isCapacityBusy = (code: string | null | undefined): boolean => typeof code === 'string' && code.endsWith('_capacity_busy')

/** CAPACITY_BUSY_WAIT_MS and up to a quarter more, at random (`random` as Math.random, for the tests). */
export function capacityBusyWait(random: () => number = Math.random): number {
  const draw = random()
  return CAPACITY_BUSY_WAIT_MS + Math.floor(CAPACITY_BUSY_WAIT_MS * 0.25 * (Number.isFinite(draw) ? Math.min(Math.max(draw, 0), 1) : 0))
}

/**
 * How long one wallet's authenticated requests wait after a refusal (429, or 503 with Retry-After): its Retry-After, or
 * for a capacity-busy code (`code`, read from the reply's body) the short wait above when that is sooner.
 */
export function refusalDelay(header: string | null, code: string | null, now: number, random: () => number = Math.random): number {
  const named = authenticatedRetryDelay(header, now)
  return isCapacityBusy(code) ? Math.min(named, capacityBusyWait(random)) : named
}

/** Injectable clock and atomic storage make account limits and multiple tabs testable without HTTP. */
export function createAuthenticatedRequestCoordinator({
  clock, storage, lock,
}: {
  clock: RequestCoordinatorClock
  storage?: RequestBudgetStorage
  lock?: RequestBudgetLock
}) {
  const memory = new Map<string, string>()
  type Job = ScheduledRequest & {
    order: number
    waitingUntil: number
    active: boolean
    detach(): void
    abort(): void
    fail(error: unknown): void
    execute(): Promise<void>
  }
  let sequence = 0
  let inFlight = 0
  let pumping = false
  let cancelTimer: (() => void) | null = null
  const jobs: Job[] = []

  async function transact<T>(owner: string, update: (budget: RequestBudget, now: number) => T): Promise<T> {
    const key = PREFIX + owner.toLowerCase()
    const work = () => {
      const now = clock.now()
      let raw = memory.get(key) ?? null
      try { raw = storage?.getItem(key) ?? raw } catch { /* A private browser can refuse storage; this tab still coordinates. */ }
      const budget = budgetOf(raw, now)
      const result = update(budget, now)
      const saved = JSON.stringify(budget)
      memory.set(key, saved)
      try { storage?.setItem(key, saved) } catch { /* In-memory coordination remains available. */ }
      return result
    }
    return lock ? lock(key, work) : work()
  }

  function wake() {
    cancelTimer?.()
    cancelTimer = null
    void pump()
  }

  async function pump() {
    if (pumping) return
    pumping = true
    try {
      while (inFlight < MAX_IN_FLIGHT) {
        // The loop removes stale jobs, so iterate a snapshot rather than skip a neighbour.
        for (const job of jobs.slice()) {
          if (!job.active && (job.signal?.aborted || !job.isCurrent())) {
            jobs.splice(jobs.indexOf(job), 1)
            job.detach()
            job.abort()
          }
        }
        const next = jobs.filter((job) => !job.active && job.waitingUntil <= clock.now())
          .sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority] || a.order - b.order)[0]
        if (!next) break
        let wait: number
        try {
          wait = await transact(next.owner, (budget, now) => {
            if (!jobs.includes(next) || next.signal?.aborted || !next.isCurrent()) return -1
            const limit = next.priority === 'preview' ? PREVIEW_LIMIT : ACCOUNT_LIMIT
            const until = Math.max(budget.blockedUntil, budget.asked.length >= limit ? budget.asked[budget.asked.length - limit] + WINDOW_MS : 0)
            if (until > now) return until
            budget.asked.push(now)
            return 0
          })
        } catch (error) {
          // Web Locks can be unavailable for a detached/private document. Settle
          // this request; do not strand it or spin an unobserved admission loop.
          const index = jobs.indexOf(next)
          if (index !== -1) jobs.splice(index, 1)
          next.detach()
          next.fail(error)
          continue
        }
        if (!jobs.includes(next)) continue // It timed out or was cancelled while waiting for a lock.
        if (wait < 0 || next.signal?.aborted || !next.isCurrent()) {
          const index = jobs.indexOf(next)
          if (index !== -1) jobs.splice(index, 1)
          next.detach()
          next.abort()
        } else if (wait > 0) {
          next.waitingUntil = wait
        } else {
          next.active = true
          inFlight += 1
          void next.execute().finally(() => {
            inFlight -= 1
            const index = jobs.indexOf(next)
            if (index !== -1) jobs.splice(index, 1)
            next.detach()
            wake()
          })
        }
      }
    } finally {
      pumping = false
      const waiting = jobs.filter((job) => !job.active)
      if (waiting.length && inFlight < MAX_IN_FLIGHT) {
        const next = Math.min(...waiting.map((job) => job.waitingUntil))
        cancelTimer?.()
        cancelTimer = clock.setTimer(wake, Math.max(1, next - clock.now()))
      }
    }
  }

  return {
    schedule<T>(request: ScheduledRequest, send: () => Promise<T>): Promise<ScheduledResult<T>> {
      if (request.signal?.aborted || !request.isCurrent()) return Promise.resolve({ kind: 'aborted' })
      return new Promise((resolve, reject) => {
        let cancelDeadline = () => {}
        const job: Job = {
          ...request,
          order: sequence++, waitingUntil: 0, active: false,
          detach: () => { request.signal?.removeEventListener('abort', aborted); cancelDeadline() },
          abort: () => resolve({ kind: 'aborted' }),
          fail: reject,
          async execute() {
            cancelDeadline() // The transport's bounded HTTP timeout starts at admission.
            try { resolve({ kind: 'completed', value: await send() }) }
            catch (error) { reject(error) }
          },
        }
        const aborted = () => {
          if (job.active) return // The active HTTP request owns its abort and reply.
          const index = jobs.indexOf(job)
          if (index !== -1) jobs.splice(index, 1)
          job.detach()
          job.abort()
          wake()
        }
        request.signal?.addEventListener('abort', aborted, { once: true })
        jobs.push(job)
        cancelDeadline = clock.setTimer(() => {
          if (job.active) return
          const index = jobs.indexOf(job)
          if (index !== -1) jobs.splice(index, 1)
          job.detach()
          resolve({ kind: 'timeout' })
          wake()
        }, MAX_QUEUE_MS)
        wake()
      })
    },
    /** Every caller/amount shares a refusal's cooldown, including other tabs. No reply body is persisted. */
    async defer(owner: string, milliseconds: number): Promise<void> {
      await transact(owner, (budget, now) => { budget.blockedUntil = Math.max(budget.blockedUntil, now + Math.max(1, Math.min(milliseconds, 300_000))) })
      wake()
    },
    /** Session changes and cross-tab storage events can discard or recheck pending admissions immediately. */
    wake,
  }
}
