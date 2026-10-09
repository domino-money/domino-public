/**
 * The position page's Domino V2 integration (src/v2in/position, 2026-10-02), its pure parts, on the packages' own
 * fixtures (no plan is shown before the deploy any more: real data only, the owner, 2026-10-02): the one shape the actions
 * take, from V1's chain read and from read-v6 (vault custody, reserves, receipts);
 * the card V1's components draw for a read-v6 position (its real pool identity, plain marks off Robinhood); the failures'
 * words (F1–F4 codes, the plan API's table, the wallet's refusal); the forms' plan inputs; the owner's decisions.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { encodeAbiParameters, keccak256 } from 'viem';
import * as readRuntime from '../../../api-contracts/read-v6/runtime.mjs';

const require = createRequire(import.meta.url);
const build = (path) => require(`../../.test-build/app/src/${path}.js`);
const model = build('v2in/position/model');
const errors = build('v2in/position/errors');
const forms = build('v2in/position/forms');
const tokens = build('v2in/position/tokens');
const card = build('v2in/position/card');
const marks = build('v2in/position/marks');
const constants = build('v2in/position/constants');
const copy = build('v2in/position/copy');
const { v2Chain } = build('v2/chains');
const { v3PoolAddress } = build('finance/v2/direct');

const CONTRACTS = resolve(import.meta.dirname, '../../../api-contracts');
const json = (...parts) => JSON.parse(readFileSync(join(CONTRACTS, ...parts), 'utf8'));
const portfolio = json('read-v6', 'fixtures', 'valid', 'portfolio.json');
const activity = json('read-v6', 'fixtures', 'valid', 'activity.json');
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const MANY = '0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a';

test('the actions\' one shape from V1\'s chain read: Robinhood v4, the pool in its own order, nothing from a guess', () => {
  const wallet = {
    tokenId: '77', status: 'open', poolId: `0x${'ab'.repeat(32)}`,
    currencies: [{ address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18 }, { address: USDG, symbol: 'USDG', decimals: 6 }],
    fee: 3000, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000', tickLower: -600, tickUpper: 600, liquidity: '1000',
    sqrtPriceX96: '79228162514264337593543950336', tick: 0, unclaimedFees: ['1', '2'], principal: ['3', '4'],
  };
  const position = model.fromWalletPosition(wallet, '0xB1b1B1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1');
  assert.deepEqual({ chainId: position.chainId, dex: position.dex, tokenId: position.tokenId, owner: position.owner, liquidity: position.liquidity, tick: position.tick, source: position.source }, { chainId: 4663, dex: 4, tokenId: 77n, owner: '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1', liquidity: 1000n, tick: 0, source: 'chain' });
  assert.deepEqual(position.pool, { dex: 4, currency0: '0x0000000000000000000000000000000000000000', currency1: USDG, fee: 3000, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000' });
  assert.equal(model.hookedPool(position.pool), false);
  // The pair listed the other way round is the same pool, in the pool's own order (2026-10-02: V1's read may list it either
  // way); a malformed id is no action shape at all.
  assert.deepEqual(model.fromWalletPosition({ ...wallet, currencies: [wallet.currencies[1], wallet.currencies[0]] }, '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1').pool, position.pool);
  assert.equal(model.fromWalletPosition({ ...wallet, tokenId: '077' }, '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1'), null);
  assert.equal(model.hookedPool({ ...position.pool, hooks: '0x00000000000000000000000000000000000000c0' }), true);
});

test('the actions\' one shape from read-v6: live positions only, the vault\'s role and custody, its reserves, the position\'s receipts', () => {
  assert.equal(readRuntime.validateResponse('portfolio', portfolio), true);
  const root = model.findPosition(portfolio, 4663, 4, 7n);
  const successor = model.findPosition(portfolio, 4663, 4, 8n);
  const plain = model.findPosition(portfolio, 4663, 4, 9n);
  assert.equal(model.findPosition(portfolio, 8453, 4, 7n), null, 'identity is chain + DEX + id');
  assert.equal(model.findPosition(portfolio, 4663, 3, 7n), null);
  const rootAction = model.fromV6(root, portfolio);
  assert.deepEqual(rootAction.vault, { address: '0xa2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2', role: 'root', armed: true, exitLive: false });
  assert.equal(rootAction.source, 'read6', 'read-v6 is the one source besides V1\'s own chain read: no test data');
  assert.equal(model.fromV6(successor, portfolio).vault.role, 'successor');
  assert.equal(model.fromV6(plain, portfolio).vault, null);
  // An unread position is never acted on.
  assert.equal(model.fromV6(model.findPosition(portfolio, 4663, 4, 12n), portfolio), null);
  assert.equal(model.fromV6(model.findPosition(portfolio, 4663, 4, 13n), portfolio), null);
  assert.deepEqual(model.vaultReservesOf(portfolio, 4663, '0xa2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2').reserves, [{ token: USDG, amount: 1202n }, { token: MANY, amount: 990n }]);
  assert.equal(model.vaultReservesOf(portfolio, 4663, '0xa5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5').reserves, null, 'not read: never a made-up zero');
  assert.deepEqual(model.positionVault(portfolio, 4663, { address: '0xa6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6', role: 'root' }), { address: '0xa6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6', role: 'root', armed: null, exitLive: false }, 'custody unread: null, never guessed');
  // Added 2026-10-06 (the integration review, rugged-literal #1): whether Auto-exit is on or paused on a root, its own
  // automation's (paused, an active order listed on the root): there only a moved approval pauses anything.
  const ROOT_VAULT = '0xa2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2';
  const [active] = portfolio.mandates;
  const own = (mandates, paused = true) => ({ ...portfolio, mandates, vaults: portfolio.vaults.map((vault) => (vault.address === ROOT_VAULT ? { ...vault, state: { ...vault.state, paused } } : vault)) });
  assert.deepEqual([active.vault, active.tokenId, active.status, active.expired, active.blockedBy], [ROOT_VAULT, '7', 'active', false, []]);
  assert.equal(model.fromV6(root, own([active])).vault.exitLive, true, 'on');
  assert.equal(model.fromV6(root, own([{ ...active, blockedBy: ['custody_lost'] }])).vault.exitLive, true, 'paused');
  assert.equal(model.fromV6(root, own([{ ...active, status: 'revoked' }])).vault.exitLive, false, 'turned off');
  assert.equal(model.fromV6(root, own([{ ...active, expired: true }])).vault.exitLive, false, 'expired');
  assert.equal(model.fromV6(root, own([active], false)).vault.exitLive, false, 'a running automation is never Auto-exit\'s own');
  assert.equal(model.fromV6(successor, own([active])).vault.exitLive, false, 'a successor is its vault\'s');
  assert.equal(readRuntime.validateResponse('activity', activity), true);
  assert.deepEqual(model.actionsOfPosition(activity, 4663, 9n).map((item) => item.action), ['exit', 'create']);
  assert.deepEqual(model.actionsOfPosition(activity, 8453, 9n), []);
  const book = tokens.tokenBook(4663, model.tokensOf(portfolio, 4663));
  assert.equal(tokens.labelOf(book, MANY), 'MANY');
  assert.equal(tokens.decimalsOf(book, MANY), null, 'decimals unread: null, never guessed');
  assert.equal(tokens.amountText(book, MANY, 990n), `990 ${copy.COPY.form.rawUnits} of MANY`);
  assert.equal(tokens.amountText(book, USDG, 1_202_000n), '1.202 USDG');
});

test('the card and marks preserve exact chain/address identities across supported networks', () => {
  const plain = model.findPosition(portfolio, 4663, 4, 9n);
  const book = tokens.tokenBook(4663, model.tokensOf(portfolio, 4663));
  const drawn = card.cardOf(plain, book);
  const id = keccak256(encodeAbiParameters([{ type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] }], [{ currency0: plain.pool.currency0, currency1: plain.pool.currency1, fee: 3000, tickSpacing: 60, hooks: plain.pool.hooks }]));
  assert.equal(drawn.poolId, id);
  assert.equal(drawn.tokenId, '9');
  assert.equal(drawn.positionManager, plain.manager);
  assert.equal(drawn.inRange, true);
  assert.equal(drawn.valuation.reason, 'no_qualified_price_source', 'no USD');
  assert.equal(drawn.principal[0].raw, plain.principal[0].toString());
  // v3: the factory's CREATE2 address, as a 32-byte word.
  const v3 = { ...plain, chainId: 8453, dex: 3, pool: { dex: 3, currency0: '0x4200000000000000000000000000000000000006', currency1: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', fee: 500, tickSpacing: 10, hooks: '0x0000000000000000000000000000000000000000' } };
  const address = v3PoolAddress(v2Chain(8453), v3.pool.currency0, v3.pool.currency1, 500);
  assert.deepEqual(card.poolIdentity(8453, v3.pool), { kind: 'v3', address });
  const baseCard = card.cardOf(v3, tokens.tokenBook(8453));
  assert.equal(baseCard.poolId, `0x${address.slice(2).padStart(64, '0')}`);
  assert.deepEqual(baseCard.currencies.map((token) => [token.chainId, token.symbol, token.readStatus, token.artwork]), [[8453, 'WETH', 'available', 'WETH'], [8453, 'USDC', 'available', null]], 'metadata and artwork resolve on the actual network');
  assert.equal(marks.markOf(4663, { address: USDG, symbol: 'USDG', decimals: 6 }).readStatus, 'available');
  assert.equal(marks.markOf(8453, { address: USDG, symbol: 'USDG', decimals: 6 }).artwork, null, 'same address on another chain never inherits Robinhood curated artwork');
  const generic = marks.markOf(42161, { address: MANY, symbol: 'USDG', decimals: null });
  assert.deepEqual([generic.chainId, generic.readStatus, generic.artwork], [42161, 'partial', null], 'a symbol cannot select artwork or turn missing metadata into a nonexistent contract');
});

test('the failures\' words: the money clients\' codes (rev2 review F1-F4), the plan API\'s table, the wallet\'s refusal; the code never in the text', () => {
  const said = (error) => errors.actionError(error, 8453);
  assert.match(said(new Error('zap_action_unsettled')).copy, /not settled on Base yet/);
  assert.equal(said(Object.assign(new Error('x'), { failures: ['plan_route_target', 'plan_shape'] })).copy, 'This plan would swap into something you didn’t ask for, so nothing was sent. Review it again.');
  assert.equal(said(new Error('plan_price_moved')).recovery, 'requote');
  assert.equal(said(new Error('position_vault_root')).copy, constants.ROOT_CHANGE_RANGE_COPY);
  assert.equal(said(new Error('position_vault_successor')).copy, constants.SUCCESSOR_BLOCKED_COPY);
  assert.equal(said(new Error('position_pool_has_hooks')).copy, constants.HOOKED_COPY);
  // The money lock before V2's contracts are live (finance/v2/liveLock.ts ContractsNotLive): the gate's own sentence.
  assert.deepEqual([said(new Error('contracts_not_live')).copy, said(new Error('contracts_not_live')).code], ["This opens as soon as Domino's service is live on Base.", 'contracts_not_live']);
  assert.equal(said(Object.assign(new Error('User rejected the request.'), { code: 4001 })).copy, 'You declined in your wallet. Nothing was sent.');
  assert.equal(said(new errors.WalletNotice('Add Base to your wallet, then try again.', 'unknown_chain')).copy, 'Add Base to your wallet, then try again.');
  const unknown = said(new Error('Something odd happened'));
  assert.equal(unknown.code, 'unknown');
  assert.doesNotMatch(unknown.copy, /unknown/);
  const planned = (result) => errors.planFailure(result, 4663);
  assert.equal(planned({ kind: 'refused', code: 'session_required', status: 401 }).copy, 'Sign in with your wallet first.');
  assert.equal(planned({ kind: 'refused', code: 'position_plan_nothing_to_convert', status: 422 }).recovery, 'offer-both');
  assert.equal(planned({ kind: 'refused', code: 'position_plan_unavailable', status: 503 }).copy, 'Not available on Robinhood Chain right now.');
  assert.equal(planned({ kind: 'expired' }).recovery, 'quiet-requote');
  assert.equal(planned({ kind: 'reverted', selector: '0xe49b763d', name: null }).copy, 'The price moved: this would add less liquidity than your minimum. No tokens moved.');
});

test('the forms\' plan inputs: amounts in each token\'s own units, a zero refused, a range around the price on the pool\'s spacing, a share', () => {
  const pool = { dex: 4, currency0: '0x0000000000000000000000000000000000000000', currency1: USDG, fee: 3000, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000' };
  const book = tokens.tokenBook(4663);
  const value = { mode: 'one', token: USDG, text: { [USDG]: '12.5' } };
  assert.deepEqual(forms.inputsOf(value, pool, book), [{ token: USDG, amount: 12_500_000n }]);
  assert.equal(forms.inputsOf({ ...value, text: { [USDG]: '0' } }, pool, book), null, 'nothing to add');
  assert.equal(forms.inputsOf({ ...value, text: { [USDG]: 'abc' } }, pool, book), null);
  assert.deepEqual(forms.inputsOf({ mode: 'both', token: USDG, text: { [pool.currency0]: '0.1', [USDG]: '300' } }, pool, book), [{ token: pool.currency0, amount: 100_000_000_000_000_000n }, { token: USDG, amount: 300_000_000n }]);
  assert.deepEqual(forms.otherTokens(4663, pool), ['0x0bd7d308f8e1639fab988df18a8011f41eacad73'], 'WETH, the one charge currency or wrapped token outside this pool');
  const ticks = forms.ticksOf({ preset: 'medium', lower: '', upper: '' }, pool, -198_080, book);
  assert.ok(ticks.tickLower % 60 === 0 && ticks.tickUpper % 60 === 0, 'on the spacing of the pool');
  assert.ok(ticks.tickLower < -198_080 && ticks.tickUpper > -198_080);
  assert.equal(forms.ticksOf({ preset: 'custom', lower: '3000', upper: '2000' }, pool, 0, book), null, 'a range upside down');
  assert.equal(forms.shareOf(1000n, '100'), 1000n);
  assert.equal(forms.shareOf(1001n, '50'), 500n);
  assert.equal(forms.shareOf(1000n, '25'), 250n);
});

test('change range shows the observed sqrt price, not a rounded tick or a guessed token decimal', () => {
  const a = '0x0000000000000000000000000000000000000001';
  const b = '0x0000000000000000000000000000000000000002';
  const book = new Map([[a, { address: a, symbol: 'A', decimals: 6 }], [b, { address: b, symbol: 'B', decimals: 6 }]]);
  const pool = { currency0: a, currency1: b };
  const observed = { pool, sqrtPriceX96: ((1n << 96n) * 101n) / 100n, tick: 0 };
  assert.equal(forms.rangeReferencePrice(observed, book), '1.0201', 'the observation wins over the integer tick');
  assert.equal(forms.rangeReferencePrice({ ...observed, sqrtPriceX96: null }, book), null);
  assert.equal(forms.rangeReferencePrice({ ...observed, sqrtPriceX96: 0n }, book), null, 'an invalid observation cannot crash the dialog');
  assert.equal(forms.rangeReferencePrice(observed, new Map([[a, book.get(a)]])), null, 'missing decimals stay unavailable');
});

test('the owner\'s decisions, one named constant each', () => {
  assert.deepEqual([constants.POSITION_SLIPPAGE_DEFAULT_BPS, constants.POSITION_SLIPPAGE_MIN_BPS, constants.POSITION_SLIPPAGE_MAX_BPS, constants.POSITION_SLIPPAGE_WARN_ABOVE_BPS], [50, 10, 500, 200], 'decision #2');
  assert.equal(constants.HIGH_SLIPPAGE_COPY, 'High slippage: you may receive noticeably less than quoted.');
  assert.deepEqual([constants.QUOTE_LIFETIME_S, constants.PLAN_DEADLINE_S], [180, 300], 'decision #3');
  assert.equal(constants.RELAYED_OFFERED, false, 'decision #4');
  assert.equal(constants.ROOT_BLOCKS_CHANGE_RANGE, true, 'decision #5');
  assert.equal(constants.ROOT_PAUSE_COPY, 'This pauses automation for this position. You can turn it back on afterwards.');
  // Added 2026-10-06 (the integration review, rugged-literal #1): on Auto-exit's own root, only a moved approval pauses it.
  assert.deepEqual([constants.EXIT_PAUSE_COPY, constants.EXIT_REARM_COPY], ['This pauses Auto-exit until you approve this position again.', 'Approve again']);
  // Review of 2026-10-03 (#13): the blocked reasons are the "···" menu's heading, said for a person who knows no pool.
  assert.equal(constants.HOOKED_COPY, "Pools with hooks aren't supported yet.", 'decision #6');
  // Changed on purpose 2026-10-04 (the owner: no "vault" in the UI; "your automation").
  assert.equal(constants.SUCCESSOR_BLOCKED_COPY, "Your automation holds this position. Withdraw it from your automation on your main position's page first.");
  // Changed on purpose 2026-10-06 (rugged97's item 4: read-v6 1.1.0-rc.1's qualified USD, by decision #22's rules).
  assert.equal(constants.USD_SHOWN, true, 'decision #22, with its qualified sources');
  assert.equal(constants.CHANGE_RANGE_BURNS_WHEN_ALL, true);
  assert.equal(constants.EXIT_BURNS, false);
  assert.equal(copy.COPY.custody.zapApproved, 'Domino can manage this position for you when you ask.');
  assert.equal(copy.COPY.lede.changeRange, 'Changing the range closes this position and opens a new one (new NFT).');
  assert.equal(copy.COPY.review.feesSent, 'Uncollected fees will also be sent to your wallet.');
  // Review of 2026-10-03 (#16): the fee's label alone; its base on the value's sub-line, as New position's review does.
  assert.equal(copy.COPY.review.fee, 'Domino fee');
  assert.equal(copy.COPY.review.feeRate, '0.65% of the amount swapped');
  assert.equal(copy.COPY.form.directNote, 'No Domino fee.');
  assert.equal(copy.COPY.review.wethWarning, 'On this pool, unused ETH comes back as WETH.');
  assert.equal(copy.COPY.receipt.fee, 'Domino fee (0.65% of the amount swapped)');
  // Review of 2026-10-03 (#11, #19): no test data and no second "locked" sentence anywhere in the page's words.
  assert.deepEqual(Object.keys(copy.COPY.review).filter((key) => /test|example|preview/i.test(key)), []);
  assert.deepEqual(Object.keys(copy.COPY.page).filter((key) => /test|example/i.test(key)), []);
  assert.equal('PREVIEW_EXAMPLE_PLANS' in constants, false);
});
