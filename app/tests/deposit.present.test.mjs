/**
 * What each deposit operation looks like (#40/#44): every package variant and
 * every derived fixture through presentOperation. Nitro gas as gross with L1
 * inside it (null L1 is unknown, "0" is zero), the evidence basis of the
 * received amounts (unqualified is unknown, never zero), exceeded limits,
 * recovery and cancellation copy, conflicts over any state, attention as
 * support-required, and Check allowances wherever there is history.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build, clone, depositRuntime as runtime, depositSource, fixture } from './support/consumer-fakes.mjs';

const { presentOperation, presentAllowances, handoffStatus, presentListItem, tokenAmount, tokenName } = build('deposit/present');
const { DERIVED, VARIANTS } = build('deposit/fixtures/derive');
const { BASIS, PREPARE_OFF_WITHOUT_HANDOFF, LATCH_COPY, SUPPORT_REQUIRED, STATE_LABEL, failureCopy } = build('deposit/copy');
const { DEPOSIT_ERROR_UI } = build('deposit/errors');

const FRESH = { monoNowMs: 5_000, walletStepDeadlineMono: 25_000, issueWalletStepAllowed: true, latched: false, busy: false };
const variant = (name) => fixture('deposit-v1', `variants/${name}.json`);
const present = (body, ctx = {}) => presentOperation(body.operation, body.walletStep, { ...FRESH, ...ctx });
const actionIds = (view) => view.actions.map((action) => action.id);
const allText = (view) => JSON.stringify(view);

const EXPECTED = {
  cancelled: ['cancelled_clean', 'Cancelled before any wallet step'],
  confirmed: ['confirmed', 'Position #7 created'],
  erc20_approval: ['step_ready', 'Wallet step ready to review'],
  erc20_reset: ['step_ready', 'Wallet step ready to review'],
  fee_cap_breach: ['confirmed', 'Position #7 created'],
  legacy_receipt: ['confirmed', 'Position #7 created'],
  mint: ['step_ready', 'Wallet step ready to review'],
  native: ['step_ready', 'Wallet step ready to review'],
  partial_allowances: ['draft_new', 'Draft saved'],
  pending: ['pending', 'Submitted, waiting for finalization'],
  permit2_approval: ['step_ready', 'Wallet step ready to review'],
  'proxy-event-amounts': ['confirmed', 'Position #7 created'],
  reported_nonce_conflict: ['attention_conflict', 'Needs attention'],
  'reviewed-proxy': ['step_ready', 'Wallet step ready to review'],
  superseded: ['superseded', 'Replaced by another transaction'],
  'token-review-changed': ['confirmed', 'Position #7 created'],
};

test('each of the 16 package variants renders its state (T5)', () => {
  assert.deepEqual([...VARIANTS].sort(), Object.keys(EXPECTED).sort());
  for (const name of VARIANTS) {
    const view = present(variant(name));
    assert.deepEqual([view.kind, view.title], EXPECTED[name], name);
    assert.ok(view.facts.includes('Your wallet sends every transaction. Depositing starts no automation.'), name);
    assert.doesNotMatch(allText(view), /\bv4\b|No server broadcast|not enabled|aren't enabled|isn't enabled/i, name);
  }
});

const DERIVED_KIND = {
  reverted: 'reverted',
  cancel_requested: 'cancel_requested',
  cancel_requested_conflict: 'cancel_requested_support',
  cancel_requested_unresolved: 'cancel_requested_support',
  cancel_requested_reorged: 'cancel_requested_reorg',
  pending_not_found: 'pending',
  attention_reorged: 'attention_reorg',
  attention_transient: 'attention_generic',
  attention_approval_unqualified: 'attention_generic',
  draft_after_approval: 'draft_progress',
  cancelled_after_steps: 'cancelled_after_steps',
  pending_provisional: 'pending',
  owner_unavailable: 'confirmed',
  l1_null: 'confirmed',
  l1_zero: 'confirmed',
  basis_token_review_unavailable: 'confirmed',
  basis_legacy_unqualified: 'confirmed',
  basis_native_net_unavailable: 'confirmed',
  single_breach: 'confirmed',
  awaiting_via_get: 'step_reserved',
};

test('every derived fixture passes the pinned runtime and renders its state (T21)', () => {
  assert.deepEqual(Object.keys(DERIVED).sort(), Object.keys(DERIVED_KIND).sort());
  for (const [id, { build: make }] of Object.entries(DERIVED)) {
    const body = make(depositSource);
    assert.ok(runtime.validateResponse('get', body), `${id} passes the runtime`);
    assert.equal(present(body).kind, DERIVED_KIND[id], id);
  }
});

test('a prepared mint shows exact fields, the max network fee 220000 x 150, and no send control (DP-4, GAS-6)', () => {
  const view = present(variant('mint'));
  assert.equal(view.step.selector, 'PositionManager modifyLiquidities');
  const gas = Object.fromEntries(view.step.gas.map((fact) => [fact.label, fact]));
  assert.equal(gas['Max network fee for this step'].value, '33,000,000 wei (0.000000000033 ETH)');
  assert.match(gas['Max network fee for this step'].note, /already includes L1/);
  assert.match(gas['Estimated gas'].note, /not a guarantee/);
  assert.match(view.step.lines.join(' '), /ticks -120 to 180\. Maximum token0 101, token1 202/);
  assert.match(view.step.lines.join(' '), /about 30 s from when it was prepared/);
  assert.equal(view.step.native, null);
  assert.deepEqual(actionIds(view), ['report', 'cancel', 'check_allowances']);
  assert.ok(!/\bsend\b/i.test(view.actions.map((action) => action.label).join(' ')), 'no Send action exists');
  assert.match(handoffStatus(variant('mint').operation), /Wallet sending isn't available in this build\. Nothing has been sent\. Nonce 5 stays reserved/);
});

test('native and approval steps say exactly what they would do, with no call syntax', () => {
  const native = present(variant('native'));
  assert.match(native.step.lines.join(' '), /Sends 101 wei ETH as principal, plus network gas/);
  assert.deepEqual(native.step.native.map((fact) => fact.label), ['Planned native deposit', 'Selected gas reserve', 'Step max network fee']);
  assert.match(present(variant('erc20_reset')).step.lines[0], /^Reset the ERC-20 allowance 0x2222222222222222222222222222222222222222 gives Permit2 \(0x000000…c78ba3\) to 0/);
  assert.match(present(variant('erc20_approval')).step.lines[0], /^Approve exactly \S+ raw units of 0x2222222222222222222222222222222222222222 to Permit2.*never unlimited/);
  assert.match(present(variant('permit2_approval')).step.lines[0], /^Allow the Uniswap PositionManager .* through Permit2, until 20\d\d-\d\d-\d\d \d\d:\d\d:\d\d UTC/);
  assert.match(present(variant('reviewed-proxy')).step.admission, /^Reviewed upgradeable token .*upgrade, pause or freeze/);
  for (const name of ['erc20_reset', 'erc20_approval', 'permit2_approval', 'mint', 'native']) assert.doesNotMatch(allText(present(variant(name))), /approve\s*\(/, name);
});

test('the same step past its handoff window is expired, with the reservation held (T15)', () => {
  const view = present(variant('mint'), { monoNowMs: 25_000 });
  assert.equal(view.kind, 'handoff_expired');
  assert.match(view.body[0], /Nonce 5 stays reserved on the server until a transaction at that nonce finalizes/);
  assert.equal(view.step, null);
  assert.deepEqual(actionIds(view), ['check_status', 'report', 'cancel', 'check_allowances']);
});

test('a step with no deadline this page set (a re-delivery after a reload) is never fresh or offered for review (rugged97, P2 on #72)', () => {
  const view = present(variant('mint'), { walletStepDeadlineMono: null });
  assert.equal(view.kind, 'handoff_unconfirmed');
  assert.equal(view.step, null);
  assert.match(view.body[0], /issued at 2027-01-15 \d\d:\d\d:\d\d UTC, before this page asked for it\. This page can't tell how much of its validity is left/);
  assert.match(view.body[0], /Nonce 5 stays reserved on the server until a transaction at that nonce finalizes/);
  assert.deepEqual(actionIds(view), ['check_status', 'report', 'cancel', 'check_allowances']);
  assert.equal(present(variant('mint'), { walletStepDeadlineMono: 25_000, monoNowMs: 25_000 }).kind, 'handoff_expired', 'a known deadline that passed is expired');
});

test('a reserved slot read back without its step: fixed UTC issue time, Re-open only when a step may be issued (DP-14, R#7)', () => {
  const body = DERIVED.awaiting_via_get.build(depositSource);
  const view = present(body);
  assert.equal(view.kind, 'step_reserved');
  assert.match(view.body[0], /was issued at 2027-01-15 \d\d:\d\d:\d\d UTC/);
  assert.doesNotMatch(view.body[0], /\bago\b/);
  assert.equal(view.actions.find((action) => action.id === 'reopen').enabled, true);
  const off = present(body, { issueWalletStepAllowed: false }).actions.find((action) => action.id === 'reopen');
  assert.deepEqual([off.enabled, off.reason], [false, PREPARE_OFF_WITHOUT_HANDOFF]);
  const latched = present(body, { latched: true }).actions.find((action) => action.id === 'reopen');
  assert.deepEqual([latched.enabled, latched.reason], [false, LATCH_COPY]);
});

test('Nitro gas: gross with L1 inside it, null L1 unknown, "0" L1 zero, net cost never derived (T6, GAS-1 to GAS-4)', () => {
  const gas = (body) => Object.fromEntries(present(body).receipt.gas.map((fact) => [fact.label, fact]));
  const confirmed = gas(variant('confirmed'));
  assert.equal(confirmed['Gross gas charge'].value, '10,000,000 wei (0.00000000001 ETH)');
  assert.equal(confirmed['Of which data-posting (L1), included above'].value, '1,000,000 wei (0.000000000001 ETH)');
  assert.deepEqual([confirmed['Net cost after refunds'].value, confirmed['Net cost after refunds'].unknown], ['Not available', true]);
  const legacy = gas(DERIVED.l1_null.build(depositSource));
  assert.deepEqual([legacy['Of which data-posting (L1), included above'].value, legacy['Of which data-posting (L1), included above'].unknown], ['Not reported (unknown)', true]);
  assert.equal(legacy['L1 gas used'].value, 'Not reported (unknown)');
  const zero = gas(DERIVED.l1_zero.build(depositSource));
  assert.equal(zero['Of which data-posting (L1), included above'].value, '0 (reported zero)');
});

test('the evidence basis of received amounts: qualified shows the amount and its basis, unqualified is unknown, never zero (T7)', () => {
  const amounts = (body) => present(body).receipt.position.amounts;
  const standard = amounts(variant('confirmed'));
  assert.equal(standard[0].value, '100 raw units (decimals unknown)');
  assert.equal(standard[0].note, 'from token transfer events');
  assert.match(amounts(variant('proxy-event-amounts'))[0].note, /reviewed upgradeable token; not a balance trace/);
  for (const [body, pattern] of [
    [variant('token-review-changed'), /implementation changed/],
    [DERIVED.basis_token_review_unavailable.build(depositSource), /identity could not be verified/],
    [DERIVED.basis_legacy_unqualified.build(depositSource), /older record/],
  ]) {
    const view = present(body);
    for (const fact of view.receipt.position.amounts) {
      assert.equal(fact.unknown, true);
      assert.match(fact.value, pattern);
      assert.doesNotMatch(fact.value, /^0/);
    }
    // NFT, liquidity and gas stay visible (AMT-2).
    assert.equal(view.receipt.position.facts[0].value, '#7');
    assert.equal(view.receipt.gas[0].label, 'Gross gas charge');
  }
  // The sixth basis: native ETH's net amount is unknown, and says where the value sent is; the ERC-20 side stays qualified.
  const native = present(DERIVED.basis_native_net_unavailable.build(depositSource)).receipt.position.amounts;
  assert.deepEqual([native[0].unknown, native[0].value], [true, 'Native ETH net amount unavailable (the value sent is shown on the step)']);
  assert.equal(native[1].unknown, undefined);
  assert.equal(native[1].value, '200 raw units (decimals unknown)');
  assert.equal(native[1].note, 'from token transfer events');
  // Every basis the contract names is shown above: two qualified, four unknown.
  const shownBases = new Set(
    [variant('confirmed'), variant('proxy-event-amounts'), variant('token-review-changed'), ...['basis_token_review_unavailable', 'basis_legacy_unqualified', 'basis_native_net_unavailable'].map((id) => DERIVED[id].build(depositSource))]
      .flatMap((body) => body.operation.history.map((step) => step.receipt?.position).filter(Boolean))
      .flatMap((position) => [position.amount0Basis, position.amount1Basis]),
  );
  assert.deepEqual([...shownBases].sort(), Object.keys(BASIS).sort());
  assert.match(present(DERIVED.owner_unavailable.build(depositSource)).receipt.position.owner, /^Current owner could not be read\.$/);
  assert.match(present(variant('confirmed')).receipt.position.owner, /observed at block 120\. A chain observation, not proof of control\./);
});

test('exceeded limits show observed against selected; an older receipt says its envelope is unknown (T8)', () => {
  const breach = present(variant('fee_cap_breach')).receipt.breach;
  assert.match(breach, /gas limit 300,001 \(you selected 300,000\); max fee per gas 201 \(you selected 200\); max priority fee per gas 101 \(you selected 100\)/);
  assert.match(present(DERIVED.single_breach.build(depositSource)).receipt.breach, /^This transaction exceeded limits you selected: gas limit 300,001 \(you selected 300,000\)\./);
  assert.equal(present(variant('confirmed')).receipt.breach, null);
  const legacy = present(variant('legacy_receipt')).receipt;
  assert.match(legacy.envelope, /^Transaction envelope not recorded \(older receipt\)/);
  assert.equal(legacy.breach, null, 'null is never read as within limits');
  assert.match(present(DERIVED.pending_provisional.build(depositSource)).receipt.notFinal, /not final/);
});

test('conflicts: support-required, over any state, from every step, and nothing can dismiss them (T9, DP-11, #68)', () => {
  const conflict = present(variant('reported_nonce_conflict'));
  assert.equal(conflict.supportRequired, true);
  assert.equal(conflict.conflicts.length, 1);
  assert.match(conflict.conflicts[0].text, /nonce 6 .* same effect as step 1 \(nonce 5\).*can't be cleared here/);
  assert.deepEqual(actionIds(conflict), ['check_status', 'check_allowances'], 'no retry, cancel, dismiss or new deposit');
  const cancelRequested = present(DERIVED.cancel_requested_conflict.build(depositSource));
  assert.equal(cancelRequested.kind, 'cancel_requested_support');
  assert.equal(cancelRequested.conflicts.length, 1, 'the overlay does not depend on the state');
  assert.equal(cancelRequested.supportRequired, true, 'a conflict kept in cancel_requested is support-required too');
  assert.deepEqual(actionIds(cancelRequested), ['check_status', 'check_allowances'], 'no report, retry or cancel beside a conflict');
  assert.ok(cancelRequested.body.includes(SUPPORT_REQUIRED));
  assert.doesNotMatch(cancelRequested.body.join(' '), /cancel or replace/);
  // A conflict on a step that is not the last still makes attention a conflict.
  const earlier = clone(variant('reported_nonce_conflict'));
  const second = { ...clone(earlier.operation.history[0]), step: 2, nonceRaw: '8', reportedEffectConflicts: [], reconciliationState: 'pending', receipt: null, transactionHash: null };
  earlier.operation.history.push(second);
  assert.equal(present(earlier).kind, 'attention_conflict');
});

test('cancel_requested with an unresolved hash is support-required; after a reorg it only checks status; a plain one keeps its copy (#68, REC-7)', () => {
  const unresolved = present(DERIVED.cancel_requested_unresolved.build(depositSource));
  assert.equal(unresolved.kind, 'cancel_requested_support');
  assert.equal(unresolved.supportRequired, true);
  assert.equal(unresolved.conflicts.length, 0);
  assert.deepEqual(actionIds(unresolved), ['check_status', 'check_allowances']);
  assert.ok(unresolved.body.includes(SUPPORT_REQUIRED));
  assert.doesNotMatch(unresolved.body.join(' '), /cancel or replace/);
  const reorg = present(DERIVED.cancel_requested_reorged.build(depositSource));
  assert.equal(reorg.kind, 'cancel_requested_reorg');
  assert.deepEqual(actionIds(reorg), ['check_status', 'check_allowances']);
  assert.match(reorg.body[0], /its receipt no longer counts\. The service keeps the evidence it recorded/);
  assert.doesNotMatch(reorg.body.join(' '), /cancel or replace/);
  const plain = present(DERIVED.cancel_requested.build(depositSource));
  assert.equal(plain.kind, 'cancel_requested');
  assert.equal(plain.supportRequired, false);
  assert.deepEqual(actionIds(plain), ['check_status', 'report', 'check_allowances']);
});

test('a conflict in any other state still makes the view support-required, with no report or cancel (#68 overlay)', () => {
  // Not runtime-valid (conflicts are only accepted in attention and
  // cancel_requested); this pins the defensive overlay in presentOperation.
  const body = clone(variant('pending'));
  body.operation.history.at(-1).reportedEffectConflicts = clone(variant('reported_nonce_conflict').operation.history[0].reportedEffectConflicts);
  const view = present(body);
  assert.equal(view.kind, 'pending');
  assert.equal(view.supportRequired, true);
  assert.deepEqual(actionIds(view), ['check_status', 'check_allowances']);
  assert.ok(view.body.includes(SUPPORT_REQUIRED));
});

test('attention without a conflict is support-required too, never retry or cancel; a reorg says so (REC-6, REC-7)', () => {
  for (const id of ['attention_transient', 'attention_approval_unqualified']) {
    const view = present(DERIVED[id].build(depositSource));
    assert.equal(view.kind, 'attention_generic');
    assert.equal(view.supportRequired, true);
    assert.deepEqual(actionIds(view), ['check_status', 'check_allowances']);
  }
  const reorg = present(DERIVED.attention_reorged.build(depositSource));
  assert.match(reorg.body[0], /its receipt no longer counts\. The service keeps the evidence it recorded/);
  assert.deepEqual(actionIds(reorg), ['check_status', 'check_allowances']);
});

test('recovery and cancellation copy never says "not sent" once a step was handed off (REC-5, T10)', () => {
  assert.match(present(DERIVED.cancel_requested.build(depositSource)).body[0], /may still have, or may already have sent/);
  assert.match(present(DERIVED.pending_not_found.build(depositSource)).body.join(' '), /hint, not proof.*not been found on-chain yet/);
  const superseded = present(variant('superseded'));
  assert.doesNotMatch(superseded.title + superseded.body.join(' '), /cancel|failed|minted|created/i);
  const afterSteps = present(DERIVED.cancelled_after_steps.build(depositSource));
  assert.equal(afterSteps.title, 'Cancelled after 1 confirmed step(s)');
  assert.doesNotMatch(allText(afterSteps), /Nothing was sent/);
  assert.match(present(variant('cancelled')).body[0], /^Nothing was sent\.$/);
  const reverted = present(DERIVED.reverted.build(depositSource));
  assert.equal(reverted.receipt.gas[0].label, 'Gross gas charge', 'reverted still shows its gas (DP-13)');
  assert.equal(reverted.receipt.facts.find((fact) => fact.label === 'Outcome').value, 'Included, reverted');
  const progress = present(DERIVED.draft_after_approval.build(depositSource));
  assert.match(progress.body[0], /prepared only when you ask for it/);
  assert.equal(progress.actions.find((action) => action.id === 'prepare').label, 'Prepare next step');
});

test('Check allowances appears in every view with history and in none without (ALW-1, DP-12)', () => {
  const bodies = [...VARIANTS.map(variant), ...Object.values(DERIVED).map(({ build: make }) => make(depositSource))];
  for (const body of bodies) {
    const view = present(body);
    assert.equal(actionIds(view).includes('check_allowances'), body.operation.history.length > 0, view.kind);
  }
});

test('allowances: unreadable is "Could not read", expired Permit2 stays next to a lasting ERC-20, guidance is text only (T11)', () => {
  const report = fixture('deposit-v1', 'variants/partial_allowances.json').allowances;
  const view = presentAllowances(report);
  assert.match(view.header, /^Read at block 100 .*A snapshot, not a token safety check\./);
  assert.deepEqual([view.rows[0].erc20.value, view.rows[0].erc20.unknown], ['Could not read', true]);
  assert.equal(view.rows[1].erc20.value, '17 raw units');
  assert.match(view.rows[1].erc20.note, /no expiry/);
  assert.match(view.rows[0].permit2.value, /^11 raw units · Expired · expires 2027-01-15/);
  assert.match(view.rows[0].permit2.note, /does not remove the ERC-20 approval/);
  assert.match(view.guidance, /0x000000000022d473030f116ddee9f6b43ac78ba3/);
  assert.match(view.guidance, /0x58daec3116aae6d93017baaea7749052e8a04fa7/);
  assert.match(view.guidance, /no button for it and builds nothing/);
  assert.match(view.guidance, /do not revoke anything/);
  assert.doesNotMatch(view.guidance, /approve\s*\(/);
});

test('the service fee on principal is shown as a percentage of 0, apart from gas (DEP-GEN-7)', () => {
  assert.ok(present(variant('confirmed')).facts.includes('Domino service fee on your principal: 0%. Network gas is separate.'));
});

const TKA = '0x1111111111111111111111111111111111111111';
const TKB = '0x2222222222222222222222222222222222222222';
const facts = (view) => Object.fromEntries(view.selection.map((fact) => [fact.label, fact]));

test('every view carries the owner’s selection above its actions: pool, amount, range, budgets and limits, in token units only where decimals were read', () => {
  const body = variant('mint');
  const unknown = facts(present(body));
  assert.deepEqual(Object.keys(unknown), ['Pool', 'Deposit amount', 'Range', 'Maximum spend', 'Slippage limit', 'Network limits per step', 'Gas reserve kept']);
  assert.equal(unknown.Pool.value, '0x111111…111111 / 0x222222…222222 · 0.30%');
  assert.equal(unknown.Pool.note, `Pool ID ${body.operation.selection.poolId}`);
  assert.equal(unknown['Deposit amount'].value, '100 raw units of 0x111111…111111', 'decimals unknown: raw, and it says so');
  assert.equal(unknown.Range.value, 'Ticks -120 to 180');
  assert.equal(unknown['Maximum spend'].value, '110 raw units of 0x111111…111111 · 220 raw units of 0x222222…222222');
  assert.equal(unknown['Slippage limit'].value, '0.5%');
  assert.equal(unknown['Network limits per step'].value, '300,000 gas · 200 wei max fee · 100 wei priority fee');
  assert.equal(unknown['Gas reserve kept'].value, '30,000,000 wei (0.00000000003 ETH)');
  for (const fact of Object.values(unknown)) assert.equal(fact.unknown, undefined, 'a selection is what the owner chose, never an unknown figure');

  const tokens = new Map([[TKA, { symbol: 'TKA', decimals: 2 }], [TKB, { symbol: 'TKB', decimals: 0 }]]);
  const known = facts(present(body, { tokens }));
  assert.equal(known.Pool.value, 'TKA / TKB · 0.30%');
  assert.equal(known['Deposit amount'].value, '1 TKA');
  assert.equal(known['Maximum spend'].value, '1.1 TKA · 220 TKB');

  const reading = facts(present(body, { tokens: new Map([[TKA, 'reading'], [TKB, { symbol: null, decimals: 6 }]]) }));
  assert.equal(reading['Deposit amount'].value, '—', 'while a token is read, no amount is guessed');
  assert.equal(reading['Maximum spend'].value, '— · 0.00022 0x222222…222222', 'decimals without a symbol keep the address');
  assert.equal(tokenAmount('12x', TKA, tokens), null);
  assert.equal(tokenName(TKA.toUpperCase().replace('0X', '0x'), tokens), 'TKA', 'addresses compare in lower case');
});

test('a symbol is whatever the token contract returned, so a sentence never takes it as written', () => {
  // A symbol ending in U+202E reorders the text after it on screen: "1.5 EVIL / 200 USDG" can be
  // read as its mirror while the string itself is unchanged. The read screens isolate symbols in
  // <bdi> (SymbolText.tsx); these presenters build sentences, so the controls are dropped instead.
  const RLO = '\u202E', LRI = '\u2066', PDI = '\u2069';
  const evil = new Map([[TKA, { symbol: `EVIL${RLO}`, decimals: 2 }], [TKB, { symbol: `${LRI}USDG${PDI}`, decimals: 0 }]]);
  assert.equal(tokenName(TKA, evil), 'EVIL', 'a trailing right-to-left override is dropped');
  assert.equal(tokenName(TKB, evil), 'USDG', 'isolates are dropped too, not just overrides');
  assert.equal(tokenAmount('150', TKA, evil), '1.5 EVIL', 'and the amount sentence is clean');

  // Cut at the 24 characters SymbolText shows, so one token cannot push a row off the panel.
  assert.equal(tokenName(TKA, new Map([[TKA, { symbol: 'A'.repeat(40), decimals: 0 }]])), `${'A'.repeat(24)}\u2026`);
  assert.equal(tokenName(TKA, new Map([[TKA, { symbol: 'A'.repeat(24), decimals: 0 }]])), 'A'.repeat(24), 'exactly 24 is not cut');

  // Nothing left after cleaning is no symbol at all, and the address stands in - the same answer
  // as a token whose contract returned no symbol.
  assert.equal(tokenName(TKA, new Map([[TKA, { symbol: `${RLO}${LRI}`, decimals: 0 }]])), '0x111111\u2026111111');
  assert.equal(tokenName(TKA, new Map([[TKA, { symbol: '   ', decimals: 0 }]])), '0x111111\u2026111111');
});

test('a list row says the pair, the amount in token units, the update time and whether a slot is reserved, in words', () => {
  const listed = fixture('deposit-v1', 'responses/list.json').operations[0];
  const row = presentListItem(listed);
  assert.deepEqual([row.id, row.state, row.pair, row.amount, row.reserved], [listed.id, 'Draft', '0x111111…111111 / 0x222222…222222 · 0.30%', '100 raw units of 0x111111…111111', false]);
  assert.match(row.updated, /^Updated 2027-01-15 \d\d:\d\d:\d\d UTC$/);
  const reserved = presentListItem({ ...listed, state: 'awaiting_wallet', outstanding: true }, new Map([[TKA, { symbol: 'TKA', decimals: 1 }], [TKB, 'reading']]));
  assert.deepEqual([reserved.state, reserved.pair, reserved.amount, reserved.reserved], ['Awaiting wallet', 'TKA / 0x222222…222222 · 0.30%', '10 TKA', true]);
  assert.equal(presentListItem(listed, new Map([[TKA, 'reading']])).amount, null);
  assert.deepEqual(Object.keys(STATE_LABEL).sort(), ['attention', 'awaiting_wallet', 'cancel_requested', 'cancelled', 'confirmed', 'draft', 'pending', 'reverted', 'superseded']);
  for (const label of Object.values(STATE_LABEL)) assert.doesNotMatch(label, /_/);
});

test('no deposit sentence describes the deployment as switched off, unfinished or in beta', () => {
  const texts = [
    ...Object.values(DEPOSIT_ERROR_UI).map((disposition) => disposition.copy),
    ...['gate_required', 'gate_unavailable', 'not_deployed', 'request_invalid', 'network', 'timeout', 'aborted', 'session_gone'].map((kind) => failureCopy({ kind })),
  ];
  for (const text of texts) assert.doesNotMatch(text, /enabled|deployment|beta|not connected|coming soon|preview/i, text);
  assert.equal(DEPOSIT_ERROR_UI.route_not_available.copy, 'The deposit service is unavailable right now. Nothing changed.');
  assert.equal(failureCopy({ kind: 'not_deployed' }), 'The deposit service is unavailable right now. Nothing changed.');
});
