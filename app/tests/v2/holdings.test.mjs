/**
 * What the wallet holds on other networks (src/finance/v2/holdings.ts, spec F7 §3.3; the owner's decision #9): read only
 * through the wallet's own provider once the wallet is on that chain; ETH, WETH and USDC on the four candidate networks,
 * never the home chain; a switch the person declines stops the scan; the wallet is taken home at the end; a balance that
 * cannot be read is absent, never zero. No test data stands in for a reading: the fake here is the wallet, not an answer.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { CANDIDATE_ORIGINS, createHoldingsCache, readHoldingsOn, readHoldingsReport, scanHoldings } = require('../../.test-build/app/src/finance/v2/holdings.js');
const { V2_CHAINS } = require('../../.test-build/app/src/v2/chains.js');

const OWNER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const ZERO = '0x0000000000000000000000000000000000000000';
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const BASE_WETH = '0x4200000000000000000000000000000000000006';
const ETH_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const word = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`;
const hex = (value) => `0x${BigInt(value).toString(16)}`;
const candidate = (chainId) => CANDIDATE_ORIGINS.find((c) => c.chainId === chainId);
const HOME = 4663;

/**
 * A wallet that is also its chains. `balances[chainId]` maps a token (lowercase; ZERO for ETH) to its raw balance, or to
 * a scripted answer: `{ answer }` is returned as the provider's reply, `{ throws }` is thrown. `known` are the chains the
 * wallet can switch to; a switch to one in `decline` is refused by the person, in `pending` left waiting; a chain in
 * `broken` answers no chain id.
 */
function fakeWallet({ chainId = HOME, balances = {}, known = [1, 8453, 42161, 10, HOME], decline = [], pending = [], broken = [] } = {}) {
  const state = { chainId, asked: [], switches: [] };
  const answer = (entry, asWord) => {
    if (entry && typeof entry === 'object') {
      if (entry.throws) throw Object.assign(new Error('execution reverted'), { code: 3 });
      return entry.answer;
    }
    const raw = entry ?? 0n;
    return asWord ? word(raw) : hex(raw);
  };
  const wallet = {
    owner: OWNER,
    async request(method, params) {
      state.asked.push([state.chainId, method]);
      const table = balances[state.chainId] ?? {};
      switch (method) {
        case 'eth_chainId':
          if (broken.includes(state.chainId)) throw Object.assign(new Error('Internal JSON-RPC error.'), { code: -32603 });
          return hex(state.chainId);
        case 'eth_getBalance':
          assert.deepEqual(params, [OWNER, 'latest']);
          return answer(table[ZERO], false);
        case 'eth_call': {
          const [{ to, data }, tag] = params;
          assert.equal(tag, 'latest');
          assert.equal(data, `0x70a08231${OWNER.slice(2).padStart(64, '0')}`, 'balanceOf(owner), exactly');
          return answer(table[to], true);
        }
        default:
          throw Object.assign(new Error(`${method} is not answered here`), { code: 4200 });
      }
    },
  };
  const switchTo = async (id) => {
    state.switches.push(id);
    if (decline.includes(id)) return 'user_rejected';
    if (pending.includes(id)) return 'pending';
    if (!known.includes(id)) return 'unknown_chain';
    state.chainId = id;
    return 'switched';
  };
  return { wallet, state, switchTo };
}

// Changed on purpose 2026-10-05 (the owner: a position on Base or Arbitrum One funded from the other two networks too):
// Robinhood Chain, with its ETH, WETH and USDG, is a candidate as well (for a deposit that arrives elsewhere).
test('the candidates: Robinhood Chain with ETH, WETH and USDG; Ethereum, Base, Arbitrum One and OP Mainnet with ETH, WETH and USDC; lowercase', () => {
  assert.deepEqual(CANDIDATE_ORIGINS.map((c) => [c.chainId, c.name]), [[4663, 'Robinhood Chain'], [1, 'Ethereum'], [8453, 'Base'], [42161, 'Arbitrum One'], [10, 'OP Mainnet']]);
  for (const c of CANDIDATE_ORIGINS) {
    assert.deepEqual(c.tokens.map((t) => [t.symbol, t.decimals]), [['ETH', 18], ['WETH', 18], [c.chainId === 4663 ? 'USDG' : 'USDC', 6]], c.name);
    for (const t of c.tokens) assert.match(t.address, /^0x[0-9a-f]{40}$/, `${c.name} ${t.symbol}`);
    assert.equal(c.tokens[0].address, ZERO);
  }
  // Robinhood Chain's WETH and USDG, Base's and Arbitrum One's WETH and USDC, are the published chain profiles' own.
  const robinhood = V2_CHAINS.find((chain) => chain.chainId === 4663);
  assert.equal(candidate(4663).tokens[1].address, robinhood.wrappedNative.address.toLowerCase(), 'Robinhood Chain WETH');
  assert.equal(candidate(4663).tokens[2].address, robinhood.chargeCurrencies.find((c) => c.symbol === 'USDG').address.toLowerCase(), 'Robinhood Chain USDG');
  for (const chainId of [8453, 42161]) {
    const profile = V2_CHAINS.find((chain) => chain.chainId === chainId);
    const found = candidate(chainId);
    assert.equal(found.name, profile.name);
    assert.equal(found.tokens[1].address, profile.wrappedNative.address.toLowerCase(), `${profile.name} WETH`);
    assert.equal(found.tokens[2].address, profile.chargeCurrencies.find((c) => c.symbol === 'USDC').address.toLowerCase(), `${profile.name} USDC`);
  }
  assert.equal(candidate(1).tokens[2].address, ETH_USDC);
  assert.equal(candidate(10).tokens[2].address, '0x0b2c639c533813f4aa9d7837caf62653d097ff85');
});

test('readHoldingsOn: the chain confirmed first, then ETH and each token; only what is above zero, in the candidate\'s order', async () => {
  const w = fakeWallet({ chainId: 8453, balances: { 8453: { [ZERO]: 420_000_000_000_000_000n, [BASE_USDC]: 120_000_000n, [BASE_WETH]: 0n } } });
  const found = await readHoldingsOn(w.wallet, candidate(8453));
  assert.deepEqual(found, [
    { chainId: 8453, chainName: 'Base', token: ZERO, symbol: 'ETH', decimals: 18, raw: 420_000_000_000_000_000n },
    { chainId: 8453, chainName: 'Base', token: BASE_USDC, symbol: 'USDC', decimals: 6, raw: 120_000_000n },
  ]);
  assert.deepEqual(w.state.asked.map(([, method]) => method), ['eth_chainId', 'eth_getBalance', 'eth_call', 'eth_call']);
  assert.deepEqual(w.state.switches, [], 'it switches nothing');
});

test('readHoldingsOn on another chain than the candidate\'s: wallet_wrong_chain, and no balance is asked', async () => {
  const w = fakeWallet({ chainId: HOME, balances: { 8453: { [ZERO]: 1n } } });
  await assert.rejects(readHoldingsOn(w.wallet, candidate(8453)), /wallet_wrong_chain/);
  assert.deepEqual(w.state.asked.map(([, method]) => method), ['eth_chainId']);
});

test('a malformed balance word, or a read that throws, leaves the token out: absent, never zero', async () => {
  const w = fakeWallet({
    chainId: 8453,
    balances: {
      8453: {
        [ZERO]: 5n,
        [BASE_WETH]: { answer: `0x${'1'.padStart(40, '0')}` },
        [BASE_USDC]: { throws: true },
      },
    },
  });
  const found = await readHoldingsOn(w.wallet, candidate(8453));
  assert.deepEqual(found.map((h) => [h.symbol, h.raw]), [['ETH', 5n]], 'the twenty-byte answer and the reverted read are not holdings of zero');
  // A native balance answered as something other than a quantity is absent too.
  const odd = fakeWallet({ chainId: 1, balances: { 1: { [ZERO]: { answer: '0x00ff' }, [ETH_USDC]: 7n } } });
  assert.deepEqual((await readHoldingsOn(odd.wallet, candidate(1))).map((h) => [h.symbol, h.raw]), [['USDC', 7n]]);
});

test('scanHoldings over two chains: Base read (ETH and USDC), Arbitrum One unknown to the wallet, the home chain skipped, the wallet taken home', async () => {
  const w = fakeWallet({ known: [8453, HOME], balances: { 8453: { [ZERO]: 420_000_000_000_000_000n, [BASE_USDC]: 120_000_000n } } });
  const progress = [];
  const scan = await scanHoldings({
    wallet: w.wallet,
    switchTo: w.switchTo,
    homeChainId: HOME,
    candidates: [candidate(8453), { chainId: HOME, name: 'Robinhood Chain', tokens: [{ address: ZERO, symbol: 'ETH', decimals: 18 }] }, candidate(42161)],
    onProgress: (state) => progress.push([state.chainId, state.phase]),
  });
  assert.deepEqual(scan.holdings.map((h) => [h.chainName, h.symbol, h.raw]), [['Base', 'ETH', 420_000_000_000_000_000n], ['Base', 'USDC', 120_000_000n]]);
  assert.deepEqual(scan.read, [8453]);
  assert.deepEqual(scan.skipped, [{ chainId: 42161, reason: 'unknown_chain' }]);
  assert.equal(scan.stoppedBy, null);
  assert.equal(scan.returned, true);
  assert.deepEqual(w.state.switches, [8453, 42161, HOME], 'each origin once, never the home chain as an origin, then home');
  assert.equal(w.state.chainId, HOME);
  assert.deepEqual(progress, [[8453, 'switching'], [8453, 'reading'], [42161, 'switching']]);
  assert.deepEqual(w.state.asked.filter(([chain]) => chain !== 8453), [], 'balances are read only on the chain switched to');
});

test('a switch the person declines stops the scan there: nothing more is asked, and the wallet is still taken home', async () => {
  const w = fakeWallet({ decline: [8453], balances: { 1: { [ETH_USDC]: 50_000_000n }, 42161: { [ZERO]: 1n } } });
  const scan = await scanHoldings({ wallet: w.wallet, switchTo: w.switchTo, homeChainId: HOME, candidates: [candidate(1), candidate(8453), candidate(42161)] });
  assert.deepEqual(scan.holdings.map((h) => [h.chainName, h.symbol]), [['Ethereum', 'USDC']]);
  assert.deepEqual(scan.read, [1]);
  assert.deepEqual(scan.skipped, [{ chainId: 8453, reason: 'user_rejected' }]);
  assert.equal(scan.stoppedBy, 'user_rejected');
  assert.deepEqual(w.state.switches, [1, 8453, HOME], 'Arbitrum One is never asked');
  assert.equal(scan.returned, true);
});

test('the way home refused: returned is false; a waiting request or a failed read skips the chain and the scan goes on; nothing throws', async () => {
  const w = fakeWallet({ decline: [HOME], pending: [10], broken: [42161], balances: { 1: { [ZERO]: 3n } } });
  const scan = await scanHoldings({ wallet: w.wallet, switchTo: w.switchTo, homeChainId: HOME, candidates: [candidate(10), candidate(42161), candidate(1)] });
  assert.deepEqual(scan.holdings.map((h) => [h.chainName, h.raw]), [['Ethereum', 3n]]);
  assert.deepEqual(scan.read, [1]);
  assert.deepEqual(scan.skipped, [{ chainId: 10, reason: 'pending' }, { chainId: 42161, reason: 'error' }]);
  assert.equal(scan.stoppedBy, null);
  assert.equal(scan.returned, false, 'the person declined the switch back');
  assert.equal(w.state.chainId, 1, 'the wallet stayed where it was');
  // A switch that throws is a failed switch, never a thrown scan.
  const thrown = await scanHoldings({ wallet: w.wallet, switchTo: async () => { throw new Error('boom'); }, homeChainId: HOME, candidates: [candidate(8453)] });
  assert.deepEqual(thrown, { holdings: [], read: [], skipped: [{ chainId: 8453, reason: 'error' }], stoppedBy: null, returned: false });
});

// Changed on purpose 2026-10-05: five candidates, Robinhood Chain first (an origin for a position on Base or Arbitrum One).
test('by default the scan goes over the candidates, in order, and never the home chain', async () => {
  const w = fakeWallet();
  const scan = await scanHoldings({ wallet: w.wallet, switchTo: w.switchTo, homeChainId: HOME });
  assert.deepEqual(w.state.switches, [1, 8453, 42161, 10, HOME]);
  assert.deepEqual(scan, { holdings: [], read: [1, 8453, 42161, 10], skipped: [], stoppedBy: null, returned: true });
  const fromBase = fakeWallet({ chainId: 8453 });
  await scanHoldings({ wallet: fromBase.wallet, switchTo: fromBase.switchTo, homeChainId: 8453 });
  assert.deepEqual(fromBase.state.switches, [4663, 1, 42161, 10, 8453], 'a position on Base: Robinhood Chain an origin, Base home, not one');
});

// Round 5: zero, unavailable and partial are different states, including during an account/network change.
test('read report keeps positive balances and names unavailable tokens; a failed read is never an empty wallet', async () => {
  const w = fakeWallet({ chainId: 8453, balances: { 8453: { [ZERO]: 0n, [BASE_WETH]: { throws: true }, [BASE_USDC]: { answer: '0x02' } } } });
  const result = await readHoldingsReport(w.wallet, candidate(8453));
  assert.deepEqual(result, { holdings: [], unread: ['WETH', 'USDC'] });
  const scan = await scanHoldings({ wallet: w.wallet, switchTo: w.switchTo, homeChainId: HOME, candidates: [candidate(8453)] });
  assert.deepEqual(scan.read, [], 'a chain with missing balances is not declared fully read');
  assert.deepEqual(scan.skipped, [{ chainId: 8453, reason: 'error' }]);
});

test('a disconnected account is refused before a request and an account changed in flight invalidates all answers', async () => {
  const w = fakeWallet({ chainId: 8453, balances: { 8453: { [ZERO]: 1n } } });
  let current = false;
  w.wallet.current = () => current;
  await assert.rejects(readHoldingsReport(w.wallet, candidate(8453)), /wallet_identity_changed/);
  assert.deepEqual(w.state.asked, []);
  current = true;
  const original = w.wallet.request;
  w.wallet.request = async (method, params) => { const answer = await original(method, params); if (method === 'eth_getBalance') current = false; return answer; };
  await assert.rejects(readHoldingsReport(w.wallet, candidate(8453)), /wallet_identity_changed/);
  assert.deepEqual(w.state.asked.map(([, method]) => method), ['eth_chainId', 'eth_getBalance']);
});

test('a network changed while balances load cannot mix another chain into the result', async () => {
  const w = fakeWallet({ chainId: 8453 });
  w.wallet.chainId = () => w.state.chainId;
  const original = w.wallet.request;
  w.wallet.request = async (method, params) => { const answer = await original(method, params); if (method === 'eth_getBalance') w.state.chainId = 1; return answer; };
  await assert.rejects(readHoldingsReport(w.wallet, candidate(8453)), /wallet_wrong_chain/);
  assert.equal(w.state.asked.length, 2);
});

test('an account changed during a manual scan cancels remaining wallet switches, including the return prompt', async () => {
  const w = fakeWallet();
  let current = true;
  w.wallet.current = () => current;
  const scan = await scanHoldings({ wallet: w.wallet, homeChainId: HOME, switchTo: async (id) => { const result = await w.switchTo(id); current = false; return result; } });
  assert.deepEqual(scan, { holdings: [], read: [], skipped: [], stoppedBy: 'wallet_changed', returned: false });
  assert.deepEqual(w.state.switches, [1]);
});

test('silent read cache shares in-flight work, separates wallets and chains, bounds success and failure retention', async () => {
  let now = 0;
  const read = createHoldingsCache(() => now);
  let calls = 0;
  let done;
  const pending = () => { calls++; return new Promise((resolve) => { done = resolve; }); };
  const first = read('wallet-a|8453', pending);
  const second = read('wallet-a|8453', pending);
  assert.equal(first, second);
  await Promise.resolve();
  done({ holdings: [], unread: [] });
  await first;
  const success = () => { calls++; return Promise.resolve({ holdings: [], unread: [] }); };
  await read('wallet-a|8453', success);
  assert.equal(calls, 1);
  await read('wallet-b|8453', success);
  await read('wallet-a|1', success);
  assert.equal(calls, 3);
  now = 30_001;
  await read('wallet-a|8453', success);
  assert.equal(calls, 4);
  const failed = () => { calls++; return Promise.reject(new Error('offline')); };
  await assert.rejects(read('broken|1', failed), /offline/);
  await assert.rejects(read('broken|1', failed), /offline/);
  assert.equal(calls, 5);
  now += 10_001;
  await read('broken|1', success);
  assert.equal(calls, 6);
});
