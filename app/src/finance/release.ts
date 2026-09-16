import type { FetchLike } from '../lib/http/rawReply'
import { financialFetch } from './http'

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

async function boundedText(response: Response): Promise<string | null> {
  if (!response.body) return ''
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    size += chunk.value.byteLength
    if (size > MAX_BYTES) { await reader.cancel().catch(() => undefined); return null }
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
export async function readRelease<T>(path: ReleasePath, parse: (value: unknown) => T | null, get: FetchLike = financialFetch, timeoutMs = 10_000): Promise<ReleaseRead<T>> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs)
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
  }
}
