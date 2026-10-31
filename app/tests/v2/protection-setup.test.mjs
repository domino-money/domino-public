import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { protectionPositions, protectionSelection } = require('../../.test-build/app/src/v2in/automate/protectionPositions.js');
const { v2Chain } = require('../../.test-build/app/src/v2/chains.js');
const { automationState, rememberMandate, sessionMandatesFor } = require('../../.test-build/app/src/v2in/automate/store.js');
const { setupWaiting } = require('../../.test-build/app/src/v2in/automate/setupPositions.js');
const fixture = () => JSON.parse(readFileSync(new URL('../../../api-contracts/read-v6/fixtures/valid/portfolio.json', import.meta.url), 'utf8'));
const portfolio = () => {
  const body = fixture();
  body.positions = [body.positions.find((p) => p.tokenId === '9')];
  body.vaults = []; body.mandates = []; body.credits = [];
  body.truncated = { positions: false, mandates: false, vaults: false };
  body.chains = body.chains.map((chain) => ({ ...body.chains[0], chainId: chain.chainId }));
  return body;
};

test('protection picker separates the same NFT id across supported chains and managers', () => {
  const body = portfolio();
  const plain = body.positions[0];
  body.positions = [4663, 8453, 42161].flatMap((chainId) => [3, 4].map((dex) => ({
    ...structuredClone(plain), chainId, dex, positionManager: v2Chain(chainId).uniswap[`v${dex}`].positionManager,
    state: { ...structuredClone(plain.state), pool: { ...plain.state.pool, dex } },
  })));
  const result = protectionPositions(body, body.wallet);
  assert.equal(result.incomplete, false);
  assert.deepEqual(result.positions.map((p) => p.key), ['4663:3:9', '4663:4:9', '8453:3:9', '8453:4:9', '42161:3:9', '42161:4:9']);
  for (const option of result.positions) {
    assert.equal(option.target.tokenId, 9n);
    assert.equal(option.target.price.block, plain.state.snapshot.number);
    assert.equal(option.target.price.saved, false);
    assert.equal(option.target.vault, null);
  }
  assert.equal(protectionSelection('#/sequence/protection/9'), '4663:4:9');
  assert.equal(protectionSelection('#/sequence/protection/base-v3-9'), '8453:3:9');
  assert.equal(protectionSelection('#/sequence/protection/09'), null);
  assert.equal(protectionSelection('#/sequence/protection'), null);
});

test('protection picker cannot offer an existing, closed, foreign, hooked, stale or full-range position', () => {
  const foreign = `0x${'1'.repeat(40)}`;
  for (const edit of [
    (b) => { b.positions[0].state.owner = foreign; },
    (b) => { b.positions[0].state.liquidity = '0'; },
    (b) => { b.positions[0].state.pool.hooks = foreign; },
    (b) => { b.positions[0].state.custody.subscriber = foreign; },
    (b) => { b.positions[0].state.freshness.status = 'stale'; },
    (b) => { Object.assign(b.positions[0].state, { tickLower: -887220, tickUpper: 887220, pool: { ...b.positions[0].state.pool, tickSpacing: 60 } }); },
    (b) => { b.positions[0].vault = { address: foreign, role: 'root' }; },
    (b) => { const vault = fixture().vaults[0]; b.vaults = [{ ...vault, rootTokenId: '9' }]; },
    (b) => { const mandate = fixture().mandates[0]; b.mandates = [{ ...mandate, tokenId: '9', status: 'active', expired: false }]; },
    (b) => { b.truncated.mandates = true; },
  ]) {
    const body = portfolio(); edit(body);
    assert.equal(protectionPositions(body, body.wallet).positions.length, 0);
  }
  const body = portfolio();
  assert.equal(protectionPositions(body, foreign).positions.length, 0, 'wallet switch cannot inherit a previous account');
  body.chains[1].status = 'unavailable';
  assert.equal(protectionPositions(body, body.wallet).incomplete, true);
  assert.equal(protectionPositions(body, body.wallet).positions.length, 1, 'an unavailable network does not hide a proven eligible NFT elsewhere');
});

// 2026-10-30 (QA round 2, final review shell-1): Set up Auto-exit (ProtectionSetup.tsx) keeps its loading rows while one of
// the wallet's own NFTs on an open network could not be judged, and shows "No positions available for Auto-exit" with New
// position only when nothing is waiting; protectionPositions' `incomplete` alone (any network behind) never decides it.
test('Auto-exit setup with nothing to offer: an NFT not judged yet keeps the loading rows; a wallet with none gets the plate', () => {
  const open = (chainId) => chainId === 4663;
  const offered = (body) => protectionPositions(body, body.wallet).positions.length;
  for (const edit of [
    (b) => { b.positions[0].state.freshness.status = 'stale'; },
    (b) => { b.positions[0].state = { status: 'not_read' }; },
    (b) => { b.chains.find((c) => c.chainId === 4663).status = 'stale'; },
  ]) {
    const body = portfolio(); edit(body);
    assert.equal(offered(body), 0);
    assert.equal(protectionPositions(body, body.wallet).incomplete, true);
    assert.equal(setupWaiting(body, body.wallet, offered(body), open), true, 'loading rows, never "No positions available for Auto-exit"');
    assert.equal(setupWaiting(body, body.wallet, offered(body), () => false), false, 'with every gate closed nothing is waited for');
  }
  // Truly none: an empty wallet with a network behind is incomplete for the picker, and still the plate at once.
  const empty = portfolio();
  empty.positions = [];
  empty.chains[1].status = 'unavailable';
  assert.equal(protectionPositions(empty, empty.wallet).incomplete, true);
  assert.equal(setupWaiting(empty, empty.wallet, 0, open), false);
  // A judged NFT Auto-exit cannot take (full range, already automated) is a fact: the plate.
  for (const edit of [
    (b) => { Object.assign(b.positions[0].state, { tickLower: -887220, tickUpper: 887220, pool: { ...b.positions[0].state.pool, tickSpacing: 60 } }); },
    (b) => { b.positions[0].vault = { address: `0x${'1'.repeat(40)}`, role: 'root' }; },
  ]) {
    const body = portfolio(); edit(body);
    assert.equal(offered(body), 0);
    assert.equal(setupWaiting(body, body.wallet, offered(body), open), false);
  }
  // ProtectionSetup asks it with its joined gates, and draws the loading rows on it before the plate.
  const screen = readFileSync(new URL('../../src/v2in/automate/ProtectionSetup.tsx', import.meta.url), 'utf8');
  assert.match(screen, /const waiting = body !== null && !waitOver && setupWaiting\(body, owner, positions\.length, \(chainId\) => gates\[chainId\] !== null\)/);
  assert.match(screen, /: !list \|\| waiting \? <div className="dm-card dm-acct-block dm-seq-loading" aria-busy="true" data-sequence-positions="failed">/);
  assert.ok(screen.indexOf('!list || waiting') < screen.indexOf('data-sequence-positions="empty"'));
});

test('a just-registered V3 mandate cannot hide the same-numbered V4 NFT or another wallet/chain', () => {
  const owner = portfolio().wallet;
  const entry = { chainId: 8453, dex: 3, owner, id: `0x${'3'.repeat(64)}`, nonce: 3n, vault: `0x${'4'.repeat(40)}`, tokenId: 9n, registered: true };
  rememberMandate(entry);
  const state = automationState();
  assert.equal(sessionMandatesFor(state, 8453, owner, 9n, 3).length, 1);
  assert.equal(sessionMandatesFor(state, 8453, owner, 9n, 4).length, 0);
  assert.equal(sessionMandatesFor(state, 4663, owner, 9n, 3).length, 0);
  assert.equal(sessionMandatesFor(state, 8453, `0x${'5'.repeat(40)}`, 9n, 3).length, 0);
  rememberMandate({ ...entry, id: `0x${'6'.repeat(64)}`, dex: undefined });
  assert.equal(sessionMandatesFor(automationState(), 8453, owner, 9n, 4).length, 1, 'older unqualified entries remain conservative until the index proves their namespace');
});
