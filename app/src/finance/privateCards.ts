/**
 * What the wallet's two private cards, Receipts and Managed positions, share:
 * this browser's copy of what they showed, their shared start, how they ask
 * again after a failed read, and whether a new session is the same wallet.
 * One module, so the cards and the wallet island (which forgets the copies
 * once a session ends) load it as one chunk.
 *
 * This browser's copy: what a card last showed, kept so it paints at once
 * when it is opened again and then refreshes quietly (the owner, 2026-09-27,
 * round 6: the receipts blanked and came back on every refresh). Display
 * only: nothing is sent, decided or trusted from here, and each screen checks
 * what it reads back against its contract. One entry per name (a kind, a
 * chain and a wallet), versioned, with the time it was kept; one too old, too
 * large or unreadable is dropped, and every wallet's copies are forgotten once
 * a session ends (forgetPrivate). Storage that is blocked or full keeps
 * nothing, and the cards read as before.
 */
import { useMemo } from 'react'
import { useWalletIdentity } from '../lib/walletIdentity'

const PREFIX = 'domino.kept.v1.'
/** The most characters one entry may hold: a copy too large for it is not kept. */
const MAX_CHARS = 120_000

/** What was kept under `name`, when it is younger than `maxAgeMs` and `check` accepts it; else null, and the entry is dropped. */
export function readKept<T>(name: string, maxAgeMs: number, check: (data: unknown) => T | null): T | null {
  let value: T | null = null
  try {
    const raw = localStorage.getItem(PREFIX + name)
    if (raw === null) return null
    const entry = raw.length <= MAX_CHARS ? JSON.parse(raw) : null
    const age = Date.now() - entry?.at
    value = age >= 0 && age <= maxAgeMs ? check(entry.data) : null
  } catch {
    // Unreadable, or storage is blocked: dropped below, when it can be.
  }
  if (value === null) drop(name)
  return value
}

function drop(name: string) {
  try {
    localStorage.removeItem(PREFIX + name)
  } catch {
    // Blocked: there is nothing to drop.
  }
}

/** Keeps `data` under `name`, and says so; a copy too large to keep, or storage that refuses it, drops the entry instead. */
export function keep(name: string, data: unknown): boolean {
  try {
    const raw = JSON.stringify({ at: Date.now(), data })
    if (raw.length <= MAX_CHARS) {
      localStorage.setItem(PREFIX + name, raw)
      return true
    }
  } catch {
    // Blocked or full: nothing is kept.
  }
  drop(name)
  return false
}

/**
 * Keeps the first of `rows` under `name`: as many as fit, halved until the
 * copy is small enough. An empty list is kept too, so a list that emptied
 * never paints its last rows again (2026-09-28, round 6 review); storage that
 * refuses even that keeps nothing.
 */
export function keepFirst(name: string, rows: readonly unknown[]): void {
  while (!keep(name, rows) && rows.length) rows = rows.slice(0, rows.length >> 1)
}

/** The name of `owner`'s copy of one private card, on Robinhood Chain. */
export const walletName = (kind: 'receipts' | 'managed', owner: string) => `${kind}.4663.${owner}`

/**
 * Forgets every wallet's private copies, the receipts' and Managed positions',
 * and keeps the public token details. The wallet island calls it whenever a
 * session ends, the wallet is let go or its account is refused, on whichever
 * page that happens (2026-09-28, round 6 review: a sign-out anywhere but
 * Positions left them here): the copy is display only and never outlives a
 * sign-in, as execution-v1 asks of private data.
 */
export function forgetPrivate(): void {
  try {
    for (const key of Object.keys(localStorage)) if (/^domino\.kept\.v1\.(receipts|managed)\./.test(key)) localStorage.removeItem(key)
  } catch {
    // Blocked: nothing was kept.
  }
}

/**
 * A shared controller's start as each view's effect: told of every change of
 * the tab's visibility, started by the first view shown, and stopped once no
 * view has shown it for a moment, since a route change unmounts one view just
 * before it mounts the next. Views shown again find what it showed.
 */
export function sharedStart(controller: { start(): () => void; visibilityChanged(): void }): () => () => void {
  let views = 0, stop: (() => void) | undefined, parting: ReturnType<typeof setTimeout> | undefined
  document.addEventListener('visibilitychange', () => controller.visibilityChanged())
  return () => {
    clearTimeout(parting); views++
    stop ??= controller.start()
    return () => { if (!--views) parting = setTimeout(() => { stop?.(); stop = undefined }) }
  }
}

/**
 * While the wallet's session is being checked (`checking`), what `load` kept
 * for the wallet connected on Robinhood Chain, so the card paints at once;
 * null otherwise. Once signed in, the controller shows the same copy.
 */
export function useKeptWhileChecking<T>(checking: boolean, load: (owner: string) => T | null): T | null {
  const identity = useWalletIdentity()
  const owner = checking && identity.kind === 'connected' && identity.chainId === 4663 ? identity.address.toLowerCase() : null
  return useMemo(() => owner ? load(owner) : null, [owner, load])
}

// ---- Asking again ----------------------------------------------------------------------------------------------------
//
// How the private screens ask again on their own after a read failed: a few times, waiting twice as long each time, only
// while the tab is visible, and never for a failure that asking again cannot fix before a deploy. Showing the tab again, a
// new sign-in or a good answer starts the count over, so a service switched on while the page is open is found the next
// time the owner comes back to it, not by a timer that runs for as long as the tab stays open. (Was finance/reask.ts; one
// module with the copies since 2026-09-28.)

/** How many more times a failed read is asked on its own before the screen waits for the owner to come back. */
export const REASK_TRIES = 3

/**
 * Failures that cannot change without a deploy: a route or page that is not
 * there, a contract this page does not speak, an answer it cannot trust, or a
 * request the service will always refuse.
 */
export const FINAL_FAILURES: ReadonlySet<string> = new Set([
  'route_not_available',
  'feature_unavailable',
  'contract_mismatch',
  'upstream_contract_mismatch',
  'invalid_response',
  'owner_or_cursor_mismatch',
  'owner_mismatch',
  'epoch_mismatch',
  'invalid_request',
  'json_required',
  'method_not_allowed',
  'request_too_large',
])

/**
 * The wait before the next automatic ask after a failure with `reason`, when
 * `tried` asks have already followed failures: `firstMs`, then twice as long
 * each time. Null when the failure is final or the tries are spent.
 */
export function reaskWait(reason: string, tried: number, firstMs: number): number | null {
  if (FINAL_FAILURES.has(reason) || tried >= REASK_TRIES) return null
  return firstMs * 2 ** tried
}

/**
 * Whether two session keys (session/port.ts sessionKey: epoch|connector|owner)
 * name the same wallet through the same connector: a new session for it keeps
 * what its private screens show (2026-09-27, round 6).
 */
export const sameWallet = (a: string, b: string) => a.slice(a.indexOf('|')) === b.slice(b.indexOf('|'))
