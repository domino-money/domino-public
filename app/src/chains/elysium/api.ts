/**
 * rugged97's two Uniswap v3 services, as this site reaches them (2026-10-01, the chain2 workstream, audit items G7, G8
 * and G9): uniswap-v3-read-v1 (capabilities, discover-pool, pool, position, ledger, history) and uniswap-v3-actions-v1
 * (capabilities, inspect, prepare, receipt), both behind this site's own route /uniswap-v3/{read,actions}/v1/<route>
 * (functions/_lib/uniswap-v3/handler.ts, routed in part B), which forwards to his bridge Worker through a service binding,
 * and answers 404 not_enabled until then.
 *
 * His closed-schema semantics are kept exactly by running his own runtimes, vendored byte for byte under
 * functions/_lib/uniswap-v3/contracts/ at commit 7d190690 and pinned by the SHA-256 his manifests record
 * (tests/elysium-api.test.mjs). They are handed in (`runtimes`), so this module stays pure and Node-testable; the
 * section's entry hands in the vendored modules. Like his own client (app/src/elysium/client.ts on his branch), every
 * request is checked before it is sent and every answer before it is used: the contract version and manifest digest in
 * both directions, JSON within 256 KiB, strictly UTF-8, his runtime's validation against the expected deployment
 * identity, and his error envelope on a refusal. An answer of the private rehearsal lane or of a local fixture is
 * refused, as his public Worker refuses it: neither may reach a public page.
 *
 * The network call is handed in (`send`): one same-origin request, with the site's own cookie for the beta gate (the
 * route removes every cookie and credential before forwarding), no redirect, no cache. Nothing is kept anywhere.
 */
import type { Draft, Identity as ActionsIdentity, Requests as ActionsRequests, Responses as ActionsResponses } from '../../../functions/_lib/uniswap-v3/contracts/uniswap-v3-actions-v1/types'
import type { Identity, Requests as ReadRequests, Responses as ReadResponses } from '../../../functions/_lib/uniswap-v3/contracts/uniswap-v3-read-v1/types'

export type { Identity }

/** The site's route prefix for both services. */
export const API_PREFIX = '/uniswap-v3/'
/** The most bytes one answer may have (his client's and Worker's bound). */
export const MAX_ANSWER_BYTES = 262_144
/** One request's own deadline (his client's). */
export const REQUEST_TIMEOUT_MS = 20_000

export type Family = 'read' | 'actions'

/** One same-origin request to the site's /uniswap-v3/ routes. */
export type ApiSend = (path: string, init: RequestInit) => Promise<Response>

/** What this client needs of one of his runtimes (runtime.mjs). */
export interface ContractRuntime {
  readonly CONTRACT_VERSION: string
  readonly ROUTES: readonly string[]
  validateRequest(route: string, value: unknown, expected?: Identity): boolean
  validateResponse(route: string, value: unknown, expected?: Identity): boolean
  validateError(status: number, value: unknown): boolean
}

export interface ActionsRuntime extends ContractRuntime {
  verifyDraft(draft: Draft): Promise<boolean>
}

/** A contract's pin (pin.json): its version and the SHA-256 of its manifest's bytes. */
export interface ContractPin {
  readonly contract: string
  readonly contractVersion: string
  readonly manifestSha256: string
}

export interface Runtimes {
  readonly read: { readonly runtime: ContractRuntime; readonly pin: ContractPin }
  readonly actions: { readonly runtime: ActionsRuntime; readonly pin: ContractPin }
}

export type ServiceFailure =
  /** This site has no route to the service yet (404 not_enabled). */
  | 'not-enabled'
  /** No answer, a timeout, the site's own 503, a gateway's page. */
  | 'unreachable'
  /** His service refused the request (his error envelope: `code`). */
  | 'refused'
  /** An answer that is not his contract's: wrong version or digest, bad JSON, too large, invalid. */
  | 'invalid'
  /** Nobody wants the answer any more. */
  | 'aborted'

export class ServiceError extends Error {
  constructor(
    readonly kind: ServiceFailure,
    readonly code: string | null,
    message: string,
  ) {
    super(message)
    this.name = 'ServiceError'
  }
}

const JSON_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i
const header = (family: Family) => `X-Domino-Uniswap-V3-${family === 'read' ? 'Read' : 'Actions'}-Contract`

/** A signal that aborts when either does; `drop()` lets go of both. */
function either(a: AbortSignal | undefined, b: AbortSignal): { signal: AbortSignal; drop: () => void } {
  if (!a) return { signal: b, drop: () => undefined }
  const controller = new AbortController()
  const abort = () => controller.abort(a.aborted ? a.reason : b.reason)
  const drop = () => {
    a.removeEventListener('abort', abort)
    b.removeEventListener('abort', abort)
  }
  if (a.aborted || b.aborted) abort()
  else {
    a.addEventListener('abort', abort, { once: true })
    b.addEventListener('abort', abort, { once: true })
  }
  return { signal: controller.signal, drop }
}

function deadline(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms)
  const controller = new AbortController()
  setTimeout(() => controller.abort(new DOMException('The request took too long', 'TimeoutError')), ms)
  return controller.signal
}

/** An answer's body as text, read no further than MAX_ANSWER_BYTES, strictly UTF-8; null past the bound. */
async function bounded(response: Response): Promise<string | null> {
  const declared = response.headers.get('Content-Length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_ANSWER_BYTES)) return null
  if (!response.body) {
    const text = await response.text()
    return new TextEncoder().encode(text).byteLength > MAX_ANSWER_BYTES ? null : text
  }
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_ANSWER_BYTES) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    parts.push(value)
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const part of parts) {
    bytes.set(part, at)
    at += part.byteLength
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

export interface V3Api {
  read<R extends keyof ReadRequests>(route: R, body: ReadRequests[R], identity: Identity | undefined, signal?: AbortSignal): Promise<ReadResponses[R]>
  actions<R extends keyof ActionsRequests>(route: R, body: ActionsRequests[R], identity: ActionsIdentity | undefined, signal?: AbortSignal): Promise<ActionsResponses[R]>
  readonly runtimes: Runtimes
}

export function createV3Api(send: ApiSend, runtimes: Runtimes, timeoutMs = REQUEST_TIMEOUT_MS): V3Api {
  async function request(family: Family, route: string, body: object, identity: Identity | undefined, signal?: AbortSignal): Promise<unknown> {
    const { runtime, pin } = runtimes[family]
    if (pin.contractVersion !== runtime.CONTRACT_VERSION || !runtime.ROUTES.includes(route)) throw new ServiceError('invalid', null, 'contract_pin_mismatch')
    // Capabilities may be asked with no identity (it is how the identity is learned); every other route names the
    // deployment it expects, and his runtime refuses a well-formed answer from any other (wrong data, not just shape).
    const expected = identity
    if (route !== 'capabilities' && !expected) throw new ServiceError('invalid', null, 'identity_required')
    if (!runtime.validateRequest(route, body, expected)) throw new ServiceError('invalid', null, 'invalid_request')
    const name = header(family)
    const joined = either(signal, deadline(timeoutMs))
    let response: Response
    let text: string | null
    try {
      response = await send(`${API_PREFIX}${family}/v1/${route}`, {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        signal: joined.signal,
        headers: { 'Content-Type': 'application/json', [name]: pin.contractVersion, [`${name}-Digest`]: pin.manifestSha256 },
        body: JSON.stringify(body),
      })
      text = JSON_TYPE.test(response.headers.get('Content-Type') ?? '') ? await bounded(response) : null
    } catch (error) {
      if (signal?.aborted) throw new ServiceError('aborted', null, 'aborted')
      throw new ServiceError('unreachable', null, error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'unreachable')
    } finally {
      joined.drop()
    }
    let value: unknown
    try {
      value = text === null ? undefined : JSON.parse(text)
    } catch {
      value = undefined
    }
    const pinned = response.headers.get(name) === pin.contractVersion && response.headers.get(`${name}-Digest`) === pin.manifestSha256
    const code = value !== null && typeof value === 'object' && typeof (value as { error?: unknown }).error === 'string' ? (value as { error: string }).error : null
    if (!response.ok) {
      // This site's own answers carry no contract header: the route is not enabled, or the binding failed.
      if (!pinned) {
        if (response.status === 404 && code === 'not_enabled') throw new ServiceError('not-enabled', code, 'not_enabled')
        throw new ServiceError('unreachable', code, `http_${response.status}`)
      }
      if (!runtime.validateError(response.status, value)) throw new ServiceError('invalid', null, 'invalid_error')
      throw new ServiceError('refused', code, code ?? 'refused')
    }
    if (!pinned) throw new ServiceError('invalid', null, 'contract_changed')
    if (value === undefined) throw new ServiceError('invalid', null, 'invalid_answer')
    if (!runtime.validateResponse(route, value, expected)) throw new ServiceError('invalid', null, 'invalid_answer')
    const answer = value as { qualification?: unknown; rehearsalWalletActionsAvailable?: unknown; localWalletActionsAvailable?: unknown }
    // His public Worker never lets these through; neither does this page (his rehearsal lane is private, his fixture local).
    if (answer.qualification === 'testnet-rehearsal' || answer.rehearsalWalletActionsAvailable === true) throw new ServiceError('invalid', null, 'private_rehearsal_only')
    if (answer.qualification === 'local-fixture' || answer.localWalletActionsAvailable === true) throw new ServiceError('invalid', null, 'local_fixture_only')
    return value
  }

  return {
    runtimes,
    read: (route, body, identity, signal) => request('read', route, body, identity, signal) as never,
    actions: (route, body, identity, signal) => request('actions', route, body, identity, signal) as never,
  }
}
