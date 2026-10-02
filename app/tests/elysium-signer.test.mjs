/**
 * The second chain's closed wallet signer (src/chains/elysium/signer.ts, 2026-10-01, the chain2 workstream, part B),
 * against a fake EIP-1193 wallet that records every request: it sends exactly the transaction of a draft rugged97's
 * actions service prepared, once, and only after the wallet's own provider says the chain is the registry's, the account
 * is the draft's owner, the draft has not expired, the account's pending nonce is the draft's, the target is pinned and
 * every pinned contract's code hashes to its pin; then the chain, the account and the expiry once more. A draft that
 * could not be what was asked is refused before the wallet is asked anything.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { elysiumSignerFor, addChain } = require('../.test-build/app/src/chains/elysium/signer.js');
const { SignerError, EXPIRY_MARGIN_S } = require('../.test-build/app/src/chains/elysium/flow.js');
const { ELYSIUM, ROBINHOOD, addChainParameters } = require('../.test-build/app/src/config/chains.js');
const { keccak256 } = require('../.test-build/app/functions/_lib/uniswap-v3/words.js');

const WIRE = JSON.parse(readFileSync(new URL('./fixtures/elysium/uniswap-v3-actions-v1.wire.json', import.meta.url), 'utf8'));
const NOW_MS = 1_790_685_000_000;
const OWNER = WIRE.responses.prepare.draft.owner;
const TARGET = WIRE.responses.prepare.draft.transaction.to;
const OTHER_PIN = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
const CODE = { [TARGET]: '0x6080604052348015600f57600080fd5b50', [OTHER_PIN]: '0x60806040' };
const HASH = `0x${'ab'.repeat(32)}`;

/** The fixture's draft, its pins the codes above, valid until ten minutes after NOW_MS. */
function draft(extra = {}, transaction = {}) {
  const base = structuredClone(WIRE.responses.prepare.draft);
  return {
    ...base,
    expiresAt: Math.floor(NOW_MS / 1000) + 600,
    contractPins: [{ address: TARGET, codeHash: keccak256(CODE[TARGET]) }, { address: OTHER_PIN, codeHash: keccak256(CODE[OTHER_PIN]) }],
    ...extra,
    transaction: { ...base.transaction, ...transaction },
  };
}

/**
 * A wallet on Elysium with the draft's owner and nonce. `answers[method]` replaces an answer: a value, an Error to throw,
 * or a function of (params, nth call of that method).
 */
function wallet(answers = {}, d = draft()) {
  const asked = [];
  const counts = {};
  const defaults = {
    eth_chainId: '0x185d9',
    eth_accounts: [OWNER.replace(/^0x/, '0x').toUpperCase().replace(/^0X/, '0x')],
    eth_getTransactionCount: `0x${d.transaction.nonce.toString(16)}`,
    eth_getCode: (params) => CODE[params[0]] ?? '0x',
    eth_sendTransaction: HASH.toUpperCase().replace(/^0X/, '0x'),
    wallet_addEthereumChain: null,
  };
  const provider = {
    async request({ method, params = [] }) {
      asked.push({ method, params });
      counts[method] = (counts[method] ?? 0) + 1;
      const answer = Object.hasOwn(answers, method) ? answers[method] : defaults[method];
      const value = typeof answer === 'function' ? answer(params, counts[method]) : answer;
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error(`unexpected ${method}`);
      return value;
    },
  };
  return { asked, wallet: { info: { uuid: '00000000-0000-4000-8000-000000000001', name: 'Test Wallet', rdns: 'io.test.wallet' }, provider } };
}
const signer = (w) => elysiumSignerFor(w.wallet, ELYSIUM, () => NOW_MS);
const methods = (asked) => asked.map(({ method }) => method);
const refusal = (kind, message) => (error) => error instanceof SignerError && error.kind === kind && (message === undefined || error.message === message);
const walletError = (code, wrapped = false) => Object.assign(new Error('wallet said no'), wrapped ? { data: { originalError: { code } } } : { code });

test('the draft\'s transaction is sent once, field for field, after every check, and its hash comes back lowercase', async () => {
  const d = draft();
  const w = wallet({}, d);
  assert.equal(await signer(w).send(d), HASH);
  assert.deepEqual(methods(w.asked), ['eth_chainId', 'eth_accounts', 'eth_getTransactionCount', 'eth_getCode', 'eth_getCode', 'eth_chainId', 'eth_accounts', 'eth_sendTransaction']);
  assert.deepEqual(w.asked[2].params, [OWNER, 'pending'], 'the owner\'s pending nonce');
  assert.deepEqual(w.asked.filter(({ method }) => method === 'eth_getCode').map(({ params }) => params), [[TARGET, 'latest'], [OTHER_PIN, 'latest']], 'every pinned contract');
  const tx = d.transaction;
  assert.deepEqual(w.asked.at(-1).params, [{
    chainId: '0x185d9',
    from: tx.from,
    to: tx.to,
    data: tx.data,
    value: '0x0',
    gas: `0x${BigInt(tx.gasLimitRaw).toString(16)}`,
    maxFeePerGas: `0x${BigInt(tx.maxFeePerGasWeiRaw).toString(16)}`,
    maxPriorityFeePerGas: `0x${BigInt(tx.maxPriorityFeePerGasWeiRaw).toString(16)}`,
    nonce: `0x${tx.nonce.toString(16)}`,
  }]);
  assert.equal(w.asked.at(-1).params[0].chainId, `0x${ELYSIUM.id.toString(16)}`, 'the registry\'s chain id, written nowhere in the signer');
});

test('a draft that is not sendable as it stands is refused before the wallet is asked anything', async () => {
  for (const [label, d] of [
    ['another chain', draft({}, { chainId: ROBINHOOD.id })],
    ['from someone else', draft({}, { from: '0x1111111111111111111111111111111111111111' })],
    ['with value', draft({}, { valueRaw: '1' })],
  ]) {
    const w = wallet({}, d);
    await assert.rejects(signer(w).send(d), refusal('failed', 'draft_not_sendable'), label);
    assert.deepEqual(w.asked, [], `${label}: nothing asked`);
  }
});

test('a wallet on another chain, on another account, or a draft about to expire is never asked to send', async () => {
  const cases = [
    ['wrong chain', { eth_chainId: '0x1237' }, 'wrong_chain', NOW_MS],
    ['chain answer that is no quantity', { eth_chainId: 'elysium' }, 'wrong_chain', NOW_MS],
    ['another account', { eth_accounts: ['0x1111111111111111111111111111111111111111'] }, 'account_changed', NOW_MS],
    ['no account', { eth_accounts: [] }, 'account_changed', NOW_MS],
    ['expiring within the margin', {}, 'expired', (draft().expiresAt - EXPIRY_MARGIN_S) * 1000],
  ];
  for (const [label, answers, kind, now] of cases) {
    const d = draft();
    const w = wallet(answers, d);
    await assert.rejects(elysiumSignerFor(w.wallet, ELYSIUM, () => now).send(d), refusal(kind), label);
    assert.ok(!methods(w.asked).includes('eth_sendTransaction'), `${label}: never sent`);
  }
  // One second more than the margin is enough.
  const d = draft();
  const w = wallet({}, d);
  assert.equal(await elysiumSignerFor(w.wallet, ELYSIUM, () => (d.expiresAt - EXPIRY_MARGIN_S - 1) * 1000).send(d), HASH);
});

test('a nonce that moved, a target that is not pinned, or code that is not the pin\'s stops it', async () => {
  const cases = [
    ['nonce moved', { eth_getTransactionCount: '0x20' }, 'nonce_changed'],
    ['nonce not a quantity', { eth_getTransactionCount: '0x01f' }, 'failed'],
    ['code changed', { eth_getCode: (params) => (params[0] === OTHER_PIN ? '0x6080' : CODE[params[0]]) }, 'code_changed'],
    ['no code', { eth_getCode: '0x' }, 'code_changed'],
    ['code not hex', { eth_getCode: '0xzz' }, 'code_changed'],
    ['code not a string', { eth_getCode: 7 }, 'code_changed'],
  ];
  for (const [label, answers, kind] of cases) {
    const d = draft();
    const w = wallet(answers, d);
    await assert.rejects(signer(w).send(d), refusal(kind), label);
    assert.ok(!methods(w.asked).includes('eth_sendTransaction'), `${label}: never sent`);
  }
  const unpinned = draft({ contractPins: [{ address: OTHER_PIN, codeHash: keccak256(CODE[OTHER_PIN]) }] });
  const w = wallet({}, unpinned);
  await assert.rejects(signer(w).send(unpinned), refusal('code_changed', 'target_not_pinned'));
  assert.deepEqual(methods(w.asked), ['eth_chainId', 'eth_accounts', 'eth_getTransactionCount'], 'stopped before any code was read');
});

test('the chain, the account and the expiry are checked again after the code reads, right before the send', async () => {
  const switched = wallet({ eth_accounts: (params, nth) => (nth === 1 ? [OWNER] : ['0x2222222222222222222222222222222222222222']) });
  await assert.rejects(signer(switched).send(draft()), refusal('account_changed'));
  assert.ok(!methods(switched.asked).includes('eth_sendTransaction'));
  const moved = wallet({ eth_chainId: (params, nth) => (nth === 1 ? '0x185d9' : '0x1237') });
  await assert.rejects(signer(moved).send(draft()), refusal('wrong_chain'));
  assert.ok(!methods(moved.asked).includes('eth_sendTransaction'));
  let now = NOW_MS;
  const d = draft();
  const late = wallet({ eth_getCode: (params) => ((now = (d.expiresAt - EXPIRY_MARGIN_S) * 1000), CODE[params[0]]) }, d);
  await assert.rejects(elysiumSignerFor(late.wallet, ELYSIUM, () => now).send(d), refusal('expired'), 'it expired while the codes were read');
  assert.ok(!methods(late.asked).includes('eth_sendTransaction'));
});

test('a wallet that fails a read is unavailable; a refusal of the send says so; any other failure is a failure', async () => {
  const broken = wallet({ eth_chainId: new Error('disconnected') });
  await assert.rejects(signer(broken).send(draft()), refusal('unavailable', 'wallet_unavailable'));
  for (const [label, error, kind] of [
    ['4001', walletError(4001), 'rejected'],
    ['4001, wrapped', walletError(4001, true), 'rejected'],
    ['-32603', walletError(-32603), 'failed'],
    ['no code', new Error('boom'), 'failed'],
  ]) {
    const w = wallet({ eth_sendTransaction: error });
    await assert.rejects(signer(w).send(draft()), refusal(kind, 'send_failed'), label);
    assert.equal(methods(w.asked).filter((method) => method === 'eth_sendTransaction').length, 1, `${label}: asked once, never again`);
  }
  for (const reply of ['0x1234', null, 42, `0x${'g'.repeat(64)}`]) {
    const w = wallet({ eth_sendTransaction: reply });
    await assert.rejects(signer(w).send(draft()), refusal('failed', 'invalid_hash'), String(reply));
  }
});

test('the wallet is asked to add exactly the registry\'s network, and its answer is told apart', async () => {
  const w = wallet();
  assert.equal(await addChain(w.wallet.provider, ELYSIUM), 'added');
  assert.deepEqual(w.asked, [{ method: 'wallet_addEthereumChain', params: [addChainParameters(ELYSIUM)] }]);
  assert.deepEqual(w.asked[0].params[0], {
    chainId: '0x185d9',
    chainName: 'Elysium Testnet',
    nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
    rpcUrls: ['https://testnet-rpc.elysium.kinetiq.xyz'],
    blockExplorerUrls: ['https://elysium.kinetiq.xyz/testnet-explorer'],
  });
  assert.equal(await addChain(wallet({ wallet_addEthereumChain: walletError(4001) }).wallet.provider, ELYSIUM), 'rejected');
  assert.equal(await addChain(wallet({ wallet_addEthereumChain: walletError(4001, true) }).wallet.provider, ELYSIUM), 'rejected');
  assert.equal(await addChain(wallet({ wallet_addEthereumChain: walletError(-32602) }).wallet.provider, ELYSIUM), 'failed');
  assert.equal(await addChain(wallet({ wallet_addEthereumChain: new Error('boom') }).wallet.provider), 'failed', 'the registry\'s Elysium by default');
});

test('the signer asks nothing but its fixed reads, the send and the network add', async () => {
  const w = wallet();
  await signer(w).send(draft());
  await addChain(w.wallet.provider, ELYSIUM);
  assert.deepEqual([...new Set(methods(w.asked))].sort(), ['eth_accounts', 'eth_chainId', 'eth_getCode', 'eth_getTransactionCount', 'eth_sendTransaction', 'wallet_addEthereumChain']);
});
