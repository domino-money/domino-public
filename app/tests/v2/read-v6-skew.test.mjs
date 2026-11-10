/**
 * The read-v6 version skew of day 9 (added 2026-11-07; docs/ELYSIUM_DAY9.md "Order", Monday checklist step 9). read-v6
 * holds a portfolio's or activity's chains to its own list exactly, and three parties each check every such answer with
 * their own copy of the package: the app, the read Worker (bridge/src/worker.mjs) and rugged97's read gateway. If his
 * day-9 read-v6 names Elysium (99901) under the same contract version, his gateway answers four chains, and a Worker or an
 * app still on today's package refused every one of those answers whole: V2 positions, a position's page, Receipts and
 * Automate blank on Robinhood Chain, Base and Arbitrum One.
 *
 * What this file runs, with the real runtimes (today's package, and rugged97's runtime over his day-9 data:
 * ../support/elysium-day9.mjs), the real read Worker (today's package, and over the day-9 one:
 * ../support/read-worker-day9.mjs) and the app's own read client (.test-build): today's Worker and app now read a
 * four-chain answer without Elysium, each checking every rule of their package on what is left, so his gateway may go
 * first; the day-9 Worker, then the day-9 app, follow. Still never safe, and held here so: a day-9 Worker or app ahead
 * of his gateway, and the day-9 app ahead of the day-9 Worker.
 *
 * Once the repository's own read-v6 names Elysium (day 9 merged), today's package is the day-9 one and these tests skip.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import * as today from '../../../api-contracts/read-v6/runtime.mjs';
import { CONSTANTS } from '../../../api-contracts/read-v6/schema-data.mjs';
import { createWorker } from '../../../bridge/src/worker.mjs';
import { READ_V6_DAY9 } from '../support/elysium-day9.mjs';
import { WORKER_DAY9 } from '../support/read-worker-day9.mjs';
import {
  ELYSIUM, activityWithElysium, pageEndingOnElysium, pageWithElysiumInside, portfolioWithElysium, readV6Fixture,
} from '../support/read-v6-four-chains.mjs';

const require = createRequire(import.meta.url);
const { readPortfolio, readActivity } = require('../../.test-build/app/src/v2/read/v6.js');

const SKIP = CONSTANTS.chainIds.includes(ELYSIUM) ? 'the repository\'s read-v6 names Elysium: day 9 is merged' : false;
const THREE = [4663, 8453, 42161];
const FOUR = [...THREE, ELYSIUM];
const day9 = READ_V6_DAY9.runtime;
const appRuntime = (rt) => Object.freeze({ CONTRACT_VERSION: rt.CONTRACT_VERSION, ERROR_STATUS_BY_CODE: rt.ERROR_STATUS_BY_CODE,
  validateRequest: rt.validateRequest, validateResponse: rt.validateResponse, validateExchange: rt.validateExchange, validateError: rt.validateError });
const APP_TODAY = appRuntime(today);
const APP_DAY9 = appRuntime(day9);
const WALLET = readV6Fixture('requests/portfolio.json').wallet;
const PAGE_REQUEST = readV6Fixture('requests/activity.json');
const chainsOf = (body) => body.chains.map((chain) => chain.chainId);
const clone = (value) => JSON.parse(JSON.stringify(value));

/** Every answer rugged97's gateway may serve on day 9 under one version, with the request each answers. */
const FOUR_CHAIN = () => [
  ['portfolio, Elysium read', 'portfolio', { wallet: WALLET }, portfolioWithElysium('current')],
  ['portfolio, Elysium not registered yet', 'portfolio', { wallet: WALLET }, portfolioWithElysium('unavailable')],
  ['portfolio, the three current and Elysium not registered yet', 'portfolio', { wallet: WALLET }, portfolioWithElysium('unavailable', 'valid/portfolio-complete.json')],
  ['activity, a first page', 'activity', { wallet: WALLET }, activityWithElysium()],
  ['activity, a page with an Elysium receipt inside', 'activity', PAGE_REQUEST, pageWithElysiumInside()],
];

// ---------------------------------------------------------------------------- the read Worker's exchange, offline
const ORIGIN = 'https://app.example.invalid';
const ENV = Object.freeze({ APP_ORIGIN: ORIGIN, GATEWAY_ORIGIN: 'https://gateway.example.invalid', READ_V6_BRIDGE_ENABLED: 'true',
  ENABLED_V6_READS: 'portfolio,activity', ACCESS_CLIENT_ID: 'synthetic-service-id', ACCESS_CLIENT_SECRET: 'synthetic-service-secret' });

/** One read through `create` (a Worker build) whose gateway answers `answer`; the reply's status, text and JSON. */
async function viaWorker(create, route, request, answer) {
  const worker = create({ getClientIp: () => '203.0.113.7', fetch: async () => new Response(JSON.stringify(answer), {
    status: 200, headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': today.CONTRACT_VERSION } }) });
  const response = await worker.fetch(new Request(`${ORIGIN}/api/read/v6/${route}`, {
    method: 'POST', body: JSON.stringify(request), duplex: 'half',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', 'X-Domino-Read-Contract': today.CONTRACT_VERSION },
  }), ENV);
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) };
}
const WORKER_TODAY = createWorker;
const WORKER_ON_DAY9 = WORKER_DAY9.createWorker;

/** The app's read client over `runtime`, served `relayed` (the Worker's reply). */
function appRead(runtime, route, request, relayed) {
  const transport = { kind: 'http', post: async () => ({ status: relayed.status, body: relayed.body }) };
  return route === 'portfolio' ? readPortfolio(transport, runtime, request.wallet)
    : readActivity(transport, runtime, request.wallet, { limit: request.limit, cursor: request.cursor });
}

test('the skew itself: under one version, today\'s package and the day-9 one each refuse the other\'s portfolio and activity answers whole', { skip: SKIP }, () => {
  assert.deepEqual([...day9.CONTRACT_VERSIONS], [...today.CONTRACT_VERSIONS], 'one version: the same window');
  for (const [name, route, request, body] of FOUR_CHAIN()) {
    assert.deepEqual(chainsOf(body), FOUR, name);
    assert.equal(day9.validateExchange(route, request, body), true, `${name}: the day-9 package takes it`);
    assert.equal(today.validateResponse(route, body), false, `${name}: today's package refuses it`);
  }
  for (const route of ['portfolio', 'activity']) {
    const body = readV6Fixture(`valid/${route}.json`);
    assert.equal(today.validateResponse(route, body), true, route);
    assert.equal(day9.validateResponse(route, body), false, `${route}: a three-chain answer, refused by the day-9 package`);
  }
  // The requests are not where it breaks: every request today's app sends is one the day-9 package takes too.
  for (const [route, request] of [['portfolio', { wallet: WALLET }], ['activity', PAGE_REQUEST], ['chain-pools', { chainId: 8453, token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' }]]) {
    assert.equal(today.validateRequest(route, request) && day9.validateRequest(route, request), true, route);
  }
  // A chain read names its chains, so its answer is the same in either: the Wallet card's balances are not in the skew.
  const balances = readV6Fixture('valid/chain-balances-asked.json');
  const asked = readV6Fixture('requests/chain-balances.json');
  assert.equal(today.validateExchange('chain-balances', asked, balances) && day9.validateExchange('chain-balances', asked, balances), true);
});

test('his gateway first: today\'s read Worker relays a four-chain answer without Elysium, and today\'s app reads it', { skip: SKIP }, async () => {
  for (const [name, route, request, body] of FOUR_CHAIN()) {
    const relayed = await viaWorker(WORKER_TODAY, route, request, body);
    assert.equal(relayed.status, 200, name);
    assert.deepEqual(chainsOf(relayed.body), THREE, `${name}: nothing of Elysium relayed`);
    assert.equal(today.validateExchange(route, request, relayed.body), true, `${name}: what is relayed passes today's package whole`);
    for (const key of ['tokens', 'vaults', 'positions', 'mandates', 'credits', 'items']) {
      if (Array.isArray(body[key])) {
        assert.deepEqual(relayed.body[key], body[key].filter((entry) => entry.chainId !== ELYSIUM), `${name}: ${key}, every other entry as it came`);
      }
    }
    // The three chains' own coverage: Elysium out, unavailable or not, says nothing about them.
    assert.equal(relayed.body.coverage, relayed.body.chains.every((chain) => chain.status === 'current') ? 'complete' : 'partial', name);
    if (name.includes('the three current')) assert.deepEqual([body.coverage, relayed.body.coverage], ['partial', 'complete'], name);
    const read = await appRead(APP_TODAY, route, request, relayed);
    assert.equal(read.kind, 'ok', name);
    assert.deepEqual(chainsOf(read.body), THREE, name);
  }
});

test('then the day-9 read Worker: it relays the four chains as they came; today\'s app reads them without Elysium, the day-9 app whole', { skip: SKIP }, async () => {
  for (const [name, route, request, body] of FOUR_CHAIN()) {
    const relayed = await viaWorker(WORKER_ON_DAY9, route, request, body);
    assert.equal(relayed.status, 200, name);
    assert.equal(relayed.text, JSON.stringify(body), `${name}: byte for byte`);
    const read = await appRead(APP_TODAY, route, request, relayed);
    assert.equal(read.kind, 'ok', `${name}: today's app`);
    assert.deepEqual(chainsOf(read.body), THREE, `${name}: today's app draws the three`);
    assert.equal(today.validateExchange(route, request, read.body), true, `${name}: what today's app draws passes its package whole`);
    // The day-9 app, Elysium's switch off (no pin yet): the package's four checked, the three drawn (servedOnly).
    const whole = await appRead(APP_DAY9, route, request, relayed);
    assert.equal(whole.kind, 'ok', `${name}: the day-9 app`);
    assert.deepEqual(chainsOf(whole.body), THREE, `${name}: Elysium off, the three drawn`);
  }
});

test('never safe, and still refused: a day-9 Worker or app ahead of his gateway, and the day-9 app ahead of the day-9 Worker', { skip: SKIP }, async () => {
  for (const route of ['portfolio', 'activity']) {
    const three = readV6Fixture(`valid/${route}.json`);
    const request = { wallet: WALLET };
    // His gateway still on three chains: the day-9 Worker refuses its every answer (502), so every app shows a dash.
    const refused = await viaWorker(WORKER_ON_DAY9, route, request, three);
    assert.deepEqual([refused.status, refused.body], [502, { error: 'upstream_contract_mismatch' }], route);
    // ...and the day-9 app refuses a three-chain answer through today's Worker: nothing is ever made up for a missing chain.
    const relayed = await viaWorker(WORKER_TODAY, route, request, three);
    assert.equal(relayed.status, 200, route);
    assert.deepEqual(await appRead(APP_DAY9, route, request, relayed), { kind: 'invalid', detail: 'response' }, route);
  }
  // His gateway first but the day-9 app before the day-9 Worker: today's Worker relays three chains, the day-9 app wants four.
  const [, route, request, body] = FOUR_CHAIN()[0];
  const narrowed = await viaWorker(WORKER_TODAY, route, request, body);
  assert.deepEqual(await appRead(APP_DAY9, route, request, narrowed), { kind: 'invalid', detail: 'response' });
});

test('every rule still holds on what is left: a four-chain answer with any other defect is refused by today\'s Worker and app alike', { skip: SKIP }, async () => {
  const portfolio = portfolioWithElysium('current');
  const elysiumAt = portfolio.chains.findIndex((chain) => chain.chainId === ELYSIUM);
  const withChains = (chains) => ({ ...clone(portfolio), chains });
  const variants = [
    ['a page that ends on an Elysium receipt (its cursor names 99901, a chain today\'s package cannot ask for)', 'activity', PAGE_REQUEST, pageEndingOnElysium()],
    ['coverage "complete" while Elysium is not current', 'portfolio', { wallet: WALLET }, { ...portfolioWithElysium('unavailable', 'valid/portfolio-complete.json'), coverage: 'complete' }],
    ['Elysium listed twice', 'portfolio', { wallet: WALLET }, withChains([...portfolio.chains, portfolio.chains[elysiumAt]])],
    ['a chain id that is not one ("99901", on every Elysium entry)', 'portfolio', { wallet: WALLET }, Object.fromEntries(Object.entries(clone(portfolio)).map(([key, value]) =>
      [key, Array.isArray(value) ? value.map((entry) => (entry?.chainId === ELYSIUM ? { ...entry, chainId: String(ELYSIUM) } : entry)) : value]))],
    ['Elysium\'s entries without Elysium in `chains`', 'portfolio', { wallet: WALLET }, withChains(portfolio.chains.filter((c) => c.chainId !== ELYSIUM))],
    ['beside Elysium, a vault of a chain `chains` does not list', 'portfolio', { wallet: WALLET }, { ...clone(portfolio), vaults: [...portfolio.vaults, { ...portfolio.vaults[0], chainId: 999 }] }],
    ['Robinhood Chain missing', 'portfolio', { wallet: WALLET }, withChains(portfolio.chains.filter((c) => c.chainId !== 4663))],
    ['a Robinhood Chain vault of another owner', 'portfolio', { wallet: WALLET }, { ...clone(portfolio), vaults: portfolio.vaults.map((v, i) => (i === 0 ? { ...v, owner: `0x${'c3'.repeat(20)}` } : v)) }],
    ['an answer about another wallet', 'portfolio', { wallet: `0x${'c3'.repeat(20)}` }, portfolio],
    ['a page longer than asked', 'activity', { wallet: WALLET, limit: 3 }, activityWithElysium()],
  ];
  for (const [name, route, request, body] of variants) {
    const relayed = await viaWorker(WORKER_TODAY, route, request, body);
    assert.deepEqual([relayed.status, relayed.body], [502, { error: 'upstream_contract_mismatch' }], `today's Worker: ${name}`);
    // The app on its own (a Worker that relayed it as it came: the day-9 one, where it passes its package).
    const read = await appRead(APP_TODAY, route, request, { status: 200, body });
    assert.equal(read.kind, 'invalid', `today's app: ${name}`);
  }
});

test('an answer of the package\'s own chains is read exactly as before: relayed byte for byte, the same object drawn', { skip: SKIP }, async () => {
  for (const route of ['portfolio', 'activity']) {
    const text = JSON.stringify(readV6Fixture(`valid/${route}.json`));
    const relayed = await viaWorker(WORKER_TODAY, route, { wallet: WALLET }, JSON.parse(text));
    assert.equal(relayed.text, text, route);
    const body = JSON.parse(text);
    const read = await appRead(APP_TODAY, route, { wallet: WALLET }, { status: 200, body });
    assert.equal(read.kind, 'ok', route);
    assert.equal(read.body, body, route);
  }
});
