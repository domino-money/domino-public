import { OutgoingContractError, type ApiOutcome, type SessionApi } from './api'
import {
  heldAway,
  initialMachine,
  reduce,
  sessionChains,
  type Call,
  type Effect,
  type Env,
  type Event,
  type Machine,
  type PrivateIdentity,
  type View,
  type WalletIdentity,
} from './machine'

/**
 * Runs the session machine: performs its effects through injected ports and
 * feeds the results back in. Holds no rules of its own; those are in
 * machine.ts.
 *
 * The snapshot it publishes to React holds the view, the public wallet
 * identity and the epoch. Credentials, challenges and signatures never leave
 * the machine and the flow that uses them.
 *
 * It also owns time: when the session is checked with me, and when it is
 * renewed with POST refresh. A refresh is asked for whenever a tab shows a
 * signed-in session: 20 minutes after the last renewal, whether the tab is
 * visible or in use, and at once when the tab comes back into view or takes
 * focus with a renewal older than 10 minutes. Tabs share each renewal
 * (broadcastRenewal / renewedElsewhere): the tab that made the last renewal
 * makes the next, a tab that only heard of it waits a little longer, and a
 * hidden tab longer still, plus a stagger of its own, so one tab renews and
 * the others hear of it instead of all refreshing.
 *
 * That timing (with at most three retries, and one read-only me after a CSRF
 * refusal) is this client's policy. The producer accepted it as policy on
 * #14; session-v1 does not guarantee any of it on the wire.
 *
 * Changed on purpose (owner, 2026-09-25): the refresh used to wait for a
 * visible tab with user activity since the last renewal, so a tab left in the
 * background, or a page read without touching it, lost its session after 30
 * minutes and the owner had to sign in again "all the time". The session now
 * lives as long as the site is open in any tab. It still ends on the
 * producer's rules alone: 30 minutes after its last renewal once no tab of
 * the site is open (or the browser holds them all back), and at the 12-hour
 * absolute limit.
 */

export type SignOutcome = { ok: true; signature: string } | { ok: false; reason: 'user_rejected' | 'provider_error' }

export interface ControllerPorts {
  api: SessionApi
  sign(request: { address: string; message: string }): Promise<SignOutcome>
  clearPrivate(): void
  storePrivate(scope: PrivateScope, identity: PrivateIdentity): void
  broadcast(): void
  /** Tells other tabs this session's idle deadline was just renewed. Carries nothing else. */
  broadcastRenewal(): void
  /** Whether the page is visible. A hidden tab refreshes too, later than a visible one (HIDDEN_DEFER_MS). */
  isVisible(): boolean
  /**
   * This tab's own extra wait, in milliseconds, before it refreshes while hidden: tabs in the background spread out,
   * so the first renews and the others hear of it. At most HIDDEN_STAGGER_MS; none unless given.
   */
  hiddenStaggerMs?: number
  now(): number
  /**
   * Returns a function that cancels the timer. `purpose` says what it is for, a session check or a refresh; it changes
   * nothing, and lets a test tell the two apart now that a signed-in tab always has a refresh planned (2026-09-25).
   */
  setTimer(callback: () => void, ms: number, purpose?: 'check' | 'refresh'): () => void
  origin: string
  checksum(address: string): string
}

export interface Snapshot {
  view: View
  identity: WalletIdentity
  epoch: number
  busy: boolean
  /**
   * Added 2026-10-05: the signed-in session is held while the account's wallet is on Base or Arbitrum One (machine.ts
   * heldAway), where the view says wrong_network; Domino V2's private routes may use it there. Changed on purpose
   * 2026-10-06 (the owner's point 2a): and while it is on a network a deposit may come from (CROSSCHAIN_ORIGIN_CHAIN_IDS).
   */
  away: boolean
}

/**
 * Where private data for the signed-in identity lives. The epoch is part of
 * it, so data written for one session can never be read under another, even
 * for the same address. So is the connector instance: two providers that
 * announce the same rdns never share a scope.
 */
export interface PrivateScope {
  connectorUid: string
  address: string
  chainId: number
  epoch: number
}

export function privateScope(snapshot: Pick<Snapshot, 'view' | 'identity' | 'epoch'>): PrivateScope | null {
  const { view, identity, epoch } = snapshot
  if (view.status !== 'signed_in' || identity.kind !== 'connected') return null
  return { connectorUid: identity.connectorUid, address: identity.address, chainId: identity.chainId, epoch }
}

/** setTimeout's ceiling; a longer delay fires immediately. */
const MAX_TIMER_MS = 2_147_483_647

/**
 * The producer ends a session 30 minutes after it was last renewed
 * (docs/WALLET_SESSIONS.md). backend/session_store.py renews `last_used_at`
 * in POST refresh (finish_private) and in an authenticated preview
 * (finish_preview); GET me never renews it and does not report it. After a
 * verify or a refresh this controller knows the deadline: one idle period
 * from then. A renewal it did not see, such as a preview, only moves the real
 * deadline later, so the one kept here is never late; passing it costs one
 * me, which finds the session still there.
 */
export const SESSION_IDLE_MS = 30 * 60_000

/**
 * How old a renewal may get before a tab renews it: ten minutes before the
 * idle deadline, which leaves room for the retries below.
 */
export const REFRESH_AFTER_MS = 20 * 60_000

/**
 * A tab that comes back into view, or takes focus, renews at once a renewal
 * older than this, instead of waiting for REFRESH_AFTER_MS: a browser may have
 * held back a background tab's timers.
 */
export const RETURN_REFRESH_MS = 10 * 60_000

/**
 * How much later a tab that only heard of the last renewal refreshes than the
 * tab that made it: that tab keeps renewing, and the others hear of it before
 * their own turn. Should it close, the next tab renews half a minute later.
 */
export const FOLLOW_DEFER_MS = 30_000

/**
 * How much later than a visible tab a hidden one refreshes, so that a visible
 * tab renews first and the hidden ones hear of it. With FOLLOW_DEFER_MS,
 * HIDDEN_STAGGER_MS and the retries below, a hidden tab's last try stays well
 * before the idle deadline (20 + 0.5 + 1 + 1 + 3.5 minutes).
 */
export const HIDDEN_DEFER_MS = 60_000

/** The most a tab's own stagger (ControllerPorts.hiddenStaggerMs) adds for a hidden tab. */
export const HIDDEN_STAGGER_MS = 60_000

/**
 * Waits before retrying a refresh the service could not serve (503, 504, 429,
 * a lost connection). Never more retries than this for one renewal; a
 * Retry-After from the service is honoured when it is longer.
 */
export const REFRESH_RETRY_MS: readonly number[] = [30_000, 60_000, 120_000]

/**
 * While signed in, me is read at least this often. After a reload (or a
 * session another tab created) the idle deadline is unknown, so this bounds
 * how long a session the server has ended can still be shown as signed in.
 */
export const SESSION_CHECK_MS = 5 * 60_000

/**
 * What `withSessionCsrf` returns instead of running its callback: the session
 * it was asked for is not the one this tab holds any more (another epoch,
 * signed out, or never signed in).
 */
export const NO_SESSION: unique symbol = Symbol('no session')

export interface SessionController {
  dispatch(event: Event): void
  /**
   * The tab came back into view or took focus: a renewal older than RETURN_REFRESH_MS is renewed at once, and a
   * refresh that waited for the tab to be visible runs.
   */
  wake(): void
  /** Another tab renewed the session; this tab's idle deadline moves with it. */
  renewedElsewhere(): void
  subscribe(listener: () => void): () => void
  getSnapshot(): Snapshot
  /**
   * Runs `fn` with the session CSRF, only while the session of `epoch` is the
   * signed-in one. For private requests other features make (#38 previews):
   * the CSRF is handed to the callback as an argument and is never returned,
   * stored or published. Anything else resolves to NO_SESSION without calling
   * `fn`. It never starts a request, a check or a signature of its own.
   */
  withSessionCsrf<T>(epoch: number, fn: (csrf: string) => Promise<T>): Promise<T | typeof NO_SESSION>
}

export function createSessionController(ports: ControllerPorts): SessionController {
  const env: Env = { origin: ports.origin, checksum: ports.checksum, chains: sessionChains(ports.origin) }
  let machine: Machine = initialMachine
  let snapshot = snapshotOf(machine)
  const listeners = new Set<() => void>()
  const inflight = new Set<AbortController>()
  let cancelExpiry: (() => void) | null = null
  // Local-clock time by which the current session idles out, when known.
  let idleDeadline: number | null = null
  // Server clock minus local clock, from the last response's Date header.
  let skew = 0
  let lastExpiresAt: string | null = null
  let checkFailures = 0
  let checkRetryAt = 0

  // Refresh bookkeeping, reset for every new epoch (a new session or identity).
  // Local-clock time of the last renewal this tab knows of, its own or
  // another tab's. Null for a session restored through me: when it last
  // renewed is unknown, so it is renewed as soon as the tab shows it.
  let renewedAt: number | null = null
  // When this tab started showing the current session.
  let shownAt = 0
  // Whether that renewal was this tab's own (a verify or a refresh it sent),
  // not one another tab told it of.
  let renewedHere = false
  // When the tab last came back into view or took focus while its renewal was
  // older than RETURN_REFRESH_MS: that refresh is due then. Null once asked.
  let returnedAt: number | null = null
  const stagger = Math.min(Math.max(ports.hiddenStaggerMs ?? 0, 0), HIDDEN_STAGGER_MS)
  let refreshEpoch = machine.epoch
  let refreshFailures = 0
  // No refresh is sent before this time: one in flight, or a retry's wait.
  let notBefore = 0
  // Two different stops. A refusal (a CSRF the service no longer accepts)
  // ends refreshing for this session: another refresh cannot fix it, and a
  // new epoch starts over. Retries used up in an outage end it only for this
  // renewal window: any later renewal, here or in another tab, proves the
  // service is back and opens a new window with a full set of retries.
  let refreshRefused = false
  let retriesExhausted = false
  let cancelRefresh: (() => void) | null = null
  let refreshAt: number | null = null

  function snapshotOf(m: Machine): Snapshot {
    return { view: m.view, identity: m.identity, epoch: m.epoch, busy: m.flow.kind !== 'idle', away: heldAway(m, env) }
  }

  function dispatch(event: Event) {
    const step = reduce(machine, event, env)
    // A new epoch is a new session (or none): nothing of the old one's
    // renewal history applies. Reset before the effects, which may record a
    // renewal for the new one.
    if (step.machine.epoch !== refreshEpoch) {
      refreshEpoch = step.machine.epoch
      renewedAt = null
      renewedHere = false
      shownAt = ports.now()
      returnedAt = null
      refreshFailures = 0
      notBefore = 0
      refreshRefused = false
      retriesExhausted = false
      checkFailures = 0
      checkRetryAt = 0
      if (step.machine.session === null) lastExpiresAt = null
    }
    if (event.type === 'result' && event.epoch === machine.epoch && event.outcome.ok && (event.outcome.route === 'me' || event.outcome.route === 'refresh')) {
      checkFailures = 0
      checkRetryAt = 0
    }
    machine = step.machine
    for (const effect of step.effects) run(effect)
    // Moving to a supported funding network clears chain-scoped reads, not the cookie's expiry/renewal schedule.
    if (heldAway(machine, env) && cancelExpiry === null && lastExpiresAt !== null) schedule(lastExpiresAt, false)
    const next = snapshotOf(machine)
    if (JSON.stringify(next) !== JSON.stringify(snapshot)) {
      snapshot = next
      for (const listener of listeners) listener()
    }
    planRefresh()
  }

  /** Whether this tab has a reason to renew the session it shows: it shows one, and nothing stopped its refreshes. */
  function refreshWanted(): boolean {
    return (machine.view.status === 'signed_in' || heldAway(machine, env)) && machine.flow.kind === 'idle' && !refreshRefused && !retriesExhausted
  }

  /**
   * When the next refresh is due, on the local clock: REFRESH_AFTER_MS after the last renewal (at once for a restored
   * session, whose last renewal is unknown), later for a tab that only heard of that renewal and later still for a
   * hidden one, and at the tab's return when the renewal it knew then was older than RETURN_REFRESH_MS. Never before
   * a retry's wait.
   */
  function refreshDue(): number {
    let due = renewedAt === null ? shownAt : renewedAt + REFRESH_AFTER_MS + (renewedHere ? 0 : FOLLOW_DEFER_MS)
    if (!ports.isVisible()) due += HIDDEN_DEFER_MS + stagger
    if (returnedAt !== null && (renewedAt === null || returnedAt - renewedAt >= RETURN_REFRESH_MS)) due = Math.min(due, returnedAt)
    return Math.max(due, notBefore)
  }

  /** Keeps exactly one refresh timer, and only while a refresh is wanted. */
  function planRefresh() {
    const at = refreshWanted() ? refreshDue() : null
    if (at === refreshAt) return
    cancelRefresh?.()
    cancelRefresh = null
    refreshAt = at
    if (at === null) return
    cancelRefresh = ports.setTimer(() => {
      cancelRefresh = null
      refreshAt = null
      maybeRefresh()
    }, Math.min(Math.max(at - ports.now(), 0), MAX_TIMER_MS), 'refresh')
  }

  function maybeRefresh() {
    if (!refreshWanted()) return planRefresh()
    const now = ports.now()
    if (now < refreshDue()) return planRefresh()
    // Past the idle deadline the session has ended; the check placed for that
    // moment finds it.
    if (idleDeadline !== null && now >= idleDeadline) return
    // At most one refresh at a time; its result resets or extends this.
    notBefore = now + REFRESH_RETRY_MS[0]
    returnedAt = null
    dispatch({ type: 'refresh' })
  }

  function perform(request: Call, signal: AbortSignal): Promise<ApiOutcome> {
    const { api } = ports
    switch (request.route) {
      case 'bootstrap':
        return api.bootstrap(signal)
      case 'challenge':
        return api.challenge(request.body, request.csrf, signal)
      case 'verify':
        return api.verify(request.body, request.csrf, signal)
      case 'me':
        return api.me(signal)
      case 'refresh':
        return api.refresh(request.csrf, signal)
      case 'logout':
        return api.logout(request.csrf, signal)
    }
  }

  /**
   * The next session check: the earliest of the absolute expiry, the idle
   * deadline when known, and the regular check interval.
   */
  function schedule(expiresAt: string, fresh: boolean) {
    cancelExpiry?.()
    cancelExpiry = null
    lastExpiresAt = expiresAt
    const now = ports.now()
    if (fresh) {
      idleDeadline = now + SESSION_IDLE_MS
      renewedAt = now
    }
    const delays = [SESSION_CHECK_MS]
    const absolute = Date.parse(expiresAt) - (now + skew)
    // A deadline that already looks past is skipped. With a local clock
    // running ahead of the server's, it would fire at once, me would return
    // the same valid expiry, and the two would loop. The regular check still
    // runs.
    if (absolute > 0) delays.push(absolute + 1000)
    if (idleDeadline !== null) {
      const idle = idleDeadline - now
      // Once passed (and the session is still valid), it was not this
      // session's deadline: forget it rather than check again at once.
      if (idle > 0) delays.push(idle + 1000)
      else idleDeadline = null
    }
    cancelExpiry = ports.setTimer(() => {
      cancelExpiry = null
      dispatch({ type: 'recheck', cause: 'expiry' })
    }, Math.min(...delays, MAX_TIMER_MS), 'check')
  }

  function run(effect: Effect) {
    switch (effect.type) {
      case 'abort_inflight':
        for (const controller of inflight) controller.abort()
        inflight.clear()
        return
      case 'clear_private':
        ports.clearPrivate()
        return
      case 'broadcast':
        ports.broadcast()
        return
      case 'cancel_expiry':
        cancelExpiry?.()
        cancelExpiry = null
        idleDeadline = null
        return
      case 'schedule_expiry':
        schedule(effect.expiresAt, effect.fresh)
        // A verify or a refresh this tab sent: it makes the next renewal too.
        if (effect.fresh) renewedHere = true
        return
      case 'private_identity': {
        const scope = privateScope(snapshotOf(machine))
        if (scope) ports.storePrivate(scope, effect.identity)
        return
      }
      case 'call': {
        const controller = new AbortController()
        inflight.add(controller)
        const { epoch } = effect
        // Through a promise, so a port that throws synchronously is handled
        // like one that rejects instead of unwinding this dispatch.
        new Promise<ApiOutcome>((resolve) => resolve(perform(effect.request, controller.signal))).then(
          (outcome) => {
            inflight.delete(controller)
            if (outcome.serverTime !== null) skew = outcome.serverTime - ports.now()
            dispatch({ type: 'result', epoch, outcome })
          },
          (error: unknown) => {
            inflight.delete(controller)
            if (error instanceof OutgoingContractError) dispatch({ type: 'request_refused', epoch })
            else dispatch({ type: 'result', epoch, outcome: { ok: false, route: effect.request.route, failure: { kind: 'network_error' }, serverTime: null } as ApiOutcome })
          },
        )
        return
      }
      case 'sign': {
        const { epoch } = effect
        ports.sign({ address: effect.address, message: effect.message }).then(
          (outcome) =>
            dispatch(
              outcome.ok
                ? { type: 'signed', epoch, signature: outcome.signature }
                : { type: 'sign_failed', epoch, reason: outcome.reason },
            ),
          () => dispatch({ type: 'sign_failed', epoch, reason: 'provider_error' }),
        )
        return
      }
      case 'cleanup_logout':
        // Deliberately outside `inflight`: an identity change must not abort
        // the revocation of a session nobody will use.
        ports.api.logout(effect.csrf, new AbortController().signal).catch(() => {})
        return
      case 'renewed':
        // schedule_expiry (fresh) already recorded the renewal: a new window.
        refreshFailures = 0
        retriesExhausted = false
        notBefore = 0
        returnedAt = null
        ports.broadcastRenewal()
        return
      case 'refresh_failed': {
        if (effect.final) {
          refreshRefused = true
          return
        }
        if (refreshFailures >= REFRESH_RETRY_MS.length) {
          retriesExhausted = true
          notBefore = ports.now() + Math.max(SESSION_CHECK_MS, (effect.retryAfterS ?? 0) * 1000)
          return
        }
        const wait = Math.max(REFRESH_RETRY_MS[refreshFailures], (effect.retryAfterS ?? 0) * 1000)
        refreshFailures += 1
        notBefore = ports.now() + wait
        return
      }
      case 'check_failed': {
        cancelExpiry?.()
        cancelExpiry = null
        // Three short retries; an established session then checks at the normal interval. A never-restored session
        // waits for focus/online after those attempts. No signature, logout, or cookie assumption is made here.
        const delay = REFRESH_RETRY_MS[checkFailures] ?? (machine.session ? SESSION_CHECK_MS : null)
        checkFailures += 1
        checkRetryAt = ports.now() + Math.max(delay ?? SESSION_CHECK_MS, (effect.retryAfterS ?? 0) * 1000)
        if (delay !== null) cancelExpiry = ports.setTimer(() => {
          cancelExpiry = null
          dispatch({ type: 'recheck', cause: 'expiry' })
        }, Math.min(checkRetryAt - ports.now(), MAX_TIMER_MS), 'check')
        return
      }
    }
  }

  return {
    dispatch,
    wake() {
      const now = ports.now()
      if (checkFailures > 0 && now >= checkRetryAt) dispatch({ type: 'recheck', cause: 'visible' })
      if (retriesExhausted && now >= notBefore) {
        retriesExhausted = false
        refreshFailures = 0
      }
      // Kept until a refresh is asked (a me check the return started may run first) or a renewal lands.
      if ((machine.view.status === 'signed_in' || heldAway(machine, env)) && (renewedAt === null || now - renewedAt >= RETURN_REFRESH_MS)) returnedAt = now
      maybeRefresh()
    },
    renewedElsewhere() {
      // The same cookie, so the same session: its idle deadline moved. No
      // request: that is what keeps two tabs from both refreshing.
      if ((machine.view.status !== 'signed_in' && !heldAway(machine, env)) || lastExpiresAt === null) return
      // A new renewal window, so the outage retries start over. A refusal
      // stays: it is about this session, not about one window.
      refreshFailures = 0
      retriesExhausted = false
      returnedAt = null
      if (!refreshRefused) notBefore = 0
      schedule(lastExpiresAt, true)
      // Another tab made this renewal: it makes the next one, and this tab waits FOLLOW_DEFER_MS longer.
      renewedHere = false
      dispatch({ type: 'renewed_elsewhere' })
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    withSessionCsrf(epoch, fn) {
      const held = machine.session
      // Changed on purpose 2026-10-05: signed in, or the same session held on Base or Arbitrum One (machine.ts heldAway);
      // since 2026-10-06 also on a network a deposit may come from.
      if (machine.epoch !== epoch || held === null || (machine.view.status !== 'signed_in' && !heldAway(machine, env))) return Promise.resolve(NO_SESSION)
      return fn(held.csrf)
    },
  }
}
