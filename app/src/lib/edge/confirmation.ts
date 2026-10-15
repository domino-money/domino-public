/**
 * Public confirmation through the existing same-origin gate and Rugged node. No wallet methods or RPC URL.
 *
 * Changed on purpose 2026-10-14 (incident C4, the 429 on this route of 2026-10-13): every question is the route's second
 * shape (chainRoutes.ts ConfirmationQuestion). It names its chain, Robinhood Chain, the one chain the site's node reads,
 * and draws from a visitor class of its own at the edge, so tabs opened before the deploy cannot starve it. A resting
 * node arrives as the state "busy" of a 200 answer, not as a 429: this adapter waits exactly as it does after a refusal
 * (that lane rests for the wait named), and the browser's console stays clean. Nothing is kept here: the edge keeps what
 * is final, for everyone.
 *
 * Changed on purpose 2026-10-14 (C4 review, version skew): an edge from before the second shape (a rollback, or the
 * seconds a deploy takes to reach every data centre) refuses it with a 400, which read as a failed read with no wait.
 * The question is then asked once more in the first shape, and the tab keeps to it: one request more, once, and nothing
 * more of the node (that edge refuses the second shape before it asks the node anything). Its answers ({v: 1, …}) are
 * read as the second shape's and checked the same; today's edge still answers the first shape, from the class `state`.
 *
 * Changed on purpose 2026-10-14 (incident C3: waiting never locks). The "not before" time was one per lane: a refusal met
 * by the background queue for any old receipt made the next read of a just-sent transaction fail in the browser without
 * a request, and the screen waiting for it locked. Now:
 *   - the wait is per question: one hash's refusal or failure rests that hash only (its Retry-After, or a backoff of
 *     1, 2, 4 … 60 s when none is named), and the finalized block keeps its own (the background's, below, is one);
 *   - a money client's own read (`read(hash, { foreground: true })`) is the foreground lane: a background read (the
 *     confirmation queue's, `read(hash)`) cannot rest it, and the cap on reads in flight is the background's alone;
 *   - after two missed reads in a row (a failure, or a rest still running), the money client's `second` source is asked
 *     in the same read: the person's own wallet, read-only (finance/v2/transact.ts; the owner's decision D2). The answer
 *     is the same three fields, checked by the money client exactly as the edge's. Its failure (no wallet, another
 *     chain, a wallet busy) is the read's failure: the caller asks again.
 *
 * Changed on purpose 2026-10-14 (C3 review: never more requests of the site's node than before). The background's rest
 * is the whole lane's again, as before C3: a refusal or failure met by one queue read rests every queue read, so the up
 * to four reads a pass makes cannot each meet the same outage. A foreground failure rests its own hash and the
 * background too (it never rests another foreground read). The foreground lane is the caller's word (`foreground`),
 * not the presence of a second source, so the owner's D2 switch turns off the wallet and nothing else. A read of a hash
 * already in flight in the other lane joins it, as it did when both lanes were one.
 */
import { ROBINHOOD_ID } from '../../config/chainIdentity'
import { MAX_RETRY_MS, RATE_RETRY_MS, jittered, postRoute, type ConfirmationQuestion } from './chainRoutes'
export interface ConfirmationAnswer3 { transaction: unknown; receipt: unknown; block: unknown }
export interface ConfirmationAsk {
  /** A money client's own read of a transaction this page sent: the lane a background refusal cannot rest (C3). */
  foreground?: boolean
  /** That client's second source, asked after two missed reads of this hash (the owner's decision D2). */
  second?: () => Promise<ConfirmationAnswer3>
}
export interface ConfirmationRead {
  read(hash: string, ask?: ConfirmationAsk): Promise<ConfirmationAnswer3>
  finalized(): Promise<unknown>
}
/** The chain whose receipts the site's edge reads: the registry's own id, as the edge's is (functions/_lib/confirmation.ts CONFIRMATION_CHAINS). */
const EDGE_CHAIN_ID = ROBINHOOD_ID
/** A failure that names no wait rests its question 1 s, then 2, 4 … up to a minute (C3: an error slows a reader, never speeds it up). */
const BACKOFF_MS = 1_000
const BACKOFF_MAX_MS = 60_000
/** Missed reads in a row before the second source is asked. */
const SECOND_AFTER = 2
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** The first shape's answer ({v: 1, …}, from an edge before the second shape) read as the second's, for the same checks. */
function asSecond(value: Record<string, unknown>): Record<string, unknown> {
  if (value.v !== 1) throw new Error('invalid_confirmation')
  if ('finalized' in value) return { v: 2, finalized: value.finalized }
  if (!('transaction' in value) || !('receipt' in value) || !('block' in value)) throw new Error('invalid_confirmation')
  return { v: 2, state: object(value.receipt) && object(value.block) ? 'included' : 'pending', transaction: value.transaction, receipt: value.receipt, block: value.block }
}
export function createConfirmationReads(): ConfirmationRead {
  const pending = new Map<string, Promise<Record<string, unknown>>>()
  let final: { at: number; value: unknown } | null = null
  /**
   * Per rest (`fg:<hash>`, the background's one `bg`, or `finality`): when it may be asked again and its failures in a
   * row. Per question (`fg:<hash>`, `bg:<hash>`): its missed reads in a row.
   */
  const deferUntil = new Map<string, number>()
  const strikes = new Map<string, number>()
  const misses = new Map<string, number>()
  /** Where a question rests: the background's reads rest together (C3 review), a foreground read on its own hash. */
  const restOf = (key: string) => (key.startsWith('bg:') ? 'bg' : key)
  /** The same hash's question in the other lane (`finality` has none). */
  const twinOf = (key: string) => (key.startsWith('fg:') ? `bg:${key.slice(3)}` : key.startsWith('bg:') ? `fg:${key.slice(3)}` : null)
  /** The shape this tab asks in: the second, until an edge refuses it as a question it does not know (the version skew above). */
  let shape: 1 | 2 = 2
  const unavailable = (retryAfterMs: number) => Object.assign(new Error('confirmation_unavailable'), { retryAfterMs })
  /** Bounded: the oldest question goes first (a few hundred hashes is far more than one tab ever waits on). */
  const keep = <T,>(map: Map<string, T>, key: string, value: T) => {
    map.delete(key)
    map.set(key, value)
    while (map.size > 256) map.delete(map.keys().next().value as string)
  }
  /**
   * A failed question rests for the wait named, and never less than its backoff; the wait it rests is the error's. A
   * foreground failure rests the background for as long (C3 review): what the node refused one read, the queue does not
   * ask meanwhile.
   */
  const strike = (key: string, named = 0): number => {
    const rest = restOf(key)
    const count = (strikes.get(rest) ?? 0) + 1
    keep(strikes, rest, count)
    const ms = Math.max(named, Math.min(BACKOFF_MAX_MS, BACKOFF_MS * 2 ** (count - 1)))
    const until = Date.now() + ms
    keep(deferUntil, rest, Math.max(deferUntil.get(rest) ?? 0, until))
    if (key.startsWith('fg:')) keep(deferUntil, 'bg', Math.max(deferUntil.get('bg') ?? 0, until))
    return ms
  }
  const read = (key: string, asked: { hash: string } | { finality: true }, timeout: number, check: (value: Record<string, unknown>) => void) => {
    const twin = twinOf(key)
    const existing = pending.get(key) ?? (twin !== null ? pending.get(twin) : undefined)
    if (existing) return existing
    const now = Date.now()
    const deferred = deferUntil.get(restOf(key)) ?? 0
    if (now < deferred) return Promise.reject(unavailable(deferred - now))
    // The cap on reads in flight is the background lane's: a money client's own read is never refused by it.
    if (key.startsWith('bg:') && [...pending.keys()].filter(other => other.startsWith('bg:')).length >= 32) return Promise.reject(new Error('confirmation_busy'))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    /** A refusal, the edge's "busy", or a failure that names no wait: this question asks nothing for the wait it rests. */
    const rest = (ms: number) => unavailable(strike(key, ms))
    /** The question in this tab's shape; a second shape refused as unknown is asked once more in the first, within the same time-out. */
    const ask = async () => {
      if (shape === 2) {
        const body: ConfirmationQuestion = { v: 2, chainId: EDGE_CHAIN_ID, ...asked }
        const answer = await postRoute('confirmation', body, { signal: controller.signal })
        if (answer.ok || answer.failure !== 'bad_request') return { answer, first: false }
        shape = 1
      }
      return { answer: await postRoute('confirmation', asked, { signal: controller.signal }), first: true }
    }
    const work = ask().then(({ answer, first }) => {
      if (!answer.ok) throw rest(answer.retryAfterMs)
      try {
        const value = first && object(answer.value) ? asSecond(answer.value) : answer.value
        if (!object(value) || value.v !== 2) throw new Error('invalid_confirmation')
        // (2026-10-15, pack 8, Q3): the edge's "busy" wait plus 0 to 25% at random, as a refusal's (./chainRoutes.ts retryAfter).
        if (value.state === 'busy') throw rest(jittered(typeof value.retryAfterMs === 'number' && Number.isFinite(value.retryAfterMs) && value.retryAfterMs >= 0 ? Math.min(MAX_RETRY_MS, value.retryAfterMs) : RATE_RETRY_MS))
        if (value.state === 'not_served') throw new Error('confirmation_not_served')
        check(value)
        strikes.delete(restOf(key))
        return value
      } catch (error) {
        // An answer that cannot be used is a failure too: it rests its question (its own words are kept).
        if (!(error instanceof Error) || error.message !== 'confirmation_unavailable') strike(key)
        throw error
      }
    }).finally(() => { clearTimeout(timer); pending.delete(key) })
    pending.set(key, work)
    return work
  }
  return {
    async read(hash, { foreground = false, second }: ConfirmationAsk = {}) {
      if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error('invalid_confirmation_hash')
      const key = `${foreground ? 'fg' : 'bg'}:${hash}`
      let answer: Record<string, unknown>
      try {
        answer = await read(key, { hash }, 10_000, value => {
          if ((value.state !== 'pending' && value.state !== 'included') || !('transaction' in value) || !('receipt' in value) || !('block' in value)) throw new Error('invalid_confirmation')
        })
      } catch (error) {
        // Two missed reads in a row (a failure, or a rest still running): the money client's own second source, now.
        const missed = (misses.get(key) ?? 0) + 1
        keep(misses, key, missed)
        if (second && missed >= SECOND_AFTER) return second()
        throw error
      }
      misses.delete(key)
      return { transaction: answer.transaction, receipt: answer.receipt, block: answer.block }
    },
    async finalized() {
      if (final && Date.now() - final.at < 2000) return final.value
      const answer = await read('finality', { finality: true }, 2000, value => {
        if ('state' in value || !('finalized' in value)) throw new Error('invalid_confirmation')
      })
      final = { at: Date.now(), value: answer.finalized }
      return final.value
    },
  }
}
export const confirmationReads = createConfirmationReads()
