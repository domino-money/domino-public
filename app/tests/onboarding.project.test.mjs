/**
 * What a preview renders as (#38): every package fixture, plus derived
 * variants for the gaps the package leaves (FIX-1), each re-validated by the
 * pinned runtime before it is projected. Nulls are unknown, never zero; gross
 * is never shown as net; the swap's Domino tariff is never an amount.
 *
 * The derived variants live in support/onboarding-derived.mjs, which the fake
 * onboarding worker also serves to Chromium (tests/consumer.browser.test.mjs).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build, fixture, onboardingRuntime as runtime } from './support/consumer-fakes.mjs';
import { DERIVED_POSITIONS, DERIVED_SWAPS, FEE_RECIPIENT } from './support/onboarding-derived.mjs';

const { projectSwap, projectPosition } = build('onboarding/project');
const { consumerTestCatalog } = build('onboarding/catalog');

const SWAP_OWNER = '0x4444444444444444444444444444444444444444';
const NO_CATALOG = { label: 'none', tokens: [], pools: [] };

const swapBase = () => fixture('onboarding-v1', 'responses/swap-preview.json');
const shown = (rows) => Object.fromEntries(rows.map((row) => [row.id, row.value.kind === 'value' ? row.value.text : `UNKNOWN: ${row.value.reason}`]));
const unknownIds = (rows) => rows.filter((row) => row.value.kind === 'unknown').map((row) => row.id);

/** A derived swap preview, which must pass the pinned runtime before the test may use it. */
function derivedSwap(name) {
  const body = swapBase();
  DERIVED_SWAPS[name].mutate(body.preview, { owner: body.preview.request.owner });
  assert.ok(runtime.validateResponse('swap-preview', body), `derived swap fixture "${name}" must pass the runtime`);
  return body.preview;
}

function derivedPosition(name) {
  const { base, mutate } = DERIVED_POSITIONS[name];
  const body = fixture('onboarding-v1', base);
  mutate(body.preview);
  assert.ok(runtime.validateResponse('position-preview', body), `derived position fixture "${name}" must pass the runtime`);
  return body.preview;
}

test('there are ten derived onboarding fixtures, eight swaps and two positions, and every one passes the pinned runtime (FIX-1)', () => {
  assert.deepEqual([Object.keys(DERIVED_SWAPS).length, Object.keys(DERIVED_POSITIONS).length], [8, 2]);
  for (const name of Object.keys(DERIVED_SWAPS)) derivedSwap(name);
  for (const name of Object.keys(DERIVED_POSITIONS)) derivedPosition(name);
});

test('the happy swap shows its amounts, a zero fee with its evidence, gas as an estimate, and no Domino amount', () => {
  const view = projectSwap(swapBase().preview, consumerTestCatalog, SWAP_OWNER);
  const amounts = shown(view.amounts);
  assert.equal(amounts['dex-input'], '0.000000000000001 SYN-A');
  assert.equal(amounts['gross-output'], '0.000000000000002 SYN-B');
  assert.equal(amounts['net-output'], '0.000000000000002 SYN-B');
  assert.equal(amounts['price-impact'], '0.03%');
  assert.equal(shown(view.fee)['fee-status'], "Reported as zero, from the provider's legacy fee field");
  assert.equal(shown(view.other)['domino-fee'], 'Not selected (ceiling 0.65%)');
  assert.equal(shown(view.gas)['gas-fee'], '0.00001 ETH');
  assert.deepEqual([view.checks.label, view.checks.tone], ['Within observed limits', 'in']);
  assert.match(view.checks.note, /not a readiness check/);
  assert.equal(view.feeOutputs, null, 'itemised outputs not reported');
  assert.equal(view.paths.length, 1);
  assert.equal(view.paths[0].label, 'Path');
});

test('the unknown variant renders every null as unknown: no zero, no gross as net (T-9, T-13, NF-8)', () => {
  const view = projectSwap(fixture('onboarding-v1', 'variants/swap-preview.unknown.json').preview, consumerTestCatalog, SWAP_OWNER);
  assert.deepEqual(unknownIds(view.amounts), ['net-output', 'net-minimum', 'price-impact']);
  assert.match(shown(view.amounts)['net-output'], /UNKNOWN: Not available: the provider fee is unknown/);
  assert.deepEqual(unknownIds(view.gas), ['gas-fee', 'gas-units', 'gas-usd']);
  assert.ok(unknownIds(view.fee).includes('fee-status'));
  assert.equal(view.other.find((row) => row.id === 'simulation').value.kind, 'unknown');
  assert.deepEqual([view.checks.label, view.checks.tone], ['Blocked', 'out']);
  assert.equal(view.checks.reasons.length, 4);
  for (const row of [...view.amounts, ...view.gas, ...view.fee]) {
    if (row.value.kind === 'value') assert.doesNotMatch(row.value.text, /^0( |$)/, `${row.id} shows a zero`);
  }
});

test('derived: an unsupported non-zero fee with itemised outputs shows the rate, amount, recipient and "(you)" (OV-4)', () => {
  const preview = derivedSwap('unsupported_nonzero_fee');
  assert.equal(preview.request.owner, SWAP_OWNER);
  const view = projectSwap(preview, consumerTestCatalog, SWAP_OWNER);
  const fee = shown(view.fee);
  assert.equal(fee['fee-status'], 'Non-zero fee reported (0.25%), not supported');
  assert.equal(fee['fee-rate'], '0.25%');
  assert.equal(fee['fee-amount'], '0.000000000000000005 SYN-B');
  assert.equal(fee['fee-recipient'], FEE_RECIPIENT);
  assert.match(shown(view.amounts)['net-output'], /not supported/);
  assert.equal(view.feeOutputs.length, 2);
  assert.deepEqual(view.feeOutputs.map((row) => row.kind), ['Integrator fee', 'Not labelled']);
  assert.equal(view.feeOutputs[1].recipient, `${SWAP_OWNER} (you)`);
  assert.equal(view.feeOutputs[1].rate.kind, 'unknown');
});

test('derived: provider failure, impact exceeded, approval unknown, USD-only null (FIX-1)', () => {
  assert.match(shown(projectSwap(derivedSwap('provider_failure'), consumerTestCatalog, SWAP_OWNER).other).simulation, /SIMULATION_ERROR/);

  const impactView = projectSwap(derivedSwap('impact_exceeded'), consumerTestCatalog, SWAP_OWNER);
  assert.equal(shown(impactView.amounts)['price-impact'], '1.5%');
  assert.deepEqual(impactView.checks.reasons, ['Price impact is above your maximum.']);

  assert.equal(projectSwap(derivedSwap('approval_unknown'), consumerTestCatalog, SWAP_OWNER).other.find((row) => row.id === 'approval').value.kind, 'unknown');

  const usdView = projectSwap(derivedSwap('usd_null'), consumerTestCatalog, SWAP_OWNER);
  assert.deepEqual(unknownIds(usdView.gas), ['gas-usd']);
  assert.equal(usdView.checks.status, 'within_observed_limits', 'a null USD alone adds no reason');
});

test('derived: route decimals unknown show raw units, never guessed ones', () => {
  const view = projectSwap(derivedSwap('decimals_null'), NO_CATALOG, SWAP_OWNER);
  assert.equal(shown(view.amounts)['dex-input'], '1,000 raw units (decimals unknown)');
});

test('derived: a multi-hop path and a 2 x 1 multi-path route; no path is "the" route (OV-4)', () => {
  const hopView = projectSwap(derivedSwap('multi_hop'), consumerTestCatalog, SWAP_OWNER);
  assert.equal(hopView.paths[0].hops.length, 2);
  assert.match(hopView.paths[0].share, /0.000000000000001 SYN-A in → 0.000000000000002 SYN-B out/);

  const pathView = projectSwap(derivedSwap('multi_path'), consumerTestCatalog, SWAP_OWNER);
  assert.deepEqual(pathView.paths.map((path) => path.label), ['Path 1 of 2', 'Path 2 of 2']);
  assert.equal(pathView.paths[1].share, '0.0000000000000005 SYN-A in → 0.000000000000001 SYN-B out');
});

test('positions: within limits, incomplete, blocked and native render their states (T-8 to T-11)', () => {
  const within = projectPosition(fixture('onboarding-v1', 'responses/position-preview.json').preview, consumerTestCatalog);
  assert.deepEqual([within.checks.label, within.checks.tone], ['Within your selected limits', 'in']);
  assert.equal(within.tokens[0].expected.text, '0.0000000000000001 SYN-A');
  assert.equal(within.tokens[0].expected.note, 'Estimate');
  assert.equal(within.tokens[0].maximum.note, 'Inspected maximum');
  assert.equal(shown(within.native)['native-deposit'], '0 ETH', 'a real zero, not a missing value');
  assert.equal(within.other.find((row) => row.id === 'gas').value.reason, 'Gas estimate unavailable.');
  assert.equal(within.other.find((row) => row.id === 'domino-fee').value.text, 'No Domino fee on a direct deposit (0%)');
  assert.match(within.provider.find((row) => row.id === 'prepared-deadline').value.note, /Not how long this preview is valid/);
  assert.match(within.statement, /not verified/);

  const incomplete = projectPosition(fixture('onboarding-v1', 'variants/position-preview.incomplete.json').preview, consumerTestCatalog);
  assert.deepEqual([incomplete.checks.label, incomplete.checks.tone, incomplete.checks.reasons.length], ['Incomplete', 'wait', 4]);
  for (const token of incomplete.tokens) {
    assert.equal(token.budget.kind, 'unknown');
    assert.equal(token.unspent.kind, 'unknown');
  }
  assert.deepEqual(unknownIds(incomplete.native), ['native-balance', 'native-reserve']);

  const blocked = projectPosition(fixture('onboarding-v1', 'variants/position-preview.blocked.json').preview, consumerTestCatalog);
  assert.deepEqual([blocked.checks.label, blocked.checks.tone], ['Blocked', 'out']);
  assert.deepEqual(blocked.checks.reasons, ['The maximum debit of currency 1 exceeds your budget.']);
  assert.equal(blocked.tokens[1].budgetStatus, 'Maximum exceeds budget');
  assert.equal(blocked.tokens[1].budget.text, '0.000000000000000001 SYN-B');
  assert.equal(blocked.tokens[1].unspentAtMaximum.kind, 'unknown');

  const native = projectPosition(fixture('onboarding-v1', 'variants/position-preview.native.json').preview, consumerTestCatalog);
  assert.equal(shown(native.native)['native-deposit'], '0.000000000000000101 ETH');
  assert.equal(native.native.find((row) => row.id === 'native-balance').value.note, 'Not verified.');
  assert.match(native.tokens[0].token, /^ETH/);
});

test('derived positions: both native blocked reasons, and a provider gas estimate (FIX-1)', () => {
  const view = projectPosition(derivedPosition('native_blocked_twice'), consumerTestCatalog);
  assert.equal(view.checks.reasons.length, 2);
  const gasRow = projectPosition(derivedPosition('gas_reported'), consumerTestCatalog).other.find((row) => row.id === 'gas');
  assert.equal(gasRow.value.text, '0.000000000001 ETH');
  assert.match(gasRow.value.note, /not verified/);
});

// ---- the product's projections: New position's deposit amounts (G8) and Setup's swap quote (G15) ----

const { positionAmounts } = build('onboarding/amounts');
const { swapRequest, swapRows, SWAP_CHECK_WORDS } = build('onboarding/swap');
const cellText = (cell) => (cell.kind === 'amount' ? `${cell.text}${cell.units ? '' : ' raw'}` : `none: ${cell.why}`);

test('deposit amounts: each currency in pool order, exact units with the decimals the pool read returned, raw units without them, no budget is none, never zero (G8)', () => {
  const happy = fixture('onboarding-v1', 'responses/position-preview.json').preview;
  const amounts = positionAmounts(happy, [18, 6]);
  assert.deepEqual(amounts.expected.map(cellText), ['0.0000000000000001', '0.0002']);
  assert.deepEqual(amounts.maximum.map(cellText), ['0.000000000000000101', '0.000202']);
  assert.deepEqual(amounts.unspent.map(cellText), ['0.00000000000000001', '0.00002']);
  assert.equal(amounts.liquidity, '12,345');
  assert.equal(amounts.checks, 'within_selected_limits');
  // Decimals not read: the raw integer, labelled raw by the screen. Never guessed.
  assert.deepEqual(positionAmounts(happy, [null, 0]).expected.map(cellText), ['100 raw', '200']);
  // The request New position sends carries no budget, so unspent is none and the checks are incomplete.
  const incomplete = positionAmounts(fixture('onboarding-v1', 'variants/position-preview.incomplete.json').preview, [18, 18]);
  assert.deepEqual(incomplete.unspent.map(cellText), ['none: no_budget', 'none: no_budget']);
  assert.equal(incomplete.checks, 'incomplete');
});

test('swap quote: the typed gross less the published fee is the quoted input, validated as onboarding-v1 would, and the balancing amount is never derived (G15)', () => {
  const fields = { tokenIn: '0x1111111111111111111111111111111111111111', tokenOut: '0x2222222222222222222222222222222222222222', grossRaw: '10000', feeBps: 30, slippageBps: '50', maxImpactBps: '100' };
  const formed = swapRequest(fields);
  assert.equal(formed.ok, true);
  assert.deepEqual([formed.feeRaw, formed.netRaw], ['30', '9970'], 'floor(10000 x 30 / 10000) = 30, as the setup contract charges it');
  assert.deepEqual(formed.request, { chainId: 4663, tokenIn: fields.tokenIn, tokenOut: fields.tokenOut, amountRaw: '9970', slippageBps: 50, maxPriceImpactBps: 100 });
  assert.ok(runtime.validateRequest('swap-preview', formed.request), 'the request passes the pinned runtime');
  assert.equal(swapRequest({ ...fields, grossRaw: '33', feeBps: 65 }).request.amountRaw, '33', 'the fee rounds down: 33 x 65 / 10000 is 0');
  for (const [patch, problem] of [
    [{ tokenOut: fields.tokenIn }, 'tokens'],
    [{ tokenIn: 'USDG' }, 'tokens'],
    [{ grossRaw: '' }, 'amount'],
    [{ grossRaw: '0' }, 'amount'],
    [{ grossRaw: '1.5' }, 'amount'],
    [{ slippageBps: '1001' }, 'slippage'],
    [{ slippageBps: '-1' }, 'slippage'],
    [{ maxImpactBps: '10001' }, 'impact'],
    [{ feeBps: 66 }, 'fee'],
  ]) {
    assert.deepEqual(swapRequest({ ...fields, ...patch }), { ok: false, problem }, JSON.stringify(patch));
  }
});

test('swap quote rows: gross output and your slippage floor in smallest units, the provider fee, gas, simulation and checks, with unknowns as none (G15)', () => {
  const text = (rows) => Object.fromEntries(rows.map((row) => [row.id, row.cell.kind === 'value' ? row.cell.text : `none: ${row.cell.why}`]));
  assert.deepEqual(text(swapRows(swapBase().preview)), {
    input: '1,000',
    output: '2,000',
    minimum: '1,990',
    impact: '0.03%',
    'provider-fee': 'None reported',
    gas: '0.00001 ETH',
    simulation: 'No failure reported',
    checks: 'Within your limits',
  });
  assert.deepEqual(text(swapRows(fixture('onboarding-v1', 'variants/swap-preview.unknown.json').preview)), {
    input: '1,000',
    output: '2,000',
    minimum: '1,990',
    impact: 'none: price_impact_unknown',
    'provider-fee': 'none: provider_output_fee_unknown',
    gas: 'none: gas_estimate_incomplete',
    simulation: 'none: simulation_unknown',
    checks: [SWAP_CHECK_WORDS.price_impact_unknown, SWAP_CHECK_WORDS.provider_output_fee_unknown, SWAP_CHECK_WORDS.simulation_unknown, SWAP_CHECK_WORDS.gas_estimate_incomplete].join(' '),
  });
  for (const words of Object.values(SWAP_CHECK_WORDS)) assert.doesNotMatch(words, /beta|enabled|this build|preview only/i);
});
