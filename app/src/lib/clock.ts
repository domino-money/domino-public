/**
 * Time for the onboarding previews and the deposit consumer.
 *
 * Two clocks, never mixed. The monotonic one measures durations: how long a
 * preview or a wallet handoff stays valid is always a duration the server
 * measured (`expiresAt - requestedAt`), applied from the moment this page sent
 * or received something. It is never compared with a server timestamp, so a
 * device clock that runs fast or slow cannot expire a preview early or keep it
 * alive. The wall clock is for display only ("expired at 14:02:11").
 *
 * This is the only file among the preview and deposit modules that reads
 * `performance.now()` or `Date.now()`; tests/consumer.guard.test.mjs checks
 * that. Tests inject their own clock.
 */
export interface Clock {
  /** Monotonic milliseconds. Durations only. */
  monoMs(): number
  /** Wall-clock milliseconds. For display only; never compared with server time. */
  wallMs(): number
  /** Runs `callback` after `ms`; returns a function that cancels it. */
  setTimer(callback: () => void, ms: number): () => void
}

export const realClock: Clock = {
  monoMs: () => performance.now(),
  wallMs: () => Date.now(),
  setTimer(callback, ms) {
    const id = setTimeout(callback, ms)
    return () => clearTimeout(id)
  },
}
