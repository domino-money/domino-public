import type { AccountValidation, SessionRequests, SessionResponses } from 'api-contracts/session-v1/types'
import type { ApiOutcome, RouteOutcome, TransportFailure } from './api'
import { classify } from './errors'
import { checkChallengeMessage } from './siwe'
import { ELYSIUM_ID, ELYSIUM_STATUS, REGISTRY_CHAIN_IDS, ROBINHOOD_ID } from '../config/chainIdentity'
import { sectionLinked } from '../chains/elysium/mode'

/**
 * The wallet-session state machine, as a pure function.
 *
 * Every rule that keeps one account's session away from another lives here,
 * where node tests can walk it without a browser or a wallet:
 *
 *   - A result that belongs to an abandoned flow never changes what is shown.
 *     Each flow runs under an epoch, and any change of wallet identity starts
 *     a new one.
 *   - A change of wallet account, network or connector abandons everything in
 *     flight, clears private data and signs the previous session out before
 *     anything is offered to the new identity.
 *   - A signature is only requested as the next step of a sign-in the user
 *     started, and only after the server's message passed siwe.ts. No error,
 *     retry or recovery path requests one.
 *   - A recheck (expiry, visibility, another tab) that arrives while a flow is
 *     running is remembered and runs once the flow ends, so another tab's
 *     sign-out is never lost behind this tab's own request.
 *   - POST refresh is the request this client sends to renew the 30-minute
 *     idle deadline. It is not the only one that renews it: on the producer
 *     an authenticated preview does too (session_store.py finish_preview),
 *     while GET me never does. The controller decides when to ask for a
 *     refresh (see controller.ts). Here a refresh keeps the session and its
 *     private scope when it works, signs out on session_required, re-reads me
 *     once on a CSRF refusal and keeps the session through an outage. No
 *     refresh outcome requests a signature.
 *
 * The reducer returns effects instead of performing them; controller.ts runs
 * them. Credentials live in the machine and never in the view, which is the
 * only part React sees.
 */

/** Robinhood Chain's id. Changed on purpose 2026-10-01 (the chain2 workstream, part B, audit item G3): the registry's. */
export const ROBINHOOD_CHAIN_ID = ROBINHOOD_ID

export type WalletIdentity =
  /** The wallet is still reconnecting; nothing is known yet. */
  | { kind: 'unknown' }
  | { kind: 'disconnected' }
  /**
   * `address` is EIP-55. `connectorUid` is the connector instance the
   * connection goes through: wagmi makes one for each EIP-6963 provider
   * announced on this page and keeps it for the life of the page (a provider
   * that announces itself again is not a new one). The rdns a provider
   * announces is its own claim, and two providers can make the same one, so it
   * identifies nothing here.
   */
  | { kind: 'connected'; connectorUid: string; connectorName: string; address: string; chainId: number }

type Connected = Extract<WalletIdentity, { kind: 'connected' }>

export function identityKey(identity: WalletIdentity): string | null {
  return identity.kind === 'connected'
    ? `${identity.connectorUid}|${identity.address.toLowerCase()}|${identity.chainId}`
    : null
}

export type SignedOutReason =
  | 'none'
  | 'logged_out'
  | 'session_ended'
  | 'identity_changed'
  | 'challenge_expired'
  | 'signature_rejected'
  | 'signature_declined'
  | 'wallet_error'
  | 'preauth_expired'
  | 'lost_response'
  | 'signin_aborted'
  | 'signin_cancelled'

export type FailureKind =
  | 'gate_required'
  | 'gate_unavailable'
  | 'service_disabled'
  | 'store_unavailable'
  | 'account_check_unavailable'
  | 'service_unavailable'
  | 'rate_limited'
  | 'account_unsupported'
  | 'contract_mismatch'
  | 'untrusted_challenge'
  | 'network_error'
  | 'timeout'
  | 'signout_unconfirmed'
  | 'client_error'
  | 'browser_unsupported'

/** What the "try again" control does from a blocked state. Never a signature. */
export type Retry = 'check' | 'sign_out' | 'none'

export type SigningStep = 'bootstrap' | 'challenge' | 'awaiting_signature' | 'verifying' | 'recovering' | 'closing'

export type View =
  | { status: 'starting' }
  | { status: 'no_wallet' }
  | { status: 'wrong_network'; chainId: number }
  | { status: 'checking' }
  | { status: 'signed_out'; reason: SignedOutReason }
  | { status: 'signing_in'; step: SigningStep }
  /**
   * `notice` is set while the service could not renew the session: it is
   * still signed in, and the controller retries a few times.
   */
  | { status: 'signed_in'; owner: string; expiresAt: string; notice?: 'refresh_unavailable' }
  /** This browser holds a session for an address other than the connected one. */
  | { status: 'other_session'; owner: string }
  | { status: 'signing_out' }
  | { status: 'blocked'; failure: FailureKind; retry: Retry; retryAfterS: number | null }

type LogoutPurpose = 'user' | 'identity_change' | 'abort_login'

/** Where a flow lands: a resting view for the current identity, or a fixed one. */
type Landing = { reason: SignedOutReason } | { view: View }

type Flow =
  | { kind: 'idle' }
  | { kind: 'bootstrap'; address: string }
  | { kind: 'challenge'; address: string }
  | { kind: 'sign'; address: string; challengeId: string; message: string }
  | { kind: 'verify'; address: string }
  | { kind: 'me'; purpose: 'restore'; wasSignedIn: boolean }
  | { kind: 'me'; purpose: 'adopt'; address: string }
  | { kind: 'me'; purpose: 'recover_verify'; address: string; landing: Landing; adopt: boolean }
  | { kind: 'me'; purpose: 'recover_logout'; logout: LogoutPurpose; owner: string; after: Landing }
  | { kind: 'me'; purpose: 'sign_out' }
  /** POST refresh with the session CSRF, behind the signed-in view. */
  | { kind: 'refresh' }
  | { kind: 'logout'; purpose: LogoutPurpose; csrf: string; owner: string; retried: boolean; after: Landing }

type MeFlow = Extract<Flow, { kind: 'me' }>
type LogoutFlow = Extract<Flow, { kind: 'logout' }>

export interface Machine {
  readonly view: View
  readonly epoch: number
  readonly identity: WalletIdentity
  readonly flow: Flow
  /** The session this browser holds, once verify or me has shown it. Owner is lowercase. */
  readonly session: { readonly owner: string; readonly csrf: string } | null
  readonly preauthCsrf: string | null
  /** Lowercase addresses refused with account_unsupported. */
  readonly locked: readonly string[]
  /**
   * A recheck arrived while a flow was running. It runs as soon as the flow
   * is idle again. Only ever true while a flow is running.
   */
  readonly recheckPending: boolean
}

/** The signed-in identity projection written to the private cache. */
export interface PrivateIdentity {
  owner: string
  expiresAt: string
  validation: AccountValidation
}

export type Call =
  | { route: 'bootstrap' }
  | { route: 'challenge'; body: SessionRequests['challenge']; csrf: string }
  | { route: 'verify'; body: SessionRequests['verify']; csrf: string }
  | { route: 'me' }
  | { route: 'refresh'; csrf: string }
  | { route: 'logout'; csrf: string }

export type Effect =
  | { type: 'abort_inflight' }
  | { type: 'clear_private' }
  | { type: 'broadcast' }
  | { type: 'cancel_expiry' }
  /**
   * Places the next session check. `fresh` means the session was created just
   * now, so its idle deadline is known to be one idle period away.
   */
  | { type: 'schedule_expiry'; expiresAt: string; fresh: boolean }
  | { type: 'private_identity'; identity: PrivateIdentity }
  | { type: 'call'; epoch: number; request: Call }
  | { type: 'sign'; epoch: number; address: string; message: string }
  /** Revokes a session created by an abandoned flow. Its result is not awaited. */
  | { type: 'cleanup_logout'; csrf: string }
  /** A refresh renewed the session's idle deadline. The controller tells other tabs. */
  | { type: 'renewed' }
  /**
   * A refresh did not renew the session. `final` means no further refresh for
   * this server session; otherwise the controller may retry, after at least
   * `retryAfterS` when the service gave one.
   */
  | { type: 'refresh_failed'; final: boolean; retryAfterS: number | null }

export type Event =
  | { type: 'identity'; identity: WalletIdentity }
  | { type: 'sign_in' }
  | { type: 'cancel' }
  | { type: 'sign_out' }
  | { type: 'retry' }
  | { type: 'recheck'; cause: 'expiry' | 'visible' | 'remote' }
  /** The controller asks to renew the idle deadline (the user is active in a visible tab). */
  | { type: 'refresh' }
  /** Another tab renewed the session this tab shows. */
  | { type: 'renewed_elsewhere' }
  | { type: 'unsupported_browser' }
  | { type: 'result'; epoch: number; outcome: ApiOutcome }
  /** A request body failed the contract before anything was sent. */
  | { type: 'request_refused'; epoch: number }
  | { type: 'signed'; epoch: number; signature: string }
  | { type: 'sign_failed'; epoch: number; reason: 'user_rejected' | 'provider_error' }

export interface Env {
  origin: string
  checksum(address: string): string
  /**
   * The registry's chains a signed-in account keeps its session across (G11), as sessionChains(origin) gives them for
   * the page's origin (session/controller.ts). Absent: Robinhood Chain alone, so every move is an identity change.
   */
  chains?: readonly number[]
}

/**
 * The registry's chains whose screens exist at `origin` (2026-10-01, fix round 1): Robinhood Chain everywhere, and the
 * second chain only where its section is open (chains/elysium/mode.ts sectionLinked, the menu's and the router's rule).
 * On domino.money, while that section is off, a wallet that moves to the second chain's network is an identity change
 * like any other chain outside the site, exactly as before the section existed.
 */
export function sessionChains(origin: string): readonly number[] {
  return REGISTRY_CHAIN_IDS.filter((id) => id !== ELYSIUM_ID || sectionLinked(origin, ELYSIUM_STATUS))
}

export interface Step {
  machine: Machine
  effects: Effect[]
}

const IDLE: Flow = { kind: 'idle' }

export const initialMachine: Machine = {
  view: { status: 'starting' },
  epoch: 0,
  identity: { kind: 'unknown' },
  flow: IDLE,
  session: null,
  preauthCsrf: null,
  locked: [],
  recheckPending: false,
}

const lower = (address: string) => address.toLowerCase()
const same = (machine: Machine): Step => ({ machine, effects: [] })
const blocked = (failure: FailureKind, retry: Retry, retryAfterS: number | null = null): View => ({
  status: 'blocked',
  failure,
  retry,
  retryAfterS,
})
const call = (machine: Machine, request: Call): Effect => ({ type: 'call', epoch: machine.epoch, request })

function onRobinhood(identity: WalletIdentity): identity is Connected {
  return identity.kind === 'connected' && identity.chainId === ROBINHOOD_CHAIN_ID
}

/** What to show for the current identity when nothing is in flight. */
function resting(m: Machine, reason: SignedOutReason): View {
  const id = m.identity
  if (id.kind === 'unknown') return { status: 'starting' }
  if (id.kind === 'disconnected') return { status: 'no_wallet' }
  if (id.chainId !== ROBINHOOD_CHAIN_ID) return { status: 'wrong_network', chainId: id.chainId }
  if (m.locked.includes(lower(id.address))) return blocked('account_unsupported', 'none')
  return { status: 'signed_out', reason }
}

const land = (m: Machine, landing: Landing): View => ('view' in landing ? landing.view : resting(m, landing.reason))

function sessionEnded(failure: TransportFailure): boolean {
  return failure.kind === 'session_error' && classify(failure.code) === 'session_ended'
}

/** The blocked view for a failure nothing more specific handled. */
export function blockedFor(failure: TransportFailure): View {
  switch (failure.kind) {
    case 'gate_required':
      return blocked('gate_required', 'none')
    case 'gate_unavailable':
      return blocked('gate_unavailable', 'check')
    // A platform 5xx (an edge or Worker failure) is an outage, not a
    // deployment without sign-in.
    case 'not_routed':
      return failure.status >= 500 ? blocked('service_unavailable', 'check') : blocked('service_disabled', 'none')
    case 'contract_mismatch':
      return blocked('contract_mismatch', 'none')
    case 'runtime_error':
      return blocked('browser_unsupported', 'none')
    case 'timeout':
      return blocked('timeout', 'check')
    case 'network_error':
    case 'aborted':
      return blocked('network_error', 'check')
    case 'session_error':
      switch (classify(failure.code)) {
        case 'disabled':
          return blocked('service_disabled', 'none')
        case 'rate_limited':
          return blocked('rate_limited', 'check', failure.retryAfterS)
        case 'store_unavailable':
          return blocked('store_unavailable', 'check')
        case 'account_check_unavailable':
          return blocked('account_check_unavailable', 'check')
        case 'upstream':
          return blocked('service_unavailable', 'check')
        case 'timeout':
          return blocked('timeout', 'check')
        case 'unsupported_account':
          return blocked('account_unsupported', 'none')
        // This page sent something the service rejects. Repeating it cannot help.
        default:
          return blocked('client_error', 'none')
      }
  }
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function checkSession(m: Machine, wasSignedIn: boolean, view: View = m.view): Step {
  const next: Machine = { ...m, flow: { kind: 'me', purpose: 'restore', wasSignedIn }, view }
  return { machine: next, effects: [call(next, { route: 'me' })] }
}

function signedIn(m: Machine, body: SessionResponses['me'], announce: boolean, fresh = false): Step {
  const owner = body.owner.address
  // The CSRF is session-bound and never rotates within a session (session-v1
  // README), so a different one for the same owner is a different server
  // session: another tab signed out and in again, or a revoked wallet was
  // re-admitted and signed in elsewhere, while this tab missed the step in
  // between. Each server session gets its own epoch, and so its own private
  // scope. Whatever was cached for the session this tab held is dropped
  // first, together with its deadlines. This comparison, in memory, is the
  // only use of the CSRF besides the request header it travels in: it is
  // never stored, put in a URL or a query key, logged or sent to another tab.
  const unchanged = m.session !== null && m.session.owner === owner && m.session.csrf === body.csrfToken
  // A failed renewal stays on screen until a renewal works, not merely until
  // the next me shows the session is still there.
  const notice = unchanged && !fresh && m.view.status === 'signed_in' ? m.view.notice : undefined
  const next: Machine = {
    ...m,
    epoch: unchanged ? m.epoch : m.epoch + 1,
    flow: IDLE,
    preauthCsrf: null,
    session: { owner, csrf: body.csrfToken },
    view: { status: 'signed_in', owner, expiresAt: body.expiresAt, ...(notice ? { notice } : {}) },
  }
  const effects: Effect[] = m.session !== null && !unchanged ? [{ type: 'clear_private' }, { type: 'cancel_expiry' }] : []
  effects.push(
    { type: 'private_identity', identity: { owner, expiresAt: body.expiresAt, validation: body.validation } },
    { type: 'schedule_expiry', expiresAt: body.expiresAt, fresh },
  )
  // Only a transition this tab made itself is announced. A tab never
  // re-announces what it learned from another, or two tabs would ping-pong.
  if (announce) effects.push({ type: 'broadcast' })
  return { machine: next, effects }
}

function otherSession(m: Machine, body: SessionResponses['me'], effects: Effect[] = []): Step {
  const owner = body.owner.address
  return {
    machine: { ...m, flow: IDLE, preauthCsrf: null, session: { owner, csrf: body.csrfToken }, view: { status: 'other_session', owner } },
    effects,
  }
}

function rest(m: Machine, reason: SignedOutReason): Step {
  return same({ ...m, flow: IDLE, preauthCsrf: null, view: resting(m, reason) })
}

function stop(m: Machine, failure: TransportFailure): Step {
  return same({ ...m, flow: IDLE, preauthCsrf: null, view: blockedFor(failure) })
}

function logout(m: Machine, flow: LogoutFlow, view: View, before: Effect[] = []): Step {
  const next: Machine = { ...m, flow, view }
  return { machine: next, effects: [...before, call(next, { route: 'logout', csrf: flow.csrf })] }
}

function flowAddress(m: Machine): string | null {
  const f = m.flow
  if ('address' in f) return f.address
  return m.identity.kind === 'connected' ? m.identity.address : null
}

/**
 * Closes a sign-in that got as far as a preauth context. Without the context
 * there is nothing to close and the flow simply lands.
 */
function abortLogin(m: Machine, landing: Landing): Step {
  const address = flowAddress(m)
  if (!m.preauthCsrf || address === null) return same({ ...m, flow: IDLE, preauthCsrf: null, view: land(m, landing) })
  const flow: LogoutFlow = {
    kind: 'logout',
    purpose: 'abort_login',
    csrf: m.preauthCsrf,
    owner: lower(address),
    retried: false,
    after: landing,
  }
  return logout({ ...m, preauthCsrf: null }, flow, { status: 'signing_in', step: 'closing' })
}

function adopt(m: Machine, address: string): Step {
  const next: Machine = { ...m, flow: { kind: 'me', purpose: 'adopt', address }, view: { status: 'signing_in', step: 'recovering' } }
  return { machine: next, effects: [call(next, { route: 'me' })] }
}

/**
 * The verify response never arrived, or arrived as a failure the store may
 * have committed behind. Read me first: an applied cookie recovers the session
 * without replaying the consumed signature. Otherwise the still-held preauth
 * context revokes anything it created.
 */
function recoverVerify(m: Machine, address: string, landing: Landing, allowAdopt: boolean): Step {
  const next: Machine = {
    ...m,
    flow: { kind: 'me', purpose: 'recover_verify', address, landing, adopt: allowAdopt },
    view: { status: 'signing_in', step: 'recovering' },
  }
  return { machine: next, effects: [call(next, { route: 'me' })] }
}

function finishLogout(m: Machine, purpose: LogoutPurpose, after: Landing): Step {
  const next: Machine = { ...m, flow: IDLE, session: null, preauthCsrf: null, view: land(m, after) }
  const effects: Effect[] = [{ type: 'clear_private' }, { type: 'cancel_expiry' }]
  if (purpose !== 'abort_login') effects.push({ type: 'broadcast' })
  return { machine: next, effects }
}

function failLogout(m: Machine, purpose: LogoutPurpose, after: Landing): Step {
  // An abandoned login needs no confirmation: the context lapses in ten
  // minutes and holds no authority. A session sign-out must be confirmed
  // before this browser offers sign-in again.
  if (purpose === 'abort_login') return same({ ...m, flow: IDLE, view: land(m, after) })
  return same({ ...m, flow: IDLE, view: blocked('signout_unconfirmed', 'sign_out') })
}

// ---------------------------------------------------------------------------
// Wallet identity
// ---------------------------------------------------------------------------

function onIdentity(m: Machine, identity: WalletIdentity, chains: readonly number[]): Step {
  const before = m.identity
  if (before.kind === identity.kind && identityKey(before) === identityKey(identity)) return same(m)
  if (before.kind === 'connected') return (movedWithinRegistry(before, identity, chains) && moveChain(m, identity)) || switchIdentity(m, before, identity)
  return settle({ ...m, identity, recheckPending: false })
}

/**
 * The same wallet and the same account, moved from one chain of the registry to another (2026-10-01, the chain2
 * workstream, part B, audit item G11): Robinhood Chain and the second chain's section (config/chainIdentity.ts
 * REGISTRY_CHAIN_IDS), where that section is open at the page's origin (`chains`, sessionChains). Anything else (another
 * account, another wallet, a chain outside them) is an identity change as it always was.
 */
function movedWithinRegistry(before: Connected, identity: WalletIdentity, chains: readonly number[]): identity is Connected {
  return (
    identity.kind === 'connected' &&
    identity.connectorUid === before.connectorUid &&
    lower(identity.address) === lower(before.address) &&
    identity.chainId !== before.chainId &&
    chains.includes(before.chainId) &&
    chains.includes(identity.chainId)
  )
}

/**
 * A signed-in account's wallet moved between the registry's chains: the session is the account's, not the network's,
 * so it is kept, where it used to be closed and a new signature asked on the way back. Only a session at rest is kept
 * (no flow, or a background check, which is abandoned): a sign-in, a sign-out or a recovery in progress ends as any
 * identity change ends it (null here: switchIdentity). Leaving Robinhood Chain rests on wrong_network with the session
 * held, as a wallet on any other chain does, and asks nothing; coming back reads me, and is signed in again without a
 * signature where the session still stands (or signed out where it ended meanwhile). What was read for the chain left
 * behind is dropped (a new epoch, its private data cleared) and its deadline is checked again on the way back.
 */
function moveChain(m: Machine, identity: Connected): Step | null {
  if ((m.flow.kind !== 'idle' && !backgroundCheck(m)) || !m.session || m.session.owner !== lower(identity.address)) return null
  const base: Machine = { ...m, identity, epoch: m.epoch + 1, flow: IDLE, recheckPending: false }
  const effects: Effect[] = [{ type: 'abort_inflight' }, { type: 'cancel_expiry' }, { type: 'clear_private' }]
  if (identity.chainId === ROBINHOOD_CHAIN_ID) {
    const step = checkSession(base, true, { status: 'checking' })
    return { machine: step.machine, effects: [...effects, ...step.effects] }
  }
  return { machine: { ...base, view: { status: 'wrong_network', chainId: identity.chainId } }, effects }
}

/** First known identity after reconnecting, or a connect from no wallet. */
function settle(m: Machine): Step {
  // A sign-out still running lands on the resting view for this identity.
  if (m.flow.kind !== 'idle') return same(m)
  if (m.view.status === 'blocked' && m.view.failure === 'browser_unsupported') return same(m)
  const id = m.identity
  if (onRobinhood(id) && !m.locked.includes(lower(id.address))) {
    return checkSession({ ...m, epoch: m.epoch + 1 }, false, { status: 'checking' })
  }
  return same({ ...m, view: resting(m, 'none') })
}

/**
 * The account, network or connector changed. Nothing from before may reach
 * the new identity: in-flight requests are abandoned (their late results are
 * stale by epoch), private data is dropped, and the old session or pending
 * login is closed. Signing in as the new identity is a fresh, user-started
 * sign-in.
 */
function switchIdentity(m: Machine, before: Connected, identity: WalletIdentity): Step {
  const owner = lower(before.address)
  // A recheck waiting for the old identity's flow is moot: the new identity
  // gets its own check (or sign-out) below.
  const base: Machine = { ...m, identity, epoch: m.epoch + 1, flow: IDLE, session: null, preauthCsrf: null, recheckPending: false }
  const effects: Effect[] = [{ type: 'abort_inflight' }, { type: 'cancel_expiry' }, { type: 'clear_private' }]
  const after: Landing = { reason: 'identity_changed' }
  const flow = m.flow

  // A sign-out that was already running is sent again. Repeating a logout is
  // harmless; losing one leaves a session behind.
  if (flow.kind === 'logout') return logout(base, { ...flow, after }, { status: 'signing_out' }, effects)
  if (flow.kind === 'me' && flow.purpose === 'recover_logout') {
    const next: Machine = { ...base, flow: { ...flow, after }, view: { status: 'signing_out' } }
    return { machine: next, effects: [...effects, call(next, { route: 'me' })] }
  }
  if (m.session && m.session.owner === owner) {
    const out: LogoutFlow = { kind: 'logout', purpose: 'identity_change', csrf: m.session.csrf, owner, retried: false, after }
    return logout(base, out, { status: 'signing_out' }, effects)
  }
  if (m.preauthCsrf) {
    const out: LogoutFlow = { kind: 'logout', purpose: 'abort_login', csrf: m.preauthCsrf, owner, retried: false, after }
    return logout(base, out, { status: 'signing_out' }, effects)
  }
  // Nothing of the old identity's to close. A session this browser holds for
  // someone else is left alone; me tells the new identity where it stands.
  if (onRobinhood(identity) && !m.locked.includes(lower(identity.address))) {
    const step = checkSession(base, false, { status: 'checking' })
    return { machine: step.machine, effects: [...effects, ...step.effects] }
  }
  return { machine: { ...base, view: resting(base, 'identity_changed') }, effects }
}

// ---------------------------------------------------------------------------
// User actions
// ---------------------------------------------------------------------------

/**
 * A background check (expiry, visibility, another tab) is the only flow that
 * runs behind a resting view. A user action on that view takes precedence: a
 * click is never swallowed by a check the user did not start. The check's
 * late answer is stale by epoch.
 */
const backgroundCheck = (m: Machine): boolean =>
  (m.flow.kind === 'me' && m.flow.purpose === 'restore') || m.flow.kind === 'refresh'

function startSignIn(m: Machine): Step {
  const id = m.identity
  const interrupting = backgroundCheck(m)
  if ((m.flow.kind !== 'idle' && !interrupting) || m.view.status !== 'signed_out' || !onRobinhood(id)) return same(m)
  if (m.locked.includes(lower(id.address))) return same(m)
  // If the check was about to find another tab's new session, bootstrap meets
  // session_exists and adopts it through me, without a signature.
  const next: Machine = {
    ...m,
    epoch: m.epoch + 1,
    flow: { kind: 'bootstrap', address: id.address },
    view: { status: 'signing_in', step: 'bootstrap' },
    recheckPending: false,
  }
  const before: Effect[] = interrupting ? [{ type: 'abort_inflight' }] : []
  return { machine: next, effects: [...before, call(next, { route: 'bootstrap' })] }
}

function cancelSignIn(m: Machine): Step {
  if (m.view.status !== 'signing_in' || m.view.step === 'recovering' || m.view.step === 'closing') return same(m)
  // The wallet prompt cannot be closed from here, but its answer arrives under
  // an old epoch and is ignored, so nothing is ever verified with it.
  const next: Machine = { ...m, epoch: m.epoch + 1 }
  const step = abortLogin(next, { reason: 'signin_cancelled' })
  return { machine: step.machine, effects: [{ type: 'abort_inflight' }, ...step.effects] }
}

function signOut(m: Machine): Step {
  if (m.flow.kind !== 'idle') {
    if (m.view.status === 'signing_in') return cancelSignIn(m)
    // A Sign out click during a background me must not be lost: when that me
    // lands, the tab would show signed in again and the session would stay
    // open on the server. The check is abandoned and the sign-out runs now.
    if (backgroundCheck(m)) {
      const out = signOutIdle({ ...m, flow: IDLE, recheckPending: false })
      if (out.effects.length === 0) return same(m)
      const aborts = out.effects.some((e) => e.type === 'abort_inflight')
      return aborts ? out : { machine: out.machine, effects: [{ type: 'abort_inflight' }, ...out.effects] }
    }
    return same(m)
  }
  return signOutIdle(m)
}

function signOutIdle(m: Machine): Step {
  const v = m.view.status
  // 2026-10-01 (part B, G11): and a session kept while the wallet is on another of the registry's chains (moveChain).
  if (m.session && (v === 'signed_in' || v === 'other_session' || v === 'blocked' || v === 'wrong_network')) {
    const next: Machine = { ...m, epoch: m.epoch + 1 }
    const flow: LogoutFlow = {
      kind: 'logout',
      purpose: 'user',
      csrf: m.session.csrf,
      owner: m.session.owner,
      retried: false,
      after: { reason: 'logged_out' },
    }
    return logout(next, flow, { status: 'signing_out' }, [
      { type: 'abort_inflight' },
      { type: 'cancel_expiry' },
      { type: 'clear_private' },
    ])
  }
  if (v === 'other_session' || v === 'blocked') {
    // No CSRF in hand: read it back from me, then sign out with it.
    const next: Machine = { ...m, epoch: m.epoch + 1, flow: { kind: 'me', purpose: 'sign_out' }, view: { status: 'signing_out' } }
    return { machine: next, effects: [call(next, { route: 'me' })] }
  }
  return same(m)
}

function retry(m: Machine): Step {
  if (m.flow.kind !== 'idle' || m.view.status !== 'blocked') return same(m)
  if (m.view.retry === 'sign_out') return signOut(m)
  if (m.view.retry === 'check' && onRobinhood(m.identity)) {
    return checkSession({ ...m, epoch: m.epoch + 1 }, false, { status: 'checking' })
  }
  return same(m)
}

/** Expiry, a tab coming back into view, or another tab's sign-in or sign-out. */
function recheck(m: Machine): Step {
  if (!onRobinhood(m.identity)) return same(m)
  // Never dropped: a me already in flight may have been answered before
  // another tab's sign-out committed. The check runs again once this flow
  // ends (see runPendingRecheck).
  if (m.flow.kind !== 'idle') return m.recheckPending ? same(m) : same({ ...m, recheckPending: true })
  const v = m.view.status
  if (v !== 'signed_in' && v !== 'signed_out' && v !== 'other_session') return same(m)
  // The view stays as it is while the check runs; a recheck is not a sign-in.
  return checkSession(m, v === 'signed_in')
}

/**
 * Renews the idle deadline of the session this tab shows. Only from a resting
 * signed-in view for the connected account: never during another flow, never
 * for a session this tab does not show, never while signed out.
 */
function startRefresh(m: Machine): Step {
  const id = m.identity
  if (m.flow.kind !== 'idle' || m.view.status !== 'signed_in' || !m.session || !onRobinhood(id)) return same(m)
  if (m.session.owner !== lower(id.address)) return same(m)
  const next: Machine = { ...m, flow: { kind: 'refresh' } }
  return { machine: next, effects: [call(next, { route: 'refresh', csrf: m.session.csrf })] }
}

/** Another tab's refresh worked, so a failed renewal here is no longer news. */
function renewedElsewhere(m: Machine): Step {
  if (m.view.status !== 'signed_in' || m.view.notice === undefined) return same(m)
  return same({ ...m, view: { status: 'signed_in', owner: m.view.owner, expiresAt: m.view.expiresAt } })
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * A pre-signature step failed. Nothing was signed and nothing committed, so
 * the flow lands; the user starts again if they want to.
 */
function beforeSignature(m: Machine, address: string, failure: TransportFailure): Step {
  if (failure.kind === 'session_error') {
    switch (classify(failure.code)) {
      case 'session_exists':
        return adopt(m, address)
      case 'preauth_expired':
        return rest(m, 'preauth_expired')
      case 'csrf':
        return rest(m, 'signin_aborted')
      case 'challenge_rejected':
        return rest(m, 'challenge_expired')
    }
  }
  return stop(m, failure)
}

function afterBootstrap(m: Machine, address: string, o: RouteOutcome<'bootstrap'>): Step {
  if (!o.ok) return beforeSignature(m, address, o.failure)
  const csrf = o.body.csrfToken
  const next: Machine = { ...m, preauthCsrf: csrf, flow: { kind: 'challenge', address }, view: { status: 'signing_in', step: 'challenge' } }
  return {
    machine: next,
    effects: [call(next, { route: 'challenge', body: { address, chainId: ROBINHOOD_CHAIN_ID }, csrf })],
  }
}

function afterChallenge(m: Machine, address: string, o: RouteOutcome<'challenge'>, env: Env): Step {
  if (!o.ok) return beforeSignature(m, address, o.failure)
  const check = checkChallengeMessage(o.body.message, {
    origin: env.origin,
    address: env.checksum(address),
    chainId: ROBINHOOD_CHAIN_ID,
    expiresAt: o.body.expiresAt,
  })
  if (!check.ok) return abortLogin(m, { view: blocked('untrusted_challenge', 'none') })
  const next: Machine = {
    ...m,
    flow: { kind: 'sign', address, challengeId: o.body.challengeId, message: o.body.message },
    view: { status: 'signing_in', step: 'awaiting_signature' },
  }
  return { machine: next, effects: [{ type: 'sign', epoch: next.epoch, address, message: o.body.message }] }
}

function onSigned(m: Machine, flow: Extract<Flow, { kind: 'sign' }>, signature: string): Step {
  if (!m.preauthCsrf) return rest(m, 'signin_aborted')
  const next: Machine = { ...m, flow: { kind: 'verify', address: flow.address }, view: { status: 'signing_in', step: 'verifying' } }
  const body = { challengeId: flow.challengeId, message: flow.message, signature }
  return { machine: next, effects: [call(next, { route: 'verify', body, csrf: m.preauthCsrf })] }
}

function afterVerify(m: Machine, address: string, o: RouteOutcome<'verify'>): Step {
  if (o.ok) {
    if (o.body.owner.address === lower(address)) return signedIn(m, o.body, true, true)
    // The service signed in an address other than the one that signed. Close
    // the session it made and stop; this is producer drift, not a user error.
    const flow: LogoutFlow = {
      kind: 'logout',
      purpose: 'identity_change',
      csrf: o.body.csrfToken,
      owner: o.body.owner.address,
      retried: false,
      after: { view: blocked('contract_mismatch', 'none') },
    }
    return logout({ ...m, preauthCsrf: null }, flow, { status: 'signing_out' })
  }

  const failure = o.failure
  if (failure.kind === 'session_error') {
    switch (classify(failure.code)) {
      case 'challenge_rejected':
        return abortLogin(m, { reason: 'challenge_expired' })
      case 'signature_rejected':
        return abortLogin(m, { reason: 'signature_rejected' })
      // Also what a repeated verify gets once the first one committed: a
      // network stack that re-sends a POST whose connection closed empty
      // meets the consumed context. The abort still matches the consumed
      // context and revokes the session it created.
      case 'preauth_expired':
        return abortLogin(m, { reason: 'preauth_expired' })
      case 'csrf':
        return rest(m, 'signin_aborted')
      case 'session_exists':
        return adopt(m, address)
      case 'unsupported_account':
        return abortLogin({ ...m, locked: [...m.locked, lower(address)] }, { view: blocked('account_unsupported', 'none') })
    }
    // Any 5xx can follow a commit: the service answers with an error and no
    // cookie when its own response to the store's commit is lost or late.
    if (failure.status >= 500) return recoverVerify(m, address, { view: blockedFor(failure) }, true)
    return abortLogin(m, { view: blockedFor(failure) })
  }
  switch (failure.kind) {
    case 'network_error':
    case 'timeout':
    case 'aborted':
      return recoverVerify(m, address, { reason: 'lost_response' }, true)
    // A 200 that failed validation may still have set a cookie. Close anything
    // it created; do not adopt a session we could not read.
    case 'contract_mismatch':
    case 'runtime_error':
      return recoverVerify(m, address, { view: blockedFor(failure) }, false)
    // A 5xx without the contract header is the platform's, not the service's:
    // an edge error, a Worker crash or exceeded limits. It can come after the
    // session Worker forwarded verify and the store committed, and it looks
    // the same as a broken gate. Treat it as a lost response: me first, then
    // the preauth abort, which also revokes a session this context created.
    // Without the abort, the next bootstrap with the same preauth cookie
    // meets session_exists until the context lapses.
    case 'gate_unavailable':
      return recoverVerify(m, address, { view: blockedFor(failure) }, true)
    case 'not_routed':
      if (failure.status >= 500) return recoverVerify(m, address, { view: blockedFor(failure) }, true)
      return stop(m, failure)
    // A gate refusal never reached the store.
    default:
      return stop(m, failure)
  }
}

function afterMe(m: Machine, f: MeFlow, o: RouteOutcome<'me'>): Step {
  const id = m.identity
  const mine = o.ok && onRobinhood(id) && o.body.owner.address === lower(id.address)
  switch (f.purpose) {
    case 'restore': {
      const wipe: Effect[] = f.wasSignedIn ? [{ type: 'clear_private' }, { type: 'cancel_expiry' }] : []
      if (o.ok) return mine ? signedIn(m, o.body, false) : otherSession(m, o.body, wipe)
      if (sessionEnded(o.failure)) {
        // A check from signed out keeps the reason already on screen (a
        // declined signature, a sign-out): nothing changed for this tab.
        const view = f.wasSignedIn ? resting(m, 'session_ended') : m.view.status === 'signed_out' ? m.view : resting(m, 'none')
        return { machine: { ...m, flow: IDLE, session: null, view }, effects: wipe }
      }
      // Unavailable is not signed out: the session CSRF is kept so the user can
      // check again or sign out, but nothing private stays on screen meanwhile.
      return { machine: { ...m, flow: IDLE, view: blockedFor(o.failure) }, effects: wipe }
    }
    case 'adopt': {
      if (o.ok) return mine ? signedIn(m, o.body, false) : otherSession(m, o.body)
      return sessionEnded(o.failure) ? rest(m, 'signin_aborted') : stop(m, o.failure)
    }
    case 'recover_verify': {
      if (o.ok && o.body.owner.address === lower(f.address)) {
        if (f.adopt) return signedIn(m, o.body, true, true)
        const flow: LogoutFlow = {
          kind: 'logout',
          purpose: 'identity_change',
          csrf: o.body.csrfToken,
          owner: o.body.owner.address,
          retried: false,
          after: f.landing,
        }
        return logout({ ...m, preauthCsrf: null }, flow, { status: 'signing_in', step: 'closing' })
      }
      return abortLogin(m, f.landing)
    }
    case 'recover_logout': {
      // The logout was refused for its CSRF. If the session it meant to close
      // is the one this browser holds, close it with the CSRF me returned.
      // Anyone else's session is left alone.
      if (o.ok) {
        if (o.body.owner.address !== f.owner) return finishLogout(m, f.logout, f.after)
        const flow: LogoutFlow = {
          kind: 'logout',
          purpose: f.logout,
          csrf: o.body.csrfToken,
          owner: f.owner,
          retried: true,
          after: f.after,
        }
        return logout(m, flow, m.view)
      }
      return sessionEnded(o.failure) ? finishLogout(m, f.logout, f.after) : failLogout(m, f.logout, f.after)
    }
    case 'sign_out': {
      if (o.ok) {
        const flow: LogoutFlow = {
          kind: 'logout',
          purpose: 'user',
          csrf: o.body.csrfToken,
          owner: o.body.owner.address,
          retried: true,
          after: { reason: 'logged_out' },
        }
        return logout(m, flow, { status: 'signing_out' })
      }
      if (sessionEnded(o.failure)) return finishLogout(m, 'user', { reason: 'logged_out' })
      return same({ ...m, flow: IDLE, view: blocked('signout_unconfirmed', 'sign_out') })
    }
  }
}

/** The failures a refresh sits out: the session is kept and the refresh retried. */
function unavailable(failure: TransportFailure): boolean {
  switch (failure.kind) {
    case 'session_error': {
      const kind = classify(failure.code)
      return (
        kind === 'store_unavailable' ||
        kind === 'account_check_unavailable' ||
        kind === 'upstream' ||
        kind === 'timeout' ||
        kind === 'rate_limited'
      )
    }
    case 'network_error':
    case 'timeout':
    case 'aborted':
    case 'gate_unavailable':
      return true
    case 'not_routed':
      return failure.status >= 500
    default:
      return false
  }
}

function afterRefresh(m: Machine, o: RouteOutcome<'refresh'>): Step {
  const wipe: Effect[] = [{ type: 'clear_private' }, { type: 'cancel_expiry' }]
  if (o.ok) {
    const id = m.identity
    // Refresh answers for the session whose CSRF it carried. Another owner
    // would be producer drift: show where this browser stands, keep nothing.
    if (!onRobinhood(id) || o.body.owner.address !== lower(id.address)) return otherSession(m, o.body, wipe)
    // Same CSRF and absolute expiry, a fresh account check and a new idle
    // deadline. A different CSRF would be a different session and would get
    // its own scope, exactly as with me.
    const step = signedIn(m, o.body, false, true)
    return { machine: step.machine, effects: [...step.effects, { type: 'renewed' }] }
  }
  const failure = o.failure
  if (failure.kind === 'session_error') {
    switch (classify(failure.code)) {
      // Expired, idled out, logged out elsewhere or revoked by an operator.
      // Other tabs hold the same session, so they are told to look.
      case 'session_ended':
        return {
          machine: { ...m, flow: IDLE, session: null, view: resting(m, 'session_ended') },
          effects: [...wipe, { type: 'broadcast' }],
        }
      // The session CSRF did not match. Re-read me once for the session this
      // browser holds; the controller sends no further refresh for this
      // session, so a CSRF the service keeps refusing cannot loop. Never a
      // signature.
      case 'csrf': {
        const check = checkSession(m, true)
        return { machine: check.machine, effects: [{ type: 'refresh_failed', final: true, retryAfterS: null }, ...check.effects] }
      }
      // The fresh account check found contract code, and the service revoked
      // the session.
      case 'unsupported_account': {
        const locked = m.session ? [...m.locked, m.session.owner] : m.locked
        return {
          machine: { ...m, flow: IDLE, session: null, locked, view: blocked('account_unsupported', 'none') },
          effects: [...wipe, { type: 'broadcast' }],
        }
      }
    }
  }
  // An outage is not a sign-out: the session and its private data stay, the
  // view says the renewal failed, and the controller retries a few times.
  if (unavailable(failure)) {
    const view: View = m.view.status === 'signed_in' ? { ...m.view, notice: 'refresh_unavailable' } : m.view
    const retryAfterS = failure.kind === 'session_error' ? failure.retryAfterS : null
    return { machine: { ...m, flow: IDLE, view }, effects: [{ type: 'refresh_failed', final: false, retryAfterS }] }
  }
  // Anything else (the beta gate, a contract mismatch, this page's own
  // mistake, sign-in switched off) stops as a me check would.
  return {
    machine: { ...m, flow: IDLE, view: blockedFor(failure) },
    effects: [...wipe, { type: 'refresh_failed', final: true, retryAfterS: null }],
  }
}

function afterLogout(m: Machine, f: LogoutFlow, o: RouteOutcome<'logout'>): Step {
  if (o.ok) return finishLogout(m, f.purpose, f.after)
  const failure = o.failure
  if (failure.kind === 'session_error') {
    const kind = classify(failure.code)
    // Nothing left to sign out.
    if (kind === 'session_ended') return finishLogout(m, f.purpose, f.after)
    // Refused for its CSRF. After a verify response whose headers landed but
    // whose body did not, the browser holds the new session cookie and no
    // preauth cookie, so a preauth abort cannot match. Recover the session
    // CSRF from me and try once more; never more than once.
    if ((kind === 'csrf' || kind === 'preauth_expired') && !f.retried) {
      const next: Machine = { ...m, flow: { kind: 'me', purpose: 'recover_logout', logout: f.purpose, owner: f.owner, after: f.after } }
      return { machine: next, effects: [call(next, { route: 'me' })] }
    }
  }
  return failLogout(m, f.purpose, f.after)
}

function onResult(m: Machine, o: ApiOutcome, env: Env): Step {
  const f = m.flow
  switch (f.kind) {
    case 'bootstrap':
      return o.route === 'bootstrap' ? afterBootstrap(m, f.address, o) : same(m)
    case 'challenge':
      return o.route === 'challenge' ? afterChallenge(m, f.address, o, env) : same(m)
    case 'verify':
      return o.route === 'verify' ? afterVerify(m, f.address, o) : same(m)
    case 'me':
      return o.route === 'me' ? afterMe(m, f, o) : same(m)
    case 'logout':
      return o.route === 'logout' ? afterLogout(m, f, o) : same(m)
    case 'refresh':
      return o.route === 'refresh' ? afterRefresh(m, o) : same(m)
    default:
      return same(m)
  }
}

/**
 * A result for a flow that was abandoned. It never changes the view. A verify
 * that succeeded anyway created a session nobody will use, so it is revoked.
 */
function onStale(m: Machine, o: ApiOutcome): Step {
  if (o.route === 'verify' && o.ok) return { machine: m, effects: [{ type: 'cleanup_logout', csrf: o.body.csrfToken }] }
  return same(m)
}

export function reduce(m: Machine, e: Event, env: Env): Step {
  return runPendingRecheck(step(m, e, env))
}

/**
 * A recheck that waited for a flow runs as soon as the flow is idle, if the
 * landing is one a recheck applies to. Anything else (blocked, wrong network)
 * drops it: a recheck never retries a failure on its own.
 */
function runPendingRecheck(s: Step): Step {
  const m = s.machine
  if (!m.recheckPending || m.flow.kind !== 'idle') return s
  const cleared: Machine = { ...m, recheckPending: false }
  const check = recheck(cleared)
  return { machine: check.machine, effects: [...s.effects, ...check.effects] }
}

function step(m: Machine, e: Event, env: Env): Step {
  switch (e.type) {
    case 'identity':
      return onIdentity(m, e.identity, (env.chains ?? [ROBINHOOD_ID]).filter((id) => REGISTRY_CHAIN_IDS.includes(id)))
    case 'sign_in':
      return startSignIn(m)
    case 'cancel':
      return cancelSignIn(m)
    case 'sign_out':
      return signOut(m)
    case 'retry':
      return retry(m)
    case 'recheck':
      return recheck(m)
    case 'refresh':
      return startRefresh(m)
    case 'renewed_elsewhere':
      return renewedElsewhere(m)
    case 'unsupported_browser':
      return {
        machine: { ...m, flow: IDLE, view: blocked('browser_unsupported', 'none') },
        effects: [{ type: 'abort_inflight' }],
      }
    case 'result':
      return e.epoch === m.epoch ? onResult(m, e.outcome, env) : onStale(m, e.outcome)
    case 'request_refused':
      if (e.epoch !== m.epoch) return same(m)
      return abortLogin({ ...m, epoch: m.epoch }, { view: blocked('client_error', 'none') })
    case 'signed':
      return e.epoch === m.epoch && m.flow.kind === 'sign' ? onSigned(m, m.flow, e.signature) : same(m)
    case 'sign_failed':
      if (e.epoch !== m.epoch || m.flow.kind !== 'sign') return same(m)
      return abortLogin(m, { reason: e.reason === 'user_rejected' ? 'signature_declined' : 'wallet_error' })
  }
}
