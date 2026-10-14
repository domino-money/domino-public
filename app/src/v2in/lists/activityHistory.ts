import type { ActivityResponse, IndexedToken } from 'api-contracts/read-v6/types'
import { readAgainAfter, type ListsReply, type ReaderTimers } from './read'
import { compareChronology, logIndexOf } from './chronology'

export type ActivityItem = ActivityResponse['items'][number]
type Failure = Exclude<ListsReply<ActivityResponse>, { kind: 'ok' }>
export interface ActivityHistory {
  answer: ActivityResponse | null
  error: Failure | null
  loading: boolean
  more: boolean
  /** A refresh has not yet reached the history already loaded. */
  catchingUp: boolean
}
export interface ActivityConfirmation { chainId: number; block: number; finalized?: boolean }
type Read = (wallet: string, page: { limit: number; cursor?: string }) => Promise<ListsReply<ActivityResponse>>
interface Walk { cursor: string; upper?: ActivityItem; cursors: Set<string> }
interface Gap extends Walk { join: Set<string> }
interface Pending extends Walk { targets: Set<string>; checked: Set<string> }
type Job = { kind: 'head'; generation: number } | { kind: 'older' | 'gap' | 'pending'; walk: Walk }
const PAGE = 20, HEAD_DELAY = 60_000, WORK_DELAY = 1_000, WORK_PAUSE = 5_000, FAST_DELAY = 2_000
const EMPTY: ActivityHistory = Object.freeze({ answer: null, error: null, loading: false, more: false, catchingUp: false })

/** The backend's chronological key, with a stable tie-breaker; never sort by transaction hash or status. */
export function compareActivity(a: ActivityItem, b: ActivityItem): number {
  const key = (item: ActivityItem) => ({ id: item.id, at: item.tx.snapshot.timestamp, chainId: item.chainId, block: item.tx.snapshot.number, logIndex: logIndexOf(item.id) })
  return compareChronology(key(a), key(b))
}
export function mergeTokens(older: readonly IndexedToken[], newer: readonly IndexedToken[]): IndexedToken[] {
  return [...new Map([...older, ...newer].map((token) => [String(token.chainId) + ':' + token.address.toLowerCase(), token])).values()]
}
const walk = (cursor: string, upper?: ActivityItem): Walk => ({ cursor, upper, cursors: new Set() })
const sameBlock = (a: ActivityItem, b: ActivityItem) => a.chainId === b.chainId && a.tx.hash.toLowerCase() === b.tx.hash.toLowerCase()
  && a.tx.snapshot.number === b.tx.snapshot.number && a.tx.snapshot.hash.toLowerCase() === b.tx.snapshot.hash.toLowerCase()

/** One wallet-keyed public history. The recent head, missing intervals and old pending receipts have independent
 * progress, but share one bounded request at a time and the service's Retry-After. A head overlapping its recent
 * segment cannot erase an older gap. Pending receipts are reread through the existing activity API, never a new RPC.
 *
 * `heard` (added 2026-10-14, incident C2): every good answer, as it arrived, before any of it is merged. Each names its
 * chains' finalized block, which is how the confirmation queue learns finality with no request of its own (activity.tsx).
 */
export function createActivityHistory(read: Read, timers: ReaderTimers, refresh = true, heard: (answer: ActivityResponse) => void = () => undefined) {
  interface Entry {
    value: ActivityHistory; listeners: Set<() => void>; timer: unknown; waking: (() => void) | null; inFlight: boolean
    headAt: number | null; workAt: number | null; notBefore: number; retry: { job: Job; at: number } | null
    generation: number; tail: Walk | null; gaps: Gap[]; pending: Pending | null; workCount: number; preferPending: boolean
    restarted: boolean; restartNeeded: boolean; recoveryJoin: Set<string> | null; failures: number; fastReads: number
    confirmations: Map<number, ActivityConfirmation>
    checkedPending: Set<string>
  }
  const entries = new Map<string, Entry>()
  const now = () => timers.now?.() ?? Date.now()
  const entry = (wallet: string): Entry => {
    let e = entries.get(wallet)
    if (!e) {
      e = { value: EMPTY, listeners: new Set(), timer: null, waking: null, inFlight: false, headAt: now(), workAt: null,
        notBefore: 0, retry: null, generation: 0, tail: null, gaps: [], pending: null, workCount: 0, preferPending: false,
        restarted: false, restartNeeded: false, recoveryJoin: null, failures: 0, fastReads: 0, confirmations: new Map(), checkedPending: new Set() }
      entries.set(wallet, e)
    }
    return e
  }
  const publish = (e: Entry, patch: Partial<ActivityHistory>) => {
    e.value = { ...e.value, ...patch, more: e.tail !== null || e.gaps.length > 0 || e.recoveryJoin !== null,
      catchingUp: e.gaps.length > 0 || e.recoveryJoin !== null }
    for (const listener of e.listeners) listener()
  }
  const nextWork = (e: Entry): Job | null => {
    if (e.pending && (e.preferPending || !e.gaps.length)) { e.preferPending = false; return { kind: 'pending', walk: e.pending } }
    if (e.gaps.length) { e.preferPending = true; return { kind: 'gap', walk: e.gaps[0] } }
    return null
  }
  const schedule = (wallet: string, e: Entry) => {
    if (e.timer !== null) timers.clear(e.timer)
    e.timer = null
    if (e.inFlight || e.listeners.size === 0) return
    const due = [e.headAt, e.workAt, e.retry?.at].filter((at): at is number => at !== null && at !== undefined)
    if (!due.length) return
    const wait = Math.max(0, Math.max(e.notBefore, Math.min(...due)) - now())
    if (wait === 0) { void pump(wallet, e); return }
    e.timer = timers.set(() => { e.timer = null; void pump(wallet, e) }, wait)
  }
  const continueWork = (e: Entry) => {
    if (!e.gaps.length && !e.pending) { e.workAt = null; return }
    // A short pause every three pages bounds backfill without stopping the recent-head lane.
    e.workAt = now() + (++e.workCount % 3 === 0 ? WORK_PAUSE : WORK_DELAY)
  }
  const pump = async (wallet: string, e: Entry) => {
    if (e.inFlight || e.listeners.size === 0) return
    if (e.notBefore > now()) { schedule(wallet, e); return }
    if (!timers.visible()) {
      if (!e.waking) e.waking = timers.onVisible(() => {
        e.waking = null; e.generation++; e.headAt = now(); schedule(wallet, e)
      })
      return
    }
    if (e.retry?.job.kind !== 'head' && e.retry) {
      const retry = e.retry.job
      const active = retry.kind === 'older' ? e.tail === retry.walk : retry.kind === 'pending' ? e.pending === retry.walk : e.gaps.includes(retry.walk as Gap)
      if (!active) e.retry = null
    }
    let job: Job | null = null
    // Due recent reads always win, even if an old page repeatedly fails.
    if (e.headAt !== null && e.headAt <= now()) { e.headAt = null; job = { kind: 'head', generation: e.generation } }
    else if (e.retry && e.retry.at <= now()) { job = e.retry.job; e.retry = null }
    else if (e.workAt !== null && e.workAt <= now()) { e.workAt = null; job = nextWork(e) }
    if (!job) { schedule(wallet, e); return }
    e.inFlight = true
    publish(e, { loading: true })
    let reply: ListsReply<ActivityResponse>
    try { reply = await read(wallet, { limit: PAGE, ...(job.kind !== 'head' ? { cursor: job.walk.cursor } : {}) }) }
    catch { reply = { kind: 'unavailable', reason: 'upstream_unavailable' } }
    e.inFlight = false
    if (reply.kind !== 'ok') {
      const expired = job.kind !== 'head' && reply.kind === 'unavailable' && ['invalid_or_expired_cursor', 'catalogue_revision_changed'].includes(reply.reason)
      if (expired && !e.restarted) {
        e.restarted = true; e.restartNeeded = true; e.retry = null; e.workAt = null
        e.recoveryJoin = e.gaps[0]?.join ?? e.recoveryJoin
        const named = 'retryAfterSeconds' in reply && typeof reply.retryAfterSeconds === 'number' ? reply.retryAfterSeconds * 1_000 : 0
        e.notBefore = Math.max(e.notBefore, now() + named); e.headAt = now() + WORK_DELAY
      } else {
        const wait = readAgainAfter(reply, ++e.failures) ?? HEAD_DELAY
        e.notBefore = Math.max(e.notBefore, now() + wait)
        e.retry = { job, at: e.notBefore }
        if (job.kind === 'head') e.headAt = e.notBefore
      }
      publish(e, { error: reply, loading: false }); schedule(wallet, e); return
    }
    heard(reply.body)
    // A confirmation during a head request must be consumed by a newer read, not this older response.
    if (job.kind === 'head' && job.generation !== e.generation) {
      e.headAt = now(); publish(e, { loading: false }); schedule(wallet, e); return
    }
    const previous = e.value.answer
    const known = new Map(previous?.items.map((item) => [item.id, item]) ?? [])
    const beforeIds = new Set(known.keys())
    const last = reply.body.items.at(-1)
    const upper = job.kind === 'head' ? undefined : job.walk.upper
    const end = reply.body.nextCursor === null && reply.body.coverage === 'complete'
    // Reorg removal is allowed only inside a fully reread interval of a current, sufficiently indexed chain.
    // The same rule applies beyond the first page, so old tentative records are not retained forever.
    for (const [id, item] of known) {
      const chain = reply.body.chains.find((value) => value.chainId === item.chainId)
      const current = chain?.status === 'current' && chain.indexedThrough !== null && chain.indexedThrough.number >= item.tx.snapshot.number
      // A cursor excludes the previous page's final event. Its absence from this older page
      // cannot prove a reorg, even when another event in that same transaction is reread.
      const inWindow = (!upper || compareActivity(item, upper) > 0) && (end || (last && compareActivity(item, last) <= 0))
      if (current && inWindow && item.tx.finality !== 'finalized') known.delete(id)
    }
    for (const item of reply.body.items) {
      const old = previous?.items.find((value) => value.id === item.id)
      // A historical page can have an older finality observation for the exact same canonical transaction.
      known.set(item.id, old?.tx.finality === 'finalized' && item.tx.finality !== 'finalized' && sameBlock(old, item) ? old : item)
    }
    let stalled = false
    if (job.kind === 'head') {
      if (!previous || !previous.items.length || e.restartNeeded) {
        e.tail = reply.body.nextCursor ? walk(reply.body.nextCursor, last) : null
        if (e.recoveryJoin && reply.body.nextCursor) e.gaps = [{ ...walk(reply.body.nextCursor, last), join: e.recoveryJoin }]
        else if (e.restartNeeded) e.gaps = []
        e.pending = null; e.recoveryJoin = null; e.restartNeeded = false
      } else if (reply.body.nextCursor && !reply.body.items.some((item) => beforeIds.has(item.id))) {
        const join = new Set(previous.items.slice(0, PAGE).map((item) => item.id))
        e.gaps.push({ ...walk(reply.body.nextCursor, last), join })
        // One wider walk covers these intervals if a very busy wallet creates more than eight gaps.
        if (e.gaps.length > 8) e.gaps = [{ ...walk(reply.body.nextCursor, last), join: e.gaps[0].join }]
      }
      if (reply.body.nextCursor === null && reply.body.coverage === 'complete') { e.tail = null; e.gaps = [] }
      for (const [chainId, confirmation] of e.confirmations) {
        const chain = reply.body.chains.find((value) => value.chainId === chainId)
        if (chain?.status === 'current' && chain.indexedThrough && chain.indexedThrough.number >= confirmation.block
          && (!confirmation.finalized || (chain.finalizedThrough && chain.finalizedThrough.number >= confirmation.block))) e.confirmations.delete(chainId)
      }
      if (e.fastReads > 0) e.fastReads--
      e.headAt = refresh ? now() + (e.fastReads > 0 && e.confirmations.size ? FAST_DELAY : HEAD_DELAY) : null
      if (e.retry?.job.kind === 'head') e.retry = null
      if (refresh && !e.pending && reply.body.nextCursor) {
        const headIds = new Set(reply.body.items.map((item) => item.id))
        const pending = [...known.values()].filter((item) => item.tx.finality !== 'finalized' && !headIds.has(item.id)).sort(compareActivity)
        const ids = new Set(pending.map((item) => item.id))
        for (const id of e.checkedPending) if (!ids.has(id)) e.checkedPending.delete(id)
        if (pending.length && pending.every((item) => e.checkedPending.has(item.id))) e.checkedPending.clear()
        const targets = pending.filter((item) => !e.checkedPending.has(item.id)).slice(0, PAGE)
        if (targets.length) e.pending = { ...walk(reply.body.nextCursor, last), targets: new Set(targets.map((item) => item.id)), checked: new Set(targets.map((item) => item.id)) }
      }
      if ((e.gaps.length || e.pending) && e.workAt === null) e.workAt = now() + WORK_DELAY
    } else {
      const cursor = job.walk.cursor
      job.walk.cursors.add(cursor)
      stalled = reply.body.nextCursor !== null && job.walk.cursors.has(reply.body.nextCursor)
      if (job.kind === 'gap') {
        const gap = job.walk as Gap
        const joined = reply.body.items.some((item) => gap.join.has(item.id))
        if (joined || reply.body.nextCursor === null || stalled) e.gaps = e.gaps.filter((value) => value !== gap)
        if (reply.body.nextCursor === null) e.tail = null
        if (stalled) e.recoveryJoin = e.gaps[0]?.join ?? gap.join
      } else if (job.kind === 'pending') {
        const pending = job.walk as Pending
        for (const id of pending.targets) if (!known.has(id) || reply.body.items.some((item) => item.id === id)) pending.targets.delete(id)
        if (!pending.targets.size || reply.body.nextCursor === null || stalled) {
          for (const id of pending.checked) e.checkedPending.add(id)
          e.pending = null
        }
      } else if (reply.body.nextCursor === null || stalled) e.tail = null
      if (reply.body.nextCursor !== null && !stalled) { job.walk.cursor = reply.body.nextCursor; if (last) job.walk.upper = last }
      if (stalled) { e.restartNeeded = true; e.workAt = null }
      else { e.restarted = false; continueWork(e) }
    }
    e.failures = 0; e.notBefore = 0
    const answer = { ...(job.kind === 'head' || !previous ? reply.body : previous), items: [...known.values()].sort(compareActivity),
      tokens: mergeTokens(previous?.tokens ?? [], reply.body.tokens), nextCursor: e.gaps[0]?.cursor ?? e.tail?.cursor ?? null }
    publish(e, { answer, error: stalled ? { kind: 'unavailable', reason: 'pagination_stalled' } : null, loading: false })
    schedule(wallet, e)
  }
  return {
    get: (wallet: string): ActivityHistory => entries.get(wallet)?.value ?? EMPTY,
    subscribe(wallet: string, listener: () => void) {
      const e = entry(wallet); e.listeners.add(listener); schedule(wallet, e)
      return () => {
        e.listeners.delete(listener)
        if (e.listeners.size) return
        if (e.timer !== null) timers.clear(e.timer)
        e.timer = null; e.waking?.(); e.waking = null
      }
    },
    more(wallet: string) {
      const e = entry(wallet)
      // Manual paging cannot bypass the read service's retry floor.
      if (e.inFlight || e.retry || e.notBefore > now()) return
      const job: Job | null = e.gaps.length ? { kind: 'gap', walk: e.gaps[0] } : e.tail ? { kind: 'older', walk: e.tail } : null
      if (!job) return
      e.retry = { job, at: now() }; schedule(wallet, e)
    },
    refresh(wallet?: string, confirmation?: ActivityConfirmation) {
      for (const [key, e] of wallet ? [[wallet, entry(wallet)] as const] : entries) {
        if (confirmation && Number.isSafeInteger(confirmation.block) && confirmation.block > 0) {
          const old = e.confirmations.get(confirmation.chainId)
          if (!old || confirmation.block > old.block || (confirmation.finalized && !old.finalized)) {
            e.confirmations.set(confirmation.chainId, { ...confirmation, block: Math.max(old?.block ?? 0, confirmation.block), finalized: confirmation.finalized || old?.finalized })
            e.fastReads = 6
          }
        }
        e.generation++; e.headAt = now(); schedule(key, e)
      }
    },
  }
}
