/**
 * One same-origin JSON POST, observed but not yet believed: the transport the
 * onboarding previews (#38) and the deposit consumer's http transport share.
 *
 * The reply has the read adapter's `RawReply` shape, so the three interpreters
 * agree on field names; only the contract header differs per package. Like the
 * read bridge source it uses `redirect: 'manual'` (a redirect is Access or an
 * edge login, never data), `credentials: 'same-origin'` (the beta and session
 * cookies are the browser's business) and a bounded body read.
 */
import type { Clock } from '../clock'
import { parseSafeInteger } from '../raw'
import type { RawBody, RawReply } from '../read/types'

export type { RawBody, RawReply }

/** The gate's JSON refusal, byte for byte as functions/_middleware.ts sends it (same as read/interpret.ts). */
export const GATE_REFUSAL = '{"error":"beta_access_required"}'
/** Non-JSON bodies are only ever inspected for the gate's refusal. */
export const MAX_PAGE_BYTES = 16 * 1024
export const JSON_MEDIA = /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i
const REQUEST_ID = /^[0-9a-f-]{36}$/

/** The request options every private POST uses. */
export const REQUEST_INIT = {
  mode: 'same-origin',
  credentials: 'same-origin',
  redirect: 'manual',
  cache: 'no-store',
  referrerPolicy: 'same-origin',
} as const satisfies RequestInit

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export type TransportResult =
  | { kind: 'reply'; reply: RawReply }
  /** fetch rejected: offline, DNS, a reset connection. */
  | { kind: 'network' }
  /** This page's own deadline passed. */
  | { kind: 'timeout' }
  /** The caller aborted: an input, account, network or session change. */
  | { kind: 'aborted' }

export interface FetchRawOptions {
  contractHeader: string
  maxBytes: number
  timeoutMs: number
  signal?: AbortSignal
  clock: Clock
}

async function boundedBody(response: Response, limit: number): Promise<RawBody> {
  const declared = response.headers.get('Content-Length')
  if (declared !== null && (!/^\d{1,16}$/.test(declared) || BigInt(declared) > BigInt(limit))) {
    await response.body?.cancel().catch(() => undefined)
    return { kind: 'too_large' }
  }
  if (!response.body) return { kind: 'text', text: '' }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => undefined)
      return { kind: 'too_large' }
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return { kind: 'text', text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  } catch {
    return { kind: 'undecodable' }
  }
}

/** A fetch Response as the interpreters see it. */
export async function rawReplyOf(response: Response, contractHeader: string, maxBytes: number): Promise<RawReply> {
  const contentType = response.headers.get('Content-Type')
  const opaqueRedirect = response.type === 'opaqueredirect'
  const requestId = response.headers.get('X-Domino-Request-Id')
  const json = contentType !== null && /^application\/json\b/i.test(contentType)
  return {
    status: response.status,
    opaqueRedirect,
    contentType,
    contractHeader: response.headers.get(contractHeader),
    requestIdHeader: requestId !== null && REQUEST_ID.test(requestId) ? requestId : null,
    retryAfterHeader: response.headers.get('Retry-After'),
    body: opaqueRedirect ? { kind: 'text', text: '' } : await boundedBody(response, json ? maxBytes : MAX_PAGE_BYTES),
  }
}

/**
 * Sends one POST and reads its reply within `timeoutMs` of this page's own
 * clock. Never throws: every way it can end is a `TransportResult`.
 */
export async function fetchRaw(
  fetchImpl: FetchLike,
  url: string,
  init: { headers: Record<string, string>; body: string },
  options: FetchRawOptions,
): Promise<TransportResult> {
  const controller = new AbortController()
  let timedOut = false
  const cancelTimer = options.clock.setTimer(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs)
  const onAbort = () => controller.abort()
  if (options.signal?.aborted) controller.abort()
  else options.signal?.addEventListener('abort', onAbort, { once: true })
  const interrupted = (): TransportResult => ({ kind: timedOut ? 'timeout' : options.signal?.aborted ? 'aborted' : 'network' })
  try {
    let response: Response
    try {
      response = await fetchImpl(url, { ...REQUEST_INIT, method: 'POST', headers: init.headers, body: init.body, signal: controller.signal })
    } catch {
      return interrupted()
    }
    try {
      return { kind: 'reply', reply: await rawReplyOf(response, options.contractHeader, options.maxBytes) }
    } catch {
      return interrupted()
    }
  } finally {
    cancelTimer()
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * A reply without the package's contract header did not come from the
 * package's worker. Recognised in this order: the beta gate's 401 JSON, the
 * gate's 503 page, a missing route (404, 405, or the SPA's HTML fallback),
 * and anything else.
 */
export function classifyHeaderless(reply: RawReply): 'gate_required' | 'gate_unavailable' | 'feature_unavailable' | 'unrecognised' {
  const text = reply.body.kind === 'text' ? reply.body.text : null
  const json = reply.contentType !== null && /^application\/json\b/i.test(reply.contentType)
  if (reply.status === 401 && text === GATE_REFUSAL) return 'gate_required'
  if (reply.status === 503 && !json) return 'gate_unavailable'
  if (reply.status === 404 || reply.status === 405) return 'feature_unavailable'
  if (reply.status === 200 && reply.contentType !== null && /^text\/html\b/i.test(reply.contentType)) return 'feature_unavailable'
  return 'unrecognised'
}

/** `Retry-After` in whole seconds, 1 to 60; anything else means the contract's 60. */
export function parseRetryAfter(header: string | null): number {
  const seconds = header === null ? null : parseSafeInteger(header)
  return seconds !== null && seconds >= 1 && seconds <= 60 ? seconds : 60
}

/** The JSON body of a reply, or why there is none. */
export function jsonBody(reply: RawReply): { ok: true; value: unknown } | { ok: false; reason: 'not_json' | 'too_large' | 'invalid_json' } {
  if (reply.contentType === null || !JSON_MEDIA.test(reply.contentType)) return { ok: false, reason: 'not_json' }
  if (reply.body.kind === 'too_large') return { ok: false, reason: 'too_large' }
  if (reply.body.kind === 'undecodable') return { ok: false, reason: 'invalid_json' }
  try {
    return { ok: true, value: JSON.parse(reply.body.text) as unknown }
  } catch {
    return { ok: false, reason: 'invalid_json' }
  }
}
