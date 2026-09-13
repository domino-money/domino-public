/**
 * The deposit screen's controller: which operation is shown, what the user
 * can do with it, and the complete list of calls it makes on its own.
 *
 * Automatic calls, all of them:
 *   1. When a session is signed in (REC-2): list the first page; get the
 *      remembered operation (a not-found or foreign answer forgets it
 *      silently); then reconcile each operation on that page that is
 *      outstanding, one at a time, with its own version, stopping at the
 *      first failure. Nothing that is not outstanding is reconciled.
 *   2. After a version or state conflict: one get of the same operation.
 *      The mutation is never replayed.
 *   A session denial (session_required, csrf_invalid, account_unsupported)
 *   from any of these goes to the session port exactly as one from a user
 *   action does (rugged97, P2 on #72); only a remembered id that is not
 *   found or not this owner's is forgotten silently.
 *
 * Everything else is a user action, one at a time. `issueWalletStep` is the
 * only function that calls prepare, reached only from the user's Prepare and
 * Re-open, and it refuses unless the transport is the fixture one or a wallet
 * handoff exists (it never does in this build). A token, admission or state
 * denial latches Prepare off for that operation: no automatic new attempt,
 * no new mint, no create (there is no create in this phase at all).
 *
 * No interval, no reconcile on focus, no polling. The wallet step lives in
 * this state only, never in storage.
 *
 * The handoff window (rugged97, P2 on #72): a step gets a deadline only when
 * this page's own prepare issued it, which the service shows by answering
 * with a newer version. Its lifetime is counted from when that prepare was
 * sent, which is no later than the service's issue. A re-delivery (the same
 * version: the service returns the persisted step with its original
 * expiration) keeps the deadline this page already knows for that step, or,
 * after a reload or on another page, gets none: the step is shown but never
 * as fresh. Nothing restarts the original lifetime or extends a known
 * deadline, and the device clock is never compared with the server's.
 */
import type { Clock } from '../lib/clock'
import { sessionKey, type SessionPort, type SessionSnapshot } from '../session/port'
import type { DepositClient, DepositFailure, DepositOutcome } from './client'
import { failureCopy } from './copy'
import { DEPOSIT_ERROR_UI } from './errors'
import type { WalletHandoff } from './handoff'
import type { DepositMemory } from './memory'
import { PERMIT2, POSITION_MANAGER } from './present'
import type { AllowanceReport, DepositErrorCode, DepositRoute, Operation, OperationListItem, PreparedArtifact } from './types'

export type FlowAction = 'open' | 'close' | 'check_status' | 'prepare' | 'reopen' | 'cancel' | 'allowances' | 'report' | 'load_more'

export type FlowEvent = { t: 'user'; action: FlowAction; id?: string; hash?: string }

export interface CurrentOperation {
  op: Operation
  walletStep: PreparedArtifact | null
  /** The prepare response exactly as validated, for the pre-sign gate. */
  prepareResponse: unknown
  prepareSentMono: number | null
  walletStepDeadlineMono: number | null
  allowances: AllowanceReport | null
}

export interface FlowNotice {
  route: DepositRoute
  failure: DepositFailure
  text: string
}

export interface FlowState {
  phase: 'ineligible' | 'booting' | 'ready'
  block: SessionSnapshot['kind'] | null
  items: OperationListItem[]
  hasMore: boolean
  nextBefore: string | null
  current: CurrentOperation | null
  busy: DepositRoute | null
  notice: FlowNotice | null
  /** Operations whose Prepare is off for this page's life, with the code that refused it. */
  latched: Readonly<Record<string, DepositErrorCode>>
  blockerId: string | null
  knownPairs: ReadonlyArray<{ currency: string; spender: string }>
}

export interface DepositFlow {
  getState(): FlowState
  subscribe(listener: () => void): () => void
  dispatch(event: FlowEvent): void
  readonly issueWalletStepAllowed: boolean
  /** Follows the session and, the first time, boots. Returns what stops following it. */
  start(): () => void
  dispose(): void
}

export interface FlowDeps {
  client: DepositClient
  session: SessionPort
  memory: DepositMemory
  clock: Clock
  handoff: WalletHandoff
}

/** How long before the handoff's own end the page stops calling it fresh. */
export const HANDOFF_MARGIN_MS = 5_000
const HASH = /^0x[0-9a-f]{64}$/i

const INITIAL: FlowState = {
  phase: 'booting',
  block: null,
  items: [],
  hasMore: false,
  nextBefore: null,
  current: null,
  busy: null,
  notice: null,
  latched: {},
  blockerId: null,
  knownPairs: [],
}

export function listItemOf(op: Operation): OperationListItem {
  const { history, ...rest } = op
  return { ...rest, historyCount: history.length, lastStep: history.at(-1) ?? null }
}

/** Currency and spender pairs a wallet step or allowance report names (ALW-7). */
/** The same current step, field for field; anything else is a different operation. */
function sameStep(a: Operation['history'][number] | undefined, b: Operation['history'][number] | undefined): boolean {
  return a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b)
}

function pairsOf(step: PreparedArtifact | null, report: AllowanceReport | null): Array<{ currency: string; spender: string }> {
  const pairs: Array<{ currency: string; spender: string }> = []
  if (step?.kind === 'erc20_approval' || step?.kind === 'erc20_reset') pairs.push({ currency: step.transaction.to.toLowerCase(), spender: PERMIT2 })
  if (step?.kind === 'permit2_approval') {
    const word = step.transaction.data.slice(10, 74)
    if (/^[0-9a-f]{64}$/i.test(word)) pairs.push({ currency: `0x${word.slice(24)}`.toLowerCase(), spender: POSITION_MANAGER })
  }
  for (const observation of report?.observations ?? []) {
    pairs.push({ currency: observation.currency.toLowerCase(), spender: observation.erc20Spender })
    pairs.push({ currency: observation.currency.toLowerCase(), spender: observation.permit2Spender })
  }
  return pairs
}

export function createDepositFlow({ client, session, memory, clock, handoff }: FlowDeps): DepositFlow {
  const issueWalletStepAllowed = client.transportKind === 'fixture' || handoff.available === true
  const listeners = new Set<() => void>()
  let state: FlowState = INITIAL
  let snapshot = session.getSnapshot()
  let key = sessionKey(snapshot)
  let run = 0
  let inflight: AbortController | null = null
  let cancelDeadline: (() => void) | null = null
  /** Deadlines this page established, one per issued step (see the header). */
  const deadlines = new Map<string, number>()
  const stepKey = (id: string, step: { step: number; nonceRaw: string; issuedAt: number; expiresAt: number }) =>
    `${id}|${step.step}|${step.nonceRaw}|${step.issuedAt}|${step.expiresAt}`

  const set = (patch: Partial<FlowState>) => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }

  const epochOf = () => (snapshot.kind === 'signed_in' ? snapshot.epoch : -1)

  function addPairs(pairs: Array<{ currency: string; spender: string }>) {
    const seen = new Set(state.knownPairs.map((pair) => `${pair.currency}|${pair.spender}`))
    const next = [...state.knownPairs]
    for (const pair of pairs) if (!seen.has(`${pair.currency}|${pair.spender}`)) next.push(pair)
    return next
  }

  function notice(route: DepositRoute, failure: DepositFailure): FlowNotice {
    return { route, failure, text: failureCopy(failure, { nonce: state.current?.op.history.at(-1)?.nonceRaw ?? null, knownPairs: state.knownPairs }) }
  }

  function withOp(op: Operation, extra: Partial<CurrentOperation> = {}): CurrentOperation {
    const same = state.current?.op.id === op.id
    return {
      op,
      walletStep: null,
      prepareResponse: null,
      prepareSentMono: null,
      walletStepDeadlineMono: null,
      allowances: same ? state.current?.allowances ?? null : null,
      ...extra,
    }
  }

  function updateItem(op: Operation) {
    return state.items.map((item) => (item.id === op.id ? listItemOf(op) : item))
  }

  /** Runs one call under the current session; a result from an older run or session is dropped. */
  async function call<R extends DepositRoute>(_route: R, send: (options: { epoch: number; signal: AbortSignal }) => Promise<DepositOutcome<R>>): Promise<DepositOutcome<R> | null> {
    const mine = run
    const controller = new AbortController()
    inflight = controller
    const outcome = await send({ epoch: epochOf(), signal: controller.signal })
    if (mine !== run) return null
    if (inflight === controller) inflight = null
    if (!outcome.ok && outcome.failure.kind === 'aborted') return null
    return outcome
  }

  /**
   * The failure paths every call shares, user actions and the boot alike.
   * Returns false when the session the call ran under is gone (a denial can
   * end it at once), so the caller must not update anything after it.
   * `followUp` is false for the one get after a conflict, which never
   * schedules another.
   */
  async function handleFailure(route: DepositRoute, failure: DepositFailure, operationId: string | null, followUp = true): Promise<boolean> {
    const mine = run
    const text = notice(route, failure)
    let patch: Partial<FlowState> = { notice: text, busy: null }
    if (failure.kind === 'contract' && failure.detail === 'owner') {
      // Nothing from a foreign answer is shown or remembered.
      patch = { ...patch, current: route === 'list' ? state.current : null, items: route === 'list' ? [] : state.items }
      if (route !== 'list') memory.forget()
      set(patch)
      return mine === run
    }
    if (failure.kind === 'error') {
      const disposition = DEPOSIT_ERROR_UI[failure.code]
      if (disposition.denial) {
        session.reportDenial(disposition.denial, epochOf())
        if (mine !== run) {
          // The port ended or replaced the session at once, and everything
          // shown went with it: only say why.
          set({ notice: text, busy: null })
          return false
        }
      }
      if (disposition.latch && operationId) patch.latched = { ...state.latched, [operationId]: failure.code }
      if (disposition.stop && state.current) patch.current = { ...state.current, walletStep: null, prepareResponse: null, walletStepDeadlineMono: null }
      if (disposition.blocker) {
        const blocker = state.items.find((item) => item.id !== operationId && (item.outstanding || item.state === 'attention'))
        patch.blockerId = blocker?.id ?? null
      }
      if (disposition.notFound && operationId) {
        memory.forget()
        if (state.current?.op.id === operationId) patch.current = null
      }
      set(patch)
      if (disposition.autoGet && operationId && followUp) {
        // One get, never a replay of the mutation. Its own failure, a session
        // denial included, takes the same path, with no further get.
        set({ busy: 'get' })
        const got = await call('get', (options) => client.get({ intentId: operationId }, options))
        if (!got) return false
        if (!got.ok) return handleFailure('get', got.failure, operationId, false)
        set({ busy: null, current: withOp(got.data.operation), items: updateItem(got.data.operation) })
      }
      return mine === run
    }
    set(patch)
    return mine === run
  }

  function scheduleDeadline(deadline: number | null) {
    cancelDeadline?.()
    cancelDeadline = null
    if (deadline === null) return
    // Re-render when the handoff stops being fresh; nothing is sent.
    cancelDeadline = clock.setTimer(() => set({}), Math.max(0, deadline - clock.monoMs()))
  }

  async function boot() {
    const mine = run
    set({ ...INITIAL, phase: 'booting', latched: state.latched, knownPairs: [] })
    const listed = await call('list', (options) => client.list({ limit: 20 }, options))
    if (!listed) return
    if (!listed.ok) {
      set({ phase: 'ready', items: [] })
      await handleFailure('list', listed.failure, null)
      return
    }
    let items = listed.data.operations
    set({ items, hasMore: listed.data.hasMore, nextBefore: listed.data.nextBefore })
    let current: CurrentOperation | null = null
    const remembered = memory.lastOperationId()
    if (remembered) {
      const got = await call('get', (options) => client.get({ intentId: remembered }, options))
      if (!got) return
      if (got.ok) {
        current = withOp(got.data.operation)
        set({ current })
      } else if ((got.failure.kind === 'error' && got.failure.code === 'deposit_not_found') || (got.failure.kind === 'contract' && got.failure.detail === 'owner')) {
        // A remembered id another owner or the archive no longer knows: forget it, say nothing.
        memory.forget()
      } else {
        set({ phase: 'ready' })
        await handleFailure('get', got.failure, remembered, false)
        return
      }
    }
    for (const item of items) {
      if (!item.outstanding) continue
      const version = current && current.op.id === item.id ? current.op.version : item.version
      const reconciled = await call('reconcile', (options) => client.reconcile({ intentId: item.id, version }, options))
      if (!reconciled) return
      if (!reconciled.ok) {
        set({ phase: 'ready' })
        if (!(await handleFailure('reconcile', reconciled.failure, item.id))) return
        set({ phase: 'ready', busy: null })
        return
      }
      const op = reconciled.data.operation
      items = items.map((entry) => (entry.id === op.id ? listItemOf(op) : entry))
      if (current && current.op.id === op.id) current = withOp(op)
      set({ items, current })
    }
    if (mine !== run) return
    set({ phase: 'ready', busy: null })
  }

  function onSession() {
    const next = session.getSnapshot()
    if (next === snapshot) return
    const nextKey = sessionKey(next)
    snapshot = next
    if (nextKey === key && nextKey !== null) return
    key = nextKey
    // A new identity or session: abort, clear everything shown and remembered.
    run += 1
    inflight?.abort()
    inflight = null
    scheduleDeadline(null)
    deadlines.clear()
    if (state.current !== null || state.items.length > 0) memory.forget()
    if (next.kind !== 'signed_in') {
      state = { ...INITIAL, phase: 'ineligible', block: next.kind }
      for (const listener of listeners) listener()
      return
    }
    void boot()
  }

  /** The only caller of client.prepare. */
  async function issueWalletStep() {
    const current = state.current
    if (!issueWalletStepAllowed || !current || state.busy !== null) return
    if (state.latched[current.op.id]) return
    if (current.op.state !== 'draft' && current.op.state !== 'awaiting_wallet') return
    const { id, version } = current.op
    set({ busy: 'prepare', notice: null })
    const sentMono = clock.monoMs()
    const outcome = await call('prepare', (options) => client.prepare({ intentId: id, version }, options))
    if (!outcome) return
    if (!outcome.ok) return handleFailure('prepare', outcome.failure, id)
    const { operation, walletStep } = outcome.data
    const last = operation.history.at(-1)
    let deadline: number | null = null
    if (walletStep && last) {
      const key = stepKey(operation.id, last)
      const known = deadlines.get(key)
      if (known !== undefined) {
        // A re-delivery of a step this page issued: the same deadline, never a later one.
        deadline = known
      } else if (operation.version > version) {
        // Issued by this request, after sentMono: the full lifetime from the send.
        const life = walletStep.expiresAt - last.issuedAt
        if (life > 0) {
          deadline = sentMono + life * 1000 - HANDOFF_MARGIN_MS
          deadlines.set(key, deadline)
        }
      }
      // Otherwise a step issued before this page asked: how much of its
      // window is left cannot be established here, so it is never fresh.
    }
    memory.remember(operation.id)
    set({
      busy: null,
      current: withOp(operation, { walletStep, prepareResponse: outcome.data, prepareSentMono: sentMono, walletStepDeadlineMono: deadline }),
      items: updateItem(operation),
      knownPairs: addPairs(pairsOf(walletStep, null)),
    })
    scheduleDeadline(deadline)
  }

  async function userAction(event: FlowEvent) {
    if (state.phase !== 'ready' || state.busy !== null || snapshot.kind !== 'signed_in') return
    const current = state.current
    switch (event.action) {
      case 'open': {
        if (!event.id) return
        const id = event.id
        set({ busy: 'get', notice: null, blockerId: null })
        const got = await call('get', (options) => client.get({ intentId: id }, options))
        if (!got) return
        if (!got.ok) return handleFailure('get', got.failure, id)
        memory.remember(got.data.operation.id)
        scheduleDeadline(null)
        set({ busy: null, current: withOp(got.data.operation, { allowances: null }), items: updateItem(got.data.operation) })
        return
      }
      case 'close':
        scheduleDeadline(null)
        set({ current: null, notice: null })
        return
      case 'prepare':
      case 'reopen':
        return issueWalletStep()
      case 'check_status':
      case 'cancel': {
        if (!current) return
        const { id, version } = current.op
        const route = event.action === 'cancel' ? 'cancel' : 'reconcile'
        set({ busy: route, notice: null })
        const outcome =
          route === 'cancel'
            ? await call('cancel', (options) => client.cancel({ intentId: id, version }, options))
            : await call('reconcile', (options) => client.reconcile({ intentId: id, version }, options))
        if (!outcome) return
        if (!outcome.ok) return handleFailure(route, outcome.failure, id)
        scheduleDeadline(null)
        set({ busy: null, current: withOp(outcome.data.operation), items: updateItem(outcome.data.operation) })
        return
      }
      case 'allowances': {
        if (!current) return
        const id = current.op.id
        set({ busy: 'allowances', notice: null })
        const outcome = await call('allowances', (options) => client.allowances({ intentId: id }, options))
        if (!outcome) return
        if (!outcome.ok) return handleFailure('allowances', outcome.failure, id)
        const report = outcome.data.allowances
        const op = outcome.data.operation
        // The route answers with the operation as it is now, which may have
        // moved on in another tab (rugged97, P2 on #72). A prepared step stays
        // only with the operation it was prepared for: the same version and
        // the same current step. Anything newer drops it, with its deadline
        // and the prepare response the pre-sign checks read; what the server
        // holds now is re-opened by hand.
        const keep = current.walletStep !== null && op.id === current.op.id && op.version === current.op.version && sameStep(op.history.at(-1), current.op.history.at(-1))
        if (!keep) scheduleDeadline(null)
        set({
          busy: null,
          current: keep ? { ...current, op, allowances: report } : withOp(op, { allowances: report }),
          items: updateItem(op),
          knownPairs: addPairs(pairsOf(null, report)),
        })
        return
      }
      case 'report': {
        if (!current || !event.hash || !HASH.test(event.hash.trim())) return
        const hash = event.hash.trim().toLowerCase()
        const { id, version } = current.op
        set({ busy: 'report', notice: null })
        const outcome = await call('report', (options) => client.report({ intentId: id, version, transactionHash: hash }, options))
        if (!outcome) return
        if (!outcome.ok) return handleFailure('report', outcome.failure, id)
        scheduleDeadline(null)
        set({ busy: null, current: withOp(outcome.data.operation), items: updateItem(outcome.data.operation) })
        return
      }
      case 'load_more': {
        if (!state.hasMore || state.nextBefore === null) return
        const before = state.nextBefore
        set({ busy: 'list', notice: null })
        const outcome = await call('list', (options) => client.list({ limit: 20, before }, options))
        if (!outcome) return
        if (!outcome.ok) return handleFailure('list', outcome.failure, null)
        set({ busy: null, items: [...state.items, ...outcome.data.operations], hasMore: outcome.data.hasMore, nextBefore: outcome.data.nextBefore })
        return
      }
    }
  }

  let unsubscribe: (() => void) | null = null
  let booted = false
  if (snapshot.kind !== 'signed_in') state = { ...INITIAL, phase: 'ineligible', block: snapshot.kind }

  function stop() {
    unsubscribe?.()
    unsubscribe = null
  }

  return {
    issueWalletStepAllowed,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start() {
      if (unsubscribe === null) unsubscribe = session.subscribe(onSession)
      if (!booted) {
        booted = true
        if (session.getSnapshot() !== snapshot) onSession()
        else if (snapshot.kind === 'signed_in') void boot()
      }
      return stop
    },
    dispatch(event) {
      void userAction(event)
    },
    dispose() {
      run += 1
      inflight?.abort()
      scheduleDeadline(null)
      deadlines.clear()
      stop()
      listeners.clear()
    },
  }
}
