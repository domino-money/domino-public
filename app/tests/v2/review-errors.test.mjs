/**
 * Added 2026-11-09 (core flows, errors). Friends on New position (Robinhood Chain's V2 review) and in a position's dialogs
 * met "The transaction would fail. Review again." for causes as far apart as their wallet's network, a token that limits
 * transfers, an amount the pool refuses and a slow wallet, and Review again brought the same sentence back. Each cause the
 * page can know now has its own sentence, its code stays in `data-error-code`, and the runs ask a read that met the
 * wallet's network failing once more before saying anything.
 *
 * src/v2in/journey/errors.ts is compiled here (it reaches the wallet, which this file stubs), as
 * tests/v2/v4-only-screens.test.mjs does; src/v2in/position/errors.ts is in the unit build.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import ts from 'typescript';
import { encodeErrorResult, parseAbiItem, toFunctionSelector } from 'viem';

const require = createRequire(import.meta.url);
const BUILD = '../../.test-build/app/src/';
const decoder = require(`${BUILD}v2/errors.js`);
const position = require(`${BUILD}v2in/position/errors.js`);
const { ZapRefusal } = require(`${BUILD}finance/v2/zap.js`);
const { financeErrorText } = require(`${BUILD}finance/words.js`);

/** New position's error words (src/v2in/journey/errors.ts), compiled here with its wallet module stubbed. */
function journeyErrors() {
  const path = new URL('../../src/v2in/journey/errors.ts', import.meta.url);
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const at = (name) => require(name.startsWith('./') ? `${BUILD}v2in/journey/${name.slice(2)}.js` : `${BUILD}${name.replace(/^(\.\.\/)+/, '')}.js`);
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)((name) => (name === './wallet' ? { JourneyNotice: class extends Error {} } : at(name)), mod, mod.exports);
  return mod.exports;
}
const journey = journeyErrors();

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const ETH = '0x0000000000000000000000000000000000000000';
const GENERIC = decoder.GENERIC_COPY;
const label = (address) => ({ [USDG]: 'USDG', [WETH]: 'WETH', [ETH]: 'ETH' })[address.toLowerCase()] ?? `${address.slice(0, 6)}…${address.slice(-4)}`;
const selector = (signature) => toFunctionSelector(`function ${signature}`);
const reverted = (signature, tokens) => ({ kind: 'reverted', selector: signature === null ? null : selector(signature), name: signature, ...(tokens ? { tokens } : {}) });
const errorString = (text) => encodeErrorResult({ abi: [parseAbiItem('error Error(string)')], errorName: 'Error', args: [text] });
const SIX = ['TokenCallFailed(address)', 'TransferFailed(address)', 'SettlementMismatch(address,uint256,uint256)', 'ApprovalFailed(address)', 'FeeNotBacked(address)', 'FeeTransferMismatch(address)'];
const JARGON = /revert|selector|\brpc\b|simulat|transaction would fail/i;

test('New position: the plan service\'s simulation refused by a token\'s transfer names every token the plan moves, none guessed', () => {
  for (const signature of SIX) {
    const said = journey.planFailure(reverted(signature, [USDG, WETH]), 4663, label);
    assert.deepEqual(said, { copy: 'USDG or WETH may limit transfers, so this position can’t be created. Try a smaller amount or another pool.', code: signature.slice(0, signature.indexOf('(')), recovery: 'other-pool' }, signature);
  }
  // Paid with a token outside the pool: all three, in the plan's order.
  assert.equal(journey.planFailure(reverted('TokenCallFailed(address)', [USDG, ETH, WETH]), 4663, label).copy, 'USDG, ETH or WETH may limit transfers, so this position can’t be created. Try a smaller amount or another pool.');
  // No tokens to name (an answer without them): the honest generic line, the code kept.
  assert.deepEqual(journey.planFailure(reverted('TokenCallFailed(address)'), 4663, label), { copy: journey.REFUSED_COPY, code: 'TokenCallFailed', recovery: 'review-again' });
});

test('New position: a revert nothing names says what the person can change, never "The transaction would fail. Review again."', () => {
  const said = (result) => journey.planFailure(result, 4663, label);
  assert.equal(journey.REFUSED_COPY, 'This position can’t be created with these choices. Try a different amount or pool.');
  for (const [result, code] of [
    [{ kind: 'reverted', selector: '0x08c379a0', name: 'Error(string)' }, 'Error'],
    [{ kind: 'reverted', selector: '0x4e487b71', name: 'Panic(uint256)' }, 'Panic'],
    [{ kind: 'reverted', selector: '0x12345678', name: null, tokens: [USDG, WETH] }, '0x12345678'],
    [{ kind: 'reverted', selector: null, name: null, tokens: [USDG, WETH] }, 'plan_simulation_reverted'],
  ]) assert.deepEqual([said(result).copy, said(result).code], [journey.REFUSED_COPY, code], code);
  // A revert the spec words keeps its words.
  assert.equal(said(reverted('InsufficientLiquidity(uint128,uint128)', [USDG, WETH])).copy, 'The price moved: this would add less liquidity than your minimum. No tokens moved.');
  assert.equal(said(reverted('InvalidPool()', [USDG, WETH])).copy, 'This pool isn\'t supported.');
});

test('New position: the wallet\'s network, a slow wallet and a changed one each have their own sentence', () => {
  const said = (error, changed) => journey.journeyError(error, 4663, label, changed);
  for (const [error, code] of [
    [{ code: -32603, message: 'Internal JSON-RPC error.' }, 'wallet_rpc_internal'],
    [{ code: -32000, message: 'header not found' }, 'wallet_rpc_no_header'],
    [new TypeError('Failed to fetch'), 'wallet_rpc_unreachable'],
    [Object.assign(new Error('Cannot decode zero data ("0x") with ABI parameters.'), { name: 'AbiDecodingZeroDataError' }), 'wallet_rpc_empty'],
    [{ message: 'Request timed out' }, 'wallet_rpc_timeout'],
  ]) assert.deepEqual(said(error), { copy: 'Your wallet’s network didn’t answer. Try again.', code, recovery: 'retry' }, code);
  for (const error of [{ code: -32005, message: 'Request rate exceeded' }, { code: 429, message: 'Too Many Requests' }]) {
    assert.deepEqual(said(error), { copy: 'Your wallet’s network is busy. Try again in a moment.', code: 'wallet_rpc_limited', recovery: 'retry' });
  }
  // The money client's window ran out (finance/v2/transact.ts) while the wallet stayed the same: slow, not changed.
  assert.equal(said(new Error('wallet_action_expired')).copy, 'Your wallet took too long to answer. Try again.');
  assert.equal(said(new Error('wallet_action_expired'), false).code, 'wallet_action_expired', 'the code as before');
  assert.equal(said(new Error('wallet_action_expired'), true).copy, 'Your wallet changed while this was open. Review again.');
  assert.equal(said(new Error('wallet_identity_changed')).copy, 'Your wallet changed while this was open. Review again.');
  // Untouched: the person's own refusal, and a wallet that did not answer the window.
  assert.equal(said({ code: 4001, message: 'User rejected the request.' }).copy, 'You declined in your wallet. Nothing was sent.');
  assert.equal(said(new Error('wallet_timeout')).copy, 'Your wallet did not answer in time. Check it, then review again.');
});

test('New position: the zap client\'s review codes that had no words have their own', () => {
  const said = (code, chainId = 4663) => journey.journeyError(new ZapRefusal([code, 'plan_shape']), chainId, label);
  assert.deepEqual(said('registry_rank_mismatch'), { copy: 'Domino’s settings on Robinhood Chain changed. Reload the page, then try again.', code: 'registry_rank_mismatch', recovery: 'none' });
  assert.equal(said('registry_rank_mismatch', 8453).copy, 'Domino’s settings on Base changed. Reload the page, then try again.');
  // finance/words.ts's own sentences, written in src/v2/errors.ts (not imported: V1's chunk) and kept equal here.
  assert.equal(said('native_eth_refused').copy, financeErrorText('native_eth_refused', '', 'Create position'));
  assert.equal(decoder.nativeRefusedCopy('ETH'), financeErrorText('native_eth_refused', '', 'Create position'));
  assert.equal(decoder.nativeRefusedCopy('HYPE'), financeErrorText('native_eth_refused', '', 'Create position').replaceAll('ETH', 'HYPE'));
  assert.equal(decoder.UNREADABLE_REPLY_COPY, `${financeErrorText('invalid_wallet_reply', '', 'Create position')} Try again.`);
  assert.deepEqual(said('invalid_wallet_reply'), { copy: 'Your wallet returned an answer that could not be read. Try again.', code: 'invalid_wallet_reply', recovery: 'retry' });
  for (const code of ['rank_unread', 'permit2_account_not_plain']) assert.deepEqual(said(code), { copy: 'This plan can’t be executed. Review it again.', code, recovery: 'requote' }, code);
  // A step that reverted (its simulation, or on chain): the decoder reads the word "revert" in its code as a revert with no
  // data, as before (code `empty`, no fresh quote by itself, so a step that failed on chain is said), in the honest line.
  assert.deepEqual(journey.journeyError(new Error('batch_simulation_reverted'), 4663, label), { copy: journey.REFUSED_COPY, code: 'empty', recovery: 'review-again' });
});

test('New position: a thrown revert nothing names, and a failure nothing names at all, have honest sentences; the code stays', () => {
  const said = (error) => journey.journeyError(error, 4663, label);
  assert.deepEqual(said({ code: 3, message: 'execution reverted', data: errorString('STF') }), { copy: journey.REFUSED_COPY, code: 'Error', recovery: 'review-again' });
  assert.deepEqual(said({ code: 3, message: 'execution reverted' }), { copy: journey.REFUSED_COPY, code: 'empty', recovery: 'review-again' });
  assert.deepEqual(said(new Error('Something odd happened')), { copy: 'This didn’t go through. Try again.', code: 'unknown', recovery: 'review-again' });
  assert.deepEqual(said(new Error('relayed_not_offered')), { copy: 'This didn’t go through. Try again.', code: 'relayed_not_offered', recovery: 'review-again' });
  // A revert the spec words is said as before, with its token.
  const data = encodeErrorResult({ abi: [parseAbiItem('error TokenCallFailed(address)')], errorName: 'TokenCallFailed', args: [USDG] });
  assert.equal(said({ code: 3, message: 'execution reverted', data }).copy, 'A transfer of USDG failed. Check its approval and your balance.');
});

test('the position\'s dialogs: the same causes, in the dialog\'s words; elsewhere (Close positions, a direct withdrawal) a line that fits any action', () => {
  for (const signature of SIX) {
    assert.equal(position.planFailure(reverted(signature, [USDG, WETH]), 4663, label).copy, 'USDG or WETH may limit transfers, so this can’t go through. Try a smaller amount.', signature);
  }
  assert.equal(position.DIALOG_REFUSED_COPY, 'This can’t go through with these choices. Try a different amount or range.');
  assert.equal(position.ACTION_REFUSED_COPY, 'This can’t go through right now. Try again later.');
  assert.deepEqual(position.planFailure({ kind: 'reverted', selector: '0x4e487b71', name: null }, 8453), { copy: position.DIALOG_REFUSED_COPY, code: 'Panic', recovery: 'review-again' });
  assert.deepEqual(position.planFailure({ kind: 'reverted', selector: null, name: null }, 8453), { copy: position.DIALOG_REFUSED_COPY, code: 'plan_simulation_reverted', recovery: 'review-again' });
  const empty = { code: 3, message: 'execution reverted' };
  assert.equal(position.actionError(empty, 8453).copy, position.ACTION_REFUSED_COPY, 'Close positions, a direct withdrawal, an approval');
  assert.equal(position.actionError(empty, 8453, label, { refused: position.DIALOG_REFUSED_COPY }).copy, position.DIALOG_REFUSED_COPY, 'the dialog\'s run');
  assert.equal(position.actionError(new Error('batch_simulation_reverted'), 8453, label, { refused: position.DIALOG_REFUSED_COPY }).copy, position.DIALOG_REFUSED_COPY);
  assert.deepEqual(position.actionError({ code: -32603, message: 'Internal JSON-RPC error.' }, 8453), { copy: 'Your wallet’s network didn’t answer. Try again.', code: 'wallet_rpc_internal', recovery: 'retry' });
  assert.equal(position.actionError({ code: -32005, message: 'limit exceeded' }, 8453).copy, 'Your wallet’s network is busy. Try again in a moment.');
  assert.equal(position.actionError(new Error('wallet_action_expired'), 8453).copy, 'Your wallet took too long to answer. Try again.');
  assert.equal(position.actionError(new Error('wallet_action_expired'), 8453, label, { walletChanged: true }).copy, 'Your wallet changed while this was open. Review again.');
  assert.equal(position.actionError(new Error('position_identity'), 8453).copy, 'This position couldn’t be verified, so Domino can’t change it.');
  assert.equal(position.actionError(new ZapRefusal(['registry_rank_mismatch']), 42161).copy, 'Domino’s settings on Arbitrum One changed. Reload the page, then try again.');
  assert.equal(position.actionError(new Error('invalid_wallet_reply'), 8453).copy, 'Your wallet returned an answer that could not be read. Try again.');
  assert.equal(position.actionError(new Error('Something odd happened'), 8453).copy, 'This didn’t go through. Try again.');
  // The codes the dialogs already worded keep their words.
  assert.equal(position.actionError(new Error('native_eth_refused'), 4663).copy, 'Your account can’t receive ETH directly. Use another account.');
  assert.equal(position.actionError(new Error('position_vault_successor'), 8453).copy.startsWith('Your automation holds this position.'), true);
});

test('no cause either screen can name says the old sentence, and none of the new sentences says a word of jargon', () => {
  const thrown = [
    { code: -32603, message: 'Internal JSON-RPC error.' }, { code: -32005, message: 'limit exceeded' }, { code: -32000, message: 'header not found' },
    new TypeError('Failed to fetch'), new Error('wallet_action_expired'), new Error('invalid_wallet_reply'), new Error('batch_simulation_reverted'),
    new ZapRefusal(['registry_rank_mismatch']), new ZapRefusal(['rank_unread']), new ZapRefusal(['native_eth_refused']), new Error('position_identity'),
    { code: 3, message: 'execution reverted' }, { code: 3, message: 'execution reverted', data: errorString('STF') }, new Error('Something odd happened'),
  ];
  const plans = [...SIX.map((signature) => reverted(signature, [USDG, WETH])), { kind: 'reverted', selector: '0x12345678', name: null }, { kind: 'reverted', selector: null, name: null }, { kind: 'reverted', selector: '0x08c379a0', name: null }];
  const all = [
    ...thrown.map((error) => journey.journeyError(error, 4663, label)),
    ...thrown.map((error) => position.actionError(error, 8453, label)),
    ...thrown.map((error) => position.actionError(error, 8453, label, { refused: position.DIALOG_REFUSED_COPY })),
    ...plans.map((result) => journey.planFailure(result, 4663, label)),
    ...plans.map((result) => position.planFailure(result, 8453, label)),
  ];
  for (const said of all) {
    assert.notEqual(said.copy, GENERIC, said.code);
    assert.doesNotMatch(said.copy, JARGON, `${said.code}: ${said.copy}`);
    assert.match(said.code, /^[A-Za-z0-9_x]{1,64}$/, 'a code for data-error-code, never text');
  }
});

// The runs are React hooks, outside this build: their source says what they do.
test('both runs ask a read that met the wallet\'s network failing once more, and only reads: never a send, a batch or a signature', () => {
  for (const [file, review] of [
    ['../../src/v2in/journey/run.ts', 'onceMore(gen, () => connection.zap.review('],
    ['../../src/v2in/position/run.ts', 'onceMore(gen, () => zap.review('],
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.ok(source.includes(review), `${file}: the review`);
    assert.match(source, /onceMore\(gen, \(\) => (connection\.)?zap\.consentFor\(/, `${file}: the consent path`);
    assert.ok(source.includes('onceMore(gen, () => zap.prepareBatch(reviewed.review))'), `${file}: a batch's preparation`);
    assert.ok(source.includes('onceMore(gen, () => zap.prepareStep(reviewed.review, step.index))'), `${file}: a step's preparation`);
    assert.doesNotMatch(source, /onceMore\([^)]*\(\) => [^)]*\.(send|sendBatch|signPermit|prepareCancelNonce)\(/, `${file}: nothing that reaches the wallet's prompt`);
    assert.match(source, /if \(gen !== generation\.current \|\| !transientWalletRead\(error\)\) throw error\s+await sleep\(WALLET_READ_RETRY_MS\)\s+if \(gen !== generation\.current\) throw error\s+return read\(\)/, `${file}: once, while the quote is current`);
    assert.match(source, /walletChanged/, `${file}: tells a changed wallet from a slow one`);
  }
});
