/**
 * domino-wide-gate: rugged97's rule 1 for the whole site (C:/dwt/rpc-plan/RUGGED_RPC_SITE_2026-10-02.md, binding): wide
 * log scans on his node, since the deploy say, at most 10 a second and 4 at once for the site, about one core of the node
 * (some 11 µs of CPU per thousand blocks). Added 2026-10-02 (review of the rules, finding 2): the Pages Functions keep
 * that pace per isolate only (app/functions/_lib/localRpc.ts LOCAL_RPC_WIDE), and many isolates run at once.
 *
 * One Durable Object, WideGate, named "site": every isolate asks it before a wide scan, with the blocks the scan covers.
 * It grants a turn when fewer than SITE_WIDE.parallel are out and its bucket of blocks holds the scan (a scan wider than
 * the burst waits for a full bucket and leaves the rest owed), telling the isolate how long to wait first; or refuses it
 * with the wait after which one may be free. A turn is given back when the scan ends, and lapses after SITE_WIDE.leaseMs
 * whatever happens to the isolate. Its memory is the object's own (nothing stored): an object that restarts starts with a
 * full bucket, as a new isolate does.
 *
 *   POST https://wide-gate/take     {"blocks": n, "waitMs": n}  →  {"ok": true, "lease": "…", "waitMs": n} | {"ok": false, "retryAfterMs": n}
 *   POST https://wide-gate/release  {"lease": "…"}             →  {"ok": true}
 *
 * Only the domino-app Pages Functions reach it, through their Durable Object binding WIDE_GATE (no route, no workers.dev,
 * no preview URL). Not deployed by the repository: the owner deploys it, then binds it (RPC-SPEC §11.5).
 */
export const SITE_WIDE = Object.freeze({ blocksPerSecond: 80_000_000, burstBlocks: 160_000_000, parallel: 4, leaseMs: 15_000, maxWaitMs: 5_000 });
const MAX_BLOCKS = 10_000_000_000;
const BODY_BYTES = 256;

/** The gate's arithmetic, apart from the object (tests give it a clock of their own). */
export function wideGate(now = () => Date.now()) {
  let tat = 0;
  let next = 0;
  /** Each turn out, and when it lapses. */
  const leases = new Map();
  const out = () => {
    const at = now();
    for (const [lease, until] of leases) if (until <= at) leases.delete(lease);
    return leases.size;
  };
  return {
    take(blocks, waitMs) {
      if (!Number.isSafeInteger(blocks) || blocks < 1 || blocks > MAX_BLOCKS || !Number.isSafeInteger(waitMs) || waitMs < 0) return null;
      const at = now();
      // Four out: one is given back as its scan ends, a second or so; asked again then.
      if (out() >= SITE_WIDE.parallel) return { ok: false, retryAfterMs: 1_000 };
      // The bucket (GCRA, in blocks): its burst holds the scan, or it is full for one wider than the burst.
      const perMs = SITE_WIDE.blocksPerSecond / 1000;
      const start = Math.max(tat, at);
      const wait = Math.max(0, start - at - Math.max(0, SITE_WIDE.burstBlocks - blocks) / perMs);
      if (wait > Math.min(waitMs, SITE_WIDE.maxWaitMs)) return { ok: false, retryAfterMs: Math.ceil(wait) };
      tat = start + blocks / perMs;
      next += 1;
      const lease = `${next}`;
      leases.set(lease, at + wait + SITE_WIDE.leaseMs);
      return { ok: true, lease, waitMs: Math.ceil(wait) };
    },
    release(lease) {
      if (typeof lease === 'string') leases.delete(lease);
    },
    /** Tests: the turns out now. */
    out,
  };
}

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/** The Durable Object: one gate for the site. */
export class WideGate {
  constructor() {
    this.gate = wideGate();
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || (url.pathname !== '/take' && url.pathname !== '/release') || url.search) return json({ error: 'not_found' }, 404);
    const text = await request.text();
    let body = null;
    try {
      body = text.length <= BODY_BYTES ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'bad_request' }, 400);
    if (url.pathname === '/release') {
      this.gate.release(body.lease);
      return json({ ok: true });
    }
    const answer = this.gate.take(body.blocks, body.waitMs);
    return answer ? json(answer) : json({ error: 'bad_request' }, 400);
  }
}

/** The Worker itself answers nothing: only the object, through the Pages Functions' binding, is reached. */
export default { fetch: () => json({ error: 'not_found' }, 404) };
