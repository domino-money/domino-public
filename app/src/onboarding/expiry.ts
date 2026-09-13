/**
 * When a preview stops being current, on this page's monotonic clock.
 *
 *   deadline = min( sent     + (expiresAt − requestedAt) · 1000,
 *                   received + (expiresAt − retrievedAt) · 1000 )
 *
 * Both terms are durations the server measured, applied from moments this
 * page observed. The device's wall clock is never compared with a server
 * timestamp, so clock skew cannot expire a preview early or keep one alive.
 * The first term is conservative: the worker started the provider request
 * after this page sent it. `preparedDeadline` is provider metadata and never
 * extends anything.
 */
export interface PreviewTimes {
  requestedAt: number
  retrievedAt: number
  expiresAt: number
}

export function previewDeadlineMono(times: PreviewTimes, sentMono: number, receivedMono: number): number {
  return Math.min(sentMono + (times.expiresAt - times.requestedAt) * 1000, receivedMono + (times.expiresAt - times.retrievedAt) * 1000)
}

/** Whole seconds left before the deadline, rounded up, never negative. */
export function secondsLeft(deadlineMono: number, nowMono: number): number {
  return Math.max(0, Math.ceil((deadlineMono - nowMono) / 1000))
}
