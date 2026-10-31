import type { S1PlanResult } from '../../../v2/plan/types'

/**
 * Added 2026-10-30 (QA round 2, INST-2, the owner's "New position faster"): the plans New position asked for, kept for
 * the same choices, so opening Review again (Back then Continue, a choice changed and changed back, Review again) does
 * not wait for the plan service again (its p50 is 3.8 s). Pure: no wallet, no React; the clock is handed in.
 *
 *   - A plan is kept by its key (../run.ts: the chain, the wallet and the request exactly as sent, its consent path
 *     included) and handed out again only while at least PLAN_REUSE_MIN_LEFT_S remain before its quote expires, and only
 *     when the caller allows it (`reuse`: never for a quote asked again because the price moved or the quote ran out).
 *     Only a plan that came back usable is kept; any other answer is forgotten at once.
 *   - A plan still being asked for the same key is joined, never asked twice. Each caller brings its own abort: one that
 *     gives up leaves the shared request to the others, and the request itself is stopped only when nobody waits for it.
 *   - The caller forgets a key whose plan failed its review or was used (Create position pressed), so a plan whose
 *     signature or nonce may be spent is never handed out again.
 * The money client still reviews every plan it is given afresh, at one block (finance/v2/zap.ts review): this keeps the
 * plan service's answer only, never a review, a step or anything the wallet said.
 */

/**
 * A kept plan is handed out again only with at least this long before its quote expires (seconds; a plan's quote lives
 * 180 s, position-plan-v1 quoteLifetimeSeconds). Two minutes, not one (2026-10-30, the review of INST-2): an idle Review
 * asks a fresh quote once 30 s are left (../JourneyCreateV2.tsx), and an approval then the position must both land before
 * the quote expires (finance/v2/zap.ts plan_quote_expired), so a kept plan still leaves Review about as long as a fresh
 * one did for both. Back then Continue within the plan's first minute is the case it serves.
 */
export const PLAN_REUSE_MIN_LEFT_S = 120
/** How many keys are kept at most (the oldest go first). */
export const PLAN_CACHE_MAX = 8

export interface PlanAsk {
  /** The plan service's answer (or the reason there is none: an `aborted` one when this caller gave up). */
  result: S1PlanResult
  /** True when it is a plan kept from an earlier ask (not asked now, nor joined). */
  kept: boolean
}

export interface PlanCache {
  /**
   * The plan for `key`: a kept one when `reuse` allows it and it has time left, else the ask already out for this key,
   * else a new ask (`ask`, with the abort of the shared request). `signal` is this caller's: aborted, it answers
   * `{ kind: 'unavailable', reason: 'aborted' }` at once, and the shared request stops if nobody else waits for it.
   */
  plan(key: string, ask: (signal: AbortSignal) => Promise<S1PlanResult>, options: { signal: AbortSignal; reuse: boolean }): Promise<PlanAsk>
  /** Never hands out the plan of `key` again (its review failed, or Create position was pressed on it). */
  forget(key: string): void
}

interface Entry {
  result: Promise<S1PlanResult>
  settled: S1PlanResult | null
  controller: AbortController
  waiting: number
}

const ABORTED: S1PlanResult = Object.freeze({ kind: 'unavailable', reason: 'aborted' }) as S1PlanResult

/** When a usable plan stops being handed out: its quote's expiry, the earlier of the reply's two words for it. */
function expiryOf(result: S1PlanResult): number | null {
  if (result.kind !== 'ok') return null
  return Math.min(result.reply.facts.expiresAt, result.reply.quote.expiresAt)
}

export function createPlanCache(now: () => number = () => Date.now() / 1000, max = PLAN_CACHE_MAX): PlanCache {
  const entries = new Map<string, Entry>()

  function drop(key: string, entry: Entry): void {
    if (entries.get(key) === entry) entries.delete(key)
  }

  function join(key: string, entry: Entry, signal: AbortSignal): Promise<PlanAsk> {
    entry.waiting++
    return new Promise<PlanAsk>((resolve, reject) => {
      let done = false
      const leave = (): boolean => {
        if (done) return false
        done = true
        signal.removeEventListener('abort', onAbort)
        entry.waiting--
        return true
      }
      function onAbort(): void {
        if (!leave()) return
        // Nobody waits for it any more: the request itself stops, and nothing of it is kept.
        if (entry.waiting === 0 && entry.settled === null) {
          drop(key, entry)
          entry.controller.abort()
        }
        resolve({ result: ABORTED, kept: false })
      }
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      entry.result.then(
        (result) => {
          if (leave()) resolve({ result, kept: false })
        },
        (error: unknown) => {
          if (leave()) reject(error)
        },
      )
    })
  }

  return {
    plan(key, ask, { signal, reuse }) {
      const known = entries.get(key)
      if (known && known.settled === null) return join(key, known, signal)
      if (known) {
        const expiry = expiryOf(known.settled as S1PlanResult)
        if (reuse && expiry !== null && expiry - now() >= PLAN_REUSE_MIN_LEFT_S) {
          // Most recently used last, so the oldest key is the one trimmed.
          entries.delete(key)
          entries.set(key, known)
          return Promise.resolve(signal.aborted ? { result: ABORTED, kept: false } : { result: known.settled as S1PlanResult, kept: true })
        }
        entries.delete(key)
      }
      if (signal.aborted) return Promise.resolve({ result: ABORTED, kept: false })
      const controller = new AbortController()
      const entry: Entry = { result: Promise.resolve(ABORTED), settled: null, controller, waiting: 0 }
      entries.set(key, entry)
      while (entries.size > max) {
        const oldest = entries.keys().next().value as string
        entries.delete(oldest)
      }
      entry.result = (async () => {
        try {
          const result = await ask(controller.signal)
          // Kept only when it came back usable and nobody stopped it; any other answer is never handed out again.
          if (result.kind === 'ok' && !controller.signal.aborted && entries.get(key) === entry) entry.settled = result
          else drop(key, entry)
          return result
        } catch (error) {
          drop(key, entry)
          throw error
        }
      })()
      return join(key, entry, signal)
    },
    forget(key) {
      const entry = entries.get(key)
      // A request still out keeps running for whoever waits for it; only its answer is no longer kept.
      if (entry) entries.delete(key)
    },
  }
}
