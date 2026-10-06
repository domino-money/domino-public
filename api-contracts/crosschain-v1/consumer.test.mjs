// Producer fixtures pass; altered answers that would misdirect funds or misreport a deposit fail.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import * as runtime from './runtime.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const requests = Object.fromEntries(runtime.ROUTES.map((route) => [route, read(`./fixtures/requests/${route}.json`)]));
const responses = Object.fromEntries(runtime.ROUTES.map((route) => [route, read(`./fixtures/responses/${route}.json`)]));
const variants = readdirSync(new URL('./fixtures/variants/', import.meta.url)).map((name) =>
  [name, name.split('.')[0], read(`./fixtures/variants/${name}`)]);
const clone = (value) => JSON.parse(JSON.stringify(value));
const OTHER = '0x' + '9'.repeat(40);

test('producer fixtures, variants and errors validate', () => {
  for (const route of runtime.ROUTES) {
    assert(runtime.validateRequest(route, requests[route]), route);
    assert(runtime.validateResponse(route, responses[route]), route);
  }
  for (const [name, route, body] of variants) assert(runtime.validateResponse(route, body), name);
  for (const [code, { status, body }] of Object.entries(read('./fixtures/errors.json'))) assert(runtime.validateError(status, body), code);
});

test('requests never name an owner, recipient or fee and stay on offered tokens', () => {
  for (const field of ['owner', 'recipient', 'refundTo', 'feeRecipient', 'appFeeBps']) {
    assert(!runtime.validateRequest('quote', { ...requests.quote, [field]: OTHER }), field);
  }
  assert(!runtime.validateRequest('quote', { ...requests.quote, destinationToken: OTHER }));
  assert(!runtime.validateRequest('quote', { ...requests.quote, originChainId: 4663 }));
  assert(!runtime.validateRequest('quote', { ...requests.quote, amountRaw: 100000000 }));
  assert(!runtime.validateRequest('quote', { ...requests.quote, destinationToken: '0x' + '0'.repeat(40), destinationGas: true }));
  assert(!runtime.validateRequest('status', { ...requests.status, requestId: '0x' + '1'.repeat(64) }));
  assert(!runtime.validateRequest('origins', { ...requests.origins, destinationChainId: 1 }));
});

test('a quote cannot send the deposit, approval or refund anywhere else', () => {
  const base = responses.quote;
  const mutate = (change) => { const value = clone(base); change(value.quote); return runtime.validateResponse('quote', value); };
  assert(!mutate((q) => { q.steps[1].transaction.to = OTHER; }));
  assert(!mutate((q) => { q.steps[0].approval.spender = OTHER; }));
  assert(!mutate((q) => { q.steps[0].approval.amountRaw = String(BigInt(q.steps[0].approval.amountRaw) * 2n); }));
  assert(!mutate((q) => { q.steps[0].transaction.data = q.steps[0].transaction.data.slice(0, -2) + 'ff'; }));
  assert(!mutate((q) => { q.steps[1].transaction.chainId = 8453; }));
  assert(!mutate((q) => { q.candidates[0].refund.recipient = OTHER; }));
  assert(!mutate((q) => { q.feeRecipient = q.request.owner; }));
  assert(!mutate((q) => { q.steps.reverse(); }));
});

test('the decision is recomputed from the candidates', () => {
  const base = responses.quote;
  const mutate = (change) => { const value = clone(base); change(value.quote); return runtime.validateResponse('quote', value); };
  assert(!mutate((q) => { q.decision = q.decision === 'relay' ? 'across' : 'relay'; }));
  assert(!mutate((q) => { q.comparison.advantageRaw = '1'; }));
  assert(!mutate((q) => { q.candidates.reverse(); }));
  assert(!mutate((q) => { q.reason = 'only_quote'; }));
  assert(!mutate((q) => { q.expiresAt += 60; }));
});

test('by output (1.1.0-rc.1): the cap, the guarantee, the better rate and the winner\'s input', () => {
  const variant = (name) => variants.find(([file]) => file === `${name}.json`)[2];
  const [output, above, native] = ['quote.output', 'quote.output-above-max', 'quote.output-native'].map(variant);
  const mutate = (base, change) => { const value = clone(base); change(value.quote); return runtime.validateResponse('quote', value); };
  // Relay takes more but delivers more per unit sent: it wins, and the wallet approves what its deposit takes.
  assert.equal(output.quote.decision, 'relay');
  assert.equal(output.quote.steps[0].approval.amountRaw, output.quote.candidates[0].inputRaw);
  assert.notEqual(output.quote.candidates[0].inputRaw, output.quote.request.amountRaw);
  assert(!mutate(output, (q) => { q.decision = 'across'; }));
  assert(!mutate(output, (q) => { q.steps[0].approval.amountRaw = q.request.amountRaw; }));
  assert(!mutate(native, (q) => { q.steps[0].transaction.valueRaw = q.request.amountRaw; }));
  // Only what the wallet may send is eligible; above it a candidate is input_above_max, still priced.
  assert.equal(above.quote.candidates[0].status, 'input_above_max');
  assert(!mutate(output, (q) => { q.request.maxInputRaw = '100910000'; }));
  assert(!mutate(above, (q) => { q.request.maxInputRaw = '150000000'; }));
  // Every price guarantees what must arrive, and says what its deposit takes.
  assert(!mutate(above, (q) => { q.candidates[0].minimumOutputRaw = '99999999'; }));
  assert(!mutate(above, (q) => { q.candidates[0].inputRaw = null; }));
  // The request: a cap exactly when asking by output.
  assert(runtime.validateRequest('quote', { ...requests.quote, amountKind: 'output', maxInputRaw: '1' }));
  assert(!runtime.validateRequest('quote', { ...requests.quote, amountKind: 'output' }));
  assert(!runtime.validateRequest('quote', { ...requests.quote, maxInputRaw: '1' }));
  assert(!runtime.validateRequest('quote', { ...requests.quote, amountKind: 'exact_output' }));
});

test('tracking only moves forward and reports fees for fills only', () => {
  const base = responses.status;
  const mutate = (change) => { const value = clone(base); change(value.status); return runtime.validateResponse('status', value); };
  assert(!mutate((s) => { s.request.previousState = 'refunded'; }));
  assert(!mutate((s) => { s.terminal = false; }));
  assert(!mutate((s) => { s.state = 'pending'; s.transition = 'held'; }));
  assert(!mutate((s) => { s.fee.amountRaw = '0'; }));
  assert(!mutate((s) => { s.nextCheckSeconds = 10; }));
  const held = variants.find(([name]) => name === 'status.across-held.json')[2];
  assert.equal(held.status.state, 'filled');
  assert.equal(held.status.transition, 'held');
  assert.deepEqual(runtime.advance('filled', 'pending'), ['filled', 'held']);
  assert.deepEqual(runtime.advance('pending', 'refund_pending'), ['refund_pending', 'advanced']);
});
