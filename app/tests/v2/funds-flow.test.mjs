/**
 * The inline offer's deposit steps (src/v2in/funds/flow.ts, spec F7 §3.6), copied from the rejected #/v2 section, run
 * again here over the real closed sender (src/finance/v2/crosschain.ts) and a fake origin chain: a fixture quote stops
 * before the wallet is asked anything; a live quote goes switch → review → exact approval → its receipt (a delay is
 * never a failure) → the quote checked again → the deposit, two transactions and never a batch; each stop names its
 * step and nothing is ever sent twice. The fixtures are re-addressed HERE only, to drive the sender as a live quote would.
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

function lab({ quote = asOwner(fixture('responses/quote.json').quote), walletOn = 4663, switchTo = 'switched', mine = 'instant', source = 'http' } = {}) {
  const origin = createOriginChain({ owner: OWNER, chainId: walletOn, mine });
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
