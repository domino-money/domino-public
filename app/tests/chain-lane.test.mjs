/**
 * The page's state reads, through the site's own routes (2026-09-25; changed on purpose 2026-10-01, RPC-SPEC, the owner's
 * rule: nothing is read from a public RPC): client.ts chainState over the site's state route is shared between askers,
 * dropped once every asker has left, and warmed for a position's page.
 *
 * Changed on purpose 2026-10-02 (RPC-SPEC §11.4): the fees worker's lane to the logs route, its time budget and the
 * relay's wait for a paced runtime's turn are gone with the fees replay.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const client = require('../.test-build/app/src/lib/fees/client.js');
const relay = require('../.test-build/app/functions/_lib/fees.js');

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

// Changed on purpose 2026-10-01 (RPC-SPEC, UNIT fees): the state is asked of the site's own route (client.ts chainState
// over src/lib/edge/chainRoutes.ts postState), answered here at the edge by the relay's code over the recorded chain.
test('two askers of the same position’s state share one read; one that leaves gets nothing, the other its answer', async () => {
  const { caseChain } = await import('./support/fees/case-chain.mjs');
  const { chainDeps, withEdge } = await import('./support/fees/edge.mjs');
  const chain = caseChain('3136705');
  globalThis.__DOMINO_DEPLOYABLE__ = true;
  relay.resetRelayMemory();
  try {
    const controller = new AbortController();
    const both = await withEdge(chainDeps(chain), async () => {
      const leaving = client.chainState(['3136705'], controller.signal);
      const staying = client.chainState(['3136705']);
      controller.abort();
      return Promise.all([leaving, staying]);
    });
    assert.deepEqual(both.result[0], { ok: false, failure: 'unavailable', retryAfterMs: 0 });
    assert.equal(both.result[1].ok, true);
    assert.equal(both.sent.length, 1, 'one request, not two');
    // Changed on purpose 2026-10-01 (fees item A21): one read is two calls, where it was three.
    assert.equal(chain.log.filter((call) => call.method === 'eth_call').length, 2, 'one read of two calls at the edge');
    // Once answered, a read is never reused: asked again, the position is asked again.
    const again = await withEdge(chainDeps(chain), () => client.chainState(['3136705']));
    assert.deepEqual([again.result.ok, again.sent.length], [true, 1]);
  } finally {
    delete globalThis.__DOMINO_DEPLOYABLE__;
  }
});

// 2026-09-28 (speed wave B, item 43: a page's chain reads went on after it was left): a /state read shared by several
// askers stops once every one of them has left, and makes no further call; one with no signal keeps it to its end.
// Changed on purpose 2026-10-01 (RPC-SPEC): the read is one request of the site's state route, dropped (aborted) once
// every asker has left.
test('a shared /state read stops once every asker has left, and one that stays keeps it going', async () => {
  const { caseChain } = await import('./support/fees/case-chain.mjs');
  const { chainDeps, withEdge } = await import('./support/fees/edge.mjs');
  const chain = caseChain('3136705');
  globalThis.__DOMINO_DEPLOYABLE__ = true;
  relay.resetRelayMemory();
  try {
    const a = new AbortController();
    const b = new AbortController();
    const slow = chainDeps({ fetch: async (url, init) => {
      await wait(30);
      return chain.fetch(url, init);
    } });
    const left = await withEdge(slow, async () => {
      const both = [client.chainState(['3136705'], a.signal), client.chainState(['3136705'], b.signal)];
      await wait(10);
      a.abort();
      b.abort();
      const answers = await Promise.all(both);
      await wait(150);
      return answers;
    });
    assert.deepEqual(left.result.map((answer) => answer.ok), [false, false]);
    assert.equal(left.sent.length, 1, 'one request for both');
    assert.equal(left.sent[0].init.signal?.aborted, true, 'dropped once both had left');
    relay.resetRelayMemory();
    const c = new AbortController();
    const kept = await withEdge(slow, async () => {
      const staying = client.chainState(['3136705']);
      const leaving = client.chainState(['3136705'], c.signal);
      c.abort();
      return Promise.all([leaving, staying]);
    });
    assert.deepEqual(kept.result.map((answer) => answer.ok), [false, true], 'the one that stayed gets its answer');
    assert.equal(kept.sent[0].init.signal?.aborted, false, 'its request was not dropped');
    // 2026-09-28 (speed wave B, item 17): with each position's feature, for the page's chips.
    assert.deepEqual(kept.result[1].value.automation, [{ tokenId: '3136705', automation: 'plain' }]);
  } finally {
    delete globalThis.__DOMINO_DEPLOYABLE__;
  }
});

// 2026-09-28 (speed wave B, item 24): a position's page's first read, started as soon as its route is known, is the one
// the page takes, once, and only for a moment.
test('the state read warmed for a position’s page is the one it takes, once', async () => {
  const { caseChain } = await import('./support/fees/case-chain.mjs');
  const { chainDeps, withEdge } = await import('./support/fees/edge.mjs');
  const chain = caseChain('3136705');
  globalThis.__DOMINO_DEPLOYABLE__ = true;
  relay.resetRelayMemory();
  try {
    const run = await withEdge(chainDeps(chain), async () => {
      client.warmState('3136705');
      client.warmState('3136705');
      const taken = client.takeWarmState('3136705');
      const again = client.takeWarmState('3136705');
      return { answer: await taken, again };
    });
    assert.equal(run.result.answer.ok, true);
    assert.equal(run.result.again, null, 'taken once');
    assert.equal(run.sent.length, 1, 'one read');
    assert.equal(client.takeWarmState('1'), null);
  } finally {
    delete globalThis.__DOMINO_DEPLOYABLE__;
  }
});
