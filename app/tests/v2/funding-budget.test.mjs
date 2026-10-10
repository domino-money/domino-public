import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const at = (path) => require(`../../.test-build/app/src/${path}.js`);
const { remoteFundingChoice, remotePayment } = at('v2in/funds/fundingBudget');
const { lackingTokens } = at('v2in/funds/model');
const { initialState } = at('lib/create/journey');
const { reviewPlan, reviewTerms, REVIEW_GAS_RESERVE_WEI: GAS } = at('lib/create/reviewPlan');
const { wholeFromOther } = at('lib/create/depositPlan');
const { heldRaw } = at('components/create/valuation');
const { sqrtPriceAtTick } = at('finance/position');
const { payFunding } = at('lib/create/payFunding');
const ZERO = '0x0000000000000000000000000000000000000000';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const E18 = 10n ** 18n;
const token = (address, symbol, decimals = 18) => ({ origin: 'read', chainId: 4663, address, symbol, decimals, readStatus: 'available', artwork: null });
const ETH = token(ZERO, 'ETH');
const STABLE = token(USDG, 'USDG', 6);
const WRAPPED = token(WETH, 'WETH');

function stateFor(currencies, side, budget, tick = 0) {
  const currency = currencies[side];
  return { ...initialState(), budget, range: { lower: tick - 600, upper: tick + 600 },
    token: { key: currency.address, token: currency, kind: 'erc20_candidate', decimalsUnavailable: false },
    pool: { key: `${currencies[0].address}/${currencies[1].address}`, currencies, sqrtPriceX96: sqrtPriceAtTick(tick).toString(), feePips: 500, liquidity: { state: 'unavailable' }, usdPrices: ['2', '2'] } };
}
const choice = (state, planned, extra = {}) => remoteFundingChoice({ state, planned, pay: null, alternative: null, nativeRaw: E18, ...extra });

test('remote budgets preserve a funded ETH swap from either pool side and either typed token', () => {
  for (const ethSide of [0, 1]) {
    const currencies = ethSide === 0 ? [ETH, STABLE] : [STABLE, ETH];
    const balances = ethSide === 0 ? [E18.toString(), '0'] : ['0', E18.toString()];
    for (const typedSide of [0, 1]) {
      const state = stateFor(currencies, typedSide, typedSide === ethSide ? '0.1' : '50', ethSide === 0 ? -199020 : 199020);
      const planned = reviewPlan(state, balances);
      assert.equal(planned.plan.kind, 'swap');
      assert.equal(planned.plan.from, ethSide);
      const found = choice(state, planned);
      assert.equal(found.budget.token, ZERO);
      assert.equal(found.budget.side, ethSide);
      assert.equal(found.budget.requiredRaw, planned.plan.deposit, 'bring the displayed input budget, not a fabricated shortage');
      assert.equal(found.payment, null, 'pair inputs keep their existing review path');
      assert.deepEqual(lackingTokens({ chainId: 4663, currencies, balances, plan: planned.plan, independent: typedSide }), [], 'real deficit remains empty');
      assert.equal(state.budget, typedSide === ethSide ? '0.1' : '50', 'typed amount remains unchanged');
    }
  }
});

test('covered two-token budgets and one-sided ranges use the existing pool terms without deducting local wealth', () => {
  const state = stateFor([ETH, STABLE], 0, '0.1', -199020);
  const balances = [E18.toString(), '1000000000000'];
  const planned = reviewPlan(state, balances);
  assert.equal(planned.plan.kind, 'both');
  const terms = reviewTerms(state);
  const required = wholeFromOther(terms, 1, planned.need[0], planned.need[1], terms.slippageBps);
  assert.equal(choice(state, planned).budget.requiredRaw, required);
  assert.ok(required > planned.need[0], 'the remote token covers both sides');
  const one = { ...planned, need: [E18 / 10n, 0n], plan: { kind: 'both', amount0: E18 / 10n, amount1: 0n } };
  assert.equal(choice(state, one).budget.requiredRaw, E18 / 10n, 'a single-sided position adds no unnecessary swap room');
});

test('WETH is a separate asset and editing the same funded input recalculates its remote budget', () => {
  const state = stateFor([WRAPPED, STABLE], 0, '0.1', -199020);
  const balances = [E18.toString(), '0'];
  const found = choice(state, reviewPlan(state, balances), { nativeRaw: 0n });
  assert.equal(found.budget.token, WETH);
  assert.equal(found.budget.requiredRaw, E18 / 10n, 'ERC20 gas is handled separately, never counted as WETH');
  const edited = { ...state, budget: '0.2' };
  assert.equal(choice(edited, reviewPlan(edited, balances)).budget.requiredRaw, E18 / 5n);
});

test('a funded non-bridgeable swap budgets the displayed holdings when the opposite token is brought', () => {
  for (const paidSide of [0, 1]) {
    const paid = token(A, 'PONS');
    const currencies = paidSide === 0 ? [paid, STABLE] : [STABLE, paid];
    const state = stateFor(currencies, paidSide, '10', paidSide === 0 ? -276324 : 276324);
    const balances = paidSide === 0 ? [(100n * E18).toString(), '0'] : ['0', (100n * E18).toString()];
    const planned = reviewPlan(state, balances);
    assert.equal(planned.plan.kind, 'swap');
    assert.equal(planned.plan.from, paidSide);
    const found = choice(state, planned);
    const holdings = heldRaw(planned);
    const terms = reviewTerms(state);
    const required = wholeFromOther(terms, paidSide, holdings[0], holdings[1], terms.slippageBps);
    const unswapped = wholeFromOther(terms, paidSide, planned.need[0], planned.need[1], terms.slippageBps);
    assert.equal(found.budget.token, USDG);
    assert.equal(found.budget.requiredRaw, required);
    assert.ok(found.budget.requiredRaw < unswapped * 3n / 4n, 'do not budget both hypothetical unswapped quantities');
    assert.equal(state.budget, '10');
  }
});

test('a real bridgeable shortfall keeps the deficit path, including after selecting another payment token', () => {
  const state = stateFor([ETH, STABLE], 0, '0.1', -199020);
  const planned = reviewPlan(state, ['0', '0']);
  assert.equal(planned.plan.kind, 'short');
  assert.equal(choice(state, planned), null, 'do not replace automatic deficit assistance with a full transfer');
  const paid = { ...state, payWith: { token: ETH, text: '0.2' } };
  const funds = { token: ETH, raw: E18, nativeRaw: E18, usd: '2000' };
  assert.equal(choice(paid, planned, { pay: funds }).budget.requiredRaw, E18 / 5n);
  assert.equal(choice(paid, planned, { pay: { ...funds, raw: E18 / 10n } }), null);
  assert.equal(choice(paid, planned, { pay: { ...funds, stale: true } }), null);
});

const generic = stateFor([token(A, 'A'), token(B, 'B')], 0, '10');
const genericPlan = { independent: 0, need: [10n * E18, 10n * E18], plan: { kind: 'short', token: 0, have: 0n, need: 10n * E18 }, noLiquidity: false };
const external = { token: ETH, raw: 0n, nativeRaw: 0n, usd: '2000', origins: [42161] };

test('generic pools keep an indicative payment input separate from a missing ETH gas reserve', () => {
  const found = choice(generic, genericPlan, { alternative: external, nativeRaw: 0n });
  assert.equal(found.budget.token, ZERO);
  assert.equal(found.budget.paymentRaw, E18 / 50n, '$40 at qualified $2000/ETH');
  assert.equal(found.budget.requiredRaw, E18 / 50n + GAS);
  assert.equal(found.payment.text, '0.02');
  assert.equal(found.payment.estimated, true, 'the local conversion still requires S1 Review');
  const partialGas = choice(generic, genericPlan, { alternative: external, nativeRaw: GAS / 2n });
  assert.equal(partialGas.budget.requiredRaw, E18 / 50n + GAS / 2n, 'only missing gas is added');
  const noPrice = { ...generic, pool: { ...generic.pool, usdPrices: undefined } };
  assert.equal(choice(noPrice, genericPlan, { alternative: external, nativeRaw: 0n }), null);
  assert.equal(choice(generic, genericPlan, { alternative: { ...external, usd: null }, nativeRaw: 0n }), null);
  assert.equal(choice(generic, genericPlan, { alternative: { ...external, stale: true }, nativeRaw: 0n }), null);
  assert.equal(choice(generic, genericPlan, { alternative: external, nativeRaw: null }), null, 'unknown gas is never zero');
  assert.equal(choice(generic, genericPlan, { alternative: { ...external, token: { ...ETH, chainId: 8453 } }, nativeRaw: 0n }), null);
});

test('a generic local swap budgets the displayed position, not both hypothetical unswapped amounts', () => {
  const planned = { ...genericPlan, plan: { kind: 'swap', from: 0, deposit: 10n * E18, swap: 5n * E18, receive: 5n * E18 } };
  assert.equal(choice(generic, planned, { alternative: external, nativeRaw: GAS }).budget.paymentRaw, E18 / 100n, '$20 of displayed holdings, not $40');
});

test('post-arrival continuation uses the reviewed frozen payment amount and still requires current balance checks', () => {
  const chosen = remotePayment(4663, [A, B], ZERO, (E18 / 50n).toString());
  assert.equal(chosen.text, '0.02');
  assert.equal(chosen.estimated, true);
  assert.equal(payFunding(chosen, { token: ETH, raw: E18 / 50n + GAS, nativeRaw: E18 / 50n + GAS, usd: null }).kind, 'ready');
  assert.equal(payFunding(chosen, { token: ETH, raw: E18 / 50n, nativeRaw: E18 / 50n, usd: null }).kind, 'short');
  assert.equal(remotePayment(4663, [ZERO, USDG], ZERO, '1'), null, 'this continuation is only for a third token');
  assert.equal(remotePayment(4663, [A, B], A, '1'), null, 'unsupported arbitrary bridge targets are not invented');
  for (const amount of ['0', '-1', '0.5', (1n << 128n).toString(), '9'.repeat(90)]) assert.equal(remotePayment(4663, [A, B], ZERO, amount), null);
});
