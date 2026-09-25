/**
 * The read adapter's vocabulary.
 *
 * Every read goes through one interface, `ReadSource`, whichever source serves
 * it: the package fixtures, or the same-origin bridge. Both hand the same
 * `RawReply` to the same interpretation pipeline, so a fixture exercises the
 * real gate, header and validation order rather than skipping it.
 *
 * Response and request shapes are rugged97's generated types, imported in
 * place. Nothing here restates a field of the contract.
 */
import type {
  CacheObservation,
  ErrorResponse,
  ReadRequests as V1ReadRequests,
  ReadResponses as V1ReadResponses,
  Snapshot,
} from 'api-contracts/read-v1/types'
import type { CapabilitiesResponse as V2Capabilities, PoolAprEstimate } from 'api-contracts/read-v2/types'
import type { ReadV3Requests, ReadV3Responses } from 'api-contracts/read-v3/types'

/** Both namespaces expose the same flags; each wire validator requires its exact version. */
export type ReadResponses = Omit<V1ReadResponses, 'capabilities'> & Omit<ReadV3Responses, 'capabilities'> & { capabilities: V1ReadResponses['capabilities'] | V2Capabilities | ReadV3Responses['capabilities'] }
export type ReadRequests = V1ReadRequests & ReadV3Requests

/** Every read family across the three contracts, exactly the `ReadRequests` keys. */
export type ReadRoute = keyof ReadRequests
/** Those routes plus the bridge's capabilities GET, which has a response but no request body. */
export type ReadKey = keyof ReadResponses
export type RequestOf<R extends ReadKey> = R extends ReadRoute ? ReadRequests[R] : null
export type ErrorCode = ErrorResponse['error']

/**
 * The shared validators, satisfied structurally by the package runtime. They
 * are passed in rather than imported so the pure modules compile for node
 * tests; src/lib/read/contract.ts is the one place the app imports them.
 */
export interface ReadValidators {
  CONTRACT_VERSION: string
  ERROR_STATUS_BY_CODE: Readonly<Record<ErrorCode, number>>
  assertResponse<R extends keyof ReadResponses>(route: R, payload: unknown): ReadResponses[R]
  validateRequest<R extends ReadRoute>(route: R, payload: unknown): payload is ReadRequests[R]
  validateError(status: number, payload: unknown): payload is ErrorResponse
  /** Only after assertResponse accepted a v2 wrapper; never computes an APR. */
  poolAprEstimate?(payload: unknown): PoolAprEstimate | undefined
  matchesRequest?(route: ReadRoute, request: unknown, response: unknown): boolean
}

/** What a transport observed, before anything about it is believed. */
export type RawBody =
  | { kind: 'text'; text: string }
  /** Bigger than the bound; the rest was never read. */
  | { kind: 'too_large' }
  /** Not valid UTF-8. */
  | { kind: 'undecodable' }

export interface RawReply {
  status: number
  /** `fetch` with `redirect: 'manual'` saw a redirect, which it does not expose. */
  opaqueRedirect: boolean
  contentType: string | null
  /** `X-Domino-Read-Contract`. */
  contractHeader: string | null
  /** `X-Domino-Request-Id`, only in a shape requestId.ts accepts (a Worker UUID or a gateway's 32 lowercase hex), else null. */
  requestIdHeader: string | null
  retryAfterHeader: string | null
  body: RawBody
}

/** How the reply reached this app. Not where the data came from: see `Observation`. */
export interface Provenance {
  transport: 'fixture' | 'bridge'
  /** Package-relative fixture path, fixture transport only. */
  fixture?: string
  /** Support identifier from the Worker (a UUID) or, on the development lane, the gateway (32 lowercase hex). Never rendered as text. */
  requestId?: string
  /** The contract header as observed, null when absent. */
  contract: string | null
  /** Wall clock, ms (Date.now()), when this outcome was made. Orders retained results; never a data timestamp, never a deadline. */
  receivedAt: number
  /**
   * Monotonic clock, ms (`Clock.monotonic`), when this outcome was made: what
   * time on screen is counted from, since no wall-clock step moves it. Means
   * nothing outside this page, so it is never shown.
   */
  receivedMonotonic?: number
  attempts: number
  /** Monotonic clock, ms (`Clock.monotonic`), by which the logical read this belongs to had to settle (R-1). A restart keeps it. */
  deadlineAt?: number
}

/** A data provider named by the payload itself, with its own time. */
export interface ProviderObservation {
  /** Which part of the payload this is about, e.g. `market` or `pools[0].providerMetrics`. */
  scope: string
  provider: 'geckoterminal' | 'dexscreener' | 'alchemy' | 'alchemy_historical' | 'chainlink_robinhood_standard_v1'
  /** Unix seconds the provider was read, when the payload says. */
  retrievedAt: number | null
  cache?: CacheObservation
}

/** Freshness and origin, extracted from every successful payload. */
export interface Observation {
  /** Block the answer is pinned to. Null only for the catalogue, which covers an interval. */
  block: Snapshot | null
  revision?: number
  freshness?: { status: 'fresh' | 'stale'; ageSeconds: number; checkedAgainstHead?: number }
  /** Catalogue coverage: the configured interval it indexes, never complete history. */
  interval?: { startBlock: number; indexedThrough: number | null; coverage: 'configured_interval_only' }
  providers: ProviderObservation[]
}

/**
 * Why the site's own /api layer answered instead of the read bridge. The
 * first three are the /api forwarder's refusals (#80): no bridge bound, an
 * address it does not serve (a preview host, say), a request from a Worker
 * rather than a browser. `no_forwarder` is a deployment with no /api
 * function at all, whose static site answers a read with its index page.
 */
export type NotConnectedReason = 'bridge_unavailable' | 'not_found' | 'worker_subrequest_refused' | 'no_forwarder'

export type InvalidReason =
  | 'request_contract'
  | 'unrecognised_401'
  | 'not_json'
  | 'too_large'
  | 'invalid_json'
  | 'response_contract'
  | 'error_contract'
  | 'identity_mismatch'

export type UnavailableCause =
  | { kind: 'producer'; code: ErrorCode; status: number }
  /** fetch rejected: offline, DNS, reset. */
  | { kind: 'network' }
  /** A non-JSON reply with no contract header: an edge error page or no bridge mounted. */
  | { kind: 'edge'; status: number }
  /** This screen already has as many reads waiting as it may. */
  | { kind: 'queue_full' }
  /**
   * Stopped at one of R-1's deadlines: an attempt past its 20 s (`attempt`),
   * or the read past 60 s from enqueue, time queued included (`read`).
   * Anything that arrived after it was discarded.
   */
  | { kind: 'read_deadline'; limit: 'attempt' | 'read' }

/**
 * Why a market read carries no pool APR estimate: read-v2 is off on this
 * connection, its namespace could not be reached, its reply failed the
 * estimate contract this build carries (a read service on another release),
 * or the answer was served from the read service's stored snapshot, which
 * keeps no estimate.
 */
export type EstimateReason = 'estimate_not_enabled' | 'estimate_transport_unavailable' | 'estimate_contract_mismatch' | 'estimate_not_in_snapshot'

/**
 * Everything a read can come back as. Only `ok` carries data, and the data in
 * it has passed the package runtime and the identity checks. Every other state
 * carries nothing a screen could partly render.
 */
export type ReadOutcome<R extends ReadKey = ReadRoute> = { route: R; provenance: Provenance } & (
  | { state: 'ok'; data: ReadResponses[R]; observation: Observation; estimate?: PoolAprEstimate; estimateReason?: EstimateReason }
  /** 401 `{"error":"beta_access_required"}`: the invitation cookie is missing or expired. */
  | { state: 'gate_required' }
  /** 503 access page: the gate's own configuration is broken. */
  | { state: 'gate_unavailable' }
  /** A redirect, which is what Cloudflare Access answers with. */
  | { state: 'access_required' }
  | {
      state: 'incompatible'
      reason: 'contract_header_missing' | 'contract_version_not_accepted' | 'upstream_contract_mismatch'
    }
  | { state: 'invalid'; reason: InvalidReason }
  /** `retryable`: transient, so a person may try again. The pipeline never asks again on its own. */
  | { state: 'unavailable'; cause: UnavailableCause; retryable: boolean }
  /**
   * A validated 429 `read_capacity_busy`: the one answer the pipeline asks
   * again on its own, after its Retry-After, while the read has attempts and
   * time left. Shown, with the wait it asked for, once it has neither.
   */
  | { state: 'busy'; retryAfterSeconds: number }
  | { state: 'restart_required'; code: 'invalid_or_expired_cursor' | 'catalogue_revision_changed' }
  /** Any other 4xx: this app asked for something the bridge refuses. */
  | { state: 'request_rejected'; code: ErrorCode; status: number }
  | { state: 'disabled'; reason: 'live_data_disabled' | 'route_not_enabled' | 'bridge_data_mode_disabled' }
  /** Nothing was read: live data is not connected on this deployment. Never asked again on its own. */
  | { state: 'not_connected'; reason: NotConnectedReason }
  | { state: 'aborted' }
)

export type ReadState = ReadOutcome['state']
export type FailedOutcome<R extends ReadKey = ReadRoute> = Exclude<ReadOutcome<R>, { state: 'ok' }>

/** A failure moved onto another route, e.g. a capabilities refusal reported against the read that needed it. */
export const reroute = <R extends ReadKey>(failure: FailedOutcome<ReadKey>, route: R): FailedOutcome<R> =>
  ({ ...failure, route }) as FailedOutcome<R>

export interface ReadOptions {
  signal?: AbortSignal
  /**
   * Monotonic clock, ms (`Clock.monotonic`), by which the read must be
   * settled. The scheduler sets it at enqueue; a restart passes on its read's,
   * so the two share one budget. Never a Date.now() reading.
   */
  deadlineAt?: number
  /** Told as each attempt goes out, retries included, so a queue can pace from the last one. */
  onAttempt?: () => void
  /**
   * `first`: a queue starts this read before every queued read without it
   * (scheduler.ts), and among its own kind in order. The markets provider's
   * reads carry it (added 2026-09-25): the figures Home, its ticker and the
   * Markets table show wait for no card's price history.
   */
  priority?: 'first'
}

/**
 * Whether this page's capabilities list a route, asked without a read of its
 * own. `failed` carries what a read of that route would have come back as
 * instead: the gate, a forwarder refusal, live data switched off, an abort.
 */
export type RouteCheck =
  | { state: 'enabled' }
  | { state: 'not_enabled' }
  | { state: 'failed'; outcome: FailedOutcome<ReadRoute> }

export interface ReadSource {
  readonly transport: 'fixture' | 'bridge'
  /** This source has a separate V3 namespace adapter; not a deployment capability. */
  readonly supportsStoredReads?: true
  read<R extends ReadRoute>(route: R, request: ReadRequests[R], options?: ReadOptions): Promise<ReadOutcome<R>>
  /**
   * Whether the deployment lists `route`, from the source's one shared
   * capabilities answer: never queued, paced or posted, so a route that is
   * off costs a screen nothing, not even a place in the queue. Optional: a
   * source without it is never asked, and its screens read as if the route
   * were not listed.
   */
  routeEnabled?(route: ReadRoute, options?: Pick<ReadOptions, 'signal' | 'deadlineAt'>): Promise<RouteCheck>
}

declare const opaque: unique symbol
/**
 * A pagination handle from a validated reply. Branded so it can only come from
 * a pager, and held only inside one: never parsed, shown, stored or put in a URL.
 */
export type OpaqueCursor = string & { readonly [opaque]: true }

/** Curated artwork keys: the token files this app ships in public/tokens. */
export type ArtworkKey = 'ETH' | 'WETH' | 'USDG' | 'MARLIN' | 'UNI'

/**
 * A token as a screen may show it. Identity is chain plus address. `symbol` on
 * a read token is untrusted text: render it only as React text, never as
 * markup, an attribute, a URL or an artwork key.
 */
export type TokenDisplay =
  | {
      origin: 'read'
      chainId: 4663
      /** Lowercase. */
      address: string
      symbol: string | null
      decimals: number | null
      readStatus: 'available' | 'partial' | 'no_contract' | 'unavailable'
      /** From the curated address table only, never derived from the symbol. */
      artwork: ArtworkKey | null
    }
