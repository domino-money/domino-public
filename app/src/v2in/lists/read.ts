import type { ActivityResponse, PortfolioResponse } from 'api-contracts/read-v6/types'
import { readActivity, readPortfolio, type ReadV6Reply } from '../../v2/read/v6'
import { routeServes } from '../../v2/routes'
import type { V2Transports } from '../dataSource'

/**
 * Where the Positions screen's lists read read-v6 from (spec F7 rev4 §6.2), through the integrated screens' one source
 * of V2 data (src/v2in/transports.ts, chosen by each chain's gate): the person's own positions and receipts, from the
 * site's own route, about the wallet the list is for, read only while the route's capabilities say it serves the read;
 * a route that is off is a dash with its reason, never test data (Changed on purpose (data) 2026-10-02, the owner: real
 * data only; the package's example rows are gone). Every answer passes the package's validator (src/v2/read/v6.ts).
 * Pure: the transports are handed in.
 */

/** A read's answer as the lists draw it: read-v6's own, or a route that is off (its reason in a data attribute). */
export type ListsReply<T> = ReadV6Reply<T> | { kind: 'unavailable'; reason: string }

/** The transports the lists read through: an open chain's (the site's route); null for none. */
export interface ListsTransports {
  live: V2Transports | null
}

export interface ListsSource {
  /** The wallet's own portfolio, from the site's route only. */
  ownPortfolio(wallet: string): Promise<ListsReply<PortfolioResponse>>
  /** One page of the wallet's own receipts, newest first, from the site's route only. */
  ownActivity(wallet: string, page?: { limit?: number; cursor?: string }): Promise<ListsReply<ActivityResponse>>
}

const NO_CHAIN = { kind: 'unavailable' as const, reason: 'gate_off' }

/**
 * A read not made because the route is simply not on yet (before the deploy: the family not bound, the Worker's flag
 * off, no chain open): nothing to say on screen, the list is V1's. A read that failed, or an answer the validator
 * refused, is said.
 */
const ROUTE_QUIET: ReadonlySet<string> = new Set(['gate_off', 'route_not_available', 'disabled', 'not_deployed'])
export const routeQuiet = <T,>(reply: ListsReply<T> | null): boolean => reply !== null && reply.kind === 'unavailable' && ROUTE_QUIET.has(reply.reason)

/** Whether the live route serves `read` now; its reason when it does not (src/v2/routes.ts V2RouteOff). */
async function served(t: V2Transports, read: 'portfolio' | 'activity'): Promise<string | null> {
  const state = await t.routeState('readV6')
  if (routeServes(state, read)) return null
  return state.on ? 'route_not_available' : state.reason
}

export function createListsReads(transports: () => Promise<ListsTransports>): ListsSource {
  return {
    async ownPortfolio(wallet) {
      const t = (await transports()).live
      if (!t) return NO_CHAIN
      const off = await served(t, 'portfolio')
      return off ? { kind: 'unavailable', reason: off } : readPortfolio(t.read, t.readRuntime, wallet)
    },
    async ownActivity(wallet, page = {}) {
      const t = (await transports()).live
      if (!t) return NO_CHAIN
      const off = await served(t, 'activity')
      return off ? { kind: 'unavailable', reason: off } : readActivity(t.read, t.readRuntime, wallet, page)
    },
  }
}

// ---------------------------------------------------------------------------
// A read per key, shared by every view of it, asked again by itself
// ---------------------------------------------------------------------------

export interface KeyedReader<T> {
  /** Starts reading `key` while it has a listener; returns the unsubscribe. */
  subscribe(key: string, listener: () => void): () => void
  /** The last answer for `key` (the same object until the next one arrives), or null before the first. */
  get(key: string): T | null
  /** Asks `key` again now (after something the page did). */
  again(key: string): void
}

export interface ReaderTimers {
  set(run: () => void, ms: number): unknown
  clear(handle: unknown): void
  /** Whether the page is visible: a hidden tab is not read, and is read again once shown. */
  visible(): boolean
  /** Calls `run` once, the next time the page becomes visible; returns the cancel. */
  onVisible(run: () => void): () => void
}

const browserTimers: ReaderTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  visible: () => typeof document === 'undefined' || !document.hidden,
  onVisible(run) {
    if (typeof document === 'undefined') return () => undefined
    const wake = () => {
      if (document.hidden) return
      document.removeEventListener('visibilitychange', wake)
      run()
    }
    document.addEventListener('visibilitychange', wake)
    return () => document.removeEventListener('visibilitychange', wake)
  },
}

/**
 * One read per key, shared by every component that shows it: read when the first one subscribes, kept across remounts,
 * and asked again by itself after `next(answer, failures)` milliseconds (null: not again) while someone still watches
 * and the page is visible. `failures` counts the answers in a row `failed` called failed, for a growing wait. Never a
 * Retry button: a read that failed is asked again by the page.
 */
export function createKeyedReader<T>(read: (key: string) => Promise<T>, policy: { next: (answer: T, failures: number) => number | null; failed: (answer: T) => boolean }, timers: ReaderTimers = browserTimers): KeyedReader<T> {
  interface Entry { value: T | null; listeners: Set<() => void>; timer: unknown; reading: boolean; failures: number; due: boolean; waking: (() => void) | null }
  const entries = new Map<string, Entry>()
  const entry = (key: string): Entry => {
    let found = entries.get(key)
    if (!found) {
      found = { value: null, listeners: new Set(), timer: null, reading: false, failures: 0, due: true, waking: null }
      entries.set(key, found)
    }
    return found
  }
  const start = (key: string, e: Entry) => {
    if (e.reading || e.listeners.size === 0) return
    if (!timers.visible()) {
      // Hidden: asked once the page is visible again.
      e.due = true
      if (!e.waking) {
        e.waking = timers.onVisible(() => {
          e.waking = null
          start(key, e)
        })
      }
      return
    }
    e.due = false
    e.reading = true
    void read(key).then(
      (value) => {
        e.reading = false
        e.value = value
        e.failures = policy.failed(value) ? e.failures + 1 : 0
        for (const listener of e.listeners) listener()
        const wait = policy.next(value, e.failures)
        if (wait !== null && e.listeners.size > 0) {
          e.timer = timers.set(() => {
            e.timer = null
            start(key, e)
          }, wait)
        } else if (wait !== null) e.due = true
      },
      () => {
        // The reads here never throw (they answer `unavailable`); a throw is asked again like a failure.
        e.reading = false
        e.failures += 1
        e.timer = timers.set(() => {
          e.timer = null
          start(key, e)
        }, 5_000)
      },
    )
  }
  return {
    subscribe(key, listener) {
      const e = entry(key)
      e.listeners.add(listener)
      if (e.due && e.timer === null) start(key, e)
      return () => {
        e.listeners.delete(listener)
        if (e.listeners.size > 0) return
        if (e.timer !== null) {
          timers.clear(e.timer)
          e.timer = null
          e.due = true
        }
        if (e.waking) {
          e.waking()
          e.waking = null
        }
      }
    },
    get: (key) => entries.get(key)?.value ?? null,
    again(key) {
      const e = entry(key)
      if (e.timer !== null) {
        timers.clear(e.timer)
        e.timer = null
      }
      e.due = true
      start(key, e)
    },
  }
}

/**
 * How long until a read-v6 answer is asked again: a minute after a good one; 5 s, 15 s, 45 s, then a minute after failures.
 * Changed on purpose 2026-10-06 (rugged's answer of 6 Oct, §1: the gateway's Retry-After is the real time to the lane's
 * next token): never sooner than the Retry-After a busy reader named (src/v2/read/v6.ts `retryAfterSeconds`).
 */
export function readAgainAfter<T>(reply: ListsReply<T>, failures: number): number | null {
  if (reply.kind === 'ok') return 60_000
  // An answer that broke the contract is not asked again soon: the same answer would come back.
  if (reply.kind === 'invalid') return 300_000
  const named = 'retryAfterSeconds' in reply && typeof reply.retryAfterSeconds === 'number' ? reply.retryAfterSeconds * 1000 : 0
  return Math.max([5_000, 15_000, 45_000][failures - 1] ?? 60_000, named)
}
