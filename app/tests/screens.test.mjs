/**
 * The read screens' pure modules (#2 position cards, #3 selectors, #13
 * figures), against rugged97's package fixtures and the real package runtime,
 * through slice A's pipeline, scheduler and pagers. Nothing here re-implements
 * a validator or a fixture.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import * as runtime from '../../api-contracts/read-v1/runtime.mjs';

const require = createRequire(import.meta.url);
const built = (name) => require(`../.test-build/app/src/lib/read/${name}.js`);
const identity = built('screens/identity');
const fee = built('screens/fee');
const { readWithin, withReadBudget, SCREEN_BUDGET_MS } = built('screens/screenRead');
const { createAppMarketsProvider } = built('screens/appMarkets');
const { describeFailure } = built('describe');
const project = built('project');
const positions = built('screens/positions');
const cards = require('../.test-build/app/src/lib/walletCards.js');
const tokens = built('screens/tokens');
const walletSession = built('screens/walletSession');
const pools = built('screens/poolsList');
const poolRange = built('screens/poolRange');
const catalogue = built('screens/catalogueSession');
const figures = built('screens/figures');
const marketList = built('screens/marketList');
const copy = built('screens/copy');
const { withDelays } = built('screens/delayedSource');
const { APP_SCRIPT, FIXTURE_NFT_IDS, FIXTURE_OWNER } = built('screens/appScript');
const { createFixtureSource } = built('fixtureSource');
const { createScheduledSource } = built('scheduler');
// F3 renamed this: the table loads exactly the reviewed pool selection.
const { loadSelectedPools } = built('marketsProvider');
const { MARKET_CASES, PROJECTION_CASES, projectionTokens, FIXTURE_POOL, FIXTURE_TOKEN, NATIVE, MUTATED_CURSOR, gateway, errorFixture, invalidFixture, withCursor, withNextCataloguePage } = built('scenarios');
const markets = require('../.test-build/app/src/lib/markets.js');
const ts = require('typescript');

const READ = resolve(import.meta.dirname, '../../api-contracts/read-v1');
const SRC = resolve(import.meta.dirname, '../src');
const text = (path) => readFileSync(join(READ, path), 'utf8');
const catalog = { index: JSON.parse(text('fixtures/index.json')), text };
const fixture = (name) => JSON.parse(text(`fixtures/gateway/${name}.json`));
const fixtures = (script, options = {}) => createFixtureSource({ catalog, validators: runtime, script, ...options });
const BIG = FIXTURE_NFT_IDS[1];
const live = () => new AbortController().signal;
const PROVENANCE_BANNED = /\b(current|live|updated|qualified)\b/i;
const OTHER_ADDRESS = `0x${'12'.repeat(20)}`;
const flush = () => new Promise((done) => setImmediate(done));

/** A clock that moves only when a test says so; sleeps wait for it. */
function manualClock() {
  let now = 0;
  const timers = [];
  return {
    now: () => now,
    // The read pipeline times itself on a monotonic reading, never on the wall
    // clock: this one moves with the test's own advance() and nothing else.
    monotonic: () => now,
    random: () => 0,
    sleep(ms, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const timer = { at: now + ms, resolve };
        timers.push(timer);
        signal?.addEventListener(
          'abort',
          () => {
            const i = timers.indexOf(timer);
            if (i !== -1) timers.splice(i, 1);
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
    /** The deadline timer of pipeline.ts, on the same list advance() drains. */
    timer(ms, callback) {
      const entry = { at: now + ms, resolve: callback };
      timers.push(entry);
      return () => {
        const i = timers.indexOf(entry);
        if (i !== -1) timers.splice(i, 1);
      };
    },
    async advance(ms) {
      now += ms;
      for (const timer of timers.filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.resolve();
      }
      await flush();
      await flush();
    },
    pending: () => timers.length,
  };
}

/** A clock whose sleeps pass at once, moving time forward by what was asked. */
function autoClock() {
  let now = 0;
  return {
    now: () => now,
    // Same reading as now(): this clock only ever moves forward, by what a
    // sleep asked for, so wall time and monotonic time cannot diverge here.
    monotonic: () => now,
    timer: () => () => undefined,
    random: () => 0,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw signal.reason;
      now += ms;
    },
  };
}

const tokenMap = (...names) => {
  const map = new Map();
  for (const name of names) {
    const asset = fixture(name).asset;
    map.set(asset.address, { origin: 'read', chainId: 4663, address: asset.address, symbol: asset.symbol, decimals: asset.decimals, readStatus: asset.readStatus, artwork: null });
  }
  return map;
};

const BASE_TOKENS = [
  { fixture: gateway('token.native'), expectRequest: { token: NATIVE } },
  { fixture: gateway('token.success'), expectRequest: { token: FIXTURE_TOKEN } },
];

// ---------------------------------------------------------------------------
// Identity (#3 S-ID1..3, T-S1..3)
// ---------------------------------------------------------------------------

test('a pasted address is accepted exactly when the read contract accepts it, as typed, with nothing trimmed', () => {
  const boundaries = JSON.parse(text('fixtures/request-boundaries.json')).filter((c) => c.route === 'token');
  const names = [];
  for (const c of boundaries) {
    const payload = JSON.parse(c.json);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 1 || typeof payload.token !== 'string') continue;
    names.push(c.name);
    const parsed = identity.parseAddressInput(payload.token);
    assert.equal(parsed.ok, runtime.validateRequest('token', payload), `${c.name} disagrees with validateRequest`);
    assert.equal(parsed.ok, c.valid, `${c.name} disagrees with the boundary corpus`);
    if (parsed.ok) {
      assert.equal(parsed.wire, payload.token, 'sent exactly as typed');
      assert.equal(parsed.key, payload.token.toLowerCase());
    }
  }
  for (const needed of ['token-newline', 'token-crlf', 'token-upper-prefix', 'token-upper-digits', 'token-zero', 'token-short', 'token-long', 'token-invalid-hex']) {
    assert.ok(names.includes(needed), `boundary case ${needed} was exercised`);
  }
  const address = '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
  assert.deepEqual(identity.parseAddressInput(`${address}\n`), { ok: false, reason: 'line_break' });
  assert.deepEqual(identity.parseAddressInput(`${address}\r\n`), { ok: false, reason: 'line_break' });
  assert.deepEqual(identity.parseAddressInput(` ${address}`), { ok: false, reason: 'whitespace' });
  assert.deepEqual(identity.parseAddressInput(`0X${address.slice(2)}`), { ok: false, reason: 'prefix' });
  assert.deepEqual(identity.parseAddressInput(''), { ok: false, reason: 'empty' });
  for (const pasted of [`${address}\n`, `${address}\r\n`, `${address.slice(0, 20)}\n${address.slice(20)}`]) {
    assert.deepEqual(identity.screenPaste(pasted), { ok: false, reason: 'line_break' }, JSON.stringify(pasted));
  }
  assert.deepEqual(identity.screenPaste(address), { ok: true });
});

test('native ETH and a wrapped ERC-20 are two identities, and two rows', () => {
  const native = tokens.candidateFromToken(fixture('token.native'), NATIVE);
  const wethData = fixture('token.success');
  wethData.asset.address = '0x7777777777777777777777777777777777777777';
  wethData.asset.symbol = 'WETH';
  const weth = tokens.candidateFromToken(wethData, wethData.asset.address);
  assert.equal(native.kind, 'native');
  assert.equal(weth.kind, 'erc20_candidate');
  assert.notEqual(native.key, weth.key);
  assert.equal(tokens.mergeCandidates([native], [weth]).length, 2);
});

test('address search matches hex only, never symbol text, and the same symbol at two addresses stays two rows', () => {
  const data = fixture('pools.success');
  const twin = structuredClone(data.pools[0]);
  twin.poolId = `0x${'cd'.repeat(32)}`;
  data.pools.push(twin);
  const view = pools.projectPoolsView(runtime.assertResponse('pools', data));
  assert.equal(view.options.length, 2, 'two pools with the same symbols are two options');
  assert.notEqual(view.options[0].key, view.options[1].key);
  const rows = [{ key: '0x1111111111111111111111111111111111111111' }, { key: '0x0000000000000000000000000000000000000000' }];
  assert.deepEqual(identity.searchByAddress(rows, 'TOKEN'), []);
  assert.deepEqual(identity.searchByAddress(rows, 'ETH'), []);
  assert.deepEqual(identity.searchByAddress(rows, '0x1111'), [rows[0]]);
  assert.deepEqual(identity.searchByAddress(rows, ''), rows);
});

test('token states: what can be chosen, what cannot, and the untrusted symbol byte for byte', () => {
  const pick = (name) => tokens.candidateFromToken(fixture(name), fixture(name).asset.address);
  assert.equal(pick('token.success').why, null);
  assert.equal(pick('token.missing-contract').why, 'no_contract');
  assert.equal(pick('token.unavailable').why, 'unreadable');
  const gas = pick('token.call-gas-limit');
  assert.equal(gas.why, 'unreadable');
  assert.equal(gas.reasonCode, 'rpc_call_gas_limit');
  for (const partial of ['token.missing-decimals', 'token.metadata-reverted']) {
    const c = pick(partial);
    assert.equal(c.why, null, `${partial} stays selectable`);
    assert.equal(c.decimalsUnavailable, true, `${partial} says decimals are unavailable`);
  }
  const zero = pick('token.zero-decimals');
  assert.equal(zero.why, null);
  assert.equal(zero.decimalsUnavailable, false, 'zero decimals is a real value');
  assert.equal(zero.token.decimals, 0);
  assert.equal(pick('token.untrusted-symbol').token.symbol, '<img src=x onerror=alert(1)>');
  const first = pick('token.success');
  assert.equal(tokens.excluding(first, first.key).why, 'excluded');
});

// ---------------------------------------------------------------------------
// Fees (G13)
// ---------------------------------------------------------------------------

test('fees are exact to the pip, and the dynamic sentinel reads Dynamic', () => {
  const table = { 1: '0.0001%', 50: '0.005%', 100: '0.01%', 500: '0.05%', 3000: '0.30%', 9000: '0.90%', 10000: '1.00%', 1000000: '100.00%' };
  for (const [pips, want] of Object.entries(table)) assert.equal(fee.fixedFeePercent(Number(pips)), want, `${pips} pips`);
  assert.equal(fee.feeLabel({ feeMode: 'dynamic', fee_pips: 8388608 }), 'Dynamic');
  assert.equal(fee.feeLabel({ feeMode: 'fixed', fee_pips: 3000 }), '0.30%');
  // Both surfaces that name a fee agree with the table above, which is exact to
  // the pip. The old two-decimal rounding is gone: it turned 50 pips, a real
  // tier, into the same text as 100.
  for (const [pips, want] of Object.entries(table)) {
    assert.equal(fee.feeFromPips(Number(pips)), want, `${pips} pips through feeFromPips`);
    assert.equal(markets.feeTierLabel(Number(pips)), want, `${pips} pips on a table row`);
  }
  assert.equal(fee.feeFromPips(8388608), 'Dynamic');
  assert.equal(markets.feeTierLabel(8388608), 'Dynamic');
  // Every other surface that names a fee: the Top pools row and ticker, and slice A's read facts.
  // The row says "Dynamic fee": the word alone would read as a figure's state.
  assert.equal(markets.feeLabel({ feePips: null }), 'Dynamic fee', 'a market row of a dynamic-fee pool');
  assert.equal(markets.feeLabel({ feePips: 3000 }), '0.30%');
  // A read fact spells it out: "Dynamic fee", never the bare word, which would
  // read as a figure's state rather than as how the pool charges.
  assert.equal(project.feeText({ feeMode: 'dynamic', fee_pips: 8388608 }), 'Dynamic fee', "slice A's fee fact");
  assert.equal(project.feeText({ feeMode: 'fixed', fee_pips: 50 }), '0.005%');
});

// ---------------------------------------------------------------------------
// #2 position cards, from chain (2026-09-24: the lookup by typed NFT ids and its nft-positions reads are gone; every
// card is a WalletPosition of the wallet's list or of a position's /state answer, lib/walletCards.ts)
// ---------------------------------------------------------------------------

/** A position as the chain read gives it: ETH (18) / TOKEN (6), 0.30%, spacing 60, -60 to 60, the pool at tick 0. */
const chainPosition = (patch = {}) => ({
  tokenId: '1',
  status: 'open',
  poolId: FIXTURE_POOL,
  currencies: [{ address: NATIVE, symbol: 'ETH', decimals: 18 }, { address: FIXTURE_TOKEN, symbol: 'TOKEN', decimals: 6 }],
  fee: 3000,
  tickSpacing: 60,
  hooks: NATIVE,
  tickLower: -60,
  tickUpper: 60,
  liquidity: '1',
  sqrtPriceX96: String(2n ** 96n),
  tick: 0,
  unclaimedFees: ['0', '0'],
  principal: ['0', '0'],
  ...patch,
});
const chainCard = (patch) => cards.walletCard(chainPosition(patch), FIXTURE_OWNER);
const unknownDecimals = [{ address: NATIVE, symbol: 'ETH', decimals: 18 }, { address: FIXTURE_TOKEN, symbol: null, decimals: null }];

test('without decimals the range is ticks only and amounts stay raw', () => {
  const card = chainCard({ currencies: unknownDecimals, principal: ['3797063508', '3797063507756903070969194400'] });
  assert.equal(card.range.prices, null);
  assert.equal(positions.rangePricesProblem(card.range), 'decimals_unknown', 'the one problem a card says in words');
  assert.deepEqual([card.principal[1].kind, card.principal[1].exact], ['raw', null], 'raw, and never an exact amount in units');
  assert.equal(card.principal[1].raw, '3797063507756903070969194400');
  assert.equal(card.principal[0].kind, 'units');
});

test('card amounts: six significant digits that never split a number, every digit kept for the title', () => {
  // The live review's cards: an 18-decimal USDe principal that wrapped as "40." and "003206592866332023", and SMK4 amounts of 18 digits.
  const amountOf = (raw, decimals) => {
    const card = chainCard({ currencies: [{ address: NATIVE, symbol: 'ETH', decimals }, { address: FIXTURE_TOKEN, symbol: 'TOKEN', decimals: 6 }], principal: [raw, '0'] });
    return [card.principal[0].text, card.principal[0].exact, card.principal[0].kind];
  };
  assert.deepEqual(amountOf('40003206592866332023', 18), ['40.0032', '40.003206592866332023', 'units']);
  assert.deepEqual(amountOf('997049999999999986', 18), ['0.99705', '0.997049999999999986', 'units']);
  assert.deepEqual(amountOf('3000000000000005', 18), ['0.003', '0.003000000000000005', 'units']);
  assert.deepEqual(amountOf('4553157887631', 18), ['0.00000455316', '0.000004553157887631', 'units']);
  assert.deepEqual(amountOf('39996793', 6), ['39.9968', '39.996793', 'units']);
  assert.deepEqual(amountOf('1', 18), ['0.000000000000000001', '0.000000000000000001', 'units'], 'the smallest unit is still not zero');
  assert.deepEqual(amountOf('123456789', 0), ['123,456,789', '123,456,789', 'units'], 'never fewer digits than the whole part');
  assert.deepEqual(amountOf('0', 18), ['0', '0', 'zero']);
  for (const [text] of [amountOf('40003206592866332023', 18), amountOf('4553157887631', 18)]) assert.doesNotMatch(text, /e/i, 'never an exponent');
  // An amount the chain did not give (no pool price, no fee growth) is a dash, never a zero.
  const unread = chainCard({ principal: null, unclaimedFees: null });
  assert.deepEqual([...unread.principal, ...unread.unsettledFees].map((a) => [a.kind, a.text]), Array(4).fill(['unread', '—']));
});

/** A chain card with its range moved to these ticks, on this spacing. */
const rangedCard = (lower, upper, spacing, currencies) => chainCard({ tickLower: lower, tickUpper: upper, tickSpacing: spacing, ...(currencies ? { currencies } : {}) });

test('a full-range position is 0 to ∞ whatever the decimals, and never blamed on decimals', () => {
  // Both ends at the usable limits of spacing 60: 1.0001^±887220 is far outside what a price can be written as, yet nothing is unknown.
  const full = rangedCard(-887220, 887220, 60);
  assert.equal(full.range.fullRange, true);
  assert.deepEqual(full.range.prices, { lower: '0', upper: '∞' });
  assert.deepEqual(full.range.ends, { lower: { kind: 'limit', text: '0' }, upper: { kind: 'limit', text: '∞' } });
  assert.equal(positions.rangePricesProblem(full.range), null);

  const unread = rangedCard(-887220, 887220, 60, unknownDecimals);
  assert.deepEqual(unread.range.prices, { lower: '0', upper: '∞' }, 'a limit needs no decimals');
  assert.equal(positions.rangePricesProblem(unread.range), null);

  assert.equal(rangedCard(-887272, 887272, 1).range.fullRange, true, 'spacing 1 reaches the tick limits themselves');

  const oneSided = rangedCard(-60, 887220, 60);
  assert.deepEqual(oneSided.range.prices, { lower: '≈994,018,000,000', upper: '∞' });
  assert.equal(oneSided.range.fullRange, false);

  // 18 and 6 decimals: tick 600000 is a real price, too large to write as a plain number, and not a limit of spacing 60.
  const beyond = rangedCard(-60, 600000, 60);
  assert.equal(beyond.range.prices, null);
  assert.deepEqual(beyond.range.ends.lower, { kind: 'price', text: '≈994,018,000,000' });
  assert.deepEqual(beyond.range.ends.upper, { kind: 'tick', problem: 'beyond_display' });
  assert.equal(positions.rangePricesProblem(beyond.range), 'beyond_display');
  assert.equal(
    positions.rangePricesProblem({ ends: { lower: { kind: 'tick', problem: 'beyond_display' }, upper: { kind: 'tick', problem: 'decimals_unknown' } } }),
    'decimals_unknown',
    'an unread decimal comes first: it is the one a reader can act on',
  );
});

test('a range end at its pool’s usable tick limit is 0 below or ∞ above, on that side only, for any spacing', () => {
  for (const s of [1, 10, 60, 200]) {
    const { min, max } = poolRange.usableTicks(s);
    assert.deepEqual(positions.rangeEnd(min, 'lower', s, null, null), { kind: 'limit', text: '0' }, `spacing ${s}`);
    assert.deepEqual(positions.rangeEnd(max, 'upper', s, null, null), { kind: 'limit', text: '∞' }, `spacing ${s}`);
    assert.deepEqual(positions.rangeEnd(min + s, 'lower', s, null, null), { kind: 'tick', problem: 'decimals_unknown' }, `spacing ${s}: one step inside is a price`);
    assert.deepEqual(positions.rangeEnd(min + s, 'lower', s, 18, 18), { kind: 'tick', problem: 'beyond_display' }, `spacing ${s}`);
    assert.notEqual(positions.rangeEnd(min, 'upper', s, 18, 18).kind, 'limit', `spacing ${s}: the lower limit is no upper end`);
    assert.notEqual(positions.rangeEnd(max, 'lower', s, 18, 18).kind, 'limit', `spacing ${s}: the upper limit is no lower end`);
  }
  assert.deepEqual(positions.rangeEnd(-60, 'lower', 60, 18, 6), { kind: 'price', text: '≈994,018,000,000' });
});

test('the range bar is a log price axis in ticks: a quarter width of padding each side, the marker clamped to the edge and said so', () => {
  const { rangeBarScale, RANGE_BAR_PADDING } = positions;
  assert.equal(RANGE_BAR_PADDING, 0.25);
  const close = (a, b) => Math.abs(a - b) < 1e-9;
  const marker = (scale) => ({ current: scale.current, currentBeyond: scale.currentBeyond });
  const noMarker = rangeBarScale(-60, 60, null);
  assert.ok(close(noMarker.lower, 1 / 6) && close(noMarker.upper, 5 / 6), `the band sits inside the padding: ${noMarker.lower}..${noMarker.upper}`);
  assert.deepEqual(marker(noMarker), { current: null, currentBeyond: null }, 'no current tick, no marker');
  assert.ok(close(rangeBarScale(-60, 60, 0).current, 0.5), 'the middle tick is the middle of the band');
  // Ticks are log prices: the geometric midpoint of the range's prices is the
  // centre of the band, whatever the range's width or where it sits.
  assert.ok(close(rangeBarScale(-100, 300, 100).current, 0.5));
  assert.ok(close(rangeBarScale(1000, 1400, 1200).current, 0.5));
  assert.ok(close(rangeBarScale(-887272, 887272, 0).current, 0.5), 'a full-range position too');
  assert.ok(close(rangeBarScale(-60, 60, -60).current, 1 / 6), 'the lower tick is the band’s left edge');
  assert.ok(close(rangeBarScale(-60, 60, 60).current, 5 / 6), 'the upper tick is its right edge');
  // The axis for -60..60 runs from -90 to 90: a tick a little outside the range is still drawn where it is.
  assert.ok(close(rangeBarScale(-60, 60, -75).current, 15 / 180));
  assert.deepEqual(marker(rangeBarScale(-60, 60, -90)), { current: 0, currentBeyond: null }, 'exactly at the drawn edge is drawn, not beyond');
  assert.deepEqual(marker(rangeBarScale(-60, 60, -1000)), { current: 0, currentBeyond: 'below' });
  assert.deepEqual(marker(rangeBarScale(-60, 60, 1000)), { current: 1, currentBeyond: 'above' });
  const flat = rangeBarScale(10, 10, 10);
  assert.ok(flat.lower <= flat.upper && flat.current >= 0 && flat.current <= 1, 'a degenerate range still draws');
  for (const scale of [noMarker, rangeBarScale(-60, 60, 1000), flat]) {
    for (const value of [scale.lower, scale.upper, scale.current ?? 0]) assert.ok(value >= 0 && value <= 1, 'every position is a fraction of the drawn width');
  }
});

test('a portfolio link carries an address and nothing else; what is written is what is read back', () => {
  assert.deepEqual(positions.portfolioRoute(`#/portfolio/${FIXTURE_OWNER}`), { onRoute: true, address: FIXTURE_OWNER });
  assert.deepEqual(positions.portfolioRoute('#/portfolio'), { onRoute: true, address: '' });
  assert.deepEqual(positions.portfolioRoute('#/positions/1'), { onRoute: false });
  assert.equal(positions.portfolioHash(FIXTURE_OWNER), `#/portfolio/${FIXTURE_OWNER}`);
  assert.equal(positions.portfolioHash(null), '#/portfolio');
  // The address in a link is checked exactly as a pasted one: 0x plus 40 hex characters, as typed, no trimming, no checksum needed.
  assert.equal(identity.parseAddressInput(positions.portfolioRoute(`#/portfolio/${FIXTURE_OWNER}`).address).ok, true);
  assert.equal(identity.parseAddressInput(positions.portfolioRoute(`#/portfolio/${FIXTURE_OWNER.toUpperCase().replace('0X', '0x')}`).address).ok, true);
  assert.equal(identity.parseAddressInput(positions.portfolioRoute(`#/portfolio/${FIXTURE_OWNER}%20`).address).ok, false);
  assert.equal(identity.parseAddressInput(positions.portfolioRoute('#/portfolio/0x1234').address).ok, false);
  // 2026-09-24: no positions link carries a list of ids any more: the lookup that read one is gone.
  assert.equal(positions.positionsRoute, undefined);
  assert.equal(positions.positionsHash, undefined);
  assert.equal(positions.parseTokenIdsInput, undefined);
});

// Changed on purpose (owner, 2026-09-24): `#/positions/<id>` with one canonical id is that position's own page
// (screens/PositionDetail.tsx), which is where Create position lands; anything else, a list of ids included, is the list.
test('one canonical NFT id in a positions link is that position’s page; a list, or anything else, is not', () => {
  assert.equal(positions.positionDetailId('3135288'), '3135288');
  assert.equal(positions.positionDetailId(BIG), BIG);
  assert.equal(positions.positionDetailId('%34%32'), '42', 'decoded as a route segment');
  for (const segment of ['', '0', '01', '1,2', '1%2C2', `1,${BIG}`, ' 1', '1 ', '-1', '+1', '1e3', '0x1', (2n ** 256n).toString(), '9'.repeat(79), 'abc', '%E0%A4%A']) {
    assert.equal(positions.positionDetailId(segment), null, segment);
  }
});

// Review of 2026-09-25: a position's page offered "Add to this pool" (#/new/<poolId>) for any pool, where New position
// refuses a pool with hooks or a dynamic fee. The card carries its fee in pips, and the page links only where New
// position's own rule (poolsList.ts usableForDomino) holds.
test('a card carries its pool’s fee in pips, and only a pool with no hooks and a fixed fee is one Domino can add to', () => {
  const plain = chainCard({});
  assert.equal(plain.feePips, 3000);
  assert.equal(plain.fee, '0.30%');
  assert.equal(positions.cardPoolUsableForDomino(plain), true);
  const hooked = chainCard({ hooks: `0x${'4a'.repeat(20)}` });
  assert.deepEqual([hooked.hooks, hooked.feePips], [`0x${'4a'.repeat(20)}`, 3000]);
  assert.equal(positions.cardPoolUsableForDomino(hooked), false, 'hooks');
  const dynamic = chainCard({ fee: fee.DYNAMIC_FEE_PIPS });
  assert.deepEqual([dynamic.feePips, dynamic.fee], [fee.DYNAMIC_FEE_PIPS, 'Dynamic']);
  assert.equal(positions.cardPoolUsableForDomino(dynamic), false, 'a dynamic fee');
  // The same verdict as New position's own test on a projected pool, for every combination.
  for (const [hooks, feePips] of [[NATIVE, 3000], [NATIVE, fee.DYNAMIC_FEE_PIPS], [`0x${'4a'.repeat(20)}`, 3000], [`0x${'4a'.repeat(20)}`, fee.DYNAMIC_FEE_PIPS]]) {
    assert.equal(positions.cardPoolUsableForDomino({ hooks, feePips }), pools.optionUsableForDomino({ integration: 'hookless_fixed_fee', hooks, feePips }), `${hooks} ${feePips}`);
  }
});

test('the pool price on a card: the same chain read’s tick, checked against its square root, in the card’s decimals, placed against the range', () => {
  const card = chainCard({});
  const at = (tick, block = 700) => positions.chainPoolPrice(card, { sqrtPriceX96: poolRange.sqrtPriceAtTick(tick).toString(), tick, block });
  const price = at(0);
  assert.deepEqual(price, { state: 'usable', block: 700, tick: 0, text: '≈1,000,000,000,000', position: 'inside' });
  assert.equal(price.text, positions.tickPriceText(0, 18, 6), 'the same words as a bound price');
  assert.equal(at(-120).position, 'below');
  assert.equal(at(-60).position, 'inside');
  assert.equal(at(60).position, 'above', 'v4 counts the upper tick as outside');
  // Checked the way the range controls check a pool price: the tick has to agree with the square-root price.
  assert.deepEqual(positions.chainPoolPrice(card, { sqrtPriceX96: String(2n ** 96n), tick: 5000, block: 700 }), { state: 'unavailable', problem: 'tick_mismatch', block: 700 });
  assert.deepEqual(positions.chainPoolPrice(card, { sqrtPriceX96: '0', tick: 0, block: 700 }), { state: 'unavailable', problem: 'not_initialized', block: 700 });
  assert.deepEqual(positions.chainPoolPrice(card, { sqrtPriceX96: null, tick: null, block: 700 }), { state: 'unavailable', problem: 'not_initialized', block: 700 });
  // Without both tokens' decimals there is no price to write, only ticks.
  assert.deepEqual(positions.chainPoolPrice(chainCard({ currencies: unknownDecimals }), { sqrtPriceX96: String(2n ** 96n), tick: 0, block: 700 }), { state: 'unavailable', problem: 'decimals_unknown', block: 700 });
});

// ---------------------------------------------------------------------------
// Screen reads and slice A's scheduler (G8, T-G10)
// ---------------------------------------------------------------------------

test('a read gives up after its budget, counting time spent queued, and leaves no timer behind', async () => {
  const clock = manualClock();
  const hang = withDelays(fixtures({ token: BASE_TOKENS }), () => ({ hang: true }), clock);
  const pending = readWithin(hang, 'token', { token: FIXTURE_TOKEN }, { signal: live(), clock, budgetMs: 1000 });
  await clock.advance(999);
  await clock.advance(1);
  assert.deepEqual(await pending, { route: 'token', state: 'local', code: 'screen_budget_exceeded' });
  assert.equal(SCREEN_BUDGET_MS, 60_000);

  // Queued behind a read that never ends, the second read's budget still runs out.
  const queue = createScheduledSource(hang, { minIntervalMs: 0, clock });
  void queue.read('token', { token: NATIVE }, { signal: live() });
  const queued = readWithin(queue, 'token', { token: FIXTURE_TOKEN }, { signal: live(), clock, budgetMs: 500 });
  await clock.advance(500);
  assert.equal((await queued).state, 'local');
  assert.equal(hang.log.filter((entry) => entry.request.token === FIXTURE_TOKEN).length, 1, 'only the first budget test read started');

  const quick = manualClock();
  const done = await readWithin(fixtures({ token: BASE_TOKENS }), 'token', { token: FIXTURE_TOKEN }, { signal: live(), clock: quick });
  assert.equal(done.state, 'ok');
  assert.equal(quick.pending(), 0, 'the budget timer is cleared once the read settles');
  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal((await readWithin(fixtures({ token: BASE_TOKENS }), 'token', { token: FIXTURE_TOKEN }, { signal: cancelled.signal, clock: quick })).state, 'aborted');
});

test('the shared queue: 12 distinct pending reads at most, duplicates joined, the last waiter cancels, spaced starts', async () => {
  const clock = manualClock();
  const hang = withDelays(fixtures({ token: BASE_TOKENS }), () => ({ hang: true }), clock);
  const queue = createScheduledSource(hang, { minIntervalMs: 0, clock });
  const controller = new AbortController();
  const address = (i) => `0x${(i + 1).toString(16).padStart(40, '0')}`;
  for (let i = 0; i < 12; i++) void queue.read('token', { token: address(i) }, { signal: controller.signal });
  let joined = false;
  void queue.read('token', { token: address(3) }, { signal: controller.signal }).then(() => {
    joined = true;
  });
  const refused = await queue.read('token', { token: address(12) }, { signal: controller.signal });
  assert.equal(refused.state, 'unavailable');
  assert.equal(refused.cause.kind, 'queue_full');
  assert.equal(copy.failureText(refused, 'token').detail, 'Too many reads queued. Try again in a moment.');
  await flush();
  assert.equal(joined, false, 'a duplicate joins the queued read instead of counting as another');
  assert.equal(hang.log.some((entry) => entry.request.token === address(12)), false, 'the refused read never reached the source');
  controller.abort();
  await flush();

  // Two waiters on one read: one leaving keeps it, the last leaving cancels it.
  const slow = withDelays(fixtures({ token: BASE_TOKENS }), () => ({ delayMs: 100 }), clock);
  const shared = createScheduledSource(slow, { minIntervalMs: 0, clock });
  const a = new AbortController();
  const b = new AbortController();
  const first = shared.read('token', { token: FIXTURE_TOKEN }, { signal: a.signal });
  const second = shared.read('token', { token: FIXTURE_TOKEN }, { signal: b.signal });
  a.abort();
  assert.equal((await first).state, 'aborted');
  await clock.advance(100);
  assert.equal((await second).state, 'ok', 'the other waiter still gets the answer');
  assert.equal(slow.log.length, 1, 'one read for both');
  const c = new AbortController();
  const lone = shared.read('token', { token: NATIVE }, { signal: c.signal });
  await flush();
  c.abort();
  assert.equal((await lone).state, 'aborted');
  await flush();
  assert.equal(slow.log.at(-1).aborted, true, 'the last waiter leaving cancels the read itself');

  // A read aborted before it starts never reaches the source.
  const blocked = withDelays(fixtures({ token: BASE_TOKENS }), (_r, request) => (request.token === NATIVE ? { hang: true } : undefined), clock);
  const serial = createScheduledSource(blocked, { minIntervalMs: 0, clock });
  const head = new AbortController();
  const tail = new AbortController();
  void serial.read('token', { token: NATIVE }, { signal: head.signal });
  const behind = serial.read('token', { token: FIXTURE_TOKEN }, { signal: tail.signal });
  tail.abort();
  assert.equal((await behind).state, 'aborted');
  head.abort();
  await flush();
  await flush();
  assert.deepEqual(blocked.log.map((entry) => entry.request.token), [NATIVE]);

  // Starts are at least 1.1 s apart.
  const auto = autoClock();
  const timed = withDelays(fixtures({ token: BASE_TOKENS }), () => undefined, auto);
  const paced = createScheduledSource(timed, { minIntervalMs: 1100, clock: auto });
  await Promise.all([NATIVE, FIXTURE_TOKEN, address(5)].map((token) => paced.read('token', { token }, { signal: live() })));
  const starts = timed.log.map((entry) => entry.at);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 1100, `starts ${starts}`);
});

test('a read never makes more attempts than the pipeline policy allows', async () => {
  // The shipped policy's shape, with no waiting between attempts so the test
  // does not depend on a clock: what is under test is the count, not the pace.
  const RETRY_NOW = { maxAttempts: 3, jitterMs: 0, attemptMs: 20_000, totalMs: 60_000 };

  // A 503 is not asked again. R-1 retries one answer and one only, a validated
  // 429: a service that says it is unavailable is believed the first time.
  const refused = fixtures({ token: [{ fixture: errorFixture('token.upstream_unavailable') }] }, { policy: RETRY_NOW, clock: autoClock() });
  const once = await refused.read('token', { token: FIXTURE_TOKEN });
  assert.equal(once.provenance.attempts, 1, 'an upstream_unavailable is believed the first time');

  // The 429 is the one that is asked again, up to the policy's ceiling.
  const busy = fixtures({ token: [{ fixture: errorFixture('token.read_capacity_busy'), retryAfter: '0' }] }, { policy: RETRY_NOW, clock: autoClock() });
  const outcome = await busy.read('token', { token: FIXTURE_TOKEN });
  assert.equal(outcome.provenance.attempts, RETRY_NOW.maxAttempts, 'a validated 429 is asked again, and never past the ceiling');
  assert.equal(busy.requests.length, 1, 'one call to the source, however many attempts inside it');
});

// ---------------------------------------------------------------------------
// #3 wallet listing and catalogue
// ---------------------------------------------------------------------------

const WALLET = { wallet: FIXTURE_OWNER, autoDiscover: true };
const WALLET_MORE = { ...WALLET, cursor: MUTATED_CURSOR };
const firstPage = { fixture: gateway('wallet-assets.opaque-page'), mutate: withCursor(MUTATED_CURSOR), expectRequest: WALLET };
const expiredCursor = { fixture: errorFixture('wallet-assets.invalid_or_expired_cursor'), expectRequest: WALLET_MORE };

test('the wallet handle goes back exactly as received and never leaves the pager', async () => {
  const source = fixtures({ 'wallet-assets': [firstPage, { fixture: gateway('wallet-assets.last-page'), expectRequest: WALLET_MORE }] });
  const session = walletSession.createWalletSession(source, { wallet: FIXTURE_OWNER, tokens: [] });
  const one = await session.first();
  assert.equal(one.status, 'ready');
  assert.equal(one.canLoadMore, true);
  const two = await session.more();
  assert.equal(two.status, 'ready', 'a wrong handle would have been refused with 422');
  assert.equal(two.view.pages, 2);
  assert.equal(two.canLoadMore, false, 'the last page ends the list');
  assert.equal(JSON.stringify(two).includes(MUTATED_CURSOR), false);
  assert.deepEqual(source.requests.map((r) => r.request), [WALLET, WALLET_MORE]);

  const mixed = '0xABCDEF0123456789abcdef0123456789ABCDEF01';
  const exact = fixtures({ 'wallet-assets': [{ fixture: gateway('wallet-assets.page'), expectRequest: { wallet: mixed, autoDiscover: true } }] });
  assert.equal((await walletSession.createWalletSession(exact, { wallet: mixed, tokens: [] }).first()).status, 'ready', 'the wallet goes out exactly as typed');
  assert.deepEqual(walletSession.walletRequest({ wallet: mixed, tokens: [FIXTURE_TOKEN] }), { wallet: mixed, tokens: [FIXTURE_TOKEN], autoDiscover: true });
  // Added 2026-09-20. A LISTING wants discovery; a by-address check does not.
  // Asking "how much of this one token" with autoDiscover made the service page
  // the whole wallet to answer about one address — rugged measured about 90
  // local RPC items in 17 requests plus 2 Alchemy calls, against about 12 items
  // in 7 for the address alone (reports/capacity-2026-09-20). The Create flow
  // paid that for every balance line it drew.
  assert.deepEqual(walletSession.walletRequest({ wallet: mixed, tokens: [FIXTURE_TOKEN], discover: false }), { wallet: mixed, tokens: [FIXTURE_TOKEN], autoDiscover: false });
  assert.deepEqual(walletSession.walletRequest({ wallet: mixed, tokens: [], discover: false }), { wallet: mixed, autoDiscover: false });
  // Absent means a listing, so nothing that does not ask loses discovery.
  assert.deepEqual(walletSession.walletRequest({ wallet: mixed, tokens: [] }), { wallet: mixed, autoDiscover: true });
  assert.deepEqual(walletSession.walletRequest({ wallet: mixed, tokens: [FIXTURE_TOKEN], discover: true }), { wallet: mixed, tokens: [FIXTURE_TOKEN], autoDiscover: true });
  // And the two by-address callers ask for it, while the two listings do not.
  for (const [file, expected] of [
    ['../src/components/create/usePairBalances.ts', true],
    ['../src/components/read/screens/WalletCandidates.tsx', false],
  ]) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.equal(/discover: false/.test(text), expected, `${file} discovery`);
  }
  // The portfolio is both: a listing first, a by-address check on the automatic retry.
  const portfolio = readFileSync(new URL('../src/components/portfolio/PortfolioTokens.tsx', import.meta.url), 'utf8');
  assert.match(portfolio, /discover: tokens !== SELECTED_TOKENS/, 'the automatic second read stops discovering');
});

test('an expired handle restarts once and marks nothing lost; a second one is left to the person', async () => {
  const once = walletSession.createWalletSession(fixtures({ 'wallet-assets': [firstPage, expiredCursor] }), { wallet: FIXTURE_OWNER, tokens: [] });
  await once.first();
  const restarted = await once.more();
  assert.equal(restarted.restarted, true);
  assert.equal(restarted.status, 'ready');
  const twice = await once.more();
  assert.equal(twice.status, 'restart_exhausted', 'a second expiry never loops');
  assert.equal(twice.canLoadMore, false);
  const fresh = await once.restart();
  assert.equal(fresh.status, 'ready');
});

test('a failed page is asked for again with the same handle while it can live, then the list starts over', async () => {
  let now = 0;
  const source = fixtures({ 'wallet-assets': [firstPage, { fixture: errorFixture('wallet-assets.upstream_unavailable'), expectRequest: WALLET_MORE }, { fixture: gateway('wallet-assets.last-page'), expectRequest: WALLET_MORE }] });
  const session = walletSession.createWalletSession(source, { wallet: FIXTURE_OWNER, tokens: [] }, () => now);
  await session.first();
  const failed = await session.more();
  assert.equal(failed.status, 'failed');
  now = walletSession.HANDLE_RETRY_WINDOW_MS - 1;
  const again = await session.more();
  assert.equal(again.status, 'ready');
  assert.deepEqual(source.requests.map((r) => r.request.cursor ?? null), [null, MUTATED_CURSOR, MUTATED_CURSOR]);

  let later = 0;
  const stale = fixtures({ 'wallet-assets': [firstPage, { fixture: errorFixture('wallet-assets.upstream_unavailable'), expectRequest: WALLET_MORE }] });
  const aged = walletSession.createWalletSession(stale, { wallet: FIXTURE_OWNER, tokens: [] }, () => later);
  await aged.first();
  await aged.more();
  later = walletSession.HANDLE_RETRY_WINDOW_MS;
  assert.equal(aged.snapshot().status, 'handle_expired');
  const restarted = await aged.more();
  assert.equal(restarted.restarted, true);
  assert.equal(stale.requests.at(-1).request.cursor, undefined, 'a handle that may be dead is not sent');
});

test('wallet: a full cursor table is busy, an empty unconfigured list asks for token addresses, 5 pages at most', async () => {
  const busy = walletSession.createWalletSession(fixtures({ 'wallet-assets': [firstPage, { fixture: errorFixture('wallet-assets.read_capacity_busy'), expectRequest: WALLET_MORE }] }), { wallet: FIXTURE_OWNER, tokens: [] });
  await busy.first();
  assert.equal((await busy.more()).status, 'busy');

  const empty = { fixture: gateway('wallet-assets.fallback'), mutate: (b) => ({ ...b, items: [] }) };
  assert.equal((await walletSession.createWalletSession(fixtures({ 'wallet-assets': [empty] }), { wallet: FIXTURE_OWNER, tokens: [] }).first()).emptyHint, true);
  assert.equal((await walletSession.createWalletSession(fixtures({ 'wallet-assets': [empty] }), { wallet: FIXTURE_OWNER, tokens: [FIXTURE_TOKEN] }).first()).emptyHint, false);

  const zero = await walletSession.createWalletSession(fixtures({ 'wallet-assets': [{ fixture: gateway('wallet-assets.zero') }] }), { wallet: FIXTURE_OWNER, tokens: [] }).first();
  assert.deepEqual(zero.view.rows.map((row) => row.amount.text), ['0', '0']);

  const source = fixtures({ 'wallet-assets': [firstPage, { fixture: gateway('wallet-assets.opaque-page'), mutate: withCursor(MUTATED_CURSOR), expectRequest: WALLET_MORE }] });
  const capped = walletSession.createWalletSession(source, { wallet: FIXTURE_OWNER, tokens: [] });
  let snap = await capped.first();
  for (let i = 0; i < 6; i++) snap = await capped.more();
  assert.equal(snap.view.pages, walletSession.WALLET_PAGE_CAP);
  assert.equal(snap.capped, true);
  assert.equal(snap.canLoadMore, false);
  assert.equal(source.requests.length, 5, 'no read past the cap');

  const candidates = tokens.candidatesFromWalletView(zero.view);
  assert.deepEqual(candidates.map((c) => c.kind), ['native', 'erc20_candidate']);
  const gas = await walletSession.createWalletSession(fixtures({ 'wallet-assets': [{ fixture: gateway('wallet-assets.call-gas-limit') }] }), { wallet: FIXTURE_OWNER, tokens: [] }).first();
  const rows = tokens.candidatesFromWalletView(gas.view);
  assert.deepEqual(rows.map((c) => c.why), [null, 'wallet_unavailable'], 'an unreadable balance leaves the others valid');
});

test('the empty hint counts held balances: zero rows and native ETH are nothing held, a finished list only, and never with typed tokens', async () => {
  /** A finished provider page (no more pages) whose items are exactly `items`. */
  const pageOf = (items, inventory = {}) => ({ fixture: gateway('wallet-assets.last-page'), mutate: (b) => ({ ...b, items: items(b.items), inventory: { ...b.inventory, ...inventory } }) });
  const hint = async (reply, context = {}) => (await walletSession.createWalletSession(fixtures({ 'wallet-assets': [reply] }), { wallet: FIXTURE_OWNER, tokens: [], ...context }).first()).emptyHint;
  const zeroNative = (items) => [{ ...items[0], amountRaw: '0' }];
  // The live review's address: the provider returned no rows and the reply listed only native ETH at 0 (before: a list, so no hint, no check, no form).
  assert.equal(await hint(pageOf(zeroNative, { rowsReceived: 0 })), true, 'only a zero native row');
  assert.equal(await hint(pageOf((items) => items.map((item) => ({ ...item, amountRaw: '0' })))), true, 'every row a zero balance');
  assert.equal(await hint(pageOf((items) => [{ ...items[0], amountRaw: '1000000000000000000' }])), true, 'native ETH is read for every address, so it says nothing about the tokens');
  assert.equal(await hint(pageOf((items) => items)), false, 'a token with a balance is something held');
  assert.equal(await hint(pageOf(zeroNative), { tokens: [FIXTURE_TOKEN] }), false, 'typed tokens were already asked about');
  assert.equal(await hint({ ...pageOf(zeroNative, { hasMore: true, nextCursor: 'ab'.repeat(32) }) }), false, 'a list with pages to come is not finished');
  // wallet-assets.call-gas-limit: native ETH at 0, and a token whose balance read hit the gas limit.
  assert.equal(await hint({ fixture: gateway('wallet-assets.call-gas-limit') }), false, 'a token balance that could not be read may be something held');
  assert.equal(walletSession.listsHeldTokens({ rows: [{ key: `4663:${NATIVE}`, amount: { state: 'value' } }], unavailable: [{ key: `4663:${NATIVE}` }] }), false, 'native ETH, read or not, says nothing about the tokens');
  assert.equal(walletSession.listsHeldTokens({ rows: [{ key: `4663:${OTHER_ADDRESS}`, amount: { state: 'raw' } }], unavailable: [] }), true, 'a balance in raw units is held');
});

// A page that skipped provider candidates (2cb559e): the skipped addresses are not in the reply and the handle starts after them.
const partialInventory = (n) => (b) => ({ ...b, inventory: { ...b.inventory, candidatesProbed: 13, candidatesSkipped: n, skippedReason: 'request_budget_exhausted' } });
const skippedPage = { fixture: gateway('wallet-assets.opaque-page'), mutate: (b) => partialInventory(7)(withCursor(MUTATED_CURSOR)(b)), expectRequest: WALLET };
const CHECK = { wallet: FIXTURE_OWNER, tokens: [OTHER_ADDRESS], autoDiscover: false };
/** The by-address check's answer: native ETH, and OTHER_ADDRESS with a balance. */
const heldCheck = { fixture: gateway('wallet-assets.not-requested'), mutate: (b) => ((b.items[1].address = OTHER_ADDRESS), b), expectRequest: CHECK };
const FALLBACK = { wallet: FIXTURE_OWNER, tokens: [], fallbackTokens: [FIXTURE_TOKEN, OTHER_ADDRESS] };

test('a partial page checks the fallback tokens once, by exact address and without discovery, and adds only held balances', async () => {
  const source = fixtures({ 'wallet-assets': [skippedPage, heldCheck, { fixture: gateway('wallet-assets.last-page'), expectRequest: WALLET_MORE }] });
  const session = walletSession.createWalletSession(source, FALLBACK);
  const listed = await session.first();
  assert.deepEqual([listed.status, listed.view.skipped, listed.pendingCheck], ['ready', 7, true]);
  const checked = await session.check();
  // FIXTURE_TOKEN is on the page already, so only OTHER_ADDRESS is asked about.
  assert.deepEqual(source.requests.map((r) => r.request), [WALLET, CHECK]);
  assert.deepEqual([checked.status, checked.failure, checked.reason, checked.pendingCheck, checked.canLoadMore], ['ready', null, null, false, true]);
  const found = checked.view.rows.find((row) => row.key === `4663:${OTHER_ADDRESS}`);
  assert.deepEqual([found?.via, found?.block], ['address', 700]);
  assert.deepEqual(checked.view.notes, listed.view.notes, 'nothing is said about the check');
  assert.equal(checked.view.rows.filter((row) => row.via === 'address').length, 1, 'native ETH from the check adds nothing');
  await session.check();
  assert.equal(source.requests.length, 2, 'a list is checked once');
  const more = await session.more();
  assert.deepEqual(source.requests.at(-1).request, WALLET_MORE, 'the handle is untouched by the check');
  assert.deepEqual([more.status, more.view.pages, more.pendingCheck], ['ready', 2, false]);
});

test('a failed check is silent and not asked again; a cancelled one is still owed', async () => {
  const failing = fixtures({ 'wallet-assets': [skippedPage, { fixture: errorFixture('wallet-assets.upstream_unavailable'), expectRequest: CHECK }] });
  const session = walletSession.createWalletSession(failing, FALLBACK);
  const listed = await session.first();
  const after = await session.check();
  assert.deepEqual([after.status, after.failure, after.pendingCheck], ['ready', null, false], 'no status, no failure, nothing owed');
  assert.deepEqual(after.view.rows, listed.view.rows);
  await session.check();
  assert.equal(failing.requests.length, 2, 'any answer settles the check');

  const owed = walletSession.createWalletSession(fixtures({ 'wallet-assets': [skippedPage, heldCheck] }), FALLBACK);
  await owed.first();
  const controller = new AbortController();
  controller.abort();
  assert.equal((await owed.check(controller.signal)).pendingCheck, true, 'a cancelled check answered nothing');
  assert.equal((await owed.check()).pendingCheck, false);
});

test('a check on the wire is never sent twice: a call meanwhile joins it, the next page leaves it be and does not owe it again', async () => {
  // The read-layer review's sequence: page 1 skipped candidates, its check goes out, Load more is pressed while the check is on the wire.
  const scripted = fixtures({ 'wallet-assets': [skippedPage, heldCheck, { fixture: gateway('wallet-assets.last-page'), expectRequest: WALLET_MORE }] });
  let release;
  const held = new Promise((done) => (release = done));
  const source = {
    transport: 'fixture',
    read(route, request, options) {
      const answer = scripted.read(route, request, options);
      // The check's answer waits on the wire until the test lets it through; pages answer at once.
      return request.autoDiscover === false ? held.then(() => answer) : answer;
    },
  };
  const session = walletSession.createWalletSession(source, FALLBACK);
  assert.equal((await session.first()).pendingCheck, true);
  const checking = session.check();
  await flush();
  assert.equal(session.snapshot().pendingCheck, false, 'a check on the wire is not owed');
  const joined = session.check();
  const page2 = await session.more();
  assert.deepEqual([page2.status, page2.view.pages, page2.view.skipped, page2.pendingCheck], ['ready', 2, 7, false], 'the next page leaves the check on the wire, and does not owe it again');
  release();
  const [checked, same] = await Promise.all([checking, joined]);
  assert.deepEqual(scripted.requests.map((r) => r.request), [WALLET, CHECK, WALLET_MORE], 'one check for one list');
  assert.deepEqual(checked.view.rows.filter((row) => row.via === 'address').map((row) => row.key), [`4663:${OTHER_ADDRESS}`], 'its answer is adopted into the list as it is by then');
  assert.equal(checked.view.pages, 2);
  assert.deepEqual(same, checked, 'the call that joined gets the same answer');
  assert.equal((await session.check()).pendingCheck, false);
  assert.equal(scripted.requests.length, 3, 'answered: never asked again');

  // Cancelled on the wire by its own signal (the list was left): owed again, and asked again once.
  const again = fixtures({ 'wallet-assets': [skippedPage, heldCheck] });
  let hung = false;
  const hanging = {
    transport: 'fixture',
    read(route, request, options) {
      if (request.autoDiscover !== false || hung) return again.read(route, request, options);
      hung = true;
      // The first check hangs on the wire until its signal is aborted, as a slow read would.
      return new Promise((done) => options.signal.addEventListener('abort', () => done({ route, state: 'aborted', provenance: { transport: 'fixture', contract: null, receivedAt: 0, attempts: 1 } }), { once: true }));
    },
  };
  const left = walletSession.createWalletSession(hanging, FALLBACK);
  await left.first();
  const controller = new AbortController();
  const cancelled = left.check(controller.signal);
  await flush();
  assert.equal(left.snapshot().pendingCheck, false);
  controller.abort();
  assert.equal((await cancelled).pendingCheck, true, 'a check cancelled on the wire answered nothing, so it is owed again');
  const answered = await left.check();
  assert.deepEqual([answered.pendingCheck, again.requests.map((r) => r.request)], [false, [WALLET, CHECK]]);
});

test('no check without skipped candidates, without fallback tokens, or when every fallback token is listed', async () => {
  const whole = fixtures({ 'wallet-assets': [firstPage] });
  const session = walletSession.createWalletSession(whole, { ...FALLBACK, fallbackTokens: [OTHER_ADDRESS] });
  assert.equal((await session.first()).pendingCheck, false);
  await session.check();
  assert.equal(whole.requests.length, 1, 'a list that skipped nothing is not checked');

  const listedAll = walletSession.createWalletSession(fixtures({ 'wallet-assets': [skippedPage] }), { ...FALLBACK, fallbackTokens: [FIXTURE_TOKEN, NATIVE] });
  assert.equal((await listedAll.first()).pendingCheck, false, 'every fallback token is on the page, or native');
  const none = walletSession.createWalletSession(fixtures({ 'wallet-assets': [skippedPage] }), { wallet: FIXTURE_OWNER, tokens: [] });
  assert.equal((await none.first()).pendingCheck, false, 'a screen with no fallback tokens checks nothing');
});

test('the fallback request: fallback tokens the list lacks, not asked, not native, once each, at most 10, in their own order', () => {
  const token = (hex) => `0x${hex.repeat(20)}`;
  const view = { rows: [{ key: `4663:${FIXTURE_TOKEN}`, old: false }, { key: `4663:${token('99')}`, old: true }], unavailable: [{ key: `4663:${token('77')}` }], skipped: 1 };
  const many = Array.from({ length: 12 }, (_, i) => `0x${(i + 1).toString(16).padStart(2, '0').repeat(20)}`);
  const context = {
    wallet: FIXTURE_OWNER,
    tokens: [token('88')],
    fallbackTokens: [FIXTURE_TOKEN, NATIVE, token('77'), token('88'), token('AA'), token('aa'), token('99'), ...many],
  };
  const request = walletSession.fallbackRequest(context, view);
  assert.deepEqual(Object.keys(request), ['wallet', 'tokens', 'autoDiscover'], 'a fixed key order: the scheduler coalesces by JSON');
  assert.equal(request.autoDiscover, false);
  assert.equal(request.tokens.length, 10);
  assert.deepEqual(request.tokens.slice(0, 2), [token('AA'), token('99')], 'the first spelling of an address is kept; a row from an earlier list is checked again');
  assert.equal(runtime.validateRequest('wallet-assets', request), true);
  assert.equal(walletSession.fallbackRequest(context, { ...view, skipped: 0 }), null, 'nothing skipped, nothing to check');
  assert.equal(walletSession.fallbackRequest({ ...context, fallbackTokens: [FIXTURE_TOKEN, NATIVE] }, view), null, 'nothing left to check');
});

test('a quiet re-ask waits longer each time, only while a failure can pass, and stops after four', () => {
  const quiet = built('screens/quietRead');
  const provenance = { transport: 'fixture', contract: null, receivedAt: 0, attempts: 1 };
  const failure = (s) => ({ route: 'wallet-assets', provenance, ...s });
  const busy = failure({ state: 'busy', retryAfterSeconds: 7 });
  const [lowest, middle, highest] = [() => 0, () => 0.5, () => 1];
  // About ±25% of jitter around the doubled wait, never before the service's own Retry-After.
  assert.deepEqual([0, 1, 2, 3, 4].map((n) => quiet.reaskDelayMs(busy, n, lowest)), [7000, 10500, 21000, 42000, null], 'never before the service’s own Retry-After');
  assert.deepEqual([0, 1, 2, 3, 4].map((n) => quiet.reaskDelayMs(busy, n, highest)), [8750, 17500, 35000, 70000, null]);
  const transient = failure({ state: 'unavailable', cause: { kind: 'producer', code: 'upstream_unavailable', status: 503 }, retryable: true });
  assert.deepEqual([0, 1, 2, 3, 4].map((n) => quiet.reaskDelayMs(transient, n, middle)), [4000, 8000, 16000, 32000, null]);
  assert.deepEqual([0, 1, 2, 3].map((n) => [quiet.reaskDelayMs(transient, n, lowest), quiet.reaskDelayMs(transient, n, highest)]), [[3000, 5000], [6000, 10000], [12000, 20000], [24000, 40000]]);
  for (let i = 0; i < 200; i += 1) {
    const wait = quiet.reaskDelayMs(transient, 0);
    assert.ok(wait >= 3000 && wait <= 5000, `${wait} ms, drawn with Math.random`);
  }
  assert.ok(new Set(Array.from({ length: 50 }, () => quiet.reaskDelayMs(transient, 2))).size > 1, 'screens that failed together do not come back together');
  // A hop's refusal (502 upstream_contract_mismatch), which a gateway that does not stamp its mid-hop failures sends for a
  // hop that is only flapping: asked again like any failure that names no wait of its own, 4 s give or take a quarter, four times.
  const hop = failure({ state: 'incompatible', reason: 'upstream_contract_mismatch' });
  assert.deepEqual([0, 1, 2, 3, 4].map((n) => quiet.reaskDelayMs(hop, n, middle)), [4000, 8000, 16000, 32000, null]);
  assert.deepEqual([0, 1, 2, 3].map((n) => [quiet.reaskDelayMs(hop, n, lowest), quiet.reaskDelayMs(hop, n, highest)]), [[3000, 5000], [6000, 10000], [12000, 20000], [24000, 40000]]);
  for (const passing of [
    transient,
    busy,
    hop,
    failure({ state: 'unavailable', cause: { kind: 'network' }, retryable: false }),
    failure({ state: 'unavailable', cause: { kind: 'edge', status: 502 }, retryable: false }),
    failure({ state: 'unavailable', cause: { kind: 'edge', status: 429 }, retryable: false }),
    failure({ state: 'unavailable', cause: { kind: 'read_deadline', limit: 'read' }, retryable: true }),
    failure({ state: 'unavailable', cause: { kind: 'queue_full' }, retryable: true }),
    failure({ state: 'gate_unavailable' }),
    failure({ state: 'restart_required', code: 'catalogue_revision_changed' }),
    { route: 'wallet-assets', state: 'local', code: 'screen_budget_exceeded' },
  ]) {
    assert.equal(quiet.passing(passing), true, JSON.stringify(passing));
  }
  for (const final of [
    failure({ state: 'unavailable', cause: { kind: 'producer', code: 'nft_live_position_has_no_owner', status: 503 }, retryable: false }),
    failure({ state: 'unavailable', cause: { kind: 'edge', status: 403 }, retryable: false }),
    failure({ state: 'gate_required' }),
    failure({ state: 'access_required' }),
    // A contract header this page does not accept meets every read the same: final.
    failure({ state: 'incompatible', reason: 'contract_version_not_accepted' }),
    failure({ state: 'incompatible', reason: 'contract_header_missing' }),
    failure({ state: 'invalid', reason: 'identity_mismatch' }),
    failure({ state: 'request_rejected', code: 'invalid_request', status: 422 }),
    failure({ state: 'restart_required', code: 'invalid_or_expired_cursor' }),
    failure({ state: 'disabled', reason: 'route_not_enabled' }),
    failure({ state: 'not_connected', reason: 'bridge_unavailable' }),
    failure({ state: 'aborted' }),
    { state: 'incomplete_reply' },
  ]) {
    assert.equal(quiet.reaskDelayMs(final, 0), null, JSON.stringify(final));
  }
  assert.deepEqual(
    [transient, busy, failure({ state: 'disabled', reason: 'route_not_enabled' }), failure({ state: 'unavailable', cause: { kind: 'network' }, retryable: false }), { route: 'token', state: 'local', code: 'screen_budget_exceeded' }].map(quiet.failureCode),
    ['upstream_unavailable', 'busy', 'route_not_enabled', 'network', 'screen_budget_exceeded'],
  );
  // A title names a site without its read service plainly, never as something to come.
  const offSite = quiet.quietTitle(failure({ state: 'not_connected', reason: 'bridge_unavailable' }), 'wallet');
  assert.doesNotMatch(offSite, /yet|coming|soon|later/i);
  // The access check is site access in a title, never a beta.
  assert.equal(quiet.quietTitle(failure({ state: 'gate_required' }), 'wallet'), 'Site access expired. Reload the page to sign in again.');
  assert.equal(quiet.quietTitle(failure({ state: 'gate_unavailable' }), 'wallet'), 'Site access is paused. Nothing is wrong on your side.');
  for (const state of ['gate_required', 'gate_unavailable']) assert.doesNotMatch(quiet.quietTitle(failure({ state }), 'token'), /beta/i, state);
  assert.equal(quiet.quietTitle(failure({ state: 'incompatible', reason: 'contract_version_not_accepted' }), 'wallet'), `Update needed. ${copy.COPY.local.update}`, 'a title and its detail, once each');
  assert.equal(quiet.quietTitle(transient, 'wallet'), 'Wallet data unavailable. The read service answered: read service unavailable.');
});

test('one quiet re-ask policy: the pool screens and the wallet, token and position screens ask again after exactly the same failures, after the same waits', () => {
  const quiet = built('screens/quietRead');
  const screen = built('screens/screenRead');
  const transient = built('screens/transient');
  const { ERROR_CLASS } = built('errors');
  const provenance = { transport: 'bridge', contract: null, receivedAt: 0, attempts: 1 };
  const outcome = (s) => ({ route: 'pools', provenance, ...s });
  // Every producer code as the pipeline hands it to a screen (interpret.ts), then every other way a read can end.
  const fromCode = Object.entries(ERROR_CLASS).map(([code, rule]) => {
    switch (rule.kind) {
      case 'restart': return outcome({ state: 'restart_required', code });
      case 'route_disabled': return outcome({ state: 'disabled', reason: 'route_not_enabled' });
      case 'request_rejected': return outcome({ state: 'request_rejected', code, status: 400 });
      case 'busy': return outcome({ state: 'busy', retryAfterSeconds: 2 });
      case 'incompatible': return outcome({ state: 'incompatible', reason: 'upstream_contract_mismatch' });
      default: return outcome({ state: 'unavailable', cause: { kind: 'producer', code, status: 503 }, retryable: rule.retryable });
    }
  });
  const others = [
    ...[0, 200, 400, 403, 404, 408, 429, 500, 502, 503, 504, 520, 530].map((status) => outcome({ state: 'unavailable', cause: { kind: 'edge', status }, retryable: false })),
    outcome({ state: 'unavailable', cause: { kind: 'network' }, retryable: false }),
    outcome({ state: 'unavailable', cause: { kind: 'queue_full' }, retryable: true }),
    outcome({ state: 'unavailable', cause: { kind: 'read_deadline', limit: 'attempt' }, retryable: true }),
    outcome({ state: 'unavailable', cause: { kind: 'read_deadline', limit: 'read' }, retryable: true }),
    outcome({ state: 'gate_required' }),
    outcome({ state: 'gate_unavailable' }),
    outcome({ state: 'access_required' }),
    ...['contract_header_missing', 'contract_version_not_accepted', 'upstream_contract_mismatch'].map((reason) => outcome({ state: 'incompatible', reason })),
    ...['request_contract', 'not_json', 'response_contract', 'identity_mismatch'].map((reason) => outcome({ state: 'invalid', reason })),
    ...['live_data_disabled', 'route_not_enabled', 'bridge_data_mode_disabled'].map((reason) => outcome({ state: 'disabled', reason })),
    outcome({ state: 'not_connected', reason: 'bridge_unavailable' }),
    outcome({ state: 'busy', retryAfterSeconds: 30 }),
    outcome({ state: 'aborted' }),
    { route: 'pools', state: 'local', code: 'screen_budget_exceeded' },
    { state: 'incomplete_reply' },
  ];
  const draws = [0, 0.25, 0.5, 0.75, 1];
  for (const failure of [...fromCode, ...others]) {
    const label = JSON.stringify({ ...failure, provenance: undefined });
    assert.equal(quiet.passing(failure), transient.isTransient(failure), label);
    for (let attempt = 0; attempt <= 4; attempt += 1) {
      for (const draw of draws) {
        assert.equal(screen.quietRetryDelay(failure, attempt, () => draw), quiet.reaskDelayMs(failure, attempt, () => draw), `${label} #${attempt} at ${draw}`);
      }
      assert.equal(quiet.reaskDelayMs(failure, attempt, () => 0.5) !== null, transient.isTransient(failure) && attempt < 4, `${label} #${attempt}`);
    }
  }
  // The rule itself, spelled out once: a producer code errors.ts marks transient, and these.
  const name = (f) => (f.cause ? `${f.cause.kind}${f.cause.status === undefined ? '' : ` ${f.cause.status}`}` : f.code ?? f.reason ?? f.state);
  assert.deepEqual(
    fromCode.filter(transient.isTransient).map((f) => f.cause?.code ?? name(f)).sort(),
    [...Object.entries(ERROR_CLASS).filter(([, rule]) => rule.kind === 'unavailable' && rule.retryable).map(([code]) => code), 'busy', 'catalogue_revision_changed', 'upstream_contract_mismatch'].sort(),
    'every producer code errors.ts reads as transient, a busy service, a catalogue that moved under the read, and a hop that refused the reply',
  );
  assert.deepEqual(
    others.filter(transient.isTransient).map(name),
    ['edge 408', 'edge 429', 'edge 500', 'edge 502', 'edge 503', 'edge 504', 'edge 520', 'edge 530', 'network', 'queue_full', 'read_deadline', 'read_deadline', 'gate_unavailable', 'upstream_contract_mismatch', 'busy', 'screen_budget_exceeded'],
    'an edge page with a server status, the network, this page’s queue and deadlines, the access check’s own outage, a hop’s refusal (never a contract header this page does not accept), a busy service and the screen budget',
  );
});

test('existing pools: neutral order, provider figures attributed, rejected candidates listed, never "no pool exists"', () => {
  const view = pools.projectPoolsView(runtime.assertResponse('pools', fixture('pools.success')));
  const [option] = view.options;
  assert.equal(option.fee, '0.30%');
  assert.equal(option.kind, 'discovery');
  assert.deepEqual(option.liquidity, { state: 'attributed', value: '$10.00', raw: '10.00', zero: false, provider: 'dexscreener', retrievedAt: 1010, cacheAgeSeconds: null }, 'the provider decimal is kept beside the formatted one, so a list can work the APR estimate out without a read per row');
  assert.equal(option.volume.value, '$1.2K');
  // Source and age for the discovery provider's figures: the payload's retrieval time, the only age the pools route gives.
  assert.equal(option.providerNote, 'Provider figures retrieved 00:16:50 UTC, 1970-01-01. Provider-reported, not reconciled with chain data.');
  assert.doesNotMatch(option.providerNote, PROVENANCE_BANNED);
  assert.equal(option.aprReason, 'reconciled_fee_history_unavailable');

  const rejected = pools.projectPoolsView(runtime.assertResponse('pools', fixture('pools.rejected-candidate')));
  assert.equal(rejected.options.length, 0);
  assert.deepEqual(rejected.rejected.map((r) => r.reason), ['provider_currency_mismatch']);
  for (const name of ['pools.rejected-candidate', 'pools.missing', 'pools.provider-unavailable', 'pools.success', 'pools.catalogue']) {
    const lines = pools.projectPoolsView(runtime.assertResponse('pools', fixture(name))).coverage.join(' ');
    assert.doesNotMatch(lines, /no pool exists|there are no pools/i, name);
  }
  assert.match(pools.projectPoolsView(runtime.assertResponse('pools', fixture('pools.missing'))).coverage.join(' '), /isn’t proof that none exists/);
  const unavailable = pools.projectPoolsView(runtime.assertResponse('pools', fixture('pools.provider-unavailable')));
  assert.equal(unavailable.complete, false);
  assert.match(unavailable.coverage[0], /unavailable \(network unavailable\)/);
  const zeroMissing = pools.projectPoolsView(runtime.assertResponse('pools', fixture('pools.zero-and-missing-metrics'))).options[0];
  assert.equal(zeroMissing.liquidity.state, 'not_reported');
  assert.equal(zeroMissing.volume.zero, true);
  assert.equal(pools.projectPoolsView(runtime.assertResponse('pools', fixture('pools.catalogue'))).options[0].catalogue.source, 'initialize_event');
  const ordered = pools.neutralOrder([
    { key: '0xb', feePips: 3000 },
    { key: '0xa', feePips: 8388608 },
    { key: '0xc', feePips: 500 },
    { key: '0xa0', feePips: 3000 },
  ]);
  assert.deepEqual(ordered.map((o) => o.key), ['0xc', '0xa0', '0xb', '0xa']);
});

// Answered by @rugged97 on #112: no producer or wire change is needed. The
// `pairedToken` echo stays nullable, and the binding does not depend on it —
// each returned pool carries its own key, so the consumer checks every pool's
// currencies against the token and the optional second asset it asked for
// (interpret.ts, the 'pools' case, as the 'catalogue' case already did).
// Without that check he reproduced both a wrong token and a wrong second asset
// passing the runtime and becoming one selectable option.
test('a pools reply is bound to the chosen token and second asset: a pool holding neither is a wrong answer, never an option', async () => {
  const pooled = (entry) => fixtures({ pools: [entry] });
  // The echo names the asked-for token, but the only pool holds 0x0000… and 0x1111….
  const echoOnly = { fixture: gateway('pools.success'), mutate: (b) => ((b.selectedToken = OTHER_ADDRESS), b) };
  const foreign = await readWithin(pooled(echoOnly), 'pools', pools.poolsRequest(OTHER_ADDRESS, null), { signal: live() });
  assert.deepEqual([foreign.state, foreign.reason], ['invalid', 'identity_mismatch']);
  assert.equal('data' in foreign, false);
  // A second asset none of the returned pools holds.
  const unpaired = await readWithin(pooled({ fixture: gateway('pools.success') }), 'pools', pools.poolsRequest(FIXTURE_TOKEN, OTHER_ADDRESS), { signal: live() });
  assert.deepEqual([unpaired.state, unpaired.reason], ['invalid', 'identity_mismatch']);
  // The pair the pool does hold still answers.
  const paired = await readWithin(pooled({ fixture: gateway('pools.success') }), 'pools', pools.poolsRequest(FIXTURE_TOKEN, NATIVE), { signal: live() });
  assert.equal(paired.state, 'ok');
  assert.equal(pools.projectPoolsView(paired.data).options.length, 1);
  // The per-pool check does not lean on the pairedToken echo, which the fixtures leave null.
  assert.equal(paired.data.pairedToken, null);

  // Verifying a catalogue candidate goes through the same check.
  const wrongPair = await catalogue.verifyCandidate(pooled({ fixture: gateway('pools.catalogue') }), FIXTURE_TOKEN, OTHER_ADDRESS, FIXTURE_POOL, { signal: live() });
  assert.deepEqual([wrongPair.failure?.state, wrongPair.failure?.reason, wrongPair.option], ['invalid', 'identity_mismatch', null]);
  const wrongToken = await catalogue.verifyCandidate(
    pooled({ fixture: gateway('pools.catalogue'), mutate: (b) => ((b.selectedToken = OTHER_ADDRESS), b) }),
    OTHER_ADDRESS,
    null,
    FIXTURE_POOL,
    { signal: live() },
  );
  assert.deepEqual([wrongToken.failure?.reason, wrongToken.option], ['identity_mismatch', null]);
  const rightPair = await catalogue.verifyCandidate(pooled({ fixture: gateway('pools.catalogue') }), FIXTURE_TOKEN, NATIVE, FIXTURE_POOL, { signal: live() });
  assert.equal(rightPair.option?.key, FIXTURE_POOL);
});

// ---------------------------------------------------------------------------
// Practice range on a chosen pool (#3 S-PL7), wallet chain (#3)
// ---------------------------------------------------------------------------

/** sqrtPriceX96 at each tick, from backend/v4_math.py's sqrt_at_tick (the backend's port of v4-core TickMath). */
const SQRT_AT_TICK = {
  0: '79228162514264337593543950336',
  1: '79232123823359799118286999568',
  [-1]: '79224201403219477170569942574',
  60: '79466191966197645195421774833',
  [-60]: '78990846045029531151608375686',
  1000: '83290069058676223003182343270',
  12345: '146870458338965608271414022015',
  [-54321]: '5240503682681966373147841867',
  200000: '1744244129640337381386292603617838',
  [-200000]: '3598751819609688046946419',
  [-887272]: '4295128739',
  887272: '1461446703485210103287273052203988822378723970342',
};

const optionFrom = (name, mutate = (b) => b, readAt = 1_000) => pools.projectPoolsView(runtime.assertResponse('pools', mutate(fixture(name))), readAt).options[0];

test('the pool price check is v4 TickMath exactly: every tick agrees with its own square-root price and no other', () => {
  for (const [tick, sqrt] of Object.entries(SQRT_AT_TICK)) assert.equal(poolRange.sqrtPriceAtTick(+tick).toString(), sqrt, `tick ${tick}`);
  assert.equal(poolRange.sqrtPriceAtTick(poolRange.MIN_TICK), poolRange.MIN_SQRT_PRICE);
  assert.equal(poolRange.sqrtPriceAtTick(poolRange.MAX_TICK), poolRange.MAX_SQRT_PRICE);
  assert.throws(() => poolRange.sqrtPriceAtTick(887273), RangeError);
  assert.throws(() => poolRange.sqrtPriceAtTick(0.5), RangeError);
  const at = (t) => poolRange.sqrtPriceAtTick(t);
  assert.equal(poolRange.tickAgrees(0, at(0)), true);
  assert.equal(poolRange.tickAgrees(0, at(1) - 1n), true, 'anywhere inside the tick');
  assert.equal(poolRange.tickAgrees(0, at(1)), true, 'on the upper boundary, where a swap going down leaves the tick one below');
  assert.equal(poolRange.tickAgrees(0, at(1) + 1n), false);
  assert.equal(poolRange.tickAgrees(1, at(0)), false);
  assert.equal(poolRange.tickAgrees(5000, at(0)), false);
  assert.equal(poolRange.tickAgrees(0, 0n), false);
  assert.equal(poolRange.tickAgrees(poolRange.MAX_TICK, poolRange.MAX_SQRT_PRICE), false, 'no pool sits at MAX_SQRT_PRICE');
  assert.equal(poolRange.tickAgrees(poolRange.MIN_TICK, poolRange.MIN_SQRT_PRICE), true);
});

test('a chosen pool’s price comes only from its read tick, square-root price and decimals; anything short of that is unavailable', () => {
  const option = optionFrom('pools.success');
  assert.deepEqual([option.tick, option.sqrtPriceX96, option.readAt, option.tickSpacing], [0, '79228162514264337593543950336', 1_000, 60]);
  const price = poolRange.poolPrice(option, 1_000);
  assert.equal(price.state, 'usable');
  // ETH (18 decimals) is currency0 and TOKEN (6) currency1: 10^12 TOKEN per ETH at tick 0, from the helper the NFT cards use.
  assert.equal(price.text, '≈1,000,000,000,000');
  assert.equal(price.text, positions.tickPriceText(0, 18, 6));
  assert.deepEqual([price.block, price.tick, price.base.symbol, price.quote.symbol, price.partial, price.stale], [700, 0, 'ETH', 'TOKEN', false, false]);

  const problem = (o) => {
    const p = poolRange.poolPrice(o, 1_000);
    return p.state === 'unavailable' ? p.problem : `usable ${p.text}`;
  };
  assert.equal(problem(optionFrom('pools.partial-metadata')), 'decimals_unknown', 'TOKEN’s decimals could not be read');
  assert.equal(problem({ ...option, tick: 5000 }), 'tick_mismatch');
  assert.equal(problem({ ...option, sqrtPriceX96: '0' }), 'not_initialized');
  assert.equal(problem({ ...option, sqrtPriceX96: 'nope' }), 'tick_mismatch');
  assert.equal(problem({ ...option, tick: 887271, sqrtPriceX96: poolRange.sqrtPriceAtTick(887271).toString() }), 'beyond_display');

  const partial = poolRange.poolPrice(
    optionFrom('pools.success', (b) => {
      b.pools[0].tokenMetadataStatus = 'partial';
      Object.assign(b.tokens[0], { symbol: null, readStatus: 'partial', metadataIssues: { symbol: 'invalid_symbol_text' } });
      return b;
    }),
    1_000,
  );
  assert.deepEqual([partial.state, partial.partial, partial.text, partial.quote.symbol], ['usable', true, '≈1,000,000,000,000', null]);

  // Stale is time since the reply arrived on this page, never the payload's own clock.
  assert.equal(poolRange.poolPrice(option, 1_000 + poolRange.PRICE_STALE_MS - 1).stale, false);
  assert.equal(poolRange.poolPrice(option, 1_000 + poolRange.PRICE_STALE_MS).stale, true);
  assert.equal(poolRange.poolPrice({ ...option, readAt: null }, 1e15).stale, false);
  assert.equal(poolRange.PRICE_STALE_MS, 300_000);
});

test('the checked width is derived from the range and the price now: a preset only while the range is exactly it, otherwise Custom', () => {
  const spacing = 60;
  const closer = poolRange.presetRange(0, spacing, 'standard');
  const wider = poolRange.presetRange(0, spacing, 'wide');
  assert.equal(poolRange.rangeMode(closer, 0, spacing), 'standard');
  assert.equal(poolRange.rangeMode(wider, 0, spacing), 'wide', 'a kept Wider range reopens as Wider, not the default');
  assert.equal(poolRange.rangeMode(poolRange.stepBound(wider, 'upper', 1, spacing), 0, spacing), 'custom', 'a stepped range reopens as Custom');
  assert.equal(poolRange.rangeMode(poolRange.stepBound(closer, 'lower', -1, spacing), 0, spacing, 'standard'), 'custom', 'a remembered pick never outlives the range');
  // The price read again moved one tick spacing: the kept range is no longer 0.7× to 1.5× of it.
  assert.equal(poolRange.rangeMode(closer, 60, spacing, 'standard'), 'custom');
  assert.equal(poolRange.rangeMode(poolRange.presetRange(60, spacing, 'standard'), 60, spacing), 'standard');
  // An explicit "Custom" stays custom; a preferred preset that doesn't match gives way.
  assert.equal(poolRange.rangeMode(closer, 0, spacing, 'custom'), 'custom');
  assert.equal(poolRange.rangeMode(closer, 0, spacing, 'wide'), 'standard');
  // On a spacing so wide the two presets coincide, the pick breaks the tie.
  const huge = 32767;
  assert.deepEqual(poolRange.presetRange(0, huge, 'standard'), poolRange.presetRange(0, huge, 'wide'));
  assert.equal(poolRange.rangeMode(poolRange.presetRange(0, huge, 'wide'), 0, huge), 'standard');
  assert.equal(poolRange.rangeMode(poolRange.presetRange(0, huge, 'wide'), 0, huge, 'wide'), 'wide');
});

test('range presets sit on the tick spacing, inside v4’s ticks, around the pool’s tick, and bounds never cross', () => {
  const spacing = 60;
  const closer = poolRange.presetRange(0, spacing, 'standard');
  const wider = poolRange.presetRange(0, spacing, 'wide');
  // 0.7× to 1.5× and 0.5× to 2× of the pool price (ranges.ts RANGES), rounded outward to multiples of 60.
  assert.deepEqual(closer, { lower: -3600, upper: 4080 });
  assert.deepEqual(wider, { lower: -6960, upper: 6960 });
  for (const range of [closer, wider, poolRange.presetRange(12345, 200, 'standard'), poolRange.presetRange(-887000, 10, 'wide'), poolRange.presetRange(887250, 60, 'standard')]) {
    assert.ok(Number.isInteger(range.lower) && Number.isInteger(range.upper), JSON.stringify(range));
    assert.ok(range.lower < range.upper, JSON.stringify(range));
    for (const t of [range.lower, range.upper]) assert.ok(t >= poolRange.MIN_TICK && t <= poolRange.MAX_TICK, `${t} inside v4 ticks`);
  }
  assert.equal(poolRange.presetRange(12345, 200, 'standard').lower % 200, 0);
  assert.equal(poolRange.rangePosition(poolRange.presetRange(12345, 200, 'standard'), 12345), 'inside');
  assert.deepEqual(poolRange.usableTicks(60), { min: -887220, max: 887220 });
  assert.equal(poolRange.presetRange(887250, 60, 'standard').upper, 887220);

  assert.deepEqual(poolRange.stepBound(closer, 'upper', 1, spacing), { lower: -3600, upper: 4140 });
  assert.deepEqual(poolRange.stepBound(closer, 'lower', -2, spacing), { lower: -3720, upper: 4080 });
  assert.deepEqual(poolRange.moveBound(closer, 'lower', 9000, spacing), { lower: 4020, upper: 4080 }, 'the lower bound stops one spacing below the upper');
  assert.deepEqual(poolRange.moveBound(closer, 'upper', -9000, spacing), { lower: -3600, upper: -3540 });
  assert.deepEqual(poolRange.moveBound(closer, 'upper', 131, spacing), { lower: -3600, upper: 120 }, 'snapped to the nearest multiple of the spacing');
  assert.deepEqual(poolRange.moveBound(closer, 'lower', -1e7, spacing), { lower: -887220, upper: 4080 });
  assert.ok(Object.is(poolRange.moveBound({ lower: -120, upper: 60 }, 'lower', -20, spacing).lower, 0), 'never -0');
  assert.deepEqual(poolRange.normaliseRange({ lower: 887220, upper: 887220 }, spacing), { lower: 887160, upper: 887220 });

  assert.deepEqual(poolRange.sliderWindow(0, spacing, closer), { min: -13920, max: 13920 }, 'a quarter to four times the pool price');
  assert.deepEqual(poolRange.sliderWindow(0, spacing, { lower: -20000, upper: 60 }), { min: -20000, max: 13920 }, 'widened to hold the range');

  assert.equal(poolRange.rangePosition(closer, 0), 'inside');
  assert.equal(poolRange.rangePosition(closer, -3601), 'below');
  assert.equal(poolRange.rangePosition(closer, -3600), 'inside');
  assert.equal(poolRange.rangePosition(closer, 4080), 'above', 'v4: the upper tick is outside');

  assert.equal(poolRange.fromPoolPrice(0, 0), '0%');
  assert.equal(poolRange.fromPoolPrice(4080, 0), '+50.4%');
  assert.equal(poolRange.fromPoolPrice(-3600, 0), '−30.2%');
  assert.equal(poolRange.fromPoolPrice(13920, 0), '+302%');
  const price = poolRange.poolPrice(optionFrom('pools.success'), 1_000);
  assert.equal(poolRange.boundPrice(-3600, price), positions.tickPriceText(-3600, 18, 6));
  assert.equal(poolRange.boundPrice(887220, price), null, 'beyond display is said in words, never an exponent');
});

test('wallet candidates: only a reply about Robinhood Chain (4663) is used, and it is public data, not ownership', async () => {
  const otherChain = { fixture: gateway('wallet-assets.opaque-page'), mutate: (b) => ((b.chainId = 1), b) };
  const refused = await walletSession.createWalletSession(fixtures({ 'wallet-assets': [otherChain] }), { wallet: FIXTURE_OWNER, tokens: [] }).first(live());
  assert.equal(refused.failure?.state, 'invalid');
  assert.deepEqual([refused.view.rows.length, refused.canLoadMore], [0, false], 'nothing from another chain is listed');
  const listed = await walletSession.createWalletSession(fixtures({ 'wallet-assets': [{ fixture: gateway('wallet-assets.opaque-page') }] }), { wallet: FIXTURE_OWNER, tokens: [] }).first(live());
  assert.equal(listed.failure, null);
  assert.ok(listed.view.rows.length > 0);
  assert.match(copy.COPY.picker.walletPublicNote, /public chain data on Robinhood Chain \(4663\)/);
  assert.match(copy.COPY.picker.walletPublicNote, /isn’t proof that anyone here owns or controls it/);
  assert.doesNotMatch(copy.COPY.picker.walletPublicNote, /\byour\b/i);
  for (const text of Object.values(copy.COPY.range).flatMap((v) => (typeof v === 'string' ? [v] : Object.values(v)))) {
    assert.doesNotMatch(text, /\byour\b|recommend|best|guarantee/i, text);
  }
  assert.ok(copy.allCopyStrings().includes(copy.COPY.range.note), 'the range words are in the default-bundle check');
});

test('the catalogue pages, restarts once on 409, stops at 5 pages, and only a verified pool becomes an option', async () => {
  const CATALOGUE = { token: FIXTURE_TOKEN, limit: 20 };
  const NEXT = { ...CATALOGUE, afterPoolId: FIXTURE_POOL, revision: 2 };
  const withNext = { fixture: gateway('catalogue.success'), mutate: withNextCataloguePage, expectRequest: CATALOGUE };
  const paged = catalogue.createCatalogueSession(fixtures({ catalogue: [withNext, { fixture: gateway('catalogue.empty'), expectRequest: NEXT }] }), FIXTURE_TOKEN, null);
  await paged.first();
  const two = await paged.more();
  assert.equal(two.view.pages, 2);
  assert.equal(two.canLoadMore, false);

  const changed = catalogue.createCatalogueSession(fixtures({ catalogue: [withNext, { fixture: errorFixture('pools.catalogue_revision_changed'), expectRequest: NEXT }] }), FIXTURE_TOKEN, null);
  await changed.first();
  assert.equal((await changed.more()).view.restarted, true);

  const source = fixtures({ catalogue: [withNext, { fixture: gateway('catalogue.success'), mutate: withNextCataloguePage, expectRequest: NEXT }] });
  const capped = catalogue.createCatalogueSession(source, FIXTURE_TOKEN, null);
  let snap = await capped.first();
  for (let i = 0; i < 6; i++) snap = await capped.more();
  assert.equal(snap.view.pages, catalogue.CATALOGUE_PAGE_CAP);
  assert.equal(snap.capped, true);
  assert.equal(source.requests.length, 5);

  const request = catalogue.verifyRequest(FIXTURE_TOKEN, NATIVE, FIXTURE_POOL);
  assert.equal(runtime.validateRequest('pools', request), true);
  assert.equal(runtime.validateRequest('catalogue', catalogue.catalogueRequest(FIXTURE_TOKEN, NATIVE)), true);
  const VERIFY = { token: FIXTURE_TOKEN, maxPools: 1, poolIds: [FIXTURE_POOL] };
  const verified = await catalogue.verifyCandidate(fixtures({ pools: [{ fixture: gateway('pools.catalogue'), expectRequest: VERIFY }] }), FIXTURE_TOKEN, null, FIXTURE_POOL, { signal: live() });
  assert.equal(verified.option?.kind, 'catalogue');
  const missing = await catalogue.verifyCandidate(fixtures({ pools: [{ fixture: gateway('pools.missing'), expectRequest: VERIFY }] }), FIXTURE_TOKEN, null, FIXTURE_POOL, { signal: live() });
  assert.deepEqual([missing.failure, missing.option], [null, null]);
  const restarted = await catalogue.verifyCandidate(fixtures({ pools: [{ fixture: errorFixture('pools.catalogue_revision_changed') }, { fixture: gateway('pools.catalogue') }] }), FIXTURE_TOKEN, null, FIXTURE_POOL, { signal: live() });
  assert.equal(restarted.restarted, true);
  assert.equal(restarted.option?.key, FIXTURE_POOL);
});

test('the Top pools reads have the same 60 s budget as the screens, worded as a read stopped, never as retries used up', async () => {
  const clock = manualClock();
  const log = [];
  const hanging = {
    transport: 'fixture',
    read: (route, request, { signal }) => {
      log.push(route);
      return new Promise((done) => signal.addEventListener('abort', () => done({ route, state: 'aborted', provenance: { transport: 'fixture', contract: null, receivedAt: 0, attempts: 0 } })));
    },
  };
  const budgeted = withReadBudget(hanging, { clock });
  const pending = budgeted.read('pool-market', { poolId: FIXTURE_POOL }, { signal: live() });
  await clock.advance(SCREEN_BUDGET_MS - 1);
  let settled = false;
  void pending.then(() => (settled = true));
  await flush();
  assert.equal(settled, false, 'still waiting 1 ms before the budget');
  await clock.advance(1);
  const stopped = await pending;
  assert.deepEqual([stopped.state, stopped.cause, stopped.retryable], ['unavailable', { kind: 'read_deadline', limit: 'read' }, true]);
  assert.equal(describeFailure(stopped).detail, 'Stopped after 60 s, time spent queued included.', 'the Top pools wording, which ships in slice A’s describe module');
  // The screens say what slice A already says: one event, one description.
  assert.equal(copy.failureText(stopped, 'pools').detail, 'Stopped after 60 s, time spent queued included.');

  // The caller's own cancel stays a silent abort, and a read inside the budget passes through untouched.
  const cancelled = new AbortController();
  const aborted = withReadBudget(hanging, { clock }).read('pool-market', { poolId: FIXTURE_POOL }, { signal: cancelled.signal });
  cancelled.abort();
  assert.equal((await aborted).state, 'aborted');
  const provider = MARKET_CASES.find((c) => c.id === 'provider').script;
  // The lean request the table sends: the scenario answers that one and no other.
  const ok = await withReadBudget(fixtures(provider)).read('pool-market', { poolId: FIXTURE_POOL, includePriceHistory: false });
  assert.equal(ok.state, 'ok');
  assert.equal(clock.pending(), 0, 'no budget timer outlives its read');

  // What the app builds (buildMode.ts and the lab both call createAppMarketsProvider): the budget applies.
  const markets = createAppMarketsProvider({ source: hanging, poolIds: [FIXTURE_POOL], kind: 'fixture', clock });
  markets.ensure();
  await flush();
  assert.equal(markets.getSnapshot().phase, 'loading');
  await clock.advance(SCREEN_BUDGET_MS);
  await flush();
  const snap = markets.getSnapshot();
  assert.equal(snap.phase, 'failed');
  assert.deepEqual(snap.failure.cause, { kind: 'read_deadline', limit: 'read' });
});

// ---------------------------------------------------------------------------
// #13 attributed figures
// ---------------------------------------------------------------------------


test('pool-market figures keep every envelope state apart, dated only by the payload', () => {
  const market = (name) => runtime.assertResponse('pool-market', fixture(`pool-market.${name}`)).market;
  assert.deepEqual(figures.figureFromMarket(market('success'), 'liquidity'), { state: 'attributed', value: '$12.3K', raw: market('success').data.reportedLiquidityUsd, zero: false, provider: 'geckoterminal', retrievedAt: market('success').data.retrievedAt, cacheAgeSeconds: 0 });
  const stale = figures.figureFromMarket(market('stale'), 'liquidity');
  assert.equal(stale.state, 'attributed_stale', 'a stale envelope with a reason is still a retained observation');
  assert.equal(stale.refreshReason, 'provider_unavailable');
  assert.deepEqual(figures.figureFromMarket(market('expired'), 'liquidity'), { state: 'unavailable', provider: 'geckoterminal', reason: market('expired').reason }, 'a cache age on discarded data is not an observation');
  assert.equal(figures.figureFromMarket(market('rejected-currencies'), 'liquidity').state, 'rejected');
  assert.equal(figures.figureFromMarket(market('provider-timeout'), 'volume').state, 'unavailable');
  assert.equal(figures.figureFromMarket(market('missing'), 'liquidity').state, 'not_reported');
  const zero = figures.figureFromMarket(market('zero'), 'volume');
  assert.deepEqual([zero.value, zero.zero], ['$0.00', true]);
  assert.equal(figures.utcTime(1010), '00:16:50 UTC, 1970-01-01');
});

test('provenance attributes the figure to a provider without naming it, gives the retrieval, says not reconciled, never claims current, and ignores the client clock', () => {
  const states = [
    { state: 'attributed', value: '$1', zero: false, provider: 'geckoterminal', retrievedAt: 1010, cacheAgeSeconds: 0 },
    { state: 'attributed_stale', value: '$1', zero: false, provider: 'geckoterminal', retrievedAt: 1010, cacheAgeSeconds: 200, refreshReason: 'provider_unavailable' },
    { state: 'not_reported', provider: 'dexscreener' },
    { state: 'unavailable', provider: 'geckoterminal', reason: 'provider_rate_limited' },
    { state: 'rejected', provider: 'geckoterminal', reason: 'provider_currency_or_pool_mismatch' },
  ];
  const realNow = Date.now;
  const render = () => states.map((s) => figures.provenanceText(s));
  try {
    Date.now = () => 0;
    const in1970 = render();
    Date.now = () => Date.UTC(2026, 8, 11);
    assert.deepEqual(render(), in1970, 'the same reply reads the same whatever the client clock says');
  } finally {
    Date.now = realNow;
  }
  for (const [i, { short, long }] of render().entries()) {
    assert.match(short, /^Provider\b/, `state ${states[i].state} says a provider reported it`);
    assert.match(long, /market data provider/, `state ${states[i].state} attributes the figure to a provider`);
    assert.doesNotMatch(`${short} ${long}`, /GeckoTerminal|DexScreener/, 'the provider is never named on a screen');
    assert.match(long, /retrieved/i, 'the retrieval is stated');
    assert.match(long, /not reconciled/);
    assert.doesNotMatch(`${short} ${long}`, PROVENANCE_BANNED);
  }
});

test('#123: stale provenance does not invent a failed refresh when only the observation aged', () => {
  const stale = { state: 'attributed_stale', value: '$1', zero: false, provider: 'geckoterminal', retrievedAt: 1010, cacheAgeSeconds: 0, refreshReason: null };
  const aged = figures.provenanceText(stale);
  assert.match(aged.short, /stale/);
  assert.match(aged.long, /retrieved 00:16:50 UTC, 1970-01-01/);
  assert.doesNotMatch(aged.long, /refresh failed/i, 'elapsed time is not evidence that a refresh was attempted');
  const failed = figures.provenanceText({ ...stale, refreshReason: 'provider_unavailable' });
  assert.ok(failed.long.includes(built('describe').reasonText('provider_unavailable')), 'a known reason remains visible');
  assert.match(failed.short, /stale/);
});

test('pool age comes from verified activity data only, and never an APR or USD figure from it', () => {
  const partial = runtime.assertResponse('pool-activity', fixture('pool-activity.partial'));
  const realNow = Date.now;
  let facts;
  try {
    Date.now = () => 0;
    facts = figures.activityFacts(partial);
    Date.now = () => Date.UTC(2026, 8, 11);
    assert.deepEqual(figures.activityFacts(partial), facts);
  } finally {
    Date.now = realNow;
  }
  assert.equal(facts.window, 'young');
  assert.deepEqual(facts.age, { seconds: 19, basis: 'observedSeconds' });
  assert.equal(19, partial.snapshot.timestamp - partial.coverage.initializedAt);
  assert.equal(Object.keys(facts).some((key) => /apr|usd/i.test(key)), false);
  const covered = figures.activityFacts(runtime.assertResponse('pool-activity', fixture('pool-activity.success')));
  assert.equal(covered.window, 'covered');
  assert.equal(covered.age, null);
  assert.equal(figures.activityFacts(runtime.assertResponse('pool-activity', fixture('pool-activity.stale'))).stale, true);
  assert.equal(figures.activityFacts(runtime.assertResponse('pool-activity', fixture('pool-activity.unavailable'))).feeAccounting, 'unavailable');
});

test('pool activity’s age: fresh up to the read service’s 120 s, shown stale up to 15 minutes behind, never the last 24 hours past that; time on the page counts on', () => {
  const { activityAge, heldSeconds, lagText, activityStaleText, ACTIVITY_FRESH_SECONDS, ACTIVITY_SHOWN_SECONDS } = figures;
  // The bound is grounded in the producer: its fresh line is 120 s, and it names no age at which stale history stops being served.
  assert.equal(ACTIVITY_FRESH_SECONDS, 120);
  assert.equal(ACTIVITY_SHOWN_SECONDS, 900);
  const at = (ageSeconds) => ({ ageSeconds, status: ageSeconds > 120 ? 'stale' : 'fresh', checkedAgainstHead: 701 });
  assert.deepEqual([0, 120, 121, 900, 901, 4_891_659].map((age) => activityAge(at(age)).state), ['fresh', 'fresh', 'stale', 'stale', 'too_old', 'too_old']);
  assert.deepEqual(activityAge(at(10), 890.9), { seconds: 900, state: 'stale' }, 'whole seconds held, added to the reported age');
  assert.deepEqual(activityAge(at(10), 891), { seconds: 901, state: 'too_old' });
  assert.deepEqual(activityAge(at(10), -50), { seconds: 10, state: 'fresh' }, 'a clock that went backwards takes nothing off');
  assert.equal(activityAge({ ageSeconds: 30, status: 'stale', checkedAgainstHead: 1 }).state, 'stale', 'the read service saying stale is enough');
  assert.equal(heldSeconds({ receivedAt: 1_000, receivedMonotonic: 50 }, { wall: 10_000_000, monotonic: 3_049 }), 2, 'the monotonic clock when both have one');
  assert.equal(heldSeconds({ receivedAt: 1_000 }, { wall: 4_500, monotonic: 99 }), 3, 'the wall clock otherwise');
  assert.equal(heldSeconds({ receivedAt: 9_000 }, { wall: 1_000 }), 0);
  assert.deepEqual([59, 119, 120, 7_199, 7_200, 172_799, 172_800, 4_891_659].map(lagText), ['59 s', '119 s', '2 min', '119 min', '2 h', '47 h', '2 days', '56 days']);
  assert.equal(activityStaleText(activityAge(at(10)), 700), null);
  assert.equal(activityStaleText(activityAge(at(300)), 700), 'Stale: indexed 5 min behind the chain head, at block 700.');
  assert.equal(activityStaleText(activityAge(at(4_891_659)), 14_787_808), 'Stale: indexed 56 days behind the chain head, at block 14787808, too far behind to show as the last 24 hours.');
});

test('the pool page’s chain figures: amounts in each token’s own units from decimals already read, bound by address; never guessed, never USD', () => {
  const tokens = [
    { origin: 'read', chainId: 4663, address: NATIVE, symbol: 'ETH', decimals: 18, readStatus: 'available', artwork: null },
    { origin: 'read', chainId: 4663, address: FIXTURE_TOKEN, symbol: 'TOKEN', decimals: 6, readStatus: 'available', artwork: null },
  ];
  assert.deepEqual(figures.tokenAmount('1635670293697', FIXTURE_TOKEN, tokens), { raw: '1635670293697', text: '1,635,670', exact: '1,635,670.293697' });
  assert.deepEqual(figures.tokenAmount('28926913445278', NATIVE, tokens), { raw: '28926913445278', text: '0.0000289269', exact: '0.000028926913445278' }, 'six significant digits, never an exponent');
  assert.equal(figures.tokenAmount('1234567', FIXTURE_TOKEN, tokens).text, '1.23457');
  const lettered = { ...tokens[1], address: `0x${'ab'.repeat(20)}` };
  assert.equal(figures.tokenAmount('1234567', `0x${'AB'.repeat(20)}`, [lettered]).text, '1.23457', 'the address binds without case');
  assert.equal(figures.tokenAmount('0', NATIVE, tokens).text, '0');
  assert.equal(figures.tokenAmount('999999999999', FIXTURE_TOKEN, tokens).text, '1,000,000', 'rounded at six significant digits, carried into the next place');
  assert.deepEqual(figures.tokenAmount('5', OTHER_ADDRESS, tokens), { raw: '5', text: null, exact: null }, 'a token whose decimals were not read keeps its raw amount only');
  assert.deepEqual(figures.tokenAmount('5', NATIVE, [{ ...tokens[0], decimals: null }]), { raw: '5', text: null, exact: null });

  const view = figures.poolActivityView(runtime.assertResponse('pool-activity', fixture('pool-activity.success')), tokens);
  assert.deepEqual(view.turnover.map((amount) => amount.text), ['0.0000289269', '1,635,670']);
  assert.deepEqual(view.lpFees.amounts.map((amount) => amount.exact), ['0.000000086412877935', '300.000002']);
  assert.equal(Object.keys(view).some((key) => /apr|usd/i.test(key)), false, 'no USD figure and no APR from pool activity');
  const unreconciled = figures.poolActivityView(runtime.assertResponse('pool-activity', fixture('pool-activity.unavailable')), tokens);
  assert.deepEqual([unreconciled.lpFees, unreconciled.lpAssets], [{ state: 'unavailable', reason: 'fee_ledger_not_caught_up' }, { state: 'unavailable', reason: 'position_ledger_not_caught_up' }]);

  const positions = figures.poolPositionsView(runtime.assertResponse('pool-positions', fixture('pool-positions.success')), tokens);
  assert.deepEqual([positions.state, positions.count, positions.withLiquidity, positions.rows.map((r) => [r.tickLower, r.tickUpper, r.hasLiquidity, r.nft])], ['reconciled', 3, 2, [[-60000, 60000, true, null], [-60, 60, true, null], [-60000, 60000, false, null]]], 'no NFT resolved: no owner is shown');
  assert.deepEqual(figures.poolPositionsView(runtime.assertResponse('pool-positions', fixture('pool-positions.unavailable')), tokens), { state: 'unavailable', reason: 'position_ledger_not_caught_up', block: 700, stale: false });
});

test('a pool’s protocol fee reads per direction from its packed value, and anything outside the v4 bounds is invalid, never a rate', () => {
  assert.deepEqual(figures.protocolFee(0), { state: 'none' });
  assert.deepEqual(figures.protocolFee(820200), { state: 'directional', zeroForOne: '0.10%', oneForZero: '0.02%', zeroForOnePips: 1000, oneForZeroPips: 200 }, 'low 12 bits selling currency0, high 12 bits selling currency1');
  assert.deepEqual(figures.protocolFee(1000 * 4096 + 1000), { state: 'directional', zeroForOne: '0.10%', oneForZero: '0.10%', zeroForOnePips: 1000, oneForZeroPips: 1000 });
  assert.deepEqual(figures.protocolFee(1), { state: 'directional', zeroForOne: '0.0001%', oneForZero: '0.00%', zeroForOnePips: 1, oneForZeroPips: 0 });
  for (const bad of [1001, 1001 * 4096, -1, 1 << 24, 0.5]) assert.deepEqual(figures.protocolFee(bad), { state: 'invalid' }, String(bad));
});

// The table reads pool-metrics where the capabilities list it (marketsProvider.ts),
// and a fixture source lists exactly the routes its script answers, so these
// rows come from the projection cases' pool-market and pool-metrics replies
// through the table's own load.
test('only usableAsCurrent24h makes a row qualified; provider-derived turnover waits on the open question', async () => {
  const script = (id) => {
    const c = PROJECTION_CASES.find((entry) => entry.id === id);
    return { 'pool-market': [{ ...c.market, expectRequest: { poolId: FIXTURE_POOL, includePriceHistory: false } }], 'pool-metrics': [c.metrics], token: projectionTokens(c.token) };
  };
  const row = async (id) => (await loadSelectedPools(fixtures(script(id)), [FIXTURE_POOL], undefined, undefined, { metrics: true })).rows[0];
  assert.equal(figures.rowQualified(await row('qualified')), true);
  for (const id of ['provider', 'reference', 'partial', 'stale', 'metrics-invalid']) assert.equal(figures.rowQualified(await row(id)), false, id);
  const provider = await row('provider');
  assert.deepEqual(figures.turnoverCell(provider), { kind: 'unavailable', reason: 'derived_figure_pending_q8' });
  assert.equal(figures.turnoverCell(await row('stale')).kind, 'unavailable');
  const qualified = await row('qualified');
  assert.deepEqual(figures.turnoverCell(qualified), markets.turnover(qualified), 'qualified operands keep the existing ratio');
  assert.equal(figures.metricNoteCode(provider.feeAprPercent), provider.feeAprPercent.reason);
  assert.equal(figures.figureNoteId('provider_lp_fee_history_unavailable'), 'figure-note-provider_lp_fee_history_unavailable');
  assert.equal(copy.screenReason('derived_figure_pending_q8'), 'volume over TVL from provider figures waits on a decision about derived figures');
});

test('the landing reads a bounded list: no placeholder pool, at most 4 reads a pool', async () => {
  for (const mode of ['fixture', 'bridge']) {
    const ids = marketList.marketPoolIds(mode);
    assert.ok(ids.length >= 1 && ids.length <= marketList.MARKET_POOL_BUDGET, mode);
    for (const id of ids) assert.equal(marketList.PLACEHOLDER_POOL_IDS.includes(id), false);
  }
  const source = fixtures(APP_SCRIPT);
  const loaded = await loadSelectedPools(source, marketList.marketPoolIds('fixture'));
  assert.equal(loaded.rows.length, 1);
  assert.ok(source.requests.length <= marketList.READS_PER_POOL * loaded.rows.length, `${source.requests.length} reads`);
  assert.deepEqual(source.requests.map((r) => r.route), ['pool-market', 'token', 'token']);
  // Explicitly false, not absent: the table draws no chart, and saying so lets
  // answersRequest refuse a reply that carries history nobody asked for.
  assert.equal(source.requests[0].request.includePriceHistory, false, 'table rows ask for no price history, and say so');
});

// ---------------------------------------------------------------------------
// Words and guards
// ---------------------------------------------------------------------------

test('every fixed sentence is listed for the default-bundle check, and chain cards never say "your"', () => {
  const all = copy.allCopyStrings();
  assert.ok(all.length > 40, `${all.length} sentences`);
  assert.equal(new Set(all).size, all.length);
  for (const sentence of all) assert.ok(sentence.length >= 12, sentence);
  // 2026-09-24: the lookup's sentences went with the lookup by typed NFT ids.
  assert.equal(copy.COPY.lookup, undefined);
  assert.equal(copy.IDS_PROBLEM, undefined);
  for (const wanted of [copy.COPY.card.ownerNote, copy.COPY.picker.tokenTitle, copy.COPY.figures.providerDetail]) assert.ok(all.includes(wanted), wanted);
  for (const sentence of Object.values(copy.COPY.card)) assert.doesNotMatch(sentence, /\byour\b|\byou own\b/i, sentence);
  // Changed on purpose (review of 2026-09-14): the owner is labelled Owner, and that it is public data proving nothing is its title, not a caption.
  assert.equal(copy.COPY.card.owner, 'Owner');
  assert.match(copy.COPY.card.ownerNote, /proves nothing/);
  // No card or picker sentence is a caption about where data comes from.
  for (const sentence of [...Object.values(copy.COPY.card), copy.COPY.picker.walletEmpty]) assert.doesNotMatch(sentence, /read from chain|this server|read service/i, sentence);
  assert.match(copy.COPY.picker.walletPill, /not your wallet/);
});

test('every read state has its own words, and the beta gate never offers a wallet sign-in', () => {
  const provenance = { transport: 'fixture', contract: null, receivedAt: 0, attempts: 3 };
  const states = [
    { state: 'gate_required' },
    { state: 'gate_unavailable' },
    { state: 'access_required' },
    { state: 'incompatible', reason: 'contract_version_not_accepted' },
    { state: 'invalid', reason: 'response_contract' },
    { state: 'invalid', reason: 'identity_mismatch' },
    { state: 'unavailable', cause: { kind: 'producer', code: 'upstream_unavailable', status: 503 }, retryable: true },
    { state: 'unavailable', cause: { kind: 'network' }, retryable: false },
    { state: 'unavailable', cause: { kind: 'edge', status: 502 }, retryable: false },
    { state: 'unavailable', cause: { kind: 'read_deadline', limit: 'read' }, retryable: true },
    { state: 'unavailable', cause: { kind: 'queue_full' }, retryable: true },
    { state: 'busy', retryAfterSeconds: 7 },
    { state: 'restart_required', code: 'invalid_or_expired_cursor' },
    { state: 'request_rejected', code: 'invalid_request', status: 422 },
    { state: 'disabled', reason: 'route_not_enabled' },
    { state: 'disabled', reason: 'bridge_data_mode_disabled' },
    { state: 'local', code: 'screen_budget_exceeded' },
    { state: 'incomplete_reply' },
  ];
  const seen = new Set();
  for (const s of states) {
    const t = copy.failureText({ route: 'nft-positions', provenance, ...s }, 'positions');
    assert.ok(t.title && t.detail, JSON.stringify(s));
    seen.add(`${t.title}|${t.detail}`);
    assert.doesNotMatch(`${t.title} ${t.detail}`, /connect|wallet sign|sign in with/i);
  }
  // An incompatible header and a reply that fails validation both mean the same thing to a person: this build needs an update.
  const update = (s) => copy.failureText({ route: 'nft-positions', provenance, ...s }, 'positions');
  assert.deepEqual(update(states[3]), { ...update(states[4]), code: 'incompatible' });
  assert.equal(seen.size, states.length - 1, 'every other pair of states reads differently');
  assert.match(copy.failureText({ route: 'nft-positions', provenance, state: 'gate_required' }, 'positions').detail, /Reload the page to sign in again/);
  // Nothing a person can read about the site's access check calls the site a beta.
  for (const state of ['gate_required', 'gate_unavailable']) assert.doesNotMatch(Object.values(copy.failureText({ route: 'nft-positions', provenance, state }, 'positions')).join(' '), /\bbeta\b|\byet\b/i, state);
  assert.equal(copy.failureText({ route: 'nft-positions', provenance, state: 'disabled', reason: 'route_not_enabled' }, 'positions').detail, 'Position reads aren’t enabled on this server.');
  assert.equal(copy.failureText({ route: 'nft-positions', provenance, state: 'aborted' }, 'positions').title, '', 'a cancelled read says nothing');
});

const SCREEN_DIRS = [join(SRC, 'lib/read/screens'), join(SRC, 'components/read/screens')];
const BANNED_IDENTIFIERS = new Set([
  'sendTransaction', 'writeContract', 'sendCalls', 'approve', 'signMessage', 'signTypedData', 'ethereum', 'fetch', 'XMLHttpRequest', 'WebSocket',
  'EventSource', 'sendBeacon', 'innerHTML', 'outerHTML', 'dangerouslySetInnerHTML', 'localStorage', 'sessionStorage', 'indexedDB', 'caches',
  'BroadcastChannel', 'Number', 'parseFloat', 'parseInt', 'sourceUrl', 'eval',
]);
const BANNED_IMPORTS = /core\/practice|core\/local-workspace|session-v1|deposit-v1|onboarding-v1/;
const BANNED_STRINGS = /https?:\/\/|eth_[a-z]|personal_sign/i;

/** Every violation in one source file, found on its syntax tree so comments never count. */
function violations(source, file = 'inline.tsx') {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found = [];
  const visit = (node) => {
    if (ts.isIdentifier(node) && BANNED_IDENTIFIERS.has(node.text)) found.push(`identifier ${node.text}`);
    if (ts.isPropertyAccessExpression(node) && node.expression.getText() === 'window' && node.name.text === 'open') found.push('window.open');
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText() === 'a') found.push('<a> element');
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText();
      if (name === 'href' || name === 'src') found.push(`${name} attribute`);
      if (name === 'key' && node.initializer && /symbol/i.test(node.initializer.getText())) found.push('key built from a symbol');
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) && BANNED_STRINGS.test(node.text)) {
      found.push(`string ${node.text.slice(0, 40)}`);
    }
    if (ts.isImportDeclaration(node) && BANNED_IMPORTS.test(node.moduleSpecifier.text)) found.push(`import ${node.moduleSpecifier.text}`);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

test('the read screens hold no signing, value transfer, network, storage, link, markup or practice-workspace path', () => {
  // The guard itself catches what it is for, and ignores comments.
  assert.deepEqual(violations('// fetch approve localStorage https://x\nconst a = 1'), []);
  assert.deepEqual(
    violations('const x = fetch("https://evil.test"); const y = <a href="/">x</a>; window.open("/"); localStorage.x = Number("1")').sort(),
    ['<a> element', 'href attribute', 'identifier Number', 'identifier fetch', 'identifier localStorage', 'string https://evil.test', 'window.open'].sort(),
  );
  assert.deepEqual(violations("import { addPracticePosition } from 'core/practice'"), ['import core/practice']);
  assert.deepEqual(violations('const r = rows.map((t) => <li key={t.symbol}>{t.symbol}</li>)'), ['key built from a symbol']);
  const files = SCREEN_DIRS.flatMap(sourceFiles);
  assert.ok(files.length >= 25, `${files.length} files scanned`);
  for (const file of files) assert.deepEqual(violations(readFileSync(file, 'utf8'), file), [], file);
});

// #112 review, P2 (@rugged97): withReadBudget dropped the caller's deadlineAt,
// and readWithin forwarded only its own signal. A pager's automatic restart
// carries the first attempt's deadline so the two share one budget — through
// the wrapper it was granted a fresh 60 s instead. The budget may shorten that
// deadline; it may never extend it.
test('the screen budget shortens the caller’s deadline and never extends it', async () => {
  const clock = manualClock();
  const seen = [];
  const inner = {
    transport: 'fixture',
    read: (route, request, options) => {
      seen.push(options?.deadlineAt ?? null);
      return Promise.resolve({ route, state: 'ok', data: null, provenance: { transport: 'fixture', contract: null, receivedAt: clock.now(), attempts: 0 } });
    },
  };
  const budgeted = withReadBudget(inner, { clock });

  await budgeted.read('token', { token: FIXTURE_TOKEN }, { signal: live() });
  assert.equal(seen[0], null, 'the budget is not handed down as a deadline: when it runs out the outcome is this screen’s own, not the pipeline’s');

  await budgeted.read('token', { token: FIXTURE_TOKEN }, { signal: live(), deadlineAt: 1000 });
  assert.equal(seen[1], 1000, 'an earlier deadline passes through untouched');

  // The reproduction from the review: monotonic 1050, caller deadline 1000.
  await clock.advance(1050);
  await budgeted.read('token', { token: FIXTURE_TOKEN }, { signal: live(), deadlineAt: 1000 });
  assert.equal(seen[2], 1000, 'an expired deadline reaches the source as it is, for the source to answer as a direct read would');

  const distant = clock.monotonic() + 5 * SCREEN_BUDGET_MS;
  await budgeted.read('token', { token: FIXTURE_TOKEN }, { signal: live(), deadlineAt: distant });
  assert.equal(seen[3], distant, 'a deadline beyond the budget travels as it is; the budget still stops the read first, in its own words');
});

// The rest of that same finding, which the wrapper fix did not reach: the two
// manual 409 restarts asked again without the first attempt's deadline, so a
// restart near expiry was handed a fresh screen budget. @rugged97's exact
// reproduction on #112: first attempt with deadline 60000,
// `catalogue_revision_changed` at 59000, second attempt granted 119000 and
// answering with a selectable option at 61000 — past the deadline the logical
// read began with. Both restart sites now pass the first outcome's
// `provenance.deadlineAt` on, so the two attempts share one budget.
test('a manual restart after catalogue_revision_changed keeps the first attempt’s deadline, never a fresh budget', async () => {
  const seen = [];
  const provenance = { transport: 'fixture', contract: null, receivedAt: 0, attempts: 1, deadlineAt: 60_000 };
  const source = {
    transport: 'fixture',
    read: (route, _request, options) => {
      seen.push(options?.deadlineAt ?? null);
      return Promise.resolve(
        seen.length === 1
          ? { route, state: 'restart_required', code: 'catalogue_revision_changed', provenance }
          : { route, state: 'unavailable', cause: { kind: 'network' }, retryable: true, provenance },
      );
    },
  };

  const verified = await catalogue.verifyCandidate(source, FIXTURE_TOKEN, null, FIXTURE_POOL, { signal: live() });
  assert.equal(verified.restarted, true, 'the 409 did start a second attempt');
  assert.deepEqual(
    seen,
    [null, 60_000],
    'the first attempt carries no deadline of its own, and the restart carries the one that attempt came back with',
  );
});
