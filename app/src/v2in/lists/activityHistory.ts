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
type Read = (wallet: string, page: { limit: number; cursor?: string }) => Promise<ListsReply<ActivityResponse>>
type Job = { kind: 'head' | 'older' | 'bridge'; cursor?: string }
const PAGE = 20
const EMPTY: ActivityHistory = Object.freeze({ answer: null, error: null, loading: false, more: false, catchingUp: false })

/** The backend's chronological key, with a stable tie-breaker; never sort by transaction hash or status. */
export function compareActivity(a: ActivityItem, b: ActivityItem): number {
  const key = (item: ActivityItem) => ({ id: item.id, at: item.tx.snapshot.timestamp, chainId: item.chainId, block: item.tx.snapshot.number, logIndex: logIndexOf(item.id) })
  return compareChronology(key(a), key(b))
}

export function mergeTokens(older: readonly IndexedToken[], newer: readonly IndexedToken[]): IndexedToken[] {
  return [...new Map([...older, ...newer].map((token) => [`${token.chainId}:${token.address.toLowerCase()}`, token])).values()]
}

/** One public, wallet-keyed history shared by overview, full history and positions. No private records enter this store.
 * A refreshed head is bridged back to the loaded tail before its cursor is considered contiguous. Failed pages retain
 * their cursor and all token metadata. Navigation never restarts the tail; a wallet switch never borrows another key.
 */
export function createActivityHistory(read: Read, timers: ReaderTimers, refresh = true) {
  interface Entry {
    value: ActivityHistory; listeners: Set<() => void>; timer: unknown; waking: (() => void) | null
    tail: string | null; bridge: string | null; inFlight: boolean; failures: number; retry: Job | null
    dirty: boolean; bridgePages: number; restarted: boolean; restarting: boolean; cursors: Set<string>
  }
  const entries = new Map<string, Entry>()
  const entry = (wallet: string): Entry => {
    let e = entries.get(wallet)
    if (!e) {
      e = { value: EMPTY, listeners: new Set(), timer: null, waking: null, tail: null, bridge: null, inFlight: false, failures: 0, retry: null,
        dirty: false, bridgePages: 0, restarted: false, restarting: false, cursors: new Set() }
      entries.set(wallet, e)
    }
    return e
  }
  const publish = (e: Entry, patch: Partial<ActivityHistory>) => {
    e.value = { ...e.value, ...patch, more: e.tail !== null || e.bridge !== null, catchingUp: e.bridge !== null }
    for (const listener of e.listeners) listener()
  }
  const schedule = (wallet: string, e: Entry, job: Job, delay: number) => {
    if (e.timer !== null) timers.clear(e.timer)
    e.timer = timers.set(() => { e.timer = null; void run(wallet, e, job) }, delay)
  }
  const run = async (wallet: string, e: Entry, job: Job) => {
    if (e.inFlight || e.listeners.size === 0) return
    if (!timers.visible()) {
      if (!e.waking) e.waking = timers.onVisible(() => { e.waking = null; void run(wallet, e, job) })
      return
    }
    e.inFlight = true
    publish(e, { loading: true })
    let reply: ListsReply<ActivityResponse>
    try { reply = await read(wallet, { limit: PAGE, ...(job.cursor ? { cursor: job.cursor } : {}) }) }
    catch { reply = { kind: 'unavailable', reason: 'upstream_unavailable' } }
    e.inFlight = false
    if (reply.kind !== 'ok') {
      if (job.cursor && reply.kind === 'unavailable' && ['invalid_or_expired_cursor', 'catalogue_revision_changed'].includes(reply.reason) && !e.restarted) {
        e.restarted = true; e.restarting = true; e.cursors.clear(); e.tail = null; e.bridge = null
        publish(e, { error: reply, loading: false })
        schedule(wallet, e, { kind: 'head' }, 1_000)
        return
      }
      e.retry = job
      e.failures++
      publish(e, { error: reply, loading: false })
      if (e.listeners.size) schedule(wallet, e, job, readAgainAfter(reply, e.failures) ?? 60_000)
      return
    }
    if (e.dirty && job.kind === 'head') {
      e.dirty = false; e.retry = null
      publish(e, { loading: false })
      void run(wallet, e, { kind: 'head' })
      return
    }
    const previous = e.value.answer
    const known = new Map(previous?.items.map((item) => [item.id, item]) ?? [])
    const overlaps = reply.body.items.some((item) => known.has(item.id))
    // A head refresh may replace an unfinalized block. Only discard old rows in the fully reread window;
    // older pages and finalized records remain available while their chain is catching up.
    if (job.kind === 'head') {
      const last = reply.body.items.at(-1)
      const completeEmpty = !last && reply.body.nextCursor === null && reply.body.coverage === 'complete'
      for (const [id, item] of known) {
        const chain = reply.body.chains.find((value) => value.chainId === item.chainId)
        const reread = chain?.status === 'current' && chain.indexedThrough !== null && chain.indexedThrough.number >= item.tx.snapshot.number
        if (reread && item.tx.finality !== 'finalized' && (completeEmpty || (last && compareActivity(item, last) <= 0))) known.delete(id)
      }
    }
    for (const item of reply.body.items) known.set(item.id, item)
    if (job.kind === 'head') { e.cursors.clear(); e.bridgePages = 0 }
    if (job.cursor) e.cursors.add(job.cursor)
    const stalled = reply.body.nextCursor !== null && e.cursors.has(reply.body.nextCursor)
    if (!previous || e.restarting) { e.tail = reply.body.nextCursor; e.restarting = false }
    else if (job.kind === 'head') e.bridge = overlaps ? null : reply.body.nextCursor
    else if (job.kind === 'older') e.tail = reply.body.nextCursor
    else e.bridge = overlaps ? null : reply.body.nextCursor
    if ((job.kind === 'head' || job.kind === 'bridge') && reply.body.nextCursor === null) e.tail = null
    if (stalled) { e.tail = null; e.bridge = null }
    if (job.kind === 'bridge') e.bridgePages++
    if (job.cursor && !stalled) e.restarted = false
    e.failures = 0
    e.retry = null
    const answer = { ...(job.kind === 'head' || !previous ? reply.body : previous), items: [...known.values()].sort(compareActivity),
      tokens: mergeTokens(previous?.tokens ?? [], reply.body.tokens), nextCursor: e.bridge ?? e.tail }
    publish(e, { answer, error: stalled ? { kind: 'unavailable', reason: 'pagination_stalled' } : null, loading: false })
    if (e.listeners.size) {
      if (!e.bridge && e.dirty) { e.dirty = false; void run(wallet, e, { kind: 'head' }) }
      else if (e.bridge && e.bridgePages < 3) schedule(wallet, e, { kind: 'bridge', cursor: e.bridge }, 1_000)
      else if (!e.bridge && refresh) schedule(wallet, e, { kind: 'head' }, 60_000)
    }
  }
  return {
    get: (wallet: string): ActivityHistory => entries.get(wallet)?.value ?? EMPTY,
    subscribe(wallet: string, listener: () => void) {
      const e = entry(wallet)
      e.listeners.add(listener)
      if (!e.inFlight && e.timer === null && e.waking === null) {
        if (!e.value.answer) void run(wallet, e, e.retry ?? { kind: 'head' })
        else if (e.retry) schedule(wallet, e, e.retry, readAgainAfter(e.value.error!, e.failures) ?? 60_000)
        else if (e.bridge && e.bridgePages < 3) schedule(wallet, e, { kind: 'bridge', cursor: e.bridge }, 1_000)
        else if (!e.bridge && refresh) schedule(wallet, e, { kind: 'head' }, 60_000)
      }
      return () => {
        e.listeners.delete(listener)
        if (e.listeners.size) return
        if (e.timer !== null) timers.clear(e.timer)
        e.timer = null
        e.waking?.(); e.waking = null
      }
    },
    more(wallet: string) {
      const e = entry(wallet)
      // Retry-After applies to manual requests too. The scheduled retry owns a failed cursor.
      if (e.inFlight || e.retry) return
      const cursor = e.bridge ?? e.tail
      if (!cursor) return
      if (e.timer !== null) timers.clear(e.timer)
      e.timer = null
      void run(wallet, e, { kind: e.bridge ? 'bridge' : 'older', cursor })
    },
    refresh(wallet?: string) {
      for (const [key, e] of wallet ? [[wallet, entry(wallet)] as const] : entries) {
        if (e.inFlight || e.retry) { e.dirty = true; continue }
        if (e.timer !== null) timers.clear(e.timer)
        e.timer = null
        void run(key, e, e.bridge ? { kind: 'bridge', cursor: e.bridge } : { kind: 'head' })
      }
    },
  }
}
