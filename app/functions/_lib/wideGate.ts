/**
 * The site-wide gate for wide log scans (rugged97's rule 1: at most 10 a second and 4 at once for the whole site), as the
 * chain routes' transport asks it (localRpc.ts LocalRpcOptions.siteGate). Added 2026-10-02 (review of the rules, finding
 * 2): the transport's own pace (LOCAL_RPC_WIDE) is per isolate; this one is the site's, a Durable Object every isolate
 * asks, in its own Worker (bridge/src/wide-gate-worker.mjs, domino-wide-gate), reached through the Pages binding
 * WIDE_GATE once the owner deploys it and binds it (RPC-SPEC §11.5). Without the binding the isolate's own pace alone
 * holds, as before.
 *
 * The gate answers within SITE_GATE_TIMEOUT_MS or not at all: a gate that cannot be asked (away, slow, an answer of
 * another shape) is let alone for SITE_GATE_REST_MS, and meanwhile the isolate's own pace alone holds, so a scan is never
 * refused for the gate's sake. Nothing of a visitor or a request goes to it: the blocks a scan covers, and the wait the
 * transport can still give it.
 */

/** The part of a Durable Object namespace binding the gate uses (the repo compiles functions/ without the workers types). */
export interface GateNamespace {
  idFromName(name: string): unknown
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> }
}

/** A turn from the gate: wait `waitMs`, then scan, then `release`; or the wait after which one may be free. */
export type GateTurn = { waitMs: number; release: () => void } | { retryAfterMs: number }

export interface SiteGate {
  take(blocks: number, waitMs: number): Promise<GateTurn>
}

export const SITE_GATE_TIMEOUT_MS = 2_000
export const SITE_GATE_REST_MS = 60_000
const ORIGIN = 'https://wide-gate'
const MAX_WAIT_MS = 30_000
const LEASE = /^[1-9][0-9]{0,15}$/

const isNamespace = (value: unknown): value is GateNamespace =>
  !!value && typeof value === 'object' && typeof (value as GateNamespace).idFromName === 'function' && typeof (value as GateNamespace).get === 'function'

/** When a gate that could not be asked is asked again (per isolate). */
let restUntil = 0

/** Tests: forget a gate that could not be asked. */
export function resetSiteGate(): void {
  restUntil = 0
}

/**
 * The gate over the deployment's binding, or null without one. `keepAlive`: the invocation's waitUntil, which carries a
 * turn's release past the answer; `now` the clock; `log` one line when the gate cannot be asked.
 */
export function siteGateOf(binding: unknown, keepAlive?: (work: Promise<unknown>) => void, now: () => number = () => Date.now(), log?: (event: string) => void): SiteGate | null {
  if (!isNamespace(binding)) return null
  const post = (path: string, body: unknown, signal?: AbortSignal) =>
    binding.get(binding.idFromName('site')).fetch(`${ORIGIN}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
  const alone: GateTurn = { waitMs: 0, release: () => {} }
  return {
    async take(blocks, waitMs) {
      if (restUntil > now()) return alone
      let value: unknown
      try {
        const response = await post('/take', { blocks: Math.ceil(blocks), waitMs: Math.max(0, Math.floor(waitMs)) }, AbortSignal.timeout(SITE_GATE_TIMEOUT_MS))
        value = response.ok ? await response.json() : null
      } catch {
        value = null
      }
      const answer = value as { ok?: unknown; lease?: unknown; waitMs?: unknown; retryAfterMs?: unknown } | null
      if (answer?.ok === true && typeof answer.lease === 'string' && LEASE.test(answer.lease) && Number.isSafeInteger(answer.waitMs) && (answer.waitMs as number) >= 0 && (answer.waitMs as number) <= MAX_WAIT_MS) {
        const lease = answer.lease
        const release = () => {
          const given = post('/release', { lease }).catch(() => undefined)
          keepAlive?.(given)
        }
        return { waitMs: answer.waitMs as number, release }
      }
      if (answer?.ok === false && Number.isSafeInteger(answer.retryAfterMs) && (answer.retryAfterMs as number) >= 0 && (answer.retryAfterMs as number) <= MAX_WAIT_MS) return { retryAfterMs: answer.retryAfterMs as number }
      // The gate cannot be asked: let alone a while; the isolate's own pace alone meanwhile.
      restUntil = now() + SITE_GATE_REST_MS
      log?.('wide_gate_away')
      return alone
    },
  }
}
