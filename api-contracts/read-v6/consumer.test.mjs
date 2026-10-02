// Producer answers pass; each answer with one defect fails, exactly as the
// producer (backend/v2_read_contract.py) refuses it.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import * as runtime from './runtime.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const list = (directory) => readdirSync(new URL(directory, import.meta.url)).filter((name) => name.endsWith('.json'));
const route = (name) => (name.startsWith('portfolio') ? 'portfolio' : 'activity');
const clone = (value) => JSON.parse(JSON.stringify(value));

test('the routes and the version are the producer\'s', () => {
  assert.deepEqual([...runtime.ROUTES].sort(), ['activity', 'portfolio']);
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

test('no answer claims a total, a price or a valuation it does not hold', () => {
  const tokens = read('./fixtures/valid/portfolio.json').tokens;
  assert(tokens.length > 0 && tokens.every((t) => t.price === null && t.priceReason === 'no_qualified_price_source'));
  const body = read('./fixtures/valid/activity.json');
  const withTotal = clone(body);
  withTotal.items[0].tx.gas.totalFeeWei = '1';
  assert(!runtime.validateResponse('activity', withTotal));
  const portfolio = read('./fixtures/valid/portfolio.json');
  const priced = clone(portfolio);
  priced.positions[0].state.valueUsd = '12.5';
  assert(!runtime.validateResponse('portfolio', priced));
});

test('errors are read-v1\'s', () => {
  for (const [code, { status, body }] of Object.entries(read('./fixtures/errors.json'))) {
    assert(runtime.validateError(status, body), code);
  }
  assert(!runtime.validateError(503, { error: 'v2_receipt_unanchored' }));
});
