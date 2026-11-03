/**
 * Added 2026-11-02 (review of the money PRs, M4: "1,250" was read as 1250, a thousand times the 1.25 that someone who
 * writes a decimal comma meant; the launch audience is Brazilian). Every figure typed for a transaction is read by one rule
 * (src/lib/create/typedFigure.ts): the dot is always the decimal point; en-US grouping (two or more groups, or groups
 * before a dot) loses its commas; one group and no dot ("1,250") is refused in every language, saying both readings; any
 * other single comma is a decimal comma where the person's language writes one, and refused elsewhere.
 *
 * Each input that reaches a transaction is checked through its own function, with the language's separator handed in, so
 * every test below fails on main b374421a (which read "1,250" as 1250, "0,125" as 125 on the zap and position paths, and
 * dropped every comma of a starting price or a custom range price).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const at = (path) => require(`../../.test-build/app/src/${path}.js`);
const figure = at('lib/create/typedFigure');
const { amountText } = at('lib/create/amountText');
const { validateBudget } = at('lib/create/journey');
const { CREATE } = at('lib/create/copy');
const { payFunding } = at('lib/create/payFunding');
const { parseUnitsText } = at('v2/plan/present');
const { parsePriceText } = at('v2/plan/initialPrice');
const { amountRawOf } = at('v2in/funds/model');
const { remotePayment } = at('v2in/funds/fundingBudget');
const forms = at('v2in/position/forms');
const { tokenBook } = at('v2in/position/tokens');
const journey = at('v2in/journey/model/state');
const { JOURNEY } = at('v2in/journey/copy');
const { rawFromText } = at('v2in/automate/tokens');
const { typedPriceToTick } = at('lib/create/typedPrice');
const { priceInputToTick } = at('lib/read/screens/RangePriceInput');

const ZERO = '0x0000000000000000000000000000000000000000';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const E18 = 10n ** 18n;
const AMBIGUOUS = '1,250 could mean 1.25 or 1250. Type 1.25 or 1250.';
const DOT = 'Use a dot for decimals, like 0.5.';
const SEPARATOR = 'Type the number without a thousands separator, like 1250,5.';

test('the rule: a dot is the decimal point, en-US grouping is grouping, one group is ambiguous, any other comma is a decimal comma only where the language writes one', () => {
  const read = (text, decimal) => figure.readFigure(text, decimal);
  for (const decimal of ['.', ',']) {
    assert.deepEqual(read(' 1250.5 ', decimal), { ok: true, text: '1250.5' }, `${decimal}: a plain figure, trimmed`);
    assert.deepEqual(read('1,250.5', decimal), { ok: true, text: '1250.5' }, `${decimal}: the page's own grouping`);
    assert.deepEqual(read('1,250,000', decimal), { ok: true, text: '1250000' }, `${decimal}: two groups are grouping`);
    assert.deepEqual(read('1,250,000.75', decimal), { ok: true, text: '1250000.75' });
    assert.deepEqual(read('-1,5', decimal), { ok: false, problem: 'negative' });
    for (const [typed, asDecimal, asWhole] of [['1,250', '1.25', '1250'], ['12,500', '12.5', '12500'], ['100,000', '100', '100000'], ['1,000', '1', '1000'], ['999,001', '999.001', '999001']]) {
      assert.deepEqual(read(typed, decimal), { ok: false, problem: 'ambiguous', typed, asDecimal, asWhole }, `${decimal}: ${typed} is never guessed`);
    }
  }
  // A decimal comma: read where the language writes one, refused where it writes a dot.
  for (const [typed, text] of [['1,5', '1.5'], ['0,125', '0.125'], ['12,34', '12.34'], ['1,2345', '1.2345'], ['1250,5', '1250.5'], [',5', '.5']]) {
    assert.deepEqual(read(typed, ','), { ok: true, text }, `, : ${typed}`);
    assert.deepEqual(read(typed, '.'), { ok: false, problem: 'comma', decimal: '.' }, `. : ${typed}`);
  }
  // "0,125" was en-US grouping by the old pattern (a first group of "0"), so 125 on the zap and position paths.
  assert.deepEqual(read('0,125', '.'), { ok: false, problem: 'comma', decimal: '.' });
  for (const typed of ['1.250,5', '1,2,3', '12,50,0', '1,,5', '1,5,', ',', '1,250.5,1']) {
    for (const decimal of ['.', ',']) assert.deepEqual(read(typed, decimal), { ok: false, problem: 'comma', decimal }, `${decimal}: ${typed}`);
  }
  assert.equal(figure.figureHint('1,250', '.'), AMBIGUOUS);
  assert.equal(figure.figureHint('1,250', ','), AMBIGUOUS);
  assert.equal(figure.figureHint('1,5', '.'), DOT);
  assert.equal(figure.figureHint('1.250,5', ','), SEPARATOR);
  assert.equal(figure.figureHint('1,5', ','), null);
  assert.equal(figure.figureHint('-1', '.'), null, 'a minus is each field\'s zero rule');
  assert.equal(CREATE.amount.decimalComma, DOT, 'the same words as before for a comma in a dot language');
});

test('the person\'s language: a comma for pt-BR, de, fr and es, a dot for en; the site\'s dot outside a browser', () => {
  for (const locale of ['pt-BR', 'de-DE', 'fr-FR', 'es-ES', ['pt-BR', 'en-US']]) assert.equal(figure.decimalOf(locale), ',', String(locale));
  for (const locale of ['en-US', 'en-GB', ['en-US', 'pt-BR'], 'not a language tag!']) assert.equal(figure.decimalOf(locale), '.', String(locale));
  assert.equal(figure.personDecimal(), '.', 'node has no page: the site\'s own way');
});

test('New position and Pay with (validateBudget, amountText): "1,250" is refused in every language, "1,5" is 1.5 only where a comma is the decimal', () => {
  for (const decimal of ['.', ',']) {
    assert.deepEqual(validateBudget('1,250', 6, decimal), { ok: false, reason: AMBIGUOUS }, `${decimal}: never 1250`);
    assert.deepEqual(amountText('1,250', decimal), { ok: false, reason: AMBIGUOUS });
    assert.deepEqual(validateBudget('1,250.5', 6, decimal), { ok: true, raw: '1250500000' });
    assert.deepEqual(validateBudget('1,250,000', 6, decimal), { ok: true, raw: '1250000000000' });
    assert.deepEqual(validateBudget('-1,5', 6, decimal), { ok: false, reason: CREATE.amount.zero });
  }
  assert.deepEqual(validateBudget('1,5', 6, ','), { ok: true, raw: '1500000' });
  assert.deepEqual(validateBudget('0,125', 6, ','), { ok: true, raw: '125000' });
  assert.deepEqual(validateBudget('1,5', 6, '.'), { ok: false, reason: DOT });
  assert.deepEqual(validateBudget('0,125', 6, '.'), { ok: false, reason: DOT });
  assert.deepEqual(validateBudget('1.250,5', 6, ','), { ok: false, reason: SEPARATOR });
  assert.deepEqual(validateBudget('1,0000001', 6, ','), { ok: false, reason: CREATE.amount.tooManyPlaces(6) }, 'a decimal comma meets the token\'s own decimals');
  // Pay with another token: the same reading (src/v2in/funds/model.ts amountRawOf, and payFunding through validateBudget).
  for (const decimal of ['.', ',']) assert.equal(amountRawOf('1,250', 6, decimal), null, `${decimal}: never 1250`);
  assert.equal(amountRawOf('1,5', 6, ','), '1500000');
  assert.equal(amountRawOf('1,5', 6, '.'), null);
  assert.equal(amountRawOf('1,250.5', 6), '1250500000');
});

test('a funding amount Domino writes is plain, and reads back to the same raw amount (remotePayment)', () => {
  const ETH = { origin: 'read', chainId: 4663, address: ZERO, symbol: 'ETH', decimals: 18, readStatus: 'available', artwork: null };
  for (const [raw, text] of [[1250n * E18, '1250'], [12505n * E18 / 10n, '1250.5'], [1_250_000n * E18, '1250000'], [E18 / 50n, '0.02']]) {
    const chosen = remotePayment(4663, [A, B], ZERO, raw.toString());
    assert.equal(chosen.text, text, 'no thousands separator: a grouped "1,250" would be refused as ambiguous');
    for (const decimal of ['.', ',']) {
      assert.deepEqual(validateBudget(chosen.text, 18, decimal), { ok: true, raw: raw.toString() });
      assert.equal(amountRawOf(chosen.text, 18, decimal), raw.toString());
    }
    assert.equal(payFunding(chosen, { token: ETH, raw: raw + E18, nativeRaw: raw + E18, usd: null }).kind, 'ready');
  }
});

test('the zap journey, a position\'s Add liquidity and the S2 offer (parseUnitsText): "0,125" and "1,250" are no longer 125 and 1250', () => {
  for (const decimal of ['.', ',']) {
    assert.equal(parseUnitsText('1,250', 6, decimal), null, `${decimal}: never 1250`);
    assert.equal(parseUnitsText('1,250', null, decimal), null, `${decimal}: raw units either`);
    assert.equal(parseUnitsText('1,250.5', 6, decimal), 1_250_500_000n);
    assert.equal(parseUnitsText('1,250,000', null, decimal), 1_250_000n);
  }
  assert.equal(parseUnitsText('0,125', 6, '.'), null, 'was 125, a thousand times 0.125');
  assert.equal(parseUnitsText('0,125', 6, ','), 125_000n);
  assert.equal(parseUnitsText('1,5', 6, ','), 1_500_000n);
  assert.equal(parseUnitsText('1,5', null, ','), null, 'raw units are whole');
  // The zap journey's amount step says what the comma needs (src/v2in/journey/model/state.ts amountProblem).
  const state = { chainId: 8453, pool: { pool: { currency0: ZERO, currency1: USDC }, tokens: [{ address: ZERO, symbol: 'ETH', decimals: 18 }, { address: USDC, symbol: 'USDC', decimals: 6 }] } };
  assert.equal(journey.amountProblem(state, USDC, '1,250', ','), AMBIGUOUS);
  assert.equal(journey.amountProblem(state, USDC, '1,5', '.'), DOT);
  assert.equal(journey.amountProblem(state, USDC, '1,5', ','), null);
  assert.equal(journey.amountProblem(state, USDC, 'abc', ','), JOURNEY.amount.invalid);
  // A position's Add liquidity (src/v2in/position/forms.ts inputsOf), and the hint under its fields.
  const pool = { dex: 4, currency0: A, currency1: B, fee: 3000, tickSpacing: 60, hooks: ZERO };
  const book = tokenBook(8453, [{ address: A, symbol: 'AAA', decimals: 18 }, { address: B, symbol: 'BBB', decimals: 18 }]);
  const typed = (text) => ({ mode: 'one', token: B, text: { [B]: text } });
  for (const decimal of ['.', ',']) {
    assert.equal(forms.inputsOf(typed('1,250'), pool, book, decimal), null, `${decimal}: never 1250`);
    assert.equal(forms.amountsHint(typed('1,250'), pool, decimal), AMBIGUOUS);
  }
  assert.deepEqual(forms.inputsOf(typed('1,5'), pool, book, ','), [{ token: B, amount: 15n * E18 / 10n }]);
  assert.equal(forms.inputsOf(typed('1,5'), pool, book, '.'), null);
  assert.equal(forms.amountsHint(typed('1,5'), pool, '.'), DOT);
  assert.equal(forms.amountsHint(typed('1,5'), pool, ','), null);
});

test('prices that reach a mint: a new pool\'s starting price and a position\'s custom range kept no comma rule at all', () => {
  // A new pool's starting price (src/v2/plan/initialPrice.ts parsePriceText): every comma was dropped ("1,5" set 15).
  assert.equal(parsePriceText('1,5', '.'), null);
  assert.deepEqual(parsePriceText('1,5', ','), { num: 15n, den: 10n, text: '1.5' });
  assert.equal(parsePriceText('0,5', '.'), null, 'was 5');
  for (const decimal of ['.', ',']) assert.equal(parsePriceText('1,250', decimal), null, `${decimal}: never 1250`);
  assert.deepEqual(parsePriceText('2,500.5'), { num: 25005n, den: 10n, text: '2500.5' });
  // A position's Change range, custom prices (src/v2in/position/forms.ts ticksOf): every comma was dropped there too.
  const pool = { dex: 4, currency0: A, currency1: B, fee: 3000, tickSpacing: 60, hooks: ZERO };
  const book = tokenBook(8453, [{ address: A, symbol: 'AAA', decimals: 18 }, { address: B, symbol: 'BBB', decimals: 18 }]);
  const custom = (lower, upper) => ({ preset: 'custom', lower, upper });
  const wanted = forms.ticksOf(custom('1.5', '20'), pool, 0, book);
  assert.ok(wanted, 'a range from 1.5 to 20');
  assert.equal(forms.ticksOf(custom('1,5', '20'), pool, 0, book, '.'), null, 'was the range from 15 to 20');
  assert.deepEqual(forms.ticksOf(custom('1,5', '20'), pool, 0, book, ','), wanted);
  for (const decimal of ['.', ',']) {
    assert.equal(forms.ticksOf(custom('1,250', '2000'), pool, 0, book, decimal), null, `${decimal}: never 1250`);
    assert.equal(forms.rangeHint(custom('1,250', '2000'), decimal), AMBIGUOUS);
  }
  assert.deepEqual(forms.ticksOf(custom('1,250.5', '2,000.5'), pool, 0, book), forms.ticksOf(custom('1250.5', '2000.5'), pool, 0, book), 'the page\'s own grouping');
  assert.equal(forms.rangeHint({ preset: 'medium', lower: '1,250', upper: '' }, '.'), null, 'a preset types nothing');
});

test('the range steps (typedPriceToTick): New position and the zap journey read a typed price by the same rule', () => {
  const range = { lower: -600, upper: 600 };
  const price = { state: 'usable', tick: 0, tickSpacing: 60, decimals: [18, 18] };
  for (const decimal of ['.', ',']) {
    assert.deepEqual(typedPriceToTick('1,250', 'upper', { lower: -600, upper: 99_960 }, price, decimal), { ok: false, message: AMBIGUOUS }, `${decimal}: never 1250`);
    assert.deepEqual(typedPriceToTick(' 1,000.5 ', 'upper', { lower: -600, upper: 99_960 }, price, decimal), priceInputToTick('1000.5', 'upper', { lower: -600, upper: 99_960 }, price), 'the page\'s own grouping, trimmed');
    assert.deepEqual(typedPriceToTick('-1', 'lower', range, price, decimal), { ok: false, message: 'Price must be greater than zero.' });
  }
  assert.deepEqual(typedPriceToTick('1,001', 'upper', range, price, ','), { ok: false, message: '1,001 could mean 1.001 or 1001. Type 1.001 or 1001.' });
  assert.deepEqual(typedPriceToTick('0,999', 'lower', range, price, ','), priceInputToTick('0.999', 'lower', range, price), 'a decimal comma where the language writes one');
  assert.deepEqual(typedPriceToTick('0,999', 'lower', range, price, '.'), { ok: false, message: DOT });
  // Both range steps go through it, and neither drops a comma itself (they stripped any one-group figure's). The pool
  // page's range controls create nothing and keep priceInputToTick's own rule: no comma at all.
  for (const file of ['components/create/RangeStep.tsx', 'v2in/journey/RangeStage.tsx']) {
    const source = readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8');
    assert.equal((source.match(/typedPriceToTick\(value, which, range, price\)/g) ?? []).length, 2, file);
    assert.doesNotMatch(source, /priceInputToTick\(|replace\(\/,\/g/, file);
  }
});

test('a vault\'s recovery amount (rawFromText) refused every comma: it takes the same reading now', () => {
  assert.equal(rawFromText('1,5', 6, ','), 1_500_000n);
  assert.equal(rawFromText('1,5', 6, '.'), null);
  for (const decimal of ['.', ',']) {
    assert.equal(rawFromText('1,250', 6, decimal), null, `${decimal}: never 1250`);
    assert.equal(rawFromText('1,250.5', 6, decimal), 1_250_500_000n);
  }
});

test('the zap journey\'s amounts are grouped on screen only, never in the amount it reads (AmountStage)', () => {
  // A "1250" left as "1,250" was written back into the amount, and "1,250" is refused now as ambiguous.
  const stage = readFileSync(new URL('../../src/v2in/journey/AmountStage.tsx', import.meta.url), 'utf8');
  assert.match(stage, /value=\{editing === token \|\| decimals === null \? text : groupedAmount\(text\)\}/);
  assert.doesNotMatch(stage, /groupedOnLeave|set\(token, shown\)/);
  assert.doesNotMatch(stage, /onBlur=\{[^}]*set\(/);
});
