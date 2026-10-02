/**
 * A position's page while the site's own chain routes cannot answer (src/lib/positions/gatewayRow.ts, RPC-SPEC D2 and
 * P2, 2026-10-01): one row for its header from rugged97's read gateway, through the page's read source: the NFT
 * (read-v1 `nft-positions`), its pool's price (`pool-market`) and its tokens' names (this visit's chain reads, else
 * `token`). Mapped from the read-v1 package's own recorded answers (api-contracts/read-v1/fixtures/gateway), with no
 * figure computed, and refused for anything that is not what was asked for.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { readGatewayRow } = require('../.test-build/app/src/lib/positions/gatewayRow.js');
const { noteTokens } = require('../.test-build/app/src/lib/chainTokens.js');
const { walletCard } = require('../.test-build/app/src/lib/walletCards.js');

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../api-contracts/read-v1/fixtures/gateway/${name}.json`, import.meta.url), 'utf8'));
const NFTS = fixture('nft-positions.success');
const MARKET = fixture('pool-market.not-requested');
const TOKEN = fixture('token.success');
const NATIVE = '0x0000000000000000000000000000000000000000';
const ERC20 = '0x1111111111111111111111111111111111111111';
const OWNER = '0x3333333333333333333333333333333333333333';
const POOL = NFTS.items[0].poolId;
const clone = (value) => JSON.parse(JSON.stringify(value));
const never = () => new AbortController().signal;

/**
 * The page's read source over recorded answers: `answers[route](request)` is the data of an `ok` outcome, or an outcome
 * of its own (`{ state: … }`). Every read it was asked, in order.
 */
function source(answers = {}) {
  const asked = [];
  const defaults = { 'nft-positions': () => clone(NFTS), 'pool-market': () => clone(MARKET), token: () => clone(TOKEN) };
  return {
    asked,
    transport: 'bridge',
    async read(route, request) {
      asked.push([route, request]);
      const data = (answers[route] ?? defaults[route])?.(request);
      if (data && typeof data.state === 'string') return { route, ...data };
      return { route, provenance: { kind: 'bridge' }, state: 'ok', data, observation: {} };
    },
  };
}

test('the row is the gateway’s own figures at its snapshot: the NFT’s pool key, range, liquidity, principal and unsettled fees, the pool’s price, the tokens’ names', async () => {
  const reads = source();
  const got = await readGatewayRow(reads, '1', never());
  const item = NFTS.items[0];
  assert.deepEqual(got, {
    owner: OWNER,
    block: NFTS.snapshot.number,
    row: {
      tokenId: '1',
      status: 'open',
      poolId: POOL,
      currencies: [{ address: NATIVE, symbol: 'ETH', decimals: 18 }, { address: ERC20, symbol: 'TOKEN', decimals: 6 }],
      fee: 3000,
      tickSpacing: 60,
      hooks: NATIVE,
      tickLower: item.tickLower,
      tickUpper: item.tickUpper,
      liquidity: item.liquidityRaw,
      sqrtPriceX96: MARKET.pool.sqrtPriceX96,
      tick: MARKET.pool.tick,
      unclaimedFees: item.unsettledFeesRaw,
      principal: item.principalRaw,
    },
  });
  // The reads, in order: the NFT at the gateway's latest snapshot, its pool without a price history, the ERC-20's name.
  assert.deepEqual(reads.asked, [
    ['nft-positions', { tokenIds: ['1'], blockNumber: null }],
    ['pool-market', { poolId: POOL, includePriceHistory: false }],
    ['token', { token: ERC20 }],
  ]);
  // The card the page draws from it: the same figures, nothing added.
  const card = walletCard(got.row, got.owner);
  assert.deepEqual([card.tokenId, card.hasLiquidity, card.liquidityRaw, card.principal.map((a) => a.raw), card.unsettledFees.map((a) => a.raw)], ['1', true, item.liquidityRaw, item.principalRaw, item.unsettledFeesRaw]);
  // A token this visit's chain reads named is not asked again.
  noteTokens([{ address: ERC20, symbol: 'TKN', decimals: 6 }]);
  const known = source();
  assert.deepEqual((await readGatewayRow(known, '1', never())).row.currencies[1], { address: ERC20, symbol: 'TKN', decimals: 6 });
  assert.deepEqual(known.asked.map(([route]) => route), ['nft-positions', 'pool-market']);
  // A token the gateway gives no units for: no name and no decimals, never a guess (the card writes its raw amount).
  const OTHER = '0x8888888888888888888888888888888888888888';
  const nfts = clone(NFTS);
  nfts.items[0].poolKey.currency1 = OTHER;
  const market = clone(MARKET);
  market.pool.poolKey.currency1 = OTHER;
  const unread = clone(fixture('token.unavailable'));
  unread.asset.address = OTHER;
  const unitless = await readGatewayRow(source({ 'nft-positions': () => nfts, 'pool-market': () => market, token: () => unread }), '1', never());
  assert.deepEqual(unitless.row.currencies[1], { address: OTHER, symbol: null, decimals: null });
  assert.deepEqual(walletCard(unitless.row, unitless.owner).principal.map((a) => a.kind), ['units', 'raw'], 'its smallest units only');
});

test('a position with no liquidity left is listed closed, its NFT kept', async () => {
  const empty = clone(NFTS);
  Object.assign(empty.items[0], { liquidityRaw: '0', hasLiquidity: false, principalRaw: ['0', '0'] });
  const got = await readGatewayRow(source({ 'nft-positions': () => empty }), '1', never());
  assert.deepEqual([got.row.status, got.row.liquidity, got.row.principal], ['closed', '0', ['0', '0']]);
});

test('no row for anything that is not what was asked for: not live, a dynamic fee, hooks, another PositionManager, another pool, a read that is not ok', async () => {
  const nft = (change) => () => {
    const data = clone(NFTS);
    change(data.items[0], data);
    return data;
  };
  const cases = [
    ['an NFT with nothing at the snapshot', { 'nft-positions': () => fixture('nft-positions.empty') }],
    ['another id only', { 'nft-positions': nft((item) => (item.tokenId = '2')) }],
    ['a dynamic fee', { 'nft-positions': nft((item) => (item.poolKey = { ...item.poolKey, feeMode: 'dynamic', fee_pips: 8388608 })) }],
    ['hooks', { 'nft-positions': nft((item) => (item.poolKey = { ...item.poolKey, hooks: '0x4444444444444444444444444444444444444444' })) }],
    ['another PositionManager', { 'nft-positions': nft((item) => (item.positionManager = '0x5555555555555555555555555555555555555555')) }],
    ['a malformed range', { 'nft-positions': nft((item) => Object.assign(item, { tickLower: 60, tickUpper: -60 })) }],
    ['a malformed amount', { 'nft-positions': nft((item) => (item.unsettledFeesRaw = ['1'])) }],
    ['another pool’s market', { 'pool-market': () => ({ ...clone(MARKET), poolId: `0x${'ab'.repeat(32)}`, pool: { ...clone(MARKET).pool, poolId: `0x${'ab'.repeat(32)}` } }) }],
    ['a market of other currencies', { 'pool-market': () => ({ ...clone(MARKET), pool: { ...clone(MARKET).pool, poolKey: { ...MARKET.pool.poolKey, currency1: '0x6666666666666666666666666666666666666666' } } }) }],
    ['a price of zero', { 'pool-market': () => ({ ...clone(MARKET), pool: { ...clone(MARKET).pool, sqrtPriceX96: '0' } }) }],
    ['another token’s name', { token: () => ({ ...clone(TOKEN), asset: { ...TOKEN.asset, address: '0x6666666666666666666666666666666666666666' } }) }],
    ['the NFT read busy', { 'nft-positions': () => ({ state: 'busy', retryAfterSeconds: 5 }) }],
    ['the NFT read unavailable', { 'nft-positions': () => ({ state: 'unavailable', cause: { kind: 'network' }, retryable: true }) }],
    ['the pool read refused', { 'pool-market': () => ({ state: 'request_rejected', code: 'invalid_request', status: 400 }) }],
    ['the token read unavailable', { token: () => ({ state: 'unavailable', cause: { kind: 'network' }, retryable: true }) }],
  ];
  // A token named by an earlier test of this file is not asked: name the unknown one here.
  const other = '0x7777777777777777777777777777777777777777';
  for (const [label, answers] of cases) {
    const tokenCase = label.startsWith('the token') || label.startsWith('another token');
    const withToken = tokenCase
      ? { ...answers, 'nft-positions': nft((item) => (item.poolKey = { ...item.poolKey, currency1: other })), 'pool-market': () => ({ ...clone(MARKET), pool: { ...clone(MARKET).pool, poolKey: { ...MARKET.pool.poolKey, currency1: other } } }) }
      : answers;
    assert.equal(await readGatewayRow(source(withToken), '1', never()), null, label);
  }
  // Nothing is asked for an id that is not one, nor once the page left.
  const bad = source();
  assert.equal(await readGatewayRow(bad, '01', never()), null);
  const left = new AbortController();
  left.abort();
  assert.equal(await readGatewayRow(bad, '1', left.signal), null);
  assert.equal(bad.asked.length, 0);
  // A source that throws is no row, never an error on the page.
  assert.equal(await readGatewayRow({ transport: 'bridge', read: async () => { throw new Error('broken'); } }, '1', never()), null);
});

test('the module reads only through the page’s read source: no network, no storage, no chain code', () => {
  const src = readFileSync(new URL('../src/lib/positions/gatewayRow.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\bfetch\(|https?:\/\/|\b(?:XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB)\b|chainCode|functions\/_lib|edge\/chainRoutes/);
  assert.deepEqual([...src.matchAll(/readWithin\(source, '([a-z-]+)'/g)].map((match) => match[1]), ['token', 'nft-positions', 'pool-market']);
});

// 2026-10-02 (review of the RPC switch, finding 9): the gateway reads the NFT and its pool each at its own snapshot; the
// row's figures are all of one block, the pool's, the NFT being read again there when it was read at another.
test('one block for every figure: when the pool’s snapshot is not the NFT’s, the NFT is read again at the pool’s block, and the row is that block’s', async () => {
  const later = (data, number) => ({ ...data, snapshot: { ...data.snapshot, number } });
  const market = later(clone(MARKET), 705);
  market.pool.snapshot = { ...market.pool.snapshot, number: 705 };
  const atBlock = later(clone(NFTS), 705);
  atBlock.items[0].principalRaw = ['111', '222'];
  const reads = source({ 'pool-market': () => clone(market), 'nft-positions': (request) => (request.blockNumber === 705 ? clone(atBlock) : clone(NFTS)) });
  const got = await readGatewayRow(reads, '1', never());
  assert.equal(got.block, 705, 'the price’s block');
  assert.deepEqual(got.row.principal, ['111', '222'], 'the principal read at that same block');
  assert.equal(got.row.sqrtPriceX96, market.pool.sqrtPriceX96);
  assert.deepEqual(reads.asked.slice(0, 3).map(([route, request]) => [route, request.blockNumber ?? null]), [['nft-positions', null], ['pool-market', null], ['nft-positions', 705]]);
  // The second read that does not answer, or answers another block: no row, never one of two blocks.
  for (const second of [{ state: 'unavailable', reason: 'stale_or_future_block' }, later(clone(NFTS), 704)]) {
    const failing = source({ 'pool-market': () => clone(market), 'nft-positions': (request) => (request.blockNumber === 705 ? clone(second) : clone(NFTS)) });
    assert.equal(await readGatewayRow(failing, '1', never()), null, JSON.stringify(second).slice(0, 60));
  }
  // The same block: one NFT read, as before.
  const same = source();
  await readGatewayRow(same, '1', never());
  assert.equal(same.asked.filter(([route]) => route === 'nft-positions').length, 1);
});
