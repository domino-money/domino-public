/**
 * The V2 money clients' one way to a wallet (src/finance/v2/transact.ts): chain-bound reads, the nonce held across
 * the page and offered once, the chain read again right before the send, a refusal releasing exactly its claim, the
 * same address on two chains never colliding, and receipts only for what this page sent, with "included" and
 * "finalized" apart and Base's L1 fee.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { numberToHex } from 'viem';

const require = createRequire(import.meta.url);
const { createTransactor, suggestV2Gas, V2Revert } = require('../../.test-build/app/src/finance/v2/transact.js');
const chains = require('../../.test-build/app/src/v2/chains.js');

const OWNER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const TARGET = '0x00000000000000000000000000000000d0d00004';
const GAS = { maxGas: 1_000_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 0n, reserveWei: 0n };
const step = { kind: 'action', to: TARGET, data: '0x0e97b041', value: 0n, summary: ['Create a position.'] };

/** A wallet on `chainId` that is also its chain: scripted, recording every ask. */
function fakeWallet({ chainId = 4663, nonce = 7, journal = new Map(), finalized = true } = {}) {
  const state = { chainId, nonce, pending: nonce, sent: [], asked: [], revertNext: null, chainAfterClaim: null, refuseNext: false, current: true, l1Fee: '0x2a', l1Ceiling: 7_000_000_000n, l1Asked: [] };
  const hashOf = (i) => `0x${(0xc0 + i).toString(16).padStart(64, '0')}`;
  const claims = [];
  const wallet = {
    owner: OWNER,
    current: () => state.current,
    chainId: () => state.chainId,
    async request(method, params) {
      state.asked.push(method);
      switch (method) {
        case 'eth_accounts': return [OWNER];
        case 'eth_chainId': {
          // A wallet the person moves to another network while the nonce is being claimed.
          if (state.chainAfterClaim !== null && claims.length > 0) state.chainId = state.chainAfterClaim;
          return numberToHex(state.chainId);
        }
        case 'eth_getTransactionCount': return numberToHex(params[1] === 'pending' ? state.pending : state.nonce);
        case 'eth_call': {
          // Base's GasPriceOracle predeploy (post-B4 review F5): getL1FeeUpperBound(size) answers a fixed ceiling.
          if (String(params[0].to).toLowerCase() === '0x420000000000000000000000000000000000000f' && String(params[0].data).startsWith('0xf1c7a58b')) {
            state.l1Asked.push(BigInt(`0x${params[0].data.slice(10)}`));
            return `0x${state.l1Ceiling.toString(16).padStart(64, '0')}`;
          }
          if (state.revertNext) { const data = state.revertNext; state.revertNext = null; throw Object.assign(new Error('execution reverted'), { code: 3, data }); }
          return '0x';
        }
        case 'eth_estimateGas': return '0x30d40';
        case 'eth_getBalance': return numberToHex(10n ** 18n);
        case 'eth_gasPrice': return numberToHex(100_000_000n);
        case 'eth_maxPriorityFeePerGas': return numberToHex(5_000_000n);
        case 'eth_sendTransaction': {
          if (state.refuseNext) { state.refuseNext = false; throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); }
          state.sent.push(params[0]);
          state.nonce += 1; state.pending += 1;
          return hashOf(state.sent.length - 1);
        }
        case 'eth_getTransactionByHash': {
          const i = state.sent.findIndex((_, k) => hashOf(k) === params[0]);
          if (i < 0) return null;
          const tx = state.sent[i];
          return { hash: hashOf(i), from: tx.from, to: tx.to, input: tx.data, value: tx.value, nonce: tx.nonce };
        }
        case 'eth_getTransactionReceipt': {
          const i = state.sent.findIndex((_, k) => hashOf(k) === params[0]);
          if (i < 0) return null;
          return { transactionHash: hashOf(i), from: OWNER, status: '0x1', blockNumber: numberToHex(100 + i), blockHash: `0x${'b'.repeat(63)}${i}`, gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', l1Fee: state.l1Fee,
            logs: [{ address: TARGET.toUpperCase().replace('0X', '0x'), topics: [`0x${'a'.repeat(64)}`], data: '0x', logIndex: '0x0' }] };
        }
        case 'eth_getBlockByNumber': {
          if (params[0] === 'finalized') return { number: finalized ? '0xffff' : '0x1' };
          if (params[0] === 'latest') return { number: '0x64', timestamp: '0x6a8f2f10' };
          const n = Number(BigInt(params[0])) - 100;
          return { hash: `0x${'b'.repeat(63)}${n}` };
        }
        case 'eth_getCode': return '0x';
      }
      throw new Error(`unexpected ${method}`);
    },
    nonceOffered: (chain, n) => journal.has(`${chain}|${OWNER}|${n}`),
    async claimNonce(chain, n) {
      const key = `${chain}|${OWNER}|${n}`;
      if (journal.has(key)) throw new Error('wallet_nonce_already_offered');
      const token = `claim-${chain}-${n}`;
      journal.set(key, token); claims.push(['claim', chain, n]);
      return token;
    },
    async releaseRejectedNonce(chain, n, token) {
      const key = `${chain}|${OWNER}|${n}`;
      if (journal.get(key) === token) journal.delete(key);
      claims.push(['release', chain, n]);
    },
    signatures: { held: () => false, record: async () => {}, forget: async () => {}, list: () => [] },
  };
  return { wallet, state, claims, journal };
}
const prepared = async (t) => t.bounded(async (rpc) => { await t.identity(rpc); return t.prepare(rpc, step, GAS); });

test('a step is simulated, estimated with a fifth more, frozen with the free nonce and this chain\'s id', async () => {
  const { wallet, state } = fakeWallet();
  const t = createTransactor(wallet, chains.v2Chain(4663), () => 1_000);
  const p = await prepared(t);
  assert.equal(p.chainId, 4663);
  assert.equal(p.transaction.chainId, '0x1237');
  assert.equal(p.transaction.nonce, '0x7');
  assert.equal(p.transaction.gas, numberToHex((200_000n * 120n + 99n) / 100n));
  assert.equal(p.networkFeeWei, 240_000n * 1_000_000_000n);
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.transaction));
  assert.deepEqual(state.asked.slice(0, 2), ['eth_accounts', 'eth_chainId']);
  assert.ok(state.asked.includes('eth_call') && state.asked.includes('eth_estimateGas'));
});

test('a wallet on another chain is refused before anything is read or prepared', async () => {
  const { wallet, state } = fakeWallet({ chainId: 8453 });
  const t = createTransactor(wallet, chains.v2Chain(4663), () => 1_000);
  await assert.rejects(prepared(t), /wallet_wrong_chain/);
  assert.deepEqual(state.asked, [], 'the connector says Base: not even the account is asked');
  // A connector that still says Robinhood while the wallet answers Base is caught by the wallet's own eth_chainId.
  const lying = fakeWallet({ chainId: 8453 });
  const tl = createTransactor({ ...lying.wallet, chainId: () => 4663 }, chains.v2Chain(4663), () => 1_000);
  await assert.rejects(prepared(tl), /wallet_wrong_chain/);
  assert.deepEqual(lying.state.asked, ['eth_accounts', 'eth_chainId']);
});

test('a wallet that moves to another chain in the middle of an operation stops it at the next call', async () => {
  const { wallet, state } = fakeWallet();
  const t = createTransactor(wallet, chains.v2Chain(4663), () => 1_000);
  await assert.rejects(t.bounded(async (rpc) => {
    await t.identity(rpc);
    state.chainId = 42161;
    return t.prepare(rpc, step, GAS);
  }), /wallet_wrong_chain/);
  assert.equal(state.asked.includes('eth_call'), false, 'nothing of the review was read from the other chain');
});

test('send: re-read, re-simulated, the nonce claimed, the chain read last, then offered once and never again', async () => {
  const { wallet, state, claims } = fakeWallet();
  const t = createTransactor(wallet, chains.v2Chain(4663), () => 1_000);
  const p = await prepared(t);
  await assert.rejects(t.send(p, false), /wallet_review_required/, 'not acknowledged');
  state.asked.length = 0;
  const hash = await t.send(p, true);
  assert.match(hash, /^0x[0-9a-f]{64}$/);
  // The last read before the wallet is asked is the chain.
  const last = state.asked.lastIndexOf('eth_sendTransaction');
  assert.equal(state.asked[last - 1], 'eth_chainId');
  assert.deepEqual(claims, [['claim', 4663, 7n]]);
  assert.equal(state.sent.length, 1);
  assert.equal(state.sent[0].chainId, '0x1237');
  assert.equal(t.wasOffered(p), true);
  await assert.rejects(t.send(p, true), /wallet_review_required/, 'the same review is never sent twice');
  assert.equal(state.sent.length, 1);
});

test('a wallet that moved to another chain after the review is caught right before the send, and its claim released', async () => {
  const { wallet, state, claims } = fakeWallet();
  const t = createTransactor(wallet, chains.v2Chain(4663), () => 1_000);
  const p = await prepared(t);
  state.chainAfterClaim = 8453;
  // The first chain read (identity) still says 4663; the one right before the send says 8453.
  await assert.rejects(t.send(p, true), /wallet_wrong_chain/);
  assert.equal(state.sent.length, 0);
  assert.deepEqual(claims, [['claim', 4663, 7n], ['release', 4663, 7n]]);
});

test('a refusal in the wallet (4001) releases exactly its claim; the next send needs a new review', async () => {
  const { wallet, state, claims, journal } = fakeWallet();
  const t = createTransactor(wallet, chains.v2Chain(4663), () => 1_000);
  const p = await prepared(t);
  state.refuseNext = true;
  await assert.rejects(t.send(p, true), (error) => error.code === 4001);
  assert.deepEqual(claims, [['claim', 4663, 7n], ['release', 4663, 7n]]);
  assert.equal(journal.size, 0);
  await assert.rejects(t.send(p, true), /wallet_review_required/);
  const again = await prepared(t);
  assert.match(await t.send(again, true), /^0x/);
});

test('an unknown outcome keeps the nonce held: nothing more is prepared on that chain until the chain says', async () => {
  const journal = new Map([[`4663|${OWNER}|7`, 'held-elsewhere']]);
  const { wallet } = fakeWallet({ journal });
  const t = createTransactor(wallet, chains.v2Chain(4663), () => 1_000);
  await assert.rejects(prepared(t), /pending_wallet_transaction/);
});

test('a latch the chain shows nothing pending for is let go only by V1\'s settle rule (its page gone, or older than 600 s)', async () => {
  const journal = new Map([[`8453|${OWNER}|7`, 'held-elsewhere']]);
  const base = fakeWallet({ chainId: 8453, journal });
  const asked = [];
  let free = false;
  const wallet = { ...base.wallet, async settleNonce(chain, n, now, maxAge) {
    asked.push([chain, n, now, maxAge]);
    if (free) journal.delete(`${chain}|${OWNER}|${n}`);
    return free;
  } };
  const t = createTransactor(wallet, chains.v2Chain(8453), () => 1_000);
  await assert.rejects(prepared(t), /pending_wallet_transaction/, 'still live and young: the request may be open in the wallet');
  free = true;
  const p = await prepared(t);
  assert.deepEqual(asked, [[8453, 7n, 1_000, 600], [8453, 7n, 1_000, 600]]);
  assert.equal(p.transaction.chainId, '0x2105');
  // A transaction in flight is never settled away: the chain's own pending count refuses first.
  base.state.pending = 8;
  asked.length = 0;
  await assert.rejects(prepared(createTransactor(wallet, chains.v2Chain(8453), () => 1_000)), /pending_wallet_transaction/);
  assert.deepEqual(asked, []);
});

test('the same address on two chains never collides: Base\'s nonce 7 is not Robinhood\'s', async () => {
  const journal = new Map([[`4663|${OWNER}|7`, 'held-on-robinhood']]);
  const base = fakeWallet({ chainId: 8453, journal });
  const t = createTransactor(base.wallet, chains.v2Chain(8453), () => 1_000);
  const p = await prepared(t);
  assert.equal(p.transaction.chainId, '0x2105');
  await t.send(p, true);
  assert.deepEqual(base.claims, [['claim', 8453, 7n]]);
  assert.ok(journal.has(`4663|${OWNER}|7`) && journal.has(`8453|${OWNER}|7`));
});

test('a transaction in flight (pending ≠ latest) is waited for, never stacked', async () => {
  const { wallet, state } = fakeWallet();
  state.pending = 8;
  const t = createTransactor(wallet, chains.v2Chain(4663), () => 1_000);
  await assert.rejects(prepared(t), /pending_wallet_transaction/);
});

test('a simulation the contract refuses is a V2Revert carrying its revert data, for the error decoder', async () => {
  const { wallet, state } = fakeWallet();
  state.revertNext = '0x21f24259';
  const t = createTransactor(wallet, chains.v2Chain(4663), () => 1_000);
  await assert.rejects(prepared(t), (error) => error instanceof V2Revert && error.data === '0x21f24259');
});

test('an expired review is not sent', async () => {
  let clock = 1_000;
  const { wallet, state } = fakeWallet();
  const t = createTransactor(wallet, chains.v2Chain(4663), () => clock);
  const p = await prepared(t);
  clock += 26;
  await assert.rejects(t.send(p, true), /wallet_review_required/);
  assert.equal(state.sent.length, 0);
});

test('receipts: only for hashes this page sent; included, then finalized; logs lowercased; Base adds its L1 fee', async () => {
  const robinhood = fakeWallet({ finalized: false });
  const t = createTransactor(robinhood.wallet, chains.v2Chain(4663), () => 1_000);
  await assert.rejects(t.receipt(`0x${'c'.repeat(64)}`), /receipt_not_from_this_review/);
  const hash = await t.send(await prepared(t), true);
  const included = await t.receipt(hash);
  assert.equal(included.state, 'included');
  assert.equal(included.l1Fee, null, 'Nitro: gasUsed already includes the L1 part');
  assert.equal(included.logs[0].address, '0x00000000000000000000000000000000d0d00004');
  assert.equal(included.gasUsed, 21_000n);

  const base = fakeWallet({ chainId: 8453 });
  const tb = createTransactor(base.wallet, chains.v2Chain(8453), () => 1_000);
  const baseHash = await tb.send(await prepared(tb), true);
  const final = await tb.receipt(baseHash);
  assert.equal(final.state, 'finalized');
  assert.equal(final.l1Fee, 42n);
});

test('gas: no priority fee where the chain orders by arrival; the wallet\'s suggestion on Base', async () => {
  const rh = fakeWallet();
  const rpc = (method, params) => rh.wallet.request(method, params);
  assert.deepEqual(await suggestV2Gas(rpc, chains.v2Chain(4663)), { maxGas: 8_000_000n, maxFeePerGas: 200_000_000n, maxPriorityFeePerGas: 0n, reserveWei: 0n });
  assert.equal((await suggestV2Gas(rpc, chains.v2Chain(42161))).maxPriorityFeePerGas, 0n);
  assert.equal((await suggestV2Gas(rpc, chains.v2Chain(8453))).maxPriorityFeePerGas, 5_000_000n);
});

// ---------------------------------------------------------------------------
// Post-B4 review: the budget read at the review (F8), Base's L1 data fee ceiling (F5), a request the wallet never saw (F9)
// ---------------------------------------------------------------------------

test('Base: the step\'s cost adds the GasPriceOracle\'s L1 fee ceiling at its size; Nitro asks no oracle', async () => {
  const base = fakeWallet({ chainId: 8453 });
  const pb = await createTransactor(base.wallet, chains.v2Chain(8453), () => 1_000).bounded(async (rpc) => {
    const t = createTransactor(base.wallet, chains.v2Chain(8453), () => 1_000);
    return t.prepare(rpc, step, GAS);
  });
  assert.equal(pb.networkFeeWei, 240_000n * 1_000_000_000n + 7_000_000_000n);
  assert.deepEqual(base.state.l1Asked, [4n + 160n], 'the calldata\'s 4 bytes and the unsigned envelope');
  const robinhood = fakeWallet();
  const t = createTransactor(robinhood.wallet, chains.v2Chain(4663), () => 1_000);
  assert.equal((await prepared(t)).networkFeeWei, 240_000n * 1_000_000_000n);
  assert.deepEqual(robinhood.state.l1Asked, []);
  // A reply that is not a word is refused, never guessed.
  base.state.l1Ceiling = -1n;
  const broken = { ...base.wallet, request: async (method, params) => (method === 'eth_call' && String(params[0].to).toLowerCase() === '0x420000000000000000000000000000000000000f' ? '0x' : base.wallet.request(method, params)) };
  const tb = createTransactor(broken, chains.v2Chain(8453), () => 1_000);
  await assert.rejects(tb.bounded(async (rpc) => { await tb.identity(rpc); return tb.prepare(rpc, step, GAS); }), /l1_fee_unavailable/);
});

test('no budget handed in: it is read at the review, through the bounded port, from the chain\'s own price', async () => {
  const { wallet, state } = fakeWallet({ chainId: 8453 });
  const t = createTransactor(wallet, chains.v2Chain(8453), () => 1_000);
  const p = await t.bounded(async (rpc) => { await t.identity(rpc); return t.prepare(rpc, step, null); });
  assert.equal(p.transaction.maxFeePerGas, numberToHex(200_000_000n), 'twice the gas price');
  assert.equal(p.transaction.maxPriorityFeePerGas, numberToHex(5_000_000n), 'Base: the wallet\'s own tip');
  assert.ok(state.asked.indexOf('eth_gasPrice') > state.asked.indexOf('eth_chainId'), 'after the chain was checked');
});

test('a send the port refuses before the wallet is asked lets its nonce go: nothing reached the wallet', async () => {
  const { wallet, state, claims, journal } = fakeWallet();
  let afterClaim = 0;
  // The account goes away right before eth_sendTransaction would be asked (the fourth look after the claim: the chain's
  // last read before and after, the check after it, then the port's own look before the send).
  const leaving = { ...wallet, current: () => !(claims.length > 0 && ++afterClaim >= 4) };
  const t = createTransactor(leaving, chains.v2Chain(4663), () => 1_000);
  const p = await prepared(t);
  await assert.rejects(t.send(p, true), /wallet_action_expired/);
  assert.equal(state.asked.includes('eth_sendTransaction'), false);
  assert.deepEqual(claims, [['claim', 4663, 7n], ['release', 4663, 7n]]);
  assert.equal(journal.size, 0);
  assert.equal(t.wasOffered(p), false);
});
