import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import * as runtime from '../../../api-contracts/read-v6/runtime.mjs';

const require = createRequire(import.meta.url);
const { SETUP_WAIT_MS, setupEligibility, setupPositions, setupRetryDelay, setupWaiting } = require('../../.test-build/app/src/v2in/automate/setupPositions.js');
const { v2Chain } = require('../../.test-build/app/src/v2/chains.js');
const { setupIntent, setupHref } = require('../../.test-build/app/src/v2in/automate/intent.js');
const ZERO = `0x${'0'.repeat(40)}`;
const OTHER = `0x${'1'.repeat(40)}`;
const fixture = () => JSON.parse(readFileSync(new URL('../../../api-contracts/read-v6/fixtures/valid/portfolio.json', import.meta.url), 'utf8'));
function portfolio() {
  const body = fixture();
  body.positions = [body.positions.find((p) => p.tokenId === '9')];
  body.vaults = [];
  body.mandates = [];
  body.credits = [];
  body.truncated = { vaults: false, positions: false, mandates: false };
  assert.equal(runtime.validateResponse('portfolio', body), true);
  return body;
}

test('V2-only S1 NFTs enter setup without a V1 mint or existing factory vault', () => {
  const body = portfolio();
  body.positions = ['3659474', '3659583', '3659593'].map((tokenId) => ({ ...structuredClone(body.positions[0]), tokenId }));
  assert.equal(runtime.validateResponse('portfolio', body), true);
  const result = setupPositions(body, body.wallet);
  assert.equal(result.incomplete, false, 'unavailable unrelated chains do not hide Robinhood');
  assert.deepEqual(result.positions.map((p) => p.tokenId), ['3659474', '3659583', '3659593']);
  const [position] = result.positions;
  assert.equal(position.currencies[0].symbol, 'USDG');
  assert.equal(position.currencies[0].decimals, 6);
  assert.equal(position.liquidity, body.positions[0].state.liquidity);
  assert.deepEqual(position.unclaimedFees, ['1200', '0']);
  assert.deepEqual(position.principal, body.positions[0].state.principalAtSpot);
  assert.equal(position.sqrtPriceX96, body.positions[0].state.sqrtPriceX96);
});

test('NFT ids are scoped to chain, DEX and the deployed position manager', () => {
  const body = portfolio();
  const root = body.positions[0];
  const current = body.chains.find((c) => c.chainId === 4663);
  body.chains = [4663, 8453, 42161].map((chainId) => ({ ...structuredClone(current), chainId }));
  body.positions = [4663, 8453, 42161].flatMap((chainId) => [3, 4].map((dex) => ({ ...structuredClone(root), chainId, dex,
    positionManager: v2Chain(chainId).uniswap[`v${dex}`].positionManager,
    state: { ...structuredClone(root.state), pool: { ...root.state.pool, dex } },
  })));
  body.tokens.push({ ...body.tokens.find((t) => t.address === root.state.pool.currency1), chainId: 8453, symbol: 'WRONG CHAIN', decimals: 2 });
  const positions = setupPositions(body, body.wallet).positions;
  assert.deepEqual(positions.map((p) => p.key), ['4663:3:9', '4663:4:9', '8453:3:9', '8453:4:9', '42161:3:9', '42161:4:9']);
  assert.notEqual(positions[0].currencies[1].symbol, 'WRONG CHAIN');
  assert.equal(positions[2].currencies[1].symbol, 'WRONG CHAIN', 'metadata is taken from this position’s network only');
  body.positions = [root];
  root.positionManager = OTHER;
  assert.equal(setupEligibility(body, body.wallet, root), 'unsupported');
  assert.deepEqual(setupPositions(body, body.wallet).positions, []);
  root.positionManager = v2Chain(4663).uniswap.v4.positionManager;
  root.state.pool.dex = 3;
  assert.equal(setupEligibility(body, body.wallet, root), 'unsupported');
});

test('automation routes preserve Robinhood numeric links and qualify every other NFT namespace', () => {
  for (const chainId of [4663, 8453, 42161]) for (const dex of [3, 4]) for (const mode of [null, 'compound', 'domino', 'protection']) {
    const position = { chainId, dex, tokenId: 9n };
    const href = setupHref(position, mode);
    assert.deepEqual(setupIntent(href), { mode, tokenId: '9', position });
  }
  assert.equal(setupHref({ chainId: 4663, dex: 4, tokenId: 9n }), '/sequence/9');
  assert.equal(setupHref({ chainId: 4663, dex: 4, tokenId: 9n }, 'compound'), '/sequence/compound/9');
  for (const hash of ['#/sequence/base-v5-9', '#/sequence/compound/base-v3-0', '#/sequence/domino/unknown-v3-9']) {
    assert.equal(setupIntent(hash).position, null, 'invalid qualified links never resolve to Robinhood');
  }
});

test('current ownership and live custody exclude already managed, transferred, closed and hooked NFTs', () => {
  const cases = [
    ['not-owned', (p) => { p.state.owner = OTHER; }],
    ['closed', (p) => { p.state.liquidity = '0'; }],
    ['unsupported', (p) => { p.state.pool.hooks = OTHER; }],
    ['unsupported', (p) => { p.tokenId = (1n << 96n).toString(); }],
    ['automated', (p) => { p.vault = { address: OTHER, role: 'root' }; }],
    ['subscribed', (p) => { p.state.custody.subscriber = OTHER; }],
  ];
  for (const [reason, edit] of cases) {
    const body = portfolio();
    edit(body.positions[0]);
    assert.equal(setupEligibility(body, body.wallet, body.positions[0]), reason);
    assert.deepEqual(setupPositions(body, body.wallet), { positions: [], incomplete: true }, reason + ': this known NFT is excluded, while the unrelated unavailable inventories remain unknown');
  }
  const body = portfolio();
  body.positions[0].state.custody = { approved: OTHER, subscriber: ZERO };
  assert.equal(setupEligibility(body, body.wallet, body.positions[0]), 'eligible', 'the flow can replace an individual approval; it cannot replace a subscriber');
  assert.equal(setupEligibility(body, OTHER, body.positions[0]), 'unavailable', 'another wallet never inherits the previous answer');
});

test('missing, stale and partial coverage never claim that there are no positions', () => {
  for (const edit of [
    (b) => { b.positions[0].state = { status: 'not_read' }; },
    (b) => { b.positions[0].state.status = 'unavailable'; },
    (b) => { b.positions[0].state.freshness.status = 'stale'; },
    (b) => { b.chains.find((c) => c.chainId === 4663).status = 'stale'; },
    (b) => { b.chains = b.chains.filter((c) => c.chainId !== 4663); },
  ]) {
    const body = portfolio();
    edit(body);
    assert.deepEqual(setupPositions(body, body.wallet), { positions: [], incomplete: true });
  }
  const body = portfolio();
  body.truncated.positions = true;
  assert.equal(setupPositions(body, body.wallet).incomplete, true);
  assert.equal(setupPositions(body, body.wallet).positions.length, 1, 'known eligible entries remain usable');
  body.positions = [];
  assert.deepEqual(setupPositions(body, body.wallet), { positions: [], incomplete: true });
  body.truncated.positions = false;
  assert.deepEqual(setupPositions(body, body.wallet), { positions: [], incomplete: true });
});

test('an empty unavailable inventory is unknown; an unrelated network failure never hides a verified Robinhood position', () => {
  const body = portfolio();
  assert.equal(setupPositions(body, body.wallet).positions.length, 1, 'the verified Robinhood position remains available');
  assert.equal(setupPositions(body, body.wallet).incomplete, false);
  const current = structuredClone(body.chains.find(chain => chain.status === 'current'));
  const unavailable = structuredClone(body.chains.find(chain => chain.status === 'unavailable'));
  body.positions = [];
  body.chains = body.chains.map(chain => ({ ...structuredClone(unavailable), chainId: chain.chainId }));
  assert.equal(runtime.validateResponse('portfolio', body), true, 'an unavailable empty inventory is a valid API response');
  assert.deepEqual(setupPositions(body, body.wallet), { positions: [], incomplete: true }, 'unavailable does not mean there are no eligible positions');
  body.chains = body.chains.map(chain => ({ ...structuredClone(current), chainId: chain.chainId }));
  body.coverage = 'complete';
  assert.equal(runtime.validateResponse('portfolio', body), true);
  assert.deepEqual(setupPositions(body, body.wallet), { positions: [], incomplete: false }, 'only a checked empty inventory is shown as empty');
});

// 2026-10-30 (QA round 2, final review shell-1): Set up automation (SetupEntry.tsx) keeps its loading rows while one of the
// wallet's own NFTs on an open network could not be judged, and shows the "No positions available for setup" plate, with
// New position, only when nothing is waiting: a wallet that truly has no position gets the plate at once.
test('setup with nothing to offer: an NFT not judged yet keeps the loading rows; a wallet with none gets the plate', () => {
  const open = () => true;
  const offered = (body) => setupPositions(body, body.wallet).positions.length;
  // Eligible none, but the wallet's Robinhood NFT could not be judged: its reading or its network is not fresh yet.
  for (const [why, edit] of [
    ['a stale reading', (b) => { b.positions[0].state.freshness.status = 'stale'; }],
    ['a reading not taken yet', (b) => { b.positions[0].state = { status: 'not_read' }; }],
    ['its network behind', (b) => { b.chains.find((c) => c.chainId === 4663).status = 'stale'; }],
    ['its network missing from the answer', (b) => { b.chains = b.chains.filter((c) => c.chainId !== 4663); }],
  ]) {
    const body = portfolio();
    edit(body);
    assert.equal(offered(body), 0, why);
    assert.equal(setupWaiting(body, body.wallet, offered(body), open), true, `${why}: loading rows, never the plate`);
    assert.equal(setupWaiting(body, body.wallet, offered(body), (chainId) => chainId !== 4663), false, `${why}: an NFT behind a closed gate is not waited for`);
  }
  // Truly none: an empty wallet, even with an unrelated network behind (the fixture's Base and Arbitrum), gets the plate.
  const empty = portfolio();
  empty.positions = [];
  assert.equal(setupPositions(empty, empty.wallet).incomplete, true, 'an unrelated network is still behind');
  assert.equal(setupWaiting(empty, empty.wallet, 0, open), false, 'no NFT to wait for: the plate at once');
  // NFTs judged and excluded (closed, transferred, already automated) are a fact too: the plate.
  for (const edit of [(p) => { p.state.liquidity = '0'; }, (p) => { p.state.owner = OTHER; }, (p) => { p.vault = { address: OTHER, role: 'root' }; }]) {
    const body = portfolio();
    edit(body.positions[0]);
    assert.equal(setupWaiting(body, body.wallet, offered(body), open), false);
  }
  // Something to offer: the list, whatever else waits.
  const body = portfolio();
  body.positions.push({ ...structuredClone(body.positions[0]), tokenId: '10', state: { status: 'not_read' } });
  assert.equal(offered(body), 1);
  assert.equal(setupWaiting(body, body.wallet, offered(body), open), false);
  // SetupEntry draws the loading rows (data-sequence-positions="failed") on it, before the plate, with the gates it lists by.
  const entry = readFileSync(new URL('../../src/v2in/automate/SetupEntry.tsx', import.meta.url), 'utf8');
  // (final review follow-up) For two minutes at most (SETUP_WAIT_MS), in both setup screens: read-v6 can keep an NFT unjudged
  // for good, and the plate is said then rather than loading rows forever.
  assert.match(entry, /if \(!body \|\| !list \|\| \(!waitOver && setupWaiting\(body, owner, positions\.length, \(chainId\) => gateOpen\(gates\[chainId\]\)\)\)\) return \(\s*<div className="dm-card dm-acct-block dm-seq-loading" aria-busy="true" data-sequence-positions="failed">/);
  assert.ok(entry.indexOf('setupWaiting(body') < entry.indexOf('data-sequence-positions="empty"'), 'the waiting check comes before the plate');
  assert.match(entry, /const waitOver = useSetupWaitOver\(\)/);
  const protection = readFileSync(new URL('../../src/v2in/automate/ProtectionSetup.tsx', import.meta.url), 'utf8');
  assert.match(protection, /const waitOver = useSetupWaitOver\(\)/);
  assert.match(protection, /const waiting = body !== null && !waitOver && setupWaiting\(/);
  assert.equal(SETUP_WAIT_MS, 120_000);
  const helper = readFileSync(new URL('../../src/v2in/automate/setupPositions.ts', import.meta.url), 'utf8');
  assert.match(helper, /window\.setTimeout\(\(\) => setOver\(true\), SETUP_WAIT_MS\)/);
  assert.match(helper, /return \(\) => window\.clearTimeout\(timer\)/);
});

test('metadata stays chain-qualified and missing token decimals are never guessed', () => {
  const body = portfolio();
  const token = body.positions[0].state.pool.currency1;
  body.tokens = body.tokens.filter((t) => t.address !== token);
  const [position] = setupPositions(body, body.wallet).positions;
  assert.deepEqual(position.currencies[1], { address: token, symbol: null, decimals: null });
  assert.equal(position.currencies[0].decimals, 6, 'USDG uses its verified chain profile');
});

test('post-mint discovery retries only the requested NFT and stops after three increasing waits', () => {
  const body = portfolio();
  assert.deepEqual([0, 1, 2, 3, 4].map((n) => setupRetryDelay(body, body.wallet, '3659474', n)), [1500, 3000, 6000, null, null]);
  assert.equal(setupRetryDelay(body, body.wallet, null, 0), null);
  assert.equal(setupRetryDelay(body, body.wallet, '9', 0), null, 'verified eligible is ready immediately');
  assert.equal(setupRetryDelay(body, body.wallet, { chainId: 8453, dex: 3, tokenId: 9n }, 0), 1500, 'the same NFT number on Robinhood never satisfies a Base mint');
  body.positions[0].state.freshness.status = 'stale';
  assert.equal(setupRetryDelay(body, body.wallet, '9', 0), 1500);
  body.positions[0].state.freshness.status = 'fresh';
  body.positions[0].state.custody.subscriber = OTHER;
  assert.equal(setupRetryDelay(body, body.wallet, '9', 0), null, 'known foreign custody is a real block, not index lag');
});
