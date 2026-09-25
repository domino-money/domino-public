// Added 2026-09-24 (the owner's simpler automation page): the position picker's data (src/lib/automate/picker.ts).
// The page lists the connected wallet's open positions from lib/walletPositions.ts; nothing is typed or searched, and a
// `#/sequence/<mode>/<id>` link only preselects an id that is already in the list. Tested here with injected data,
// since useWalletPositions answers idle until its endpoint lands.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { automatable, pickerList, preselected, tokenName, feeText, rangeView } = require('../.test-build/app/src/lib/automate/picker.js');

const ETH = { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18 };
const USDG = { address: '0x' + 'ab'.repeat(20), symbol: 'USDG', decimals: 6 };
const position = (tokenId, patch = {}) => ({
  tokenId, status: 'open', poolId: '0x' + '11'.repeat(32), currencies: [ETH, USDG], fee: 3000, tickSpacing: 60, hooks: ETH.address,
  tickLower: -600, tickUpper: 600, liquidity: '1000', sqrtPriceX96: null, tick: 0, unclaimedFees: null, principal: null, ...patch,
});

test('only open positions with a canonical id are offered, in the order read; idle and nothing open are the empty state', () => {
  const open = [position('7'), position('5', { status: 'closed', liquidity: '0' }), position('9'), position('012')];
  assert.deepEqual(pickerList({ phase: 'ready', block: 1, positions: open }), { kind: 'ready', positions: [open[0], open[2]] });
  assert.deepEqual(pickerList({ phase: 'ready', block: 1, positions: [position('5', { status: 'closed' })] }), { kind: 'empty' });
  assert.deepEqual(pickerList({ phase: 'idle' }), { kind: 'empty' });
  assert.deepEqual(pickerList({ phase: 'loading' }), { kind: 'loading' });
  assert.deepEqual(pickerList({ phase: 'failed', reason: 'x' }), { kind: 'failed' });
});

test('a link preselects its id only when that position is listed', () => {
  const list = [position('7'), position('9')];
  assert.equal(preselected(list, '9'), '9');
  assert.equal(preselected(list, '5'), null, 'someone else’s or a closed id is never chosen for the person');
  assert.equal(preselected(list, null), null);
});

test('each option names its tokens by symbol, and its fee tier as the rest of the app writes it', () => {
  assert.equal(tokenName(USDG), 'USDG');
  assert.equal(tokenName({ ...USDG, symbol: null }), '0xabab…abab', 'no symbol: the short address, never an empty name');
  assert.equal(tokenName({ ...USDG, symbol: '  ' }), '0xabab…abab');
  assert.deepEqual([3000, 500, 100, 50, 80000, 10000].map(feeText), ['0.30%', '0.05%', '0.01%', '0.005%', '8.00%', '1.00%']);
});

test('the mini range bar draws the range in the middle half and where the pool’s tick sits', () => {
  assert.deepEqual(rangeView({ tickLower: -600, tickUpper: 600, tick: 0 }), { lower: 0.25, upper: 0.75, current: 0.5, inRange: true });
  assert.deepEqual(rangeView({ tickLower: -600, tickUpper: 600, tick: 900 }), { lower: 0.25, upper: 0.75, current: 0.875, inRange: false });
  assert.deepEqual(rangeView({ tickLower: -600, tickUpper: 600, tick: 600 }).inRange, false, 'the upper tick is outside, as in the pool');
  assert.deepEqual(rangeView({ tickLower: -600, tickUpper: 600, tick: -100000 }).current, 0, 'far outside: at the edge');
  assert.deepEqual(rangeView({ tickLower: -600, tickUpper: 600, tick: null }), { lower: 0.25, upper: 0.75, current: null, inRange: null });
});

// Added 2026-09-24 (the three features joined up): Positions' rows offer Automate on the same test the picker lists by,
// so no row leads to a position the automation page leaves out; a sequence refuses a pool with hooks or a dynamic fee.
test('a position can be automated when it is open, in a pool with no hooks and a fixed fee', () => {
  assert.equal(automatable(position('7')), true);
  assert.equal(automatable(position('7', { status: 'closed' })), false);
  assert.equal(automatable(position('7', { hooks: '0x' + '4a'.repeat(20) })), false);
  assert.equal(automatable(position('7', { fee: 8388608 })), false);
  assert.equal(automatable(position('07')), false);
  const list = [position('7'), position('8', { hooks: '0x' + '4a'.repeat(20) }), position('9', { fee: 8388608 })];
  assert.deepEqual(pickerList({ phase: 'ready', block: 1, positions: list }), { kind: 'ready', positions: [list[0]] });
});
