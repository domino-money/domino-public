/**
 * Work that the invocations of one isolate share (2026-10-02, review of the RPC switch, finding 3): the node's chain id
 * check (localRpc.ts), the same question asked twice at once (chainRoutes.ts), and the chain code's units in flight
 * (fees.ts). Cloudflare cancels every task of a request whose visitor goes away, unless the task was handed to the
 * request's waitUntil: a shared promise made by that request would then never settle, and every later question that
 * joined it would wait for good (the runtime ends such a request as one that "will never generate a response").
 *
 * So each shared piece of work is (1) handed to its first request's waitUntil, so it outlives a visitor that leaves;
 * (2) cleared from its slot by its own settling, never by the first request's frame; and (3) dated, so a later question
 * never joins one older than its bound, and one that joins waits no longer than that bound on a timer of its own.
 */

/**
 * How long one shared read may run before a later question stops waiting on it: past every route's own limits (fees.ts
 * and owned.ts DEADLINE_MS of 25 s, one node call's time-out of 10 s, the bucket's wait and the chain id check).
 */
export const SHARED_STALE_MS = 45_000

/**
 * `work`'s value, wrapped, or null once `ms` passed first: a timer of the caller's own (cleared as soon as either ends),
 * so a caller that joined someone else's work always has an event of its own to wake on. A rejection is passed on.
 */
export async function outlast<T>(work: Promise<T>, ms: number): Promise<{ value: T } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((done) => {
    timer = setTimeout(() => done(null), Math.max(0, ms))
  })
  try {
    return await Promise.race([work.then((value) => ({ value })), late])
  } finally {
    clearTimeout(timer)
  }
}
