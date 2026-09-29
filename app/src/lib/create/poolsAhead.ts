/**
 * New position's pools read, asked the moment a token is chosen, and its answer
 * kept for the flow (speed wave, 2026-09-28; study items 27 and 30).
 *
 * Before, step 1 did everything after a token was chosen one thing after the
 * other: the token read, then the list mounted, then the pool hints (one
 * token-pairs GET, poolHints.ts), then the pools read. The pools read needs only
 * the token's address, which is known the moment the person chooses it, so the
 * search starts it here beside the token read (`startCreatePools`), and the list
 * takes that same read when it mounts (`readCreatePools`) instead of starting its
 * own. The rows still appear only once the token read has answered, as before:
 * the list is not drawn earlier, it only finds its answer already on the way.
 *
 * And the list forgot what it had read: Change pool, or the same token chosen
 * again, mounted it afresh and read the pools again (1.6 s typical, up to 5 s).
 * An answer that came back ok is kept for this flow, for a minute at most
 * (KEEP_MS), and a list mounted for the same question in that time shows it at
 * once, with no read. A failed or cancelled answer is never kept: the list's own
 * quiet re-ask reads again, as before. The range step still reads a price again
 * once it is 5 minutes old (RangeStep.tsx), whatever the list's age.
 *
 * The read is exactly the list's own (PoolPicker.tsx, variant "create"): the
 * hints for at most 2.5 s, the request that names the featured pools and the
 * hints, and one restart of the same logical read when the catalogue's revision
 * changed. Nothing here is shown, and nothing is stored outside this page's
 * memory: the flow's end (the Journey leaving) forgets it all.
 *
 * A read nobody waits for any more is cancelled: a choice of another token
 * cancels the reads of earlier choices that no list has taken yet, a choice
 * whose token read failed for good cancels its own (`dropCreatePools`), and a
 * list that leaves while its read is still out cancels it unless it is the
 * current choice's.
 */
import type { AddressKey } from '../read/screens/identity'
import { hintsWithin, poolHints } from '../read/screens/poolHints'
import { usablePoolsRequest } from '../read/screens/poolsList'
import { readWithin, type ScreenOutcome } from '../read/screens/screenRead'
import type { ReadSource } from '../read/types'

/** What the list does with the read: its outcome, and whether it was restarted once for a new catalogue revision. */
export type PoolsAnswer = { outcome: ScreenOutcome<'pools'>; restarted: boolean }

/** How long an ok answer is shown again without a read. */
export const KEEP_MS = 60_000

interface Entry {
  source: ReadSource
  controller: AbortController
  result: Promise<PoolsAnswer>
  /** Set once the read settled ok, with the time it did; a failed read leaves the map instead. */
  kept: { answer: PoolsAnswer; at: number } | null
  /** Lists waiting for it now. */
  holders: number
}

const entries = new Map<string, Entry>()
/** The question of the latest choice, whose read is left running when a list leaves it. */
let current: string | null = null

/** The list's question: the token and the second asset, as PoolPicker keys it. */
export const poolsQuestion = (token: AddressKey, paired: AddressKey | null) => `${token}:${paired ?? ''}`

const now = () => Date.now()

function live(question: string, source: ReadSource): Entry | null {
  const entry = entries.get(question)
  if (!entry || entry.source !== source) return null
  if (entry.kept && now() - entry.kept.at >= KEEP_MS) {
    entries.delete(question)
    return null
  }
  return entry
}

function cancel(question: string, entry: Entry) {
  if (entries.get(question) === entry) entries.delete(question)
  entry.controller.abort()
}

/** Cancels every read still out that no list waits for, but the one for `keep`. */
function cancelIdle(keep: string | null) {
  for (const [question, entry] of entries) if (!entry.kept && entry.holders === 0 && question !== keep) cancel(question, entry)
}

/** The list's own read (PoolPicker.tsx before 2026-09-28), for one token and second asset. */
async function poolsRead(source: ReadSource, token: AddressKey, paired: AddressKey | null, signal: AbortSignal): Promise<PoolsAnswer> {
  // New position names the pools worth verifying first; hints that are slow or missing leave the plain read,
  // never a longer wait (poolHints.ts).
  const request = usablePoolsRequest(token, paired, await hintsWithin(token, paired, signal))
  // Cancelled while the hints were asked: nothing is read at all.
  if (signal.aborted) return { outcome: { route: 'pools', state: 'aborted', provenance: { transport: source.transport, contract: null, receivedAt: now(), attempts: 0 } }, restarted: false }
  let outcome = await readWithin(source, 'pools', request, { signal })
  let restarted = false
  if (outcome.state === 'restart_required' && outcome.code === 'catalogue_revision_changed') {
    restarted = true
    // Same logical read, so the restart keeps the first attempt's deadline instead of starting a fresh screen budget.
    outcome = await readWithin(source, 'pools', request, { signal, deadlineAt: outcome.provenance.deadlineAt })
  }
  return { outcome, restarted }
}

function begin(question: string, source: ReadSource, token: AddressKey, paired: AddressKey | null): Entry {
  const controller = new AbortController()
  const read = poolsRead(source, token, paired, controller.signal)
  const entry: Entry = {
    source,
    controller,
    kept: null,
    holders: 0,
    result: read.then(
      (answer) => {
        const mine = entries.get(question) === entry
        if (mine && answer.outcome.state === 'ok' && !controller.signal.aborted) entry.kept = { answer, at: now() }
        else if (mine) entries.delete(question)
        return answer
      },
      (error: unknown) => {
        if (entries.get(question) === entry) entries.delete(question)
        throw error
      },
    ),
  }
  // A read that throws is answered to its lists by readCreatePools; nobody else waits for it.
  entry.result.catch(() => undefined)
  entries.set(question, entry)
  return entry
}

function entryFor(source: ReadSource, token: AddressKey, paired: AddressKey | null): Entry {
  const question = poolsQuestion(token, paired)
  return live(question, source) ?? begin(question, source, token, paired)
}

/**
 * A token was chosen: its pools read starts now, beside the token read, unless an answer for it is kept or on its way.
 * Earlier choices' reads that no list has taken are cancelled.
 */
export function startCreatePools(source: ReadSource, token: AddressKey, paired: AddressKey | null): void {
  current = poolsQuestion(token, paired)
  cancelIdle(current)
  entryFor(source, token, paired)
}

/** The choice's token read failed for good, or the flow ended: nothing waits for a read that no list has taken. */
export function dropCreatePools(): void {
  current = null
  cancelIdle(null)
}

/** The flow ended: its reads still out are cancelled and its kept answers forgotten. */
export function forgetCreatePools(): void {
  dropCreatePools()
  entries.clear()
}

/** The kept ok answer for this question, when there is one, for a list's first paint. */
export function keptCreatePools(source: ReadSource, token: AddressKey, paired: AddressKey | null): PoolsAnswer | null {
  return live(poolsQuestion(token, paired), source)?.kept?.answer ?? null
}

/**
 * The list's pools read: the kept answer, the read already on its way, or a new one. Null once `signal` aborts first;
 * the read then goes on only while it is the current choice's or another list waits for it.
 */
export function readCreatePools(source: ReadSource, token: AddressKey, paired: AddressKey | null, signal: AbortSignal): Promise<PoolsAnswer | null> {
  if (signal.aborted) return Promise.resolve(null)
  const question = poolsQuestion(token, paired)
  const entry = entryFor(source, token, paired)
  if (entry.kept) return Promise.resolve(entry.kept.answer)
  entry.holders += 1
  return new Promise((done) => {
    let held = true
    const release = () => {
      if (!held) return
      held = false
      entry.holders -= 1
      signal.removeEventListener('abort', leave)
    }
    const leave = () => {
      release()
      if (!entry.kept && entry.holders === 0 && question !== current) cancel(question, entry)
      done(null)
    }
    signal.addEventListener('abort', leave, { once: true })
    void entry.result.then(
      (answer) => {
        if (!held) return
        release()
        done(answer)
      },
      () => {
        if (!held) return
        release()
        done(null)
      },
    )
  })
}

/**
 * A token is pointed at in the search (highlighted, or a pasted address offered): its token-pairs list, which the
 * hints are made from, is asked now, so it is in hand when the token is chosen. One GET per token, shared with the
 * artwork and kept 30 s (lib/tokenArtwork.ts); nothing is shown from it.
 */
export function warmPoolHints(token: AddressKey): void {
  void poolHints(token, null).catch(() => undefined)
}
