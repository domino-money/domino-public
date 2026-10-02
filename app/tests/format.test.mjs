// Added 2026-09-24 (V2 foundation, DESIGN-V2 §6 and R-19): the pure number, USD, change, time and token-hue
// helpers in src/lib/format. Exact strings throughout: nothing here may round up an amount or invent a figure.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { shortAmount } = require('../.test-build/app/src/lib/format/amount.js');
const { priceFromSqrt } = require('../.test-build/app/src/lib/format/price.js');
const { formatUsd, usdgValue, quoteValue } = require('../.test-build/app/src/lib/format/usd.js');
const { compareDecimal, compareDisplayed, numericPart, percentChange } = require('../.test-build/app/src/lib/format/change.js');
const { shortDate, shortTime, bucketLabel, axisLabel } = require('../.test-build/app/src/lib/format/time.js');
const { tokenHue } = require('../.test-build/app/src/lib/format/tokenHue.js');

test('shortAmount keeps six significant digits, cuts toward zero, never cuts whole digits', () => {
  const cases = [
    ['9.004652116466694467', '9.00465'],
    ['0.000845776536917121', '0.000845776'],
    ['4.239016373224626171', '4.23901'],
    ['2,847.09', '2,847.09'],
    ['1,161,237', '1,161,237'],
    ['3,797,063,508', '3,797,063,508'],
    ['3,797,063,508.123', '3,797,063,508'],
    ['≈4.239016373224626171', '≈4.23901'],
    ['12,345.678', '12,345.6'],
    ['0.999999999', '0.999999'],
  ];
  for (const [text, short] of cases) {
    const amount = shortAmount(text);
    assert.equal(amount.short, short, text);
    assert.equal(amount.head + amount.tail, text, `${text}: head + tail is the full text`);
    assert.equal(amount.full, text);
    assert.equal(amount.cut, short !== text, text);
  }
  assert.deepEqual(shortAmount('1.20000123'), { short: '1.2', head: '1.20000', tail: '123', full: '1.20000123', cut: true });
  assert.deepEqual(shortAmount('—'), { short: '—', head: '—', tail: '', full: '—', cut: false }, 'not a number: as it came');
  assert.equal(shortAmount('-0.123456789').short, '-0.123456', 'the sign stays and nothing rounds up');
});

test('priceFromSqrt is exact fixed point: currency1 per currency0 in whole tokens, 18 fraction digits', () => {
  const Q96 = 1n << 96n;
  assert.equal(priceFromSqrt(Q96, 18, 18), '1.000000000000000000');
  assert.equal(priceFromSqrt(Q96 * 2n, 6, 6), '4.000000000000000000');
  assert.equal(priceFromSqrt(Q96, 18, 6), '1000000000000.000000000000000000', 'raw 1:1 with 18 and 6 decimals');
  assert.equal(priceFromSqrt(Q96, 6, 18), '0.000000000001000000', 'and the other way round');
  assert.equal(priceFromSqrt(Q96 * 3n / 2n, 18, 18), '2.250000000000000000');
  assert.throws(() => priceFromSqrt(0n, 18, 18), RangeError);
});

test('usdgValue and quoteValue add the other amount at the pool price, exactly', () => {
  const Q96 = 1n << 96n;
  // Price 9 (currency1 per currency0), both 6 decimals.
  const at9 = { decimals: [6, 6], sqrtPriceX96: Q96 * 3n };
  assert.equal(usdgValue({ ...at9, amounts: [2_000_000n, 5_000_000n], usdgIndex: 1 }), '23.000000000000000000', '2 × 9 + 5');
  assert.equal(usdgValue({ ...at9, amounts: [9_000_000n, 9_000_000n], usdgIndex: 0 }), '10.000000000000000000', '9 + 9 ÷ 9');
  assert.equal(quoteValue({ ...at9, amounts: [1_000_000n, 0n], quoteIndex: 1 }), '9.000000000000000000');
  assert.equal(usdgValue({ ...at9, amounts: [0n, 0n], usdgIndex: 1 }), '0.000000000000000000');
});

test('formatUsd: cents from $1, four significant digits below, $0.00 for zero, half away from zero', () => {
  const cases = [
    ['1234.567', '$1,234.57'],
    ['1000000', '$1,000,000.00'],
    ['2.005', '$2.01'],
    ['1', '$1.00'],
    ['0', '$0.00'],
    ['0.000000000000000000', '$0.00'],
    ['0.0042134', '$0.004213'],
    ['0.5', '$0.50'],
    ['0.12345', '$0.1235'],
    ['0.999996', '$1.00'],
    ['-12.345', '-$12.35'],
    ['23.000000000000000000', '$23.00'],
  ];
  for (const [value, text] of cases) assert.equal(formatUsd(value), text, value);
  assert.equal(formatUsd('n/a'), 'n/a', 'never an invented figure');
});

test('change helpers compare and move figures as the page shows them', () => {
  assert.equal(numericPart('$1,234.56'), '1234.56');
  assert.equal(numericPart('≈0.617502 USDG per PONS'), '0.617502');
  assert.equal(numericPart('−1.23%'), '-1.23');
  assert.equal(numericPart('+1.23%'), '1.23');
  assert.equal(numericPart('—'), null);
  assert.equal(compareDecimal('1.10', '1.1'), 0);
  assert.equal(compareDecimal('-2', '1'), -1);
  assert.equal(compareDecimal(null, '1'), 0);
  assert.equal(compareDisplayed('$1,234.56', '$999.99'), 1);
  assert.equal(compareDisplayed('0.617502', '0.617524'), -1);
  assert.deepEqual(percentChange('0.617524', '0.625'), { sign: 1, text: '1.21%' });
  assert.deepEqual(percentChange('2', '1'), { sign: -1, text: '50.00%' });
  assert.deepEqual(percentChange('1', '1.00001'), { sign: 0, text: '0.00%' }, 'a change that rounds to zero is zero');
  assert.deepEqual(percentChange('1,000', '1,500'), { sign: 1, text: '50.00%' });
  assert.equal(percentChange('0', '1'), null);
  assert.equal(percentChange('x', '1'), null);
});

test('time captions use the existing MM-DD HH:MM UTC style, no month words', () => {
  const at = Date.UTC(2026, 8, 24, 13, 0, 0) / 1000;
  assert.equal(shortDate(at), '09-24');
  assert.equal(shortTime(at), '13:00 UTC');
  assert.equal(bucketLabel(at - 7 * 3600, at - 3600), '09-24 06:00–12:00 UTC');
  assert.equal(bucketLabel(at - 13 * 3600, at + 11 * 3600), '09-24');
  assert.equal(bucketLabel(at - 13 * 3600, at + 11 * 3600 + 6 * 86400), '09-24 – 09-30');
  assert.equal(bucketLabel(at + 5 * 3600, at + 11 * 3600 + 6 * 3600), '09-24 18:00 – 09-25 06:00 UTC');
  assert.equal(bucketLabel(at + 10 * 3600, at + 11 * 3600), '09-24 23:00–00:00 UTC', 'an hour ending at midnight is still that day');
  assert.equal(axisLabel(at, 86400), '13:00');
  assert.equal(axisLabel(at, 7 * 86400), '09-24');
});

test('tokenHue: the first two bytes of the lower-cased address, modulo 360; 0 for anything else', () => {
  assert.equal(tokenHue(`0x5fc5${'0'.repeat(36)}`), 0x5fc5 % 360);
  assert.equal(tokenHue(`0xABCD${'0'.repeat(36)}`), 0xabcd % 360);
  assert.equal(tokenHue('ETH'), 0);
  assert.equal(tokenHue('0x12'), 0);
});

// ---------------------------------------------------------------------------
// 2026-10-01 (the copy workstream): one format for a fee tier and for an APR on every screen (audit E21), the edges of
// a rate rounded first (audit E8), a position screen's dust in dollars (audit E7), and a network by its name (audit E6).
// ---------------------------------------------------------------------------
const { feeWords, feeChipText, FEE_VENUE_PREFIX } = require('../.test-build/app/src/lib/format/fee.js');
const { aprDigits, aprDigitsOf, APR_SLIVER } = require('../.test-build/app/src/lib/format/apr.js');
const { formatUsdFloor } = require('../.test-build/app/src/lib/format/usd.js');
const { networkName } = require('../.test-build/app/src/lib/networkName.js');

test('a fee tier reads one way everywhere: "0.30% fee", "Dynamic fee", and "Uniswap · " before it where the exchange is named', () => {
  assert.equal(feeWords('0.30%'), '0.30% fee');
  assert.equal(feeWords('0.005%'), '0.005% fee');
  for (const dynamic of ['Dynamic', 'Dynamic fee', 'dynamic']) assert.equal(feeWords(dynamic), 'Dynamic fee', dynamic);
  assert.equal(feeWords('Unknown fee'), 'Unknown fee', 'never "fee fee"');
  assert.equal(feeChipText('1.00%'), 'Uniswap · 1.00% fee');
  assert.equal(FEE_VENUE_PREFIX, 'Uniswap · ');
});

test('an APR reads by one rule everywhere: one decimal under 100%, whole percents from there, rounded before it is sized', () => {
  const cases = [['27.18', '27.2'], ['10.95', '11.0'], ['99.94', '99.9'], ['99.95', '100'], ['99.96', '100'], ['181.25', '181'], ['1428.4', '1,428'], ['0', '0.0'], ['0.05', APR_SLIVER], ['0.000000000000000001', APR_SLIVER], ['0.06', '0.1']];
  for (const [value, text] of cases) assert.equal(aprDigits(value), text, value);
  assert.equal(aprDigits('not a number'), null);
  const numbers = [[27.18, '27.2'], [99.96, '100'], [181.25, '181'], [1428.4, '1,428'], [0, '0.0'], [0.05, APR_SLIVER], [0.04, APR_SLIVER], [0.06, '0.1']];
  for (const [value, text] of numbers) assert.equal(aprDigitsOf(value), text, String(value));
  assert.equal(APR_SLIVER, '<0.1');
});

test('a position screen’s dollars: under a cent reads "<$0.01", never "$0.000005"; zero and the rest as formatUsd writes them', () => {
  assert.equal(formatUsdFloor('0.000005'), '<$0.01');
  assert.equal(formatUsdFloor('0.009999'), '<$0.01');
  assert.equal(formatUsdFloor('0.01'), '$0.01');
  assert.equal(formatUsdFloor('0.0100'), '$0.01');
  assert.equal(formatUsdFloor('0'), '$0.00');
  assert.equal(formatUsdFloor('0.000000000000000000'), '$0.00');
  assert.equal(formatUsdFloor('1234.5'), '$1,234.50');
  assert.equal(formatUsdFloor('-0.000005'), formatUsd('-0.000005'), 'a negative figure is not floored');
  assert.equal(formatUsdFloor('n/a'), 'n/a', 'what is not a figure comes back as it came');
});

test('a wallet’s network by its name, and any other as "another network", never its number', () => {
  assert.deepEqual([1, 8453, 42161, 10, 4663].map(networkName), ['Ethereum', 'Base', 'Arbitrum', 'OP Mainnet', 'Robinhood Chain']);
  for (const other of [999_999, null, undefined, Number.NaN]) assert.equal(networkName(other), 'another network', String(other));
});
