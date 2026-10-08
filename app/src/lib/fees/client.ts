/**
 * The page's reads for a position's fees (DESIGN-V2 §15.4): a position NFT's state at one block, and its own ledger of
 * settlements (2026-10-02, RPC-SPEC §11.4: in place of the fees replay's log units).
 *
 * 2026-10-01 (RPC-SPEC, the owner's rule: nothing is read from a public RPC): asked of Domino's own chain routes again,
 * POST /api/fees/v1/state and (since 2026-10-02) /api/fees/v2/ledger (src/lib/edge/chainRoutes.ts), which the site's Pages Functions answer
 * from Domino's own Robinhood Chain node with the very relay code that ran in this page from 2026-09-25 on, when the
 * public RPC refused Cloudflare's edge. The browser sends no JSON-RPC and learns no node's address; every answer is
 * checked here field by field, as it was. A refusal or a source that is away is a calm `unavailable` (the card keeps
 * the unclaimed figure, or shows nothing), asked again by the store on its own schedule.
 *
 * Nothing is asked in a build that is not meant to reach the chain: the
 * fixture and bridge-test builds answer `unavailable` without a request (the
 * check is made inside each call, never when the module loads), and the
 * screens then show what they show without the history.
 *
 * The checks are answers.ts's.
 */
import { postLedger, postState } from '../edge/chainRoutes'
import { UNAVAILABLE, chainRead, checked, isLedgerResponse, isStateResponse } from './answers'
import { noteAnswered, parseAutomationAnswer } from '../automationState'
import { noteTokens } from '../chainTokens'
import type { LedgerMintHint, LedgerResponse, RelayAnswer, StateResponse } from './types'

export { isLedgerResponse, isStateResponse } from './answers'

/**
 * For tests: kept from when this context cached the relay's units itself; the edge keeps them now (RPC-SPEC §4.2). What
 * is forgotten since 2026-10-01: the ids asked fresh after an action (freshState).
 */
export function forgetChainMemory(): void {
  freshUntil.clear()
}

/**
 * Up to eight positions' ledgers (functions/_lib/feesLedger.ts), each with its state at the answer's block, checked field by
 * field. `fresh`: the page's state shows a settlement the ledger it has does not hold, so the route takes no answer it kept
 * from before it. Not shared between askers: the store asks each set of ids once at a time itself.
 */
export async function chainLedger(tokenIds: readonly string[], fresh = false, signal?: AbortSignal, mintHints?: readonly LedgerMintHint[]): Promise<RelayAnswer<LedgerResponse>> {
  if (!chainRead() || signal?.aborted) return UNAVAILABLE
  try {
    const answer = await postLedger(tokenIds, fresh, { signal }, mintHints)
    if (!answer.ok) return answer
    const value = answer.value as LedgerResponse
    // Every id asked, and only those.
    if (!isLedgerResponse(value) || value.positions.length !== tokenIds.length || value.positions.some((position) => !tokenIds.includes(position.tokenId))) return UNAVAILABLE
    for (const position of value.positions) if (position.ok) noteTokens(position.state.currencies)
    return checked(answer as RelayAnswer<LedgerResponse>, isLedgerResponse)
  } catch {
    return UNAVAILABLE
  }
}

/** Resolves with `work`'s answer, or with `fallback` as soon as `signal` aborts (the work itself goes on for whoever else waits on it). */
function unlessDropped<T>(work: Promise<T>, signal: AbortSignal | undefined, fallback: T): Promise<T> {
  if (!signal) return work
  return new Promise((resolve) => {
    const drop = () => resolve(fallback)
    signal.addEventListener('abort', drop, { once: true })
    void work.then((value) => {
      signal.removeEventListener('abort', drop)
      resolve(value)
    })
  })
}

/**
 * The /state reads on their way, by id set: a position page and its fees card ask the same ids at once, and share one
 * read. 2026-09-28 (speed wave B, item 43): with how many askers still wait for it (one with no signal waits for good),
 * and its own signal: once every asker has left, the request is dropped.
 */
const statesAsked = new Map<string, { answer: Promise<RelayAnswer<StateResponse>>; waiting: number; stop: AbortController }>()

/**
 * The position's features a /state read carried (item 17), for the chips, badges and cards that show them, and its tokens
 * (item 25), for Receipts. Taken only from an answer already checked; features that do not parse are left out.
 */
function noted(answer: RelayAnswer<StateResponse>): RelayAnswer<StateResponse> {
  if (!answer.ok) return answer
  for (const position of answer.value.positions) if (position.ok) noteTokens(position.currencies)
  const features: unknown = answer.value.automation
  const ids = Array.isArray(features) ? features.map((one: unknown) => (one && typeof one === 'object' ? (one as { tokenId?: unknown }).tokenId : null)) : null
  const parsed = ids && ids.every((id): id is string => typeof id === 'string') ? parseAutomationAnswer({ block: answer.value.block, positions: features }, ids) : null
  // 2026-10-02 (review findings 7 and 15): with the answer's block, so an answer from before the owner's action, or older
  // than the state shown, is not drawn over it (automationState.ts answerTakes).
  if (parsed) noteAnswered(parsed.positions, parsed.block)
  return answer
}

/**
 * The ids the owner just acted on (a Collect, a Close, a mint the page does not show yet), and until when their state is
 * asked fresh: the route keeps an answer 10 s, and the page must show the action's result at once (2026-10-01, the RPC
 * switch's integration).
 */
const freshUntil = new Map<string, number>()
/** How long after an action its position's state is asked fresh: past the page's second read (AFTER_ACTION_MS, 11 s). */
export const FRESH_AFTER_ACTION_MS = 15_000
/** After the owner's action on `tokenIds`: their state reads for the next FRESH_AFTER_ACTION_MS ask the route fresh. */
export function freshState(tokenIds: readonly string[]): void {
  const until = Date.now() + FRESH_AFTER_ACTION_MS
  for (const id of tokenIds) freshUntil.set(id, until)
}

/**
 * Up to eight positions at one block, asked of the state route, each with its feature (item 17). Two askers of the same
 * ids while a read is on its way share it; a read that has answered is never reused, so a page reading again after an
 * action gets the chain as it is then: the route keeps an answer 10 s, and a read of an id the owner just acted on asks
 * it fresh (freshState). `background` (a minute's refresh) is accepted and changes nothing since the switch to
 * Domino's own node (RPC-SPEC §4.2): there is no lane on the page to wait for.
 */
export async function chainState(tokenIds: readonly string[], signal?: AbortSignal, background = false): Promise<RelayAnswer<StateResponse>> {
  void background
  if (!chainRead() || signal?.aborted) return UNAVAILABLE
  const now = Date.now()
  const fresh = tokenIds.some((id) => (freshUntil.get(id) ?? 0) > now)
  // A fresh read shares only with another fresh one: a read on its way may have started before the action.
  const key = `${[...tokenIds].sort().join(',')}${fresh ? '|fresh' : ''}`
  let read = statesAsked.get(key)
  if (!read) {
    const stop = new AbortController()
    const answer = postState(tokenIds, true, { signal: stop.signal }, fresh)
      .then((answer) => noted(checked(answer as RelayAnswer<StateResponse>, isStateResponse)))
      .catch((): RelayAnswer<StateResponse> => UNAVAILABLE)
      .finally(() => statesAsked.get(key) === read && statesAsked.delete(key))
    read = { answer, waiting: 0, stop }
    statesAsked.set(key, read)
  }
  const shared = read
  shared.waiting += 1
  signal?.addEventListener(
    'abort',
    () => {
      if (--shared.waiting > 0) return
      shared.stop.abort()
      if (statesAsked.get(key) === shared) statesAsked.delete(key)
    },
    { once: true },
  )
  return unlessDropped(shared.answer, signal, UNAVAILABLE)
}

/**
 * 2026-09-28 (speed wave B, item 24): a position page's first read, started by Positions as soon as the route names the
 * NFT, before the page's chunk is in; the page's first ask takes it (takeWarmState) rather than reading again.
 */
let warm: { id: string; answer: Promise<RelayAnswer<StateResponse>>; at: number } | null = null
export function warmState(tokenId: string): void {
  if (warm?.id !== tokenId) warm = { id: tokenId, answer: chainState([tokenId]), at: Date.now() }
}
/** The read warmState started for `tokenId`, if it is the last one and at most WARM_MS old; taken once. */
export function takeWarmState(tokenId: string): Promise<RelayAnswer<StateResponse>> | null {
  const found = warm?.id === tokenId && Date.now() - warm.at < WARM_MS ? warm.answer : null
  warm = null
  return found
}
const WARM_MS = 5_000
