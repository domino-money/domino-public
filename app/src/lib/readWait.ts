import { useEffect, useState } from 'react'

/**
 * Added 2026-11-09 (core flows, the owner: nothing may load forever): how long a screen keeps its loading rows for a read
 * that keeps failing before it says what to do. The reads behind it are asked again on their own meanwhile and after (the
 * lists' readers at 5 s, 15 s, 45 s, then every minute; read-v6's own deadline is 22 s), so the line gives way to the real
 * content the moment an answer arrives. Twenty seconds is three failed answers in a row on a quick failure.
 */
export const STUCK_MS = 20_000

/**
 * Whether `waiting` has held, without a break, for `ms`: false again as soon as it stops. A screen draws its loading rows
 * while this is false and its one line after.
 */
export function useWaitOver(waiting: boolean, ms: number = STUCK_MS): boolean {
  const [over, setOver] = useState(false)
  // A wait that ended starts from nothing the next time (set during render, React's way for state derived from props).
  if (!waiting && over) setOver(false)
  useEffect(() => {
    if (!waiting) return
    const timer = setTimeout(() => setOver(true), ms)
    return () => clearTimeout(timer)
  }, [waiting, ms])
  return waiting && over
}

/**
 * The words of those lines (2026-11-09, the ux-copy pass): what to do, in the approved voice of the token pages ("Reload the
 * page to see this token’s pools.", components/read/screens/StoredTokenExplorer.tsx). No "could not load", no apology.
 */
export const RELOAD_WORDS = {
  positions: 'Reload the page to see your positions.',
  /** Another address's list (View address). */
  addressPositions: 'Reload the page to see this address’s positions.',
  position: 'Reload the page to see this position.',
  receipts: 'Reload the page to see your receipts.',
  tokens: 'Reload the page to see your tokens.',
} as const

/** The one line while a position just created is being added to Domino’s list of it (2026-11-09, the ux-copy pass). */
export const ADDING_POSITION = 'Adding your new position…'
