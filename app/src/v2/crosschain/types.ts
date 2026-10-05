/**
 * S2, deposit from another network (spec F7 §3): the crosschain-v1 vocabulary as the app holds it.
 *
 * The shapes are rugged97's generated crosschain-v1 types, imported in place (type-only, so nothing of the package
 * runs here). The runtime that validates them is injected (`CrosschainValidators`), as deposit/ does: only a future
 * contract.ts imports the real one, and the node tests pass api-contracts/crosschain-v1/runtime.mjs themselves.
 *
 * Nothing under src/v2/crosschain imports the session, the wallet or lib/http: the pure V2 modules stay outside the
 * wallet feature (tests/session.source-guard.test.mjs) and outside the consumer directories
 * (tests/consumer.guard.test.mjs GUARD-5). Where the client needs the session it takes a `CrosschainSession`, which
 * the PHASE B screen builds from session/port.ts.
 */
import type {
  Approval,
  Candidate,
  CrosschainErrorCode,
  CrosschainRequests,
  CrosschainResponses,
  CrosschainRoute,
  FeeMeasure,
  OriginChain,
  OriginToken,
  OriginsList,
  ProviderListing,
  QuotePlan,
  Recovery,
  StatusReport,
  Step,
  Transaction,
} from 'api-contracts/crosschain-v1/types'

export type {
  Approval,
  Candidate,
  CrosschainErrorCode,
  CrosschainRequests,
  CrosschainResponses,
  CrosschainRoute,
  FeeMeasure,
  OriginChain,
  OriginToken,
  OriginsList,
  ProviderListing,
  QuotePlan,
  Recovery,
  StatusReport,
  Step,
  Transaction,
}

export type Provider = Candidate['provider']
export type CandidateStatus = Candidate['status']
export type DepositState = StatusReport['state']
export type Transition = StatusReport['transition']
export type FeeStatus = FeeMeasure['status']
export type DestinationChainId = QuotePlan['request']['destinationChainId']

/** Relay, then Across: the order of `candidates[]` and of `providers[]` (XC README). */
export const PROVIDERS: readonly Provider[] = Object.freeze(['relay', 'across'])

/** Every tracking state, in the order the README's table lists them. */
export const DEPOSIT_STATES: readonly DepositState[] = Object.freeze([
  'awaiting_deposit',
  'pending',
  'filled',
  'refund_pending',
  'failed',
  'refunded',
  'refund_failed',
])

export const TERMINAL_STATES: readonly DepositState[] = Object.freeze(['filled', 'refunded'])

/**
 * The package runtime, satisfied structurally by api-contracts/crosschain-v1/runtime.mjs (its runtime.d.mts). The
 * runtime recomputes the decision, checks that every step reaches only the provider's pinned contract on the origin,
 * with an exact approval, and that tracking only moves forward (spec §3.2).
 */
export interface CrosschainValidators {
  readonly CONTRACT_VERSION: string
  readonly ROUTES: readonly CrosschainRoute[]
  readonly ERROR_STATUS_BY_CODE: Readonly<Record<CrosschainErrorCode, number>>
  validateRequest<R extends CrosschainRoute>(route: R, value: unknown): value is CrosschainRequests[R]
  validateResponse<R extends CrosschainRoute>(route: R, value: unknown): value is CrosschainResponses[R]
  validateError(status: number, value: unknown): value is { error: CrosschainErrorCode }
  /** The tracking rule: [state, transition] for an observation after the state last shown. */
  advance(previous: string | null, observed: string): [string, string]
}

/** The three codes a private route answers when it refuses the session (session/port.ts `DenialCode`, restated). */
export type CrosschainDenial = 'session_required' | 'csrf_invalid' | 'account_unsupported'

/**
 * What the client needs of the signed-in session, and nothing more. PHASE B builds it from session/port.ts:
 * `withCsrf: (fn) => port.withCsrf(epoch, fn).then((r) => (r === SESSION_GONE ? { lent: false } : { lent: true, value: r }))`
 * and `reportDenial: (code) => port.reportDenial(code, epoch)`.
 */
export interface CrosschainSession {
  /** Runs `send` with the CSRF lent for this one request; `lent: false` when that session is gone. */
  withCsrf<T>(send: (csrf: string) => Promise<T>): Promise<{ lent: true; value: T } | { lent: false }>
  /** A route refused the session. The page's session flow takes it from there; it never leads to a signature. */
  reportDenial(code: CrosschainDenial): void
}

/** Monotonic time and timers, structurally lib/clock.ts's `Clock` (not imported: see the header). */
export interface CrosschainClock {
  /** Monotonic milliseconds. Durations only; never compared with a server timestamp. */
  monoMs(): number
  /** Runs `callback` after `ms`; returns a function that cancels it. */
  setTimer(callback: () => void, ms: number): () => void
}

/** What the page knows about a token on a chain: symbol (untrusted text) and decimals, either possibly unknown. */
export interface TokenInfo {
  symbol: string | null
  decimals: number | null
}

/** Looks a token up by chain and address (lowercase); null when the page knows nothing about it. */
export type TokenBook = (chainId: number, address: string) => TokenInfo | null

/** A chain's name as this flow says it, or null when the page does not know the chain. */
export type ChainNames = (chainId: number) => string | null
