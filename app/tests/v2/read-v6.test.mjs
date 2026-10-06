/**
 * read-v6 (spec F7 rev2 §6.2): the app's client holds every answer to the package's own validator, never draws a
 * partial or malformed answer, says an error as `unavailable` with its code, and says a chain that is out as out
 * without emptying the others. The pins (src/v2/pins.ts) match the packages byte for byte.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import * as runtime from '../../../api-contracts/read-v6/runtime.mjs';
import * as planRuntime from '../../../api-contracts/position-plan-v1/runtime.mjs';

const require = createRequire(import.meta.url);
const { readPortfolio, readActivity, readChainPools, readChainBalances, readChainTokens, coverageNote, READ_V6_CONTRACT_VERSION } =
  require('../../.test-build/app/src/v2/read/v6.js');
const { createReadV6FixtureTransport } = require('../../.test-build/app/src/v2/read/v6FixtureTransport.js');
const { READ_V6_PIN, POSITION_PLAN_V1_PIN } = require('../../.test-build/app/src/v2/pins.js');

const CONTRACTS = resolve(import.meta.dirname, '../../../api-contracts');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixture = (path) => JSON.parse(readFileSync(join(CONTRACTS, 'read-v6', 'fixtures', path), 'utf8'));
const WALLET = fixture('requests/portfolio.json').wallet;
// A fixture answers the longest route its file name starts with, then `.` or `-`.
const routeOf = (file) => [...runtime.ROUTES].sort((a, b) => b.length - a.length)
  .find((r) => file.startsWith(r) && '.-'.includes(file[r.length]));
// What each route's client sends for an answer, read off the answer itself (the request fixtures for the stored routes).
async function readAs(route, transport, body, file) {
  if (route === 'chain-pools') return readChainPools(transport, runtime, body.chainId, body.token, body.pairedToken ?? undefined);
  if (route === 'chain-tokens') return readChainTokens(transport, runtime, body.chainId, body.query);
  if (route === 'chain-balances') {
    const asked = file.startsWith('chain-balances-asked') ? fixture('requests/chain-balances.json').tokens : undefined;
    return readChainBalances(transport, runtime, body.wallet, asked);
  }
  const request = fixture(`requests/${route}.json`);
  return route === 'portfolio' ? readPortfolio(transport, runtime, request.wallet)
    : readActivity(transport, runtime, request.wallet, { limit: request.limit, cursor: request.cursor });
}

for (const [name, pin, rt] of [['read-v6', READ_V6_PIN, runtime], ['position-plan-v1', POSITION_PLAN_V1_PIN, planRuntime]]) {
  test(`${name}: the pin matches the package's manifest and every file it lists`, () => {
    const bytes = readFileSync(join(CONTRACTS, name, 'manifest.json'));
    const manifest = JSON.parse(bytes);
    assert.equal(sha256(bytes), pin.manifestSha256, `${name}/manifest.json drifted from the pin`);
    assert.equal(manifest.contractVersion, pin.version);
    assert.equal(rt.CONTRACT_VERSION, pin.version);
    for (const file of manifest.files) assert.equal(sha256(readFileSync(join(CONTRACTS, name, file.path))), file.sha256, file.path);
  });
}

test('every valid stored fixture is read as ok, through the validator', async () => {
  assert.equal(READ_V6_CONTRACT_VERSION, runtime.CONTRACT_VERSION);
  const valid = readdirSync(join(CONTRACTS, 'read-v6', 'fixtures', 'valid')).filter((file) => !file.startsWith('chain-'));
  assert.ok(valid.length >= 10);
  for (const file of valid) {
    const route = routeOf(file);
    const transport = createReadV6FixtureTransport();
    transport.script(route, 200, fixture(`valid/${file}`));
    const request = fixture(`requests/${route}.json`);
    // The page fixture answers the request fixture (limit 3, a cursor); the others a first page at the default limit.
    const page = file === 'activity-page.json' ? { limit: request.limit, cursor: request.cursor } : {};
    const reply = route === 'portfolio'
      ? await readPortfolio(transport, runtime, request.wallet.toUpperCase().replace('0X', '0x'))
      : await readActivity(transport, runtime, request.wallet, page);
    assert.equal(reply.kind, 'ok', file);
    assert.equal(transport.calls()[0].body.wallet, request.wallet, 'sent in lower case');
  }
});

test('every valid chain read is read as ok, its request built by its own client', async () => {
  const valid = readdirSync(join(CONTRACTS, 'read-v6', 'fixtures', 'valid')).filter((file) => file.startsWith('chain-'));
  assert.ok(valid.length >= 8);
  for (const file of valid) {
    const route = routeOf(file);
    const transport = createReadV6FixtureTransport();
    const body = fixture(`valid/${file}`);
    transport.script(route, 200, body);
    const reply = await readAs(route, transport, body, file);
    assert.equal(reply.kind, 'ok', file);
  }
});

test('every invalid fixture is refused whole: nothing of it is drawn', async () => {
  for (const file of readdirSync(join(CONTRACTS, 'read-v6', 'fixtures', 'invalid'))) {
    const route = routeOf(file);
    const transport = createReadV6FixtureTransport();
    const body = fixture(`invalid/${file}`);
    transport.script(route, 200, body);
    const base = fixture(`valid/${route}.json`);
    const reply = await readAs(route, transport, route.startsWith('chain-') ? base : body, file);
    assert.equal(reply.kind, 'invalid', file);
  }
});

test('an answer about another wallet is refused (validateExchange); an error is unavailable with its code; a network failure too', async () => {
  const transport = createReadV6FixtureTransport();
  transport.script('portfolio', 200, fixture('valid/portfolio.json'));
  assert.deepEqual(await readPortfolio(transport, runtime, '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'), { kind: 'invalid', detail: 'exchange' });
  transport.script('portfolio', 503, { error: 'upstream_unavailable' });
  assert.deepEqual(await readPortfolio(transport, runtime, WALLET), { kind: 'unavailable', reason: 'upstream_unavailable' });
  transport.script('portfolio', 503, { error: 'not_a_code' });
  assert.deepEqual(await readPortfolio(transport, runtime, WALLET), { kind: 'invalid', detail: 'error_body' });
  assert.deepEqual(await readActivity(transport, runtime, WALLET), { kind: 'unavailable', reason: 'network' }, 'nothing scripted');
  assert.deepEqual(await readPortfolio(transport, runtime, '0x12'), { kind: 'invalid', detail: 'request' });
  assert.deepEqual(await readActivity(transport, runtime, WALLET, { limit: 51 }), { kind: 'invalid', detail: 'request' }, 'limit 1 to 50');
});

test('one chain out is said as out, and never empties the others (§6.3)', () => {
  const chains = fixture('valid/portfolio-behind.json').chains;
  const out = (ids) => chains.map((c) => (ids.includes(c.chainId) ? { ...c, status: 'unavailable', reason: 'never_indexed' } : { ...c, status: 'current', reason: null }));
  // Changed on purpose 2026-10-06 (the owner: one name for one network): Arbitrum One, as every other screen names it.
  assert.equal(coverageNote(out([4663])), 'Showing Base and Arbitrum One. Robinhood Chain is unavailable right now.');
  assert.equal(coverageNote(out([])), null);
  assert.equal(coverageNote(out([4663, 8453, 42161])), 'Robinhood Chain, Base and Arbitrum One are unavailable right now.');
});
