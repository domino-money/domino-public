import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { previewPosition } from '../.test-build/position.js';
import {
  previewCompound,
  moneyUnits,
  pendingFeesExplanation,
} from '../.test-build/compound.js';
import {
  emptyBook,
  parseBook,
  addPracticePosition,
  runPracticeCompound,
  practiceFunding,
} from '../.test-build/practice.js';
const cases = JSON.parse(
  readFileSync(
    new URL('./fixtures/compound-cases.json', import.meta.url),
    'utf8',
  ),
);
for (const c of cases)
  test(c.name, () => {
    const result = previewCompound(c.input);
    for (const [k, v] of Object.entries(c.expected)) assert.equal(result[k], v);
  });
test('price scenarios conserve start and reach correct boundary assets', () => {
  const input = {
    amount: 1000,
    lower: 0.7,
    upper: 1.5,
    startingPrice: 1,
    scenarioPrice: 1,
  };
  assert.ok(Math.abs(previewPosition(input).value - 1000) < 1e-9);
  assert.equal(previewPosition({ ...input, scenarioPrice: 2 }).token, 0);
  assert.equal(previewPosition({ ...input, scenarioPrice: 0.5 }).stable, 0);
  assert.equal(
    previewPosition({ ...input, scenarioPrice: 0.7 }).status,
    'inside',
  );
  assert.equal(
    previewPosition({ ...input, scenarioPrice: 1.5 }).status,
    'above',
  );
  for (const scenarioPrice of [0.5, 0.8, 1, 1.2, 1.6, 2]) {
    const r = previewPosition({ ...input, scenarioPrice });
    assert.ok(r.value <= r.holdValue + 1e-8);
  }
  assert.throws(() => previewPosition({ ...input, lower: 1 }));
  assert.throws(() => previewPosition({ ...input, amount: NaN }));
});
test('reject coercion, negative amounts and overly precise or large decimals', () => {
  for (const x of [
    1,
    NaN,
    null,
    {},
    '-1',
    '1e3',
    ' 1',
    '1.1234567',
    '1000000000',
  ])
    assert.throws(() => moneyUnits(x));
});
function makePosition(id) {
  return {
    id,
    createdAt: '2026-09-09T03:00:00Z',
    amount: 1000,
    lower: 0.7,
    upper: 1.5,
    enabled: true,
    reservesUsd: '0.000000',
    feesAddedUsd: '0.000000',
    netAddedUsd: '0.000000',
    servicePaidUsd: '0.000000',
  };
}
const id = 'practice-00000000-0000-4000-8000-000000000001',
  other = 'practice-00000000-0000-4000-8000-000000000002';
test('use all balanced fees once without a fixed percentage reserve', () => {
  let b = addPracticePosition(emptyBook(), makePosition(id), 'create');
  b = runPracticeCompound(
    b,
    id,
    '200',
    '0.25',
    'first',
    '2026-09-09T03:01:00Z',
  );
  assert.equal(b.positions[0].reservesUsd, '0.000000');
  assert.equal(b.positions[0].netAddedUsd, '196.000000');
  b = runPracticeCompound(b, id, '0', '0.25', 'second', '2026-09-09T03:02:00Z');
  const p = b.positions[0];
  assert.equal(p.reservesUsd, '0.000000');
  assert.equal(
    moneyUnits(p.netAddedUsd) + moneyUnits(p.servicePaidUsd),
    moneyUnits('200'),
  );
  assert.ok(moneyUnits(p.servicePaidUsd) <= moneyUnits('4'));
  assert.equal(b.events[0].decision.reason, 'no_fees');
  assert.deepEqual(parseBook(JSON.parse(JSON.stringify(b))), b);
});
test('historical receipts stay intact while waiting fees use the new policy', () => {
  const legacy = {
    mode: 'simulation',
    decision: 'eligible',
    reason: 'ready',
    availableFeesUsd: '200.000000',
    consumedFeesUsd: '153.061224',
    serviceFeeUsd: '3.061224',
    reinvestedUsd: '150.000000',
    reserveUsd: '46.938776',
    gasUsd: '0.250000',
    operatorMarginUsd: '2.811224',
    minimumFeesUsd: '14.375000',
    maxNetAdditionUsd: '150.000000',
  };
  let b = parseBook({
    version: 1,
    positions: [
      {
        ...makePosition(id),
        reservesUsd: legacy.reserveUsd,
        feesAddedUsd: '200.000000',
        netAddedUsd: legacy.reinvestedUsd,
        servicePaidUsd: legacy.serviceFeeUsd,
      },
    ],
    events: [
      {
        id: 'legacy',
        positionId: id,
        at: '2026-09-09T03:01:00Z',
        kind: 'compound',
        decision: legacy,
      },
    ],
  });
  assert.match(pendingFeesExplanation(b.events[0].decision), /Historical/);
  b = runPracticeCompound(b, id, '0', '0.25', 'new', '2026-09-09T03:02:00Z');
  assert.deepEqual(b.events[1].decision, legacy);
  assert.equal(b.events[0].decision.policyVersion, 2);
  assert.equal(b.positions[0].reservesUsd, '0.000000');
  const p = b.positions[0];
  assert.equal(
    moneyUnits(p.netAddedUsd) + moneyUnits(p.servicePaidUsd),
    moneyUnits('200'),
  );
  assert.ok(moneyUnits(p.servicePaidUsd) <= moneyUnits('4'));
  assert.deepEqual(parseBook(JSON.parse(JSON.stringify(b))), b);
});
test('a lower gas estimate makes the existing balance eligible without adding fees', () => {
  let b = addPracticePosition(emptyBook(), makePosition(id), 'create');
  b = runPracticeCompound(b, id, '5', '0.25', 'wait', '2026-09-09T03:01:00Z');
  assert.equal(b.events[0].decision.reserveReason, 'network_cost');
  assert.match(pendingFeesExplanation(b.events[0].decision), /network cost/);
  b = runPracticeCompound(b, id, '0', '0.05', 'use', '2026-09-09T03:02:00Z');
  assert.equal(b.positions[0].netAddedUsd, '4.900000');
  assert.equal(b.positions[0].servicePaidUsd, '0.100000');
  assert.equal(b.positions[0].reservesUsd, '0.000000');
});
test('reported $10.38 fee includes uncharged waiting fees plus $172 newly added', () => {
  const legacy = {
    mode: 'simulation',
    decision: 'eligible',
    reason: 'ready',
    availableFeesUsd: '500.000000',
    consumedFeesUsd: '153.061224',
    serviceFeeUsd: '3.061224',
    reinvestedUsd: '150.000000',
    reserveUsd: '346.938776',
    gasUsd: '0.250000',
    operatorMarginUsd: '2.811224',
    minimumFeesUsd: '14.375000',
    maxNetAdditionUsd: '150.000000',
  };
  const original = parseBook({
    version: 1,
    positions: [
      {
        ...makePosition(id),
        reservesUsd: legacy.reserveUsd,
        feesAddedUsd: '500.000000',
        netAddedUsd: legacy.reinvestedUsd,
        servicePaidUsd: legacy.serviceFeeUsd,
      },
    ],
    events: [
      {
        id: 'legacy',
        positionId: id,
        at: '2026-09-09T13:42:57Z',
        kind: 'compound',
        decision: legacy,
      },
    ],
  });
  const next = runPracticeCompound(
    original,
    id,
    '172',
    '0.25',
    'reported',
    '2026-09-09T14:03:58Z',
  );
  const receipt = next.events[0];
  assert.equal(receipt.decision.availableFeesUsd, '518.938776');
  assert.equal(receipt.decision.serviceFeeUsd, '10.378775');
  assert.equal(receipt.decision.reinvestedUsd, '508.560001');
  assert.deepEqual(practiceFunding(next, receipt), {
    waitingFeesUsd: '346.938776',
    newFeesUsd: '172.000000',
  });
  assert.deepEqual(parseBook(JSON.parse(JSON.stringify(next))), next);
  assert.deepEqual(next.events[1].decision, legacy);
  const position = next.positions[0];
  assert.equal(position.feesAddedUsd, '672.000000');
  assert.equal(position.servicePaidUsd, '13.439999');
  assert.equal(
    moneyUnits(position.netAddedUsd) + moneyUnits(position.servicePaidUsd),
    moneyUnits('672'),
  );
  // A migrated receipt lacking explicit funding can use a known prior balance.
  const olderReceipt = { ...receipt };
  delete olderReceipt.funding;
  const olderBook = {
    ...next,
    events: [olderReceipt, ...next.events.slice(1)],
  };
  assert.deepEqual(practiceFunding(olderBook, olderReceipt), receipt.funding);
  // Rechecking the same prior waiting balance with zero new fees charges only it.
  const recheck = runPracticeCompound(
    original,
    id,
    '0',
    '0.25',
    'recheck',
    '2026-09-09T14:03:58Z',
  );
  assert.equal(recheck.events[0].decision.serviceFeeUsd, '6.938775');
});
test('funding provenance handles unrelated records and missing history without guessing', () => {
  let b = addPracticePosition(emptyBook(), makePosition(id), 'create');
  b = addPracticePosition(b, makePosition(other), 'create-other');
  b = runPracticeCompound(b, id, '20', '0.25', 'fees', '2026-09-09T14:03:58Z');
  const receipt = { ...b.events[0] };
  delete receipt.funding;
  b = { ...b, events: [receipt, ...b.events.slice(1)] };
  assert.deepEqual(practiceFunding(b, receipt), {
    waitingFeesUsd: '0.000000',
    newFeesUsd: '20.000000',
  });
  assert.equal(
    practiceFunding({ ...b, events: [receipt] }, receipt),
    undefined,
  );
  assert.throws(() =>
    parseBook({
      ...b,
      events: [
        { ...receipt, funding: { waitingFeesUsd: '19', newFeesUsd: '20' } },
        ...b.events.slice(1),
      ],
    }),
  );
});
test('a waiting scenario charges nothing, and another position remains untouched', () => {
  let b = addPracticePosition(emptyBook(), makePosition(id), 'create');
  b = addPracticePosition(b, makePosition(other), 'create2');
  const second = b.positions[1];
  b = runPracticeCompound(b, id, '5', '0.25', 'fees', '2026-09-09T03:01:00Z');
  assert.equal(b.positions[0].servicePaidUsd, '0.000000');
  assert.equal(b.positions[0].reservesUsd, '5.000000');
  assert.deepEqual(b.positions[1], second);
  assert.throws(() =>
    runPracticeCompound(
      { ...b, positions: b.positions.map((p) => ({ ...p, enabled: false })) },
      id,
      '20',
      '0.25',
      'paused',
      '2026-09-09T03:02:00Z',
    ),
  );
});
test('corrupt practice storage fails validation', () => {
  assert.throws(() => parseBook({ version: 1, positions: [{}], events: [] }));
  assert.throws(() => parseBook({ version: 2, positions: [], events: [] }));
});
test('conservation and full use of eligible balanced fees across many balances', () => {
  for (let i = 1; i <= 400; i++) {
    const r = previewCompound({
      availableFeesUsd: (i * 137.123).toFixed(6),
      positionValueUsd: '1000',
      gasUsd: '0.25',
    });
    assert.equal(
      moneyUnits(r.availableFeesUsd),
      moneyUnits(r.reinvestedUsd) +
        moneyUnits(r.serviceFeeUsd) +
        moneyUnits(r.reserveUsd),
    );
    assert.equal(r.policyVersion, 2);
    assert.equal('maxNetAdditionUsd' in r, false);
    if (r.decision === 'eligible') assert.equal(r.reserveUsd, '0.000000');
  }
});
