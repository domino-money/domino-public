import { useEffect, useState } from 'react'
import type { CreatedPosition } from './createdPositions'
import { useKeyedLatest } from './hooks'
import { OWN_PORTFOLIO } from './source'

/**
 * Added 2026-11-09 (core flows, the owner: nothing slow when it can be fast). A position this browser just created (its
 * receipt, ./createdPositions.ts) is on chain before read-v6 lists it. The screens that wait for it (Set up automation, the
 * position's own page) ask the wallet's portfolio again every few seconds meanwhile, never sooner than a Retry-After the
 * reader holds, and stop waiting once it is listed or NEW_POSITION_WAIT_MS after the receipt, whichever comes first. The
 * portfolio's own pace was 30 s between good answers (2 s six times only after an action in this very tab), so a person
 * coming back to Set up automation after a reload looked at bare loading rows for up to five minutes.
 */
export const NEW_POSITION_WAIT_MS = 300_000
/** How soon after each portfolio answer it is asked again while a just-created position is awaited. */
export const NEW_POSITION_ASK_MS = 3_000

/** Whether the creation `created` is still within its wait (from its receipt's moment); false for none. */
export function useNewPositionWait(created: Pick<CreatedPosition, 'observedAt'> | undefined): boolean {
  const at = created?.observedAt ?? null
  const [ended, setEnded] = useState<number | null>(null)
  useEffect(() => {
    if (at === null) return
    const timer = setTimeout(() => setEnded(at), Math.max(0, at + NEW_POSITION_WAIT_MS - Date.now()))
    return () => clearTimeout(timer)
  }, [at])
  return at !== null && ended !== at
}

/** How soon after each answer it is asked again while an NFT of the wallet waits to be judged (../automate/setupPositions.ts). */
export const UNJUDGED_ASK_MS = 10_000

/**
 * While `waiting`, the wallet's portfolio is asked again `ms` after each of its answers (../lists/read.ts `soon`: never a
 * read in flight dropped, never sooner than the reader's own wait after a failure).
 */
export function useQuickPortfolio(wallet: string | null, waiting: boolean, ms: number = NEW_POSITION_ASK_MS): void {
  const key = waiting ? wallet : null
  const latest = useKeyedLatest(OWN_PORTFOLIO, key)
  useEffect(() => {
    if (key === null) return
    OWN_PORTFOLIO.soon(key, ms)
  }, [key, latest, ms])
}
