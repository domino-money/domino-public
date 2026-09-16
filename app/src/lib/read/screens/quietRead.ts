/**
 * How the wallet, token and position screens handle a read that failed,
 * now that they show no status panel and offer no Retry.
 *
 * A failure that can pass by itself is asked again on its own, quietly, the
 * way the pool screens do: after a wait that doubles each time (from about
 * 4 s, never under the service's Retry-After, with about ±25% jitter), a few
 * times per question, and only while the page is visible. Everything else is
 * final at once: nothing asked again could change it, so the screen shows a
 * dash or an empty state and keeps the reason in a title and a data
 * attribute. Which failures pass and how long to wait is transient.ts, shared
 * with the pool screens; this keeps the timer-shaped half. Nothing here
 * reads; it only says when to.
 */
import type { ReadRoute } from '../types'
import { COPY, failureText, type Subject } from './copy'
import type { ScreenOutcome } from './screenRead'
import { isTransient, quietDelayMs } from './transient'

export { QUIET_ATTEMPTS, QUIET_WAIT_S } from './transient'

/** Any outcome but an answer. A cancelled read is among them only so a stored failure type fits; it is never asked again. */
export type QuietFailure = Exclude<ScreenOutcome<ReadRoute>, { state: 'ok' }> | { state: 'incomplete_reply' }

/** Whether a failure can clear by itself, by the one rule every read screen follows (transient.ts). */
export function passing(failure: QuietFailure): boolean {
  return isTransient(failure)
}

/** One closed code for a failure, for a data attribute: the contract's or this app's own, never free text. */
export function failureCode(failure: QuietFailure): string {
  switch (failure.state) {
    case 'unavailable':
      return failure.cause.kind === 'producer' ? failure.cause.code : failure.cause.kind
    case 'disabled':
    case 'not_connected':
    case 'invalid':
    case 'incompatible':
      return failure.reason
    case 'request_rejected':
    case 'restart_required':
    case 'local':
      return failure.code
    default:
      return failure.state
  }
}

/** The site's own access check, named as site access in a title: nothing a person can see calls the site a beta. */
const SITE_ACCESS_EXPIRED = 'Site access expired. Reload the page to sign in again.'
const SITE_ACCESS_PAUSED = 'Site access is paused. Nothing is wrong on your side.'

/**
 * The words a title carries for a failure a screen no longer prints: the
 * read screens' own words for it, in one line. A site whose reads are not
 * wired up is named plainly, as reads that are off, never as something to
 * come, and the access check as site access.
 */
export function quietTitle(failure: QuietFailure, subject: Subject): string {
  switch (failure.state) {
    case 'not_connected':
      return COPY.local.serverOff
    case 'gate_required':
      return SITE_ACCESS_EXPIRED
    case 'gate_unavailable':
      return SITE_ACCESS_PAUSED
    default: {
      const { title, detail } = failureText(failure, subject)
      if (!detail || detail.startsWith(title)) return detail || title
      return `${title}. ${detail}`
    }
  }
}

/**
 * The wait before quiet re-ask number `attempt` (0 for the first), jittered,
 * or null when the failure is final or this question's re-asks are spent.
 * `random` is for tests; the screens leave it to Math.random.
 */
export function reaskDelayMs(failure: QuietFailure, attempt: number, random?: () => number): number | null {
  return quietDelayMs(failure, attempt, random)
}

/**
 * Calls `run` once `ms` have passed and the page is visible: a hidden page
 * waits until it is shown again, so nothing is asked for nobody. The function
 * it returns cancels whatever is still pending.
 */
export function whenVisibleAfter(ms: number, run: () => void): () => void {
  let cancelled = false
  const whenVisible = () => {
    if (document.hidden) return
    document.removeEventListener('visibilitychange', whenVisible)
    if (!cancelled) run()
  }
  const timer = setTimeout(() => {
    if (cancelled) return
    if (document.hidden) document.addEventListener('visibilitychange', whenVisible)
    else run()
  }, ms)
  return () => {
    cancelled = true
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', whenVisible)
  }
}
