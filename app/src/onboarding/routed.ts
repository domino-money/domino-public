/**
 * One route decision for Create position's current Review. No timer retry,
 * signature or persistent state: the caller owns when to ask again and must
 * recheck the returned session key and monotonic deadline before offering it.
 */
import type { Clock } from '../lib/clock'
import { SESSION_GONE, sessionKey, type SessionPort } from '../session/port'
import type { PreviewBudget } from './budget'
import type { OnboardingClient } from './client'
import { previewDeadlineMono } from './expiry'
import type { SwapRoutePreview, SwapRouteRequest } from './types'

export interface SwapRouteDeps {
  client: OnboardingClient
  port: SessionPort
  clock: Clock
  budget: PreviewBudget
}

export type SwapRouteResult =
  | { ok: true; preview: SwapRoutePreview; deadlineMono: number; sessionKey: string }
  | { ok: false; reason: 'aborted' | 'session' | 'budget' | 'expired' | 'unavailable' }

/** Failure means use the existing pool path; an abort means discard the whole old Review. */
export async function requestSwapRoute(
  { client, port, clock, budget }: SwapRouteDeps,
  request: SwapRouteRequest,
  { owner, signal }: { owner: string; signal?: AbortSignal },
): Promise<SwapRouteResult> {
  if (signal?.aborted) return { ok: false, reason: 'aborted' }
  const session = port.getSnapshot()
  const key = sessionKey(session)
  if (session.kind !== 'signed_in' || !key || !port.csrfAccess || session.owner.toLowerCase() !== owner.toLowerCase()) {
    return { ok: false, reason: 'session' }
  }
  if (!budget.check().ok) return { ok: false, reason: 'budget' }
  const sent = { ...request, poolKey: { ...request.poolKey } }
  const abort = new AbortController()
  const cancel = () => abort.abort()
  const unsubscribe = port.subscribe(() => {
    if (sessionKey(port.getSnapshot()) !== key) cancel()
  })
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    // A port may have changed while the subscription was being installed.
    if (signal?.aborted || sessionKey(port.getSnapshot()) !== key) cancel()
    if (abort.signal.aborted) return { ok: false, reason: 'aborted' }
    const sentMono = clock.monoMs()
    budget.spend()
    const result = await port.withCsrf(session.epoch, (csrf) =>
      client.preview('swap-route', sent, { csrf, sessionOwner: session.owner, signal: abort.signal }),
    )
    if (abort.signal.aborted || sessionKey(port.getSnapshot()) !== key) return { ok: false, reason: 'aborted' }
    if (result === SESSION_GONE) return { ok: false, reason: 'session' }
    if (!result.ok) {
      if ('aborted' in result) return { ok: false, reason: 'aborted' }
      if (result.failure.kind === 'rate_limited') budget.cooldown(result.failure.retryAfterS ?? 60)
      if ('denial' in result.failure && result.failure.denial) port.reportDenial(result.failure.denial, session.epoch)
      return { ok: false, reason: 'unavailable' }
    }
    const receivedMono = clock.monoMs()
    const deadlineMono = previewDeadlineMono(result.preview, sentMono, receivedMono)
    if (deadlineMono <= receivedMono) return { ok: false, reason: 'expired' }
    return { ok: true, preview: result.preview, deadlineMono, sessionKey: key }
  } catch {
    return { ok: false, reason: abort.signal.aborted ? 'aborted' : 'unavailable' }
  } finally {
    signal?.removeEventListener('abort', cancel)
    unsubscribe()
  }
}
