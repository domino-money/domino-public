import { useEffect, useSyncExternalStore } from 'react'
import { postAutomation, type RouteOptions } from './edge/chainRoutes'
import type { RelayAnswer } from './fees/types'

/**
 * Which of Domino's three features a position is in (the owner's product,
 * 2026-09-24): a plain position, Auto-compound or Domino-compound, and for the
 * two automations whether the sequence is paused or active. Read from the
 * chain (functions/_lib/automation.ts scanAutomation: the NFT's
 * PositionManager subscriber, and when it is a sequence vault the factory
 * made, that vault's policy), for Positions' rows, a position's page and the
 * automation page's picker.
 *
 * 2026-09-25 to 2026-10-01: the page read it itself, from the chain's public
 * RPC, with the scan the site's route ran, because that RPC answered 429 to
 * every call from Cloudflare's edge.
 *
 * RPC-SPEC D3 (2026-10-01, the owner's rule: nothing is read from a public
 * RPC): the page asks the site's own fixed route again, POST
 * /api/automation/v1/state (lib/edge/chainRoutes.ts), which runs that same scan
 * at the edge against Domino's own node. The wallet's list and a position's
 * state carry the same features in their own answers (noteAutomation). The
 * answer still passes this module's parser, field by field. read-v4's
 * sequence snapshot cannot say this (no subscriber, no policy, and pinned to
 * the finalized block), so it stays where it is: the money code's fallback.
 *
 * The screens ask by id, and the ids asked in the same moment go out in one
 * read: a list of positions is one read. An answer is kept a few seconds
 * in memory (never in the browser's storage). A read that fails is not
 * retried and says nothing: the screens then show no state, only the way to
 * Automate.
 *
 * 2026-10-02 (review of the RPC switch, findings 7 and 15): the routes keep
 * their answers at the edge (the list 40 s, the automation route 15 s, the
 * state route 10 s), so an answer read just before the owner's own Turn on,
 * Pause or Set up automation can arrive after it. Each answer is taken with its
 * block, and one older than the state shown is never drawn over it; a state the
 * owner's own confirmed action set (noteAutomation) holds against every answer
 * for ACTION_HOLD_MS, past the longest of those caches, and the next answer
 * after that is drawn as usual.
 */

export type AutomationMode = 'compound' | 'domino'

/** One position's automation, as the scan answers it. `other`: a subscriber that is not Domino's, of which nothing is said. */
export type PositionAutomation =
  | { tokenId: string; automation: 'plain' }
  | { tokenId: string; automation: 'other' }
  | SequenceAutomation

/** A position that is the root of one of Domino's sequences. */
export interface SequenceAutomation {
  tokenId: string
  automation: AutomationMode
  paused: boolean
  active: boolean
  vault: string
}

export interface AutomationAnswer {
  block: number
  positions: PositionAutomation[]
}

/** What a screen has for one position: on its way, its state, or nothing to say (the read failed, or this build reads no chain). */
export type AutomationView = { phase: 'loading' } | { phase: 'ready'; state: PositionAutomation } | { phase: 'unknown' }

/** The most ids one read names (the scan's own limit, functions/_lib/automation.ts MAX_IDS). */
export const MAX_AUTOMATION_IDS = 100
/** How long an answer is kept before a screen that opens asks again. */
const KEEP_MS = 10_000
/**
 * How long a state the owner's own confirmed action set holds against the routes' answers: past the longest time a
 * route keeps an answer from before the action (functions/_lib/owned.ts CACHE_SECONDS, 25 s), with a margin.
 */
export const ACTION_HOLD_MS = 45_000
const ID = /^[1-9]\d{0,77}$/
const ADDRESS = /^0x[0-9a-f]{40}$/

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const keysAre = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).sort().join() === [...keys].sort().join()

function entry(value: unknown): PositionAutomation | null {
  if (!isRecord(value) || typeof value.tokenId !== 'string' || !ID.test(value.tokenId)) return null
  const { tokenId, automation } = value
  if (automation === 'plain' && keysAre(value, ['tokenId', 'automation'])) return { tokenId, automation }
  if (automation === 'other' && keysAre(value, ['tokenId', 'automation'])) return { tokenId, automation }
  if ((automation === 'compound' || automation === 'domino') && keysAre(value, ['tokenId', 'automation', 'paused', 'active', 'vault'])) {
    const { paused, active, vault } = value
    if (typeof paused !== 'boolean' || typeof active !== 'boolean' || typeof vault !== 'string' || !ADDRESS.test(vault) || (paused && active)) return null
    return { tokenId, automation, paused, active, vault }
  }
  return null
}

/** The scan's answer checked field by field: exactly the ids asked, in their order. Null for anything else. */
export function parseAutomationAnswer(value: unknown, ids: readonly string[]): AutomationAnswer | null {
  if (!isRecord(value) || !keysAre(value, ['block', 'positions']) || !Number.isSafeInteger(value.block) || (value.block as number) < 0) return null
  if (!Array.isArray(value.positions) || value.positions.length !== ids.length) return null
  const positions: PositionAutomation[] = []
  for (const [index, item] of (value.positions as unknown[]).entries()) {
    const parsed = entry(item)
    if (!parsed || parsed.tokenId !== ids[index]) return null
    positions.push(parsed)
  }
  return { block: value.block as number, positions }
}

/** Whether this build reads the chain: the deployable builds, and the wallet test builds whose browsers answer the site's routes from a fake chain. */
function chainRead(): boolean {
  return __DOMINO_DEPLOYABLE__ || __DOMINO_TEST_HOOKS__
}

const U256 = 1n << 256n

/**
 * One read of `ids` (distinct, at most MAX_AUTOMATION_IDS) through the site's route (RPC-SPEC §2.5.4); null when it could
 * not be read. `post` is the route's client (lib/edge/chainRoutes.ts); tests hand in their own.
 */
export async function readAutomation(ids: readonly string[], post: (ids: readonly string[], options?: RouteOptions) => Promise<RelayAnswer<unknown>> = postAutomation): Promise<AutomationAnswer | null> {
  if (!chainRead() || ids.length === 0 || ids.length > MAX_AUTOMATION_IDS || new Set(ids).size !== ids.length) return null
  if (!ids.every((id) => ID.test(id) && BigInt(id) < U256)) return null
  try {
    const answer = await post(ids)
    // Taken only when every field is what the parser expects: exactly the ids asked, in their order.
    return answer.ok ? parseAutomationAnswer(answer.value, ids) : null
  } catch {
    return null
  }
}

const LOADING: AutomationView = { phase: 'loading' }
const UNKNOWN: AutomationView = { phase: 'unknown' }
/**
 * What each position's screens show: its view, when it was set, the block of the answer it came from (null: none, or
 * the owner's own action), and when the owner's own action set it (0: an answer did).
 */
const known = new Map<string, { view: AutomationView; at: number; block: number | null; acted: number }>()

/**
 * Whether an answer read at `block` may be drawn for `tokenId` now: not over a state the owner's own action set less
 * than ACTION_HOLD_MS ago, and not over one from a later block.
 */
function answerTakes(tokenId: string, block: number, now: number): boolean {
  const kept = known.get(tokenId)
  if (!kept) return true
  if (kept.acted > 0) return now - kept.acted >= ACTION_HOLD_MS
  return kept.block === null || block >= kept.block
}
const listeners = new Set<() => void>()
const queued = new Set<string>()
let flushing: ReturnType<typeof setTimeout> | null = null

function flush() {
  flushing = null
  const ids = [...queued]
  queued.clear()
  for (let at = 0; at < ids.length; at += MAX_AUTOMATION_IDS) {
    const part = ids.slice(at, at + MAX_AUTOMATION_IDS)
    void readAutomation(part).then((answer) => {
      const now = Date.now()
      for (const [index, id] of part.entries()) {
        const kept = known.get(id)
        const before = kept?.view
        const found = answer?.positions[index]
        // An answer from before the owner's own action, or older than the state shown, is not drawn (answerTakes).
        if (found && answer && answerTakes(id, answer.block, now)) known.set(id, { view: { phase: 'ready', state: found }, at: now, block: answer.block, acted: 0 })
        else if (found && kept) continue
        // A later read that fails keeps a state already on screen.
        else known.set(id, { view: before?.phase === 'ready' ? before : UNKNOWN, at: now, block: kept?.block ?? null, acted: kept?.acted ?? 0 })
      }
      for (const listener of listeners) listener()
    })
  }
}

/** Asks for `tokenId` with the others asked in the same moment, unless an answer younger than KEEP_MS is kept or one is on its way. */
function want(tokenId: string) {
  if (!ID.test(tokenId) || queued.has(tokenId)) return
  const kept = known.get(tokenId)
  if (kept && (kept.view.phase === 'loading' || Date.now() - kept.at < KEEP_MS)) return
  if (!kept) known.set(tokenId, { view: LOADING, at: Date.now(), block: null, acted: 0 })
  queued.add(tokenId)
  flushing ??= setTimeout(flush, 0)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * The state the owner's own confirmed action set, shown at once: a sequence the automation page just created
 * (SequenceCreate.tsx), or one just turned on or paused (SequenceSwitch.tsx), so Positions shows it without waiting for
 * the next read. It holds against the routes' answers for ACTION_HOLD_MS (they may be from before the action), then the
 * next answer is drawn as usual. Asked again after KEEP_MS.
 */
export function noteAutomation(state: PositionAutomation) {
  const now = Date.now()
  known.set(state.tokenId, { view: { phase: 'ready', state }, at: now, block: null, acted: now })
  for (const listener of listeners) listener()
}

/**
 * The features a route's answer carried, read at `block` (the wallet's list, a position's state: lib/walletPositions.ts,
 * lib/fees/client.ts), shown at once where answerTakes lets them: never over the owner's own action of the last
 * ACTION_HOLD_MS, nor over a state from a later block.
 */
export function noteAnswered(states: readonly PositionAutomation[], block: number) {
  const now = Date.now()
  let drawn = false
  for (const state of states) {
    if (!answerTakes(state.tokenId, block, now)) continue
    known.set(state.tokenId, { view: { phase: 'ready', state }, at: now, block, acted: 0 })
    drawn = true
  }
  if (drawn) for (const listener of listeners) listener()
}

/** For tests: what the screens would show for `tokenId` now (undefined: nothing asked or noted). */
export const automationShown = (tokenId: string): AutomationView | undefined => known.get(tokenId)?.view

/** For tests: forget every state shown, asked or noted. */
export function forgetAutomation(): void {
  known.clear()
  queued.clear()
}

/** One position's automation, asked when a screen shows it (null asks nothing). */
export function useAutomation(tokenId: string | null): AutomationView {
  useEffect(() => {
    if (tokenId) want(tokenId)
  }, [tokenId])
  return useSyncExternalStore(
    subscribe,
    () => (tokenId ? (known.get(tokenId)?.view ?? LOADING) : UNKNOWN),
    () => LOADING,
  )
}

/** Paused as its policy says; Active when it is not paused and its permission over the NFT holds; Stopped when that permission was lost. */
export function automationWord(state: SequenceAutomation): string {
  return state.paused ? 'Paused' : state.active ? 'Active' : 'Stopped'
}
