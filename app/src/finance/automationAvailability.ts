import type { ExecutionError, ExecutionResponses } from 'api-contracts/execution-v1/types'
import type { SessionPort } from '../session/port'
import { SESSION_GONE } from '../session/port'
import { boundedText } from './release'

type Runtime = { CONTRACT_VERSION: string; validateResponse(route: 'availability', value: unknown): value is ExecutionResponses['availability'];
  validateError(status: number, value: unknown): value is ExecutionError }

/** A private, owner-bound service heartbeat. A refusal always closes Resume. */
export async function automationAvailable(owner: `0x${string}`, vault: `0x${string}`,
  port: SessionPort, fetcher: (url: string, init: RequestInit) => Promise<Response>, runtime: Runtime,
  wallMs: () => number = Date.now): Promise<boolean> {
  return (await automationReadyUntil(owner, vault, port, fetcher, runtime, wallMs)) !== null
}

/**
 * The same heartbeat, with how long its "ready" holds: the wall-clock time (ms) of the service's own expiresAtEpoch,
 * which the contract puts at most 10 seconds after its check, or null for any refusal. A Turn on shown on this answer
 * goes away when it expires unless a newer one arrived (lib/automate/switchGate.ts; the review of 2026-09-25).
 */
export async function automationReadyUntil(owner: `0x${string}`, vault: `0x${string}`,
  port: SessionPort, fetcher: (url: string, init: RequestInit) => Promise<Response>, runtime: Runtime,
  wallMs: () => number = Date.now): Promise<number | null> {
  const session = port.getSnapshot()
  if (session.kind !== 'signed_in' || session.owner !== owner || session.chainId !== 4663 || !port.csrfAccess) return null
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await port.withCsrf(session.epoch, csrf => fetcher('/api/execution/v1/availability', {
      method: 'POST', cache: 'no-store', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json',
        'X-Domino-Execution-Contract': runtime.CONTRACT_VERSION, 'X-Domino-CSRF': csrf },
      body: JSON.stringify({ vault }),
    }))
    if (response === SESSION_GONE || controller.signal.aborted
        || response.headers.get('X-Domino-Execution-Contract') !== runtime.CONTRACT_VERSION) return null
    if (response.status !== 200 && response.status !== 401 && response.status !== 403) return null
    const body = await boundedText(response, 2048)
    if (body === null) return null
    const data: unknown = JSON.parse(body)
    if (response.status !== 200) {
      if (runtime.validateError(response.status, data)
          && (data.error === 'session_required' || data.error === 'csrf_invalid' || data.error === 'account_unsupported'))
        port.reportDenial(data.error, session.epoch)
      return null
    }
    if (!runtime.validateResponse('availability', data) || data.owner !== owner || data.vault !== vault
        || data.operational !== true) return null
    const now = Math.floor(wallMs() / 1000)
    const current = port.getSnapshot()
    return data.checkedAtEpoch >= now - 5 && data.checkedAtEpoch <= now + 5
      && data.expiresAtEpoch > now && current.kind === 'signed_in'
      && current.epoch === session.epoch && current.owner === owner ? data.expiresAtEpoch * 1000 : null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}
