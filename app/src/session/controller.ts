import { OutgoingContractError, type ApiOutcome, type SessionApi } from './api'
import {
  initialMachine,
  reduce,
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
 * renewed with POST refresh. A refresh is asked for only while the tab shows
 * a signed-in session, is visible, and has seen user activity since the
 * session was last renewed, so a session nobody is using still idles out.
 *
 * That timing (a refresh 20 minutes after the last renewal, only while the
 * tab is visible and in use, at most three retries, one read-only me after a
 * CSRF refusal) is this client's policy. The producer accepted it as policy on
 * #14; session-v1 does not guarantee any of it on the wire.
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
  /** Whether the page is visible. A hidden tab never refreshes. */
  isVisible(): boolean
  now(): number
  /** Returns a function that cancels the timer. */
  setTimer(callback: () => void, ms: number): () => void
  origin: string
  checksum(address: string): string
}

export interface Snapshot {
  view: View
  identity: WalletIdentity
  epoch: number
  busy: boolean
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
 * How old a renewal may get before an active tab renews it: ten minutes
 * before the idle deadline, which leaves room for the retries below.
 */
export const REFRESH_AFTER_MS = 20 * 60_000

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

export interface SessionController {
  dispatch(event: Event): void
  /** The user did something in this tab (a key, a pointer, a wheel). */
  activity(): void
  /** The tab may have come back into view: a refresh that waited for it can run. */
  wake(): void
  /** Another tab renewed the session; this tab's idle deadline moves with it. */
  renewedElsewhere(): void
  subscribe(listener: () => void): () => void
  getSnapshot(): Snapshot
}

export function createSessionController(ports: ControllerPorts): SessionController {
  const env: Env = { origin: ports.origin, checksum: ports.checksum }
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

  // Refresh bookkeeping, reset for every new epoch (a new session or identity).
  // Local-clock time of the last renewal this tab knows of, its own or
  // another tab's. Null for a session restored through me: when it last
  // renewed is unknown, so the first activity after the restore renews it.
  let renewedAt: number | null = null
  // When this tab started showing the current session.
  let shownAt = 0
  let lastActivity = Number.NEGATIVE_INFINITY
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
    return { view: m.view, identity: m.identity, epoch: m.epoch, busy: m.flow.kind !== 'idle' }
  }

  function dispatch(event: Event) {
    const step = reduce(machine, event, env)
    // A new epoch is a new session (or none): nothing of the old one's
    // renewal history applies. Reset before the effects, which may record a
    // renewal for the new one.
    if (step.machine.epoch !== refreshEpoch) {
      refreshEpoch = step.machine.epoch
      renewedAt = null
      shownAt = ports.now()
      refreshFailures = 0
      notBefore = 0
      refreshRefused = false
      retriesExhausted = false
    }
    machine = step.machine
    for (const effect of step.effects) run(effect)
    const next = snapshotOf(machine)
    if (JSON.stringify(next) !== JSON.stringify(snapshot)) {
      snapshot = next
      for (const listener of listeners) listener()
    }
    planRefresh()
  }

  /** Whether this tab has a reason to renew the session it shows. */
  function refreshWanted(): boolean {
    if (machine.view.status !== 'signed_in' || machine.flow.kind !== 'idle' || refreshRefused || retriesExhausted) return false
    // Activity since the last renewal (or since the session appeared here).
    return lastActivity > (renewedAt ?? shownAt)
  }

  /** When the next refresh is due, on the local clock. */
  function refreshDue(): number {
    return Math.max(renewedAt === null ? shownAt : renewedAt + REFRESH_AFTER_MS, notBefore)
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
    }, Math.min(Math.max(at - ports.now(), 0), MAX_TIMER_MS))
  }

  function maybeRefresh() {
    if (!refreshWanted()) return planRefresh()
    const now = ports.now()
    if (now < refreshDue()) return planRefresh()
    // Past the idle deadline the session has ended; the check placed for that
    // moment finds it. A hidden tab waits for wake().
    if (idleDeadline !== null && now >= idleDeadline) return
    if (!ports.isVisible()) return
    // At most one refresh at a time; its result resets or extends this.
    notBefore = now + REFRESH_RETRY_MS[0]
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
    }, Math.min(...delays, MAX_TIMER_MS))
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
        ports.broadcastRenewal()
        return
      case 'refresh_failed': {
        if (effect.final) {
          refreshRefused = true
          return
        }
        if (refreshFailures >= REFRESH_RETRY_MS.length) {
          retriesExhausted = true
          return
        }
        const wait = Math.max(REFRESH_RETRY_MS[refreshFailures], (effect.retryAfterS ?? 0) * 1000)
        refreshFailures += 1
        notBefore = ports.now() + wait
        return
      }
    }
  }

  return {
    dispatch,
    activity() {
      lastActivity = ports.now()
      maybeRefresh()
    },
    wake() {
      maybeRefresh()
    },
    renewedElsewhere() {
      // The same cookie, so the same session: its idle deadline moved. No
      // request: that is what keeps two active tabs from both refreshing.
      if (machine.view.status !== 'signed_in' || lastExpiresAt === null) return
      // A new renewal window, so the outage retries start over. A refusal
      // stays: it is about this session, not about one window.
      refreshFailures = 0
      retriesExhausted = false
      if (!refreshRefused) notBefore = 0
      schedule(lastExpiresAt, true)
      dispatch({ type: 'renewed_elsewhere' })
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
  }
}
