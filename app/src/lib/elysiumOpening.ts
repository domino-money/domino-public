/**
 * Elysium's opening day, read in the visitor's own time (added 2026-11-07, Elysium's pre-launch). The build writes the
 * day in (lib/elysiumIdentity.ts ELYSIUM_OPENING, scripts/elysium-switch.mjs ELYSIUM_OPENS_ON); whether it has come is
 * this browser's own calendar, never the build's clock and never a server's, so the words that carry the date are true
 * however late the live release is: they drop the date at the start of the opening day, local midnight, by themselves.
 * Home's Elysium chip (screens/Landing.tsx) and the docs' dated sentence (components/docs/DocsContent.tsx) read it.
 * Not in elysiumIdentity.ts, which imports nothing: this file imports React.
 */
import { useEffect, useState } from 'react'
import { ELYSIUM_OPENING } from './elysiumIdentity'

/**
 * The first moment of the opening day in this browser's own time zone: local midnight, new Date(y, m - 1, d). Never a
 * parse of the day's text, which reads it as midnight in UTC.
 */
export const openingStart = (at: readonly [number, number, number]): number => new Date(at[0], at[1] - 1, at[2]).getTime()
/** Whether `now` is before the opening day in this browser's own time: the one test the dated words take. */
export const beforeOpening = (at: readonly [number, number, number], now: number): boolean => now < openingStart(at)

/** The longest wait a timer takes (2^31 - 1 ms): past it, setTimeout fires at once. */
const LONGEST = 2_147_483_647

/**
 * True while the visitor's own date is before Elysium's opening day; turns false by itself at their local midnight,
 * without a reload. One way: once false it stays false.
 */
export function useBeforeElysiumOpens(): boolean {
  const at = ELYSIUM_OPENING?.at ?? null
  const [before, setBefore] = useState(() => at !== null && beforeOpening(at, Date.now()))
  useEffect(() => {
    if (at === null || !before) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = () => {
      clearTimeout(timer)
      const left = openingStart(at) - Date.now()
      if (left <= 0) setBefore(false)
      // 250 ms past midnight, so the timer lands after it.
      else timer = setTimeout(check, Math.min(left + 250, LONGEST))
    }
    check()
    // A laptop that slept or a background tab whose timers were held back: check again when the page is seen.
    document.addEventListener('visibilitychange', check)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', check)
    }
  }, [at, before])
  return before
}
