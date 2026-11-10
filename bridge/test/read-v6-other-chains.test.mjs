// read-v6 answers naming a chain beyond the package's (added 2026-11-07, the read-v6 version skew;
// app/docs/ELYSIUM_DAY9.md "Order"): a read gateway whose read-v6 names one chain more under the same contract version
// (Elysium, 99901, on day 9) answers every portfolio and activity with it. This Worker checks such an answer again
// without that chain and relays only what it checked; every rule of the package still holds on what is left, and an
// answer of the package's own chains is relayed byte for byte, as before. app/tests/v2/read-v6-skew.test.mjs runs the
// same with rugged97's runtime over his day-9 data.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CONSTANTS } from '../../api-contracts/read-v6/schema-data.mjs';
import { CONTRACT_VERSION, validateExchange, validateResponse } from '../../api-contracts/read-v6/runtime.mjs';
import { createWorker } from '../src/worker.mjs';

const fixtures = new URL('../../api-contracts/read-v6/fixtures/', import.meta.url);
const fixture = (path) => JSON.parse(readFileSync(new URL(path, fixtures), 'utf8'));
// A chain the package does not name: Elysium until read-v6 names it, then HyperEVM's id.
const OTHER = CONSTANTS.chainIds.includes(99901) ? 999 : 99901;
const FIRST = CONSTANTS.chainIds[0];
const WALLET = fixture('requests/portfolio.json').wallet;
const PAGE_REQUEST = fixture('requests/activity.json');
const PER_CHAIN = ['tokens', 'vaults', 'positions', 'mandates', 'credits', 'items'];
const origin = 'https://app.example.invalid';
const env = {
  APP_ORIGIN: origin, GATEWAY_ORIGIN: 'https://gateway.example.invalid', READ_V6_BRIDGE_ENABLED: 'true',
  ENABLED_V6_READS: 'portfolio,activity,chain-pools', ACCESS_CLIENT_ID: 'synthetic-service-id', ACCESS_CLIENT_SECRET: 'synthetic-service-secret',
};

const key = (t) => `${String(t.chainId).padStart(20, '0')}:${t.address}`;
const itemKey = (item) => [item.tx.snapshot.timestamp, item.chainId, item.tx.snapshot.number, Number(item.id.split(':')[2])];
const newestFirst = (a, b) => {
  const [x, y] = [itemKey(a), itemKey(b)];
  const at = x.findIndex((value, index) => value !== y[index]);
  return at === -1 ? 0 : x[at] > y[at] ? -1 : 1;
};

/** `body` (an answer of the package's own chains) with OTHER beside them: a copy of the first chain's status and entries. */
function withOther(body, { status = 'current' } = {}) {
  const base = body.chains.find((c) => c.chainId === FIRST);
  const other = status === 'current' ? { ...structuredClone(base), chainId: OTHER }
    : { ...structuredClone(base), chainId: OTHER, status: 'unavailable', reason: 'deployment_not_registered', deployment: null,
      finalizedThrough: null, head: null, indexedThrough: null, lagBlocks: null, lagSeconds: null, lastError: null,
      automationHalted: null, operatorsAdmitted: null, waitingReasons: { ageSeconds: null, block: null, status: 'not_configured', timestamp: null } };
  const chains = [...body.chains, other];
  const out = { ...structuredClone(body), chains, coverage: chains.every((c) => c.status === 'current') ? 'complete' : 'partial' };
  if (status !== 'current') return out;
  const copies = (list) => list.filter((entry) => entry.chainId === FIRST).map((entry) => ({ ...structuredClone(entry), chainId: OTHER }));
  out.tokens = [...body.tokens, ...copies(body.tokens).map((t) => ({ ...t, price: null, priceReason: 'no_qualified_price_source' }))]
    .sort((a, b) => (key(a) < key(b) ? -1 : 1));
  for (const name of ['vaults', 'positions', 'mandates', 'credits']) if (Array.isArray(body[name])) out[name] = [...body[name], ...copies(body[name])];
  if (Array.isArray(body.items)) {
    out.items = [...body.items, ...copies(body.items).slice(0, 6).map((item) => ({ ...item, id: `${OTHER}:${item.id.split(':').slice(1).join(':')}` }))]
      .sort(newestFirst);
  }
  return out;
}

/** What the package's own chains say: OTHER's entries out, the coverage then the rest's own. */
function without(body) {
  const out = { ...structuredClone(body) };
  for (const name of ['chains', ...PER_CHAIN]) if (Array.isArray(body[name])) out[name] = body[name].filter((entry) => entry.chainId !== OTHER);
  out.coverage = out.chains.every((c) => c.status === 'current') ? 'complete' : 'partial';
  return out;
}

async function read(route, request, answer) {
  const calls = [];
  const worker = createWorker({ getClientIp: () => '203.0.113.7', fetch: async (url, init) => {
    calls.push(url);
    return new Response(typeof answer === 'string' ? answer : JSON.stringify(answer), {
      status: 200, headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': CONTRACT_VERSION } });
  } });
  const response = await worker.fetch(new Request(`${origin}/api/read/v6/${route}`, {
    method: 'POST', body: JSON.stringify(request), duplex: 'half',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
  }), env);
  assert.equal(calls.length, 1, 'one upstream call, no retry');
  const text = await response.text();
  return { status: response.status, version: response.headers.get('X-Domino-Read-Contract'), text, body: JSON.parse(text) };
}

const ANSWERS = () => [
  ['portfolio, the other chain read', 'portfolio', { wallet: WALLET }, withOther(fixture('valid/portfolio.json'))],
  ['portfolio, the other chain not registered', 'portfolio', { wallet: WALLET }, withOther(fixture('valid/portfolio.json'), { status: 'unavailable' })],
  ['portfolio, every own chain current', 'portfolio', { wallet: WALLET }, withOther(fixture('valid/portfolio-complete.json'), { status: 'unavailable' })],
  ['activity, a first page', 'activity', { wallet: WALLET }, withOther(fixture('valid/activity.json'))],
  ['activity, an empty one', 'activity', { wallet: WALLET }, withOther(fixture('valid/activity-empty.json'), { status: 'unavailable' })],
];

test('an answer naming a chain beyond the package\'s is relayed without it, the rest exactly as it came and checked whole', async () => {
  for (const [name, route, request, answer] of ANSWERS()) {
    assert.equal(validateResponse(route, answer), false, `${name}: the package refuses it whole`);
    const expected = without(answer);
    assert.equal(validateExchange(route, request, expected), true, `${name}: what is left passes the package and the request`);
    const reply = await read(route, request, answer);
    assert.equal(reply.status, 200, name);
    assert.equal(reply.version, CONTRACT_VERSION, name);
    assert.deepEqual(reply.body, expected, name);
    assert.equal(reply.text, JSON.stringify(expected), `${name}: only what was checked is relayed`);
    // Changed on purpose 2026-11-07 (day-9 rehearsal): the whole number, since on day 9 OTHER is 999 and the package's own
    // `"chainId":99901` starts with `"chainId":999`.
    assert.equal(new RegExp(`"chainId":${OTHER}[,}]`).test(reply.text), false, `${name}: not a byte of the other chain`);
  }
  // The other chain out says nothing about the package's own: all of them current is complete.
  const [, , , complete] = ANSWERS()[2];
  assert.deepEqual([complete.coverage, without(complete).coverage], ['partial', 'complete']);
});

test('every other rule still holds: an answer naming another chain is refused whole for any other defect', async () => {
  const portfolio = withOther(fixture('valid/portfolio.json'));
  const page = withOther(fixture('valid/activity-page.json'));
  const renamed = (body, to) => Object.fromEntries(Object.entries(structuredClone(body)).map(([name, value]) =>
    [name, Array.isArray(value) ? value.map((entry) => (entry?.chainId === OTHER ? { ...entry, chainId: to } : entry)) : value]));
  // A page whose last receipt is on the other chain: its cursor names a chain this package cannot ask for.
  const last = page.items.at(-1);
  const endsOnOther = { ...page, items: [...page.items.slice(0, -1), { ...last, chainId: OTHER, id: `${OTHER}:${last.id.split(':').slice(1).join(':')}` }],
    nextCursor: `${last.tx.snapshot.timestamp}.${OTHER}.${last.tx.snapshot.number}.${last.id.split(':')[2]}` };
  for (const [name, route, request, answer] of [
    ['its coverage not its own chains\' (complete, the other chain unavailable)', 'portfolio', { wallet: WALLET },
      { ...withOther(fixture('valid/portfolio-complete.json'), { status: 'unavailable' }), coverage: 'complete' }],
    ['the other chain listed twice', 'portfolio', { wallet: WALLET }, { ...portfolio, chains: [...portfolio.chains, portfolio.chains.at(-1)] }],
    ['a chain id that is not one (a string)', 'portfolio', { wallet: WALLET }, renamed(portfolio, String(OTHER))],
    ['a chain id that is not one (zero)', 'portfolio', { wallet: WALLET }, renamed(portfolio, 0)],
    ['entries of a chain `chains` does not list', 'portfolio', { wallet: WALLET }, { ...portfolio, chains: portfolio.chains.filter((c) => c.chainId !== OTHER) }],
    ['beside the other chain, entries of a chain `chains` does not list', 'portfolio', { wallet: WALLET },
      { ...portfolio, vaults: [...portfolio.vaults, { ...portfolio.vaults[0], chainId: OTHER + 1 }] }],
    ['one of the package\'s chains missing', 'portfolio', { wallet: WALLET }, { ...portfolio, chains: portfolio.chains.filter((c) => c.chainId !== FIRST) }],
    ['an entry of the package\'s own chains broken (a vault of another owner)', 'portfolio', { wallet: WALLET },
      { ...portfolio, vaults: portfolio.vaults.map((v, i) => (i === 0 ? { ...v, owner: `0x${'c3'.repeat(20)}` } : v)) }],
    ['an unknown key', 'portfolio', { wallet: WALLET }, { ...portfolio, extra: true }],
    ['about another wallet', 'portfolio', { wallet: `0x${'c3'.repeat(20)}` }, portfolio],
    ['a page that ends on the other chain', 'activity', PAGE_REQUEST, endsOnOther],
    ['a page longer than asked once the other chain is out', 'activity', { wallet: WALLET, limit: 3 }, withOther(fixture('valid/activity.json'))],
  ]) {
    const reply = await read(route, request, answer);
    assert.deepEqual([reply.status, reply.body], [502, { error: 'upstream_contract_mismatch' }], name);
  }
});

test('only the wallet reads that list chains are checked so: a chain read about another chain is refused as before', async () => {
  const pools = fixture('valid/chain-pools.json');
  const reply = await read('chain-pools', { chainId: pools.chainId, token: pools.token, ...(pools.pairedToken ? { pairedToken: pools.pairedToken } : {}) },
    { ...pools, chainId: OTHER });
  assert.deepEqual([reply.status, reply.body], [502, { error: 'upstream_contract_mismatch' }]);
});

test('an answer of the package\'s own chains is relayed byte for byte, its spelling kept', async () => {
  for (const [route, file, request] of [['portfolio', 'portfolio.json', { wallet: WALLET }], ['activity', 'activity-page.json', PAGE_REQUEST]]) {
    // Spaces and key order as the gateway wrote them: never parsed and written again.
    const text = readFileSync(new URL(`valid/${file}`, fixtures), 'utf8');
    const reply = await read(route, request, text);
    assert.equal(reply.status, 200, file);
    assert.equal(reply.text, text, file);
  }
});
