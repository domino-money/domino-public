/**
 * One rule for every read screen: which failed reads can clear by themselves,
 * and how long a screen waits before it asks the same question again.
 *
 * Two helpers use it and keep their own mechanics. The pool screens await
 * `askAgainLater` (screenRead.ts), a sleep on the injectable clock with an
 * abort signal. The wallet, token and position screens take a delay from
 * `reaskDelayMs` (quietRead.ts) and hand it to a timer. Either way the same
 * failure is asked again on every screen, or on none.
 *
 * Asked again: a busy read service (once R-1's own retries gave up), the
 * site's access check being briefly out, a producer answer marked transient
 * (errors.ts), a dropped connection, an edge error page with a server status
 * (5xx, 408 or 429), a read stopped at a deadline or by the screen's own
 * budget, a full queue on this page, a catalogue that changed under a read,
 * whose first question can pass when asked later, and a hop that refused the
 * reply (502 upstream_contract_mismatch). A gateway that does not stamp its
 * own mid-hop failures (85e7511, still on the dev and production lanes) sends
 * that for a hop that is only flapping, for a read and for the capabilities
 * GET a read waits for alike. Everything else comes back the same next time
 * and is final: access, a contract header this page does not accept (missing,
 * or another version), identity, a refusal, a switched-off route, and a page
 * handle that expired (its pager restarts it once by itself; after that it is
 * the person's call).
 *
 * The wait is max(Retry-After, 4) s, doubled for each re-ask already spent,
 * moved by about ±25% so that screens which failed together do not come back
 * together (so the first comes after 3 to 5 s), and never under the
 * Retry-After a busy service asked for. At most 4 times per question. Nothing
 * here reads, sleeps or looks at the page.
 */

/** Quiet re-asks per question, after its first answer. */
export const QUIET_ATTEMPTS = 4
/** The shortest wait before a quiet re-ask, in seconds, before jitter. */
export const QUIET_WAIT_S = 4
/** How far a wait may move either way from its doubled value: about ±25%. */
export const QUIET_JITTER = 0.25

/** Whatever a screen holds for a failed read: a read outcome, a screen outcome, or a pager's failure. */
export interface TransientCandidate {
  readonly state: string
  readonly retryAfterSeconds?: number
  readonly retryable?: boolean
  readonly code?: string
  readonly reason?: string
  readonly cause?: { readonly kind: string; readonly status?: number }
}

/** An edge error page that a server may stop sending: its own failure or overload, a timeout, a rate limit. */
const passingEdgeStatus = (status: number | undefined) => status !== undefined && (status >= 500 || status === 408 || status === 429)

/**
 * Seconds a failure itself asks to wait before the same read may help (0
 * when it names no wait), or null when asking again cannot change it.
 */
export function transientWaitSeconds(outcome: TransientCandidate): number | null {
  switch (outcome.state) {
    case 'busy':
      return outcome.retryAfterSeconds !== undefined && outcome.retryAfterSeconds > 0 ? outcome.retryAfterSeconds : 0
    case 'gate_unavailable':
    case 'local':
      return 0
    case 'restart_required':
      return outcome.code === 'catalogue_revision_changed' ? 0 : null
    case 'incompatible':
      // A hop's refusal names no wait of its own. A contract header this page does not accept meets every read the same.
      return outcome.reason === 'upstream_contract_mismatch' ? 0 : null
    case 'unavailable':
      switch (outcome.cause?.kind) {
        case 'producer':
          return outcome.retryable === true ? 0 : null
        case 'edge':
          return passingEdgeStatus(outcome.cause.status) ? 0 : null
        case 'network':
        case 'queue_full':
        case 'read_deadline':
          return 0
        default:
          return null
      }
    default:
      return null
  }
}

/** Whether a failure can clear by itself. */
export const isTransient = (outcome: TransientCandidate) => transientWaitSeconds(outcome) !== null

/** Whether a screen still asks again after quiet re-ask number `attempt` (0 for the first) of this failure. */
export const asksAgain = (outcome: TransientCandidate, attempt: number) =>
  Math.trunc(attempt) === attempt && attempt >= 0 && attempt < QUIET_ATTEMPTS && isTransient(outcome)

/**
 * The wait before quiet re-ask number `attempt`, in ms, or null when the
 * failure is final or the question's re-asks are spent: max(Retry-After, 4) s
 * doubled `attempt` times, moved by up to ±25%, never before the service's
 * own Retry-After. `random` returns a number in [0, 1], as Math.random does;
 * tests pass a fixed one.
 */
export function quietDelayMs(outcome: TransientCandidate, attempt: number, random: () => number = Math.random): number | null {
  if (!asksAgain(outcome, attempt)) return null
  const wait = transientWaitSeconds(outcome) ?? 0
  const centre = Math.max(wait, QUIET_WAIT_S) * 1000 * 2 ** attempt
  const lower = Math.max(centre * (1 - QUIET_JITTER), wait * 1000)
  const upper = centre * (1 + QUIET_JITTER)
  const draw = random()
  // Anything but a number in [0, 1] is no draw at all: the middle of the range.
  const unit = draw >= 0 && draw <= 1 ? draw : 0.5
  return Math.round(lower + unit * (upper - lower))
}
