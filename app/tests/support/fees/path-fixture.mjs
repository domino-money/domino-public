/**
 * Recorded chain logs for the price path's tests (2026-09-25, tests/fees-path.test.mjs).
 *
 * `path-delta.json.gz` (USDG/DELTA 1.99 %, the owner's NFT 3203538) and
 * `path-pons.json.gz` (PONS/USDG 0.30 %, his NFTs 3202568 and 3204536) hold,
 * read-only from Robinhood Chain's public RPC on 2026-09-25: every Swap of the
 * pool from shortly before the first mint to the state block (72,252,753),
 * the NFTs' own ModifyLiquidity events, their Transfers, the pool's
 * Initialize, the hourly headers of their lives, and each NFT's position at
 * the state block with the chain's own unclaimed fees and its pool's protocol fee (slot0). Trimmed: a Swap's tx,
 * sender and amounts are zeroed (the price path reads its price, liquidity,
 * tick and fee); the pool's other ModifyLiquidity events are left out; fee
 * growth was not recorded (zero here: the price path does not check it).
 *
 * pathRelay() answers the pipeline's requests from one of them as the relay
 * would; a request the price path must never make (a pool epoch, a swap day)
 * fails the test. Not a suite of its own.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const { SPAN_CAP_BYTES } = require('../../../.test-build/app/src/lib/fees/constants.js');

export const PATH_CASES = { '3203538': 'path-delta', '3202568': 'path-pons', '3204536': 'path-pons' };

const loaded = new Map();

/** One recorded pool, parsed (cached per process; callers must not mutate it). */
export function loadPath(name) {
  if (!loaded.has(name)) loaded.set(name, JSON.parse(gunzipSync(readFileSync(new URL(`./${name}.json.gz`, import.meta.url))).toString('utf8')));
  return loaded.get(name);
}

/** An NFT's recorded position as the worker gets it: its PositionState, and a zero growth (not recorded). */
export function pathState(fixture, id) {
  const { block, timestamp, positions: [p] } = fixture.positions[id].state;
  const state = {
    block,
    timestamp,
    unclaimed: [BigInt(p.unclaimed0), BigInt(p.unclaimed1)],
    sqrtPriceX96: BigInt(p.sqrtPriceX96),
    tick: p.tick,
    tickLower: p.tickLower,
    tickUpper: p.tickUpper,
    liquidity: BigInt(p.liquidity),
    protocolFee: p.protocolFee,
    poolId: p.poolId,
    owner: p.owner,
    currencies: [{ ...p.currencies[0] }, { ...p.currencies[1] }],
  };
  return { state, growth: [0n, 0n] };
}

const SALT_AT = 2 + 3 * 64;
const isOwn = (log, id) => log[2] === 1 && BigInt(`0x${log[5].slice(SALT_AT, SALT_AT + 64)}`) === BigInt(id);

/**
 * A fake relay over one recorded pool for NFT `id`. The recording holds none of the pool's other ModifyLiquidity
 * events: `busyProbe` puts fifty of them (another NFT's) in the first probe answer, a liquidity history as busy as
 * USDG/DELTA's (its last epochs were replies of 1 and 1.7 MB), which is what makes the probe choose the price path for
 * it; PONS/USDG's Swaps alone do. `script` answers the first requests of a kind with the given RelayAnswer instead;
 * `requests` records every request. A span request whose reply is past the worker's cap (SPAN_CAP_BYTES of compact logs,
 * functions/_lib/feesPath.ts SPAN_BYTES of the RPC's JSON) is too_large, as the worker cuts it (2026-09-25, review);
 * `cut` counts them and `spanBytes` adds up the span replies' bytes.
 */
export function pathRelay(fixture, id, { busyProbe = false, quietProbe = 1, script = {} } = {}) {
  const requests = [];
  const relay = { logs: null, requests, cut: 0, spanBytes: 0 };
  const head = fixture.positions[id].state.block + 2;
  const [from0, to0] = fixture.range;
  const answer = (value, factor = 1) => {
    const text = JSON.stringify(value);
    return { ok: true, value: JSON.parse(text), bytes: Math.round(text.length * factor) };
  };
  const within = (from, to) => {
    if (from < from0 || to > to0) throw new Error(`blocks ${from}..${to} were not recorded (${from0}..${to0})`);
  };
  const logs = async (request) => {
    requests.push(request);
    const scripted = script[request.kind]?.shift();
    if (scripted) return typeof scripted === 'function' ? scripted(request) : scripted;
    switch (request.kind) {
      case 'transfer':
        return answer({ v: 1, kind: 'transfer', head, units: [{ unit: null, from: request.since ?? 0, to: head, final: false, logs: fixture.positions[id].transfer.filter((log) => log[0] >= (request.since ?? 0)) }], next: null });
      case 'initialize':
        return answer({ v: 1, kind: 'initialize', head, units: [{ unit: null, from: 0, to: head, final: true, logs: [fixture.initialize] }], next: null });
      case 'probe': {
        // `quietProbe`: one Swap in so many, as a probe that met a quiet moment of a busy pool sees them.
        const inside = fixture.logs.filter((log) => log[0] >= request.from && log[0] <= request.to).filter((log, i) => log[2] !== 3 || i % quietProbe === 0);
        const first = !requests.slice(0, -1).some((asked) => asked.kind === 'probe');
        const mine = fixture.logs.find((log) => log[2] === 1);
        const busy = busyProbe && first ? Array.from({ length: 50 }, (_, i) => [request.from + i, 900 + i, 1, mine[3], mine[4], `${mine[5].slice(0, 2 + 3 * 64)}${'0'.repeat(63)}1`]) : [];
        const logs = [...inside, ...busy].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        return answer({ v: 1, kind: 'probe', head, units: [{ unit: null, from: request.from, to: request.to, final: false, logs }], next: null });
      }
      case 'span': {
        const units = request.spans.map(([from, to]) => {
          within(from, to);
          return { unit: null, from, to, final: false, logs: fixture.logs.filter((log) => (log[2] === 3 || log[2] === 4) && log[0] >= from && log[0] <= to) };
        });
        if (JSON.stringify(units).length > SPAN_CAP_BYTES) {
          relay.cut += 1;
          return { ok: false, failure: 'too_large', retryAfterMs: 0 };
        }
        const replied = answer({ v: 1, kind: 'span', head, units, next: null });
        relay.spanBytes += replied.bytes;
        return replied;
      }
      case 'settlements': {
        within(request.from, request.to);
        const own = fixture.logs.filter((log) => isOwn(log, request.tokenId) && log[0] >= request.from && log[0] <= request.to);
        return answer({ v: 1, kind: 'settlements', head, units: [{ unit: null, from: request.from, to: request.to, final: false, logs: own }], next: null });
      }
      case 'swapBefore': {
        const before = fixture.logs.filter((log) => log[2] === 3 && log[0] < request.block && log[0] >= (request.since ?? 0));
        if (before.length === 0 && request.block - 1 >= from0) throw new Error(`no Swap recorded before ${request.block}`);
        return answer({ v: 1, kind: 'swapBefore', head, log: before[before.length - 1] ?? null });
      }
      case 'headers': {
        const missing = request.blocks.filter((block) => !(block in fixture.headers));
        if (missing.length) throw new Error(`no headers ${missing.slice(0, 3)} recorded`);
        return answer({ v: 1, kind: 'headers', head, headers: request.blocks.map((block) => [block, fixture.headers[block]]) });
      }
      default:
        throw new Error(`the price path asked ${JSON.stringify(request).slice(0, 120)}`);
    }
  };
  relay.logs = logs;
  return relay;
}
