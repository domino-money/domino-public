/**
 * Added 2026-10-06 (the review of the owner's point 5): New position's success offers Auto-exit for the position it just
 * made by opening that position's own page (components/create/CreatedNext.tsx), which works on every network and needs
 * nothing of V1's automation release. The ask is kept here for that position, in this page's memory only, for two
 * minutes; the position's automation panel (src/v2in/automate/PositionAutomation.tsx) takes it once it offers Auto-exit
 * there, and opens its dialog by itself. Nothing is stored, read or sent.
 *
 * Changed on purpose 2026-10-06 (the review, a second look): read-v6 lists a new position some seconds after it is made
 * (its index runs behind the chain), so the position's page (src/v2in/position/PositionPage.tsx) waits for one opened
 * from New position's success, by its own link or Auto-exit's, for the same two minutes (`newPositionExpected`), instead
 * of saying it isn't listed and losing the ask.
 *
 * `key` is the panel's own key for the position (src/v2in/autoexit/entry.ts exitOrderKey: the bare id for Robinhood
 * Chain's Uniswap v4, `chain:dex:id` elsewhere). A V1 module, so a V1 screen may name it (V1 files open src/v2in only
 * lazily: tests/session.source-guard.test.mjs).
 */

const KEEP_MS = 120_000
let pending: { key: string; until: number } | null = null
let opened: { key: string; until: number } | null = null

/** Asks for Auto-exit's dialog on `key`'s page, the next time its panel offers it (within two minutes). */
export function askAutoExitOnArrival(key: string, now: number = Date.now()): void {
  pending = opened = { key, until: now + KEEP_MS }
}

/** Takes the ask for `key` once: true when one was waiting and is still current; any other ask stays. */
export function takeAutoExitAsk(key: string, now: number = Date.now()): boolean {
  if (pending === null || pending.key !== key) return false
  const current = pending.until >= now
  pending = null
  return current
}

/** New position's success opens `key`'s page: the page waits for read-v6 to list it (within two minutes). */
export function expectNewPosition(key: string, now: number = Date.now()): void {
  opened = { key, until: now + KEEP_MS }
}

/** Whether `key`'s page waits for read-v6 to list it: opened from New position's success, by either link, within two minutes. */
export function newPositionExpected(key: string, now: number = Date.now()): boolean {
  return opened !== null && opened.key === key && opened.until >= now
}
