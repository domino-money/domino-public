/**
 * The browser side of deposit-v1: all eight routes, with the same order of
 * interpretation as the previews (transport, header-less gate and route
 * replies, the exact pinned header, JSON and the 256 KiB bound, then the
 * package runtime or `validateError`).
 *
 * After the runtime accepts a response, the client binds it to the session:
 * `operation.owner`, and every list item's `owner`, must equal the signed-in
 * owner. The runtime cannot know the session, and a response with the owner
 * rewritten passes it, so this check is what keeps another account's deposit
 * off the screen. Any mismatch fails the whole response closed:
 * `contract('owner')`, nothing returned, nothing remembered.
 *
 * `create` is a typed method, tested here, with no call site in this phase.
 */
import { classifyHeaderless, jsonBody, parseRetryAfter, type TransportResult } from '../lib/http/rawReply'
import { SESSION_GONE, type SessionPort } from '../session/port'
import { MAX_REQUEST_BYTES, type DepositTransport } from './transport'
import type { DepositErrorCode, DepositRequests, DepositResponses, DepositRoute, DepositValidators } from './types'
import { DEPOSIT_CONTRACT } from './version'

export const DEPOSIT_ROUTES: readonly DepositRoute[] = ['create', 'get', 'list', 'prepare', 'report', 'reconcile', 'cancel', 'allowances']

export type ContractDetail =
  | 'version'
  | 'header_missing'
  | 'not_json'
  | 'too_large'
  | 'invalid_json'
  | 'response'
  | 'error_body'
  | 'owner'
  | 'redirect'
  | 'runtime'

export type DepositFailure =
  | { kind: 'error'; code: DepositErrorCode; status: number; retryAfterS?: number }
  | { kind: 'gate_required' }
  | { kind: 'gate_unavailable' }
  | { kind: 'not_deployed' }
  | { kind: 'contract'; detail: ContractDetail }
  | { kind: 'request_invalid' }
  | { kind: 'network' }
  | { kind: 'timeout' }
  | { kind: 'aborted' }
  | { kind: 'session_gone' }

export type DepositOutcome<R extends DepositRoute> =
  | { ok: true; route: R; data: DepositResponses[R] }
  | { ok: false; route: R; failure: DepositFailure }

export interface CallOptions {
  /** The session epoch the caller acted under; a different one sends nothing. */
  epoch: number
  signal?: AbortSignal
}

export interface DepositClient {
  readonly transportKind: DepositTransport['kind']
  create(body: DepositRequests['create'], options: CallOptions): Promise<DepositOutcome<'create'>>
  get(body: DepositRequests['get'], options: CallOptions): Promise<DepositOutcome<'get'>>
  list(body: DepositRequests['list'], options: CallOptions): Promise<DepositOutcome<'list'>>
  prepare(body: DepositRequests['prepare'], options: CallOptions): Promise<DepositOutcome<'prepare'>>
  report(body: DepositRequests['report'], options: CallOptions): Promise<DepositOutcome<'report'>>
  reconcile(body: DepositRequests['reconcile'], options: CallOptions): Promise<DepositOutcome<'reconcile'>>
  cancel(body: DepositRequests['cancel'], options: CallOptions): Promise<DepositOutcome<'cancel'>>
  allowances(body: DepositRequests['allowances'], options: CallOptions): Promise<DepositOutcome<'allowances'>>
}

const lower = (value: string) => value.toLowerCase()

/** Every owner the response names is the session's. */
export function ownedBy<R extends DepositRoute>(route: R, data: DepositResponses[R], sessionOwner: string): boolean {
  const owner = lower(sessionOwner)
  if (route === 'list') return (data as DepositResponses['list']).operations.every((item) => lower(item.owner) === owner)
  return lower((data as DepositResponses['get']).operation.owner) === owner
}

/** One reply (or the lack of one) as an outcome. Exported for the tests. */
export function interpretDeposit<R extends DepositRoute>(route: R, result: TransportResult, runtime: DepositValidators, sessionOwner: string): DepositOutcome<R> {
  const fail = (failure: DepositFailure): DepositOutcome<R> => ({ ok: false, route, failure })
  switch (result.kind) {
    case 'aborted':
      return fail({ kind: 'aborted' })
    case 'timeout':
      return fail({ kind: 'timeout' })
    case 'network':
      return fail({ kind: 'network' })
    case 'reply':
      break
  }
  const reply = result.reply
  if (reply.opaqueRedirect) return fail({ kind: 'contract', detail: 'redirect' })
  if (reply.contractHeader === null) {
    switch (classifyHeaderless(reply)) {
      case 'gate_required':
        return fail({ kind: 'gate_required' })
      case 'gate_unavailable':
        return fail({ kind: 'gate_unavailable' })
      case 'feature_unavailable':
        return fail({ kind: 'not_deployed' })
      case 'unrecognised':
        return fail({ kind: 'contract', detail: 'header_missing' })
    }
  }
  if (reply.contractHeader !== DEPOSIT_CONTRACT) return fail({ kind: 'contract', detail: 'version' })
  const body = jsonBody(reply)
  if (!body.ok) return fail({ kind: 'contract', detail: body.reason })
  try {
    if (reply.status === 200) {
      if (!runtime.validateResponse(route, body.value)) return fail({ kind: 'contract', detail: 'response' })
      const data = body.value as DepositResponses[R]
      if (!ownedBy(route, data, sessionOwner)) return fail({ kind: 'contract', detail: 'owner' })
      return { ok: true, route, data }
    }
    if (!runtime.validateError(reply.status, body.value)) return fail({ kind: 'contract', detail: 'error_body' })
  } catch {
    return fail({ kind: 'contract', detail: 'runtime' })
  }
  const code = (body.value as { error: DepositErrorCode }).error
  return fail({ kind: 'error', code, status: reply.status, ...(reply.status === 429 ? { retryAfterS: parseRetryAfter(reply.retryAfterHeader) } : {}) })
}

export function createDepositClient({ transport, runtime, session }: { transport: DepositTransport; runtime: DepositValidators; session: SessionPort }): DepositClient {
  async function call<R extends DepositRoute>(route: R, request: DepositRequests[R], { epoch, signal }: CallOptions): Promise<DepositOutcome<R>> {
    const fail = (failure: DepositFailure): DepositOutcome<R> => ({ ok: false, route, failure })
    let valid: boolean
    try {
      valid = DEPOSIT_ROUTES.includes(route) && runtime.validateRequest(route, request)
    } catch {
      valid = false
    }
    const body = JSON.stringify(request)
    if (!valid || new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) return fail({ kind: 'request_invalid' })
    const snapshot = session.getSnapshot()
    if (snapshot.kind !== 'signed_in' || snapshot.epoch !== epoch) return fail({ kind: 'session_gone' })
    const owner = snapshot.owner
    let result: TransportResult | typeof SESSION_GONE
    try {
      result = await session.withCsrf(epoch, (csrf) => transport.send(route, body, { csrf, signal }))
    } catch {
      result = { kind: 'network' }
    }
    if (result === SESSION_GONE) return fail({ kind: 'session_gone' })
    return interpretDeposit(route, result, runtime, owner)
  }

  return {
    transportKind: transport.kind,
    create: (body, options) => call('create', body, options),
    get: (body, options) => call('get', body, options),
    list: (body, options) => call('list', body, options),
    prepare: (body, options) => call('prepare', body, options),
    report: (body, options) => call('report', body, options),
    reconcile: (body, options) => call('reconcile', body, options),
    cancel: (body, options) => call('cancel', body, options),
    allowances: (body, options) => call('allowances', body, options),
  }
}
