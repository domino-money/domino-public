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

/**
 * `answer(route, body)`, optional: the gateway's reply to one question, as JSON text, in place of the fixture; undefined
 * leaves the fixture. The Worker checks it like any gateway reply. For a scenario whose chain made something the
 * fixtures do not hold, such as the position NFT Create position has just minted (finance.browser).
 */
export function createReadStub({ answer } = {}) {
  /** Every read the page asked the Worker for, as it arrived. */
  const requests = [];
  const worker = createWorker({
    getClientIp: () => '198.51.100.31',
    fetch: async (url, init) => {
      const route = new URL(url).pathname.replace('/internal/read/v1/', '');
      const body = JSON.parse(init.body);
      return new Response(answer?.(route, body) ?? reply(route, body), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': RC3 } });
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
      return worker.fetch(new Request(new URL(`${url.pathname}${url.search}`, APP), { method: request.method, headers, body }), BRIDGE);
    },
  };
}
