import { useEffect, useSyncExternalStore } from 'react'
import type { OwnedDeps } from '../../functions/_lib/owned'

/**
 * Which of Domino's three features a position is in (the owner's product,
 * 2026-09-24): a plain position, Auto-compound or Domino-compound, and for the
 * two automations whether the sequence is paused or active. Read from the
 * chain (functions/_lib/automation.ts scanAutomation: the NFT's
 * PositionManager subscriber, and when it is a sequence vault the factory
 * made, that vault's policy), for Positions' rows, a position's page and the
 * automation page's picker.
 *
 * 2026-09-25: the page reads it itself, from the chain's public RPC, with the
 * scan the site's route ran (through lib/chain/browser.ts, in the chain code
 * chunk lib/chain/chainCode.ts, loaded on the first read), exactly as the
 * wallet's positions and a position's state moved: the RPC answers 429 to
 * every call from Cloudflare's edge, so POST /api/automation/v1/state could
 * never answer in production. The route stays, tested; the page never asks
 * it. The scan's answer still passes this module's parser, field by field.
 *
 * The screens ask by id, and the ids asked in the same moment go out in one
 * read: a list of positions is one read. An answer is kept a few seconds
 * in memory (never in the browser's storage). A read that fails is not
 * retried and says nothing: the screens then show no state, only the way to
 * Automate.
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

/** Whether this build reads the chain: the deployable builds, and the wallet test builds whose browsers answer the RPC with a fake chain. */
function chainRead(): boolean {
  return __DOMINO_DEPLOYABLE__ || __DOMINO_TEST_HOOKS__
}

const U256 = 1n << 256n

/**
 * One read of `ids` (distinct, at most MAX_AUTOMATION_IDS) from the chain by the page; null when it could not be read.
 * `deps` is the page's own runtime (lib/chain/browser.ts); tests hand in fakes.
 */
export async function readAutomation(ids: readonly string[], deps?: OwnedDeps): Promise<AutomationAnswer | null> {
  if (!chainRead() || ids.length === 0 || ids.length > MAX_AUTOMATION_IDS || new Set(ids).size !== ids.length) return null
  if (!ids.every((id) => ID.test(id) && BigInt(id) < U256)) return null
  try {
    const code = await import('./chain/chainCode')
    const answer = await code.scanAutomation(deps ?? code.chainDeps(), ids.map((id) => BigInt(id)))
    // The scan's answer as the route would have sent it, taken only when every field is what the parser expects.
    return parseAutomationAnswer(JSON.parse(JSON.stringify(answer)), ids)
  } catch {
    // The chain could not be read, or the chain code's chunk could not be loaded (a file of an earlier deploy).
    return null
  }
}

const LOADING: AutomationView = { phase: 'loading' }
const UNKNOWN: AutomationView = { phase: 'unknown' }
const known = new Map<string, { view: AutomationView; at: number }>()
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
        const before = known.get(id)?.view
        const found = answer?.positions[index]
        // A later read that fails keeps a state already on screen.
        known.set(id, { view: found ? { phase: 'ready', state: found } : before?.phase === 'ready' ? before : UNKNOWN, at: now })
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
  if (!kept) known.set(tokenId, { view: LOADING, at: Date.now() })
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
 * A state read on chain elsewhere on this page, shown at once: the automation page's own read of the sequence it
 * just created (SequenceCreate.tsx), so Positions shows it without waiting for the next read. Asked again after KEEP_MS.
 */
export function noteAutomation(state: PositionAutomation) {
  known.set(state.tokenId, { view: { phase: 'ready', state }, at: Date.now() })
  for (const listener of listeners) listener()
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
