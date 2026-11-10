/**
 * The Base/Arbitrum position page's words are Robinhood Chain's (added 2026-11-06, the owner: every chain the same as
 * Robinhood Chain; O-09, O-12, O-13, O-14): the tiles' help from the one module both pages draw them with, no "Read at
 * block", and the strings Robinhood Chain's own page and actions use, word for word.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { COPY } = require('../../.test-build/app/src/v2in/position/copy.js');
const src = (path) => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8');

test('the tiles\' words are Robinhood Chain\'s own, from the one module both pages draw them with', () => {
  const parts = src('components/positions/keyFigureParts.tsx');
  assert.match(parts, /valueInfo: 'What your position is worth now, at the pool’s price\. Fees not included\.'/);
  const page = src('v2in/position/PositionPage.tsx');
  for (const used of ['KEY.valueInfo', 'KEY.feesInfo', 'KEY.priceInfo', 'KEY.tokenAmounts', '<RangeLine', '<ValueSplit', '<PriceNow']) assert.ok(page.includes(used), used);
  assert.ok(src('components/positions/KeyFigures.tsx').includes("from './keyFigureParts'"), 'Robinhood Chain\'s page draws the same parts');
  const code = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /Read at block|readAt/, 'no "Read at block" on the strip or in Details (QA round 2, R23)');
  assert.equal(COPY.page.readAt, undefined);
  assert.equal(COPY.page.holdsInfo, undefined, 'the V2-only Position value help is gone');
  assert.equal(COPY.page.collectableInfo, 'Tokens available to collect. This can include tokens withdrawn from liquidity outside Domino.', 'v3 keeps its own Fees to collect help');
});

test('Details, Collect fees and a burned NFT say what Robinhood Chain\'s page says', () => {
  const detail = src('screens/PositionDetail.tsx');
  const actions = src('components/positions/PositionActions.tsx');
  assert.ok(detail.includes(`<KeyValue label="${COPY.page.poolId}">`));
  assert.ok(detail.includes(`<KeyValue label="${COPY.page.feesHistory}">`));
  assert.ok(detail.includes(COPY.page.newInPool));
  assert.ok(detail.includes(`title="${COPY.page.gone}"`));
  assert.ok(detail.includes('body={`NFT #${tokenId} was not found at block ${current.block}.`}'));
  assert.equal(COPY.page.goneAt('41', 52500000), 'NFT #41 was not found at block 52500000.');
  assert.ok(actions.includes(`'${COPY.page.noFees}'`));
  // Changed on purpose 2026-11-09 (the core-flows fix, item d): fees not read no longer turn Collect fees off on either
  // page (its dialog reads them on chain), so neither says "The fees could not be read just now." on a button any more.
  assert.ok(!actions.includes(`'${COPY.page.feesUnread}'`));
  assert.ok(actions.includes(`'${COPY.page.closedNoLiquidity}'`), 'a closed position: Robinhood Chain\'s own reason');
  const [before, after] = COPY.page.ownerOnly.connected;
  assert.ok(detail.includes(`${before} <Address value={card.owner.address} short /> ${after}`));
  const [connect, rest] = COPY.page.ownerOnly.disconnected;
  assert.ok(detail.includes(`${connect} <Address value={card.owner.address} short /> ${rest}`));
});
