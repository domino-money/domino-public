/**
 * A position's feature, read from chain (2026-09-24, the owner's three features joined up): POST
 * /api/automation/v1/state (functions/_lib/automation.ts) over a fake chain that answers only the calls it may make,
 * and the page's client (src/lib/automationState.ts) checking the answer field by field. A sequence holds its root
 * NFT as its PositionManager subscriber (contracts/src/DominoVaultV4.sol _armRoot), so a position is plain when it
 * has no subscriber, and Auto-compound or Domino-compound when its subscriber is a vault the pinned factory made
 * whose root is that NFT; any other subscriber is `other`, and nothing more is said of it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { decodeFunctionData, encodeFunctionResult, numberToHex, parseAbi, toFunctionSelector } from 'viem';
import { memoryCache, multicallAbi } from './owned-chain.mjs';

const require = createRequire(import.meta.url);
const endpoint = require('../.test-build/app/functions/_lib/automation.js');
const owned = require('../.test-build/app/functions/_lib/owned.js');
const client = require('../.test-build/app/src/lib/automationState.js');
const { FEATURES, FEATURE_ORDER } = require('../.test-build/app/src/lib/automate/features.js');
const { CREATE } = require('../.test-build/app/src/lib/create/copy.js');
const { AUTOMATION_FEE_BPS } = require('../.test-build/app/src/finance/sequence.js');

const PM = owned.POSITION_MANAGER;
const FACTORY = endpoint.SEQUENCE_FACTORY;
const ZERO = '0x0000000000000000000000000000000000000000';
const HEAD = 71_800_000;
const pmAbi = parseAbi(['function subscriber(uint256) view returns (address)']);
const factoryAbi = parseAbi(['function isVault(address) view returns (bool)']);
const vaultAbi = parseAbi([
  'struct Policy { uint16 serviceFeeBps; uint16 triggerDistanceBps; uint16 maxOverlapBps; uint32 minimumIntervalSeconds; uint8 maxPositions; uint64 version; bool paused; }',
  'function rootTokenId() view returns (uint256)',
  'function policy() view returns (Policy)',
  'function rootPermissionValid() view returns (bool)',
]);
const vault = (n) => `0x${String(n).repeat(40)}`;
const policy = (serviceFeeBps, paused) => ({ serviceFeeBps, triggerDistanceBps: 500, maxOverlapBps: 2000, minimumIntervalSeconds: 3600, maxPositions: serviceFeeBps === 200 ? 1 : 3, version: 1n, paused });

/**
 * `subscribers`: per id, its subscriber (none: zero). `vaults`: per address, { made, root, fee, paused, valid }; an
 * address not in it reverts every vault call and is no vault of the factory.
 */
function fakeChain({ subscribers = {}, vaults = {}, script = [] } = {}) {
  const log = [];
  const ok = (abi, functionName, result) => ({ success: true, returnData: encodeFunctionResult({ abi, functionName, result }) });
  const revert = { success: false, returnData: '0x' };
  const view = (target, data) => {
    if (target === PM) {
      const { functionName, args } = decodeFunctionData({ abi: pmAbi, data });
      assert.equal(functionName, 'subscriber');
      return ok(pmAbi, functionName, subscribers[args[0].toString()] ?? ZERO);
    }
    if (target === FACTORY) {
      const { functionName, args } = decodeFunctionData({ abi: factoryAbi, data });
      assert.equal(functionName, 'isVault');
      return ok(factoryAbi, functionName, vaults[args[0].toLowerCase()]?.made ?? false);
    }
    const entry = vaults[target];
    assert.ok(target in subscribers || Object.values(subscribers).includes(target), `a call to ${target}, which is no subscriber`);
    if (!entry) return revert;
    const { functionName } = decodeFunctionData({ abi: vaultAbi, data });
    if (functionName === 'rootTokenId') return ok(vaultAbi, functionName, BigInt(entry.root));
    if (functionName === 'policy') return ok(vaultAbi, functionName, policy(entry.fee, entry.paused));
    return ok(vaultAbi, functionName, entry.valid);
  };
  const deps = {
    time: 0,
    now: () => deps.time,
    sleep: async () => {},
    fetch: async (url, init) => {
      assert.equal(url, owned.RPC_URL);
      const body = JSON.parse(init.body);
      log.push({ method: body.method, params: body.params });
      const scripted = script.shift();
      if (scripted) return scripted;
      if (body.method === 'eth_blockNumber') return Response.json({ jsonrpc: '2.0', id: body.id, result: numberToHex(HEAD) });
      assert.equal(body.method, 'eth_call', `the endpoint asked ${body.method}`);
      const [call, block] = body.params;
      assert.equal(call.to, owned.MULTICALL3);
      assert.equal(block, numberToHex(HEAD), 'both reads are pinned to the head');
      const { args } = decodeFunctionData({ abi: multicallAbi, data: call.data });
      for (const sub of args[0]) assert.equal(sub.allowFailure, true);
      const result = encodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', result: args[0].map((sub) => view(sub.target.toLowerCase(), sub.callData)) });
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    },
  };
  return { deps, log };
}

const ask = (body, headers = {}) =>
  new Request('https://domino.money/api/automation/v1/state', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://domino.money', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('the fixed calls: the selectors are the contracts’ own, and the factory is the pinned one', () => {
  for (const [name, signature] of [
    ['subscriber', 'subscriber(uint256)'],
    ['isVault', 'isVault(address)'],
    ['rootTokenId', 'rootTokenId()'],
    ['policy', 'policy()'],
    ['rootPermissionValid', 'rootPermissionValid()'],
  ]) assert.equal(`0x${endpoint.AUTOMATION_SELECTOR[name]}`, toFunctionSelector(signature), name);
  const pin = readFileSync(new URL('../src/finance/pin.ts', import.meta.url), 'utf8');
  assert.match(pin, new RegExp(`export const SEQUENCE_FACTORY: Pin = '${FACTORY}'`), 'the factory the sequence lane pins');
});

test('a plain position, both automations paused or running, a lost permission, and subscribers that are not Domino’s', async () => {
  const chain = fakeChain({
    subscribers: { 11: vault(1), 12: vault(2), 13: vault(3), 14: vault(4), 15: vault(5), 16: vault(6) },
    vaults: {
      [vault(1)]: { made: true, root: 11, fee: 200, paused: true, valid: true },
      [vault(2)]: { made: true, root: 12, fee: 400, paused: false, valid: true },
      [vault(3)]: { made: true, root: 13, fee: 400, paused: false, valid: false },
      // Made by someone else: the same functions, but the factory never made it.
      [vault(4)]: { made: false, root: 14, fee: 200, paused: true, valid: true },
      // The factory's vault, but its root is another NFT: this one is only subscribed to it.
      [vault(5)]: { made: true, root: 99, fee: 200, paused: true, valid: true },
    },
  });
  const answer = await endpoint.scanAutomation(chain.deps, [10n, 11n, 12n, 13n, 14n, 15n, 16n]);
  assert.deepEqual(answer, {
    block: HEAD,
    positions: [
      { tokenId: '10', automation: 'plain' },
      { tokenId: '11', automation: 'compound', paused: true, active: false, vault: vault(1) },
      { tokenId: '12', automation: 'domino', paused: false, active: true, vault: vault(2) },
      { tokenId: '13', automation: 'domino', paused: false, active: false, vault: vault(3) },
      { tokenId: '14', automation: 'other' },
      { tokenId: '15', automation: 'other' },
      { tokenId: '16', automation: 'other' },
    ],
  });
  assert.deepEqual(chain.log.map((entry) => entry.method), ['eth_blockNumber', 'eth_call', 'eth_call'], 'the head and two batched reads');
  // The client takes the answer as it came, and says each state in the app's words.
  const ids = answer.positions.map((entry) => entry.tokenId);
  assert.deepEqual(client.parseAutomationAnswer(JSON.parse(JSON.stringify(answer)), ids), answer);
  assert.deepEqual(answer.positions.filter((entry) => 'paused' in entry).map(client.automationWord), ['Paused', 'Active', 'Stopped']);
});

test('when no position has a subscriber, one batched read is all', async () => {
  const chain = fakeChain();
  const answer = await endpoint.scanAutomation(chain.deps, [3135288n, 3202568n]);
  assert.deepEqual(answer.positions, [{ tokenId: '3135288', automation: 'plain' }, { tokenId: '3202568', automation: 'plain' }]);
  assert.deepEqual(chain.log.map((entry) => entry.method), ['eth_blockNumber', 'eth_call']);
});

test('the request: exactly {"tokenIds": [...]}, canonical and distinct, at most 100, same-origin JSON POST only', async () => {
  const chain = fakeChain();
  const status = async (request) => (await endpoint.answerAutomation(request, chain.deps)).status;
  assert.equal(await status(ask({ tokenIds: ['1'] })), 200);
  for (const body of [{}, { tokenIds: [] }, { tokenIds: ['01'] }, { tokenIds: ['1', '1'] }, { tokenIds: [1] }, { tokenIds: ['1'], fresh: true }, { owner: ZERO }, 'nope', { tokenIds: Array.from({ length: 101 }, (_, i) => String(i + 1)) }, { tokenIds: [(2n ** 256n).toString()] }]) {
    assert.equal(await status(ask(body)), 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal(await status(ask({ tokenIds: Array.from({ length: 100 }, (_, i) => String(i + 1)) })), 200, 'a hundred ids, the most Positions lists');
  assert.equal(await status(ask({ tokenIds: ['1'] }, { Origin: 'https://evil.test' })), 403);
  assert.equal(await status(ask({ tokenIds: ['1'] }, { 'Sec-Fetch-Site': 'cross-site' })), 403);
  assert.equal(await status(ask({ tokenIds: ['1'] }, { 'Content-Type': 'text/plain' })), 415);
  assert.equal(await status(new Request('https://domino.money/api/automation/v1/state')), 405);
});

test('an answer is kept for the same ids, in any order, and a chain that cannot be read is a 502, never a partial answer', async () => {
  const { cache, stored } = memoryCache();
  const chain = fakeChain({ subscribers: { 7: vault(7) }, vaults: { [vault(7)]: { made: true, root: 7, fee: 200, paused: true, valid: true } } });
  const first = await endpoint.answerAutomation(ask({ tokenIds: ['7', '8'] }), chain.deps, cache);
  assert.equal(first.status, 200);
  const calls = chain.log.length;
  chain.deps.time = (endpoint.ANSWER_SECONDS - 1) * 1000;
  const again = await endpoint.answerAutomation(ask({ tokenIds: ['8', '7'] }), chain.deps, cache);
  assert.deepEqual((await again.json()).positions.map((entry) => entry.tokenId), ['8', '7'], 'in the order this question asked');
  assert.equal(chain.log.length, calls, 'from the cache: no RPC call');
  assert.ok([...stored.keys()].every((key) => /^https:\/\/domino\.money\/api\/automation\/v1\/cache\/[0-9a-f]{64}$/.test(key)), 'a digest, no id, in the cache key');

  const down = fakeChain({ script: [new Response('busy', { status: 503 }), new Response('busy', { status: 503 }), new Response('busy', { status: 503 }), new Response('busy', { status: 503 })] });
  const failed = await endpoint.answerAutomation(ask({ tokenIds: ['9'] }), down.deps, memoryCache().cache);
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), { error: 'chain_unavailable' });
});

test('the client refuses any answer that is not exactly the ids asked, in order, with their fields', () => {
  const ok = { block: 5, positions: [{ tokenId: '1', automation: 'plain' }, { tokenId: '2', automation: 'domino', paused: true, active: false, vault: vault(2) }] };
  assert.deepEqual(client.parseAutomationAnswer(ok, ['1', '2']), ok);
  for (const [answer, ids] of [
    [ok, ['2', '1']],
    [ok, ['1']],
    [{ ...ok, extra: 1 }, ['1', '2']],
    [{ block: -1, positions: ok.positions }, ['1', '2']],
    [{ block: 5, positions: [{ tokenId: '1', automation: 'plain', paused: false }] }, ['1']],
    [{ block: 5, positions: [{ tokenId: '1', automation: 'compound', paused: true, active: true, vault: vault(1) }] }, ['1']],
    [{ block: 5, positions: [{ tokenId: '1', automation: 'compound', paused: false, active: true, vault: 'nope' }] }, ['1']],
    [{ block: 5, positions: [{ tokenId: '1', automation: 'managed' }] }, ['1']],
    [null, ['1']],
  ]) assert.equal(client.parseAutomationAnswer(answer, ids), null, JSON.stringify(answer).slice(0, 80));
});

test('the three features have one name and one line each, in the order they are offered', () => {
  assert.deepEqual(FEATURE_ORDER, ['plain', 'compound', 'domino']);
  assert.deepEqual(FEATURE_ORDER.map((key) => FEATURES[key].name), ['Plain position', 'Auto-compound', 'Domino-compound']);
  assert.deepEqual(FEATURE_ORDER.map((key) => FEATURES[key].fee), [null, '2%', '4%']);
  for (const key of FEATURE_ORDER) assert.match(FEATURES[key].line, /^[A-Z][^.]*\.$/, key);
  // Review of 2026-09-24: one line per feature wherever it is offered. New position's success says what the automation
  // page's own options say (without their fee sentence), and the fees are the contract's, so the two pages cannot drift.
  const { options } = CREATE.automation;
  assert.deepEqual([FEATURES.plain.name, FEATURES.plain.line], [options.none.title, options.none.line]);
  for (const key of ['compound', 'domino']) {
    assert.equal(FEATURES[key].name, options[key].title, key);
    assert.equal(FEATURES[key].line, options[key].line.slice(0, options[key].line.indexOf('.') + 1), key);
    assert.equal(FEATURES[key].fee, `${AUTOMATION_FEE_BPS[key] / 100}%`, key);
    assert.ok(options[key].line.endsWith(` ${FEATURES[key].fee} of earned fees consumed.`), key);
  }
});

// Changed on purpose (2026-09-25): the public RPC answers 429 to every call from Cloudflare's edge, so POST
// /api/automation/v1/state could never answer in production and no position ever said its feature. The page runs the
// route's own scan itself (src/lib/automationState.ts readAutomation, through the chain code chunk and the page's one
// fetcher, src/lib/chain/browser.ts), as it reads the wallet's positions and a position's state.
test('the page reads the chain itself: the scan’s fixed calls, POSTed to the public RPC with no credentials and no referrer, and the same answer the route gives', async () => {
  const setup = { subscribers: { 11: vault(1) }, vaults: { [vault(1)]: { made: true, root: 11, fee: 200, paused: true, valid: true } } };
  const original = globalThis.fetch;
  const flags = [globalThis.__DOMINO_DEPLOYABLE__, globalThis.__DOMINO_TEST_HOOKS__];
  const sent = [];
  let chain = fakeChain(setup);
  globalThis.fetch = async (url, init) => {
    sent.push({ url, init });
    return chain.deps.fetch(url, init);
  };
  try {
    globalThis.__DOMINO_DEPLOYABLE__ = true;
    globalThis.__DOMINO_TEST_HOOKS__ = false;
    const answer = await client.readAutomation(['10', '11']);
    assert.deepEqual(answer, {
      block: HEAD,
      positions: [
        { tokenId: '10', automation: 'plain' },
        { tokenId: '11', automation: 'compound', paused: true, active: false, vault: vault(1) },
      ],
    });
    const route = await endpoint.answerAutomation(ask({ tokenIds: ['10', '11'] }), fakeChain(setup).deps);
    assert.deepEqual(answer, await route.json(), 'the route’s answer, field for field');
    assert.deepEqual(chain.log.map((entry) => entry.method), ['eth_blockNumber', 'eth_call', 'eth_call'], 'the head and two batched reads');
    for (const { url, init } of sent) {
      assert.equal(url, owned.RPC_URL);
      assert.deepEqual({ ...init, body: undefined, signal: undefined }, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: undefined, signal: undefined, credentials: 'omit', referrerPolicy: 'no-referrer' });
    }
    // A chain that cannot be read says nothing: no state, never a guess.
    chain = fakeChain({ script: Array.from({ length: 8 }, () => new Response('busy', { status: 503 })) });
    assert.equal(await client.readAutomation(['12'], chain.deps), null);
    // Nothing is asked for ids the scan would refuse, nor in a build not meant to reach the chain.
    const before = sent.length;
    for (const ids of [[], ['1', '1'], ['01'], [(2n ** 256n).toString()], Array.from({ length: 101 }, (_, i) => String(i + 1))]) assert.equal(await client.readAutomation(ids), null, JSON.stringify(ids).slice(0, 40));
    globalThis.__DOMINO_DEPLOYABLE__ = false;
    assert.equal(await client.readAutomation(['1']), null);
    assert.equal(sent.length, before, 'nothing was asked');
  } finally {
    globalThis.fetch = original;
    [globalThis.__DOMINO_DEPLOYABLE__, globalThis.__DOMINO_TEST_HOOKS__] = flags;
  }
});
