/**
 * The CSP's chain hosts, generated from the registry (src/lib/chain/csp.ts, 2026-10-01, the chain2 workstream, audit
 * item G4). Changed on purpose 2026-10-01 (RPC-SPEC §7.4, the owner's rule: nothing is read from a public RPC): the page
 * reads no Robinhood Chain RPC, so production's page policy names none and the fees worker's reaches the site alone;
 * where the second chain's section is open (the preview), its RPC's origin is added and nothing else changes.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const csp = require('../.test-build/app/src/lib/chain/csp.js');
const { ELYSIUM, ROBINHOOD } = require('../.test-build/app/src/config/chains.js');
const middleware = require('../.test-build/app/functions/_middleware.js');
const { APP_CSP } = middleware;

const directive = (policy, name) => policy.split('; ').find((part) => part.startsWith(`${name} `));

// Changed on purpose 2026-10-02 (RPC-SPEC §11.4): the fees replay worker is gone, and its own policy with it.
test('production\'s page policy is the page\'s own sources, with no chain RPC; there is no worker policy any more', () => {
  assert.equal(directive(APP_CSP, 'connect-src'), `connect-src ${csp.PAGE_CONNECT_BASE.join(' ')}`);
  assert.equal(csp.pageConnectSrc([]), directive(APP_CSP, 'connect-src'), 'no chain: the page\'s own sources');
  assert.equal(csp.withChains(APP_CSP, []), APP_CSP, 'production\'s policy, unchanged');
  assert.equal(middleware.WORKER_CSP, undefined);
  assert.equal(middleware.WORKER_PATH, undefined);
  assert.equal(csp.workerCsp, undefined, 'the worker\'s policy names no chain, so nothing generates it');
});

test('with Elysium, its RPC\'s origin joins the page\'s connect-src, after the page\'s own sources, and nothing else changes', () => {
  const preview = csp.withChains(APP_CSP, [ELYSIUM]);
  assert.equal(directive(preview, 'connect-src'), `${directive(APP_CSP, 'connect-src')} https://testnet-rpc.elysium.kinetiq.xyz`);
  const others = (policy) => policy.split('; ').filter((part) => !part.startsWith('connect-src '));
  assert.deepEqual(others(preview), others(APP_CSP));
  assert.deepEqual(csp.connectOrigins([ELYSIUM, ELYSIUM]), ['https://testnet-rpc.elysium.kinetiq.xyz'], 'each origin once');
});

test('a policy with no connect-src is returned as it is: generation never widens a policy that had none', () => {
  const page = "default-src 'none'; frame-ancestors 'none'";
  assert.equal(csp.withChains(page, [ROBINHOOD, ELYSIUM]), page);
});

test('origins are origins: scheme and host, no path, no trailing slash, https only', () => {
  for (const origin of csp.connectOrigins([ROBINHOOD, ELYSIUM])) {
    assert.match(origin, /^https:\/\/[a-z0-9.-]+$/);
    assert.equal(new URL(origin).origin, origin);
  }
});

// Part B (2026-10-01): the preview's page policy is withChains over production's. Changed on purpose 2026-10-01 (RPC-SPEC
// §7.4): over the Elysium testnet alone; the middleware names no Robinhood Chain host (CHAIN_RPC_HOSTS is gone). Changed
// on purpose 2026-10-02 (review of the RPC switch, finding 1; the owner's rule: the site reads nothing from a public RPC,
// on the preview too): the testnet's RPC is named only while the section may read it (mode.ts SECTION_READS, false until
// rugged97 serves its reads), so the preview's policy is production's today.
test('the preview\'s page policy is withChains over production\'s, naming no public node while the section reads none', () => {
  const middleware = require('../.test-build/app/functions/_middleware.js');
  const { SECTION_READS } = require('../.test-build/app/src/chains/elysium/mode.js');
  assert.equal(middleware.CHAIN_RPC_HOSTS, undefined);
  assert.equal(SECTION_READS, false);
  assert.equal(middleware.APP_CSP_CHAIN2, csp.withChains(APP_CSP, []));
  assert.equal(middleware.APP_CSP_CHAIN2, APP_CSP, 'production\'s policy exactly');
  assert.equal(directive(middleware.APP_CSP_CHAIN2, 'connect-src'), "connect-src 'self' https://api.dexscreener.com wss://relay.walletconnect.org", 'the page\'s own sources and the relay, and no chain\'s RPC');
  assert.doesNotMatch(middleware.APP_CSP_CHAIN2, /kinetiq|elysium/);
  // Once the section has a source of its own, the same rule names its chain's RPC origins, as before.
  assert.equal(directive(csp.withChains(APP_CSP, [ELYSIUM]), 'connect-src'), "connect-src 'self' https://api.dexscreener.com wss://relay.walletconnect.org https://testnet-rpc.elysium.kinetiq.xyz");
  assert.equal(middleware.pageCspFor({ CHAIN2_PREVIEW: 'true' }), middleware.APP_CSP_CHAIN2);
  for (const env of [{}, { CHAIN2_PREVIEW: 'false' }, { CHAIN2_PREVIEW: 'TRUE' }, { CHAIN2_PREVIEW: true }]) assert.equal(middleware.pageCspFor(env), APP_CSP, JSON.stringify(env));
});
