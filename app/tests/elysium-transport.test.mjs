/**
 * The second chain's section's one network call (src/chains/elysium/transport.ts, 2026-10-01, the chain2 workstream,
 * part B), against a recording fetch: the registry's Elysium RPC with no credentials and no referrer, this site's own
 * /uniswap-v3/{read,actions}/v1/<route> same-origin with no redirect followed and nothing cached, and any other URL refused
 * before anything is sent. tests/read.test.mjs pins its source's two fetch calls.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, test } from 'node:test';

const require = createRequire(import.meta.url);
const { elysiumTransport } = require('../.test-build/app/src/chains/elysium/transport.js');
const { ELYSIUM } = require('../.test-build/app/src/config/chains.js');

let sent = [];
const original = globalThis.fetch;
beforeEach(() => {
  sent = [];
  globalThis.fetch = async (input, init) => {
    sent.push([input, init]);
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  };
});
afterEach(() => {
  globalThis.fetch = original;
});

const refused = (error) => error instanceof TypeError && error.message === 'not an Elysium endpoint';

// Changed on purpose 2026-10-02 (review of the RPC switch, finding 1; the owner's final decision of 2026-10-01: the site
// reads nothing from a public RPC, on the preview too): the registry's Elysium RPC is a public node, so while the section
// has no source of rugged97's (mode.ts SECTION_READS false) it is refused like any other URL, and nothing is sent.
test('the chain\'s own public RPC is refused too while the section has no source of its own: nothing reaches the testnet\'s node', async () => {
  const { SECTION_READS } = require('../.test-build/app/src/chains/elysium/mode.js');
  assert.equal(SECTION_READS, false);
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' };
  for (const url of [ELYSIUM.rpc.primary.url, ...ELYSIUM.rpc.fallbacks.map((endpoint) => endpoint.url)]) await assert.rejects(elysiumTransport.rpc(url, init), refused, url);
  assert.deepEqual(sent, [], 'no request to any public node');
});

test('a request can widen nothing: redirects and the cache are this module\'s, whatever init says', async () => {
  await elysiumTransport.api('/uniswap-v3/read/v1/capabilities', { method: 'POST', credentials: 'include', redirect: 'follow', cache: 'force-cache' });
  assert.deepEqual([sent[0][1].credentials, sent[0][1].redirect, sent[0][1].cache], ['same-origin', 'error', 'no-store']);
});

test('any other RPC URL is refused before anything is sent', async () => {
  for (const url of [
    'https://testnet-rpc.elysium.kinetiq.xyz/',
    'https://testnet-rpc.elysium.kinetiq.xyz/?x=1',
    'http://testnet-rpc.elysium.kinetiq.xyz',
    'https://TESTNET-RPC.elysium.kinetiq.xyz',
    'https://rpc.mainnet.chain.robinhood.com',
    'https://evil.example',
    '/uniswap-v3/read/v1/capabilities',
    '',
  ]) {
    await assert.rejects(elysiumTransport.rpc(url, { method: 'POST' }), refused, url);
  }
  assert.deepEqual(sent, []);
});

test('this site\'s own routes: his two families, version 1, one route, same-origin, never followed, never cached', async () => {
  for (const path of ['/uniswap-v3/read/v1/capabilities', '/uniswap-v3/read/v1/pool', '/uniswap-v3/actions/v1/prepare', '/uniswap-v3/actions/v1/receipt']) {
    const body = '{"chainId":99801}';
    await elysiumTransport.api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    const [url, init] = sent.at(-1);
    assert.equal(url, path, 'a path, so the browser sends it to this origin');
    assert.deepEqual(init, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, credentials: 'same-origin', redirect: 'error', cache: 'no-store' }, path);
  }
  assert.equal(sent.length, 4);
});

test('any other path or URL is refused before anything is sent', async () => {
  for (const path of [
    '/uniswap-v3/read/v1/',
    '/uniswap-v3/read/v2/capabilities',
    '/uniswap-v3/write/v1/capabilities',
    '/uniswap-v3/read/v1/Capabilities',
    '/uniswap-v3/read/v1/capabilities?x=1',
    '/uniswap-v3/read/v1/capabilities/',
    '/uniswap-v3//read/v1/capabilities',
    '/uniswap-v3/read/v1/a/b',
    `/uniswap-v3/read/v1/${'a'.repeat(65)}`,
    '/api/read/v1/capabilities',
    'https://domino.money/uniswap-v3/read/v1/capabilities',
    '//evil.example/uniswap-v3/read/v1/capabilities',
    'uniswap-v3/read/v1/capabilities',
  ]) {
    await assert.rejects(elysiumTransport.api(path, { method: 'POST' }), refused, path);
  }
  assert.deepEqual(sent, []);
});
