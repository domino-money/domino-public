import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { createPositionValuations, POSITION_USD_MEMORY_MS } = require('../../.test-build/app/src/v2in/lists/valuation.js');
const { POSITION_VALUATIONS } = require('../../.test-build/app/src/v2in/lists/valuation.js');
const { offerPositionState } = require('../../.test-build/app/src/v2in/lists/positionSync.js');
const { positionRows } = require('../../.test-build/app/src/v2in/lists/model.js');
const original = JSON.parse(readFileSync(new URL('../../../api-contracts/read-v6/fixtures/valid/portfolio.json', import.meta.url), 'utf8'));
const setup = () => {
  const body = structuredClone(original);
  body.positions = [body.positions[0]];
  const position = body.positions[0];
  body.tokens[1].decimals = 18; body.tokens[1].status = 'available';
  for (const token of body.tokens) if (token.price?.snapshot) token.price.snapshot.timestamp = body.servedAt;
  let clock = body.servedAt * 1000;
  const memory = createPositionValuations(() => clock);
  memory.record(body);
  const missing = structuredClone(body);
  missing.tokens[1].price = null; missing.tokens[1].priceReason = 'price_read_failed';
  return { body, position, memory, missing, advance: ms => { clock += ms; } };
};

test('an unchanged complete valuation survives a transient price read, retaining its original deadline', () => {
  const { body, position, memory, missing, advance } = setup();
  assert.equal(memory.get(body, position), null, 'current prices belong to the current read');
  advance(15_000); memory.record(missing);
  const saved = memory.get(missing, position);
  assert.equal(saved.saved, true);
  assert.equal(saved.at, body.servedAt * 1000);
  assert.match(saved.value, /^\d+\.\d+$/);
  assert.match(saved.fees, /^\d+\.\d+$/);
  advance(POSITION_USD_MEMORY_MS - 15_000);
  assert.equal(memory.get(missing, position), null, 'retries never renew the saved price');
});

test('changed principal, fees, currency identity, decimals, owner or chain never borrow a previous valuation', () => {
  const changes = [
    b => { b.positions[0].state.principalAtSpot[0] = '0'; },
    b => { b.positions[0].state.feesOwed[0] = '1'; },
    b => { b.positions[0].state.liquidity = '0'; },
    b => { b.positions[0].state.pool.fee = 10000; },
    b => { b.positions[0].state.tickLower -= 60; },
    b => { b.positions[0].state.owner = '0x' + 'de'.repeat(20); },
    b => { b.tokens[0].decimals = 18; },
    b => { b.wallet = '0x' + 'de'.repeat(20); },
    b => { b.positions[0].chainId = 8453; },
    b => { b.positions[0].positionManager = '0x' + 'de'.repeat(20); },
  ];
  for (const change of changes) {
    const { memory, missing } = setup();
    change(missing); memory.record(missing);
    assert.equal(memory.get(missing, missing.positions[0]), null);
  }
});

test('disqualified, stale and unread state clear USD, while a new qualified observation recovers', () => {
  for (const reason of ['no_pool', 'pool_depth_below_floor', 'pool_depth_unmeasurable', 'eth_usd_stale', 'sequencer_down', 'decimals_unknown']) {
    const { body, position, memory, missing } = setup();
    missing.tokens[1].priceReason = reason; memory.record(missing);
    assert.equal(memory.get(missing, position), null, reason);
    missing.tokens[1].priceReason = 'price_read_failed';
    assert.equal(memory.get(missing, position), null, 'disqualification cannot be undone by a read failure');
    memory.record(body);
    assert.equal(memory.get(missing, position)?.saved, true);
  }
  for (const change of [b => { b.chains[0].status = 'stale'; }, b => { b.positions[0].state.freshness.status = 'stale'; }, b => { b.positions[0].state.status = 'unavailable'; }]) {
    const { position, memory, missing } = setup();
    change(missing); memory.record(missing);
    assert.equal(memory.get(missing, position), null);
  }
});

test('a newer direct state read cannot borrow USD from the older indexed amounts', () => {
  const { body, position } = setup();
  position.tokenId = '666777';
  body.servedAt = Math.floor(Date.now() / 1000);
  for (const token of body.tokens) if (token.price?.snapshot) token.price.snapshot.timestamp = body.servedAt;
  POSITION_VALUATIONS.record(body);
  body.tokens[1].price = null; body.tokens[1].priceReason = 'price_read_failed';
  const previous = POSITION_VALUATIONS.get(body, position);
  assert.equal(previous?.saved, true, 'the old indexed state alone has a valid complete snapshot');
  const state = position.state;
  offerPositionState({ block: state.snapshot.number + 20, timestamp: body.servedAt, positions: [{
    ok: true, tokenId: position.tokenId, owner: state.owner, poolId: '0x' + 'ab'.repeat(32), poolKey: state.pool,
    tickLower: state.tickLower, tickUpper: state.tickUpper, liquidity: String(BigInt(state.liquidity) / 2n),
    sqrtPriceX96: String(1n << 96n), tick: 0, unclaimed0: '0', unclaimed1: '1000000000000000000',
    currencies: body.tokens.map(token => ({ address: token.address, symbol: token.symbol, decimals: token.decimals })),
  }] });
  const row = positionRows(body, () => true)[0];
  assert.equal(row.block, state.snapshot.number + 20, 'the newer direct reading is the one displayed');
  assert.equal(row.usdSavedAt, undefined);
  assert.equal(row.valueUsdBasis, 'pool-price');
  assert.equal(row.feesUsdBasis, 'pool-price');
  assert.notEqual(row.valueUsd, null, 'the current pool observation can be marked using its qualified anchor');
  assert.notEqual(row.valueUsd, previous.value, 'the previous complete valuation is not reused');
  assert.notEqual(row.feesUsd, previous.fees, 'the new raw balances are marked at their own pool observation');
  assert.equal(row.feesUsd, '1000000000000.000000000000000000', 'new Q96 price converts 1e18 raw units into the 6-decimal USDG anchor, not the old pool price');
});

test('a fresh position cannot supply pool USD while its chain is unavailable or missing', () => {
  for (const absent of [false, true]) {
    const { body } = setup();
    body.tokens[1].price = null;
    body.tokens[1].priceReason = 'pool_depth_below_floor';
    if (absent) body.chains = [];
    else body.chains[0].status = 'unavailable';
    const row = positionRows(body, () => true)[0];
    assert.equal(row.valueUsd, null);
    assert.equal(row.feesUsd, null);
    assert.equal(row.usdReason, 'stale_position_or_chain');
  }
});
