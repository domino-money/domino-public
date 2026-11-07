import type { ActivityResponse, PortfolioResponse } from 'api-contracts/read-v6/types'
import { chainHasDex } from '../../v2/chains'
import { readActivity, readPortfolio, type ReadV6Reply } from '../../v2/read/v6'
import { routeServes } from '../../v2/routes'
import type { V2ReadTransports } from '../transports'
import { pageWake, wakeDue } from '../../lib/wake'
import { jittered } from '../../lib/jitter'

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

/**
 * A read about a Uniswap version its chain lacks (added 2026-11-06, Elysium readiness; rugged97's #459: v3 on a chain
 * with v4 alone, which read-v6 refuses with invalid_request): never sent. Its answer is this one, given here: not
 * available on that network, which a screen draws as it draws a chain with nothing to show (no fault, no new words),
 * and never asked again (`offNetworkReply`, for a reader's policy).
 */
export const OFF_NETWORK: { readonly kind: 'unavailable'; readonly reason: 'dex_not_on_chain' } = Object.freeze({ kind: 'unavailable', reason: 'dex_not_on_chain' })
/** Whether a read of these positions on `chainId` would be about a version the chain lacks. */
export const offNetwork = (chainId: number, positions: readonly { dex: number }[]): boolean => positions.some((position) => !chainHasDex(chainId, position.dex))
/** Whether an answer is that one: a reader asks it never again. */
export const offNetworkReply = (reply: { kind: string; reason?: unknown }): boolean => reply.kind === 'unavailable' && reply.reason === OFF_NETWORK.reason

/** The transports the lists read through: an open chain's (the site's route); null for none. */
export interface ListsTransports {
  live: V2ReadTransports | null
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
async function served(t: V2ReadTransports, read: 'portfolio' | 'activity'): Promise<string | null> {
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
  /** Latest attempt, including a failure while get() preserves the last good answer. */
  getLatest(key: string): T | null
  /** Asks `key` again now (after something the page did). */
  again(key?: string): void
  /** Reprojects already known data without starting another network request. */
  update(project: (value: T, key: string) => T): void
}

export interface ReaderTimers {
  set(run: () => void, ms: number): unknown
  clear(handle: unknown): void
  /** Whether the page is visible: a hidden tab is not read, and is read again once shown. */
  visible(): boolean
  /** Calls `run` once, the next time the page becomes visible; returns the cancel. */
  onVisible(run: () => void): () => void
  now?(): number
  /**
   * Calls `run` at each of the page's wake rounds (lib/wake.ts): back into view or back online, at most one each 10 s.
   * Changed on purpose 2026-10-14 (incident 2026-10-13, design 2.5, package Q1): it was every focus, online and
   * visibility change.
   */
  onWake?(run: () => void): () => void
}

const browserTimers: ReaderTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  visible: () => typeof document === 'undefined' || !document.hidden,
  now: () => Date.now(),
  onWake: (run) => pageWake.onWake(run),
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
export function createKeyedReader<T>(read: (key: string, active: () => boolean) => Promise<T>, policy: { next: (answer: T, failures: number) => number | null; failed: (answer: T) => boolean }, timers: ReaderTimers = browserTimers): KeyedReader<T> {
  /** `goodAt` and `period` (2026-10-14, Q1): when the last good answer came, and the wait its policy set after it (null: none). */
  interface Entry { value: T | null; latest: T | null; listeners: Set<() => void>; timer: unknown; reading: boolean; failures: number; due: boolean; generation: number; observing: number; notBefore: number; waking: (() => void) | null; goodAt: number | null; period: number | null }
  const entries = new Map<string, Entry>()
  const now = () => timers.now?.() ?? Date.now()
  let stopWake: (() => void) | null = null
  const entry = (key: string): Entry => {
    let found = entries.get(key)
    if (!found) {
      found = { value: null, latest: null, listeners: new Set(), timer: null, reading: false, failures: 0, due: true, generation: 0, observing: 0, notBefore: 0, waking: null, goodAt: null, period: null }
      entries.set(key, found)
    }
    return found
  }
  const schedule = (key: string, e: Entry, ms: number) => {
    if (e.timer !== null) timers.clear(e.timer)
    e.timer = null
    if (e.listeners.size === 0) { e.due = true; return }
    e.timer = timers.set(() => { e.timer = null; start(key, e) }, ms)
  }
  const start = (key: string, e: Entry) => {
    if (e.reading || e.listeners.size === 0) return
    if (e.notBefore > now()) { schedule(key, e, e.notBefore - now()); return }
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
    const generation = ++e.generation, observing = e.observing
    // Follow-up work belongs only to this visible, observed generation, including after the primary reply lands.
    void read(key, () => e.listeners.size > 0 && generation === e.generation && observing === e.observing && timers.visible()).then(
      (value) => {
        e.reading = false
        const failed = policy.failed(value)
        e.failures = failed ? e.failures + 1 : 0
        const wait = policy.next(value, e.failures)
        e.notBefore = failed && wait !== null ? now() + wait : 0
        if (!failed) {
          e.goodAt = now()
          e.period = wait
        }
        // A confirmation during this request cannot be consumed by its older response.
        if (generation === e.generation) {
          e.latest = value
          if (!failed || e.value === null || policy.failed(e.value)) e.value = value
          for (const listener of e.listeners) listener()
        }
        if (e.due || generation !== e.generation) {
          if (failed && wait !== null) schedule(key, e, wait)
          else start(key, e)
        } else if (wait !== null) schedule(key, e, wait)
      },
      () => {
        // The reads here never throw (they answer `unavailable`); a throw is asked again like a failure.
        e.reading = false
        e.failures += 1
        e.notBefore = now() + 5_000
        schedule(key, e, 5_000)
      },
    )
  }
  const again = (key?: string) => {
    const targets = key === undefined ? [...entries].filter(([, e]) => e.listeners.size > 0) : [[key, entry(key)] as const]
    for (const [name, e] of targets) {
      if (e.timer !== null) { timers.clear(e.timer); e.timer = null }
      e.generation++
      e.due = true
      start(name, e)
    }
  }
  /**
   * A wake round (lib/wake.ts): each watched key whose last good answer is older than its own period (wakeDue), unless it is
   * being read or waits out a failure (an error slows a reader down, never speeds it up). Changed on purpose 2026-10-14
   * (incident 2026-10-13, design 2.5, package Q1): every watched key was read again at every wake, and a read in flight was
   * dropped for a new one.
   */
  const wake = () => {
    const at = now()
    for (const [name, e] of entries) {
      if (e.listeners.size === 0 || e.reading || e.notBefore > at || !wakeDue(e.goodAt, e.period, at)) continue
      again(name)
    }
  }
  return {
    subscribe(key, listener) {
      const e = entry(key)
      e.listeners.add(listener)
      stopWake ??= timers.onWake?.(wake) ?? null
      if (e.due && e.timer === null) start(key, e)
      return () => {
        e.listeners.delete(listener)
        if (e.listeners.size > 0) return
        e.observing++
        if (e.timer !== null) {
          timers.clear(e.timer)
          e.timer = null
          e.due = true
        }
        if (e.waking) {
          e.waking()
          e.waking = null
        }
        if (![...entries.values()].some((item) => item.listeners.size)) { stopWake?.(); stopWake = null }
      }
    },
    get: (key) => entries.get(key)?.value ?? null,
    getLatest: (key) => entries.get(key)?.latest ?? null,
    again,
    update(project) {
      for (const [key, e] of entries) {
        if (e.value === null) continue
        const next = project(e.value, key)
        if (next === e.value) continue
        if (e.latest === e.value) e.latest = next
        e.value = next
        for (const listener of e.listeners) listener()
      }
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
  // (2026-10-15, pack 8, Q3): the Retry-After plus 0 to 25% at random (../../lib/jitter.ts), never less than it named.
  const named = 'retryAfterSeconds' in reply && typeof reply.retryAfterSeconds === 'number' ? jittered(reply.retryAfterSeconds * 1000) : 0
  return Math.max([5_000, 15_000, 45_000][failures - 1] ?? 60_000, named)
}
