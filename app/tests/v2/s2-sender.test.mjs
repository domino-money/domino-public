/**
 * S2's closed origin sender (src/finance/v2/crosschain.ts, spec F7 §3.4 "Regras dos passos", §3.6) on a fake ORIGIN
 * chain that is not one of V2's (Optimism, 10) and on Arbitrum: the exact approval only when the allowance read on the
 * origin is short, its receipt before the deposit, the deposit exactly as the validated quote gave it, the chain read
 * again right before each send, a refusal releasing its claim, an unknown outcome keeping it, an expired quote sending
 * nothing, a fixture quote never sendable, the wallet's own fees (no zero tip), and the journal record kept for a reload.
 * Added 2026-10-06 (rugged's answer of 6 Oct: the owner revoked decision #15): where the wallet batches on the origin, the
 * exact approval and the deposit as ONE batch, kept until the wallet names its transaction, the deposit's.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { numberToHex } from 'viem';
import { createOriginChain, memoryStorage } from '../support/s2-origin-chain.mjs';
import { build, clone, fixture, runtime } from './support/crosschain.mjs';

const require = createRequire(import.meta.url);
const { BATCH_JOURNAL_MAX, BATCH_JOURNAL_PREFIX, batchJournalKey, createBatchJournal, createOriginSender, createDepositJournal, createUnsettledStore, depositJournalKey, DEPOSIT_JOURNAL_MAX, DEPOSIT_JOURNAL_PREFIX, isPendingBatch, isUnsettledOffer, OriginStepError, ORIGIN_MAX_GAS, unsettledKey } = require('../../.test-build/app/src/finance/v2/crosschain.js');
const { walletSteps, stillSendable, SEND_MARGIN_MS } = build('steps');

/** The connected wallet: the anvil account the browser suites use. */
const OWNER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const SYNTHETIC = '0x1111111111111111111111111111111111111111';
const OP_USDC = '0x0b2c639c533813f4aa9d7837caf62653d097ff85';
const ARB_USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
const TIMING = { sentMono: 0, receivedMono: 0 };

/** A package fixture's quote, about OWNER instead of the package's synthetic wallet (the runtime checks owner, refund). */
const asOwner = (value) => JSON.parse(JSON.stringify(value).replaceAll(SYNTHETIC, OWNER));
const arbitrumQuote = () => asOwner(fixture('responses/quote.json').quote);
const nativeQuote = () => asOwner(fixture('variants/quote.native-only-across.json').quote);

/**
 * The same Relay quote from Optimism (10), a chain V2 does not serve: the runtime pins Relay's depository there too. The
 * origin token is Optimism's USDC; the exact approval is rebuilt for it.
 */
function optimismQuote() {
  const quote = arbitrumQuote();
  quote.request.originChainId = 10;
  quote.request.originToken = OP_USDC;
  for (const c of quote.candidates) {
    if (c.refund) c.refund.chainId = 10;
    if (c.provider === 'relay') {
      c.appFee.chainId = 10;
      c.appFee.token = OP_USDC;
    }
    c.providerFee.chainId = 10;
    c.providerFee.token = OP_USDC;
  }
  quote.steps[0].approval.token = OP_USDC;
  quote.steps[0].transaction.to = OP_USDC;
  for (const step of quote.steps) step.transaction.chainId = 10;
  assert.ok(runtime.validateResponse('quote', { contractVersion: runtime.CONTRACT_VERSION, quote }), 'the Optimism quote passes the package runtime');
  return quote;
}

function lab({ quote = optimismQuote(), chain = {}, now = 1_000, journal = true } = {}) {
  const origin = createOriginChain({ owner: OWNER, chainId: quote.request.originChainId, ...chain });
  const clock = { now };
  const storage = memoryStorage();
  const kept = journal ? createDepositJournal(storage) : null;
  const sender = createOriginSender(origin.wallet, { runtime, monoMs: () => clock.now, journal: kept });
  const input = { quote, timing: TIMING, source: 'http' };
  return { origin, clock, sender, input, quote, storage, journal: kept };
}

const codeOf = async (promise) => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof OriginStepError, `an OriginStepError, not ${error}`);
    return error.code;
  }
  assert.fail('expected a refusal');
};

test('from Optimism (not a V2 chain): allowance short → the exact approval, its receipt, then the deposit exactly as quoted; fees from the wallet', async () => {
  const s = lab();
  const review = await s.sender.review(s.input);
  assert.deepEqual(review.plan.steps.map((step) => step.kind), ['approval', 'deposit']);
  assert.deepEqual(review.approval, { token: OP_USDC, spender: DEPOSITORY, amountRaw: '100000000' });
  assert.ok(s.origin.state.asked.includes('eth_call'), 'the allowance was read on the origin through the wallet');
  // The deposit cannot go before the approval's receipt.
  assert.equal(await codeOf(s.sender.send(review, 'deposit')), 'approval_not_confirmed');
  const approval = await s.sender.send(review, 'approval');
  assert.equal(approval.record, null);
  assert.equal(await codeOf(s.sender.send(review, 'deposit')), 'approval_not_confirmed', 'still not before the receipt is read');
  assert.equal((await s.sender.receipt(review, approval.hash)).state, 'included');
  const sent = await s.sender.send(review, 'deposit');
  const [approveTx, depositTx] = s.origin.state.sent;
  // Exactly what the quote gave: the exact approval (never the unlimited one), then the deposit's to, data and value.
  assert.deepEqual([approveTx.to, approveTx.data, approveTx.value], [OP_USDC, s.quote.steps[0].transaction.data, '0x0']);
  assert.deepEqual([depositTx.to, depositTx.data, depositTx.value], [DEPOSITORY, s.quote.steps[1].transaction.data, '0x0']);
  for (const tx of [approveTx, depositTx]) {
    assert.equal(tx.chainId, '0xa', 'the origin chain, Optimism');
    assert.equal(tx.type, '0x2');
    assert.equal(tx.from, OWNER);
    assert.equal(tx.maxFeePerGas, numberToHex(100_000_000n), 'twice the wallet’s gas price');
    assert.equal(tx.maxPriorityFeePerGas, numberToHex(2_000_000n), 'the wallet’s own tip: V1’s zero tip is not applied on an arbitrary origin');
    assert.equal(tx.gas, numberToHex(120_000n), 'the estimate and a fifth');
  }
  assert.deepEqual([approveTx.nonce, depositTx.nonce], ['0x3', '0x4'], 'one nonce each, in order');
  assert.deepEqual([...s.origin.claims.keys()], ['10|3', '10|4'], 'claimed in the ORIGIN chain’s journal, and kept (both were sent)');
  // The journal record (§3.6 step 4): public tracking data only, under a hashed chain-and-owner key.
  assert.deepEqual(sent.record, { provider: 'relay', originChainId: 10, destinationChainId: 4663, depositTxHash: sent.hash, requestId: s.quote.candidates[0].tracking.requestId, lastState: null });
  assert.equal(sent.journaled, true);
  assert.deepEqual(s.journal.list(4663, OWNER), [sent.record]);
  const [storageKey] = [...s.storage.map.keys()];
  assert.equal(storageKey, depositJournalKey(4663, OWNER));
  assert.ok(storageKey.startsWith(DEPOSIT_JOURNAL_PREFIX) && !storageKey.includes(OWNER.slice(2)), 'no address in the key');
  assert.doesNotMatch(s.storage.map.get(storageKey), /amount|100000000|0x095ea7b3|e8017952/i, 'no amount and no calldata kept');
  // Never twice from one review.
  assert.equal(await codeOf(s.sender.send(review, 'deposit')), 'step_already_sent');
  assert.equal(await codeOf(s.sender.send(review, 'approval')), 'step_already_sent');
  assert.equal(s.origin.state.sent.length, 2);
});

test('the approval is skipped when the allowance read on the origin already covers the amount; the deposit is read against it again', async () => {
  const s = lab();
  s.origin.state.allowances.set(`${OP_USDC}|${OWNER}|${DEPOSITORY}`, 100_000_000n);
  const review = await s.sender.review(s.input);
  assert.deepEqual(review.plan.steps.map((step) => step.kind), ['deposit']);
  assert.equal(review.plan.approvalSkipped, true);
  // The allowance moves away before the deposit: read again right then, so nothing is sent.
  s.origin.state.allowances.set(`${OP_USDC}|${OWNER}|${DEPOSITORY}`, 99_999_999n);
  assert.equal(await codeOf(s.sender.send(review, 'deposit')), 'allowance_short');
  assert.equal(s.origin.state.sent.length, 0);
  assert.equal(s.origin.claims.size, 0, 'nothing claimed');
  s.origin.state.allowances.set(`${OP_USDC}|${OWNER}|${DEPOSITORY}`, 100_000_000n);
  const sent = await s.sender.send(review, 'deposit');
  assert.equal(s.origin.state.sent.length, 1);
  assert.equal(s.origin.state.sent[0].to, DEPOSITORY);
  assert.ok(sent.journaled);
});

test('native ETH (Across, Arbitrum): the deposit alone, its value the amount, no allowance read, the value counted in the balance check', async () => {
  const s = lab({ quote: nativeQuote() });
  const before = s.origin.mark();
  const review = await s.sender.review(s.input);
  assert.equal(review.approval, null);
  assert.ok(!before().includes('eth_call'), 'no allowance to read');
  s.origin.state.balance = 50_000_000_000_000_000n; // the amount, and nothing for the fee
  assert.equal(await codeOf(s.sender.send(review, 'deposit')), 'native_balance_insufficient');
  assert.equal(s.origin.state.sent.length, 0);
  s.origin.state.balance = 10n ** 18n;
  await s.sender.send(review, 'deposit');
  const [tx] = s.origin.state.sent;
  assert.deepEqual([tx.to, tx.value, tx.chainId], ['0x97ccdbea4632140639ad5ea9b944aa034eb15fd4', numberToHex(50_000_000_000_000_000n), '0xa4b1']);
  assert.equal(s.journal.list(4663, OWNER)[0].requestId, null, 'Across: no request id');
});

test('decision #21 (§1.3): no tip from Arbitrum One or Robinhood Chain (arrival order); the wallet’s own on Base and on any other origin', async () => {
  // Arbitrum One: the fee ceiling only, and the wallet is not even asked for a tip.
  const arbitrum = lab({ quote: arbitrumQuote() });
  arbitrum.origin.state.allowances.set(`${ARB_USDC}|${OWNER}|${DEPOSITORY}`, 100_000_000n);
  await arbitrum.sender.send(await arbitrum.sender.review(arbitrum.input), 'deposit');
  assert.equal(arbitrum.origin.state.sent[0].maxPriorityFeePerGas, '0x0');
  assert.ok(!arbitrum.origin.state.asked.includes('eth_maxPriorityFeePerGas'));
  // Base (OP Stack, priority order): the wallet's suggestion. The same Relay quote from Base, with Base's USDC.
  const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const fromBase = JSON.parse(JSON.stringify(optimismQuote()).replaceAll(OP_USDC, BASE_USDC));
  fromBase.request.originChainId = 8453;
  for (const c of fromBase.candidates) {
    if (c.refund) c.refund.chainId = 8453;
    if (c.provider === 'relay') c.appFee.chainId = 8453;
    c.providerFee.chainId = 8453;
  }
  for (const step of fromBase.steps) step.transaction.chainId = 8453;
  assert.ok(runtime.validateResponse('quote', { contractVersion: runtime.CONTRACT_VERSION, quote: fromBase }));
  const base = lab({ quote: fromBase, chain: { tip: 7_000_000n } });
  base.origin.state.allowances.set(`${BASE_USDC}|${OWNER}|${DEPOSITORY}`, 100_000_000n);
  await base.sender.send(await base.sender.review(base.input), 'deposit');
  assert.equal(base.origin.state.sent[0].maxPriorityFeePerGas, numberToHex(7_000_000n));
  // Optimism, not a V2 chain: its ordering is not known here, so the wallet's own (the first test above).
});

test('the chain is read again right before each send: a wallet moved after the claim sends nothing and the claim is released', async () => {
  const s = lab({ quote: arbitrumQuote() });
  const review = await s.sender.review(s.input);
  s.origin.state.chainAfterClaim = 10;
  assert.equal(await codeOf(s.sender.send(review, 'approval')), 'wallet_wrong_chain');
  assert.equal(s.origin.state.sent.length, 0);
  assert.equal(s.origin.claims.size, 0, 'the claim is released: the provider was never asked');
  assert.ok(!s.origin.state.asked.includes('eth_sendTransaction'));
  // The step was never offered: the same review may offer it once the wallet is back.
  s.origin.state.chainAfterClaim = null;
  s.origin.state.chainId = 42161;
  await s.sender.send(review, 'approval');
  assert.equal(s.origin.state.sent.length, 1);
});

test('a wallet on another chain, or another account, is refused before anything is read for the step', async () => {
  const s = lab();
  s.origin.state.chainId = 4663;
  assert.equal(await codeOf(s.sender.review(s.input)), 'wallet_wrong_chain');
  s.origin.state.chainId = 10;
  s.origin.state.accounts = ['0x9999999999999999999999999999999999999999'];
  assert.equal(await codeOf(s.sender.review(s.input)), 'wallet_identity_changed');
  assert.equal(s.origin.state.sent.length, 0);
});

test('a refusal in the wallet (4001, or a Ledger’s words) releases exactly its claim; the review never offers that step again, a new review can', async () => {
  for (const refusal of ['refuse', 'ledger']) {
    const s = lab();
    const review = await s.sender.review(s.input);
    s.origin.state.nextSend = refusal;
    assert.equal(await codeOf(s.sender.send(review, 'approval')), 'declined');
    assert.equal(s.origin.claims.size, 0, `${refusal}: the claim is released`);
    assert.equal(await codeOf(s.sender.send(review, 'approval')), 'step_already_sent', 'never offered twice from one review');
    const again = await s.sender.review(s.input);
    await s.sender.send(again, 'approval');
    assert.equal(s.origin.state.sent.length, 1);
    assert.deepEqual([...s.origin.claims.keys()], ['10|3'], 'the same nonce, claimed again for the new offer');
  }
});

test('an unknown outcome keeps the claim, and nothing more is offered on that origin until it settles', async () => {
  const s = lab();
  const review = await s.sender.review(s.input);
  s.origin.state.nextSend = 'unknown';
  assert.equal(await codeOf(s.sender.send(review, 'approval')), 'wallet_result_unknown');
  assert.deepEqual([...s.origin.claims.keys()], ['10|3'], 'the claim stays: the transaction may have been sent');
  assert.equal(await codeOf(s.sender.review(s.input)), 'wallet_request_open', 'the chain shows its nonce still free: the wallet may still show it');
  assert.equal(s.origin.state.sent.length, 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// F1 (post-B5 review): a deposit handed to the wallet with no usable answer is never sent twice
// ---------------------------------------------------------------------------------------------------------------------

/** The same request asked again: another quote (a later requestedAt), the same deposit. */
const laterQuote = (quote, seconds = 30) => {
  const next = clone(quote);
  next.requestedAt += seconds;
  next.retrievedAt += seconds;
  next.expiresAt += seconds;
  return next;
};
const covered = (s) => s.origin.state.allowances.set(`${OP_USDC}|${OWNER}|${DEPOSITORY}`, 100_000_000n);

test('F1: a deposit the wallet broadcast and whose answer was lost, then mined, is never sent again: not from that quote, not from a new one', async () => {
  for (const loss of ['broadcast-lost', 'broadcast-garbled']) {
    const storage = memoryStorage();
    const s = lab();
    const unsettled = createUnsettledStore(storage);
    const sender = createOriginSender(s.origin.wallet, { runtime, monoMs: () => s.clock.now, journal: s.journal, unsettled });
    covered(s);
    const review = await sender.review(s.input);
    s.origin.state.nextSend = loss;
    assert.equal(await codeOf(sender.send(review, 'deposit')), 'wallet_result_unknown', loss);
    assert.equal(s.origin.state.sent.length, 1, 'it did go out, and was mined');
    assert.deepEqual(s.journal.list(4663, OWNER), [], 'no hash: no journal record');
    // The same quote: its deposit is sent for this page, whatever review it comes through.
    const asked = s.origin.mark();
    assert.equal(await codeOf(sender.review(s.input)), 'deposit_already_offered');
    assert.deepEqual(asked(), [], 'refused before the wallet is asked anything');
    assert.equal(sender.depositOffered(s.quote), true);
    // A new quote for the same deposit: the chain has taken the held nonce, so it probably went through. Said once.
    const next = { ...s.input, quote: laterQuote(s.quote) };
    assert.equal(await codeOf(sender.review(next)), 'deposit_may_have_gone');
    assert.deepEqual(unsettled.list(OWNER).map((o) => [o.kind, o.state, o.nonce]), [['deposit', 'passed', '3']]);
    assert.equal(s.origin.claims.has('10|3'), false, 'its latch is let go: the chain settled it');
    assert.equal(s.origin.state.sent.length, 1, 'no second deposit');
    // Told: a deliberate new deposit (another quote) may go now, with the next nonce.
    const after = await sender.review(next);
    await sender.send(after, 'deposit');
    assert.equal(s.origin.state.sent.length, 2);
    assert.equal(s.origin.state.sent[1].nonce, '0x4');
    // And the first quote stays sent, after a reload too (the store kept it).
    const reloaded = createOriginSender(s.origin.wallet, { runtime, monoMs: () => s.clock.now, journal: s.journal, unsettled: createUnsettledStore(storage) });
    assert.equal(await codeOf(reloaded.review(s.input)), 'deposit_already_offered');
  }
});

test('F1: while the held nonce is still free, nothing is offered on that origin (any quote) until the person says the wallet did not send it', async () => {
  const storage = memoryStorage();
  const s = lab();
  const unsettled = createUnsettledStore(storage);
  const sender = createOriginSender(s.origin.wallet, { runtime, monoMs: () => s.clock.now, journal: s.journal, unsettled });
  covered(s);
  s.origin.state.nextSend = 'unknown';
  assert.equal(await codeOf(sender.send(await sender.review(s.input), 'deposit')), 'wallet_result_unknown');
  const next = { ...s.input, quote: laterQuote(s.quote) };
  assert.equal(await codeOf(sender.review(next)), 'wallet_request_open');
  // After a reload the page's live lock is gone, so V1's settle would free the nonce latch; the hold still refuses.
  s.origin.claims.clear();
  const reloaded = createOriginSender(s.origin.wallet, { runtime, monoMs: () => s.clock.now, journal: s.journal, unsettled: createUnsettledStore(storage) });
  assert.equal(await codeOf(reloaded.review(next)), 'wallet_request_open');
  assert.deepEqual(unsettled.list(OWNER).map((o) => o.originChainId), [10], 'held for this origin only');
  // "I rejected it in my wallet": heard while the nonce is still free; the hold and the latch go, nothing is sent.
  assert.equal(await reloaded.forgetUnsettled(10), 'forgotten');
  assert.deepEqual(createUnsettledStore(storage).list(OWNER), []);
  await reloaded.send(await reloaded.review(next), 'deposit');
  assert.equal(s.origin.state.sent.length, 1);
  assert.equal(s.origin.state.sent[0].nonce, '0x3', 'the same nonce, never used before');
  // The first quote's deposit is still never offered again on this page.
  assert.equal(await codeOf(sender.review(s.input)), 'deposit_already_offered');
});

test('F1: a held step pending on chain is not let go on the person’s word; a mined approval settles by itself', async () => {
  const s = lab({ chain: { mine: 'manual' } });
  const unsettled = createUnsettledStore(null);
  const sender = createOriginSender(s.origin.wallet, { runtime, monoMs: () => s.clock.now, journal: s.journal, unsettled });
  const review = await sender.review(s.input);
  s.origin.state.nextSend = 'broadcast-lost';
  assert.equal(await codeOf(sender.send(review, 'approval')), 'wallet_result_unknown');
  assert.equal(await codeOf(sender.review(s.input)), 'pending_wallet_transaction', 'broadcast, not mined: pending');
  assert.equal(await sender.forgetUnsettled(10), 'pending');
  assert.equal(unsettled.list(OWNER).length, 1, 'kept');
  s.origin.include(`0x${(0xa0).toString(16).padStart(64, '0')}`);
  // Mined: the approval's hold settles by the chain, and the allowance read now covers the amount.
  const again = await sender.review(s.input);
  assert.deepEqual(again.plan.steps.map((step) => step.kind), ['deposit']);
  assert.deepEqual(unsettled.list(OWNER), []);
});

test('F9: a refusal of the bounded port before the provider is invoked lets the claimed nonce go; the step may be offered again', async () => {
  const s = lab();
  const wall = { now: 1_000_000 };
  const sender = createOriginSender(s.origin.wallet, { runtime, monoMs: () => s.clock.now, journal: s.journal, now: () => wall.now });
  covered(s);
  const review = await sender.review(s.input);
  // The window closes between the last chain read and the send: the wallet is never asked to send.
  const request = s.origin.wallet.request;
  s.origin.wallet.request = async (method, params) => {
    const answer = await request(method, params);
    if (method === 'eth_chainId' && s.origin.claims.size > 0) wall.now += 1_000;
    return answer;
  };
  assert.equal(await codeOf(sender.send(review, 'deposit')), 'wallet_action_expired');
  assert.ok(!s.origin.state.asked.includes('eth_sendTransaction'));
  assert.equal(s.origin.claims.size, 0, 'the claim is let go');
  assert.equal(sender.wasOffered(review, 'deposit'), false, 'never offered');
  s.origin.wallet.request = request;
  await sender.send(review, 'deposit');
  assert.equal(s.origin.state.sent.length, 1);
});

test('the wallet’s prompt never outlives the quote: its window ends at the deadline less the margin, and the step is then held', async () => {
  const s = lab();
  covered(s);
  const review = await s.sender.review(s.input);
  s.clock.now = 120_000 - SEND_MARGIN_MS - 800; // 0.8 s left
  s.origin.state.nextSend = 'hang';
  const started = Date.now();
  assert.equal(await codeOf(s.sender.send(review, 'deposit')), 'wallet_result_unknown');
  assert.ok(Date.now() - started < 5_000, `bounded by the quote, not the 180 s window (${Date.now() - started} ms)`);
  assert.equal(s.sender.depositOffered(s.quote), true);
});

test('held steps are kept closed, with public data only, under a hashed key', () => {
  const storage = memoryStorage();
  const store = createUnsettledStore(storage);
  const offer = { originChainId: 10, nonce: '3', kind: 'deposit', quote: `${'ab'.repeat(32)}:1790905139`, provider: 'relay', destinationChainId: 4663, at: 1_790_905_140, state: 'open' };
  store.put(OWNER, offer);
  const [key] = [...storage.map.keys()];
  assert.equal(key, unsettledKey(OWNER));
  assert.ok(!key.includes(OWNER.slice(2)) && !storage.map.get(key).includes(OWNER.slice(2)), 'no address kept');
  assert.deepEqual(createUnsettledStore(storage).list(OWNER), [offer], 'a reload finds it');
  assert.throws(() => store.put(OWNER, { ...offer, amountRaw: '1' }), /invalid_unsettled_offer/);
  storage.setItem(key, JSON.stringify([offer, { ...offer, originChainId: 1, extra: 1 }, { ...offer, originChainId: 8453, kind: 'swap' }]));
  assert.deepEqual(createUnsettledStore(storage).list(OWNER), [offer], 'anything else is left out');
  assert.equal(isUnsettledOffer({ ...offer, nonce: '-1' }), false);
  // A storage that refuses writes never loses the hold for this page.
  const refusing = createUnsettledStore({ getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {} });
  refusing.put(OWNER, offer);
  assert.deepEqual(refusing.list(OWNER), [offer]);
});

test('an expired quote sends nothing: refused at review, and at the send when it expires after the review', async () => {
  const late = lab({ now: 120_000 - SEND_MARGIN_MS });
  const asked = late.origin.mark();
  assert.equal(await codeOf(late.sender.review(late.input)), 'quote_expired');
  assert.deepEqual(asked(), [], 'the wallet was asked nothing');
  const s = lab();
  const review = await s.sender.review(s.input);
  s.clock.now = 110_000;
  const after = s.origin.mark();
  assert.equal(await codeOf(s.sender.send(review, 'approval')), 'quote_expired');
  assert.deepEqual(after(), [], 'refused before any wallet call');
  assert.equal(s.origin.state.sent.length, 0);
});

test('a fixture quote is never sendable: stillSendable is false for it, and the sender refuses it before the wallet is asked anything', async () => {
  const s = lab();
  const plan = walletSteps({ runtime, quote: s.quote, owner: OWNER, timing: TIMING, nowMono: 1_000, allowance: null, source: 'fixture' });
  assert.equal(plan.ok, true);
  assert.equal(plan.synthetic, true);
  assert.equal(stillSendable(plan, 1_000), false);
  const asked = s.origin.mark();
  assert.equal(await codeOf(s.sender.review({ ...s.input, source: 'fixture' })), 'quote_synthetic');
  assert.deepEqual(asked(), [], 'no wallet request at all');
  // And the package's own fixture, about its synthetic wallet, is refused for this one.
  const theirs = lab({ quote: fixture('responses/quote.json').quote, chain: { chainId: 42161 } });
  assert.equal(await codeOf(theirs.sender.review(theirs.input)), 'quote_owner');
});

test('a review only from this sender; a step outside the plan; a tampered quote yields no review', async () => {
  const s = lab();
  const review = await s.sender.review(s.input);
  assert.equal(await codeOf(s.sender.send({ ...review }, 'approval')), 'review_required', 'a copy is not the issued review');
  const tampered = clone(s.quote);
  tampered.steps[0].transaction.data = tampered.steps[0].transaction.data.replace(/5f5e100$/, 'fffffff');
  assert.equal(await codeOf(s.sender.review({ ...s.input, quote: tampered })), 'quote_not_validated');
  const unlimited = clone(s.quote);
  unlimited.steps[0].approval.amountRaw = (2n ** 256n - 1n).toString();
  assert.equal(await codeOf(s.sender.review({ ...s.input, quote: unlimited })), 'quote_not_validated', 'the unlimited approval is never taken');
  const native = lab({ quote: nativeQuote() });
  const nativeReview = await native.sender.review(native.input);
  assert.equal(await codeOf(native.sender.send(nativeReview, 'approval')), 'step_not_in_plan');
});

test('the wallet’s tip is kept under the fee ceiling; an estimate past the budget, a reverting step, or no fee are refused unsent', async () => {
  const tipped = lab({ chain: { gasPrice: 10n, tip: 1_000n } });
  const review = await tipped.sender.review(tipped.input);
  await tipped.sender.send(review, 'approval');
  assert.equal(tipped.origin.state.sent[0].maxPriorityFeePerGas, numberToHex(20n), 'capped at the ceiling');
  const big = lab({ chain: { estimate: ORIGIN_MAX_GAS } });
  assert.equal(await codeOf(big.sender.send(await big.sender.review(big.input), 'approval')), 'gas_budget_exceeded');
  const reverting = lab();
  reverting.origin.state.revertEstimate = true;
  assert.equal(await codeOf(reverting.sender.send(await reverting.sender.review(reverting.input), 'approval')), 'step_would_fail');
  const free = lab({ chain: { gasPrice: 0n } });
  assert.equal(await codeOf(free.sender.send(await free.sender.review(free.input), 'approval')), 'network_fee_unavailable');
  for (const s of [big, reverting, free]) {
    assert.equal(s.origin.state.sent.length, 0);
    assert.equal(s.origin.claims.size, 0);
  }
});

test('receipts: pending, then included and finalized apart, reverted; only for a hash this review sent; a chain with no finalized tag stays included', async () => {
  const s = lab({ chain: { mine: 'manual', finalizedTag: false } });
  const review = await s.sender.review(s.input);
  const { hash } = await s.sender.send(review, 'approval');
  assert.equal((await s.sender.receipt(review, hash)).state, 'pending');
  // While the approval is pending, nothing else is offered on the origin: latest ≠ pending.
  const early = await s.sender.review(s.input);
  assert.equal(await codeOf(s.sender.send(early, 'approval')), 'pending_wallet_transaction');
  s.origin.include(hash);
  assert.equal((await s.sender.receipt(review, hash)).state, 'included', 'no finalized tag: included, never a failure');
  assert.equal(await codeOf(s.sender.receipt(review, `0x${'e'.repeat(64)}`)), 'receipt_not_from_this_review');
  // Once mined, a new review finds the allowance covered.
  assert.deepEqual((await s.sender.review(s.input)).plan.steps.map((step) => step.kind), ['deposit']);
  const f = lab({ chain: { mine: 'manual' } });
  const fr = await f.sender.review(f.input);
  const fs = await f.sender.send(fr, 'approval');
  f.origin.include(fs.hash);
  assert.equal((await f.sender.receipt(fr, fs.hash)).state, 'included', 'past the finalized block');
  f.origin.state.finalized = f.origin.state.head;
  assert.equal((await f.sender.receipt(fr, fs.hash)).state, 'finalized', 'then finalized, a state of its own');
  const r = lab({ chain: { mine: 'manual' } });
  const rr = await r.sender.review(r.input);
  r.origin.revertNext();
  const sent = await r.sender.send(rr, 'approval');
  r.origin.include(sent.hash);
  assert.equal((await r.sender.receipt(rr, sent.hash)).state, 'reverted');
  assert.equal(await codeOf(r.sender.send(rr, 'deposit')), 'approval_not_confirmed', 'a reverted approval lets no deposit go');
});

test('reads for the screens: balances and decimals only while the wallet is on that chain; a token without decimals() is null', async () => {
  const s = lab();
  s.origin.state.tokenBalances.set(OP_USDC, 123_456n);
  s.origin.state.decimals.set(OP_USDC, 6);
  assert.equal(await s.sender.balance(10, OP_USDC), '123456');
  assert.equal(await s.sender.balance(10, '0x0000000000000000000000000000000000000000'), (10n ** 18n).toString());
  assert.equal(await s.sender.decimals(10, OP_USDC), 6);
  assert.equal(await s.sender.decimals(10, ARB_USDC), null, 'no answer: unknown, never guessed');
  assert.equal(await codeOf(s.sender.balance(4663, OP_USDC)), 'wallet_wrong_chain', 'not read while the wallet is elsewhere');
});

test('the deposits’ journal: closed records only, newest first, at most eight per chain and owner, one entry per deposit', () => {
  const storage = memoryStorage();
  const journal = createDepositJournal(storage);
  const record = (i, extra = {}) => ({ provider: 'across', originChainId: 42161, destinationChainId: 4663, depositTxHash: `0x${String(i).padStart(64, '0')}`, requestId: null, lastState: null, ...extra });
  for (let i = 1; i <= DEPOSIT_JOURNAL_MAX + 2; i++) journal.put(OWNER, record(i));
  const kept = journal.list(4663, OWNER);
  assert.equal(kept.length, DEPOSIT_JOURNAL_MAX);
  assert.equal(kept[0].depositTxHash, record(DEPOSIT_JOURNAL_MAX + 2).depositTxHash, 'newest first');
  journal.put(OWNER, record(DEPOSIT_JOURNAL_MAX + 2, { lastState: 'pending' }));
  assert.equal(journal.list(4663, OWNER).filter((r) => r.depositTxHash === record(DEPOSIT_JOURNAL_MAX + 2).depositTxHash).length, 1, 'replaced, not added');
  assert.equal(journal.list(4663, OWNER)[0].lastState, 'pending');
  assert.deepEqual(journal.list(8453, OWNER), [], 'another destination is another list');
  assert.deepEqual(journal.list(4663, '0x9999999999999999999999999999999999999999'), [], 'another owner is another list');
  assert.throws(() => journal.put(OWNER, { ...record(1), amountRaw: '1' }), /invalid_journal_record/);
  journal.drop(OWNER, record(DEPOSIT_JOURNAL_MAX + 2));
  assert.equal(journal.list(4663, OWNER).length, DEPOSIT_JOURNAL_MAX - 1);
  // Anything else under the key is left out, never repaired.
  const key = depositJournalKey(4663, OWNER);
  storage.setItem(key, JSON.stringify([record(1), { ...record(2), extra: true }, 'x', record(3, { provider: 'other' })]));
  assert.deepEqual(journal.list(4663, OWNER).map((r) => r.depositTxHash), [record(1).depositTxHash]);
  storage.setItem(key, 'not json');
  assert.deepEqual(journal.list(4663, OWNER), []);
});

test('without a journal the deposit still goes, and says it was not kept', async () => {
  const s = lab({ journal: false });
  s.origin.state.allowances.set(`${OP_USDC}|${OWNER}|${DEPOSITORY}`, 100_000_000n);
  const sent = await s.sender.send(await s.sender.review(s.input), 'deposit');
  assert.equal(sent.journaled, false);
  assert.ok(sent.record);
});

// ---------------------------------------------------------------------------------------------------------------------
// Added 2026-10-06 (rugged's answer of 6 Oct: the owner revoked decision #15; F7 delta of 6 Oct §2): the exact approval
// and the deposit as ONE EIP-5792 batch where the wallet batches atomically on the origin
// ---------------------------------------------------------------------------------------------------------------------

/** The fake origin's first transaction hash (../support/s2-origin-chain.mjs): a step's, or a batch's one transaction. */
const FIRST_HASH = `0x${(0xa0).toString(16).padStart(64, '0')}`;

/** The lab above, on a wallet that batches on the origin (`atomic`), with every store in one storage, as a page keeps them. */
function batchLab({ atomic = 'supported', mine = 'instant', quote = optimismQuote() } = {}) {
  const origin = createOriginChain({ owner: OWNER, chainId: quote.request.originChainId, atomic, mine });
  const clock = { now: 1_000 };
  const storage = memoryStorage();
  const journal = createDepositJournal(storage);
  const unsettled = createUnsettledStore(storage);
  const batches = createBatchJournal(storage);
  const sender = createOriginSender(origin.wallet, { runtime, monoMs: () => clock.now, journal, unsettled, batches });
  return { origin, clock, storage, journal, unsettled, batches, sender, quote, input: { quote, timing: TIMING, source: 'http' } };
}
const quoteKey = (quote) => `${quote.requestFingerprint}:${quote.requestedAt}`;

test('batches: the wallet’s atomic status read on the ORIGIN chain; a wallet that states none, or only another chain’s, does not batch', async () => {
  const s = batchLab();
  const review = await s.sender.review(s.input);
  const asked = s.origin.mark();
  assert.equal(await s.sender.atomic(review), 'supported');
  assert.deepEqual(asked(), ['eth_accounts', 'eth_chainId', 'wallet_getCapabilities'], 'the account and the chain, then what the wallet can do there');
  const ready = batchLab({ atomic: 'ready' });
  assert.equal(await ready.sender.atomic(await ready.sender.review(ready.input)), 'ready', 'the wallet would first upgrade the account, and asks');
  const none = lab();
  assert.equal(await none.sender.atomic(await none.sender.review(none.input)), 'unsupported', 'no capabilities: steps one by one');
  const other = batchLab();
  const otherReview = await other.sender.review(other.input);
  other.origin.state.chainId = 42161;
  assert.equal(await codeOf(other.sender.atomic(otherReview)), 'wallet_wrong_chain', 'never read on another chain than the origin');
  assert.equal(await codeOf(other.sender.atomic({ ...otherReview })), 'review_required', 'only a review this sender issued');
});

test('batches: the exact approval and the deposit as ONE batch, exactly as quoted; kept until the wallet names its one transaction, the deposit’s', async () => {
  const s = batchLab({ mine: 'manual' });
  const review = await s.sender.review(s.input);
  assert.deepEqual(review.plan.steps.map((step) => step.kind), ['approval', 'deposit']);
  const asked = s.origin.mark();
  const entry = await s.sender.sendBatch(review);
  const methods = asked();
  assert.deepEqual(methods.filter((m) => ['eth_sendTransaction', 'eth_estimateGas', 'eth_simulateV1'].includes(m)), [], 'no transaction of its own, no estimate, no simulation: the wallet simulates');
  assert.equal(methods.filter((m) => m === 'wallet_sendCalls').length, 1, 'one batch');
  assert.equal(methods.at(-2), 'eth_chainId', 'the chain read last, right before the wallet');
  const [batch] = s.origin.state.batches;
  assert.deepEqual([batch.version, batch.atomicRequired, batch.chainId, batch.from], ['2.0.0', true, '0xa', OWNER], 'atomic required, on the origin, from the owner');
  // Both calls exactly as the quote gave them: the exact approval (never the unlimited one), then the deposit.
  assert.deepEqual(batch.calls, [
    { to: OP_USDC, data: s.quote.steps[0].transaction.data, value: '0x0' },
    { to: DEPOSITORY, data: s.quote.steps[1].transaction.data, value: '0x0' },
  ]);
  // Kept until the wallet names its transaction: the wallet's id, with the origin, the provider and Relay's request id.
  assert.deepEqual(entry, { originChainId: 10, destinationChainId: 4663, provider: 'relay', requestId: s.quote.candidates[0].tracking.requestId, batchId: 'batch-1', quote: quoteKey(s.quote), at: entry.at });
  assert.deepEqual(s.batches.list(OWNER), [entry]);
  const key = batchJournalKey(OWNER);
  assert.ok(key.startsWith(BATCH_JOURNAL_PREFIX) && !key.includes(OWNER.slice(2)), 'no address in the key');
  assert.doesNotMatch(s.storage.map.get(key), /100000000|0x095ea7b3|e8017952/i, 'no amount and no calldata kept');
  assert.deepEqual(s.journal.list(4663, OWNER), [], 'no deposit record before its transaction is known');
  assert.deepEqual([...s.origin.batchClaims.values()].map((claim) => claim.id), ['batch-1'], 'the page’s latch on the origin, with the wallet’s id');
  // Pending until mined; then the wallet names its one transaction: the deposit's.
  assert.deepEqual(await s.sender.batchStatus(entry), { state: 'pending' });
  s.origin.include(FIRST_HASH);
  const said = await s.sender.batchStatus(entry);
  assert.equal(said.state, 'sent');
  assert.deepEqual(said.sent, {
    hash: FIRST_HASH,
    journaled: true,
    record: { provider: 'relay', originChainId: 10, destinationChainId: 4663, depositTxHash: FIRST_HASH, requestId: s.quote.candidates[0].tracking.requestId, lastState: null },
  });
  assert.deepEqual(s.journal.list(4663, OWNER), [said.sent.record]);
  assert.deepEqual(s.batches.list(OWNER), [], 'the batch kept until then goes');
  assert.equal(s.origin.batchClaims.size, 0, 'and so does its latch');
  // Its receipt is read for the review it came from, as a step's; the wallet's own transaction is not matched to a step.
  assert.equal((await s.sender.receipt(review, FIRST_HASH)).state, 'included');
  // Never twice: not from that review, not from a new review of that quote.
  assert.equal(await codeOf(s.sender.sendBatch(review)), 'step_already_sent');
  assert.equal(await codeOf(s.sender.send(review, 'approval')), 'step_already_sent');
  assert.equal(await codeOf(s.sender.review(s.input)), 'deposit_already_offered');
  assert.equal(s.origin.state.sent.length, 0, 'never a transaction of its own');
});

test('batches: kept across a reload until the wallet names its transaction; nothing more on that origin meanwhile', async () => {
  const s = batchLab({ mine: 'manual' });
  const entry = await s.sender.sendBatch(await s.sender.review(s.input));
  // A reload: a new sender over the same storage finds the batch and that it is in flight on its origin.
  const reloaded = createOriginSender(s.origin.wallet, { runtime, monoMs: () => s.clock.now, journal: createDepositJournal(s.storage), unsettled: createUnsettledStore(s.storage), batches: createBatchJournal(s.storage) });
  const [kept] = createBatchJournal(s.storage).list(OWNER);
  assert.deepEqual(kept, entry);
  assert.equal(await codeOf(reloaded.review(s.input)), 'deposit_already_offered', 'its quote is sent');
  const next = { ...s.input, quote: laterQuote(s.quote) };
  assert.equal(await codeOf(reloaded.review(next)), 'pending_wallet_transaction', 'a batch in flight holds its origin');
  // Read on whichever chain the wallet is on: the wallet's status names no chain.
  s.origin.state.chainId = 4663;
  assert.deepEqual(await reloaded.batchStatus(kept), { state: 'pending' });
  s.origin.include(FIRST_HASH);
  const said = await reloaded.batchStatus(kept);
  assert.equal(said.state, 'sent');
  assert.equal(said.sent.record.depositTxHash, FIRST_HASH);
  assert.deepEqual(createDepositJournal(s.storage).list(4663, OWNER), [said.sent.record], 'the deposit followed from its record, after a reload too');
  assert.deepEqual(createBatchJournal(s.storage).list(OWNER), []);
  s.origin.state.chainId = 10;
  assert.deepEqual((await reloaded.review(next)).plan.steps.map((step) => step.kind), ['deposit'], 'the origin free again; the batch’s approval stands');
});

test('batches: a refusal in the wallet lets its claim go; that review offers nothing more, a new review of the quote can', async () => {
  const s = batchLab();
  const review = await s.sender.review(s.input);
  s.origin.state.nextBatch = 'refuse';
  assert.equal(await codeOf(s.sender.sendBatch(review)), 'declined');
  assert.equal(s.origin.batchClaims.size, 0, 'nothing of it can run: its claim goes');
  assert.deepEqual(s.batches.list(OWNER), []);
  assert.deepEqual(s.unsettled.list(OWNER), [], 'nothing held');
  assert.equal(await codeOf(s.sender.sendBatch(review)), 'step_already_sent');
  assert.equal(await codeOf(s.sender.send(review, 'approval')), 'step_already_sent');
  const entry = await s.sender.sendBatch(await s.sender.review(s.input));
  assert.equal(entry.batchId, 'batch-1');
});

test('batches: a wallet that cannot batch these calls (5700), or an account upgrade declined (5750), asked nothing that runs: the same review goes step by step', async () => {
  for (const [next, code] of [['unsupported', 'batch_unsupported'], ['upgrade-declined', 'batch_upgrade_declined']]) {
    const s = batchLab();
    const review = await s.sender.review(s.input);
    s.origin.state.nextBatch = next;
    assert.equal(await codeOf(s.sender.sendBatch(review)), code);
    assert.equal(s.origin.batchClaims.size, 0, `${next}: the claim goes`);
    assert.deepEqual(s.batches.list(OWNER), []);
    const approval = await s.sender.send(review, 'approval');
    assert.equal((await s.sender.receipt(review, approval.hash)).state, 'included');
    await s.sender.send(review, 'deposit');
    assert.deepEqual(s.origin.state.sent.map((tx) => tx.to), [OP_USDC, DEPOSITORY], `${next}: the two transactions of before`);
  }
  // A wallet handle with no batch latch never batches either.
  const s = batchLab();
  const sender = createOriginSender({ ...s.origin.wallet, claimBatch: undefined }, { runtime, monoMs: () => s.clock.now, journal: s.journal });
  const asked = s.origin.mark();
  assert.equal(await codeOf(sender.sendBatch(await sender.review(s.input))), 'batch_unsupported');
  assert.equal(asked().includes('wallet_sendCalls'), false);
});

test('batches: F1, a batch the wallet took whose answer was lost holds the origin as a step does, and is never offered again', async () => {
  const s = batchLab();
  const review = await s.sender.review(s.input);
  s.origin.state.nextBatch = 'lost';
  assert.equal(await codeOf(s.sender.sendBatch(review)), 'wallet_result_unknown');
  assert.deepEqual(s.unsettled.list(OWNER).map((o) => [o.originChainId, o.kind, o.nonce, o.state, o.quote]), [[10, 'deposit', '3', 'open', quoteKey(s.quote)]]);
  assert.equal(s.origin.batchClaims.size, 1, 'its latch kept: the wallet may run it');
  assert.equal(await codeOf(s.sender.review(s.input)), 'deposit_already_offered');
  // It ran (mined at once): the chain took the held nonce, so a new quote is told the deposit probably went.
  assert.equal(await codeOf(s.sender.review({ ...s.input, quote: laterQuote(s.quote) })), 'deposit_may_have_gone');
});

test('batches: not included (400) or reverted (500): nothing ran, it goes with its latch; a wallet that forgot it (5730): kept, unknown', async () => {
  for (const [status, reverted] of [[400, false], [500, true]]) {
    const s = batchLab({ mine: 'manual' });
    const entry = await s.sender.sendBatch(await s.sender.review(s.input));
    s.origin.state.batchStatus = status;
    assert.deepEqual(await s.sender.batchStatus(entry), { state: 'gone', reverted }, String(status));
    assert.deepEqual(s.batches.list(OWNER), []);
    assert.equal(s.origin.batchClaims.size, 0);
    assert.deepEqual(s.journal.list(4663, OWNER), [], 'no deposit to follow');
    // Nothing of it ran: a new review of that quote may offer it again while the quote is good.
    s.origin.state.batchStatus = null;
    s.origin.state.pending = s.origin.state.latest;
    assert.deepEqual((await s.sender.review(s.input)).plan.steps.map((step) => step.kind), ['approval', 'deposit']);
  }
  const s = batchLab({ mine: 'manual' });
  const entry = await s.sender.sendBatch(await s.sender.review(s.input));
  s.origin.state.forgetBatches = true;
  assert.deepEqual(await s.sender.batchStatus(entry), { state: 'unknown' });
  assert.deepEqual(s.batches.list(OWNER), [entry], 'kept, for the person to remove');
});

test('batches: only a review with both steps, and only while its quote is good; nothing is asked otherwise', async () => {
  const s = batchLab();
  covered(s);
  const alone = await s.sender.review(s.input);
  assert.deepEqual(alone.plan.steps.map((step) => step.kind), ['deposit'], 'the allowance covers the amount: the deposit alone');
  assert.equal(await codeOf(s.sender.sendBatch(alone)), 'step_not_in_plan');
  const native = batchLab({ quote: nativeQuote() });
  assert.equal(await codeOf(native.sender.sendBatch(await native.sender.review(native.input))), 'step_not_in_plan', 'native ETH: one transaction');
  const late = batchLab();
  const review = await late.sender.review(late.input);
  late.clock.now += 120_000;
  const asked = late.origin.mark();
  assert.equal(await codeOf(late.sender.sendBatch(review)), 'quote_expired');
  assert.deepEqual(asked(), [], 'refused before the wallet is asked anything');
  assert.equal(late.origin.batchClaims.size, 0);
});

test('batches kept: closed entries only, public data, at most eight per owner', () => {
  const storage = memoryStorage();
  const batches = createBatchJournal(storage);
  const entry = (i, extra = {}) => ({ originChainId: 42161, destinationChainId: 4663, provider: 'across', requestId: null, batchId: `id-${i}`, quote: `${'a'.repeat(64)}:${i}`, at: i, ...extra });
  for (let i = 1; i <= BATCH_JOURNAL_MAX + 2; i++) batches.put(OWNER, entry(i));
  const kept = createBatchJournal(storage).list(OWNER);
  assert.equal(kept.length, BATCH_JOURNAL_MAX);
  assert.equal(kept[0].batchId, `id-${BATCH_JOURNAL_MAX + 2}`, 'newest first');
  for (const bad of [{ amountRaw: '1' }, { provider: 'relay' }, { destinationChainId: 1 }, { batchId: 'a|b' }, { originChainId: 4663 }]) assert.equal(isPendingBatch(entry(1, bad)), false, JSON.stringify(bad));
  assert.throws(() => batches.put(OWNER, entry(1, { amountRaw: '1' })), /invalid_batch_entry/);
  batches.drop(OWNER, `id-${BATCH_JOURNAL_MAX + 2}`);
  assert.equal(createBatchJournal(storage).list(OWNER).length, BATCH_JOURNAL_MAX - 1);
  storage.setItem(batchJournalKey(OWNER), JSON.stringify([entry(1), { ...entry(2), extra: true }, 'x']));
  assert.deepEqual(createBatchJournal(storage).list(OWNER).map((e) => e.batchId), ['id-1'], 'anything else is left out, never repaired');
});

// ---------------------------------------------------------------------------------------------------------------------
// Added 2026-11-02 (review A2, REVISAO_DINHEIRO_LOGIN.md: "Bring funds: an uncertain wallet answer leaves the transfer with
// no way out"). A step was held only once its answer came back lost, so a reload or a closed tab during the prompt left
// an open request with no record, and "I cancelled the request in my wallet" answered "may still be pending" for good;
// an approval the chain then took answered `passed`, and so did a deposit once (`none` after). A step is held before the
// wallet is asked now, let go once the wallet answers, and every answer to the person's word says what may happen next.
// ---------------------------------------------------------------------------------------------------------------------

/** A wallet whose send the test answers itself, for a prompt still open (or closed after its window). */
function heldPrompt(origin) {
  const answer = { asked: false };
  const wallet = { ...origin.wallet, request: (method, params) => method === 'eth_sendTransaction'
    ? new Promise((resolve, reject) => { answer.asked = true; answer.resolve = resolve; answer.reject = reject; })
    : origin.wallet.request(method, params) };
  return { wallet, answer };
}
const until = async (check) => {
  for (let i = 0; i < 500 && !check(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(check(), 'reached');
};

test('A2: a step is held before the wallet is asked: a reload during the prompt finds it, and the person’s word lets it go while its nonce is free', async () => {
  for (const kind of ['approval', 'deposit']) {
    const storage = memoryStorage();
    const s = lab();
    if (kind === 'deposit') covered(s);
    const { wallet, answer } = heldPrompt(s.origin);
    const sender = createOriginSender(wallet, { runtime, monoMs: () => s.clock.now, journal: s.journal, unsettled: createUnsettledStore(storage) });
    const sending = sender.send(await sender.review(s.input), kind).catch((error) => error);
    await until(() => answer.asked);
    // The page is reloaded while the wallet shows the request.
    assert.deepEqual(createUnsettledStore(storage).list(OWNER).map((o) => [o.originChainId, o.kind, o.nonce, o.state]), [[10, kind, '3', 'open']], `${kind}: held before the wallet answered`);
    const reloaded = createOriginSender(s.origin.wallet, { runtime, monoMs: () => s.clock.now, journal: s.journal, unsettled: createUnsettledStore(storage) });
    assert.equal(await codeOf(reloaded.review({ ...s.input, quote: laterQuote(s.quote) })), 'wallet_request_open', 'nothing more is offered there meanwhile');
    assert.equal(await reloaded.forgetUnsettled(10), 'forgotten', 'its nonce is still free: the person’s word lets it go');
    assert.deepEqual(createUnsettledStore(storage).list(OWNER), []);
    answer.reject(Object.assign(new Error('User rejected the request.'), { code: 4001 }));
    await sending;
    assert.equal(s.origin.state.sent.length, 0);
  }
});

test('A2: the hold goes once the wallet answers: a hash, a refusal, a refusal after its window, or nothing asked', async () => {
  const fresh = () => {
    const s = lab();
    const unsettled = createUnsettledStore(null);
    return { s, unsettled, sender: createOriginSender(s.origin.wallet, { runtime, monoMs: () => s.clock.now, journal: s.journal, unsettled }) };
  };
  const a = fresh();
  await a.sender.send(await a.sender.review(a.s.input), 'approval');
  assert.deepEqual(a.unsettled.list(OWNER), [], 'a hash: the step is followed by it');
  const b = fresh();
  b.s.origin.state.nextSend = 'refuse';
  assert.equal(await codeOf(b.sender.send(await b.sender.review(b.s.input), 'approval')), 'declined');
  assert.deepEqual(b.unsettled.list(OWNER), [], 'a refusal: nothing was sent');
  // The window closes first (0.8 s left on the quote): held, as an unknown outcome; the wallet's refusal comes after.
  const c = lab();
  c.clock.now = 120_000 - SEND_MARGIN_MS - 800;
  const { wallet, answer } = heldPrompt(c.origin);
  const unsettled = createUnsettledStore(null);
  const sender = createOriginSender(wallet, { runtime, monoMs: () => c.clock.now, journal: c.journal, unsettled });
  assert.equal(await codeOf(sender.send(await sender.review(c.input), 'approval')), 'wallet_result_unknown');
  assert.deepEqual(unsettled.list(OWNER).map((o) => o.state), ['open'], 'held while the wallet may still send it');
  answer.reject(Object.assign(new Error('User rejected the request.'), { code: 4001 }));
  await until(() => unsettled.list(OWNER).length === 0);
  assert.equal(c.origin.claims.size, 0, 'and its claim');
  // The port refuses the send itself before the provider is invoked (its window closed after the last chain read, F9):
  // the wallet never saw it.
  const d = lab();
  const wall = { now: 1_000_000 };
  const held = createUnsettledStore(null);
  const request = d.origin.wallet.request;
  const late = { ...d.origin.wallet, request: async (method, params) => {
    const reply = await request(method, params);
    if (method === 'eth_chainId' && d.origin.claims.size > 0) wall.now += 1_000;
    return reply;
  } };
  const port = createOriginSender(late, { runtime, monoMs: () => d.clock.now, journal: d.journal, unsettled: held, now: () => wall.now });
  assert.equal(await codeOf(port.send(await port.review(d.input), 'approval')), 'wallet_action_expired');
  assert.ok(!d.origin.state.asked.includes('eth_sendTransaction'));
  assert.deepEqual(held.list(OWNER), [], 'nothing asked: nothing held');
});

test('A2: an approval the chain took after its answer was lost settles on the person’s word: its deposit was never sent, and may be reviewed again', async () => {
  const s = lab();
  const unsettled = createUnsettledStore(null);
  const sender = createOriginSender(s.origin.wallet, { runtime, monoMs: () => s.clock.now, journal: s.journal, unsettled });
  s.origin.state.nextSend = 'broadcast-lost';
  assert.equal(await codeOf(sender.send(await sender.review(s.input), 'approval')), 'wallet_result_unknown');
  assert.equal(s.origin.state.sent.length, 1, 'the wallet sent it after all, and the chain took its nonce');
  assert.equal(await sender.forgetUnsettled(10), 'settled');
  assert.deepEqual(unsettled.list(OWNER), []);
  assert.equal(await sender.forgetUnsettled(10), 'none', 'nothing held there any more');
  const again = await sender.review({ ...s.input, quote: laterQuote(s.quote) });
  assert.deepEqual(again.plan.steps.map((step) => step.kind), ['deposit'], 'the allowance is on chain: the deposit goes alone');
});

test('A2: a deposit the chain may have taken answers passed every time the person asks, never none; a batch in flight answers pending', async () => {
  const s = lab();
  const unsettled = createUnsettledStore(null);
  const sender = createOriginSender(s.origin.wallet, { runtime, monoMs: () => s.clock.now, journal: s.journal, unsettled });
  covered(s);
  s.origin.state.nextSend = 'broadcast-lost';
  assert.equal(await codeOf(sender.send(await sender.review(s.input), 'deposit')), 'wallet_result_unknown');
  assert.equal(await sender.forgetUnsettled(10), 'passed');
  const asked = s.origin.mark();
  assert.equal(await sender.forgetUnsettled(10), 'passed', 'once marked it answered none, as if nothing were held');
  assert.deepEqual(asked(), [], 'said from the hold, without asking the wallet');
  assert.deepEqual(unsettled.list(OWNER).map((o) => [o.kind, o.state]), [['deposit', 'passed']]);
  // A deliberate new deposit from there (another quote) keeps that hold in place while it is asked, and takes its place
  // only when its own answer is lost, as before.
  const next = { ...s.input, quote: laterQuote(s.quote) };
  await sender.send(await sender.review(next), 'deposit');
  assert.deepEqual(unsettled.list(OWNER).map((o) => [o.kind, o.state, o.nonce]), [['deposit', 'passed', '3']], 'its answer came: the earlier hold stays');
  s.origin.state.nextSend = 'unknown';
  assert.equal(await codeOf(sender.send(await sender.review({ ...s.input, quote: laterQuote(s.quote, 60) }), 'deposit')), 'wallet_result_unknown');
  assert.deepEqual(unsettled.list(OWNER).map((o) => [o.kind, o.state, o.nonce]), [['deposit', 'open', '5']], 'lost: held open in its place');
  const b = batchLab({ mine: 'manual' });
  await b.sender.sendBatch(await b.sender.review(b.input));
  assert.deepEqual(b.unsettled.list(OWNER), [], 'a batch the wallet took is kept among the batches, not held');
  assert.equal(await b.sender.forgetUnsettled(10), 'pending', 'it is in flight: the person’s word cannot settle it');
});

test('A2: a batch is held before the wallet is asked, and kept among the batches once the wallet names it', async () => {
  const s = batchLab({ mine: 'manual' });
  const review = await s.sender.review(s.input);
  s.origin.state.nextBatch = 'wait';
  const sending = s.sender.sendBatch(review);
  await until(() => typeof s.origin.state.answerBatch === 'function');
  assert.deepEqual(createUnsettledStore(s.storage).list(OWNER).map((o) => [o.kind, o.nonce, o.state]), [['deposit', '3', 'open']], 'a reload during the prompt still knows it');
  s.origin.state.answerBatch();
  const entry = await sending;
  assert.deepEqual(s.unsettled.list(OWNER), []);
  assert.deepEqual(s.batches.list(OWNER), [entry]);
});
