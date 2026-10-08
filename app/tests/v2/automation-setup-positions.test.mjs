import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import * as runtime from '../../../api-contracts/read-v6/runtime.mjs';

const require = createRequire(import.meta.url);
const { setupEligibility, setupPositions, setupRetryDelay } = require('../../.test-build/app/src/v2in/automate/setupPositions.js');
const { v2Chain } = require('../../.test-build/app/src/v2/chains.js');
const ZERO = `0x${'0'.repeat(40)}`;
const OTHER = `0x${'1'.repeat(40)}`;
const fixture = () => JSON.parse(readFileSync(new URL('../../../api-contracts/read-v6/fixtures/valid/portfolio.json', import.meta.url), 'utf8'));
function portfolio() {
  const body = fixture();
  body.positions = [body.positions.find((p) => p.tokenId === '9')];
  body.vaults = [];
  body.mandates = [];
  body.credits = [];
  body.truncated = { vaults: false, positions: false, mandates: false };
  assert.equal(runtime.validateResponse('portfolio', body), true);
  return body;
}

test('V2-only S1 NFTs enter setup without a V1 mint or existing factory vault', () => {
  const body = portfolio();
  body.positions = ['3659474', '3659583', '3659593'].map((tokenId) => ({ ...structuredClone(body.positions[0]), tokenId }));
  assert.equal(runtime.validateResponse('portfolio', body), true);
  const result = setupPositions(body, body.wallet);
  assert.equal(result.incomplete, false, 'unavailable unrelated chains do not hide Robinhood');
  assert.deepEqual(result.positions.map((p) => p.tokenId), ['3659474', '3659583', '3659593']);
  const [position] = result.positions;
  assert.equal(position.currencies[0].symbol, 'USDG');
  assert.equal(position.currencies[0].decimals, 6);
  assert.equal(position.liquidity, body.positions[0].state.liquidity);
  assert.deepEqual(position.unclaimedFees, ['1200', '0']);
  assert.deepEqual(position.principal, body.positions[0].state.principalAtSpot);
  assert.equal(position.sqrtPriceX96, body.positions[0].state.sqrtPriceX96);
});

test('NFT ids are scoped to chain, DEX and the deployed position manager', () => {
  const body = portfolio();
  const root = body.positions[0];
  const base = structuredClone(root);
  base.chainId = 8453;
  base.positionManager = v2Chain(8453).uniswap.v4.positionManager;
  const v3 = structuredClone(root);
  v3.dex = 3;
  v3.state.pool.dex = 3;
  v3.positionManager = v2Chain(4663).uniswap.v3.positionManager;
  body.positions = [base, v3, root];
  body.tokens.push({ ...body.tokens.find((t) => t.address === root.state.pool.currency1), chainId: 8453, symbol: 'WRONG CHAIN', decimals: 2 });
  assert.deepEqual(setupPositions(body, body.wallet).positions.map((p) => p.tokenId), ['9']);
  assert.notEqual(setupPositions(body, body.wallet).positions[0].currencies[1].symbol, 'WRONG CHAIN');
  root.positionManager = OTHER;
  assert.equal(setupEligibility(body, body.wallet, root), 'unsupported');
  assert.deepEqual(setupPositions(body, body.wallet).positions, []);
  root.positionManager = v2Chain(4663).uniswap.v4.positionManager;
  root.state.pool.dex = 3;
  assert.equal(setupEligibility(body, body.wallet, root), 'unsupported');
});

test('current ownership and live custody exclude already managed, transferred, closed and hooked NFTs', () => {
  const cases = [
    ['not-owned', (p) => { p.state.owner = OTHER; }],
    ['closed', (p) => { p.state.liquidity = '0'; }],
    ['unsupported', (p) => { p.state.pool.hooks = OTHER; }],
    ['unsupported', (p) => { p.tokenId = (1n << 96n).toString(); }],
    ['automated', (p) => { p.vault = { address: OTHER, role: 'root' }; }],
    ['subscribed', (p) => { p.state.custody.subscriber = OTHER; }],
  ];
  for (const [reason, edit] of cases) {
    const body = portfolio();
    edit(body.positions[0]);
    assert.equal(setupEligibility(body, body.wallet, body.positions[0]), reason);
    assert.deepEqual(setupPositions(body, body.wallet), { positions: [], incomplete: false }, reason);
  }
  const body = portfolio();
  body.positions[0].state.custody = { approved: OTHER, subscriber: ZERO };
  assert.equal(setupEligibility(body, body.wallet, body.positions[0]), 'eligible', 'the flow can replace an individual approval; it cannot replace a subscriber');
  assert.equal(setupEligibility(body, OTHER, body.positions[0]), 'unavailable', 'another wallet never inherits the previous answer');
});

test('missing, stale and partial coverage never claim that there are no positions', () => {
  for (const edit of [
    (b) => { b.positions[0].state = { status: 'not_read' }; },
    (b) => { b.positions[0].state.status = 'unavailable'; },
    (b) => { b.positions[0].state.freshness.status = 'stale'; },
    (b) => { b.chains.find((c) => c.chainId === 4663).status = 'stale'; },
    (b) => { b.chains = b.chains.filter((c) => c.chainId !== 4663); },
  ]) {
    const body = portfolio();
    edit(body);
    assert.deepEqual(setupPositions(body, body.wallet), { positions: [], incomplete: true });
  }
  const body = portfolio();
  body.truncated.positions = true;
  assert.equal(setupPositions(body, body.wallet).incomplete, true);
  assert.equal(setupPositions(body, body.wallet).positions.length, 1, 'known eligible entries remain usable');
  body.positions = [];
  assert.deepEqual(setupPositions(body, body.wallet), { positions: [], incomplete: true });
  body.truncated.positions = false;
  assert.deepEqual(setupPositions(body, body.wallet), { positions: [], incomplete: false });
});

test('metadata stays chain-qualified and missing token decimals are never guessed', () => {
  const body = portfolio();
  const token = body.positions[0].state.pool.currency1;
  body.tokens = body.tokens.filter((t) => t.address !== token);
  const [position] = setupPositions(body, body.wallet).positions;
  assert.deepEqual(position.currencies[1], { address: token, symbol: null, decimals: null });
  assert.equal(position.currencies[0].decimals, 6, 'USDG uses its verified chain profile');
});

test('post-mint discovery retries only the requested NFT and stops after three increasing waits', () => {
  const body = portfolio();
  assert.deepEqual([0, 1, 2, 3, 4].map((n) => setupRetryDelay(body, body.wallet, '3659474', n)), [1500, 3000, 6000, null, null]);
  assert.equal(setupRetryDelay(body, body.wallet, null, 0), null);
  assert.equal(setupRetryDelay(body, body.wallet, '9', 0), null, 'verified eligible is ready immediately');
  body.positions[0].state.freshness.status = 'stale';
  assert.equal(setupRetryDelay(body, body.wallet, '9', 0), 1500);
  body.positions[0].state.freshness.status = 'fresh';
  body.positions[0].state.custody.subscriber = OTHER;
  assert.equal(setupRetryDelay(body, body.wallet, '9', 0), null, 'known foreign custody is a real block, not index lag');
});
