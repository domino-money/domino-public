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
 */
export function fixtureRelay(fixture, { maxDays = 7, script = {}, tamper, swapBytes = 1 } = {}) {
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
        return answer({ v: 1, kind: 'transfer', head, units: [{ unit: null, from: 9506, to: head, final: false, logs: fixture.transfer }], next: null });
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
      case 'swapBefore': {
        if (!(request.block in fixture.swapBefore)) throw new Error(`no swapBefore ${request.block} in fixture ${fixture.id}`);
        return answer({ v: 1, kind: 'swapBefore', head, log: fixture.swapBefore[request.block] });
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
