/**
 * Domino V2's error decoder (spec F7 §2.12, §4.9, §5.8, §7.5, §8.2): every row of the spec's tables decodes to its
 * sentence and recovery in its context, every selector is recomputed from its Solidity signature and cross-checked with
 * api-contracts/v2/abi, unknown selectors stay generic with the selector in the data attribute only, wallet errors are
 * found however deep the library nests them, and a token's label only ever comes from the caller's labeler.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import {
  CallExecutionError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  RpcRequestError,
  UserRejectedRequestError,
  encodeAbiParameters,
  encodeErrorResult,
  parseAbiItem,
  toFunctionSelector,
} from 'viem';

const require = createRequire(import.meta.url);
const errors = require('../../.test-build/app/src/v2/errors.js');

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const MANY = '0xa11ce00000000000000000000000000000000001';
const ETH = '0x0000000000000000000000000000000000000000';
const GENERIC = 'The transaction would fail. Review again.';
const short = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;
/** The caller's labeler: a safe label for the tokens it knows, a short address otherwise. */
const labeler = (address) => (address === USDG ? 'USDG' : short(address));
const LABELS = { chainId: 4663, token: labeler, subjectToken: USDG, reason: 'set a price to exit at' };

// ---------------------------------------------------------------------------
// The spec's tables, transcribed from the spec (not from the module): context, signature, the spec's selector (null
// where the spec names the error without one), the sentence with its placeholders, and the recovery.
// ---------------------------------------------------------------------------

const PLAN_REFUSED = "This plan can't be executed. Review it again.";
const RANGE = "This price range isn't valid for this pool.";
const EXACT = "{token} doesn't transfer exact amounts, so it can't be used in a position.";
const SIGNATURE = "Your wallet's signature can't be used here. Use a direct transaction instead.";
const LESS = 'A swap would return less than your minimum (the price moved).';
const ROUTE = 'The swap route expired or failed. Review again.';
const UNAVAILABLE = "Domino isn't available on this network right now.";
const ANCHOR = 'Waiting for a valid reference price.';
// Changed on purpose 2026-10-04 (the owner: no "vault" in the UI; "your automation"): where the spec's sentences say "vault",
// the app's say "your automation" or "this automation".
const BLOCKED = 'Blocked: Domino no longer has approval on this position, or it left your automation.';

const SPEC = [
  // §2.12
  ['zap', 'InvalidPlan()', '0x21f24259', PLAN_REFUSED, 'requote'],
  ['zap', 'PlanExpired()', '0x059e8997', 'This review expired before it was confirmed. Review again for a fresh quote.', 'replan'],
  ['zap', 'Unauthorized()', '0x82b42900', 'Only the wallet that holds this position can do this.', 'switch-account'],
  ['zap', 'InvalidSignature()', '0x8baa579f', "The signature doesn't match this position's owner or this plan.", 'sign-again-or-direct'],
  ['zap', 'NonceUsed(address,uint256)', '0x2af71f10', 'This signature was already used or cancelled.', 'new-nonce'],
  ['zap', 'InsufficientLiquidity()', '0xbb55fd27', "The amount to withdraw is below this plan's minimum.", 'replan'],
  ['zap', 'InsufficientLiquidity(uint128,uint128)', '0xe49b763d', 'The price moved: this would add less liquidity than your minimum. No tokens moved.', 'requote'],
  ['zap', 'FeeMismatch()', '0x36a9d011', "The Domino fee in this plan doesn't match the fee rule. Review again.", 'report-plan-bug'],
  ['zap', 'SwapEffectMismatch()', '0x374aa3d7', 'A swap would return less than your minimum (the price moved). No tokens moved.', 'requote'],
  ['zap', 'PositionPoolMismatch(uint256)', '0xf71fd589', "This position doesn't belong to the selected pool, or it was closed.", 'reread-position'],
  ['zap', 'InvalidPool()', '0x2083cd40', "This pool isn't supported.", 'other-pool'],
  ['zap', 'InvalidRange(int24,int24,int24)', '0x00911c16', RANGE, 'adjust-range'],
  ['zap', 'InvalidTick(int24)', '0x8b86327a', RANGE, 'adjust-range-or-price'],
  ['zap', 'InvalidSqrtPrice(uint160)', '0x61487524', RANGE, 'adjust-range-or-price'],
  ['zap', 'PoolNotInitialized()', '0x486aa307', 'This pool has no price yet.', 'other-pool'],
  ['zap', 'PartialBurn(uint256,uint128,uint128)', '0xa97bba2b', 'This position changed since the review. Review again.', 'reread-and-replan'],
  ['zap', 'InvalidRecipient(address)', '0x17858bbe', PLAN_REFUSED, 'report-plan-bug'],
  ['zap', 'OpenDelta(int256,int256)', '0x5e9131f6', 'Uniswap reported an unexpected state for this pool. Try again later.', 'retry'],
  ['zap', 'TransferFailed(address)', '0x39f1c8d9', EXACT, 'other-token'],
  ['zap', 'SettlementMismatch(address,uint256,uint256)', '0x60752ed2', EXACT, 'other-token'],
  ['zap', 'ApprovalFailed(address)', '0xe5a0a42f', '{token} refused the approval.', 'other-token'],
  ['zap', 'TokenCallFailed(address)', '0xfecb69b4', 'A transfer of {token} failed. Check its approval and your balance.', 'approve-token'],
  ['zap', 'ReentrantCall()', '0x37ed32e8', 'A token in this action tried to call back into Domino, so the action was refused.', 'other-token'],
  ['zap', 'FeeNotBacked(address)', '0x6ce78f60', "This plan doesn't cover the Domino fee. Review again.", 'report-plan-bug'],
  ['zap', 'FeeTransferMismatch(address)', '0xaa22b734', 'The fee token behaved unexpectedly. Try another route.', 'other-route'],
  ['zap', 'InvalidSigner()', '0x815e1d64', SIGNATURE, 'direct-transaction'],
  ['zap', 'InvalidContractSignature()', '0xb0669cbc', SIGNATURE, 'direct-transaction'],
  ['zap', 'InvalidSignatureLength()', '0x4be6321b', SIGNATURE, 'direct-transaction'],
  ['zap', 'InvalidNonce()', '0x756688fe', 'This signature was already used.', 'replan'],
  ['zap', 'SignatureExpired(uint256)', '0xcd21db4f', 'The signature expired. Review again.', 'replan'],
  ['zap', 'InsufficientAllowance(uint256)', '0xf96fb071', 'The swap route asked for more than approved. Review again.', 'requote'],
  ['zap', 'InvalidAmount(uint256)', '0x3728b83d', PLAN_REFUSED, 'report-plan-bug'],
  ['zap', 'LengthMismatch()', '0xff633a38', PLAN_REFUSED, 'report-plan-bug'],
  ['zap', 'NotApproved(address)', '0x0ca968d8', 'Approve Domino to manage this position first.', 'approve-position'],
  ['zap', 'WrappedError(address,bytes4,bytes,bytes)', '0x90bfb865', 'Another app connected to this position refused the change.', 'show-target'],
  ['zap', 'MaximumAmountExceeded(uint128,uint128)', '0x31e30ad0', 'The price moved. Review again.', 'requote'],
  ['zap', 'MinimumAmountInsufficient(uint128,uint128)', '0x12816f22', 'The price moved. Review again.', 'requote'],
  ['zap', 'V4TooLittleReceived(uint256,uint256)', '0x8b063d73', LESS, 'requote'],
  ['zap', 'V3TooLittleReceived()', '0x39d35496', LESS, 'requote'],
  ['zap', 'TransactionDeadlinePassed()', '0x5bf6f916', ROUTE, 'requote'],
  ['zap', 'ExecutionFailed(uint256,bytes)', '0x2c4029e9', ROUTE, 'requote'],
  ['zap', 'DirectCall()', '0xdf146856', UNAVAILABLE, 'disable-chain'],
  ['zap', 'InvalidZapConfig()', '0x787fe9bc', UNAVAILABLE, 'disable-chain'],
  // §4.9, the owner's actions. Changed on purpose 2026-10-06 (rugged's answer of 6 Oct: the spec delta §3, "order" becomes
  // "Auto-exit"): the delta's words.
  ['autoExit', 'MandateAlreadyRegistered()', '0x6f6ffce9', 'This Auto-exit is already on.', 'show-existing'],
  ['autoExit', 'InvalidMandate()', '0x544cad7e', "This Auto-exit isn't valid: {reason}.", 'fix-fields'],
  ['autoExit', 'NonceAlreadyUsed()', '0x1fb09b80', 'This signature was already used or cancelled. Sign a new one.', 'new-nonce'],
  ['autoExit', 'InvalidSignature()', '0x8baa579f', "The signature isn't from the owner of this automation.", 'switch-account'],
  ['autoExit', 'Unauthorized()', '0x82b42900', 'Only the owner of this automation can do this.', 'none'],
  ['autoExit', 'MandateNotActive()', '0x952501f6', 'This Auto-exit is no longer on.', 'reread-status'],
  ['autoExit', 'NothingToClaim()', '0x969bf728', 'Nothing to claim in {token}.', 'none'],
  ['autoExit', 'InvalidRecipient()', '0x9c8d2cd2', 'Choose a valid address to receive the funds.', 'fix-fields'],
  ['autoExit', 'DeliveryMismatch(address)', '0xf0de72c3', '{token} moved a different amount than expected, so the claim was refused.', 'support'],
  // §4.9, why an order waits (the operator's reverts)
  ['autoExitWaiting', 'TriggerNotReached()', '0xdccfcae2', 'Waiting for the reference price to reach your trigger.', 'wait'],
  ['autoExitWaiting', 'SpotOutsideBand()', '0x97befd3a', 'Waiting: the pool price is too far from the reference price.', 'wait'],
  ['autoExitWaiting', 'BelowMinimum()', '0x860b82a9', 'Waiting: the exit would return less than your minimum.', 'wait'],
  ['autoExitWaiting', 'ObservationExpired()', '0xf9e0c800', ANCHOR, 'wait'],
  ['autoExitWaiting', 'ObservationRevoked()', '0x86669805', ANCHOR, 'wait'],
  ['autoExitWaiting', 'InvalidObservation()', '0xcea61d22', ANCHOR, 'wait'],
  ['autoExitWaiting', 'TwapUnavailable()', '0x146f8be2', ANCHOR, 'wait'],
  ['autoExitWaiting', 'PoolUnavailable()', '0x899b8f88', ANCHOR, 'wait'],
  ['autoExitWaiting', 'InvalidAnchor()', '0x080631d5', ANCHOR, 'wait'],
  ['autoExitWaiting', 'TwapWindowTooShort()', '0xe602580b', ANCHOR, 'wait'],
  // Added 2026-10-04 (rugged97's #323): the reference window bounded from above as well, waited out the same way.
  ['autoExitWaiting', 'TwapWindowTooLong()', '0x38fa200f', ANCHOR, 'wait'],
  ['autoExitWaiting', 'AutomationHalted()', '0x8d37598c', 'Paused: Domino stopped automation on {chain} for safety.', 'wait'],
  ['autoExitWaiting', 'ExitModuleNotEnabled()', '0x50cb9524', 'Paused: auto-exit is turned off for your automation.', 'wait'],
  ['autoExitWaiting', 'VaultOwnerChanged()', '0x5aeff3a7', 'Not valid: the owner of this automation changed.', 'none'],
  ['autoExitWaiting', 'AutomationUnavailable()', '0xb114dfff', BLOCKED, 'none'],
  ['autoExitWaiting', 'InvalidPosition()', '0xce7e065e', BLOCKED, 'none'],
  ['autoExitWaiting', 'InvalidExecution()', '0x29adbb29', GENERIC, 'hidden'],
  // §5.8
  ['vault', 'Unauthorized()', '0x82b42900', 'Only the owner of this automation can do this.', 'switch-account'],
  ['vault', 'InvalidInit()', '0xab849bda', "This automation can't manage this position.", 'fix-fields'],
  ['vault', 'UnexpectedNonce(uint256,uint256)', '0x315f0ba0', 'Another automation was set up from this wallet. Review again: your approval must point to the new one.', 'predict-again'],
  ['vault', 'AutomationUnavailable()', '0xb114dfff', 'Approve this position for your automation from the wallet that holds it, then try again.', 'approve-position'],
  ['vault', 'HookedPool(address)', '0x1758b8a8', "Pools with hooks can't be automated yet.", 'none'],
  ['vault', 'ForeignSubscriber(address)', '0x7889477f', 'Another app is connected to this position. Remove it at Uniswap first.', 'unsubscribe'],
  ['vault', 'InvalidPolicy()', '0xd06b96b1', 'One of the settings is outside the allowed range.', 'fix-fields'],
  ['vault', 'InvalidLimits()', '0xe773e0a9', 'One of the settings is outside the allowed range.', 'fix-fields'],
  ['vault', 'InvalidPosition()', '0xce7e065e', "This position can't be withdrawn this way.", 'none'],
  ['vault', 'InvalidAmount()', '0x2c5211c6', 'Enter an amount greater than zero.', 'fix-fields'],
  ['vault', 'InsufficientReserves()', '0x945e9268', "That's more than your automation holds in {token}.", 'reread-status'],
  // Changed on purpose 2026-10-04 (rugged97's delta of 4 Oct §2 item 1, #317): the failed transfer offers "Send to another
  // address you own"; InvalidRecipient (address(0)) only by the app's bug, in the delta's own words.
  ['vault', 'TokenCallFailed(address)', '0xfecb69b4', 'The transfer of {token} to your wallet failed.', 'send-elsewhere'],
  ['vault', 'InvalidRecipient()', '0x9c8d2cd2', 'Choose a wallet to receive the funds.', 'fix-fields'],
  ['vault', 'ReentrantCall()', '0x37ed32e8', 'Another Domino action is running on your automation. Try again.', 'retry'],
  // Spec rev4 §5.6 (#311 returnReserves): the spec lists these errors without sentences; the app's plain words.
  ['vault', 'RootOpen()', '0xdae47e24', "Your position still holds liquidity, so its fees can't be returned this way. Use Withdraw to wallet.", 'reread-status'],
  ['vault', 'SuccessorActive()', '0xa1c3fa1f', 'A position your automation opened is still active. Withdraw it from your automation first.', 'reread-status'],
  // §5.8's last row: the operator's or the module's own, never the owner's (no selectors in the spec).
  ...['StaleNonce()', 'TooSoon()', 'PlanExpired()', 'InvalidPlan()', 'InvalidRoute()', 'StepUnavailable()', 'InvalidInstruction()', 'UnexpectedCallback()']
    .map((signature) => ['vault', signature, null, GENERIC, 'hidden']),
];

const nameOf = (signature) => signature.slice(0, signature.indexOf('('));
const selectorOf = (signature) => toFunctionSelector(`function ${signature}`);
/** The revert data of an error, encoded by viem, with the token (and other) arguments filled. */
function revertData(signature, token = USDG) {
  const item = parseAbiItem(`error ${signature}`);
  const args = item.inputs.map((input) => {
    if (input.type === 'address') return token;
    if (input.type === 'bytes') return '0x';
    if (input.type === 'bytes4') return '0xdeadbeef';
    const bits = Number(input.type.replace(/^u?int/, '') || 256);
    return bits <= 48 ? 7 : 7n;
  });
  return encodeErrorResult({ abi: [item], errorName: item.name, args });
}
const fillExpected = (template, values) => template.replaceAll('{token}', values.token).replaceAll('{chain}', values.chain).replaceAll('{reason}', values.reason);

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

test('every selector of the spec\'s tables is keccak256 of its signature (recomputed here, none trusted)', () => {
  const inconsistent = SPEC.filter(([, signature, selector]) => selector !== null && selectorOf(signature) !== selector);
  assert.deepEqual(inconsistent, [], 'a spec selector that is not its signature\'s');
  // §2.12's generic rows, and the wallet-free ones the module handles by hand.
  assert.equal(selectorOf('Error(string)'), '0x08c379a0');
  assert.equal(selectorOf('Panic(uint256)'), '0x4e487b71');
});

test('the module\'s tables are exactly the spec\'s rows: same contexts, signatures, selectors, sentences and recoveries', () => {
  const ours = Object.entries(errors.ERROR_TABLES).flatMap(([context, rows]) => rows.map((row) => [context, row.signature, row.selector, row.copy, row.recovery]));
  const theirs = SPEC.map(([context, signature, selector, copy, recovery]) => [context, signature, selector ?? selectorOf(signature), copy, recovery]);
  const key = (row) => row.join(' | ');
  assert.deepEqual(ours.map(key).sort(), theirs.map(key).sort());
  // Every module selector is its signature's, and no context holds a selector twice.
  for (const [context, rows] of Object.entries(errors.ERROR_TABLES)) {
    for (const row of rows) assert.equal(row.selector, selectorOf(row.signature), `${context} ${row.signature}`);
    assert.equal(new Set(rows.map((row) => row.selector)).size, rows.length, `${context} has a duplicate selector`);
    for (const row of rows) assert.ok(errors.RECOVERIES.includes(row.recovery), row.recovery);
  }
});

test('cross-check with api-contracts/v2/abi: every exported error the app meets is in a table, with the same selector', () => {
  const dir = new URL('../../../api-contracts/v2/abi/', import.meta.url);
  const exported = new Map();
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json') && name !== 'index.json')) {
    const { abi } = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
    for (const item of abi.filter((entry) => entry.type === 'error')) {
      const signature = `${item.name}(${item.inputs.map((input) => input.type).join(',')})`;
      exported.set(`${file.replace(/\.json$/, '')}:${signature}`, selectorOf(signature));
    }
  }
  const inTables = new Map(Object.values(errors.ERROR_TABLES).flat().map((row) => [row.signature, row.selector]));
  let crossChecked = 0;
  const missing = [];
  for (const [where, selector] of exported) {
    const signature = where.slice(where.indexOf(':') + 1);
    // The registry's governance errors (ChangeNotReady, InvalidChange) are no owner's: the app never sends those calls.
    if (where.startsWith('IDominoRegistry:') && signature !== 'Unauthorized()') continue;
    if (!inTables.has(signature)) {
      missing.push(where);
      continue;
    }
    assert.equal(inTables.get(signature), selector, where);
    crossChecked += 1;
  }
  assert.deepEqual(missing, []);
  assert.ok(crossChecked >= 35, `cross-checked ${crossChecked}`);
});

// ---------------------------------------------------------------------------
// Every row
// ---------------------------------------------------------------------------

test('every row of §2.12, §4.9 (both tables) and §5.8 decodes to its sentence and recovery, in its context', () => {
  for (const [context, signature, , template, recovery] of SPEC) {
    const data = revertData(signature);
    const said = errors.decodeRevertData(data, context, LABELS);
    const expected = fillExpected(template, { token: 'USDG', chain: 'Robinhood Chain', reason: 'set a price to exit at' });
    assert.equal(said.copy, expected, `${context} ${signature}`);
    assert.equal(said.recovery, recovery, `${context} ${signature}`);
    assert.equal(said.code, signature);
    assert.equal(said.selector, selectorOf(signature));
    assert.equal(said.dataCode, nameOf(signature));
    assert.equal(said.context, context);
    // The code never appears in the sentence: not the selector, not the error's name.
    assert.equal(said.copy.includes(said.selector), false, signature);
    assert.equal(said.copy.includes(nameOf(signature)), false, signature);
    assert.ok(Object.isFrozen(said));
    // A thrown error carrying the same data says the same.
    assert.deepEqual(errors.decodeV2Error({ code: 3, message: 'execution reverted', data }, context, LABELS), said);
  }
});

test('a token carried by the error is decoded by hand from its ABI word, as viem reads it', () => {
  for (const signature of ['TransferFailed(address)', 'SettlementMismatch(address,uint256,uint256)', 'ApprovalFailed(address)', 'TokenCallFailed(address)', 'FeeNotBacked(address)', 'FeeTransferMismatch(address)']) {
    const said = errors.decodeRevertData(revertData(signature, MANY), 'zap', LABELS);
    assert.equal(said.token, MANY, signature);
    if (said.copy !== "This plan doesn't cover the Domino fee. Review again." && said.copy !== 'The fee token behaved unexpectedly. Try another route.') {
      assert.ok(said.copy.includes(short(MANY)), `${signature}: ${said.copy}`);
    }
  }
  const delivery = errors.decodeRevertData(revertData('DeliveryMismatch(address)', MANY), 'autoExit', LABELS);
  assert.equal(delivery.copy, `${short(MANY)} moved a different amount than expected, so the claim was refused.`);
  assert.equal(errors.decodeRevertData(revertData('TokenCallFailed(address)', ETH), 'vault', { chainId: 4663 }).copy, 'The transfer of ETH to your wallet failed.');
  // Addresses that are not tokens are kept apart, never put in the sentence.
  const notApproved = errors.decodeRevertData(revertData('NotApproved(address)', MANY), 'zap', LABELS);
  assert.equal(notApproved.address, MANY);
  assert.equal(notApproved.token, undefined);
  assert.equal(errors.decodeRevertData(revertData('HookedPool(address)', MANY), 'vault', LABELS).address, MANY);
  // A dirty address word (upper bytes set) is not an address: the generic sentence, never a guessed token.
  const dirty = `0x39f1c8d9${'ff'.repeat(12)}${USDG.slice(2)}`;
  const said = errors.decodeRevertData(dirty, 'zap', LABELS);
  assert.deepEqual([said.copy, said.code, said.dataCode, said.token], [GENERIC, 'TransferFailed(address)', 'TransferFailed', undefined]);
  // Too short to hold the word: the same.
  assert.equal(errors.decodeRevertData('0xfecb69b4', 'zap', LABELS).copy, GENERIC);
});

test('the same selector says different things on different contracts', () => {
  const said = (signature, context) => errors.decodeRevertData(revertData(signature), context, LABELS);
  assert.deepEqual(['zap', 'vault', 'autoExit'].map((context) => said('Unauthorized()', context).copy), [
    // Changed on purpose 2026-10-04 (the owner: no "vault" in the UI; "your automation").
    'Only the wallet that holds this position can do this.', 'Only the owner of this automation can do this.', 'Only the owner of this automation can do this.',
  ]);
  assert.deepEqual(['zap', 'vault', 'autoExit'].map((context) => said('Unauthorized()', context).recovery), ['switch-account', 'switch-account', 'none']);
  assert.notEqual(said('InvalidSignature()', 'zap').copy, said('InvalidSignature()', 'autoExit').copy);
  assert.notEqual(said('TokenCallFailed(address)', 'zap').copy, said('TokenCallFailed(address)', 'vault').copy);
  assert.notEqual(said('ReentrantCall()', 'zap').copy, said('ReentrantCall()', 'vault').copy);
  assert.notEqual(said('InvalidPosition()', 'vault').copy, said('InvalidPosition()', 'autoExitWaiting').copy);
  assert.notEqual(said('AutomationUnavailable()', 'vault').copy, said('AutomationUnavailable()', 'autoExitWaiting').copy);
  // InvalidPlan and PlanExpired are the owner's on the zap, and the operator's (hidden) on a vault.
  assert.equal(said('InvalidPlan()', 'vault').recovery, 'hidden');
  assert.equal(said('PlanExpired()', 'vault').copy, GENERIC);
  // A selector that belongs to another contract's table is unknown here.
  const elsewhere = said('FeeMismatch()', 'vault');
  assert.deepEqual([elsewhere.code, elsewhere.copy, elsewhere.dataCode], ['unknown', GENERIC, '0x36a9d011']);
  assert.throws(() => errors.decodeRevertData('0x', 'router', LABELS), /invalid_error_context/);
});

// ---------------------------------------------------------------------------
// Generic, nested and malformed
// ---------------------------------------------------------------------------

test('an unknown selector is the generic sentence, with the selector in the data attribute only', () => {
  const said = errors.decodeRevertData('0x12345678abcdef', 'zap', LABELS);
  assert.deepEqual({ ...said }, { code: 'unknown', selector: '0x12345678', copy: GENERIC, recovery: 'review-again', dataCode: '0x12345678', context: 'zap' });
  assert.equal(said.copy.includes('0x12345678'), false);
  assert.equal(errors.decodeRevertData('0xDEADBEEF', 'vault', LABELS).dataCode, '0xdeadbeef');
  // Empty, shorter than a selector, and not hex at all.
  assert.deepEqual([errors.decodeRevertData('0x', 'zap', LABELS).code, errors.decodeRevertData('0x', 'zap', LABELS).dataCode], ['empty', 'empty']);
  assert.deepEqual([errors.decodeRevertData('0x1234', 'zap', LABELS).code, errors.decodeRevertData('0x1234', 'zap', LABELS).dataCode], ['unknown', '0x1234']);
  for (const bad of ['0x123', 'deadbeef', '0xzz', '', null]) {
    const said2 = errors.decodeRevertData(bad, 'zap', LABELS);
    assert.deepEqual([said2.copy, said2.dataCode], [GENERIC, 'malformed'], String(bad));
  }
});

test('Error(string): v3\'s "Not approved" and "Price slippage check" have their sentences; any other text stays in the data attribute', () => {
  const reason = (text) => encodeErrorResult({ abi: [parseAbiItem('error Error(string)')], errorName: 'Error', args: [text] });
  const approve = errors.decodeRevertData(reason('Not approved'), 'zap', LABELS);
  assert.deepEqual([approve.copy, approve.recovery, approve.code, approve.dataCode, approve.detail], ['Approve Domino to manage this position first.', 'approve-position', 'Error(string)', 'Error', 'Not approved']);
  const slippage = errors.decodeRevertData(reason('Price slippage check'), 'zap', LABELS);
  assert.deepEqual([slippage.copy, slippage.recovery], ['The price moved. Review again.', 'requote']);
  const other = errors.decodeRevertData(reason('STF'), 'zap', LABELS);
  assert.deepEqual([other.copy, other.recovery, other.detail, other.dataCode], [GENERIC, 'review-again', 'STF', 'Error']);
  // The v3 sentences are the zap's: on a vault the same text is generic.
  assert.equal(errors.decodeRevertData(reason('Not approved'), 'vault', LABELS).copy, GENERIC);
  // Untrusted text: controls and bidirectional overrides stripped, bounded, never in the sentence.
  const hostile = errors.decodeRevertData(reason(`\u202eevil\u0000 ${'x'.repeat(500)}`), 'zap', LABELS);
  assert.equal(hostile.copy, GENERIC);
  assert.ok(hostile.detail.startsWith('evil x') && Array.from(hostile.detail).length === 201, hostile.detail.slice(0, 20));
  assert.equal(hostile.detail.includes('\u202e') || hostile.detail.includes(String.fromCharCode(0)), false);
  // A lying length is not read past the data.
  const truncated = reason('Not approved').slice(0, 10 + 64 + 64);
  assert.deepEqual([errors.decodeRevertData(truncated, 'zap', LABELS).copy, errors.decodeRevertData(truncated, 'zap', LABELS).detail], [GENERIC, undefined]);
});

test('Panic(uint256) and a revert without data are the generic sentence', () => {
  const panic = errors.decodeRevertData(encodeErrorResult({ abi: [parseAbiItem('error Panic(uint256)')], errorName: 'Panic', args: [0x11n] }), 'zap', LABELS);
  assert.deepEqual([panic.copy, panic.code, panic.dataCode, panic.detail], [GENERIC, 'Panic(uint256)', 'Panic', '0x11']);
  const empty = errors.decodeV2Error({ code: 3, message: 'execution reverted' }, 'vault', LABELS);
  assert.deepEqual([empty.copy, empty.code, empty.dataCode, empty.recovery], [GENERIC, 'empty', 'empty', 'review-again']);
  assert.equal(errors.decodeV2Error({ message: 'Execution reverted with reason: none' }, 'zap', LABELS).code, 'empty');
});

test('UR ExecutionFailed: the sentence stays the route\'s, and the inner error is decoded as its cause', () => {
  const inner = revertData('V4TooLittleReceived(uint256,uint256)');
  const data = encodeErrorResult({ abi: [parseAbiItem('error ExecutionFailed(uint256 commandIndex, bytes message)')], errorName: 'ExecutionFailed', args: [2n, inner] });
  const said = errors.decodeRevertData(data, 'zap', LABELS);
  assert.deepEqual([said.copy, said.recovery, said.code], [ROUTE, 'requote', 'ExecutionFailed(uint256,bytes)']);
  assert.deepEqual([said.cause.code, said.cause.copy, said.cause.dataCode], ['V4TooLittleReceived(uint256,uint256)', LESS, 'V4TooLittleReceived']);
  // Nested twice: a command that failed with a token's string.
  const nested = encodeErrorResult({ abi: [parseAbiItem('error ExecutionFailed(uint256 commandIndex, bytes message)')], errorName: 'ExecutionFailed', args: [0n, data] });
  assert.equal(errors.decodeRevertData(nested, 'zap', LABELS).cause.cause.code, 'V4TooLittleReceived(uint256,uint256)');
  // An unknown inner error keeps its selector in its own data attribute.
  const unknown = encodeErrorResult({ abi: [parseAbiItem('error ExecutionFailed(uint256 commandIndex, bytes message)')], errorName: 'ExecutionFailed', args: [0n, '0xcafebabe'] });
  assert.equal(errors.decodeRevertData(unknown, 'zap', LABELS).cause.dataCode, '0xcafebabe');
});

test('v4 WrappedError: the refusing contract is exposed as target, and its reason as the cause', () => {
  const hook = '0x0000000000000000000000000000000000c0ffee';
  const data = encodeErrorResult({
    abi: [parseAbiItem('error WrappedError(address target, bytes4 selector, bytes reason, bytes details)')],
    errorName: 'WrappedError',
    args: [hook, '0x12345678', '0xbadc0de5', '0x'],
  });
  const said = errors.decodeRevertData(data, 'zap', LABELS);
  assert.deepEqual([said.copy, said.recovery, said.target, said.cause.dataCode], ['Another app connected to this position refused the change.', 'show-target', hook, '0xbadc0de5']);
  assert.equal(said.copy.includes(hook), false);
});

test('wallet errors are found however the library nests them', () => {
  const invalidPlan = revertData('InvalidPlan()');
  // MetaMask: Internal JSON-RPC error with the node's error inside data.originalError.
  const metamask = { code: -32603, message: 'Internal JSON-RPC error.', data: { originalError: { code: 3, message: 'execution reverted', data: invalidPlan } } };
  assert.equal(errors.decodeV2Error(metamask, 'zap', LABELS).code, 'InvalidPlan()');
  // Another wallet: data.data.
  assert.equal(errors.decodeV2Error({ code: -32000, data: { data: invalidPlan } }, 'zap', LABELS).code, 'InvalidPlan()');
  // viem: ContractFunctionExecutionError → ContractFunctionRevertedError with the raw data.
  const reverted = new ContractFunctionRevertedError({ abi: [], data: revertData('PlanExpired()'), functionName: 'exit' });
  const viemError = new ContractFunctionExecutionError(reverted, { abi: [], functionName: 'exit', args: [], contractAddress: MANY });
  assert.equal(errors.decodeV2Error(viemError, 'zap', LABELS).code, 'PlanExpired()');
  // viem: CallExecutionError → RpcRequestError { code: 3, data }.
  const call = new CallExecutionError(new RpcRequestError({ body: {}, url: 'wallet', error: { code: 3, message: 'execution reverted', data: revertData('FeeMismatch()') } }), {});
  assert.equal(errors.decodeV2Error(call, 'zap', LABELS).code, 'FeeMismatch()');
  // A cause chain of plain objects, and the error field ethers-style providers use.
  assert.equal(errors.decodeV2Error({ cause: { cause: { error: { data: revertData('InvalidMandate()') } } } }, 'autoExit', LABELS).code, 'InvalidMandate()');
  // Revert data handed over directly.
  assert.equal(errors.decodeV2Error(revertData('TooSoon()'), 'vault', LABELS).recovery, 'hidden');
});

test('4001 anywhere in the chain is the refusal, before any data it carries; 4902 asks to add the chain', () => {
  const declined = (value) => errors.decodeV2Error(value, 'zap', LABELS);
  const expected = { code: 'declined', selector: null, copy: 'You declined in your wallet. Nothing was sent.', recovery: 'none', dataCode: 'declined', context: 'zap' };
  assert.deepEqual({ ...declined({ code: 4001, message: 'User rejected the request.' }) }, expected);
  assert.deepEqual({ ...declined({ cause: { cause: { code: 4001 } } }) }, expected);
  assert.deepEqual({ ...declined(new UserRejectedRequestError(new Error('User rejected the request.'))) }, expected);
  assert.deepEqual({ ...declined({ code: -32603, data: { originalError: { code: 4001, data: revertData('InvalidPlan()') } } }) }, expected);
  // Post-B4 review F6: WalletConnect's 5000 and a hardware wallet's refusal (a Ledger's 0x6985, passed on as data that
  // would otherwise read as a revert) are the person's refusal too, exactly as finance/nonce.ts personRefused says.
  const { personRefused } = require('../../.test-build/app/src/finance/nonce.js');
  const samples = [
    { code: 5000, message: 'User rejected.' },
    { code: -32603, message: 'Ledger device: Condition of use not satisfied (denied by the user?) (0x6985)' },
    { code: -32603, message: 'Internal JSON-RPC error.', data: '0x6985' },
    { code: -32603, data: { cause: { message: 'User cancelled' } } },
  ];
  for (const value of samples) {
    assert.equal(personRefused(value), true);
    assert.deepEqual({ ...declined(value) }, expected, JSON.stringify(value));
  }
  for (const value of [{ code: 4100, message: 'Unauthorized' }, { code: -32603, message: 'execution reverted', data: revertData('InvalidPlan()') }]) {
    assert.equal(personRefused(value), false);
    assert.notEqual(declined(value)?.code, 'declined');
  }
  // 4902: the chain the action is on, by its profile's name.
  for (const [chainId, name] of [[4663, 'Robinhood Chain'], [8453, 'Base'], [42161, 'Arbitrum One']]) {
    const said = errors.decodeV2Error({ code: -32603, data: { originalError: { code: 4902, message: 'Unrecognized chain ID' } } }, 'zap', { chainId });
    assert.deepEqual([said.copy, said.recovery, said.dataCode, said.code], [`Add ${name} to your wallet, then try again.`, 'add-chain', 'unknown_chain', 'unknown_chain']);
  }
});

test('not a revert, not a refusal: null, so the caller\'s own failure sentence applies', () => {
  for (const value of [
    new Error('Failed to fetch'),
    { code: -32005, message: 'Request rate exceeded' },
    { code: 429, message: 'execution reverted', data: revertData('InvalidPlan()') },
    { message: 'timeout' },
    null,
    undefined,
    'not hex',
    42,
  ]) assert.equal(errors.decodeV2Error(value, 'zap', LABELS), null, String(value?.message ?? value));
  // A cycle is walked once.
  const cyclic = { message: 'oops' };
  cyclic.cause = cyclic;
  assert.equal(errors.decodeV2Error(cyclic, 'zap', LABELS), null);
  // Deeper than the bound: not found.
  let deep = { code: 3, data: revertData('InvalidPlan()') };
  for (let i = 0; i < 10; i += 1) deep = { cause: deep };
  assert.equal(errors.decodeV2Error(deep, 'zap', LABELS), null);
});

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

test('{token} comes only from the labeler, as plain text: stripped, bounded, never re-read as a template', () => {
  const data = revertData('ApprovalFailed(address)', MANY);
  const said = (token) => errors.decodeRevertData(data, 'zap', { chainId: 4663, token }).copy;
  assert.equal(said(() => 'MANY'), 'MANY refused the approval.');
  // Without a labeler, or with one that fails or returns nothing usable: the short address.
  assert.equal(said(undefined), `${short(MANY)} refused the approval.`);
  assert.equal(said(() => { throw new Error('no'); }), `${short(MANY)} refused the approval.`);
  assert.equal(said(() => ''), `${short(MANY)} refused the approval.`);
  assert.equal(said(() => 42), `${short(MANY)} refused the approval.`);
  assert.equal(said(() => '\u202e\u200b'), `${short(MANY)} refused the approval.`);
  // Bidirectional overrides and controls are stripped; a label is never read as a template.
  assert.equal(said(() => '\u202eYNAM\u0007'), 'YNAM refused the approval.');
  assert.equal(said(() => '{chain}{reason}'), '{chain}{reason} refused the approval.');
  assert.equal(said(() => '<b>MANY</b>'), '<b>MANY</b> refused the approval.');
  // Bounded.
  assert.equal(said(() => 'M'.repeat(100)), `${'M'.repeat(40)}… refused the approval.`);
  // The labeler sees only the decoded address.
  const seen = [];
  said((address) => { seen.push(address); return 'X'; });
  assert.deepEqual(seen, [MANY]);
});

test('{token} for an error that carries none comes from the action\'s token; without one, the generic sentence', () => {
  const claim = (labels) => errors.decodeRevertData(revertData('NothingToClaim()'), 'autoExit', labels);
  assert.equal(claim({ chainId: 4663, token: labeler, subjectToken: USDG }).copy, 'Nothing to claim in USDG.');
  assert.equal(claim({ chainId: 4663, token: labeler, subjectToken: USDG }).token, USDG);
  assert.equal(claim({ chainId: 4663, subjectToken: ETH }).copy, 'Nothing to claim in ETH.');
  const bare = claim({ chainId: 4663 });
  assert.deepEqual([bare.copy, bare.recovery, bare.code], [GENERIC, 'none', 'NothingToClaim()']);
  // Changed on purpose 2026-10-04 (the owner: no "vault" in the UI; "your automation").
  assert.equal(errors.decodeRevertData(revertData('InsufficientReserves()'), 'vault', { chainId: 8453, token: labeler, subjectToken: USDG }).copy, "That's more than your automation holds in USDG.");
});

test('{reason} is InvalidMandate\'s local reason; {chain} the chain\'s name; InvalidInit says the consent when it was missing', () => {
  const mandate = (reason) => errors.decodeRevertData(revertData('InvalidMandate()'), 'autoExit', { chainId: 4663, reason });
  assert.equal(mandate('set a price to exit at').copy, "This Auto-exit isn't valid: set a price to exit at.");
  assert.equal(mandate('the slippage must be 10% or less.').copy, "This Auto-exit isn't valid: the slippage must be 10% or less.");
  assert.equal(mandate('the date\u202e is in the past').copy, "This Auto-exit isn't valid: the date is in the past.");
  for (const missing of [undefined, '', '.', '   ']) assert.deepEqual([mandate(missing).copy, mandate(missing).recovery], [GENERIC, 'fix-fields']);
  // The reason fills {reason} only: another sentence is untouched by it.
  assert.equal(errors.decodeRevertData(revertData('MandateNotActive()'), 'autoExit', { chainId: 4663, reason: 'x' }).copy, 'This Auto-exit is no longer on.');
  const halted = errors.decodeRevertData(revertData('AutomationHalted()'), 'autoExitWaiting', { chainId: 42161 });
  assert.equal(halted.copy, 'Paused: Domino stopped automation on Arbitrum One for safety.');
  assert.equal(errors.decodeRevertData(revertData('AutomationHalted()'), 'autoExitWaiting', { chainId: 1 }).copy, GENERIC);
  const init = (consentGiven) => errors.decodeRevertData(revertData('InvalidInit()'), 'vault', { chainId: 4663, consentGiven }).copy;
  // Changed on purpose 2026-10-04 (the owner: no "vault" in the UI; "your automation").
  assert.equal(init(undefined), "This automation can't manage this position.");
  assert.equal(init(true), "This automation can't manage this position.");
  assert.equal(init(false), 'Confirm that earned fees become automation fees.');
});

test('§2.12\'s missing Permit2 allowance: the sentence and the approval step, for the token the app found short', () => {
  const said = errors.permit2ApprovalNeeded(USDG, LABELS);
  assert.deepEqual({ ...said }, { code: 'permit2_allowance_missing', selector: null, copy: 'Approve USDG for Permit2 first.', recovery: 'approve-permit2', dataCode: 'permit2_allowance_missing', context: 'zap', token: USDG });
  assert.equal(errors.permit2ApprovalNeeded(MANY.toUpperCase().replace('0X', '0x'), { chainId: 4663 }).copy, `Approve ${short(MANY.toUpperCase().replace('0X', '0x'))} for Permit2 first.`);
  assert.throws(() => errors.permit2ApprovalNeeded('0x1234', LABELS), /invalid_address/);
});

test('the recovery set is closed and every recovery the tables name is in it', () => {
  const used = new Set(Object.values(errors.ERROR_TABLES).flat().map((row) => row.recovery));
  for (const recovery of used) assert.ok(errors.RECOVERIES.includes(recovery), recovery);
  for (const extra of ['approve-permit2', 'add-chain', 'review-again', 'none']) assert.ok(errors.RECOVERIES.includes(extra), extra);
  assert.equal(new Set(errors.RECOVERIES).size, errors.RECOVERIES.length);
});

test('the hand reader follows a dynamic argument\'s offset as viem encodes it, and refuses a body it cannot read', () => {
  const encoded = encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes' }], [5n, '0xcafebabe00']);
  const said = errors.decodeRevertData(`0x2c4029e9${encoded.slice(2)}`, 'zap', LABELS);
  assert.deepEqual([said.cause.code, said.cause.dataCode], ['unknown', '0xcafebabe']);
  // An Error(string) selector without its body: generic, no text.
  const bareBody = encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes' }], [0n, '0x08c379a0']);
  const bare = errors.decodeRevertData(`0x2c4029e9${bareBody.slice(2)}`, 'zap', LABELS);
  assert.deepEqual([bare.cause.code, bare.cause.copy, bare.cause.detail], ['Error(string)', GENERIC, undefined]);
  // An offset pointing past the data: no cause rather than a guess.
  const lying = `0x2c4029e9${'0'.repeat(63)}5${'f'.repeat(64)}`;
  assert.equal(errors.decodeRevertData(lying, 'zap', LABELS).cause, undefined);
});

// ---------------------------------------------------------------------------
// What the screens say when the decoder has no sentence (added 2026-11-09, core flows, errors)
// ---------------------------------------------------------------------------

test('the wallet\'s network failing is found however the wallet or viem says it, each with its own code', async () => {
  const viem = await import('viem');
  const zeroData = (() => {
    try {
      viem.decodeFunctionResult({ abi: [{ type: 'function', name: 'f', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' }], functionName: 'f', data: '0x' });
    } catch (error) {
      return error;
    }
    return null;
  })();
  assert.equal(zeroData?.name, 'AbiDecodingZeroDataError', 'viem\'s own error for an empty eth_call answer');
  for (const [error, code] of [
    [{ code: -32603, message: 'Internal JSON-RPC error.' }, 'wallet_rpc_internal'],
    [new viem.InternalRpcError(new Error('upstream')), 'wallet_rpc_internal'],
    // MetaMask's wrapping: the inner reason decides.
    [{ code: -32603, message: 'Internal JSON-RPC error.', data: { code: -32005, message: 'rate limited' } }, 'wallet_rpc_limited'],
    [{ code: -32603, message: 'Internal JSON-RPC error.', data: { originalError: { code: -32000, message: 'header not found' } } }, 'wallet_rpc_no_header'],
    [{ code: -32005, message: 'Request rate exceeded' }, 'wallet_rpc_limited'],
    [new viem.LimitExceededRpcError(new Error('upstream')), 'wallet_rpc_limited'],
    [{ code: -32000, message: 'daily request count exceeded, request rate limited' }, 'wallet_rpc_limited'],
    // A 429 carrying revert data is still the network's (decodeV2Error leaves it to the caller).
    [{ code: 429, message: 'execution reverted', data: revertData('InvalidPlan()') }, 'wallet_rpc_limited'],
    [{ code: -32000, message: 'missing trie node 4f2c (path )' }, 'wallet_rpc_no_header'],
    [{ code: -32000, message: 'unknown block' }, 'wallet_rpc_no_header'],
    [zeroData, 'wallet_rpc_empty'],
    [{ message: 'The contract function "allowance" returned no data ("0x").' }, 'wallet_rpc_empty'],
    [new viem.TimeoutError({ url: 'https://rpc.example', body: {} }), 'wallet_rpc_timeout'],
    [{ message: 'Request timed out' }, 'wallet_rpc_timeout'],
    [new viem.HttpRequestError({ url: 'https://rpc.example', status: 503, body: {} }), 'wallet_rpc_unreachable'],
    [new TypeError('Failed to fetch'), 'wallet_rpc_unreachable'],
    [{ code: 4900, message: 'Disconnected' }, 'wallet_rpc_unreachable'],
    [{ code: 4901, message: 'Chain disconnected' }, 'wallet_rpc_unreachable'],
  ]) assert.equal(errors.walletNetworkFailure(error), code, String(error?.message ?? error));
});

test('a call refused, a refusal in the wallet and the clients\' own codes are never the network', () => {
  for (const error of [
    { code: 4001, message: 'User rejected the request.' },
    Object.assign(new Error('Ledger: 0x6985'), { code: -32603 }),
    { code: 4902, message: 'Unrecognized chain ID' },
    { code: 3, message: 'execution reverted', data: revertData('InvalidPlan()') },
    { code: -32603, message: 'Internal JSON-RPC error.', data: { code: 3, message: 'execution reverted', data: revertData('InvalidPlan()') } },
    { code: -32603, message: 'Internal JSON-RPC error.', data: { message: 'execution reverted' } },
    { code: -32000, message: 'insufficient funds for gas * price + value' },
    { code: -32603, message: 'Internal JSON-RPC error.', data: { message: 'gas required exceeds allowance (0)' } },
    { code: -32603, message: 'Internal JSON-RPC error.', data: { message: 'exceeds block gas limit' } },
    { code: -32000, message: 'nonce too low' },
    { code: -32601, message: 'the method eth_simulateV1 does not exist/is not available' },
    { code: -32602, message: 'Invalid parameters were provided to the RPC method.' },
    new Error('wallet_timeout'),
    new Error('wallet_action_expired'),
    new Error('invalid_wallet_reply'),
    Object.assign(new Error('registry_rank_mismatch'), { failures: ['registry_rank_mismatch'] }),
    new Error('Something odd happened'),
    null, undefined, 42, '', {},
  ]) assert.equal(errors.walletNetworkFailure(error), null, JSON.stringify(error) ?? String(error));
  // A cycle is walked once.
  const cyclic = { message: 'oops' };
  cyclic.cause = cyclic;
  assert.equal(errors.walletNetworkFailure(cyclic), null);
});

test('a read worth asking once more: the network\'s failures and an unreadable wallet reply; never a refusal, a revert or a closed code', () => {
  for (const error of [{ code: -32603, message: 'Internal JSON-RPC error.' }, { code: -32000, message: 'header not found' }, new Error('invalid_wallet_reply'), new TypeError('Failed to fetch')]) {
    assert.equal(errors.transientWalletRead(error), true, String(error.message));
  }
  for (const error of [{ code: 4001, message: 'User rejected the request.' }, { code: 3, message: 'execution reverted', data: revertData('InvalidPlan()') }, new Error('wallet_timeout'), new Error('wallet_action_expired'), new Error('zap_action_unsettled'), new Error('plan_price_moved')]) {
    assert.equal(errors.transientWalletRead(error), false, String(error.message));
  }
});

test('the six token errors, reported by selector alone, are the decoder\'s generic case, and their tokens are said as a choice through the labeler', () => {
  const six = ['TokenCallFailed(address)', 'TransferFailed(address)', 'SettlementMismatch(address,uint256,uint256)', 'ApprovalFailed(address)', 'FeeNotBacked(address)', 'FeeTransferMismatch(address)'];
  assert.deepEqual([...errors.TOKEN_TRANSFER_ERRORS].sort(), [...six].sort());
  for (const signature of six) {
    const bare = errors.decodeRevertData(toFunctionSelector(`function ${signature}`), 'zap', LABELS);
    assert.deepEqual([bare.code, bare.copy, bare.token], [signature, GENERIC, undefined], signature);
    assert.ok(errors.ZAP_ERRORS.some((row) => row.signature === signature), `${signature} is a row of §2.12`);
  }
  // The app's labelers name the native currency themselves (src/v2in/journey/tokens.ts labelOf); without one, its symbol.
  const labels = { chainId: 4663, token: (address) => (address === ETH ? 'ETH' : labeler(address)) };
  assert.equal(errors.tokenChoice([USDG, ETH], labels), 'USDG or ETH');
  assert.equal(errors.tokenChoice([ETH, MANY], { chainId: 4663 }), `ETH or ${short(MANY)}`, 'the chain\'s native currency by its symbol');
  assert.equal(errors.tokenChoice([USDG, MANY, ETH], labels), `USDG, ${short(MANY)} or ETH`);
  assert.equal(errors.tokenChoice([USDG, USDG.toUpperCase().replace('0X', '0x')], labels), 'USDG', 'once each');
  assert.equal(errors.tokenChoice([MANY], { chainId: 4663 }), short(MANY), 'without a labeler, the short address');
  assert.equal(errors.tokenChoice([MANY], { chainId: 4663, token: () => '‮EVIL\u0000 {token}' }), 'EVIL {token}', 'safe text, never re-read');
  assert.equal(errors.tokenChoice([], labels), null);
  assert.equal(errors.tokenChoice(undefined, labels), null);
  assert.equal(errors.tokenChoice(['0x1234'], labels), null, 'not an address: nothing named');
});

test('the screens\' own sentences for what the decoder leaves to them say no jargon, and the console gets the whole failure in a browser only', () => {
  for (const copy of [errors.WALLET_NETWORK_COPY, errors.WALLET_NETWORK_BUSY_COPY, errors.SLOW_WALLET_COPY, errors.UNKNOWN_FAILURE_COPY]) {
    assert.doesNotMatch(copy, /revert|selector|rpc|simulat|transaction would fail|review again/i, copy);
    assert.match(copy, /Try again/);
  }
  assert.equal(errors.walletNetworkCopy('wallet_rpc_limited'), errors.WALLET_NETWORK_BUSY_COPY);
  for (const code of ['wallet_rpc_internal', 'wallet_rpc_no_header', 'wallet_rpc_timeout', 'wallet_rpc_empty', 'wallet_rpc_unreachable']) assert.equal(errors.walletNetworkCopy(code), errors.WALLET_NETWORK_COPY, code);
  const logged = [];
  const debug = console.debug;
  console.debug = (...args) => logged.push(args);
  try {
    errors.debugFailure('New position', 'wallet_rpc_internal', { code: -32603 });
    assert.deepEqual(logged, [], 'no window: nothing in the tests\' output');
    globalThis.window = {};
    const failure = { code: -32603, message: 'Internal JSON-RPC error.' };
    errors.debugFailure('New position', 'wallet_rpc_internal', failure);
    assert.equal(logged.length, 1);
    assert.equal(logged[0][0], '[domino] New position: wallet_rpc_internal');
    assert.equal(logged[0][1], failure, 'the error object itself, for DevTools to expand');
    console.debug = () => { throw new Error('console refused'); };
    assert.doesNotThrow(() => errors.debugFailure('x', 'y', null));
  } finally {
    console.debug = debug;
    delete globalThis.window;
  }
});
