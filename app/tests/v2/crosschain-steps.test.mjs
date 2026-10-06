/**
 * The wallet steps of a quote (spec F7 §3.4 steps table, §3.6) and the journal record. Steps come only from a quote
 * the runtime accepts again, about the connected wallet, before its deadline; a tampered quote (deposit target
 * changed, approval doubled, steps reversed, another owner, expired) yields none. The approval is exact and is skipped
 * only by an allowance reading about this owner, token and spender on the origin chain.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build, fixture, fixtureText, lab, OTHER, OWNER, runtime } from './support/crosschain.mjs';

const { walletSteps, approvalCalldata, stillSendable, SEND_MARGIN_MS, journalRecord, isJournalRecord, withLastState, statusRequestOf } = build('steps');
const { reply } = build('fixtureTransport');

const TIMING = { sentMono: 0, receivedMono: 0 };
const NOW = 1_000;
const quoteOf = (name) => fixture(name).quote;
const base = () => quoteOf('responses/quote.json');
const allowanceFor = (quote, raw, change = {}) => ({
  chainId: quote.request.originChainId,
  token: quote.steps[0].approval.token,
  owner: OWNER,
  spender: quote.steps[0].approval.spender,
  raw,
  ...change,
});
const steps = (quote, { owner = OWNER, allowance = null, nowMono = NOW, source = 'http', timing = TIMING } = {}) =>
  walletSteps({ runtime, quote, owner, timing, nowMono, allowance, source });

test('an ERC-20 quote gives the exact approval, then the deposit, on the origin chain, exactly as the quote sent them', () => {
  const quote = base();
  const plan = steps(quote, { allowance: allowanceFor(quote, '0') });
  assert.equal(plan.ok, true);
  assert.equal(plan.provider, 'relay');
  assert.equal(plan.originChainId, 42161);
  assert.equal(plan.destinationChainId, 4663);
  assert.equal(plan.requestId, '0x1790905348d0ab084c8a20982a3dceb600295f180e97fd772e20b61baf5060ec');
  assert.equal(plan.approvalSkipped, false);
  assert.equal(plan.synthetic, false);
  assert.deepEqual(plan.steps, quote.steps.map((s) => ({ kind: s.kind, chainId: 42161, to: s.transaction.to, data: s.transaction.data, value: BigInt(s.transaction.valueRaw) })));
  assert.deepEqual(plan.steps.map((s) => s.value), [0n, 0n]);
  // The approval is exactly approve(spender, amountRaw), the calldata the runtime rebuilds too.
  assert.equal(approvalCalldata('0x4cd00e387622c35bddb9b4c962c136462338bc31', '100000000'), quote.steps[0].transaction.data);
  assert.equal(plan.steps[0].to, '0xaf88d065e77c8cc2239327c5edb3a432268e5831');
  assert.equal(plan.steps[1].to, '0x4cd00e387622c35bddb9b4c962c136462338bc31');
  assert.equal(plan.sendBeforeMono, 120_000 - SEND_MARGIN_MS);
});

test('the approval is skipped only when an allowance reading about this owner, token, spender and origin covers the amount', () => {
  const quote = base();
  assert.equal(steps(quote, { allowance: allowanceFor(quote, '99999999') }).approvalSkipped, false);
  const covered = steps(quote, { allowance: allowanceFor(quote, '100000000') });
  assert.equal(covered.approvalSkipped, true);
  assert.deepEqual(covered.steps.map((s) => s.kind), ['deposit']);
  assert.equal(steps(quote, { allowance: allowanceFor(quote, `1${'0'.repeat(70)}`) }).approvalSkipped, true);
  // Without a reading, the exact approval stays: it moves nothing by itself.
  const unread = steps(quote, { allowance: null });
  assert.deepEqual(unread.steps.map((s) => s.kind), ['approval', 'deposit']);
  // A reading about anything else skips nothing and gives no steps.
  for (const change of [{ spender: OTHER }, { token: OTHER }, { owner: OTHER }, { chainId: 8453 }, { raw: '1e30' }, { raw: '-1' }, { raw: 100000000 }]) {
    assert.deepEqual(steps(quote, { allowance: allowanceFor(quote, '100000000', change) }), { ok: false, reason: 'allowance' }, JSON.stringify(change));
  }
  // Case does not matter for the reading's addresses.
  assert.equal(steps(quote, { allowance: allowanceFor(quote, '100000000', { spender: quote.steps[0].approval.spender.toUpperCase().replace('0X', '0x') }) }).approvalSkipped, true);
});

test('native ETH is the deposit alone, its value the amount; Across on the native path, no tracking id', () => {
  const quote = quoteOf('variants/quote.native-only-across.json');
  const plan = steps(quote, { allowance: null });
  assert.equal(plan.ok, true);
  assert.equal(plan.provider, 'across');
  assert.equal(plan.requestId, null);
  assert.deepEqual(plan.steps.map((s) => [s.kind, s.chainId, s.to, s.value]), [['deposit', 42161, '0x97ccdbea4632140639ad5ea9b944aa034eb15fd4', 50000000000000000n]]);
  // An allowance reading is irrelevant to a native deposit.
  assert.equal(steps(quote, { allowance: { chainId: 42161, token: OTHER, owner: OWNER, spender: OTHER, raw: '0' } }).ok, true);
});

test('the destination-gas variant is Relay’s, with its own steps; no route gives no steps', () => {
  const gas = steps(quoteOf('variants/quote.destination-gas.json'));
  assert.equal(gas.ok, true);
  assert.equal(gas.provider, 'relay');
  assert.deepEqual(gas.steps.map((s) => s.kind), ['approval', 'deposit']);
  assert.deepEqual(steps(quoteOf('variants/quote.none.json')), { ok: false, reason: 'no_decision' });
});

test('a tampered quote yields no steps: deposit target, approval amount, order, spender, calldata, chain, refund, fee recipient', () => {
  const tampered = [
    (q) => { q.steps[1].transaction.to = OTHER; },
    (q) => { q.steps[0].approval.amountRaw = String(BigInt(q.steps[0].approval.amountRaw) * 2n); },
    (q) => {
      q.steps[0].approval.amountRaw = String(BigInt(q.steps[0].approval.amountRaw) * 2n);
      q.steps[0].transaction.data = approvalCalldata(q.steps[0].approval.spender, q.steps[0].approval.amountRaw);
    },
    (q) => { q.steps.reverse(); },
    (q) => { q.steps[0].approval.spender = OTHER; },
    (q) => { q.steps[0].transaction.data = `${q.steps[0].transaction.data.slice(0, -2)}ff`; },
    (q) => { q.steps[1].transaction.chainId = 8453; },
    (q) => { q.steps[1].transaction.valueRaw = '1'; },
    (q) => { q.steps.pop(); },
    (q) => { q.candidates[0].refund.recipient = OTHER; },
    (q) => { q.feeRecipient = q.request.owner; },
    (q) => { q.decision = 'across'; },
    (q) => { q.expiresAt += 600; },
  ];
  for (const [index, change] of tampered.entries()) {
    const quote = base();
    change(quote);
    assert.deepEqual(steps(quote, { allowance: null }), { ok: false, reason: 'not_validated' }, `tamper #${index}`);
  }
  const native = quoteOf('variants/quote.native-only-across.json');
  native.steps[0].transaction.valueRaw = '1';
  assert.deepEqual(steps(native), { ok: false, reason: 'not_validated' });
});

// Added 2026-10-06 (crosschain-v1 1.1.0-rc.1): by output, the wallet sends the winner's inputRaw; the request's
// amountRaw is what must arrive, in the destination token.
test('by output, the steps send the winner’s input: the exact approval for it, or the native deposit carrying it', () => {
  const usdg = quoteOf('variants/quote.output.json');
  const plan = steps(usdg, { allowance: null });
  assert.equal(plan.provider, 'relay');
  assert.deepEqual([usdg.request.amountRaw, usdg.steps[0].approval.amountRaw], ['100000000', '100916974']);
  assert.equal(plan.steps[0].data, approvalCalldata('0x4cd00e387622c35bddb9b4c962c136462338bc31', '100916974'));
  // The allowance is held against what is sent.
  assert.equal(steps(usdg, { allowance: allowanceFor(usdg, '100916973') }).approvalSkipped, false);
  assert.equal(steps(usdg, { allowance: allowanceFor(usdg, '100916974') }).approvalSkipped, true);
  const native = steps(quoteOf('variants/quote.output-native.json'));
  assert.deepEqual(native.steps.map((s) => [s.kind, s.value]), [['deposit', 50445218582624564n]]);
  // Relay above what the wallet may send: Across serves, for its own input.
  const above = steps(quoteOf('variants/quote.output-above-max.json'));
  assert.deepEqual([above.provider, above.steps[0].data], ['across', approvalCalldata('0x09aea4b2242abc8bb4bb78d537a67a245a7bec64', '100902201')]);
});

test('defense in depth: under a runtime that accepts anything, the page still sends only the winner’s input', () => {
  const lax = { ...runtime, validateResponse: () => true };
  const sends = (quote) => walletSteps({ runtime: lax, quote, owner: OWNER, timing: TIMING, nowMono: NOW, allowance: null, source: 'http' });
  assert.equal(sends(quoteOf('variants/quote.output.json')).ok, true);
  // An approval for what must arrive instead of what the deposit takes, its calldata rebuilt to match: no steps.
  const need = quoteOf('variants/quote.output.json');
  need.steps[0].approval.amountRaw = need.request.amountRaw;
  need.steps[0].transaction.data = approvalCalldata(need.steps[0].approval.spender, need.request.amountRaw);
  assert.deepEqual(sends(need), { ok: false, reason: 'shape' });
  // A native deposit carrying what must arrive: no steps.
  assert.equal(sends(quoteOf('variants/quote.output-native.json')).ok, true);
  const native = quoteOf('variants/quote.output-native.json');
  native.steps[0].transaction.valueRaw = native.request.amountRaw;
  assert.deepEqual(sends(native), { ok: false, reason: 'shape' });
});

test('a quote about another wallet gives no steps, even unchanged; so a fixture quote never gives a real wallet any', () => {
  assert.deepEqual(steps(base(), { owner: OTHER }), { ok: false, reason: 'owner' });
  assert.deepEqual(steps(base(), { owner: 'nobody' }), { ok: false, reason: 'owner' });
  // The owner rewritten everywhere still passes the runtime; the connected wallet is what stops it.
  const rewritten = base();
  rewritten.request.owner = OTHER;
  for (const c of rewritten.candidates) if (c.refund) c.refund.recipient = OTHER;
  assert.deepEqual(steps(rewritten), { ok: false, reason: 'owner' });
});

test('nothing is sendable at or after the deadline less the margin; a new quote is needed then', () => {
  const quote = base();
  const last = 120_000 - SEND_MARGIN_MS;
  assert.equal(steps(quote, { nowMono: last - 1 }).ok, true);
  assert.deepEqual(steps(quote, { nowMono: last }), { ok: false, reason: 'expired' });
  assert.deepEqual(steps(quote, { nowMono: 200_000 }), { ok: false, reason: 'expired' });
  const plan = steps(quote);
  assert.equal(stillSendable(plan, last - 1), true);
  assert.equal(stillSendable(plan, last), false, 'checked again before the deposit, after the approval’s receipt');
});

test('through the client: an accepted fixture quote gives steps marked synthetic, never sendable; a quote changed after acceptance gives none', async () => {
  const { client, transport, clock } = lab();
  transport.script('quote', reply(200, fixtureText('responses/quote.json')), reply(200, fixtureText('responses/quote.json')));
  const out = await client.quote(fixture('requests/quote.json'), { owner: OWNER });
  assert.equal(out.ok, true);
  const plan = walletSteps({ runtime, quote: out.data.quote, owner: OWNER, timing: out.timing, nowMono: clock.monoMs(), allowance: null, source: out.source });
  assert.equal(plan.ok, true);
  assert.equal(plan.synthetic, true);
  assert.equal(stillSendable(plan, clock.monoMs()), false, 'a fixture quote never reaches a wallet');
  const again = await client.quote(fixture('requests/quote.json'), { owner: OWNER });
  again.data.quote.steps[1].transaction.to = OTHER;
  assert.deepEqual(walletSteps({ runtime, quote: again.data.quote, owner: OWNER, timing: again.timing, nowMono: clock.monoMs(), allowance: null, source: 'http' }), { ok: false, reason: 'not_validated' });
  // A refused reply returns no data to derive steps from at all.
  transport.script('quote', reply(200, JSON.stringify({ ...fixture('responses/quote.json'), contractVersion: '1.0.0-rc.2' })));
  const refused = await client.quote(fixture('requests/quote.json'), { owner: OWNER });
  assert.equal(refused.ok, false);
  assert.equal('data' in refused, false);
});

test('the journal keeps the six public fields; its record asks a status the runtime accepts', () => {
  const plan = steps(base());
  const hash = `0x${'D1'.repeat(32)}`;
  const record = journalRecord(plan, hash);
  assert.deepEqual(record, {
    provider: 'relay',
    originChainId: 42161,
    destinationChainId: 4663,
    depositTxHash: `0x${'d1'.repeat(32)}`,
    requestId: '0x1790905348d0ab084c8a20982a3dceb600295f180e97fd772e20b61baf5060ec',
    lastState: null,
  });
  assert.equal(journalRecord(plan, '0x1234'), null);
  assert.ok(isJournalRecord(record));
  assert.ok(isJournalRecord(JSON.parse(JSON.stringify(withLastState(record, 'pending')))));
  assert.ok(runtime.validateRequest('status', statusRequestOf(record)));
  assert.deepEqual(statusRequestOf(withLastState(record, 'pending')).previousState, 'pending');
  const across = journalRecord(steps(quoteOf('variants/quote.native-only-across.json')), `0x${'d1'.repeat(32)}`);
  assert.equal(across.requestId, null);
  assert.ok(isJournalRecord(across));
  assert.ok(runtime.validateRequest('status', statusRequestOf(across)));
  for (const bad of [
    { ...record, owner: OWNER },
    { ...record, amountRaw: '1' },
    { ...record, requestId: null },
    { ...across, requestId: record.requestId },
    { ...record, depositTxHash: '0x12' },
    { ...record, originChainId: 4663 },
    { ...record, originChainId: 0 },
    { ...record, destinationChainId: 1 },
    { ...record, lastState: 'done' },
    { ...record, provider: 'stargate' },
    (({ lastState, ...rest }) => (void lastState, rest))(record),
    null,
    [record],
    'record',
  ]) assert.equal(isJournalRecord(bad), false, JSON.stringify(bad));
  assert.equal(JSON.stringify(record).includes('100000000'), false, 'no amount in the journal');
});
