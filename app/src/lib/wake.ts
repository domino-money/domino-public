/**
 * One wake rule for every reader of the page (incident 2026-10-13, design 2.5, package Q1): the fees store
 * (lib/fees/spawn.ts), the lists' readers (v2in/lists/read.ts), the activity reader (v2in/lists/activity.tsx) and the
 * capability gates (v2in/automate/gate.tsx).
 *
 * - A wake is the page coming back into view (`visibilitychange` to visible) or the network coming back (`online`).
 *   `focus` is not one: a wallet's popup closing fires it, and each one re-read everything at once (the owner's console on
 *   13 Oct: a list re-read every few seconds).
 * - Wake rounds are at least WAKE_GAP_MS apart, for the whole page: events in between ask nothing.
 * - In a round, each reader reads only when its last good answer is older than its own period (wakeDue). A reader that is
 *   waiting out a failure keeps its wait: an error slows a reader down, never speeds it up.
 *
 * Nothing here reads; it only says when a reader may. Pure but for the page's default source (pageWake), so tests hand in
 * their own events and clock.
 */

/**
 * The least time between two wake rounds.
 * (2026-10-14, Q1 alone): 10 s though a position page's own period is 5 s again (lib/fees/constants.ts STATE_REFRESH_MS):
 * the gap only drops rounds, so no reader reads more often than before Q1, and a page shown again inside it still reads on
 * its own timer (lib/fees/spawn.ts `later`, whenVisibleAfter, runs a refresh that fell due while the page was hidden).
 * (2026-10-15, pack 8): the page's own period is 10 s again (the owner's decision D8), the same as this gap.
 */
export const WAKE_GAP_MS = 10_000

/** Where wake events come from. */
export interface WakeSource {
  /** Calls `run` on each wake event (back into view, back online); returns the unsubscribe. */
  listen(run: () => void): () => void
  /** Whether the page is hidden now: a hidden page has no wake. */
  hidden(): boolean
  now(): number
}

export interface Wake {
  /** Calls `reader` at each wake round until the returned function is called. */
  onWake(reader: () => void): () => void
}

/** A page's wake over `source`: one listener for every reader, rounds at least WAKE_GAP_MS apart. */
export function createWake(source: WakeSource): Wake {
  const readers = new Set<() => void>()
  let last = Number.NEGATIVE_INFINITY
  let stop: (() => void) | null = null
  const round = () => {
    if (source.hidden()) return
    const now = source.now()
    if (now - last < WAKE_GAP_MS) return
    last = now
    // A copy: a reader may leave while the others are called.
    for (const reader of Array.from(readers)) reader()
  }
  return {
    onWake(reader) {
      readers.add(reader)
      stop ??= source.listen(round)
      let open = true
      return () => {
        if (!open) return
        open = false
        readers.delete(reader)
        if (readers.size === 0) {
          stop?.()
          stop = null
        }
      }
    },
  }
}

/**
 * Whether a reader reads at a wake round at `now`: its last good answer came at `goodAt` (null: none yet) and its own
 * period is `periodMs`. Null period: the reader asks nothing again by itself (a test build's reader with its refresh off),
 * so the wake is its only refresh.
 */
export function wakeDue(goodAt: number | null, periodMs: number | null, now: number): boolean {
  if (goodAt === null || periodMs === null) return true
  return now - goodAt >= periodMs
}

/**
 * The wake events of a window and its document: `visibilitychange` to visible and `online`, never `focus`. Hidden is either
 * of the document's two words for it (the readers used both).
 */
export function browserWakeSource(win: Pick<Window, 'addEventListener' | 'removeEventListener'>, doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'> & { hidden?: boolean }, now: () => number = () => Date.now()): WakeSource {
  const hidden = () => doc.hidden === true || doc.visibilityState === 'hidden'
  return {
    listen(run) {
      const visible = () => {
        if (!hidden()) run()
      }
      doc.addEventListener('visibilitychange', visible)
      win.addEventListener('online', run)
      return () => {
        doc.removeEventListener('visibilitychange', visible)
        win.removeEventListener('online', run)
      }
    },
    hidden,
    now,
  }
}

const NO_SOURCE: WakeSource = { listen: () => () => undefined, hidden: () => true, now: () => Date.now() }

/** The page's one wake (none outside a browser). */
export const pageWake: Wake = createWake(typeof window !== 'undefined' && typeof document !== 'undefined' ? browserWakeSource(window, document) : NO_SOURCE)
