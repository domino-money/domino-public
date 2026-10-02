/**
 * Recorded fees relay answers for the fees tests (2026-09-24, P6).
 *
 * Each `<tokenId>.json.gz` beside this file holds one position NFT's /state
 * answer and every relay log unit its history needs (transfer, initialize,
 * pool epochs, swap days, swapBefore, headers), captured read-only from
 * Robinhood Chain's public RPC through functions/_lib/fees.ts, and trimmed:
 * Swap and Donate tx hashes and senders are zeroed and the mint day's swaps
 * before the mint are dropped but the last one (the replay reads neither).
 * `expect` is what the capture's own run printed.
 *
 * fixtureRelay() answers any LogsRequest from one of them, the way the relay
 * would, so the tests do not depend on the pipeline's request pattern. Not a
 * suite of its own.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

export const CASES = ['3135288', '3136705', '2310187', '3165100'];

const loaded = new Map();

/** One recorded case, parsed (cached per process; callers must not mutate it). */
export function loadCase(id) {
  if (!loaded.has(id)) loaded.set(id, JSON.parse(gunzipSync(readFileSync(new URL(`./${id}.json.gz`, import.meta.url))).toString('utf8')));
  return loaded.get(id);
}

/**
 * 2026-09-27: probe answers with no log at all, as many as a run asks: a pool whose samples saw no Swap, whose history
 * the exact replay reads (a young position in a pool whose Swaps the probe sees takes the price path: pipeline.ts P5).
 * For fixtureRelay's `script.probe`.
 */
export const quietProbes = (fixture) => Array.from({ length: 10 }, () => (request) => ({ ok: true, value: { v: 1, kind: 'probe', head: fixture.state.block + 2, units: [{ unit: null, from: request.from, to: request.to, final: false, logs: [] }], next: null }, bytes: 100 }));

const EPOCH = 3_600_000;
const DAY = 864_000;
const U256 = (1n << 256n) - 1n;

/** A case's /state position as the worker gets it: its PositionState and the chain's (inside − insideLast) mod 2^256. */
export function stateOfCase(fixture) {
  const { block, timestamp, positions: [p] } = fixture.state;
  const state = {
    block,
    timestamp,
    unclaimed: [BigInt(p.unclaimed0), BigInt(p.unclaimed1)],
    sqrtPriceX96: BigInt(p.sqrtPriceX96),
    tick: p.tick,
    tickLower: p.tickLower,
    tickUpper: p.tickUpper,
    liquidity: BigInt(p.liquidity),
    poolId: p.poolId,
    owner: p.owner,
    currencies: [{ ...p.currencies[0] }, { ...p.currencies[1] }],
  };
  const growth = [(BigInt(p.feeGrowthInside0X128) - BigInt(p.feeGrowthInside0LastX128)) & U256, (BigInt(p.feeGrowthInside1X128) - BigInt(p.feeGrowthInside1LastX128)) & U256];
  return { state, growth };
}

/**
 * A fake relay over one case: `logs(request)` resolves a RelayAnswer as
 * client.ts would. `maxDays` caps the days of one `swaps` answer (the rest go
 * to `next`); `script` answers the first requests of a kind with the given
 * RelayAnswer instead; `swapBytes` multiplies the size a `swaps` answer
 * reports (the recording is trimmed; the relay's own answers are about three
 * times larger for a busy pool); `requests` records every request asked.
 * `probeHistory` (2026-09-25): a probe answer carries the pool's recorded liquidity logs only when asked for. Since that
 * day a probe that sees any leads to the price path (pipeline.ts), so the exact replay's own tests, which replay the
 * recorded pool history, answer their probes with the recorded Swaps alone.
 */
export function fixtureRelay(fixture, { maxDays = 7, script = {}, tamper, swapBytes = 1, probeHistory = false } = {}) {
  const requests = [];
  const head = fixture.state.block + 2;
  const answer = (value) => {
    const text = JSON.stringify(value);
    return { ok: true, value: JSON.parse(text), bytes: value.kind === 'swaps' ? Math.round(text.length * swapBytes) : text.length };
  };
  const logs = async (request) => {
    requests.push(request);
    const scripted = script[request.kind]?.shift();
    if (scripted) return typeof scripted === 'function' ? scripted(request) : scripted;
    const until = request.until ?? head;
    switch (request.kind) {
      case 'transfer':
        // From `since` when asked (2026-09-25), to `until` when asked (2026-09-27), as the relay reads it.
        return answer({ v: 1, kind: 'transfer', head, units: [{ unit: null, from: Math.max(9506, request.since ?? 0), to: request.until ?? head, final: false, logs: fixture.transfer.filter((log) => log[0] >= (request.since ?? 0) && log[0] <= (request.until ?? head)) }], next: null });
      case 'initialize':
        return answer({ v: 1, kind: 'initialize', head, units: [{ unit: null, from: 0, to: head, final: true, logs: fixture.initialize }], next: null });
      case 'pool': {
        const logsOf = fixture.pool[request.epoch];
        if (!logsOf) throw new Error(`no pool epoch ${request.epoch} in fixture ${fixture.id}`);
        const to = Math.min(request.epoch * EPOCH + EPOCH - 1, until);
        return answer({ v: 1, kind: 'pool', head, units: [{ unit: request.epoch, from: request.epoch * EPOCH, to, final: false, logs: logsOf.filter((log) => log[0] <= to) }], next: null });
      }
      case 'swaps': {
        const units = [];
        let next = null;
        for (let day = request.day; day < request.day + request.count && day * DAY <= until; day++) {
          if (units.length === maxDays) {
            next = day;
            break;
          }
          const logsOf = fixture.swaps[day];
          if (!logsOf) throw new Error(`no swap day ${day} in fixture ${fixture.id}`);
          const to = Math.min(day * DAY + DAY - 1, until);
          const kept = logsOf.filter((log) => log[0] <= to);
          units.push({ unit: day, from: day * DAY, to, final: false, logs: tamper ? tamper(kept, day) : kept });
        }
        return answer({ v: 1, kind: 'swaps', head, units, next });
      }
      case 'probe': {
        // 2026-09-25: the pool's recorded logs (its epochs and swap days) in [from, to], in chain order.
        const seen = new Set();
        const logs = [...(probeHistory ? Object.values(fixture.pool).flat() : []), ...Object.values(fixture.swaps).flat()]
          .filter((log) => log[0] >= request.from && log[0] <= request.to && !seen.has(`${log[0]}:${log[1]}`) && seen.add(`${log[0]}:${log[1]}`))
          .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        return answer({ v: 1, kind: 'probe', head, units: [{ unit: null, from: request.from, to: request.to, final: false, logs }], next: null });
      }
      case 'swapBefore': {
        if (request.block in fixture.swapBefore) return answer({ v: 1, kind: 'swapBefore', head, log: fixture.swapBefore[request.block] });
        // 2026-09-25: the price path asks for the Swap before the mint's own block: the recorded one before it.
        const recorded = [...Object.values(fixture.swapBefore).filter(Boolean), ...Object.values(fixture.swaps).flat()].filter((log) => log[2] === 3 && log[0] < request.block).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        // None recorded before it: the pool's first Swap came later (3135288's pool never swapped), as the relay says.
        return answer({ v: 1, kind: 'swapBefore', head, log: recorded[recorded.length - 1] ?? null });
      }
      // 2026-09-25: the price path's two reads (functions/_lib/feesPath.ts), from the recorded swap days and pool epochs.
      case 'span': {
        const swaps = Object.values(fixture.swaps).flat();
        const units = request.spans.map(([from, to]) => ({ unit: null, from, to, final: false, logs: swaps.filter((log) => (log[2] === 3 || log[2] === 4) && log[0] >= from && log[0] <= to).sort((a, b) => a[0] - b[0] || a[1] - b[1]) }));
        return answer({ v: 1, kind: 'span', head, units, next: null });
      }
      case 'settlements': {
        const salt = BigInt(request.tokenId);
        const own = Object.values(fixture.pool).flat().filter((log) => log[2] === 1 && log[0] >= request.from && log[0] <= request.to && `0x${log[4][1].slice(26)}` === '0x58daec3116aae6d93017baaea7749052e8a04fa7' && BigInt(`0x${log[5].slice(2 + 3 * 64, 2 + 4 * 64)}`) === salt);
        return answer({ v: 1, kind: 'settlements', head, units: [{ unit: null, from: request.from, to: request.to, final: false, logs: own.sort((a, b) => a[0] - b[0] || a[1] - b[1]) }], next: null });
      }
      // 2026-10-01 (fees item A4): an automation vault's own record: the NFT's own ModifyLiquidity in its mint's block and in
      // each block of the vault's executions for it (here, every block of its own: the recorded case's compounds).
      case 'vault': {
        const salt = BigInt(request.tokenId);
        const own = Object.values(fixture.pool).flat().filter((log) => log[2] === 1 && log[0] >= request.from && log[0] <= request.to && `0x${log[4][1].slice(26)}` === '0x58daec3116aae6d93017baaea7749052e8a04fa7' && BigInt(`0x${log[5].slice(2 + 3 * 64, 2 + 4 * 64)}`) === salt);
        return answer({ v: 1, kind: 'vault', head, units: [{ unit: null, from: request.from, to: request.to, final: false, logs: own.sort((a, b) => a[0] - b[0] || a[1] - b[1]) }], next: null });
      }
      // 2026-09-27: the price path's own-settlements scan: every PositionManager ModifyLiquidity of the pool in each span
      // (the recorded epochs hold all of them), the NFT's own answered, what they all cost as the answer's bytes.
      case 'modifies': {
        const salt = BigInt(request.tokenId);
        const managed = Object.values(fixture.pool).flat().filter((log) => log[2] === 1 && `0x${log[4][1].slice(26)}` === '0x58daec3116aae6d93017baaea7749052e8a04fa7');
        const units = request.spans.map(([from, to]) => ({ unit: null, from, to, final: false, logs: managed.filter((log) => log[0] >= from && log[0] <= to && BigInt(`0x${log[5].slice(2 + 3 * 64, 2 + 4 * 64)}`) === salt).sort((a, b) => a[0] - b[0] || a[1] - b[1]) }));
        const read = managed.filter((log) => request.spans.some(([from, to]) => log[0] >= from && log[0] <= to));
        const replied = answer({ v: 1, kind: 'modifies', head, units, next: null });
        return { ...replied, bytes: Math.max(replied.bytes, JSON.stringify(read).length) };
      }
      case 'headers': {
        const missing = request.blocks.filter((block) => !(block in fixture.headers));
        if (missing.length) throw new Error(`no headers ${missing.slice(0, 3)} in fixture ${fixture.id}`);
        return answer({ v: 1, kind: 'headers', head, headers: request.blocks.map((block) => [block, fixture.headers[block]]) });
      }
      default:
        throw new Error(`unexpected request ${JSON.stringify(request)}`);
    }
  };
  return { logs, requests };
}
