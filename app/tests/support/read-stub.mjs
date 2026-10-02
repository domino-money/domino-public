/**
 * A read service for browser scenarios that walk New position on the
 * wallet-test or consumer-test build: the unmodified read Worker
 * (bridge/src/worker.mjs) with its gateway replaced by the read-v1 package
 * fixtures, as read-bridge.browser.test.mjs sets it up, mounted as one of
 * wallet-server.mjs's same-origin routes. The only translation is the one
 * Cloudflare would make: the Worker requires an https origin, so this origin
 * is presented to it as one.
 *
 * The fixture pool is ETH (0x0000…0000, 18 decimals) against TOKEN
 * (0x1111…1111, 6 decimals), fee 0.30%, tick spacing 60, price at tick 0.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createWorker } from '../../../bridge/src/worker.mjs';

const APP = 'https://app.test';
const RC3 = '1.1.0-rc.3';
const ZERO = '0x0000000000000000000000000000000000000000';
const READ = resolve(import.meta.dirname, '../../../api-contracts/read-v1/fixtures/gateway');
const fixture = (name) => readFileSync(join(READ, `${name}.json`), 'utf8');

export const FIXTURE_TOKEN = '0x1111111111111111111111111111111111111111';
export const FIXTURE_POOL = JSON.parse(fixture('pools.success')).pools[0].poolId;

const BRIDGE = {
  APP_ORIGIN: APP,
  READ_BRIDGE_ENABLED: 'true',
  READ_V2_BRIDGE_ENABLED: 'false',
  ENABLED_V2_READS: '',
  GATEWAY_ORIGIN: 'https://gateway.test',
  ENABLED_READS: 'token,pools,pool-market,wallet-assets,nft-positions,catalogue,pool-activity',
  ACCESS_CLIENT_ID: 'read-stub-client',
  ACCESS_CLIENT_SECRET: 'read-stub-secret',
};

const reply = (route, body) => {
  const name = {
    'pool-market': 'pool-market.not-requested',
    'wallet-assets': 'wallet-assets.last-page',
    token: body.token === ZERO ? 'token.native' : 'token.success',
  }[route];
  return fixture(name ?? `${route}.success`);
};

/** The gateway refusing a read with `code` (read-v1's error table), as its reply to the Worker. */
export const gatewayError = (code, status) =>
  new Response(JSON.stringify({ error: code }), { status, headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': RC3 } });

/**
 * `answer(route, body)`, optional: the gateway's reply to one question, as JSON text, in place of the fixture; undefined
 * leaves the fixture. The Worker checks it like any gateway reply. For a scenario whose chain made something the
 * fixtures do not hold, such as the position NFT Create position has just minted (finance.browser).
 *
 * `stored(route, body)`, optional (added 2026-09-28, speed wave): lists read-v3's stored routes (overview, history,
 * search) and answers them, as JSON text; without it read-v3 is off, as before.
 *
 * Added 2026-09-28 (speed wave, after review): either may also return a promise of its answer, for a service that
 * answers late, and `answer` may return a Response, for the gateway refusing the read with its own status
 * (`gatewayError`).
 *
 * `reads`, optional (added 2026-10-02, the fee chart's periods): the read-v1 routes the deployment lists, a comma list,
 * in place of the default (a suite that wants only `nft-positions` listed, say).
 */
export function createReadStub({ answer, stored, reads } = {}) {
  const base = reads === undefined ? BRIDGE : { ...BRIDGE, ENABLED_READS: reads };
  const env = stored ? { ...base, READ_V3_BRIDGE_ENABLED: 'true', ENABLED_V3_READS: 'overview,history,search' } : base;
  /** Every read the page asked the Worker for, as it arrived. */
  const requests = [];
  const worker = createWorker({
    getClientIp: () => '198.51.100.31',
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(init.body);
      if (stored && path.startsWith('/internal/read/v3/')) {
        return new Response(await stored(path.replace('/internal/read/v3/', ''), body), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': '3.0.0-rc.1' } });
      }
      const route = path.replace('/internal/read/v1/', '');
      const given = await answer?.(route, body);
      if (given instanceof Response) return given;
      return new Response(given ?? reply(route, body), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': RC3 } });
    },
  });
  return {
    requests,
    /** A wallet-server route: answers /api/read/*, and leaves everything else to the next route. */
    async handle(request, url) {
      if (!url.pathname.startsWith('/api/read/')) return undefined;
      const headers = new Headers(request.headers);
      if (headers.get('origin') === url.origin) headers.set('origin', APP);
      headers.delete('host');
      const body = request.method === 'GET' ? undefined : await request.text();
      requests.push({ method: request.method, path: url.pathname, body });
      return worker.fetch(new Request(new URL(`${url.pathname}${url.search}`, APP), { method: request.method, headers, body }), env);
    },
  };
}
