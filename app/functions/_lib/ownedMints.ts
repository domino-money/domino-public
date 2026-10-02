/**
 * The mint block and transaction of each of a wallet's Domino positions (RPC-SPEC §2.5.1, D4), for the fees history's
 * hints (src/lib/fees/mintHints.ts): the owner's SetupMinted logs, walked at the edge from Domino's node, which keeps
 * every log. The list's ids come from DominoSetupV1's state (walletPositions.ts operationIds); this walk only adds when
 * each was minted, best effort: a walk that fails leaves the answer with the mints kept before.
 *
 * Per owner, under a digest of the address (never the address in a URL, even an internal one), the walk keeps what it
 * found for a week: the block it read to, every id it named and their mints. The next walk reads the logs from shortly
 * before that block only (walletPositions.ts mintedIds' `known`), so a cold walk from DominoSetupV1's deployment (some
 * 8.5 million blocks, two POSTs of 50 windows) is paid once per owner and data centre. 2026-10-02 (review finding 13):
 * a walk that stopped at MAX_POSITIONS is kept too (its ids are the newest up to its block); only one cut short by its
 * byte budget is not.
 *
 * 2026-10-02 (review finding 12): the list does not wait for a slow walk. An answer waits at most MINT_WALK_WAIT_MS for
 * it (a warm walk, one POST, fits); past that it answers with the mints kept before, and the walk goes on under the
 * invocation's waitUntil and keeps what it found for the next answer. One walk per owner runs at a time in an isolate.
 */
import { HASH, SETUP_DEPLOY_BLOCK, type AnswerCache, type Budget, type OwnedDeps } from './owned'
import { SHARED_STALE_MS, outlast } from './sharedWork'
import { MAX_POSITIONS, mintedIds, type MintedAt, type MintedMemory } from './walletPositions'

/** The kept entry's format; bumping it retires every entry. */
export const MINTS_VERSION = 'm1'
/** How long a walk's result is kept per owner. */
export const MINTS_KEEP_SECONDS = 7 * 24 * 3600
/** How long an answer waits for its walk before it answers with the mints kept before (the walk goes on). */
export const MINT_WALK_WAIT_MS = 2_500

/** What a walk keeps per owner: the block it read up to, the ids it named (newest first) and their mints. */
export interface KeptMints {
  block: number
  ids: string[]
  mints: MintedAt[]
}

const ID = /^[1-9]\d{0,77}$/
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** `${origin}/api/owned/v2/cache/mints/<sha256('owned-mints/m1|' + owner)>`. */
export async function mintsKey(origin: string, owner: string): Promise<string> {
  return `${origin}/api/owned/v2/cache/mints/${await sha256(`owned-mints/${MINTS_VERSION}|${owner}`)}`
}

/** One mint as a hint may carry it: a canonical id, a block after DominoSetupV1's deployment and a transaction hash. */
export function isMint(value: unknown): value is MintedAt {
  if (!isRecord(value) || Object.keys(value).length !== 3) return false
  const { id, block, tx } = value
  return typeof id === 'string' && ID.test(id) && typeof block === 'number' && Number.isSafeInteger(block) && block >= SETUP_DEPLOY_BLOCK && typeof tx === 'string' && HASH.test(tx) && tx === tx.toLowerCase()
}

/** A kept entry checked field by field; null for anything else. */
export function keptMintsOf(value: unknown): KeptMints | null {
  if (!isRecord(value) || Object.keys(value).sort().join() !== 'block,ids,mints') return null
  const { block, ids, mints } = value
  if (typeof block !== 'number' || !Number.isSafeInteger(block) || block < SETUP_DEPLOY_BLOCK) return null
  if (!Array.isArray(ids) || ids.length > MAX_POSITIONS || !ids.every((id) => typeof id === 'string' && ID.test(id)) || new Set(ids).size !== ids.length) return null
  if (!Array.isArray(mints) || mints.length > MAX_POSITIONS || !mints.every(isMint)) return null
  return { block, ids: [...ids], mints: mints.map(({ id, block: at, tx }) => ({ id, block: at, tx })) }
}

/** `found` and `kept` as one list, one mint per id (a new one first), only of `ids`, newest block first. */
export function mergedMints(found: readonly MintedAt[], kept: readonly MintedAt[], ids: ReadonlySet<string>): MintedAt[] {
  const byId = new Map<string, MintedAt>()
  for (const mint of [...found, ...kept]) if (ids.has(mint.id) && !byId.has(mint.id)) byId.set(mint.id, { id: mint.id, block: mint.block, tx: mint.tx })
  return [...byId.values()].sort((a, b) => b.block - a.block || (BigInt(b.id) > BigInt(a.id) ? 1 : -1))
}

/** A walk on its way per owner in this isolate (by its key), and when it began: a second answer joins it (sharedWork.ts). */
const walking = new Map<string, { done: Promise<{ mints: MintedAt[]; capped: boolean }>; started: number }>()

/** Tests: forget the walks on their way. */
export function resetMintWalks(): void {
  walking.clear()
}

/**
 * The owner's mints up to `head`: the kept walk's, and the logs since its block. Kept again unless the walk stopped short
 * on its byte budget (walletPositions.ts mintedIds' `incomplete`); one capped at MAX_POSITIONS is kept with its newest
 * ids. Never throws: a walk that fails answers the kept mints.
 *
 * With `waitUntil` (a Pages Function's), the answer waits for the walk at most `waitMs`, then takes the mints kept before
 * while the walk goes on under waitUntil (it keeps its result for the next answer); a walk of the same owner already on
 * its way in this isolate is joined rather than started again. Without it, the walk is waited for whole, as before.
 */
export async function walkMints(deps: OwnedDeps, owner: string, head: number, cache: AnswerCache | null, origin: string, waitUntil?: (work: Promise<unknown>) => void, waitMs = MINT_WALK_WAIT_MS, listed?: ReadonlySet<string>): Promise<{ mints: MintedAt[]; capped: boolean }> {
  const name = await mintsKey(origin, owner)
  const key = cache ? new Request(name) : null
  let kept: KeptMints | null = null
  if (cache && key) {
    try {
      const entry = await cache.match(key)
      kept = entry ? keptMintsOf(await entry.json()) : null
    } catch {
      kept = null
    }
  }
  // 2026-10-02 (RPC fix round 2: the list's refresh every 30 s): every listed position's mint is kept already, so a walk
  // could add nothing (an answer carries the listed positions' mints only) and none is made: a refresh reads no log.
  const held = kept
  if (held && listed && [...listed].every((id) => held.mints.some((mint) => mint.id === id))) return { mints: held.mints, capped: held.ids.length >= MAX_POSITIONS }
  const walk = async (): Promise<{ mints: MintedAt[]; capped: boolean }> => {
    try {
      // A node behind the kept block reads from where it stands; the kept ids stay.
      const known: MintedMemory | null = kept ? { block: Math.min(kept.block, head), ids: kept.ids.map((id) => BigInt(id)) } : null
      const budget: Budget = { calls: 0, started: deps.now(), logBytes: 0 }
      const walked = await mintedIds(deps, budget, owner, head, known)
      const ids = walked.ids.map(String)
      const mints = mergedMints(walked.mints, kept?.mints ?? [], new Set(ids))
      if (!walked.incomplete && cache && key) {
        const entry = new Response(JSON.stringify({ block: head, ids, mints } satisfies KeptMints), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${MINTS_KEEP_SECONDS}` } })
        const stored = cache.put(key, entry).catch(() => undefined)
        if (waitUntil) waitUntil(stored)
        else await stored
      }
      return { mints, capped: walked.capped }
    } catch {
      return { mints: kept?.mints ?? [], capped: false }
    }
  }
  if (!waitUntil) return walk()
  const at = deps.now()
  const running = walking.get(name)
  const entry = running && at - running.started <= SHARED_STALE_MS ? running : { done: walk(), started: at }
  if (entry !== running) {
    walking.set(name, entry)
    const clear = () => {
      if (walking.get(name) === entry) walking.delete(name)
    }
    void entry.done.then(clear, clear)
    waitUntil(entry.done)
  }
  const done = await outlast(entry.done, waitMs)
  return done ? done.value : { mints: kept?.mints ?? [], capped: false }
}
