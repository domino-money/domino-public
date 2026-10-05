/**
 * A deployable build never runs the S1 client on a FIXTURE contracts set (src/finance/v2/zap.ts reads
 * __DOMINO_DEPLOYABLE__ once, when the module loads, as finance/pin.ts does). `.test-build` is not deployable, so this
 * file loads one copy of the module as it is, then sets the flag and loads a FRESH copy, which stands in for a
 * deployable build. Its own file: the flag is global to the process.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { createV2Chain, walletOf } from '../support/v2-chain.mjs';
import * as fx from './support/plans.mjs';

const require = createRequire(import.meta.url);
const chains = require('../../.test-build/app/src/v2/chains.js');
const path = require.resolve('../../.test-build/app/src/finance/v2/zap.js');
// The pinned-set check lives in deployment.js, which reads the flag when it loads too: both are loaded afresh.
const deploymentPath = require.resolve('../../.test-build/app/src/finance/v2/deployment.js');
const testBuild = require(path);
delete globalThis.__DOMINO_DEPLOYABLE__;

function deployableCopy() {
  delete require.cache[path];
  delete require.cache[deploymentPath];
  globalThis.__DOMINO_DEPLOYABLE__ = true;
  try {
    return require(path);
  } finally {
    delete globalThis.__DOMINO_DEPLOYABLE__;
    delete require.cache[path];
    delete require.cache[deploymentPath];
  }
}

test('a fixture contracts set runs in a test build and is refused by a deployable one, at construction and before any read', async () => {
  const chain = createV2Chain({ balances: { [fx.USDG]: 5_000_000_000n }, pools: fx.PRICED });
  assert.equal(chain.contracts.fixture, true);
  const client = testBuild.createZapClient(walletOf(chain), chains.v2Chain(4663), chain.contracts, () => fx.NOW);
  assert.equal(typeof client.review, 'function');

  const deployable = deployableCopy();
  assert.notEqual(deployable.createZapClient, testBuild.createZapClient, 'a fresh module copy');
  const before = chain.log.length;
  assert.throws(() => deployable.createZapClient(walletOf(chain), chains.v2Chain(4663), chain.contracts, () => fx.NOW), /deployment_fixture_refused/);
  // A set that does not say what it is counts as a fixture.
  const { fixture: _fixture, ...unmarked } = chain.contracts;
  void _fixture;
  assert.throws(() => deployable.createZapClient(walletOf(chain), chains.v2Chain(4663), unmarked, () => fx.NOW), /deployment_fixture_refused/);
  assert.equal(chain.log.length, before, 'nothing was asked of the wallet');

  // A set that merely SAYS it is real (fixture: false) is not taken either: a deployable build takes exactly the chain's
  // pinned manifest set (src/v2/manifest.ts), and none is pinned until #301, so no V2 client is built at all.
  assert.throws(() => deployable.createZapClient(walletOf(chain), chains.v2Chain(4663), { ...chain.contracts, fixture: false }, () => fx.NOW), /deployment_not_pinned/);
  assert.equal(chain.log.length, before, 'nothing was asked of the wallet');
  // In a test build, a set marked real runs (its code is still checked on chain before any write).
  const plain = testBuild.createZapClient(walletOf(chain), chains.v2Chain(4663), { ...chain.contracts, fixture: false }, () => fx.NOW);
  const plan = fx.createWithSwap();
  const review = await plain.review(fx.honestInput({ chainId: 4663, plan: { action: 'create', plan }, consent: 'direct', quote: { requestedAt: fx.NOW, expiresAt: fx.NOW + 180, legs: fx.quotedFor(plan.legs), simulation: { ok: true, block: 1n, error: null } } }, chain));
  assert.deepEqual(review.steps.map((step) => step.kind), ['approve', 'action']);
});

test('the chain must be the app\'s own profile object, not a look-alike with other addresses', () => {
  const chain = createV2Chain();
  const lookalike = { ...chains.v2Chain(4663) };
  assert.throws(() => testBuild.createZapClient(walletOf(chain), lookalike, chain.contracts, () => fx.NOW), /deployment_chain_mismatch/);
});
