// Producer answers pass; each answer with one defect fails, exactly as the
// producer (backend/v2_read_contract.py) refuses it.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import * as runtime from './runtime.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const list = (directory) => readdirSync(new URL(directory, import.meta.url)).filter((name) => name.endsWith('.json'));
// A fixture answers the longest route its file name starts with, then `.` or `-`.
const route = (name) => [...runtime.ROUTES].sort((a, b) => b.length - a.length)
  .find((r) => name.startsWith(r) && '.-'.includes(name[r.length]));
const clone = (value) => JSON.parse(JSON.stringify(value));

test('the routes and the version are the producer\'s', () => {
  assert.deepEqual([...runtime.ROUTES].sort(), ['activity', 'chain-balances', 'chain-pools', 'chain-tokens', 'portfolio']);
  assert.equal(runtime.CONTRACT_VERSION, read('./manifest.json').contractVersion);
});

test('every answer the producer serves validates', () => {
  const names = list('./fixtures/valid/');
  assert(names.length >= 7);
  for (const name of names) assert(runtime.validateResponse(route(name), read(`./fixtures/valid/${name}`)), name);
});

test('every answer with one defect is refused', () => {
  const names = list('./fixtures/invalid/');
  assert(names.length >= 50);
  for (const name of names) assert(!runtime.validateResponse(route(name), read(`./fixtures/invalid/${name}`)), name);
});

test('requests name a lower-case wallet, a bounded page and a well-formed cursor', () => {
  for (const name of list('./fixtures/requests/')) {
    assert(runtime.validateRequest(name.replace('.json', ''), read(`./fixtures/requests/${name}`)), name);
  }
  const wallet = '0x' + 'b1'.repeat(20);
  assert(runtime.validateRequest('portfolio', { wallet }));
  assert(runtime.validateRequest('activity', { wallet }));
  assert(!runtime.validateRequest('portfolio', { wallet: wallet.toUpperCase().replace('0X', '0x') }));
  assert(!runtime.validateRequest('portfolio', { wallet, chainId: 4663 }));
  assert(!runtime.validateRequest('activity', { wallet, limit: 51 }));
  assert(!runtime.validateRequest('activity', { wallet, limit: 0 }));
  assert(!runtime.validateRequest('activity', { wallet, cursor: '1.1.1.1' }), 'a chain V2 does not serve');
  assert(runtime.validateRequest('activity', { wallet, cursor: null }));
  const token = '0x' + '5e'.repeat(20);
  assert(runtime.validateRequest('chain-pools', { chainId: 8453, token }));
  assert(!runtime.validateRequest('chain-pools', { chainId: 8453, token, pairedToken: token }), 'a token with itself');
  assert(!runtime.validateRequest('chain-pools', { chainId: 1, token }), 'a chain V2 does not serve');
  assert(runtime.validateRequest('chain-balances', { wallet }));
  assert(!runtime.validateRequest('chain-balances', { wallet, tokens: [] }));
  assert(!runtime.validateRequest('chain-balances', { wallet, tokens: [{ chainId: 8453, address: token },
    { chainId: 8453, address: token }] }), 'a token twice');
  assert(runtime.validateRequest('chain-tokens', { chainId: 42161, query: 'usd' }));
  assert(!runtime.validateRequest('chain-tokens', { chainId: 4663, query: 'usd' }), 'Robinhood searches read-v3');
  assert(!runtime.validateRequest('chain-tokens', { chainId: 8453, query: '   ' }));
  assert(!runtime.validateRequest('chain-tokens', { chainId: 8453, query: 'a\u0000b' }));
  assert(!runtime.validateRequest('chain-tokens', { chainId: 8453, query: 'usd', limit: 25 }));
});

test('an exchange is about the wallet asked for', () => {
  const body = read('./fixtures/valid/activity-page.json');
  const request = read('./fixtures/requests/activity.json');
  assert(runtime.validateExchange('activity', request, body));
  assert(!runtime.validateExchange('activity', { ...request, wallet: '0x' + 'b2'.repeat(20) }, body));
  assert(!runtime.validateExchange('activity', { ...request, limit: 2 }, body));
  const portfolio = read('./fixtures/valid/portfolio.json');
  assert(runtime.validateExchange('portfolio', read('./fixtures/requests/portfolio.json'), portfolio));
});

test('a chain read is about the chain, token, query, wallet and tokens asked', () => {
  const pools = read('./fixtures/valid/chain-pools.json');
  const ask = read('./fixtures/requests/chain-pools.json');
  assert(runtime.validateExchange('chain-pools', ask, pools));
  assert(!runtime.validateExchange('chain-pools', { ...ask, chainId: 42161 }, pools));
  assert(!runtime.validateExchange('chain-pools', { ...ask, pairedToken: '0x' + '42'.repeat(20) }, pools));
  const balances = read('./fixtures/valid/chain-balances-asked.json');
  const asked = read('./fixtures/requests/chain-balances.json');
  assert(runtime.validateExchange('chain-balances', asked, balances));
  assert(!runtime.validateExchange('chain-balances', { ...asked, tokens: asked.tokens.slice(0, 1) }, balances));
  assert(!runtime.validateExchange('chain-balances', { ...asked, tokens: [...asked.tokens].reverse() }, balances));
  assert(runtime.validateExchange('chain-balances', { wallet: balances.wallet },
    read('./fixtures/valid/chain-balances.json')), 'every chain by default');
  assert(!runtime.validateExchange('chain-balances', { wallet: balances.wallet }, balances));
  const tokens = read('./fixtures/valid/chain-tokens.json');
  const query = read('./fixtures/requests/chain-tokens.json');
  assert(runtime.validateExchange('chain-tokens', query, tokens));
  assert(!runtime.validateExchange('chain-tokens', { ...query, query: 'aerodrome' }, tokens));
  assert(!runtime.validateExchange('chain-tokens', { ...query, limit: 1 }, tokens));
});

test('no answer claims a total, a valuation or a price the contract does not qualify', () => {
  // Every token has a price or the reason it has none; the stable is US$ 1 and a pool price names its pool and depth.
  const tokens = read('./fixtures/valid/portfolio.json').tokens;
  assert(tokens.length > 0 && tokens.every((t) => (t.price === null) !== (t.priceReason === null)));
  assert(tokens.some((t) => t.price !== null && t.price.source === 'chain_stable' && t.price.usd === '1.000000000000000000'));
  assert(tokens.some((t) => t.price !== null && t.price.source === 'pool' && t.price.pool !== null));
  const body = read('./fixtures/valid/activity.json');
  const withTotal = clone(body);
  withTotal.items[0].tx.gas.totalFeeWei = '1';
  assert(!runtime.validateResponse('activity', withTotal));
  const portfolio = read('./fixtures/valid/portfolio.json');
  const priced = clone(portfolio);
  priced.positions[0].state.valueUsd = '12.5';
  assert(!runtime.validateResponse('portfolio', priced));
  // A pool's market is its depth within the band, never a TVL.
  const pools = read('./fixtures/valid/chain-pools.json');
  assert(pools.pools.every((p) => (p.market.status === 'measured') === (p.market.depthUsd !== null)));
  const withTvl = clone(pools);
  withTvl.pools[0].tvlUsd = '10';
  assert(!runtime.validateResponse('chain-pools', withTvl));
});

test('errors are read-v1\'s', () => {
  for (const [code, { status, body }] of Object.entries(read('./fixtures/errors.json'))) {
    assert(runtime.validateError(status, body), code);
  }
  assert(!runtime.validateError(503, { error: 'v2_receipt_unanchored' }));
});
