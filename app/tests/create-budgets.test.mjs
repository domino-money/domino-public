/**
 * Turning a wallet page into the position preview's budget fields
 * (src/lib/create/budgets.ts). A position holds both of a pool's currencies,
 * so both balances are what let the service report a shortfall; this proves
 * that only a balance read at a block and converted exactly becomes a budget,
 * and that everything else contributes no field at all.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const budgets = require('../.test-build/app/src/lib/create/budgets.js');
// The wallet page keys its rows the way the read layer keys every identity, chain and all.
const { identityKey } = require('../.test-build/app/src/lib/read/project.js');

const ZERO = '0x0000000000000000000000000000000000000000';
const addr = (letter) => `0x${letter.repeat(40)}`;
const display = (address, decimals = 18, symbol = 'T') => ({ origin: 'read', chainId: 4663, address, symbol, decimals, readStatus: 'available', artwork: null });
const fact = (text, state = 'value') => ({ label: 'Balance', text, state });

const pool = (currencies) => ({ key: `0x${'a'.repeat(64)}`, kind: 'catalogue', currencies, fee: '0.3%', feePips: 3000, tickSpacing: 60, tick: 0, sqrtPriceX96: '1', readAt: null, hooks: ZERO });
const snapshot = (rows, unavailable = []) => ({ failure: null, view: { rows, unavailable, freshness: [] } });
const row = (address, amount) => ({ key: identityKey(address), token: display(address), amount });
const gone = (address) => ({ key: identityKey(address), facts: [fact('—', 'unavailable')] });

test('a raw integer comes back only from a balance read at a block, through the same conversion the typed budget takes', () => {
  // Display units, thousands grouped exactly as the wallet page writes them.
  assert.equal(budgets.rawFromFact(fact('1,234.5'), 18), '1234500000000000000000');
  assert.equal(budgets.rawFromFact(fact('12.5'), 6), '12500000');
  // A wallet that holds none is a real budget of zero: the service cannot report a shortfall without it.
  assert.equal(budgets.rawFromFact(fact('0', 'zero'), 18), '0');
  // Everything else is not a budget, and says so by being absent.
  assert.equal(budgets.rawFromFact(fact('123', 'raw'), 18), null, 'raw units: the decimals were not read');
  assert.equal(budgets.rawFromFact(fact('—', 'unavailable'), 18), null);
  assert.equal(budgets.rawFromFact(fact('1.5'), null), null, 'no decimals, no conversion');
  assert.equal(budgets.rawFromFact(null, 18), null);
  // More places than the token can hold is not silently rounded.
  assert.equal(budgets.rawFromFact(fact('1.1234567'), 6), null);
});

test('both of a pool’s currencies are answered in pool order, whatever order the page listed them', () => {
  const currencies = [display(addr('1'), 18, 'ETH'), display(addr('2'), 6, 'USDG')];
  const page = snapshot([row(addr('2'), fact('40')), row(addr('1'), fact('0.5'))]);
  const pair = budgets.pairBalances(page, pool(currencies));
  assert.deepEqual(
    pair.map((balance) => [balance.token.symbol, balance.raw]),
    [
      ['ETH', '500000000000000000'],
      ['USDG', '40000000'],
    ],
  );
  assert.deepEqual(budgets.budgetFields(pair), { budget0Raw: '500000000000000000', budget1Raw: '40000000' });
});

test('a currency the page did not answer for, and a page that failed, add no field: the request stays what it was without budgets', () => {
  const currencies = [display(addr('1'), 18), display(addr('2'), 6)];
  // Only one currency on the page.
  const one = budgets.pairBalances(snapshot([row(addr('1'), fact('2'))]), pool(currencies));
  assert.equal(one[1].fact, null);
  assert.deepEqual(budgets.budgetFields(one), { budget0Raw: '2000000000000000000' });
  // A currency the page named as unavailable carries its reason, and still no budget.
  const missing = budgets.pairBalances(snapshot([row(addr('1'), fact('2'))], [gone(addr('2'))]), pool(currencies));
  assert.equal(missing[1].fact.state, 'unavailable');
  assert.equal(missing[1].raw, null);
  // A failed page answers for neither.
  const failed = budgets.pairBalances({ failure: { code: 'read_failed' }, view: { rows: [], unavailable: [], freshness: [] } }, pool(currencies));
  assert.deepEqual(failed.map((balance) => balance.fact), [null, null]);
  assert.deepEqual(budgets.budgetFields(failed), {}, 'nothing read, nothing sent');
});

test('native ETH in the pool also reports the native balance, and no gas reserve is ever assumed', () => {
  const currencies = [display(ZERO, 18, 'ETH'), display(addr('2'), 6, 'USDG')];
  const pair = budgets.pairBalances(snapshot([row(ZERO, fact('1.25')), row(addr('2'), fact('10'))]), pool(currencies));
  const fields = budgets.budgetFields(pair);
  assert.equal(fields.nativeBalanceRaw, '1250000000000000000');
  assert.equal(fields.budget0Raw, '1250000000000000000');
  assert.equal('nativeGasReserveRaw' in fields, false, 'a gas reserve is the person’s choice; Setup asks for it');
  // A pool of two ERC-20s reports no native balance at all.
  const erc20 = budgets.pairBalances(snapshot([row(addr('1'), fact('1'))]), pool([display(addr('1')), display(addr('2'))]));
  assert.equal('nativeBalanceRaw' in budgets.budgetFields(erc20), false);
});

test('the wallet read asks for exactly the pool’s two currencies, in pool order', () => {
  assert.deepEqual(budgets.pairTokens(pool([display(addr('1')), display(addr('2'))])), [addr('1'), addr('2')]);
});
