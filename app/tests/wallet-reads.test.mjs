/**
 * The reads the wallet feature asks of the site (src/lib/walletReads.ts, RPC-SPEC D6 and D7, 2026-10-01, the owner's
 * rule: nothing is read from a public RPC). A WalletConnect wallet's reads and the C6 fallback (a read the connected
 * wallet's own RPC could not answer) are refused at once with no network call, as a read the chain could not answer
 * (-32603). A batch's simulation, for a wallet that does not carry eth_simulateV1, goes to the site's fixed route
 * POST /api/chain/v1/simulate (off unless the deployment turns it on): while it is off, or when the node does not carry
 * the method, it is "not available" (-32601), and finance/batch.ts goes on step by step.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { edgeFetch } from './support/edge-routes.mjs';
import { fakeChain } from './owned-chain.mjs';

const require = createRequire(import.meta.url);
const reads = require('../.test-build/app/src/lib/walletReads.js');
const batch = require('../.test-build/app/src/finance/batch.js');

const OWNER = '0xf6184f814543b88dd867c34ce6e9f56ab7d18c0a';
const SETUP = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';
const CALLS = [{ to: TOKEN, data: '0x095ea7b3' + '00'.repeat(64), value: '0x0' }, { to: SETUP, data: '0xabcdef01', value: '0x2386f26fc10000' }];
/** Exactly what finance/batch.ts simulateBatch asks. */
const paramsOf = (calls = CALLS, owner = OWNER) => [{ blockStateCalls: [{ calls: calls.map((call) => ({ from: owner, to: call.to, data: call.data, value: call.value })) }], validation: false }, 'latest'];
const RESULT = [{ calls: [{ status: '0x1', gasUsed: '0xb411' }, { status: '0x1', gasUsed: '0x3a98' }] }];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Runs `run` with the page's network call answering `answer`; what it was asked. */
async function withFetch(answer, run) {
  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (path, init) => {
    sent.push({ path, init });
    return answer(path, init);
  };
  try {
    return { result: await run().then((value) => ({ value }), (error) => ({ error })), sent };
  } finally {
    globalThis.fetch = original;
  }
}

test('every read the wallet feature asks of the site is refused at once, with no network call, as a read the chain could not answer', async () => {
  for (const method of ['eth_call', 'eth_getCode', 'eth_getBalance', 'eth_estimateGas', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getTransactionCount', 'eth_getTransactionReceipt', 'eth_gasPrice', 'eth_sendTransaction', 'eth_sign', 'wallet_sendCalls', 'anything']) {
    const { result, sent } = await withFetch(() => assert.fail('asked the network'), () => reads.readOnChain(method, [{ to: TOKEN, data: '0x' }, 'latest'], true));
    assert.equal(sent.length, 0, method);
    assert.equal(result.error?.code, -32603, method);
    // Changed on purpose 2026-10-02 (review finding 16): the site's own refusal, under its own message, so the money flows
    // can tell it from a wallet whose RPC failed (finance/setup.ts siteRefused).
    assert.equal(result.error?.message, 'site_reads_unavailable', method);
    assert.equal(result.error?.message, reads.SITE_READS_UNAVAILABLE);
  }
  // The chain code's barrel hands the money code these very functions (its import is unchanged).
  const barrel = require('../.test-build/app/src/lib/chain/chainCode.js');
  assert.equal(barrel.readOnChain, reads.readOnChain);
  assert.equal(barrel.simulateOnChain, reads.simulateOnChain);
});

test('a batch’s simulation is POSTed to the site’s fixed route as the owner and its calls, exactly what finance/batch.ts asks, lowercase', async () => {
  const { result, sent } = await withFetch(async () => json({ v: 1, result: RESULT }), () => reads.readOnChain('eth_simulateV1', paramsOf(CALLS, OWNER.toUpperCase().replace('0X', '0x'))));
  assert.deepEqual(result.value, RESULT);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].path, '/api/chain/v1/simulate');
  assert.deepEqual(JSON.parse(sent[0].init.body), { owner: OWNER, calls: CALLS });
  assert.deepEqual({ ...sent[0].init, body: undefined }, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: undefined, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: undefined });
  // Mixed case is the same bytes and numbers: sent in the one case the route takes.
  const upper = await withFetch(async () => json({ v: 1, result: RESULT }), () => reads.simulateOnChain(paramsOf([{ to: TOKEN.toUpperCase().replace('0X', '0x'), data: '0xABCDEF01', value: '0xFF' }])));
  assert.deepEqual(JSON.parse(upper.sent[0].init.body).calls, [{ to: TOKEN, data: '0xabcdef01', value: '0xff' }]);
});

test('anything but that exact shape is refused before it is sent (-32602)', async () => {
  const [options] = paramsOf();
  const call = options.blockStateCalls[0].calls[0];
  const broken = [
    [],
    [options],
    [options, 'pending'],
    [options, 'latest', {}],
    [{ ...options, validation: true }, 'latest'],
    [{ ...options, extra: 1 }, 'latest'],
    [{ blockStateCalls: options.blockStateCalls }, 'latest'],
    [{ ...options, blockStateCalls: [] }, 'latest'],
    [{ ...options, blockStateCalls: [...options.blockStateCalls, ...options.blockStateCalls] }, 'latest'],
    [{ ...options, blockStateCalls: [{ calls: [] }] }, 'latest'],
    [{ ...options, blockStateCalls: [{ calls: [call], stateOverrides: {} }] }, 'latest'],
    [{ ...options, blockStateCalls: [{ calls: [{ ...call, gas: '0x1' }] }] }, 'latest'],
    [{ ...options, blockStateCalls: [{ calls: [{ to: call.to, data: call.data, value: call.value }] }] }, 'latest'],
    [{ ...options, blockStateCalls: [{ calls: [call, { ...call, from: SETUP }] }] }, 'latest'],
    [{ ...options, blockStateCalls: [{ calls: [{ ...call, to: '0x1234' }] }] }, 'latest'],
    [{ ...options, blockStateCalls: [{ calls: [{ ...call, data: '0xabc' }] }] }, 'latest'],
    [{ ...options, blockStateCalls: [{ calls: [{ ...call, data: 'abcd' }] }] }, 'latest'],
    [{ ...options, blockStateCalls: [{ calls: [{ ...call, value: '0x01' }] }] }, 'latest'],
    [{ ...options, blockStateCalls: [{ calls: [{ ...call, value: 1 }] }] }, 'latest'],
    'not a list',
  ];
  for (const [i, params] of broken.entries()) {
    const { result, sent } = await withFetch(() => assert.fail('asked the network'), () => reads.simulateOnChain(params));
    assert.equal(sent.length, 0, `case ${i}`);
    assert.equal(result.error?.code, -32602, `case ${i}: ${JSON.stringify(params).slice(0, 80)}`);
  }
});

test('each answer of the route is what finance/batch.ts expects: a result; "not available" while it is off or the node lacks the method; a failed read otherwise', async () => {
  const outcomes = [
    [json({ v: 1, result: RESULT }), { value: RESULT }],
    [json({ v: 1, error: 'not_enabled' }, 404), { code: -32601 }],
    [json({ v: 1, error: 'simulate_unsupported' }, 501), { code: -32601 }],
    [json({ v: 1, error: 'simulation_failed' }, 422), { code: -32603 }],
    [json({ v: 1, error: 'rate_limited' }, 429), { code: -32603 }],
    [json({ v: 1, error: 'bad_request' }, 400), { code: -32603 }],
    [json({ v: 1, error: 'source_unavailable' }, 503), { code: -32603 }],
    [json({ v: 1, error: 'rpc_unavailable' }, 502), { code: -32603 }],
    [json({ result: RESULT }), { code: -32603 }],
    [new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } }), { code: -32603 }],
    [null, { code: -32603 }],
  ];
  for (const [i, [response, expected]] of outcomes.entries()) {
    const { result } = await withFetch(async () => (response ? response.clone() : Promise.reject(new TypeError('Failed to fetch'))), () => reads.simulateOnChain(paramsOf()));
    if ('value' in expected) assert.deepEqual(result.value, expected.value, `case ${i}`);
    else assert.equal(result.error?.code, expected.code, `case ${i}: ${result.error?.message}`);
  }
  // finance/batch.ts agrees: a wallet without the method, and the route off, is step by step (batch_simulation_unavailable);
  // the route on, the gas its calls used; a call that would fail there, step by step too (finding 17).
  const lacking = async (method) => {
    assert.equal(method, 'eth_simulateV1');
    throw Object.assign(new Error('the method eth_simulateV1 does not exist/is not available'), { code: -32601 });
  };
  const off = await withFetch(async () => json({ v: 1, error: 'not_enabled' }, 404), () => batch.simulateBatch(lacking, OWNER, CALLS, reads.simulateOnChain));
  assert.equal(off.result.error?.message, 'batch_simulation_unavailable');
  const on = await withFetch(async () => json({ v: 1, result: RESULT }), () => batch.simulateBatch(lacking, OWNER, CALLS, reads.simulateOnChain));
  assert.equal(on.result.value, 0xb411n + 0x3a98n);
  const reverted = await withFetch(async () => json({ v: 1, result: [{ calls: [{ status: '0x1', gasUsed: '0x1' }, { status: '0x0', gasUsed: '0x1' }] }] }), () => batch.simulateBatch(lacking, OWNER, CALLS, reads.simulateOnChain));
  // Changed on purpose 2026-10-02 (review of rugged97's rules, finding 17): the site's node may be behind the wallet's
  // reads, so a call that fails there is step by step, each step checked by the wallet.
  assert.equal(reverted.result.error?.message, 'batch_simulation_unavailable');
  // A WalletConnect wallet's own eth_simulateV1 goes to the same route, and says "not available" while it is off.
  const walletConnect = (method, params) => reads.readOnChain(method, params);
  const viaWallet = await withFetch(async () => json({ v: 1, error: 'not_enabled' }, 404), () => batch.simulateBatch(walletConnect, OWNER, CALLS, reads.simulateOnChain));
  assert.equal(viaWallet.result.error?.message, 'batch_simulation_unavailable');
});

test('through the routes over a fake node: off (the default) is not available; on, the node’s simulation trimmed by the route', async () => {
  const chain = fakeChain();
  const off = await reads.simulateOnChain(paramsOf(), { fetch: edgeFetch(chain.deps) }).then(() => null, (error) => error);
  assert.equal(off?.code, -32601);
  let asked = null;
  const simulator = () => (params) => ((asked = params), [{ calls: [{ status: '0x1', gasUsed: '0xb411', logs: [] }, { status: '0x1', gasUsed: '0x3a98', returnData: '0x' }] }]);
  assert.deepEqual(await reads.simulateOnChain(paramsOf(), { fetch: edgeFetch(chain.deps, { simulator }) }), RESULT);
  // Changed on purpose 2026-10-02 (review of rugged97's rules, finding 15): with each call's share of the gas, bounded.
  const bounded = paramsOf();
  for (const call of bounded[0].blockStateCalls[0].calls) call.gas = '0xe4e1c0';
  assert.deepEqual(asked, bounded, 'the node is asked exactly the simulation the page would have asked, each call’s gas bounded');
  const unsupported = () => () => { throw Object.assign(new Error('the method eth_simulateV1 does not exist'), { code: -32601 }); };
  assert.equal((await reads.simulateOnChain(paramsOf(), { fetch: edgeFetch(chain.deps, { simulator: unsupported }) }).catch((error) => error)).code, -32601);
  const away = await reads.simulateOnChain(paramsOf(), { fetch: edgeFetch(chain.deps, { simulator, source: () => 'off' }) }).catch((error) => error);
  assert.equal(away.code, -32603);
});

test('the module names no read method but the simulation, no host and no network client of its own', () => {
  const src = readFileSync(new URL('../src/lib/walletReads.ts', import.meta.url), 'utf8');
  // tests/session.source-guard.test.mjs's list of wallet transaction methods, and eth_call and eth_estimateGas among them.
  assert.doesNotMatch(src, /['"`](eth_sendTransaction|eth_signTransaction|eth_sendRawTransaction|eth_sign|eth_signTypedData(_v\d)?|wallet_sendCalls|wallet_addEthereumChain|wallet_watchAsset|eth_call|eth_estimateGas)['"`]/);
  assert.deepEqual([...src.matchAll(/['"`](eth_[A-Za-z0-9]+)['"`]/g)].map((match) => match[1]), ['eth_simulateV1'], 'compared only against the simulation');
  assert.doesNotMatch(src, /\bfetch\(|https?:\/\/|\b(?:XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB)\b/);
  assert.match(src, /import \{ postSimulate, type RouteOptions, type SimulateAnswer, type SimulateCall \} from '\.\/edge\/chainRoutes'/, 'its one way out: the routes\' client');
  // The barrel: the wallet feature's two functions come from here. Changed on purpose 2026-10-01 (RPC-SPEC §7.2, the
  // integration's cleanup): lib/chain/browser.ts is gone, and the barrel re-exports these two alone.
  const barrel = readFileSync(new URL('../src/lib/chain/chainCode.ts', import.meta.url), 'utf8');
  const code = barrel.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((line) => line.trim());
  assert.deepEqual(code, ["export { readOnChain, simulateOnChain } from '../walletReads'"]);
});

// 2026-10-02 (review of the RPC switch, finding 2): no text of the site says it simulates or reads through a public RPC,
// a line of its own to the chain or archive nodes, which a later change could be argued from.
test('the docs and the code say the wallet’s reads are refused and the simulation goes to the fixed route, never a public RPC or the page’s own line', () => {
  const doc = readFileSync(new URL('../../docs/OWNER_SETUP_AND_RECOVERY.md', import.meta.url), 'utf8');
  assert.doesNotMatch(doc, /public RPC,\s+the page's own chain client/);
  assert.match(doc, /\/api\/chain\/v1\/simulate/);
  assert.match(doc, /LOCAL_RPC_SIMULATE/);
  assert.match(doc, /batch_simulation_unavailable/);
  for (const file of ['wallet/walletConnect.ts', 'wallet/walletConnectMethods.ts', 'wallet/walletConnectFake.ts', 'finance/wallet.ts']) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /goes through the page's own line|through the page's line to the chain|every read to the page's own line|^\/\*\* The page's own line to the chain/m, file);
  }
  const detail = readFileSync(new URL('../src/screens/PositionDetail.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(detail, /archive nodes/, 'no source the site does not read is named on a page');
});
