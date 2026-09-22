/**
 * What the onboarding previews (#38) and, later, the live deposit consumer see
 * of the wallet session: one flat snapshot, the CSRF lent per request, and a
 * way to report that the server refused the session.
 *
 * It is pure: `createSessionPort` wraps any controller with B2's public
 * surface, so node tests drive it with a fake. session/livePort.ts binds it to
 * the page's one session controller. The mapping from B2's `View` is
 * exhaustive, so a new status in B2 fails typechecking here.
 */
import { NO_SESSION, type Snapshot } from './controller'
import type { Event, FailureKind } from './machine'

export type Lower = `0x${string}`

export type SessionSnapshot =
  /** The build has no wallet session. */
  | { kind: 'off' }
  | { kind: 'pending' }
  | { kind: 'no_wallet' }
  | { kind: 'wrong_network'; chainId: number }
  | { kind: 'signed_out' }
  | { kind: 'wallet_account_differs' }
  | { kind: 'gate_required' }
  | { kind: 'gate_unavailable' }
  | { kind: 'session_disabled' }
  | { kind: 'session_busy'; retryAfterS: number | null }
  | { kind: 'account_unsupported' }
  | { kind: 'session_error' }
  | { kind: 'browser_unsupported' }
  /**
   * `connectorUid` is the connector instance the session was signed in
   * through: B2's wagmi uid, one per announced provider, never the rdns a
   * provider announces about itself (two can announce the same).
   */
  | { kind: 'signed_in'; owner: Lower; chainId: 4663; epoch: number; connectorUid: string }

export type SessionKind = SessionSnapshot['kind']

/** What `withCsrf` resolves to when the session asked for is gone. */
export const SESSION_GONE: typeof NO_SESSION = NO_SESSION

export type DenialCode = 'session_required' | 'csrf_invalid' | 'account_unsupported'

export interface SessionPort {
  getSnapshot(): SessionSnapshot
  subscribe(listener: () => void): () => void
  /** Runs `fn` with the session CSRF while the session of `epoch` is signed in; otherwise SESSION_GONE. */
  withCsrf<T>(epoch: number, fn: (csrf: string) => Promise<T>): Promise<T | typeof SESSION_GONE>
  /** A private route refused the session of `epoch`. Never leads to a signature. */
  reportDenial(code: DenialCode, epoch: number): void
  /** False when the controller cannot lend its CSRF: nothing private can be sent. */
  readonly csrfAccess: boolean
}

/** B2's controller, as much of it as the port uses. */
export interface ControllerLike {
  getSnapshot(): Snapshot
  subscribe(listener: () => void): () => void
  dispatch(event: Event): void
  withSessionCsrf?: <T>(epoch: number, fn: (csrf: string) => Promise<T>) => Promise<T | typeof NO_SESSION>
}

const lower = (address: string) => address.toLowerCase() as Lower

/** Each of B2's blocked failures, as the previews explain it. */
const BLOCKED: Readonly<Record<FailureKind, SessionKind>> = {
  gate_required: 'gate_required',
  gate_unavailable: 'gate_unavailable',
  service_disabled: 'session_disabled',
  store_unavailable: 'session_busy',
  account_check_unavailable: 'session_busy',
  service_unavailable: 'session_busy',
  rate_limited: 'session_busy',
  network_error: 'session_busy',
  timeout: 'session_busy',
  signout_unconfirmed: 'session_busy',
  account_unsupported: 'account_unsupported',
  contract_mismatch: 'session_error',
  untrusted_challenge: 'session_error',
  client_error: 'session_error',
  browser_unsupported: 'browser_unsupported',
}

/** B2's snapshot as the port's. `locked` holds owners this page saw refused as account_unsupported. */
export function toSessionSnapshot(snapshot: Snapshot, locked: ReadonlySet<string>): SessionSnapshot {
  const { view, identity, epoch } = snapshot
  if (identity.kind === 'connected' && locked.has(identity.address.toLowerCase())) return { kind: 'account_unsupported' }
  switch (view.status) {
    case 'starting':
    case 'checking':
    case 'signing_in':
    case 'signing_out':
      return { kind: 'pending' }
    case 'no_wallet':
      return { kind: 'no_wallet' }
    case 'wrong_network':
      return { kind: 'wrong_network', chainId: view.chainId }
    case 'signed_out':
      return { kind: 'signed_out' }
    case 'other_session':
      return { kind: 'wallet_account_differs' }
    case 'blocked': {
      const kind = BLOCKED[view.failure]
      return kind === 'session_busy' ? { kind, retryAfterS: view.retryAfterS } : ({ kind } as SessionSnapshot)
    }
    case 'signed_in': {
      if (identity.kind !== 'connected') return { kind: 'pending' }
      if (identity.chainId !== 4663) return { kind: 'wrong_network', chainId: identity.chainId }
      if (lower(identity.address) !== lower(view.owner)) return { kind: 'wallet_account_differs' }
      if (locked.has(lower(view.owner))) return { kind: 'account_unsupported' }
      return { kind: 'signed_in', owner: lower(view.owner), chainId: 4663, epoch, connectorUid: identity.connectorUid }
    }
    default: {
      const unreachable: never = view
      return unreachable
    }
  }
}

/**
 * Identifies one signed-in server session for one owner through one connector
 * instance: the scope a preview and the deposit screen's state live in. B2
 * starts a new epoch for every identity change and for every new CSRF
 * (machine.ts signedIn). The key also names the connector instance, as B2's
 * private scope does, so what was fetched through one provider is never shown
 * for another, even under a controller that kept its epoch.
 */
export function sessionKey(snapshot: SessionSnapshot): string | null {
  return snapshot.kind === 'signed_in' ? `${snapshot.epoch}|${snapshot.connectorUid}|${snapshot.owner}` : null
}

export function createSessionPort(controller: ControllerLike): SessionPort {
  const locked = new Set<string>()
  const listeners = new Set<() => void>()
  let lastInput: Snapshot | null = null
  let lastLocks = -1
  let locks = 0
  let cached: SessionSnapshot = { kind: 'pending' }

  const notify = () => {
    for (const listener of listeners) listener()
  }

  function getSnapshot(): SessionSnapshot {
    const input = controller.getSnapshot()
    if (input !== lastInput || locks !== lastLocks) {
      const next = toSessionSnapshot(input, locked)
      // Stable identity while nothing changed, as useSyncExternalStore requires.
      if (JSON.stringify(next) !== JSON.stringify(cached)) cached = next
      lastInput = input
      lastLocks = locks
    }
    return cached
  }

  const csrfAccess = typeof controller.withSessionCsrf === 'function'

  return {
    csrfAccess,
    getSnapshot,
    subscribe(listener) {
      listeners.add(listener)
      const off = controller.subscribe(listener)
      return () => {
        listeners.delete(listener)
        off()
      }
    },
    withCsrf(epoch, fn) {
      if (!controller.withSessionCsrf) return Promise.resolve(SESSION_GONE)
      return controller.withSessionCsrf(epoch, fn)
    },
    reportDenial(code, epoch) {
      const current = controller.getSnapshot()
      if (current.epoch !== epoch) return
      switch (code) {
        case 'session_required':
        case 'csrf_invalid':
          // Re-read me: a session that ended lands on signed out, a valid one
          // is kept with its CSRF. Never a signature.
          controller.dispatch({ type: 'recheck', cause: 'remote' })
          return
        case 'account_unsupported': {
          // The server revoked the session. This page stops offering previews
          // to that address and signs the tab out; a later sign-in is refused
          // by the server again.
          const { view, identity } = current
          const owner = view.status === 'signed_in' ? view.owner : identity.kind === 'connected' ? identity.address : null
          if (owner !== null) {
            locked.add(owner.toLowerCase())
            locks += 1
            notify()
          }
          controller.dispatch({ type: 'sign_out' })
          return
        }
        default:
          return code satisfies never
      }
    },
  }
}
