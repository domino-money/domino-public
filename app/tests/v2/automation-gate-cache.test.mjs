import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { createGateCache, GATE_RECHECK_MS } = require('../../.test-build/app/src/v2in/automate/gateCache.js');
const { createV2RouteProbe, V2_ROUTE_SPECS, V2_READ_ROUTE_REUSE_MS } = require('../../.test-build/app/src/v2/routes.js');
globalThis.__DOMINO_V2__ = true;
const { v2Gate } = require('../../.test-build/app/src/v2/gate.js');
delete globalThis.__DOMINO_V2__;

test('a 503 capability recovers to live on re-entry/focus, with the same manifest and one concurrent request', async () => {
  let status = 503, calls = 0, now = 0;
  const spec = V2_ROUTE_SPECS.readV6;
  // Changed on purpose 2026-11-06 (read-v6 1.2.0-rc.1's window): the read Worker answers in the version asked.
  const probe = createV2RouteProbe({ now: () => now, get: async (_path, options) => {
    calls++;
    const version = options.headers[spec.header];
    return { kind: 'reply', reply: { status, opaqueRedirect: false, contentType: 'application/json', contractHeader: version,
      body: { kind: 'text', text: JSON.stringify({ contractVersion: version, dataMode: 'live_read_only', chainIds: [4663, 8453, 42161], enabledReads: ['portfolio', 'activity'], walletAuthentication: false, privateAccounts: false, ownerTransactions: false, automation: false }) } } };
  } });
  const cache = createGateCache((service, chain) => v2Gate(service, chain, 'https://domino.money', async () => probe), () => now);
  const unavailable = await cache('autoExit', 4663);
  assert.equal(unavailable.mode, 'preview');
  assert.equal(calls, 1);
  status = 200;
  const [first, second] = await Promise.all([cache('autoExit', 4663, true), cache('autoExit', 4663, true)]);
  assert.equal(first.mode, 'live'); assert.equal(second, first);
  assert.deepEqual(first.contracts, unavailable.contracts, 'availability cannot change the admitted contracts');
  assert.equal(calls, 2);
  assert.equal(await cache('autoExit', 4663, true), first, 'unchanged focus refresh preserves the review identity');
  assert.equal(calls, 2, 'the underlying capability TTL still applies');
  // Rewritten on purpose 2026-10-15 (pack 7): the probe keeps the read route's "on" five minutes (src/v2/routes.ts
  // V2_READ_ROUTE_REUSE_MS), so the gate's own minute takes the kept answer, and the outage is met at the probe's five
  // minutes (it was GATE_RECHECK_MS). Still never a page-lifetime live gate.
  now += GATE_RECHECK_MS + 1; status = 503;
  assert.equal((await cache('autoExit', 4663)).mode, 'live', "the gate's minute: the probe's kept answer, no GET");
  assert.equal(calls, 2);
  now = V2_READ_ROUTE_REUSE_MS + 1;
  assert.equal((await cache('autoExit', 4663)).mode, 'preview', 'a later outage cannot leave a page-lifetime live gate');
  assert.equal(calls, 3);
});

test('failed gate promises are bounded and a new check never inherits a previous network', async () => {
  let good = false, calls = 0;
  const cache = createGateCache(async (_service, chainId) => { calls++; if (!good) throw new Error('offline'); return { mode: 'preview', chainId, contracts: {}, locked: true, lockedCopy: 'Unavailable' }; });
  assert.equal((await cache('vault', 4663)).mode, 'off');
  good = true;
  assert.equal((await cache('vault', 4663, true)).mode, 'preview');
  assert.equal((await cache('vault', 8453)).chainId, 8453);
  assert.equal(calls, 3);
});
