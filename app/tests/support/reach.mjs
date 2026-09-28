/**
 * The chain's own RPC as a browser reaches it, for the suites that stub globalThis.fetch (2026-09-28).
 *
 * Since that day the page tells the RPC's unreadable 429 (a TypeError: its `access-control-allow-origin: *,*`) from an
 * RPC it cannot reach at all (the same TypeError: a name that does not resolve) with a probe, a no-cors GET to the same
 * URL (src/lib/chain/failover.ts): a browser answers it, opaquely, whenever the server was reached. The suites written
 * before that stub the RPC's refusal as a TypeError for every request; `reachable` answers the probe as a browser would
 * for an RPC that is there, so what they stub stays that refusal. `unreachable` is the RPC behind a name that does not
 * resolve: every request fails, the probe too. Not a suite of its own.
 */

/** Whether `init` is the router's reach probe (a no-cors GET). */
export const isProbe = (init) => init?.mode === 'no-cors';

/** `answer` for every request but the probe, which is answered as a browser answers a no-cors GET to a server that is there. */
export const reachable = (answer) => (url, init) => (isProbe(init) ? Promise.resolve(new Response(null, { status: 200 })) : answer(url, init));

/** A fetch that fails every request to `url` at the network (the probe included), and hands the others to `answer`. */
export const unreachable = (url, answer) => (asked, init) => (asked === url ? Promise.reject(new TypeError('Failed to fetch')) : answer(asked, init));
