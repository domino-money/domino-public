/**
 * The inline offer's deposit steps (src/v2in/funds/flow.ts, spec F7 §3.6), copied from the rejected #/v2 section, run
 * again here over the real closed sender (src/finance/v2/crosschain.ts) and a fake origin chain: a fixture quote stops
 * before the wallet is asked anything; a live quote goes switch → review → exact approval → its receipt (a delay is
 * never a failure) → the quote checked again → the deposit, two transactions and never a batch; each stop names its
 * step and nothing is ever sent twice. The fixtures are re-addressed HERE only, to drive the sender as a live quote would.
 * Changed on purpose 2026-10-06 (rugged's answer of 6 Oct: the owner revoked decision #15; F7 delta of 6 Oct §2): where
 * the wallet batches on the origin, the approval and the deposit in ONE batch, followed until the wallet names its one
 * transaction, the deposit's; the two transactions of before everywhere else.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { createOriginChain, memoryStorage } from '../support/s2-origin-chain.mjs';
import { fixture, runtime } from './support/crosschain.mjs';

const require = createRequire(import.meta.url);
const { createOriginSender, createDepositJournal } = require('../../.test-build/app/src/finance/v2/crosschain.js');
const { runDeposit } = require('../../.test-build/app/src/v2in/funds/flow.js');

const OWNER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const asOwner = (value) => JSON.parse(JSON.stringify(value).replaceAll('0x1111111111111111111111111111111111111111', OWNER));
const TIMING = { sentMono: 0, receivedMono: 0 };
/** The fake chain's first transaction hash (tests/support/s2-origin-chain.mjs). */
const FIRST_HASH = `0x${(0xa0).toString(16).padStart(64, '0')}`;

function lab({ quote = asOwner(fixture('responses/quote.json').quote), walletOn = 4663, switchTo = 'switched', mine = 'instant', source = 'http', atomic = null } = {}) {
  const origin = createOriginChain({ owner: OWNER, chainId: walletOn, mine, atomic });
  const clock = { now: 1_000 };
  const journal = createDepositJournal(memoryStorage());
  const sender = createOriginSender(origin.wallet, { runtime, monoMs: () => clock.now, journal });
  const stages = [];
  const switches = [];
  let waits = 0;
  const deps = {
    runtime,
    owner: OWNER,
    sender,
    async switchToOrigin(chainId) {
      switches.push(chainId);
      if (switchTo === 'switched') origin.state.chainId = chainId;
      return switchTo;
    },
    walletChainId: () => origin.state.chainId,
    monoMs: () => clock.now,
    async wait() {
      waits += 1;
      if (waits === 3) origin.include(FIRST_HASH);
    },
    aborted: () => false,
    receiptPollMs: 1,
  };
  const run = () => runDeposit(deps, { quote, timing: TIMING, source }, (stage) => stages.push(stage.stage));
  return { origin, clock, journal, deps, stages, switches, run, quote, waits: () => waits };
}

test('a fixture quote (the preview\'s) stops at once: no switch, no wallet request, nothing sent', async () => {
  const s = lab({ source: 'fixture' });
  assert.deepEqual(await s.run(), { kind: 'synthetic' });
  assert.deepEqual(s.switches, []);
  assert.deepEqual(s.origin.state.asked, []);
  assert.deepEqual(s.stages, []);
});

test('the preview\'s quote as written (about the test wallet) gives no step for the connected wallet, and asks nothing', async () => {
  const s = lab({ quote: fixture('responses/quote.json').quote, source: 'fixture' });
  assert.deepEqual(await s.run(), { kind: 'not_sendable', reason: 'owner' });
  assert.deepEqual(s.origin.state.asked, []);
});

test('the whole way on a live quote: switch, exact approval, its receipt after a wait, then the deposit; its record kept', async () => {
  const s = lab({ mine: 'manual' });
  const outcome = await s.run();
  assert.equal(outcome.kind, 'sent');
  assert.deepEqual(s.switches, [42161]);
  assert.deepEqual(s.stages, ['switching', 'reviewing', 'approval_wallet', 'approval_sent', 'approval_done', 'deposit_wallet']);
  assert.ok(s.waits() >= 3, 'pending for a while: waited, not failed');
  assert.deepEqual(s.origin.state.sent.map((tx) => tx.to), [s.quote.steps[0].transaction.to, s.quote.steps[1].transaction.to], 'two transactions, in order');
  assert.deepEqual(s.journal.list(4663, OWNER), [outcome.sent.record]);
});

test('already on the origin with the allowance covered: no switch, no approval', async () => {
  const s = lab({ walletOn: 42161 });
  s.origin.state.allowances.set(`${s.quote.steps[0].approval.token}|${OWNER}|${s.quote.steps[0].approval.spender}`, 100_000_000n);
  assert.equal((await s.run()).kind, 'sent');
  assert.deepEqual(s.switches, []);
  assert.deepEqual(s.stages, ['reviewing', 'approval_skipped', 'deposit_wallet']);
  assert.equal(s.origin.state.sent.length, 1);
});

test('the switch refused: nothing read, nothing sent', async () => {
  for (const outcome of ['unknown_chain', 'user_rejected', 'pending', 'error']) {
    const s = lab({ switchTo: outcome });
    assert.deepEqual(await s.run(), { kind: 'switch', outcome });
    assert.deepEqual(s.origin.state.asked, []);
  }
});

test('the quote expires while the approval is mined: a new quote is due, the deposit unsent', async () => {
  const s = lab({ walletOn: 42161, mine: 'manual' });
  s.deps.wait = async () => {
    s.clock.now = 110_000;
    s.origin.include(FIRST_HASH);
  };
  assert.deepEqual(await s.run(), { kind: 'expired', approved: true });
  assert.equal(s.origin.state.sent.length, 1, 'the approval only');
});

test('a refusal stops at its step; an unknown outcome holds the deposit as sent: never offered twice', async () => {
  const s = lab({ walletOn: 42161 });
  s.origin.state.nextSend = 'refuse';
  assert.deepEqual(await s.run(), { kind: 'error', step: 'approval', code: 'declined', hash: null, offered: false });
  const u = lab({ walletOn: 42161 });
  u.origin.state.allowances.set(`${u.quote.steps[0].approval.token}|${OWNER}|${u.quote.steps[0].approval.spender}`, 100_000_000n);
  u.origin.state.nextSend = 'unknown';
  assert.deepEqual(await u.run(), { kind: 'error', step: 'deposit', code: 'wallet_result_unknown', hash: null, offered: true });
  assert.equal((await u.run()).code, 'deposit_already_offered');
  assert.equal(u.origin.state.sent.length, 0);
});

test('an approval included and reverted stops before the deposit; a quote with no decision gives no step', async () => {
  const s = lab({ walletOn: 42161 });
  s.origin.revertNext();
  assert.equal((await s.run()).kind, 'approval_reverted');
  assert.equal(s.origin.state.sent.length, 1);
  const none = lab({ quote: asOwner(fixture('variants/quote.none.json').quote) });
  assert.deepEqual(await none.run(), { kind: 'not_sendable', reason: 'no_decision' });
  assert.deepEqual(none.origin.state.asked, []);
});

// ---------------------------------------------------------------------------------------------------------------------
// Added 2026-10-06 (rugged's answer of 6 Oct: the owner revoked decision #15; F7 delta of 6 Oct §2, steps 1 to 7)
// ---------------------------------------------------------------------------------------------------------------------

const allowanceKey = (quote) => `${quote.steps[0].approval.token}|${OWNER}|${quote.steps[0].approval.spender}`;

test('a wallet that batches on the origin: the approval and the deposit in ONE confirmation, followed until the wallet names its transaction, the deposit’s', async () => {
  for (const atomic of ['supported', 'ready']) {
    const s = lab({ atomic, mine: 'manual' });
    const outcome = await s.run();
    assert.equal(outcome.kind, 'sent', atomic);
    assert.deepEqual(s.switches, [42161]);
    assert.deepEqual(s.stages, ['switching', 'reviewing', 'batch_wallet', 'batch_sent'], `${atomic}: one confirmation, then its transaction waited for`);
    assert.ok(s.waits() >= 3, 'pending a while: waited, not failed');
    assert.deepEqual(s.origin.state.sent, [], 'no transaction of its own');
    const [batch] = s.origin.state.batches;
    assert.deepEqual(batch.calls.map((call) => [call.to, call.data, call.value]), s.quote.steps.map((step) => [step.transaction.to, step.transaction.data, '0x0']), 'the exact approval and the deposit, exactly as quoted');
    assert.equal(outcome.sent.hash, FIRST_HASH, 'the deposit’s transaction is the batch’s one transaction');
    assert.equal(outcome.sent.record.depositTxHash, FIRST_HASH);
    assert.deepEqual(s.journal.list(4663, OWNER), [outcome.sent.record], 'tracking starts from it');
  }
});

test('the allowance already covers the amount: the deposit alone, one transaction, the wallet’s batching not even asked; native ETH the same', async () => {
  const s = lab({ walletOn: 42161, atomic: 'supported' });
  s.origin.state.allowances.set(allowanceKey(s.quote), 100_000_000n);
  const asked = s.origin.mark();
  assert.equal((await s.run()).kind, 'sent');
  assert.deepEqual(s.stages, ['reviewing', 'approval_skipped', 'deposit_wallet']);
  assert.equal(s.origin.state.sent.length, 1);
  assert.deepEqual(asked().filter((method) => method.startsWith('wallet_')), [], 'no batch, no capabilities read');
  const n = lab({ walletOn: 42161, atomic: 'supported', quote: asOwner(fixture('variants/quote.native-only-across.json').quote) });
  assert.equal((await n.run()).kind, 'sent');
  assert.deepEqual(n.stages, ['reviewing', 'approval_skipped', 'deposit_wallet']);
  assert.deepEqual(n.origin.state.batches, []);
  assert.equal(n.origin.state.sent.length, 1);
});

test('a wallet that does not batch, one that cannot run this batch after all, or an account upgrade declined: the two transactions of before', async () => {
  for (const [atomic, next] of [[null, null], ['supported', 'unsupported'], ['ready', 'upgrade-declined']]) {
    const s = lab({ walletOn: 42161, atomic });
    s.origin.state.nextBatch = next;
    assert.equal((await s.run()).kind, 'sent', String(next));
    assert.deepEqual(s.stages, [...(next ? ['reviewing', 'batch_wallet'] : ['reviewing']), 'approval_wallet', 'approval_sent', 'approval_done', 'deposit_wallet']);
    assert.deepEqual(s.origin.state.sent.map((tx) => tx.to), [s.quote.steps[0].transaction.to, s.quote.steps[1].transaction.to], 'approval, then deposit');
    assert.deepEqual(s.origin.state.batches, []);
  }
});

test('a batch refused stops at the deposit; one not included or reverted says nothing ran; an answer lost, or a batch the wallet forgot, counts as sent', async () => {
  const r = lab({ walletOn: 42161, atomic: 'supported' });
  r.origin.state.nextBatch = 'refuse';
  assert.deepEqual(await r.run(), { kind: 'error', step: 'deposit', code: 'declined', hash: null, offered: false });
  for (const [status, code] of [[400, 'batch_not_included'], [500, 'batch_reverted']]) {
    const g = lab({ walletOn: 42161, atomic: 'supported', mine: 'manual' });
    g.origin.state.batchStatus = status;
    assert.deepEqual(await g.run(), { kind: 'error', step: 'deposit', code, hash: null, offered: false });
    assert.deepEqual(g.journal.list(4663, OWNER), []);
  }
  const u = lab({ walletOn: 42161, atomic: 'supported' });
  u.origin.state.nextBatch = 'lost';
  assert.deepEqual(await u.run(), { kind: 'error', step: 'deposit', code: 'wallet_result_unknown', hash: null, offered: true });
  assert.equal((await u.run()).code, 'deposit_already_offered', 'never offered twice');
  const f = lab({ walletOn: 42161, atomic: 'supported', mine: 'manual' });
  f.origin.state.forgetBatches = true;
  assert.deepEqual(await f.run(), { kind: 'error', step: 'deposit', code: 'batch_unknown', hash: null, offered: true });
});

test('before the batch is offered, a quote past its deadline asks for a new one: nothing asked of the wallet', async () => {
  const s = lab({ walletOn: 42161, atomic: 'supported' });
  const { review } = s.deps.sender;
  s.deps.sender = {
    ...s.deps.sender,
    review: async (input) => {
      const reviewed = await review(input);
      s.clock.now = 110_000;
      return reviewed;
    },
  };
  const asked = s.origin.mark();
  assert.deepEqual(await s.run(), { kind: 'expired', approved: false });
  assert.deepEqual(asked().filter((method) => method.startsWith('wallet_') || method === 'eth_sendTransaction'), []);
  assert.deepEqual(s.stages, ['reviewing']);
});

// Added 2026-11-09 (core flows, the owner: nothing may load forever): a batch the wallet took is followed at a pace that
// slows down, and after FUNDS_BATCH_FOLLOW_MS with no transaction named the run hands it over (`batch_slow`, offered, so its
// deposit is never offered again while its result is unknown) to the offer's card for it, which goes on asking.
test('a batch the wallet took and has not sent after three minutes is handed over as offered, never followed for good', async () => {
  const { FUNDS_BATCH_FOLLOW_MS, FUNDS_BATCH_POLL_MAX_MS, batchPollMs } = require('../../.test-build/app/src/v2in/funds/constants.js');
  assert.equal(FUNDS_BATCH_FOLLOW_MS, 180_000);
  assert.deepEqual([0, 59_999, 60_000, 120_000, 180_000, 240_000, 600_000].map((ms) => batchPollMs(ms)), [3_000, 3_000, 6_000, 12_000, 24_000, FUNDS_BATCH_POLL_MAX_MS, FUNDS_BATCH_POLL_MAX_MS]);
  const s = lab({ walletOn: 42161, atomic: 'supported', mine: 'manual' });
  const waited = [];
  s.deps.wait = async (ms) => { waited.push(ms); s.clock.now += 30_000; };
  assert.deepEqual(await s.run(), { kind: 'error', step: 'deposit', code: 'batch_slow', hash: null, offered: true });
  assert.deepEqual(waited, [1, 1, 2, 2, 4, 4, 8], 'the flow’s own pace through the first minute, then slower');
  assert.ok(s.stages.includes('batch_sent'));
  assert.equal(s.origin.state.batches.length, 1, 'one batch, never offered again');
});
