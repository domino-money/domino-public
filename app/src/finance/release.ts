import { financialFetch } from './http.js'

/** The Worker-local setup and sequence release profiles: public GETs, no wallet, no session. */
export const RELEASE_CONTRACT = '1.0.0-rc.1'
const MAX_BYTES = 8192

export type ReleasePath = '/api/setup/v1/release' | '/api/setup/v1/sequence-release'

export type ReleaseRead<T> =
  | { kind: 'available'; deployment: T }
  /**
   * Published as unavailable, refused (403, 404, 503), not routed, behind the
   * gate, unreadable or unanswered. `reason` is a closed code for titles and
   * data attributes only; the screens never print it.
   */
  | { kind: 'unavailable'; reason: string }

export async function boundedText(response: Response, maxBytes = MAX_BYTES): Promise<string | null> {
  if (!response.body) return ''
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    size += chunk.value.byteLength
    if (size > maxBytes) { await reader.cancel().catch(() => undefined); return null }
    chunks.push(chunk.value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return null }
}

/**
 * One bounded same-origin GET of a release profile. `parse` is the screen's
 * strict profile parser: null for `available: false`, a thrown code for
 * anything malformed or expired. Never throws itself.
 */
export async function readRelease<T>(path: ReleasePath, parse: (value: unknown) => T | null, get: typeof financialFetch = financialFetch, timeoutMs = 10_000, signal?: AbortSignal): Promise<ReleaseRead<T>> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs)
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const unavailable = (reason: string): ReleaseRead<T> => ({ kind: 'unavailable', reason })
  try {
    let response: Response
    try {
      response = await get(path, { signal: controller.signal, cache: 'no-store', redirect: 'error', headers: { 'X-Domino-Setup-Contract': RELEASE_CONTRACT } })
    } catch {
      return unavailable(controller.signal.aborted ? 'timeout' : 'network')
    }
    if (response.headers.get('X-Domino-Setup-Contract') !== RELEASE_CONTRACT) {
      // Not the release Worker: the gate, a family without a binding, or the page fallback.
      await response.body?.cancel().catch(() => undefined)
      return unavailable(response.status === 401 ? 'gate_required' : response.status === 503 ? 'bridge_unavailable' : 'route_missing')
    }
    const text = await boundedText(response)
    if (text === null) return unavailable('invalid_release')
    let value: unknown
    try { value = JSON.parse(text) } catch { return unavailable('invalid_release') }
    if (response.status !== 200) {
      const code = value && typeof value === 'object' ? (value as { error?: unknown }).error : undefined
      return unavailable(typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? code : `status_${response.status}`)
    }
    try {
      const deployment = parse(value)
      return deployment === null ? unavailable('release_not_available') : { kind: 'available', deployment }
    } catch (error) {
      return unavailable(error instanceof Error && /^[a-z_]{1,64}$/.test(error.message) ? error.message : 'invalid_release')
    }
  } catch {
    return unavailable('network')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

/** Display admission only. Every financial press still reads and validates the release afresh. */
const RELEASE_KEEP_MS = 60_000
const RELEASE_RETRY_MS = [2_000, 10_000, 30_000] as const
// A 429 is not retried here: this tiny release reader does not consume Retry-After, so it must not shorten it.
const TRANSIENT_RELEASE = new Set(['network', 'timeout', 'bridge_unavailable', 'upstream_unavailable', 'status_502', 'status_503', 'status_504'])
interface ReleaseWatchPorts {
  now(): number
  visible(): boolean
  later(fn: () => void, ms: number): () => void
  visibility(fn: () => void): () => void
}
const watchPorts: ReleaseWatchPorts = {
  now: Date.now,
  visible: () => !document.hidden,
  later: (fn, ms) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer) },
  visibility: (fn) => { document.addEventListener('visibilitychange', fn); return () => document.removeEventListener('visibilitychange', fn) },
}

/**
 * One public GET shared by mounted views. A passing outage gets three bounded retries, not a permanent disabled
 * screen. Returning to the tab starts a fresh read window. Refusals/contracts stay closed; no financial request is
 * retried here. Hidden/unmounted views cancel pending work, and a late answer cannot replace a newer one.
 */
export function createReleaseWatch<T>(read: (signal: AbortSignal) => Promise<ReleaseRead<T>>, ports: ReleaseWatchPorts = watchPorts) {
  const listeners = new Set<(value: ReleaseRead<T>) => void>()
  let value: ReleaseRead<T> | null = null, at = -Infinity, retries = 0
  let pending: AbortController | null = null, cancel: (() => void) | null = null, unwatch: (() => void) | null = null
  function stopWork() {
    cancel?.(); cancel = null
    pending?.abort(); pending = null
  }
  function plan(ms: number) {
    cancel?.()
    if (!ports.visible() || !listeners.size) return
    cancel = ports.later(() => { cancel = null; void ask() }, ms)
  }
  async function ask() {
    if (!listeners.size || !ports.visible() || pending) return
    cancel?.(); cancel = null
    const mine = new AbortController()
    pending = mine
    const answer = await read(mine.signal).catch((): ReleaseRead<T> => ({ kind: 'unavailable', reason: 'network' }))
    if (mine.signal.aborted || pending !== mine) return
    pending = null; value = answer; at = ports.now()
    for (const listener of listeners) listener(answer)
    if (answer.kind === 'available') { retries = 0; plan(RELEASE_KEEP_MS) }
    else if (TRANSIENT_RELEASE.has(answer.reason) && retries < RELEASE_RETRY_MS.length) plan(RELEASE_RETRY_MS[retries++])
  }
  function wake() {
    if (!ports.visible()) { stopWork(); return }
    retries = 0
    if (value?.kind !== 'available' || ports.now() - at >= RELEASE_KEEP_MS) void ask()
    else plan(RELEASE_KEEP_MS - (ports.now() - at))
  }
  return (listener: (value: ReleaseRead<T>) => void) => {
    listeners.add(listener)
    if (value) listener(value)
    if (listeners.size === 1) { unwatch = ports.visibility(wake); wake() }
    return () => {
      listeners.delete(listener)
      if (!listeners.size) { stopWork(); unwatch?.(); unwatch = null }
    }
  }
}
