import type { PerformanceRequests, PerformanceResponses, PerformanceRoute, CardsResponse, Enrollment } from 'api-contracts/performance-v2/types'
import type { Clock } from '../lib/clock'
import { fetchRaw, jsonBody, classifyHeaderless, type FetchLike } from '../lib/http/rawReply'
import { sessionKey, SESSION_GONE, type SessionPort } from '../session/port'

export interface Validators {
  CONTRACT_VERSION: string
  validateRequest(route: string, value: unknown): boolean
  validateResponse(route: string, value: unknown): boolean
  validateError(status: number, value: unknown): boolean
}
export type PerformanceView = {
  scope: string | null
  state: 'signed_out' | 'loading' | 'ready' | 'unavailable'
  enrollments: Enrollment[]
  cards: CardsResponse['cards']
  reason: string | null
  busy: boolean
  more: boolean
  receivedAt: number | null
}
export function createPerformanceController(deps: { session: SessionPort; fetch: FetchLike; runtime: Validators; clock: Clock; visible(): boolean }) {
  const { session, runtime, clock } = deps
  let view: PerformanceView = { scope: null, state: 'signed_out', enrollments: [], cards: [], reason: null, busy: false, more: false, receivedAt: null }
  const listeners = new Set<() => void>()
  let running = false
  let generation = 0
  let abort: AbortController | null = null
  let stopTimer: (() => void) | null = null
  let nextAt = 0
  let after: string | null = null
  let nextAfter: string | null = null
  const publish = (patch: Partial<PerformanceView>) => { view = { ...view, ...patch }; for (const fn of listeners) fn() }
  const stopWork = () => { generation++; abort?.abort(); abort = null; stopTimer?.(); stopTimer = null }
  function schedule(seconds = 60) {
    nextAt = clock.monoMs() + seconds * 1000
    stopTimer?.()
    stopTimer = running && deps.visible() ? clock.setTimer(() => { stopTimer = null; void refresh() }, seconds * 1000) : null
  }
  async function request<R extends PerformanceRoute>(route: R, body: PerformanceRequests[R], signal: AbortSignal): Promise<PerformanceResponses[R]> {
    const before = session.getSnapshot(), key = sessionKey(before)
    if (before.kind !== 'signed_in' || !runtime.validateRequest(route, body)) throw new Error('session_required')
    const result = await session.withCsrf(before.epoch, csrf => fetchRaw(deps.fetch, '/api/performance/v2/' + route,
      { headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Domino-CSRF': csrf,
        'X-Domino-Performance-Contract': runtime.CONTRACT_VERSION }, body: JSON.stringify(body) },
      { clock, signal, timeoutMs: 20_000, maxBytes: 65_536, contractHeader: 'X-Domino-Performance-Contract' }))
    if (signal.aborted || key !== sessionKey(session.getSnapshot()) || result === SESSION_GONE) throw new Error('session_required')
    if (result.kind !== 'reply') throw new Error(result.kind)
    const reply = result.reply
    if (reply.contractHeader === null) throw new Error(classifyHeaderless(reply))
    if (reply.contractHeader !== runtime.CONTRACT_VERSION || reply.opaqueRedirect) throw new Error('contract_mismatch')
    const parsed = jsonBody(reply)
    if (!parsed.ok) throw new Error('invalid_response')
    if (reply.status !== 200) {
      if (!runtime.validateError(reply.status, parsed.value)) throw new Error('invalid_response')
      const code = (parsed.value as { error: string }).error
      if (code === 'session_required' || code === 'csrf_invalid' || code === 'account_unsupported') session.reportDenial(code, before.epoch)
      throw new Error(code)
    }
    if (!runtime.validateResponse(route, parsed.value)) throw new Error('invalid_response')
    const response = parsed.value as PerformanceResponses[R]
    if (response.owner !== before.owner || response.chainId !== before.chainId) throw new Error('owner_mismatch')
    if (route === 'cards') {
      const asked = (body as PerformanceRequests['cards']).epochIds
      const got = (response as CardsResponse).cards
      if (got.length !== asked.length || got.some((card, index) => card.epochId !== asked[index])) throw new Error('epoch_mismatch')
    }
    return response
  }
  async function cycle(enrollment?: PerformanceRequests['enroll']) {
    if (!running || !deps.visible() || view.busy || session.getSnapshot().kind !== 'signed_in') return
    const g = ++generation, controller = new AbortController(); abort = controller
    // One bounded cycle: epochs/cards or enroll, with no request retries.
    const deadline = clock.setTimer(() => controller.abort(), 20_000)
    publish({ busy: true, reason: null, state: view.receivedAt === null ? 'loading' : view.state })
    try {
      if (enrollment) {
        await request('enroll', enrollment, controller.signal)
        if (g !== generation) return
        publish({ reason: 'enrollment_queued' })
        nextAt = 0
      } else {
        const epochs = await request('epochs', after ? { after } : {}, controller.signal)
        const ids = epochs.enrollments.flatMap(item => item.epochId === null ? [] : [item.epochId])
        const cards = ids.length ? await request('cards', { epochIds: ids }, controller.signal) : null
        if (g !== generation) return
        nextAfter = epochs.nextAfter
        publish({ state: 'ready', enrollments: epochs.enrollments, cards: cards?.cards ?? [], reason: null,
          receivedAt: clock.wallMs(), more: epochs.nextAfter !== null })
        schedule(Math.max(epochs.refreshAfterSeconds, cards?.refreshAfterSeconds ?? 30))
      }
    } catch (error) {
      if (g === generation) {
        // An older response is never presented as current after a failure.
        publish({ state: 'unavailable', enrollments: [], cards: [], receivedAt: null,
          reason: error instanceof Error ? error.message : 'unavailable' })
        schedule(60)
      }
    } finally {
      deadline()
      if (g === generation) { abort = null; publish({ busy: false }); if (enrollment) schedule(30) }
    }
  }
  async function refresh() { if (clock.monoMs() < nextAt) return; await cycle() }
  function changed() {
    const scope = sessionKey(session.getSnapshot())
    if (scope === view.scope) return
    stopWork(); nextAt = 0; after = null
    publish({ scope, state: scope ? 'loading' : 'signed_out', enrollments: [], cards: [], reason: null, busy: false, more: false, receivedAt: null })
    if (scope) void refresh()
  }
  return {
    getSnapshot: () => view,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    start() { running = true; const off = session.subscribe(changed); changed(); return () => { running = false; off(); stopWork() } },
    refresh,
    enroll: (body: PerformanceRequests['enroll']) => cycle(body),
    visibilityChanged() {
      if (!deps.visible()) { stopWork(); publish({ busy: false, cards: [], receivedAt: null, state: view.scope ? 'loading' : 'signed_out' }) }
      else if (clock.monoMs() >= nextAt) void refresh()
      else { stopTimer?.(); stopTimer = clock.setTimer(() => { void refresh() }, nextAt - clock.monoMs()) }
    },
    nextPage() { if (view.busy || !view.more || clock.monoMs() < nextAt) return; after = nextAfter; void refresh() },
    firstPage() { if (view.busy || clock.monoMs() < nextAt) return; after = null; void refresh() },
  }
}
