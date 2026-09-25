/**
 * The EIP-7702 delegates this app recognizes (src/finance/delegates.ts): how an account's code is read, which
 * delegate a designator names, and that a delegate is recognized by the hash of its code, a proxy only with a
 * recognized implementation. tests/support/eip7702-delegates.code.json holds two delegates' real runtime code,
 * read on Robinhood Chain, so the recognition below is of real code, not of a hash the test chose.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { ERC1967_IMPLEMENTATION_SLOT, KNOWN_DELEGATES, designatedDelegate, knownDelegateAt, readAccountCode } = require('../.test-build/app/src/finance/delegates.js');
const { keccak256 } = require('viem');

const REAL = JSON.parse(readFileSync(new URL('./support/eip7702-delegates.code.json', import.meta.url), 'utf8'));
const SIMPLE = '0xe6cae83bde06e4c305530e199d7217f42808555b', PROXY = '0x7702cb554e6bfb442cb743a7df23154544a7176c';
const owner = '0x' + '11'.repeat(20), other = '0x' + 'ab'.repeat(20), implementation = '0x' + 'cd'.repeat(20);
const designator = delegate => '0xef0100' + delegate.slice(2);
const word = address => '0x' + '0'.repeat(24) + address.slice(2);

/** A wallet's read over a fixed state: `code` by address and one ERC-1967 word for the owner; every read logged. */
function chain(code, slot = null) {
  const reads = [];
  const read = async (method, params) => {
    reads.push([method, ...params]);
    if (method === 'eth_getCode') return code[params[0]] ?? '0x';
    if (method === 'eth_getStorageAt' && params[0] === owner && params[1] === ERC1967_IMPLEMENTATION_SLOT) return slot ?? '0x' + '0'.repeat(64);
    throw new Error('unexpected read ' + method);
  };
  return { read, reads };
}

test('a designator is exactly 0xef0100 and a nonzero address; a byte short or long, another prefix or the zero address is none', () => {
  assert.equal(designatedDelegate(designator(other)), other);
  assert.equal(designatedDelegate(designator(other).toUpperCase().replace('0XEF', '0xef')), other, 'hex case does not matter');
  for (const code of ['0x', '0x6000', designator(other).slice(0, -2), designator(other) + '00', '0xef0101' + other.slice(2), '0xee0100' + other.slice(2), designator('0x' + '00'.repeat(20))]) {
    assert.equal(designatedDelegate(code), null, code);
  }
});

test('an account with no code is plain, and other code is a contract: in both, only the account itself is read', async () => {
  for (const [code, kind] of [['0x', 'plain'], ['0x6000', 'contract'], [designator(other) + '00', 'contract']]) {
    const c = chain({ [owner]: code });
    assert.deepEqual(await readAccountCode(c.read, owner, '0x10'), { kind });
    assert.deepEqual(c.reads, [['eth_getCode', owner, '0x10']]);
  }
});

test('a delegate is recognized by the hash of its code read at the same block, not by its address', async () => {
  // Simple7702Account's real code, where it is deployed: recognized, with its entry.
  let c = chain({ [owner]: designator(SIMPLE), [SIMPLE]: REAL.code[SIMPLE] });
  const known = await readAccountCode(c.read, owner, '0x10');
  assert.equal(known.kind, 'delegated');
  assert.equal(known.delegate, SIMPLE);
  assert.equal(known.known, KNOWN_DELEGATES.find(entry => entry.address === SIMPLE));
  assert.deepEqual(c.reads, [['eth_getCode', owner, '0x10'], ['eth_getCode', SIMPLE, '0x10']]);
  // The same code at another address is the same code: recognized too.
  c = chain({ [owner]: designator(other), [other]: REAL.code[SIMPLE] });
  assert.equal((await readAccountCode(c.read, owner)).known.address, SIMPLE);
  // A recognized address whose code is anything else is not.
  c = chain({ [owner]: designator(SIMPLE), [SIMPLE]: '0x6000' });
  assert.deepEqual(await readAccountCode(c.read, owner), { kind: 'delegated', delegate: SIMPLE, known: null });
  // Nor is a delegate with no code, which could be deployed later.
  c = chain({ [owner]: designator(other) });
  assert.deepEqual(await readAccountCode(c.read, owner), { kind: 'delegated', delegate: other, known: null });
});

test('a proxy delegate is recognized only while the account’s ERC-1967 slot names a recognized implementation', async () => {
  // Coinbase's real EIP7702Proxy with anything but CoinbaseSmartWallet behind it: not recognized, whatever the proxy is.
  let c = chain({ [owner]: designator(PROXY), [PROXY]: REAL.code[PROXY], [implementation]: '0x6000' }, word(implementation));
  assert.deepEqual(await readAccountCode(c.read, owner, '0x10'), { kind: 'delegated', delegate: PROXY, known: null });
  assert.deepEqual(c.reads.slice(2), [['eth_getStorageAt', owner, ERC1967_IMPLEMENTATION_SLOT, '0x10'], ['eth_getCode', implementation, '0x10']], 'the slot and the implementation at the same block');
  // The same logic over a table whose implementation is known: recognized, with the proxy's entry.
  const proxy = { wallet: 'P', contract: 'Proxy', address: PROXY, codeHash: keccak256('0x6001'), implementations: [{ contract: 'I', address: implementation, codeHash: keccak256('0x6002') }] };
  c = chain({ [owner]: designator(other), [other]: '0x6001', [implementation]: '0x6002' }, word(implementation));
  assert.equal((await readAccountCode(c.read, owner, 'latest', [proxy])).known, proxy);
  // Another implementation, none set, or a word that is not an address: not recognized, and a non-address is never read as one.
  for (const [slot, reads] of [[word(other), 4], ['0x' + '0'.repeat(64), 4], ['0x' + 'ff'.repeat(12) + implementation.slice(2), 3]]) {
    c = chain({ [owner]: designator(other), [other]: '0x6001', [implementation]: '0x6002' }, slot);
    assert.equal((await readAccountCode(c.read, owner, 'latest', [proxy])).known, null, slot);
    assert.equal(c.reads.length, reads, slot);
  }
  // A reply that is not one storage word fails as a read.
  c = chain({ [owner]: designator(other), [other]: '0x6001' }, '0x1234');
  await assert.rejects(readAccountCode(c.read, owner, 'latest', [proxy]), /invalid_wallet_reply/);
});

test('a reply that is not code fails as a read, never as an account of some kind', async () => {
  for (const reply of [null, 42, '0x123', 'ef0100', '0xzz']) {
    await assert.rejects(readAccountCode(async () => reply, owner), /invalid_wallet_reply/, String(reply));
  }
  await assert.rejects(readAccountCode(async (method, [address]) => (address === owner ? designator(other) : '0x1'), owner), /invalid_wallet_reply/, 'the delegate’s code too');
});

test('the table: one entry per deployment, lowercase addresses and hashes, the proxy with its implementation, and the real code hashes to its entry', () => {
  assert.ok(KNOWN_DELEGATES.length >= 13);
  assert.ok(Object.isFrozen(KNOWN_DELEGATES));
  for (const entry of KNOWN_DELEGATES) {
    assert.match(entry.address, /^0x[0-9a-f]{40}$/);
    assert.match(entry.codeHash, /^0x[0-9a-f]{64}$/);
    assert.ok(entry.wallet && entry.contract);
  }
  assert.equal(new Set(KNOWN_DELEGATES.map(entry => entry.address)).size, KNOWN_DELEGATES.length);
  assert.equal(new Set(KNOWN_DELEGATES.map(entry => entry.codeHash)).size, KNOWN_DELEGATES.length);
  const proxies = KNOWN_DELEGATES.filter(entry => entry.implementations);
  assert.deepEqual(proxies.map(entry => entry.address), [PROXY], 'the one proxy is Coinbase’s, and it names its implementation');
  assert.deepEqual(proxies[0].implementations.map(entry => entry.contract), ['CoinbaseSmartWallet']);
  for (const address of [SIMPLE, PROXY]) assert.equal(keccak256(REAL.code[address]), knownDelegateAt(address).codeHash, address);
  assert.equal(REAL.chainId, 4663);
});

test('a delegate is named from its address for display, case aside; any other address has no name', () => {
  assert.equal(knownDelegateAt(SIMPLE.toUpperCase().replace('0X', '0x')).contract, 'Simple7702Account (EntryPoint v0.8)');
  assert.equal(knownDelegateAt('0x63c0c19a282a1b52b07dd5a65b58948a07dae32b').wallet, 'MetaMask');
  assert.equal(knownDelegateAt('0x1c08930b2d330447e6c05b5be8c4caf172b4a174'), null, 'the most used unidentified delegate on 4663 stays unnamed');
});
