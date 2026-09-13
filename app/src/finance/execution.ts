import type { ExecutionResponses } from 'api-contracts/execution-v1/types'
import type { Clock } from '../lib/clock'
import { fetchRaw, jsonBody, classifyHeaderless, type FetchLike } from '../lib/http/rawReply'
import { sessionKey, SESSION_GONE, type SessionPort } from '../session/port'
import type { Validators } from './performance'

export function createExecutionController(deps: { session: SessionPort; fetch: FetchLike; runtime: Validators; clock: Clock; visible(): boolean }) {
  type Page = ExecutionResponses['list']
  let view: { scope: string | null; items: Page['items']; more: boolean; busy: boolean; reason: string | null; receivedAt: number | null } = { scope: null, items: [], more: false, busy: false, reason: null, receivedAt: null }
  const listeners = new Set<() => void>()
  let generation = 0, nextAt = 0, nextAfter: string | null = null, after: string | null = null, running = false
  let abort: AbortController | null = null
  const publish = (patch: Partial<typeof view>) => { view = { ...view, ...patch }; listeners.forEach(fn => fn()) }
  const clear = () => { generation++; abort?.abort(); abort = null; nextAfter = null; after = null; nextAt = 0; publish({ scope: sessionKey(deps.session.getSnapshot()), items: [], more: false, busy: false, reason: null, receivedAt: null }) }
  async function refresh() {
    const session = deps.session.getSnapshot(), scope = sessionKey(session)
    if (!running || !deps.visible() || session.kind !== 'signed_in' || view.busy || deps.clock.monoMs() < nextAt) return
    const gen = ++generation, controller = new AbortController(); abort = controller
    nextAt = deps.clock.monoMs() + 30_000
    publish({ scope, busy: true, reason: null, items: [], receivedAt: null, more: false })
    try {
      const body = { afterIntentId: after, limit: 10 }
      const result = await deps.session.withCsrf(session.epoch, csrf => fetchRaw(deps.fetch, '/api/execution/v1/list',
        { headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Domino-CSRF': csrf, 'X-Domino-Execution-Contract': deps.runtime.CONTRACT_VERSION }, body: JSON.stringify(body) },
        { clock: deps.clock, signal: controller.signal, timeoutMs: 20_000, maxBytes: 131072, contractHeader: 'X-Domino-Execution-Contract' }))
      if (gen !== generation || scope !== sessionKey(deps.session.getSnapshot()) || controller.signal.aborted || result === SESSION_GONE) return
      if (result.kind !== 'reply') throw new Error(result.kind)
      const reply = result.reply
      if (!reply.contractHeader) throw new Error(classifyHeaderless(reply))
      if (reply.opaqueRedirect || reply.contractHeader !== deps.runtime.CONTRACT_VERSION) throw new Error('contract_mismatch')
      const parsed = jsonBody(reply)
      if (!parsed.ok) throw new Error('invalid_response')
      if (reply.status !== 200) {
        if (!deps.runtime.validateError(reply.status, parsed.value)) throw new Error('invalid_response')
        const code = (parsed.value as { error: string }).error
        if (code === 'session_required' || code === 'csrf_invalid' || code === 'account_unsupported') deps.session.reportDenial(code, session.epoch)
        throw new Error(code)
      }
      if (!deps.runtime.validateResponse('list', parsed.value)) throw new Error('invalid_response')
      const page = parsed.value as Page
      if (page.owner !== session.owner || page.chainId !== session.chainId || page.items.length > 10 || page.items.some(item => after && item.intentId <= after)) throw new Error('owner_or_cursor_mismatch')
      nextAfter = page.nextAfterIntentId
      publish({ items: page.items, more: nextAfter !== null, receivedAt: deps.clock.wallMs() })
    } catch (error) {
      if (gen !== generation) return
      nextAt = deps.clock.monoMs() + 60_000; nextAfter = null
      publish({ items: [], more: false, reason: error instanceof Error ? error.message : 'unavailable' })
    } finally { if (gen === generation) { abort = null; publish({ busy: false }) } }
  }
  return { getSnapshot: () => view, subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn) }, refresh,
    nextPage: () => { if (!view.busy && nextAfter && deps.clock.monoMs() >= nextAt) { after = nextAfter; void refresh() } },
    firstPage: () => { if (!view.busy && deps.clock.monoMs() >= nextAt) { after = null; void refresh() } },
    visibilityChanged: () => { if (!deps.visible()) clear() },
    start: () => { running = true; clear(); const stop = deps.session.subscribe(() => { if (view.scope !== sessionKey(deps.session.getSnapshot())) clear() }); return () => { running = false; stop(); clear() } },
  }
}
