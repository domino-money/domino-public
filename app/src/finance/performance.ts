import type { PerformanceRequests, PerformanceResponses, PerformanceRoute, CardsResponse, Enrollment, EpochsResponse, TrackedCard } from 'api-contracts/performance-v2/types'
import type { Clock } from '../lib/clock'
import { fetchRaw, jsonBody, classifyHeaderless, type FetchLike } from '../lib/http/rawReply'
import { parseDecimal, toFixed } from '../lib/read/decimal'
import { sessionKey, SESSION_GONE, type SessionPort } from '../session/port'
import { reaskWait, sameWallet } from './privateCards'
import type { OwnedSequence } from './sequence'

export interface Validators {
  CONTRACT_VERSION: string
  validateRequest(route: string, value: unknown): boolean
  validateResponse(route: string, value: unknown): boolean
  validateError(status: number, value: unknown): boolean
}
/** A sequence the signed-in owner's wallet lists, offered for Start tracking. */
export interface TrackableSequence { vault: string; rootTokenId: string }
/** A row of the sequence client's listing, as Start tracking offers it. */
export const trackableSequence = (row: Pick<OwnedSequence, 'vault' | 'rootTokenId'>): TrackableSequence => ({ vault: row.vault, rootTokenId: row.rootTokenId.toString() })

/**
 * Where Start tracking finds what to send: the owner's own sequences, read
 * through the connected wallet with the sequence client. Only chain reads:
 * nothing here signs, approves or sends, and no Domino service is asked.
 * Each method throws a closed code when the read fails.
 */
export interface SequenceReads {
  /** The owner's most recent sequences, newest first, and whether it has older ones; null when this page has no deployment to read them with. */
  list(owner: string): Promise<{ rows: readonly TrackableSequence[]; older: boolean } | null>
  /** The complete active NFT set of one sequence the owner holds, as decimal strings, root first. */
  members(owner: string, vault: string): Promise<readonly string[]>
}

export type SequencesView = {
  /** idle: nothing asked yet; unavailable: no deployment, or the wallet read failed (`reason`, a closed code for data attributes only). */
  state: 'idle' | 'reading' | 'ready' | 'unavailable'
  rows: readonly TrackableSequence[]
  /** The wallet created more sequences than are listed: only then is a sequence address typed. */
  older: boolean
  reason: string | null
}

export type PerformanceView = {
  scope: string | null
  /**
   * checking: the wallet's session is being checked; loading: signed in, and no
   * history read has answered in this visit yet; unavailable: the last read
   * failed (`reason`). None of them clears what is shown.
   */
  state: 'signed_out' | 'checking' | 'loading' | 'ready' | 'unavailable'
  /** What is shown: this browser's copy until the first read answers, then the last good read, kept through each refresh, failure and hidden tab. */
  enrollments: Enrollment[]
  cards: CardsResponse['cards']
  /** Why the last read failed, as a closed code. For titles and data attributes only, never shown as text. */
  reason: string | null
  busy: boolean
  more: boolean
  /** A page change was asked for and waits for its read. */
  paging: boolean
  receivedAt: number | null
  /** The owner's sequences that Start tracking can offer. */
  sequences: SequencesView
  /** The sequence whose Start tracking is reading its positions or being sent. */
  starting: string | null
  /** What the last Start tracking in this session came to, for which vault: sent, or refused with its closed code. */
  enrollment: { vault: string; ok: true } | { vault: string; ok: false; reason: string } | null
}

/** How many more times a failed sequence listing is asked, 15 s, 30 s then 60 s later, while the tab is visible. */
export const SEQUENCE_LIST_TRIES = 3
/**
 * performance-v2 asks a visible page to refresh every 30 to 60 seconds, as
 * each good answer says. A failed read is asked again this long later while
 * the tab is visible, then twice as long each time, at most REASK_TRIES times
 * (finance/privateCards.ts); a failure asking again cannot fix is not asked again.
 */
export const PERFORMANCE_RETRY_MS = 60_000
/** The least time between two history reads the page starts on its own, whatever brought it back. */
const HISTORY_FLOOR_MS = 30_000
/** Listing failures that asking again cannot fix before the session or the deployment changes. */
const FINAL_LISTING = new Set(['deployment_code_changed', 'deployment_identity_changed', 'invalid_clone_template', 'invalid_sequence_release', 'wallet_identity_changed'])
const NO_SEQUENCES: SequencesView = { state: 'idle', rows: [], older: false, reason: null }
const codeOf = (error: unknown) => error instanceof Error && /^[a-z0-9_]{1,64}$/.test(error.message) ? error.message : 'wallet_read_failed'

/**
 * This browser's copy of what Managed positions last showed, per wallet
 * (finance/privateCards.ts): read back checked, display only. The wallet
 * island forgets it once the session ends, on any page.
 */
export interface PerformanceCache {
  load(owner: string): { enrollments: Enrollment[]; cards: CardsResponse['cards'] } | null
  save(owner: string, epochs: EpochsResponse, cards: CardsResponse | null): void
}

/**
 * Managed positions read themselves while the tab is visible, as often as
 * the service asks (every 30 to 60 seconds). Nothing shown is cleared for a
 * refresh, a failure, a hidden tab, a view shown again or a new session of
 * the same wallet (the owner, 2026-09-27, round 6: never flash empty); only
 * another wallet starts over, from this browser's copy when it has one, and a
 * sign-out from nothing.
 */
export function createPerformanceController(deps: { session: SessionPort; fetch: FetchLike; runtime: Validators; clock: Clock; visible(): boolean; sequences?: SequenceReads; cache?: PerformanceCache }) {
  const { session, runtime, clock } = deps
  let view: PerformanceView = { scope: null, state: 'signed_out', enrollments: [], cards: [], reason: null, busy: false, more: false, paging: false, receivedAt: null,
    sequences: NO_SEQUENCES, starting: null, enrollment: null }
  const listeners = new Set<() => void>()
  let running = false
  let generation = 0
  let abort: AbortController | null = null
  let stopTimer: (() => void) | null = null
  let nextAt = 0
  /** When the last epochs/cards cycle started, on the monotonic clock. */
  let lastCycleAt = -Infinity
  /** Automatic asks that followed a failed history read since the last good answer, sign-in or return to the tab. */
  let historyTries = 0
  let after: string | null = null
  let nextAfter: string | null = null
  // Start tracking and the sequence listing run beside the epochs/cards cycle, each with its own generation.
  let listGeneration = 0, listTries = 0, listTimer: (() => void) | null = null, listDueAt: number | null = null
  let trackGeneration = 0
  let pendingEnroll: PerformanceRequests['enroll'] | null = null
  const publish = (patch: Partial<PerformanceView>) => { view = { ...view, ...patch }; for (const fn of listeners) fn() }
  const stopWork = () => { generation++; abort?.abort(); abort = null; stopTimer?.(); stopTimer = null }
  const stopTracking = () => { trackGeneration++; pendingEnroll = null }
  /**
   * Drops a listing on its way and its timer. A failed listing's next ask stays
   * due, and one cut off goes back to not asked: the one controller outlives
   * its views, so a listing a stop cut off is asked again, never left reading
   * until a reload (2026-09-28, round 6 review).
   */
  const stopListing = () => { listGeneration++; listTimer?.(); listTimer = null; if (view.sequences.state === 'reading') publish({ sequences: NO_SEQUENCES }) }
  /** The next read, `ms` from now, and its timer while the page runs and is visible. */
  function schedule(ms: number) {
    nextAt = clock.monoMs() + ms
    stopTimer?.()
    stopTimer = running && deps.visible() ? clock.setTimer(() => { stopTimer = null; void refresh() }, ms) : null
  }
  /** Nothing is read again on its own: a failure asking again cannot fix, or the tries are spent. Coming back to the tab, a new sign-in or a press asks again. */
  function hold() {
    nextAt = Math.max(nextAt, lastCycleAt + HISTORY_FLOOR_MS)
    stopTimer?.(); stopTimer = null
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
    if (!enrollment) lastCycleAt = clock.monoMs()
    // One bounded cycle: epochs/cards or enroll, with no request retries.
    const deadline = clock.setTimer(() => controller.abort(), 20_000)
    publish(enrollment ? { busy: true, enrollment: null } : { busy: true, state: view.state === 'ready' || view.state === 'unavailable' ? view.state : 'loading' })
    try {
      if (enrollment) {
        // A session-authenticated POST with the CSRF, like every read here. It is never a wallet request.
        await request('enroll', enrollment, controller.signal)
        if (g !== generation) return
        publish({ starting: null, enrollment: { vault: enrollment.vault, ok: true } })
      } else {
        const epochs = await request('epochs', after ? { after } : {}, controller.signal)
        const ids = epochs.enrollments.flatMap(item => item.epochId === null ? [] : [item.epochId])
        const cards = ids.length ? await request('cards', { epochIds: ids }, controller.signal) : null
        if (g !== generation) return
        historyTries = 0
        nextAfter = epochs.nextAfter
        // Paging walks forward and, after the last page, back to the first. The first page is kept in this browser.
        publish({ state: 'ready', enrollments: epochs.enrollments, cards: cards?.cards ?? [], reason: null, paging: false,
          receivedAt: clock.wallMs(), more: epochs.nextAfter !== null || after !== null })
        if (!after) deps.cache?.save(epochs.owner, epochs, cards)
        // A visible batch is refreshed as often as the service asks: every 30 or 60 seconds.
        schedule(Math.max(epochs.refreshAfterSeconds, cards?.refreshAfterSeconds ?? 30) * 1000)
        listWhenDue()
      }
    } catch (error) {
      if (g === generation) {
        const reason = error instanceof Error ? error.message : 'unavailable'
        // A refused enrollment changes nothing already shown.
        if (enrollment) publish({ starting: null, enrollment: { vault: enrollment.vault, ok: false, reason } })
        else {
          // What is shown stays (the owner, 2026-09-27, round 6); the failure is in the section's data attributes.
          publish({ state: 'unavailable', paging: false, reason })
          // Asked again a few times, further apart each time; never for a failure asking again cannot fix.
          const wait = reaskWait(reason, historyTries, PERFORMANCE_RETRY_MS)
          if (wait === null) hold()
          else { historyTries += 1; schedule(wait) }
        }
      }
    } finally {
      deadline()
      if (g === generation) { abort = null; publish({ busy: false }); if (enrollment) schedule(30_000); void sendPendingEnroll() }
    }
  }
  async function refresh() { if (clock.monoMs() < nextAt) return; await cycle() }
  /** A Start tracking whose positions are read, sent as soon as no other cycle is on the wire. */
  function sendPendingEnroll(): Promise<void> | undefined {
    if (!pendingEnroll || view.busy) return
    const body = pendingEnroll
    pendingEnroll = null
    return cycle(body)
  }

  /**
   * The owner's sequences, read once per session through the wallet, and only
   * once the history service has answered: while it is off, Start tracking has
   * nothing to send to, so the chain is not read. A listing that failed for a
   * reason asking again could fix is asked again, silently, at most three
   * times and only while the tab is visible.
   */
  async function listSequences() {
    const before = session.getSnapshot(), key = sessionKey(before)
    if (!deps.sequences || !running || !deps.visible() || before.kind !== 'signed_in' || view.state !== 'ready' || view.sequences.state === 'reading' || view.sequences.state === 'ready') return
    listTimer?.(); listTimer = null; listDueAt = null
    const g = ++listGeneration
    publish({ sequences: { ...view.sequences, state: 'reading' } })
    try {
      const listed = await deps.sequences.list(before.owner)
      if (g !== listGeneration || key !== sessionKey(session.getSnapshot())) return
      listTries = 0
      publish({ sequences: listed ? { state: 'ready', rows: listed.rows, older: listed.older, reason: null } : { state: 'unavailable', rows: [], older: false, reason: 'no_deployment' } })
    } catch (error) {
      if (g !== listGeneration || key !== sessionKey(session.getSnapshot())) return
      const reason = codeOf(error)
      publish({ sequences: { state: 'unavailable', rows: [], older: false, reason } })
      if (FINAL_LISTING.has(reason) || listTries >= SEQUENCE_LIST_TRIES) return
      const wait = 15_000 * 2 ** listTries++
      listDueAt = clock.monoMs() + wait
      // Fired while hidden or while history is not current, it stays due and goes with the next visible, current page.
      listTimer = clock.setTimer(() => { listTimer = null; void listSequences() }, wait)
    }
  }
  /** Lists the owner's sequences when never listed in this session, or when a listing's next ask came due while it could not go. */
  function listWhenDue() {
    if (view.sequences.state === 'idle' || (listDueAt !== null && listTimer === null)) void listSequences()
  }

  /**
   * Start tracking one sequence: its complete active NFT set is read from the
   * vault through the wallet, then enroll is sent with the session. The wallet
   * is only read; the owner signs nothing.
   */
  async function track(vault: string) {
    const before = session.getSnapshot(), key = sessionKey(before)
    if (!deps.sequences || !running || !deps.visible() || before.kind !== 'signed_in' || view.starting !== null || pendingEnroll) return
    const t = ++trackGeneration
    publish({ starting: vault, enrollment: null })
    let tokenIds: string[]
    try {
      tokenIds = [...await deps.sequences.members(before.owner, vault)]
    } catch (error) {
      if (t === trackGeneration && key === sessionKey(session.getSnapshot())) publish({ starting: null, enrollment: { vault, ok: false, reason: codeOf(error) } })
      return
    }
    if (t !== trackGeneration || key !== sessionKey(session.getSnapshot())) return
    const body = { vault, tokenIds }
    if (!runtime.validateRequest('enroll', body)) { publish({ starting: null, enrollment: { vault, ok: false, reason: 'invalid_request' } }); return }
    pendingEnroll = body
    await sendPendingEnroll()
  }

  /**
   * The same session keeps what it shows, and so does a new one for the same
   * wallet and connector; another wallet starts from this browser's copy of
   * it, and a sign-out from nothing.
   */
  function changed() {
    const snapshot = session.getSnapshot(), scope = sessionKey(snapshot), before = view.scope
    const state = scope ? 'loading' : snapshot.kind === 'pending' ? 'checking' : 'signed_out'
    if (scope === before && (scope !== null || state === view.state)) return
    stopWork(); stopTracking(); stopListing(); nextAt = 0; lastCycleAt = -Infinity; historyTries = 0; after = null; nextAfter = null; listTries = 0; listDueAt = null
    const kept = snapshot.kind !== 'signed_in' ? null : before && scope && sameWallet(before, scope) ? view : deps.cache?.load(snapshot.owner)
    publish({ scope, state, enrollments: kept?.enrollments ?? [], cards: kept?.cards ?? [], reason: null, busy: false, more: false, paging: false, receivedAt: null,
      sequences: NO_SEQUENCES, starting: null, enrollment: null })
    if (scope) void refresh()
  }
  /** The next read at its time: at once when it is due, else on a timer for it. */
  function resume() {
    if (clock.monoMs() >= nextAt) void refresh()
    else { stopTimer?.(); stopTimer = clock.setTimer(() => { stopTimer = null; void refresh() }, nextAt - clock.monoMs()) }
  }
  // The first view paints where the session already stands, from this browser's copy when signed in: never a signed-out
  // line for a frame before its start. Nothing is read before it.
  changed()
  return {
    getSnapshot: () => view,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    // Started again (a view shown again, or React's development double mount), the same session keeps what it showed and
    // reads at its time (a read the last stop cut off was already due, so it goes at once); a listing the stop cut off goes
    // again at once when the cards are current.
    start() {
      running = true; const off = session.subscribe(changed)
      changed(); if (view.scope && !view.busy) resume()
      listWhenDue()
      return () => { running = false; off(); stopWork(); stopTracking(); stopListing(); publish({ busy: false, paging: false, starting: null }) }
    },
    refresh,
    enroll: (body: PerformanceRequests['enroll']) => cycle(body),
    track,
    visibilityChanged() {
      if (!deps.visible()) {
        // Hidden: nothing is read, and what is shown stays.
        stopWork(); stopTracking()
        publish({ busy: false, paging: false, starting: null })
        return
      }
      if (view.scope) listWhenDue()
      // The owner came back: failed history is asked once more as soon as the floor allows, and counted afresh.
      if (view.state === 'unavailable') { historyTries = 0; nextAt = Math.min(nextAt, lastCycleAt + HISTORY_FLOOR_MS) }
      resume()
    },
    /** The next page of positions, or the first after the last. Inside the refresh floor it waits for the scheduled read. */
    nextPage() {
      if (view.busy || view.paging || !view.more) return
      after = nextAfter
      publish({ paging: true })
      if (clock.monoMs() >= nextAt) void refresh()
    },
  }
}

// ---- presentation --------------------------------------------------------------

const grouped = (fixed: string) => {
  const [whole, fraction] = fixed.split('.')
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction === undefined ? '' : `.${fraction}`}`
}

/**
 * A USD decimal string as money, from the string itself: "$1,234.57",
 * "-$1.50". Two places, rounded half to even; a real amount under a cent keeps
 * six places so it never reads as $0.00, and one smaller still says so.
 * Null for anything that is not a decimal string.
 */
export function formatMetricUsd(text: string): string | null {
  const value = parseDecimal(text)
  if (!value) return null
  if (value.coefficient === 0n) return '$0.00'
  const negative = value.coefficient < 0n
  const magnitude = negative ? text.slice(1) : text
  let fixed = toFixed(magnitude, 2) as string
  if (fixed === '0.00') {
    fixed = toFixed(magnitude, 6) as string
    if (fixed === '0.000000') return negative ? '>-$0.000001' : '<$0.000001'
  }
  return `${negative ? '-' : ''}$${grouped(fixed)}`
}

/** A percentage decimal string to two places: "328.50%", "-12.34%"; a real rate under 0.01% says so. Null for anything else. */
export function formatMetricPercent(text: string): string | null {
  const value = parseDecimal(text)
  if (!value) return null
  if (value.coefficient === 0n) return '0.00%'
  const negative = value.coefficient < 0n
  const fixed = toFixed(negative ? text.slice(1) : text, 2) as string
  if (fixed === '0.00') return negative ? '>-0.01%' : '<0.01%'
  return `${negative ? '-' : ''}${grouped(fixed)}%`
}

/** The exact decimal, trailing zeros dropped: "9.000000000000000000" is "9". For titles. */
export function exactDecimal(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
}

/** Unix seconds as fixed UTC text, the same on every device. */
export const utcSeconds = (seconds: number) => `${new Date(seconds * 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')} UTC`

export const PERFORMANCE_STATUS_TEXT: Readonly<Record<TrackedCard['performanceStatus'], string>> = {
  available: 'Current',
  measuring: 'Measuring',
  partial: 'Partial',
  stale: 'Not current',
  unavailable: 'Unavailable',
}

export const ENROLLMENT_STATUS_TEXT: Readonly<Record<Enrollment['status'], string>> = {
  queued: 'Tracking requested',
  tracking: 'Tracking',
  stale: 'Tracking, not current',
  blocked: 'Tracking stopped',
}

/** Under a position that waits for its first figures, on Positions: plain words (2026-09-27, round 5 review, the owner's point 6). */
export const ENROLLMENT_REASON_TEXT: Readonly<Record<Enrollment['reason'], string>> = {
  awaiting_baseline: 'Waiting for its first figures.',
  forward_collection: 'Gathering its figures.',
  collection_failed: 'Its latest figures couldn’t be read.',
  baseline_reorged: 'Its first figures have to be read again.',
}

export const COLLECTION_TEXT: Readonly<Record<TrackedCard['collectionReason'], string>> = {
  forward_observations_only: 'Collecting forward observations',
  latest_read_failed: 'The latest collection read failed',
  snapshot_stale: 'The latest snapshot is out of date',
  canonical_replay_required: 'History is being replayed from the canonical chain',
  baseline_reorged: 'The first observation left the canonical chain',
}

const REASON_TEXT: Readonly<Record<string, string>> = {
  snapshot_stale: 'The latest snapshot is out of date.',
  income_coverage_incomplete: 'Fee income coverage is incomplete.',
  capital_coverage_incomplete: 'Capital coverage is incomplete.',
  fee_or_cost_price_unqualified: 'A fee or cost has no qualified price.',
  price_source_quality_not_qualified: 'The price source is not qualified.',
  price_history_missing: 'Price history is missing.',
  measuring_first_24h: 'The first 24 hours are still being measured.',
  zero_time_weighted_capital: 'Time-weighted capital is zero.',
  epoch_not_found: 'This tracked position was not found.',
  full_l2_cost_unqualified: 'The full network cost is not qualified.',
  operator_cost_evidence_incomplete: 'Operator cost evidence is incomplete.',
}

/** A performance reason code as a sentence, for titles. An unknown code is spelled out, never dropped. */
export const performanceReasonText = (code: string) => REASON_TEXT[code] ?? `${code.replaceAll('_', ' ')}.`

const WALLET_READ = new Set(['wallet_action_busy', 'wallet_action_expired', 'wallet_timeout', 'chain_changed', 'invalid_block', 'wallet_read_failed',
  'invalid_wallet_reply', 'invalid_wallet_quantity', 'invalid_sequence_reply'])

/** What Start tracking says when it could not start or was refused, in words; the code stays in the title and data attributes. */
export function enrollmentFailureText(code: string): string {
  if (code === 'performance_subject_not_admitted') return 'This automation can’t be tracked.'
  if (code === 'performance_enrollment_limit') return 'This wallet already tracks the most automations it can.'
  if (code === 'invalid_request') return 'This sequence is already tracked with other positions. Nothing changed.'
  if (code === 'session_required' || code === 'csrf_invalid' || code === 'account_unsupported') return 'Your sign-in is being checked. Nothing changed.'
  if (code === 'unqualified_sequence' || code === 'deployment_identity_changed' || code === 'invalid_address') return 'That address isn’t a sequence this wallet owns. Nothing was sent.'
  if (code === 'sequence_members_incomplete' || code === 'sequence_members_unbounded' || code === 'invalid_position_identity') return 'This sequence’s positions couldn’t all be read. Nothing was sent.'
  if (code === 'connect_robinhood_wallet' || code === 'wallet_identity_changed') return 'Your wallet account or network changed. Nothing was sent.'
  if (WALLET_READ.has(code)) return 'Your wallet couldn’t read this sequence just now. Nothing was sent.'
  return 'Tracking couldn’t start just now. Nothing changed.'
}
