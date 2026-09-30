// Candidate only: the owner authorized this dedicated destination after its
// Access app (27775e99-bcb8-48bd-b15c-777fe825d26f) was verified in the domain's
// account. No production cookie, arbitrary target or activation lives here.
import { createHash } from 'node:crypto'
import { CONTRACT_VERSION, validateResponse, validateError } from '../../api-contracts/read-v1/runtime.mjs'
import * as readV2 from '../../api-contracts/read-v2/runtime.mjs'
import * as readV3 from '../../api-contracts/read-v3/runtime.mjs'
import * as readV5 from '../../api-contracts/read-v5/runtime.mjs'
import { parseStrictJson } from '../../bridge/src/strict-json.mjs'
import { validateRequest } from '../../bridge/src/request-contract.mjs'
import { REQUEST_LIMIT, RESPONSE_LIMIT, DEADLINE_MS, READS, READS_V3, READS_V5, readRoute } from './local-live-boundary.mjs'
import { validateStatus } from './local-live-status.mjs'

const DESTINATION = 'https://dev-read.domino.money'
const CONTRACT = 'X-Domino-Read-Contract'
const errorReply = (status, code, version) => ({ status, payload: { error: code }, headers: { [CONTRACT]: version } })
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
/**
 * One read family per version, chosen by the route's own version and never by
 * the URL alone. A reply is validated by the contract it was asked under, and
 * a capabilities reply is checked against that version's routes: read-v1's ten
 * names would reject a perfectly good v3 ["overview","history","search"].
 */
const FAMILY = {
  v1: { version: CONTRACT_VERSION, reads: READS, validateResponse, validateRequest },
  v2: { version: readV2.CONTRACT_VERSION, reads: readV2.ENABLED_READS, validateResponse: readV2.validateResponse, validateRequest: readV2.validateRequest },
  v3: { version: readV3.CONTRACT_VERSION, reads: READS_V3, validateResponse: readV3.validateResponse, validateRequest: readV3.validateRequest },
  // read-v5 takes rc.1 and rc.2 while the VM moves to rc.2 (featured-policy v2, 2026-09-28), as the read Worker does.
  v5: { version: readV5.CONTRACT_VERSION, versions: readV5.CONTRACT_VERSIONS, reads: READS_V5, validateResponse: readV5.validateResponse, validateRequest: readV5.validateRequest },
}
/** The family a raw URL belongs to, for the replies sent before a route is resolved. */
const familyForUrl = (url) => url.startsWith('/api/read/v5/') ? FAMILY.v5 : url.startsWith('/api/read/v3/') ? FAMILY.v3
  : url.startsWith('/api/read/v2/') ? FAMILY.v2 : FAMILY.v1
/** Every key of a read-v2 pool-market reply, and nothing else. */
const ESTIMATE_REPLY_KEYS = ['chainId', 'estimate', 'executionAvailable', 'market', 'poolId', 'schemaVersion']
/**
 * A read-v2 pool-market reply this runtime refuses for its estimate alone, by
 * the rule the app's estimateValidators apply (src/lib/read/estimateSource.ts):
 * exactly the read-v2 envelope keys, schemaVersion 1, executionAvailable
 * false, an estimate object, and a market part that passes read-v1 on its own,
 * about the same pool and chain. A read service one release behind or ahead of
 * this checkout sends it (the dev reader on 85e7511 answers
 * protocol_fee_unsupported where this runtime derives an estimate). It goes to
 * the app unchanged, whose tolerant path keeps the market figures without the
 * estimate; any other refused reply stays refused.
 */
function refusedForEstimateOnly(payload) {
  if (!isRecord(payload)) return false
  const keys = Object.keys(payload).sort()
  if (keys.length !== ESTIMATE_REPLY_KEYS.length || keys.some((name, index) => name !== ESTIMATE_REPLY_KEYS[index])) return false
  if (payload.schemaVersion !== 1 || payload.executionAvailable !== false || !isRecord(payload.estimate)) return false
  if (!validateResponse('pool-market', payload.market)) return false
  return typeof payload.poolId === 'string' && payload.poolId.toLowerCase() === payload.market.poolId.toLowerCase() && payload.chainId === payload.market.chainId
}
function send(res, reply) {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(reply.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", ...reply.headers })
  res.end(JSON.stringify(reply.payload))
}
async function bounded(stream, limit, signal) {
  const chunks = []; let size = 0
  for await (const chunk of stream) {
    if (signal.aborted) throw new Error('deadline')
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > limit) throw new Error('size')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}
async function cancelledRace(work, signal) {
  let stop
  const cancelled = new Promise((_, reject) => { stop = () => reject(new Error('deadline')); signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop() })
  try { return await Promise.race([work, cancelled]) } finally { signal.removeEventListener('abort', stop) }
}

export function createLocalProxy({ credentials, statusSchema, fetchImpl = fetch, deadlineMs = DEADLINE_MS, frontend = { commit: 'unavailable', dirty: null } }) {
  if (!credentials?.clientId || !credentials?.clientSecret || !statusSchema) throw new Error('Private credentials and the canonical status schema are required.')
  let flight = null; let admitted = 0; let closed = false
  const secrets = [credentials.clientId, credentials.clientSecret]
  const frontendVersion = () => {
    let current
    try { current = typeof frontend === 'function' ? frontend() : frontend } catch { current = {} }
    return { commit: /^[0-9a-f]{40}$/.test(current.commit) ? current.commit : 'unavailable', dirty: typeof current.dirty === 'boolean' ? current.dirty : null }
  }
  async function upstream(operation, request, body) {
    const signal = operation.control.signal
    const version = FAMILY[request.version ?? 'v1'].version
    const error = (status, code) => errorReply(status, code, version)
    try {
      const response = await fetchImpl(`${DESTINATION}${request.path}`, {
        method: body ? 'POST' : 'GET', body, signal, redirect: 'manual', credentials: 'omit',
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}),
          [CONTRACT]: version, 'CF-Access-Client-Id': credentials.clientId, 'CF-Access-Client-Secret': credentials.clientSecret },
      })
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return error(502, 'upstream_invalid_response') }
      // Access HTML, headers and error text never reach the browser. Status
      // exposes only finite local states, not an inferred expiry/revocation cause.
      if ([401, 403].includes(response.status)) { await response.body?.cancel(); return request.route === 'status' ? { status: 403, payload: { state: 'access_rejected', frontend: frontendVersion() } } : error(503, 'upstream_unavailable') }
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) { await response.body?.cancel(); return error(502, 'upstream_invalid_response') }
      if (Number(response.headers.get('content-length')) > RESPONSE_LIMIT) { await response.body?.cancel(); return error(503, 'response_too_large') }
      let bytes
      try { bytes = await bounded(response.body ?? [], RESPONSE_LIMIT, signal) }
      catch (e) { await response.body?.cancel().catch(() => {}); return error(e.message === 'size' ? 503 : 504, e.message === 'size' ? 'response_too_large' : 'upstream_timeout') }
      let payload
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        if (secrets.some((value) => text.includes(value))) return error(502, 'upstream_invalid_response')
        payload = parseStrictJson(text)
        if (secrets.some((value) => JSON.stringify(payload).includes(value))) return error(502, 'upstream_invalid_response')
      } catch { return error(502, 'upstream_invalid_response') }
      const family = FAMILY[request.version ?? 'v1']
      const answered = response.headers.get(CONTRACT)
      if (!(family.versions ?? [version]).includes(answered)) return error(502, 'upstream_contract_mismatch')
      // Where two versions pass, a list names the one its header does.
      if (family.versions && response.status === 200 && payload?.contractVersion !== answered) return error(502, 'upstream_contract_mismatch')
      const valid = response.status === 200
        ? request.route === 'status' ? validateStatus(statusSchema, payload)
          : request.version === 'v2' ? readV2.validateResponse(request.route, payload) || (request.route === 'pool-market' && refusedForEstimateOnly(payload))
            : FAMILY[request.version ?? 'v1'].validateResponse(request.route, payload)
        : validateError(response.status, payload)
      if (!valid) return error(502, 'upstream_invalid_response')
      if (request.version === 'v2' && request.route === 'pool-market' && response.status === 200 && payload.poolId !== JSON.parse(body).poolId) return error(502, 'upstream_invalid_response')
      if (request.route === 'capabilities' && response.status === 200 && payload.enabledReads.some((name) => !FAMILY[request.version ?? 'v1'].reads.includes(name))) return error(502, 'upstream_invalid_response')
      const headers = { [CONTRACT]: answered }
      const id = response.headers.get('X-Domino-Request-Id')
      if (id && /^[0-9a-f]{32}$/.test(id) && !secrets.includes(id)) headers['X-Domino-Request-Id'] = id
      const retry = response.headers.get('Retry-After')
      if (retry && /^(?:[0-9]|[1-5][0-9]|60)$/.test(retry)) headers['Retry-After'] = retry
      return { status: response.status, headers, payload: request.route === 'status' && response.status === 200 ? { state: 'validated', frontend: frontendVersion(), backend: payload } : payload }
    } catch { return error(signal.aborted ? 504 : 503, signal.aborted ? 'upstream_timeout' : 'upstream_unavailable') }
  }
  const handler = async (req, res) => {
    const started = performance.now()
    const request = readRoute(req.url, req.method)
    const version = familyForUrl(req.url).version
    const error = (status, code) => errorReply(status, code, version)
    if (!request) { send(res, error(404, 'route_not_available')); return }
    if (closed) { send(res, error(503, 'upstream_unavailable')); return }
    if (admitted >= 8) { send(res, error(429, 'read_capacity_busy')); return }
    admitted++
    const control = new AbortController(); const timer = setTimeout(() => control.abort(), deadlineMs)
    const disconnected = () => control.abort(); res.once('close', disconnected)
    let operation
    try {
      let body
      if (req.headers['content-encoding'] || req.headers['transfer-encoding']) { send(res, error(415, 'json_required')); return }
      if (req.method === 'POST') {
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) { send(res, error(415, 'json_required')); return }
        if (Number(req.headers['content-length']) > REQUEST_LIMIT) { send(res, error(413, 'request_too_large')); return }
        try { body = await cancelledRace(bounded(req, REQUEST_LIMIT, control.signal), control.signal) }
        catch (e) { send(res, error(e.message === 'size' ? 413 : 408, e.message === 'size' ? 'request_too_large' : 'request_timeout')); return }
        let payload
        try { payload = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(body), { numberLexemes: true }) } catch { send(res, error(422, 'invalid_request')); return }
        if (!FAMILY[request.version ?? 'v1'].validateRequest(request.route, payload)) { send(res, error(422, 'invalid_request')); return }
      } else if (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0') { send(res, error(422, 'invalid_request')); return }
      if (control.signal.aborted) { send(res, error(504, 'upstream_timeout')); return }
      const key = createHash('sha256').update(req.url).update(body ?? '').digest('hex')
      if (flight && (flight.key !== key || flight.control.signal.aborted)) { send(res, error(429, 'read_capacity_busy')); return }
      if (!flight) {
        operation = { key, control: new AbortController(), readers: 0, promise: null }; flight = operation
        const operationTimer = setTimeout(() => operation.control.abort(), Math.max(0, deadlineMs - (performance.now() - started)))
        // Remains occupied until the transport settles, even if cancellation
        // is ambiguous. Remote admission additionally spans worktree/restarts.
        operation.promise = upstream(operation, request, body).finally(() => { clearTimeout(operationTimer); if (flight === operation) flight = null })
      } else operation = flight
      operation.readers++
      send(res, await cancelledRace(operation.promise, AbortSignal.any([control.signal, operation.control.signal])))
    } catch { send(res, error(504, 'upstream_timeout')) }
    finally {
      clearTimeout(timer); res.removeListener('close', disconnected); admitted--
      if (operation && --operation.readers === 0) operation.control.abort()
    }
  }
  handler.close = () => { closed = true; flight?.control.abort() }
  return handler
}
