import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import * as runtime from '../../api-contracts/read-v1/runtime.mjs'
import * as v2 from '../../api-contracts/read-v2/runtime.mjs'

const require = createRequire(import.meta.url)
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const ts = require('typescript')
const root = resolve(import.meta.dirname, '..')
const flush = () => new Promise((done) => setImmediate(done))
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
const addr = (letter) => `0x${letter.repeat(40)}`
const id = (letter) => `0x${letter.repeat(64)}`
const token = (letter) => ({ origin: 'read', chainId: 4663, address: addr(letter), symbol: letter, decimals: 18, artwork: null, readStatus: 'available' })
const option = (letter) => ({ key: id(letter), currencies: [token('1'), token('2')], fee: '0.3%', feePips: 3000, tickSpacing: 60, hooks: addr('0'), integration: 'hookless_fixed_fee', block: 700, tick: 0, sqrtPriceX96: '79228162514264337593543950336', aprReason: 'reconciled_fee_history_unavailable' })
const metric = { value: '42', state: 'provider', source: 'GeckoTerminal', asOf: 1000 }
const row = (poolId) => ({ poolId, tokens: { base: token('1'), quote: token('2') }, tvlUsd: metric, volume24hUsd: metric, provenance: { block: 700, market: { status: 'available', receivedAt: 0, ageSeconds: 0, cacheAgeSeconds: 0, freshForSeconds: 60 } } })
const Container = ({ children }) => React.createElement('div', null, children)
const stub = (name) => Object.defineProperty(() => null, 'displayName', { value: name })
const parts = Object.fromEntries([
  'PoolPicker', 'PoolSelectionDialog', 'PoolWorkspace', 'TokenPicker', 'TokenLookup', 'CatalogueCandidates', 'WalletCandidates', 'PoolPriceChart', 'PoolHistoryChart', 'PoolRangeControls',
  'PoolAprEstimate', 'IconChevronLeft', 'PoolCatalogueIdentity', 'PoolTokenLabel', 'TokenMark', 'TokenMarkPair', 'SymbolText', 'Address', 'MetricCell', 'TurnoverCell', 'Tabs', 'Skeleton',
  'CopyButton', 'ProviderFigure', 'EmptyState', 'LinkButton', 'SelectedPoolsTable', 'MarketsTable', 'TokensTable', 'SearchField', 'PageHeader', 'PoolActivityCard', 'PoolPositionsCard',
  // 2026-09-27 (round 6, the pool page for beginners): its new cards (src/components/pool/), each checked for real below.
  'PoolEarnings', 'PoolRangeGuide', 'PoolAutomation', 'PoolActivitySummary',
  // 2026-10-01 (audit V1): an estimate standing in for the read service's.
  'FallbackApr',
].map((name) => [name, stub(name)]))

// Deterministic effect harness around the actual component source. It models
// state, dependency cleanup and unmount; it does not simulate a browser or
// claim provider/contract acceptance. The read boundary is a deferred stub.
let active
const hooks = {
  useState(initial) { const host = active, index = host.cursor++; if (!(index in host.values)) host.values[index] = typeof initial === 'function' ? initial() : initial; return [host.values[index], (value) => { host.writes++; host.values[index] = typeof value === 'function' ? value(host.values[index]) : value }] },
  useRef(initial) { const host = active, index = host.cursor++; return host.values[index] ??= { current: initial } },
  useCallback(callback, deps) { const host = active, index = host.cursor++; const prior = host.memo[index]; if (!prior || deps.some((d, i) => !Object.is(d, prior.deps[i]))) host.memo[index] = { callback, deps }; return host.memo[index].callback },
  useMemo(factory, deps) { const host = active, index = host.cursor++; const prior = host.memo[index]; if (!prior || deps.some((d, i) => !Object.is(d, prior.deps[i]))) host.memo[index] = { value: factory(), deps }; return host.memo[index].value },
  useEffect(effect, deps) { const host = active, index = host.cursor++; const prior = host.effects[index]; if (!prior || !deps || deps.some((d, i) => !Object.is(d, prior.deps?.[i]))) host.pending.push(() => { prior?.cleanup?.(); host.effects[index] = { deps, cleanup: effect() } }) },
}
function mount(Component, props) {
  const host = { values: [], memo: [], effects: [], pending: [], cursor: 0, writes: 0, props,
    render() { host.cursor = 0; active = host; host.tree = Component(host.props); active = null; for (const apply of host.pending.splice(0)) apply(); return host.tree },
    unmount() { for (const effect of host.effects) effect?.cleanup?.() },
  }
  host.render(); return host
}
function elements(tree, predicate) {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap((item) => elements(item, predicate))
  return [...(predicate(tree) ? [tree] : []), ...elements(tree.props?.children, predicate)]
}
const part = (host, name) => elements(host.tree, (node) => node.type === parts[name])[0]
/** The Button stub renders as Container: the one whose only child is `label`. */
const buttonNamed = (host, label) => elements(host.tree, (node) => node.type === Container && node.props.children === label)[0]
/** `name` is a read-screen component, or a root-relative path to any module. */
function load(name, dependencies, expose = '') {
  const file = name.includes('/') ? resolve(root, name) : resolve(root, `src/components/read/screens/${name}.tsx`)
  const content = readFileSync(file, 'utf8') + (expose ? `\nexport { ${expose} };` : '')
  const code = ts.transpileModule(content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const mod = { exports: {} }
  const common = {
    ...parts, Button: Container, Card: Container, Pill: Container, StatStrip: Container, cx: (...args) => args.join(' '),
    // The shared dash is the real thing, not a stub: it carries the reason as an accessible name,
    // and `dashes` below finds it by component name, which a stub() does not have.
    FigureDash: function FigureDash({ reason }) { return React.createElement('span', { className: 'text-fg-subtle', title: reason, 'data-figure': 'none' }, '—') },
    // A stat renders its label, value and source line as text, so attribution can be checked as visible words.
    Stat: ({ label, children, sub }) => React.createElement('div', null, label, ' ', children, ' ', sub ?? null),
    useNow: () => ({ wall: 1001000, monotonic: 0 }), agedMarket: (market) => market,
    useLoadMilestone: () => undefined, // Readiness instrumentation has its own clock/privacy tests.
    retrievedAgeSeconds: () => 12, retrievedText: (age) => (age === null ? 'retrieval time unknown' : `retrieved ${age} s ago`),
    presentMetric: (value, format) => ['provider', 'stale', 'qualified'].includes(value.state) && value.value !== null ? { kind: 'value', text: format ? format(value) : '$42', source: value.source, asOf: value.asOf, stale: value.state === 'stale' } : { kind: 'unavailable', reason: value.reason },
    percentText: (metric) => metric.value,
    projectMarketRow: ({ market }) => row(market.data.poolId),
    // Never time to ask again, unless a test says so.
    askAgainLater: () => new Promise(() => {}),
    protocolFee: (raw) => (raw === 0 ? { state: 'none' } : { state: 'directional', zeroForOne: '0.10%', oneForZero: '0.02%', zeroForOnePips: raw & 0xfff, oneForZeroPips: raw >> 12 }),
    failureText: () => ({ code: 'offline', title: 'Unavailable', detail: 'No response', retry: true }),
    addressKey: (value) => value, poolIdKey: (value) => value, shortAddress: (value) => `${value.slice(0, 6)}…${value.slice(-4)}`, NATIVE_CURRENCY: addr('0'),
    parseAddressInput: (raw) => (/^0x[0-9a-fA-F]{40}$/.test(raw) ? { ok: true, wire: raw, key: raw.toLowerCase() } : { ok: false, reason: 'length' }),
    // Changed on purpose 2026-09-28 (one-sided): the page takes its preset with presetFor, on the price as it writes it.
    poolPrice: () => ({ state: 'usable', tick: 0, tickSpacing: 60, text: '≈1', base: token('1'), quote: token('2'), inverted: false, decimals: [18, 18], block: 700, stale: false, partial: false }), presetRange: () => ({ lower: -60, upper: 60 }), presetFor: () => ({ lower: -60, upper: 60 }),
    // 2026-09-27 (round 6): the pool page's plain words are the real module (src/components/pool/plain.ts), its estimate
    // is the observation's own figure, and New position's test is the one poolsList.ts states.
    ...real('src/components/pool/plain.ts'),
    presentAprEstimate: (observation) => (observation?.data?.feeAprEstimate24hPercent ? { state: 'available', text: observation.data.feeAprEstimate24hPercent, reasons: [], ageSeconds: 0 } : { state: 'unavailable', text: null, reasons: ['estimate_not_enabled'], ageSeconds: null }),
    optionUsableForDomino: (option) => option.integration === 'hookless_fixed_fee' && option.hooks === addr('0') && option.feePips !== 8388608,
    selectable: (candidate) => candidate.why === null, whyText: () => null, reasonText: (code) => String(code), activityFacts: (data) => data,
    COPY: { range: { problems: { decimals_unknown: 'Decimals unknown', tick_mismatch: 'Tick mismatch', not_initialized: 'Not initialised', beyond_display: 'Beyond display' } }, picker: { hookless: 'No hooks, fixed fee', needsAdapter: 'Needs a separate adapter', partialMetadata: '', providerConflict: '', checking: 'Checking…' }, figures: { activityLoading: '' }, selection: { decimalsUnavailable: 'decimals unavailable' } },
    // An entry with no addresses keeps its order (read.test.mjs checks inPoolOrder itself).
    SELECTED_POOL_CATALOGUE: [{ poolId: id('a'), labels: ['A', 'B'], fee: '0.3%', artwork: [null, null] }], SELECTED_POOLS_COMMON_TOKEN: addr('5'), inPoolOrder: (entry) => entry,
    // 2026-09-26 (featured pools v1): the list on screen is the embedded one here, and an entry without addresses is
    // verified against the token every embedded pool holds, as config/selectedPoolCatalogue.ts entryToken says.
    useFeatured: () => ({ source: 'bundled', entries: [], listId: null, settled: true, withdrawn: new Set() }),
    entryToken: (entry) => entry.addresses ? entry.addresses[1] : addr('5'),
    // 2026-10-01 (audit): pairs named as their price is written (E21), look-alike tokens (I1), failures that pass (A25),
    // and the stand-in figures (V1): the real rules have their own tests; here the page's use of them.
    inPriceOrder: (entry) => entry, poolWarning: () => null, warningText: () => '',
    pricePair: require('../.test-build/app/src/lib/read/orientation.js').pricePair,
    isTransient: (outcome) => outcome?.state === 'busy' || outcome?.state === 'unavailable',
    useFallbackRow: (row) => row, usePoolStandIns: () => null, useFallbackRows: (rows) => rows,
    // A token's page (audit V2): its own merge and flags are tested in token-pools.test.mjs; here, the overview pages.
    featuredPoolIds: () => [], discoveryRows: () => [], mergeTokenPools: (stored, found) => [...stored, ...found], splitFlagged: (rows) => ({ shown: rows, hidden: [] }),
    dexStore: { pool: () => null, token: () => null, ask() {}, subscribe: () => () => {}, version: () => 0 },
    hintsWithin: async () => [], usablePoolsRequest: (token) => ({ token }), tokenWarning: () => null,
    // 2026-10-01 (the copy workstream): the fee chip's and the APR's one format (audit E21), the real modules, and the
    // tab's name (audit E11), which a page here sets nowhere.
    ...real('src/lib/format/fee.ts'), ...real('src/lib/format/apr.ts'), useRouteTitle: () => undefined, useTabTitle: () => undefined,
    quoteIndex: require('../.test-build/app/src/lib/read/orientation.js').quoteIndex,
    ...dependencies,
  }
  new Function('require', 'module', 'exports', code)((name) => name === 'react' ? hooks : name === 'react/jsx-runtime' ? require(name) : common, mod, mod.exports)
  return mod.exports
}
/**
 * The workspace over a deferred read boundary. `listed` makes the source
 * answer routeEnabled, as the app's scheduled source does, with those routes
 * enabled; without it the source has no routeEnabled at all.
 */
function workspace({ listed, dependencies = {}, option: chosen = option('a') } = {}) {
  const reads = []
  const asks = []
  const checks = []
  const source = { transport: 'bridge', ...(listed ? { routeEnabled: async (route) => (checks.push(route), { state: listed.includes(route) ? 'enabled' : 'not_enabled' }) } : {}) }
  const module = load('PoolWorkspace', {
    readWithin(_source, route, request, options) { const pending = deferred(); reads.push({ route, request, options, ...pending }); return pending.promise },
    askAgainLater(outcome, attempt, signal) { const pending = deferred(); asks.push({ outcome, attempt, signal, ...pending }); return pending.promise },
    ...dependencies,
  })
  // Changed on purpose (2026-09-28, round 6 review): the workspace works out its typical range on the price now, so the
  // page hands it none (it used to hand the range planned when the pool was checked).
  const props = { source, option: chosen, onOption() {} }
  return { ...module, reads, asks, checks, props }
}
const visibleText = (host) => renderToStaticMarkup(host.tree).replace(/<[^>]+>/g, '')
const lean = { poolId: id('a'), includePriceHistory: false }
const ok = (extra = {}) => ({ state: 'ok', data: { poolId: id('a') }, ...extra })
const unavailable = { state: 'unavailable', cause: { kind: 'producer', code: 'upstream_unavailable', status: 503 }, retryable: true }
/** Every dash the page drew in place of a figure (the shared FigureDash), by the reason it names. */
const dashes = (host) => elements(host.tree, (node) => node.type?.name === 'FigureDash').map((node) => node.props.reason)

/**
 * The Markets rail over the hook harness, with the real card decisions
 * (lib/read/cardSeries.ts) and the reads stubbed at cardReads.ts: `modes`
 * records each capabilities decision the page starts, `decide` hands a test
 * that decision's later answers, `watches` records each card that asks.
 * Rewritten 2026-09-24: cards used to ask only while 60% in view, so on a
 * laptop four of six never asked until paged to, and none asked twice after
 * two refusals. Now every card with a row asks at once, those in view first.
 */
function carousel({ mode = 'chain', listings, phase = 'ready' }) {
  const cards = require(resolve(root, '.test-build/app/src/lib/read/cardSeries.js'));
  const modes = [], watches = [], decide = [];
  const Card = stub('MarketCard');
  const source = { transport: 'bridge' };
  const { MarketCarousel } = load('src/components/markets/MarketCarousel.tsx', {
    useReadSource: () => source,
    useMarkets: () => ({ state: { phase }, provider: { kind: 'bridge' } }),
    shownResult: () => ({ markets: listings.flatMap((listing) => (listing.market ? [listing.market] : [])) }), poolListings: () => listings,
    MarketCard: Card, IconButton: Container, IconChevronLeft: Container, IconChevronRight: Container,
    cardAsk: cards.cardAsk, inAskOrder: cards.inAskOrder, mergeAnswer: cards.mergeAnswer, pickSeries: cards.pickSeries,
    // The one decision the rail used to make, kept so an older rail still loads here.
    cardMode: async (_source, signal) => (modes.push(signal), mode),
    followCardMode(_source, emit, options) {
      modes.push(options.signal);
      decide.push((next) => { if (!options.signal.aborted) emit(next); });
      void Promise.resolve().then(() => { if (!options.signal.aborted) emit(mode); });
      return new Promise(() => {});
    },
    watchCard(_source, ask, emit, options) { watches.push({ ask, emit, options }); return new Promise(() => {}); },
  });
  const series = (host) => elements(host.tree, (node) => node.type === Card).map((node) => [node.props.listing.poolId, node.props.series]);
  return { MarketCarousel, modes, watches, decide, series };
}
/** A row whose provider orientation names the pool's first currency as its quote, as on the live WETH/USDG pool. */
const cardRow = (letter, extra = {}) => ({ ...row(id(letter)), key: `4663:${id(letter)}`, chartTokens: { base: addr('2'), quote: addr('1') },
  poolState: { currency0: addr('1'), currency1: addr('2') }, ...extra });
const ratio = (hour, close) => ({ startTimestamp: 997_200 - hour * 3600, open: close, high: close, low: close, close, swapCount: 2, complete: true });
const storedHistory = (poolId, extra = {}) => ({ poolId, currency: addr('1'), quoteCurrency: addr('2'), status: 'partial', reason: 'history_acquisition_pending',
  requestedWindow: { startTimestamp: 997_200 - 86_400, endTimestamp: 997_200 }, resolutionSeconds: 3600, snapshot: { number: 700, hash: '0x', timestamp: 997_200 },
  covered: [], gaps: [{ startTimestamp: 997_200 - 86_400, endTimestamp: 997_200 - 7200 }], candles: [ratio(2, '1.5'), ratio(1, '1.6')], ...extra });
const chainAnswer = (ask, data) => ({ source: 'chain', key: ask.key, data, receivedAt: 1_000_000, failure: null, code: null });

test('every carousel card asks at mount, those in view first, with no view gate, and each settles on a line or its 24h figure', async () => {
  const beforeSet = globalThis.__DOMINO_POOL_SET__;
  const beforeCancel = globalThis.cancelAnimationFrame;
  globalThis.__DOMINO_POOL_SET__ = 'selected';
  globalThis.cancelAnimationFrame = () => {};
  const letters = ['a', 'b', 'c', 'd', 'e', 'f'];
  const fixture = carousel({ listings: letters.map((letter) => ({ poolId: id(letter), market: cardRow(letter) })) });
  let host;
  try {
    host = mount(fixture.MarketCarousel, { heading: 'Markets' });
    assert.equal(fixture.modes.length, 1, 'one capabilities decision for the whole rail');
    assert.equal(fixture.watches.length, 0, 'nothing is asked before it is known what to ask');
    assert.deepEqual(fixture.series(host).map(([, series]) => series.kind), letters.map(() => 'waiting'));
    // The observer's visible-set state (hook slot 1): two cards in view, as on a laptop. The harness does not emulate layout.
    host.values[1] = new Set([id('c'), id('d')]);
    await flush(); host.render();
    assert.deepEqual(fixture.watches.map(({ ask }) => ask.poolId), [id('c'), id('d'), id('a'), id('b'), id('e'), id('f')], 'all six at once, in view first, then rail order');
    for (const { ask } of fixture.watches) assert.deepEqual(ask, { key: `chain:${ask.poolId}:${addr('1')}:3600`, poolId: ask.poolId, source: 'chain', currency: addr('1'), side: 'quote' });
    host.render(); host.values[1] = new Set([id('a')]); host.render();
    assert.equal(fixture.watches.length, 6, 'a card already asking, or scrolled to, does not ask again');
    assert.deepEqual(fixture.series(host).map(([, series]) => series.kind), letters.map(() => 'waiting'), 'a baseline only until the first answer');

    const byPool = new Map(fixture.watches.map((watch) => [watch.ask.poolId, watch]));
    byPool.get(id('a')).emit(chainAnswer(byPool.get(id('a')).ask, storedHistory(id('a'))));
    byPool.get(id('b')).emit(chainAnswer(byPool.get(id('b')).ask, storedHistory(id('b'), { status: 'not_built', candles: [], snapshot: null })));
    byPool.get(id('c')).emit({ ...chainAnswer(byPool.get(id('c')).ask, null), failure: 'Unavailable. No response', code: 'unavailable' });
    byPool.get(id('d')).emit(chainAnswer(byPool.get(id('d')).ask, storedHistory(id('d'), { candles: [ratio(1, '1.6')] })));
    for (const letter of ['e', 'f']) byPool.get(id(letter)).emit(chainAnswer(byPool.get(id(letter)).ask, storedHistory(id(letter), { status: 'available', gaps: [] })));
    host.render();
    const settled = new Map(fixture.series(host));
    assert.deepEqual(letters.map((letter) => settled.get(id(letter)).kind), ['line', 'figure', 'figure', 'figure', 'line', 'line'], 'a partial window draws its line; not built, failed or one hour shows the figure');
    for (const [, series] of settled) assert.ok(['line', 'bars', 'figure'].includes(series.kind), 'no settled card is left without something drawn');
    assert.equal(settled.get(id('b')).metric, cardRow('b').volume24hUsd, 'the figure is the row’s own 24h volume');
    assert.deepEqual([settled.get(id('b')).code, settled.get(id('c')).code, settled.get(id('d')).code], ['not_built', 'unavailable', 'few-hours']);

    // A failed refresh keeps the line it had, marked stale in its title.
    byPool.get(id('a')).emit({ ...chainAnswer(byPool.get(id('a')).ask, null), failure: 'Busy. Later', code: 'busy' });
    host.render();
    assert.equal(new Map(fixture.series(host)).get(id('a')).kind, 'line');
    assert.equal(new Map(fixture.series(host)).get(id('a')).stale, true);

    host.unmount(); host = null;
    assert.ok(fixture.watches.every(({ options }) => options.signal.aborted), 'leaving the page cancels every card');
    assert.ok(fixture.modes.every((signal) => signal.aborted));
  } finally {
    host?.unmount();
    globalThis.__DOMINO_POOL_SET__ = beforeSet;
    globalThis.cancelAnimationFrame = beforeCancel;
  }
});

test('where history is not listed the cards ask a provider, rows without its orientation show their figure at once, and a missing row waits only while the table loads', async () => {
  const beforeSet = globalThis.__DOMINO_POOL_SET__;
  const beforeCancel = globalThis.cancelAnimationFrame;
  globalThis.__DOMINO_POOL_SET__ = 'selected';
  globalThis.cancelAnimationFrame = () => {};
  const listings = [{ poolId: id('a'), market: cardRow('a') }, { poolId: id('b'), market: cardRow('b', { chartTokens: undefined }) }, { poolId: id('c') }];
  let host;
  try {
    const loading = carousel({ mode: 'provider', listings, phase: 'loading' });
    host = mount(loading.MarketCarousel, { heading: 'Markets' });
    await flush(); host.render();
    assert.deepEqual(loading.watches.map(({ ask }) => ask), [{ key: `provider:${id('a')}:${addr('1')}:3600`, poolId: id('a'), source: 'provider', currency: addr('1'), side: 'quote' }]);
    assert.deepEqual(loading.series(host).map(([, series]) => [series.kind, series.code]), [['waiting', undefined], ['figure', 'not-asked'], ['waiting', undefined]]);
    loading.watches[0].emit({ source: 'provider', key: loading.watches[0].ask.key, side: 'quote', data: null, receivedAt: 1_000_000, failure: 'Unavailable. No response', code: 'unavailable' });
    host.render();
    assert.equal(loading.series(host)[0][1].kind, 'figure');
    host.unmount(); host = null;

    const refused = carousel({ mode: 'none', listings, phase: 'ready' });
    host = mount(refused.MarketCarousel, { heading: 'Markets' });
    await flush(); host.render();
    assert.equal(refused.watches.length, 0, 'capabilities that failed ask nothing more');
    assert.deepEqual(refused.series(host).map(([, series]) => [series.kind, series.code]), [['figure', 'not-asked'], ['figure', 'not-asked'], ['figure', 'no-figures']]);
  } finally {
    host?.unmount();
    globalThis.__DOMINO_POOL_SET__ = beforeSet;
    globalThis.cancelAnimationFrame = beforeCancel;
  }
});

// Review of 2026-09-24: the rail decided its cards' series once per mount, so a passing failure of the read-v3
// capabilities GET (which comes back as "not listed") kept all six cards on the costlier provider reads for the visit,
// while the table went back to the stored overview at its next refresh.
test('cards on the provider path move to the chain line when the capabilities list history again, and stop their provider reads', async () => {
  const beforeSet = globalThis.__DOMINO_POOL_SET__;
  const beforeCancel = globalThis.cancelAnimationFrame;
  globalThis.__DOMINO_POOL_SET__ = 'selected';
  globalThis.cancelAnimationFrame = () => {};
  const fixture = carousel({ mode: 'provider', listings: [{ poolId: id('a'), market: cardRow('a') }, { poolId: id('b'), market: cardRow('b') }] });
  let host;
  try {
    host = mount(fixture.MarketCarousel, { heading: 'Markets' });
    await flush(); host.render();
    assert.deepEqual(fixture.watches.map(({ ask }) => ask.source), ['provider', 'provider']);
    const [a, b] = fixture.watches;
    a.emit({ source: 'provider', key: a.ask.key, side: 'quote', data: null, receivedAt: 1_000_000, failure: 'Unavailable. No response', code: 'unavailable' });
    host.render();
    assert.equal(fixture.decide.length, 1, 'the page follows one decision for the whole rail');

    // A minute on, the capabilities answer again and list history.
    fixture.decide[0]('chain'); host.render(); host.render();
    assert.ok(a.options.signal.aborted && b.options.signal.aborted, 'the provider reads stop');
    assert.deepEqual(fixture.watches.slice(2).map(({ ask }) => ask.key), [id('a'), id('b')].map((poolId) => `chain:${poolId}:${addr('1')}:3600`), 'and each card asks for its chain line');
    assert.equal(fixture.modes.length, 1, 'no second decision is started for it');
    const moved = new Map(fixture.series(host));
    assert.equal(moved.get(id('a')).code, 'unavailable', 'what the provider gave stays drawn until the chain answers');
    assert.equal(moved.get(id('b')).kind, 'waiting');
    const chainA = fixture.watches[2];
    chainA.emit(chainAnswer(chainA.ask, storedHistory(id('a'), { status: 'available', gaps: [] })));
    host.render();
    assert.equal(new Map(fixture.series(host)).get(id('a')).kind, 'line');

    host.unmount(); host = null;
    assert.ok(fixture.watches.every(({ options }) => options.signal.aborted) && fixture.modes.every((signal) => signal.aborted));
  } finally {
    host?.unmount();
    globalThis.__DOMINO_POOL_SET__ = beforeSet;
    globalThis.cancelAnimationFrame = beforeCancel;
  }
});

test('stored token explorer pages a pinned revision, restarts a changed catalogue, and cancels its visible refresh on exit', async () => {
  const reads = [], waits = [];
  const data = JSON.parse(readFileSync(resolve(root, '../api-contracts/read-v3/fixtures/overview.json'), 'utf8'));
  const token = data.tokens[0].address;
  data.selectedToken = token; data.requestedPoolIds = [];
  data.hasMore = true; data.nextAfterPoolId = data.pools[0].poolId; data.revision = 9;
  const source = { transport: 'bridge' };
  const { StoredTokenExplorer } = load('src/components/read/screens/StoredTokenExplorer.tsx', {
    MarketsContext: { Provider: Container }, overviewRows: () => [row(id('a'))],
    candidateFromToken: (value) => ({ token: { ...value.asset, chainId: 4663 } }),
    readWithin(_source, route, request, options) { const pending = deferred(); reads.push({ route, request, options, ...pending }); return pending.promise; },
    whenVisibleAfter(ms, run) { const wait = { ms, run, cancelled: false }; waits.push(wait); return () => { wait.cancelled = true }; },
  });
  const host = mount(StoredTokenExplorer, { source, token });
  assert.deepEqual(reads[0].request, { token, limit: 24 });
  reads[0].resolve({ state: 'ok', route: 'overview', data, provenance: { receivedAt: 1010_000, receivedMonotonic: 0, attempts: 1 } });
  await flush(); host.render();
  assert.equal(part(host, 'MarketsTable').props.includeCatalogue, false, 'arbitrary-token data is not mixed with the selected six');
  assert.equal(part(host, 'MarketsTable').props.poolToken, token, 'links keep the token needed to verify arbitrary pools');
  // Changed on purpose (2026-09-20): this fixture has nothing pending, and a
  // settled page asked again every five seconds was twelve reads a minute
  // through a one-slot gateway for figures that had already arrived.
  assert.equal(waits[0].ms, 60_000, 'a settled page waits a minute');
  buttonNamed(host, 'More pools').props.onClick(); host.render();
  assert.equal(waits[0].cancelled, true);
  assert.deepEqual(reads[1].request, { token, afterPoolId: data.nextAfterPoolId, revision: 9, limit: 24 });
  reads[1].resolve({ state: 'restart_required', route: 'overview', code: 'catalogue_revision_changed' });
  await flush(); host.render();
  assert.deepEqual(reads[2].request, { token, limit: 24 }, 'changed revision resets paging instead of mixing generations');
  assert.equal(part(host, 'MarketsTable'), undefined, 'the previous page does not become the new page');
  host.unmount();
  assert.equal(reads[2].options.signal.aborted, true);
});

test('workspace requests one lean market read and aborts/discards its result on unmount', async () => {
  const fixture = workspace(); const host = mount(fixture.PoolWorkspace, fixture.props)
  assert.deepEqual(fixture.reads.map(({ route, request }) => ({ route, request })), [{ route: 'pool-market', request: { poolId: id('a'), includePriceHistory: false } }])
  assert.equal(part(host, 'PoolHistoryChart').props.market, null, 'no provider market is passed before its read answers')
  assert.ok(elements(host.tree, (node) => node.type === parts.Skeleton).length > 0, 'figures rest while the read is in flight')
  host.unmount(); const before = host.writes
  assert.equal(fixture.reads[0].options.signal.aborted, true)
  fixture.reads[0].resolve({ state: 'ok', data: { poolId: id('a') } }); await flush()
  assert.equal(host.writes, before)
})

test('the chart receives the answered market without dispatching another market read', async () => {
  const fixture = workspace(); const host = mount(fixture.PoolWorkspace, fixture.props)
  fixture.reads[0].resolve({ state: 'ok', data: { poolId: id('a') } }); await flush(); host.render()
  const chart = part(host, 'PoolHistoryChart')
  assert.ok(chart, 'the chart is on the page')
  assert.equal(chart.props.market.poolId, id('a'))
  assert.equal(chart.props.source, fixture.props.source, 'the wrapper uses the shared capability-aware source')
  assert.equal(fixture.reads.length, 1)
  assert.equal(elements(host.tree, (node) => node.type === parts.Skeleton).length, 0, 'nothing rests once the figures arrived')
  host.unmount()
})

test('with no optional route listed the page reads its market figures only: no activity card, no positions, no 24h fees, and nothing to press', async () => {
  const fixture = workspace({ listed: ['token', 'pools', 'pool-market'] }); const host = mount(fixture.PoolWorkspace, fixture.props)
  assert.deepEqual(fixture.reads, [], 'nothing is read before the page knows which routes are listed')
  await flush(); host.render()
  assert.deepEqual(fixture.checks, ['markets-snapshot', 'pool-metrics', 'pool-activity', 'pool-positions'], 'asked of the capabilities, never as reads')
  assert.deepEqual(fixture.reads.map(({ route, request }) => ({ route, request })), [{ route: 'pool-market', request: lean }], 'the pool’s own lean read, no stored one')
  fixture.reads[0].resolve(ok()); await flush(); host.render()
  assert.equal(fixture.reads.length, 1, 'and nothing after it')
  assert.equal(part(host, 'PoolActivityCard'), undefined)
  assert.equal(part(host, 'PoolPositionsCard'), undefined)
  // Changed on purpose (2026-09-27, round 6): the page shows a typical range to read, not a planner to drag.
  assert.ok(part(host, 'PoolRangeGuide'), 'the typical range is on the page, with no view to switch to')
  assert.equal(part(host, 'PoolRangeGuide').props.guide.low, '0.994018', 'drawn on the price now, in the page’s direction')
  assert.equal(part(host, 'PoolRangeControls'), undefined, 'and no range planner')
  const visible = visibleText(host)
  assert.doesNotMatch(visible, /24h fees/)
  assert.doesNotMatch(visible, /Read activity|Read market data again|Retry|Verify again|Refresh/)
  assert.equal(elements(host.tree, (node) => node.type === Container && typeof node.props.onClick === 'function').length, 0, 'no button of the page’s own')
  assert.deepEqual(dashes(host), ['Unavailable: reconciled_fee_history_unavailable'], 'Domino’s APR, unread, is a dash that says why in its title')
  host.unmount()
})

test('with every optional route listed: the stored snapshot paints first, the pool’s own read follows, then its history, activity and positions, one at a time, each once', async () => {
  const fixture = workspace({ listed: ['markets-snapshot', 'pool-metrics', 'pool-activity', 'pool-positions'] }); const host = mount(fixture.PoolWorkspace, fixture.props)
  await flush(); host.render()
  assert.deepEqual(fixture.reads.map(({ route, request }) => ({ route, request })), [{ route: 'pool-market', request: { ...lean, fromSnapshot: true } }])
  assert.ok(part(host, 'PoolActivityCard'), 'the activity card is on the page as soon as its route is known to be listed')
  assert.equal(part(host, 'PoolActivityCard').props.read, null, 'resting until its read answers')
  assert.match(visibleText(host), /24h fees/)
  fixture.reads[0].resolve(ok({ estimateReason: 'estimate_not_in_snapshot', data: { poolId: id('a'), market: { status: 'available', reason: null, cache: { ageSeconds: 0 } } } })); await flush(); host.render()
  assert.ok(part(host, 'PoolHistoryChart').props.market, 'the stored figures are available to the chart')
  assert.deepEqual(fixture.reads.map(({ route, request }) => [route, request]), [
    ['pool-market', { ...lean, fromSnapshot: true }],
    ['pool-market', lean],
    ['pool-metrics', { poolId: id('a') }],
    ['pool-activity', { poolId: id('a') }],
    ['pool-positions', { poolId: id('a') }],
  ], 'the pool’s own read queues first, so it answers first; the history reads follow it')
  const activity = { state: 'unavailable', cause: { kind: 'producer', code: 'activity_pool_not_registered', status: 503 }, retryable: false }
  fixture.reads[3].resolve(activity); await flush(); host.render()
  assert.equal(part(host, 'PoolActivityCard').props.read, activity, 'the card is handed the answer, whatever it is')
  assert.deepEqual(fixture.asks.map(({ outcome, attempt }) => [outcome.cause.code, attempt]), [['activity_pool_not_registered', 0]], 'the page asks whether it may ask again; a final answer never gets a yes')
  host.unmount()
  for (const read of fixture.reads.slice(1)) assert.equal(read.options.signal.aborted, true, `${read.route} is cancelled with the page`)
})

// Added 2026-09-28 (speed wave, item 44): the copy's figures stand at once, and the chain reads start without waiting
// for the page's own overview; the page's own answer replaces them.
test('a painted pool shows the copy’s figures at once, starts its chain reads, and its own overview replaces them', async () => {
  const fixture = workspace({ listed: ['overview', 'pool-activity'], dependencies: { storedPoolRead: (entry) => ok({ data: { poolId: entry.poolId, painted: true } }), overviewPoolOption: () => null, whenVisibleAfter: () => () => {} } })
  fixture.props.source.supportsStoredReads = true
  const painted = { route: 'overview', state: 'ok', data: { generatedAt: 0, pools: [{ poolId: id('a') }], tokens: [] }, provenance: { receivedAt: 1 } }
  const host = mount(fixture.PoolWorkspace, { ...fixture.props, painted })
  const figures = () => host.tree.props.children.find?.((child) => child?.props?.['data-pool-figures'] === '')?.props
  assert.equal(figures()['data-market-read'], 'loading', 'resting while the page learns which routes are listed')
  await flush(); host.render()
  assert.equal(figures()['data-market-read'], 'overview', 'the copy’s figures, before any read')
  await flush(); host.render()
  assert.deepEqual(fixture.reads.map(({ route }) => route).sort(), ['overview', 'pool-activity'], 'the chain read goes beside the page’s own overview')
  fixture.reads.find(({ route }) => route === 'overview').resolve(ok({ data: { generatedAt: 0, pools: [{ poolId: id('a'), acquisition: { status: 'ready' } }], tokens: [], acquisitionAccepted: true } })); await flush(); host.render()
  assert.equal(figures()['data-market-read'], 'overview')
  host.unmount()
})

test('G10: a store that holds nothing for the pool shows nothing, and the pool’s own lean read follows as a read of its own through the queue', async () => {
  const fixture = workspace({ listed: ['markets-snapshot'] }); const host = mount(fixture.PoolWorkspace, fixture.props)
  await flush(); host.render()
  const notBuilt = { state: 'unavailable', cause: { kind: 'producer', code: 'snapshot_not_built', status: 503 }, retryable: false }
  fixture.reads[0].resolve(notBuilt); await flush(); host.render()
  assert.deepEqual(fixture.reads.map(({ request }) => request), [{ ...lean, fromSnapshot: true }, lean], 'the stored read, then the pool’s own, each asked of the paced queue')
  const figures = () => host.tree.props.children.find?.((child) => child?.props?.['data-pool-figures'] === '')?.props
  assert.equal(figures()['data-market-read'], 'loading', 'the figures still rest: an unbuilt store is not a failure on the page')
  assert.deepEqual(dashes(host).filter((title) => title !== 'Unavailable: reconciled_fee_history_unavailable'), [], 'and no dash says the store had nothing')
  assert.deepEqual(fixture.asks, [], 'nor is the stored read asked again')
  fixture.reads[1].resolve(ok()); await flush(); host.render()
  assert.equal(figures()['data-market-read'], 'read')
  host.unmount()
})

test('G10: until the pool’s own read lands, stored provider figures carry an unknown retrieval age and are stale in their title, never “retrieved 0 s ago”', async () => {
  const project = real('src/lib/read/project.ts')
  const markets = real('src/lib/markets.ts')
  const projection = { projectMarketRow: project.projectMarketRow, agedMarket: markets.agedMarket, retrievedAgeSeconds: markets.retrievedAgeSeconds, retrievedText: markets.retrievedText }
  const fixture = workspace({ listed: ['markets-snapshot'], dependencies: projection })
  const host = mount(fixture.PoolWorkspace, fixture.props)
  await flush(); host.render()
  // Received now on the page's clock (the useNow stub), so only the payload's own ages count.
  const arrived = (extra) => ({ ...okRead('pool-market', 'pool-market.success'), provenance: { transport: 'bridge', contract: null, receivedAt: 1_001_000, receivedMonotonic: 0, attempts: 1 }, ...extra })
  // The package fixture's market: available, cache age 0 when it was stored. Nothing in a stored answer says how long the store has held it.
  fixture.reads[0].resolve(arrived({ estimateReason: 'estimate_not_in_snapshot' })); await flush(); host.render()
  const cells = (tree) => elements(tree, (node) => node.type === parts.MetricCell).map((node) => [node.props.metric.state, node.props.retrieved])
  assert.deepEqual(cells(host.tree), [['stale', 'retrieval time unknown'], ['stale', 'retrieval time unknown']], 'TVL and 24h volume: stale, age unknown')
  const shown = visibleText(host)
  assert.doesNotMatch(shown, /retrieved 0 s ago/)
  // Changed on purpose (2026-09-27, round 6): who reported the figures is a row of Details, "Market data provider, <age>".
  assert.match(shown, /Market data provider, retrieval time unknown/)
  // The provider line is a stat's `sub`, so it is read from the markup.
  const provenance = (tree) => /data-market-provenance="" title="([^"]*)"/.exec(renderToStaticMarkup(tree))?.[1]
  assert.match(provenance(host.tree), /^Provider market observation, as the read service stored it: stale, retrieval time unknown;/)
  assert.equal(elements(host.tree, (node) => node.type === parts.TurnoverCell)[0].props.retrieved, 'retrieval time unknown')

  // The pool's own read lands: its figures, dated as it reports them.
  fixture.reads[1].resolve(arrived()); await flush(); host.render()
  assert.deepEqual(cells(host.tree), [['provider', 'retrieved 0 s ago'], ['provider', 'retrieved 0 s ago']])
  assert.doesNotMatch(provenance(host.tree), /stored/)
  host.unmount()

  // A lean read that fails keeps the stored figures on screen, still with no known age.
  const failing = workspace({ listed: ['markets-snapshot'], dependencies: projection })
  const page = mount(failing.PoolWorkspace, failing.props)
  await flush(); page.render()
  failing.reads[0].resolve(arrived({ estimateReason: 'estimate_not_in_snapshot' })); await flush(); page.render()
  failing.reads[1].resolve(unavailable); await flush(); page.render()
  assert.deepEqual(cells(page.tree), [['stale', 'retrieval time unknown'], ['stale', 'retrieval time unknown']])
  page.unmount()
})

test('a failed market read shows dashes with the reason in their titles, no panel and no retry control; asked again quietly, its answer replaces them', async () => {
  const fixture = workspace(); const host = mount(fixture.PoolWorkspace, fixture.props)
  fixture.reads[0].resolve(unavailable); await flush(); host.render()
  assert.equal(elements(host.tree, (node) => node.type === parts.Skeleton).length, 0, 'a failed read never leaves a resting block in place of a figure')
  assert.doesNotMatch(renderToStaticMarkup(host.tree), /data-screen-status|dm-inset/, 'no status panel')
  assert.ok(dashes(host).includes('Unavailable. No response'), 'the reason is the dashes’ title')
  const onPage = renderToStaticMarkup(host.tree).replace(/<p role="status"[^>]*>.*?<\/p>/gs, '').replace(/<span class="sr-only"[^>]*>.*?<\/span>/gs, '').replace(/<[^>]+>/g, '')
  assert.doesNotMatch(onPage, /Unavailable|No response|Retry|\bagain\b/, 'and never words on the page: only the polite live region says it')
  assert.match(renderToStaticMarkup(host.tree), /<p role="status" aria-live="polite" class="sr-only"[^>]*>Unavailable\. No response<\/p>/)
  // Changed on purpose (qa:visual): the chart card has no caption under its heading; who reports the candles is the plot's title and data.
  // Ours is the stricter guard: the chart component replaced the inline markup,
  // and no provider wording of any kind may reach the page.
  assert.doesNotMatch(onPage, /Hourly candles|GeckoTerminal|DexScreener|market data provider/i, 'no caption under the chart heading')
  assert.equal(part(host, 'PoolHistoryChart').props.failed, 'Unavailable. No response')
  assert.equal(part(host, 'PoolHistoryChart').props.loading, false)
  assert.deepEqual(fixture.asks.map(({ outcome, attempt }) => [outcome.state, attempt]), [['unavailable', 0]])
  fixture.asks[0].resolve(true); await flush(); host.render()
  assert.deepEqual(fixture.reads.map(({ request }) => request), [lean, lean], 'one more lean read, on its own')
  fixture.reads[1].resolve(ok()); await flush(); host.render()
  assert.ok(part(host, 'PoolHistoryChart').props.market)
  assert.deepEqual(dashes(host).filter((title) => title === 'Unavailable. No response'), [], 'the figures replace the dashes')
  host.unmount()
})

test('G1: with pool-metrics listed, a 24h fees stat from Domino’s history, and Domino’s APR wherever it qualifies', async () => {
  const qualified = { value: '158.06', state: 'qualified' }
  const projectMarketRow = ({ market, metrics }) => ({
    ...row(market.data.poolId),
    feeAprPercent: metrics?.state === 'ok' ? qualified : { value: null, state: 'unavailable', reason: metrics ? metrics.state : 'fee_apr_not_provided' },
    lpFees24hUsd: metrics?.state === 'ok' ? { value: '0.01', state: 'qualified' } : { value: null, state: 'unavailable', reason: 'pool_metrics_not_requested' },
  })
  const fixture = workspace({ listed: ['pool-metrics'], dependencies: { projectMarketRow } }); const host = mount(fixture.PoolWorkspace, fixture.props)
  await flush(); host.render()
  fixture.reads[0].resolve(ok()); await flush(); host.render()
  assert.deepEqual(fixture.reads.map(({ route }) => route), ['pool-market', 'pool-metrics'])
  assert.ok(elements(host.tree, (node) => node.type === parts.Skeleton).length > 0, '24h fees and Domino’s APR rest while their read runs')
  // Changed on purpose (2026-09-27, round 6): the stat is labelled APR either way; which figure it holds is the check.
  const estimates = (tree) => elements(tree, (node) => node.type === parts.PoolAprEstimate && node.props.compact === true).length
  assert.equal(estimates(host.tree), 1, 'the estimate stands until then')
  fixture.reads[1].resolve({ state: 'ok', data: { poolId: id('a') } }); await flush(); host.render()
  const visible = visibleText(host)
  assert.match(visible, /24h fees/)
  assert.match(visible, /APR/)
  assert.equal(estimates(host.tree), 0, 'a qualified APR takes the estimate’s place, as it does in the table')
  assert.match(visible, /Domino history/)
  const metricCells = elements(host.tree, (node) => node.type === parts.MetricCell).map((node) => [node.props.metric.state, node.props.percent === true])
  assert.deepEqual(metricCells.filter(([state]) => state === 'qualified'), [['qualified', true], ['qualified', false]], 'the APR first, then the 24h fees, both Domino’s')
  assert.match(visible, /Pool APR, Domino history158\.06%/, 'the history APR row has the figure instead of a fixed “unavailable”')
  host.unmount()

  // A failed metrics read keeps the provider’s figures; its reason is the dashes’ title.
  const failing = workspace({ listed: ['pool-metrics'], dependencies: { projectMarketRow } }); const page = mount(failing.PoolWorkspace, failing.props)
  await flush(); page.render()
  failing.reads[0].resolve(ok()); await flush(); page.render()
  failing.reads[1].resolve(unavailable); await flush(); page.render()
  assert.deepEqual(dashes(page), ['Unavailable. No response', 'Unavailable. No response'], 'the 24h fees and the history APR say why')
  assert.equal(estimates(page.tree), 1)
  page.unmount()
})

test('G14: the protocol fee is in the pool details, per direction, from the verified pool', async () => {
  const fixture = workspace({ option: { ...option('a'), protocolFeeRaw: 820200 } }); const host = mount(fixture.PoolWorkspace, fixture.props)
  fixture.reads[0].resolve(ok()); await flush(); host.render()
  const row = elements(host.tree, (node) => node.props?.['data-protocol-fee'] !== undefined)[0]
  assert.equal(row.props['data-protocol-fee'], 'directional')
  const text = renderToStaticMarkup(row).replace(/<[^>]+>/g, '')
  assert.match(text, /^Protocol fee0\.10% selling {2}· 0\.02% selling $/, 'each rate beside the token a swap sells (symbols are stubbed out here)')
  assert.match(row.props.children[1].props.title, /Packed value 820200, read at block 700/)
  host.unmount()
  const none = workspace({ option: { ...option('a'), protocolFeeRaw: 0 } }); const quiet = mount(none.PoolWorkspace, none.props)
  assert.match(renderToStaticMarkup(elements(quiet.tree, (node) => node.props?.['data-protocol-fee'] !== undefined)[0]), /None/)
  quiet.unmount()
  const unread = workspace(); const bare = mount(unread.PoolWorkspace, unread.props)
  assert.equal(elements(bare.tree, (node) => node.props?.['data-protocol-fee'] !== undefined).length, 0, 'no row without the figure')
  bare.unmount()
})

test('provider attribution is visible text rather than a hover-only title, and the pool id is beside a copy control', async () => {
  const fixture = workspace(); const host = mount(fixture.PoolWorkspace, fixture.props)
  fixture.reads[0].resolve({ state: 'ok', data: { poolId: id('a') } }); await flush(); host.render()
  const visible = renderToStaticMarkup(host.tree).replace(/<[^>]+>/g, '')
  assert.match(visible, /Market data provider/, 'the figures are attributed in visible text, the provider never named')
  assert.doesNotMatch(visible, /GeckoTerminal|DexScreener/)
  assert.match(visible, /retrieved 12 s ago/)
  // Changed on purpose 2026-10-01 (audit I1): the row says the pool was read on chain, never that its tokens are verified.
  assert.match(visible, /On chain at block 700/)
  assert.doesNotMatch(visible, /Verified at block/)
  // Changed on purpose (2026-09-27, round 6): the full pool id is a row of Details, drawn by Address (a stub here).
  assert.ok(elements(host.tree, (node) => node.type === parts.Address && node.props.value === id('a') && !node.props.short).length === 1, 'the full pool id is in the page')
  assert.equal(part(host, 'CopyButton').props.value, id('a'))
  assert.doesNotMatch(visible, /Deposits are not/, 'no page-wide deposit banner: the way onward is the caller’s action')
  host.unmount()
})

// --- the pool page: which token verifies which pool, and a late answer never lands ---

function poolPage(hash, dependencies = {}) {
  const verifications = []
  const listeners = new Map()
  globalThis.window = {
    location: { hash, replace(next) { globalThis.window.location.hash = next } },
    addEventListener(type, fn) { listeners.set(type, fn) }, removeEventListener(type) { listeners.delete(type) },
  }
  const source = { transport: 'bridge' }
  const { PoolDetail } = load('src/screens/PoolDetail.tsx', {
    useReadSource: () => source,
    useHash: () => globalThis.window.location.hash,
    parsePoolHash: (value) => { const [, , poolId = '', third = ''] = value.replace(/^#/, '').split('/'); return { poolId: /^0x[0-9a-f]{64}$/i.test(poolId) ? poolId.toLowerCase() : null, token: /^0x[0-9a-f]{40}$/i.test(third) ? third : null } },
    exploreHref: () => '#/markets', newPositionHref: (poolId) => `#/new/${poolId}`,
    verifyCandidate(_source, tokenKey, paired, poolId, options) { const pending = deferred(); verifications.push({ tokenKey, paired, poolId, signal: options.signal, ...pending }); return pending.promise },
    // 2026-09-24: the page offers New position only for a pool Domino can open a position in (the real test).
    optionUsableForDomino: real('src/lib/read/screens/poolsList.ts').optionUsableForDomino,
    // 2026-09-28 (speed wave, item 44): no copy of the last overview in this browser, unless a test says so.
    appPaint: null, paintedPool: () => null,
    ...dependencies,
  })
  return { PoolDetail, verifications }
}

test('one of the six is verified against the token they all hold, then gets its workspace and a way into the new-position flow', async () => {
  const previous = globalThis.window
  const { PoolDetail, verifications } = poolPage(`#/pool/${id('a')}`)
  const host = mount(PoolDetail, { poolId: id('a') })
  try {
    assert.deepEqual(verifications.map(({ tokenKey, paired, poolId }) => ({ tokenKey, paired, poolId })), [{ tokenKey: addr('5'), paired: null, poolId: id('a') }])
    // Pending is the page's own resting header: it carries the catalogue entry, so the six are named while verified.
    const pending = elements(host.tree, (node) => node.type?.name === 'Pending')[0]
    assert.equal(pending?.props.entry?.poolId, id('a'), 'the catalogue names the pool while it is verified')
    assert.equal(part(host, 'PoolWorkspace'), undefined, 'nothing from a label alone')
    verifications[0].resolve({ failure: null, option: option('a'), restarted: false }); await flush(); host.render()
    const workspace = part(host, 'PoolWorkspace')
    assert.equal(workspace.props.option.key, id('a'))
    // Changed on purpose (2026-09-28, round 6 review): no range is handed over; the workspace draws it on the price now.
    assert.equal('range' in workspace.props, false, 'the typical range is the workspace’s own, on the price now')
    // The way onward is handed to the workspace as its `actions`: a route into the new-position flow for this pool, and nothing that deposits.
    const onward = elements(workspace.props.actions, (node) => node.type === parts.LinkButton)
    assert.deepEqual(onward.map((node) => node.props.href), [`#/new/${id('a')}`])
  } finally { host.unmount(); globalThis.window = previous }
})

// Added 2026-09-24 (owner): Domino's setup contract refuses a pool with hooks or a dynamic fee, and New position
// never lists one, so a page for such a pool offers no way there. The page itself is unchanged.
test('a pool with hooks or a dynamic fee gets its page, and no New position', async () => {
  const previous = globalThis.window
  try {
    for (const refused of [{ hooks: addr('a'), integration: 'requires_separate_adapter' }, { hooks: addr('a'), feePips: 8388608, fee: 'Dynamic', integration: 'requires_separate_adapter' }]) {
      const { PoolDetail, verifications } = poolPage(`#/pool/${id('a')}`)
      const host = mount(PoolDetail, { poolId: id('a') })
      verifications[0].resolve({ failure: null, option: { ...option('a'), ...refused }, restarted: false }); await flush(); host.render()
      const workspace = part(host, 'PoolWorkspace')
      assert.equal(workspace.props.option.key, id('a'), 'the pool still has its page')
      assert.equal(workspace.props.actions, undefined, 'and no way into New position')
      host.unmount()
    }
  } finally { globalThis.window = previous }
})

test('a pool outside the six is verified with the token its link names, and is not read at all without one', async () => {
  const previous = globalThis.window
  try {
    const withToken = poolPage(`#/pool/${id('b')}/${addr('7')}`)
    const host = mount(withToken.PoolDetail, { poolId: id('b') })
    assert.deepEqual(withToken.verifications.map(({ tokenKey, poolId }) => ({ tokenKey, poolId })), [{ tokenKey: addr('7'), poolId: id('b') }])
    withToken.verifications[0].resolve({ failure: null, option: null, restarted: false }); await flush(); host.render()
    assert.equal(part(host, 'PoolWorkspace'), undefined)
    const empty = part(host, 'EmptyState')
    assert.match(empty.props.title, /could not be verified/)
    assert.deepEqual(elements(empty.props.action, (node) => node.type === parts.LinkButton).map((node) => node.props.href), ['#/markets'], 'the way back to Markets, and no Verify again')
    assert.equal(elements(empty.props.action, (node) => node.type === Container).length, 0)
    host.unmount()

    const alone = poolPage(`#/pool/${id('b')}`)
    const bare = mount(alone.PoolDetail, { poolId: id('b') })
    assert.deepEqual(alone.verifications, [], 'no token to bind a read to: no read')
    assert.equal(part(bare, 'EmptyState').props.title, 'Open this pool from Markets')
    bare.unmount()

    const junk = poolPage('#/pool/not-a-pool')
    const bad = mount(junk.PoolDetail, { poolId: 'not-a-pool' })
    assert.deepEqual(junk.verifications, [])
    assert.match(part(bad, 'EmptyState').props.title, /isn’t a pool id/)
    bad.unmount()
  } finally { globalThis.window = previous }
})

test('a verification with no answer leaves the page’s dashes, the reason in their title and the live region, no panel and no Verify again; a busy one is asked again on its own', async () => {
  const previous = globalThis.window
  const asks = []
  const { PoolDetail, verifications } = poolPage(`#/pool/${id('a')}`, {
    askAgainLater(outcome, attempt, signal) { const pending = deferred(); asks.push({ outcome, attempt, signal, ...pending }); return pending.promise },
  })
  const host = mount(PoolDetail, { poolId: id('a') })
  try {
    const busy = { state: 'busy', retryAfterSeconds: 7 }
    verifications[0].resolve({ failure: busy, option: null, restarted: false }); await flush(); host.render()
    const pending = elements(host.tree, (node) => node.type?.name === 'Pending')[0]
    assert.equal(pending.props.verifying, false)
    assert.deepEqual(pending.props.reason, { code: 'offline', text: 'Unavailable. No response' }, 'the words go to the title and the live region')
    assert.doesNotMatch(renderToStaticMarkup(host.tree), /data-screen-status|dm-inset/, 'no status panel')
    assert.equal(elements(host.tree, (node) => node.type === Container).length, 0, 'nothing to press')
    const markup = renderToStaticMarkup(host.tree)
    assert.match(markup, /data-pool-verification="offline" title="Unavailable\. No response"/)
    assert.doesNotMatch(markup.replace(/<span role="status" class="sr-only">.*?<\/span>/g, '').replace(/<[^>]+>/g, ''), /Unavailable|No response|\bagain\b/)
    // Changed on purpose (qa:visual): no caption under the chart heading; who reports the candles is the plot's title and data, and the dash keeps the reason.
    assert.doesNotMatch(markup.replace(/<[^>]+>/g, ''), /Hourly candles|GeckoTerminal|market data provider/i, 'no caption under the chart heading')
    // Changed on purpose (2026-09-27, round 6): the resting chart's title says where its prices come from in plain words.
    assert.match(markup, /<div class="dm-pool-plot dm-dots-chart mt-4" title="Prices from swaps on Robinhood Chain\."><div class="dm-pool-plot-empty"><span class="text-fg-subtle" title="Unavailable\. No response">—<\/span>/)
    assert.deepEqual(asks.map(({ outcome, attempt }) => [outcome.state, attempt]), [['busy', 0]])
    assert.equal(verifications.length, 1)
    asks[0].resolve(true); await flush(); host.render()
    assert.equal(verifications.length, 2, 'asked again, once')
    verifications[1].resolve({ failure: null, option: option('a'), restarted: false }); await flush(); host.render()
    assert.equal(part(host, 'PoolWorkspace').props.option.key, id('a'))
  } finally { host.unmount(); globalThis.window = previous }
})

// Added 2026-09-28 (speed wave, items 3 and 12): read-v1's capabilities (the page's chain reads) are asked beside
// read-v3's, not after the pool is verified; and a read-v3 check still failing in passing after publicSource.ts asked
// it again is a failure now, not the older path, so the page asks it again on its own, as it does a verification.
test('the pool page asks read-v1’s capabilities beside read-v3’s, and a check that failed in passing is asked again on its own', async () => {
  const previous = globalThis.window
  const checks = []
  const asks = []
  const reads = []
  const answers = [{ state: 'failed', outcome: { state: 'unavailable', cause: { kind: 'edge', status: 502 }, retryable: false } }, { state: 'enabled' }]
  const source = { transport: 'bridge', supportsStoredReads: true, routeEnabled: async (route) => (checks.push(route), route === 'overview' ? answers.shift() : { state: 'enabled' }) }
  const { PoolDetail } = poolPage(`#/pool/${id('a')}`, {
    useReadSource: () => source,
    readWithin(_source, route, request) { const pending = deferred(); reads.push({ route, request, ...pending }); return pending.promise },
    askAgainLater(outcome, attempt, signal) { const pending = deferred(); asks.push({ outcome, attempt, signal, ...pending }); return pending.promise },
  })
  const host = mount(PoolDetail, { poolId: id('a') })
  try {
    await flush(); host.render()
    assert.deepEqual(checks, ['pool-activity', 'overview'], 'read-v1’s capabilities beside read-v3’s')
    assert.equal(elements(host.tree, (node) => node.type?.name === 'Pending')[0].props.verifying, false, 'the failure is shown as the page’s dashes')
    assert.deepEqual(asks.map(({ outcome, attempt }) => [outcome.state, attempt]), [['unavailable', 0]], 'asked again on its own')
    asks[0].resolve(true); await flush(); host.render(); await flush()
    assert.deepEqual(checks.slice(2), ['pool-activity', 'overview'])
    assert.deepEqual(reads.map(({ route, request }) => [route, request]), [['overview', { poolIds: [id('a')] }]], 'the overview, never the older verification')
  } finally { host.unmount(); globalThis.window = previous }
})

// Added 2026-09-28 (speed wave, item 44, the owner's OK): a pool this browser's copy of the last overview names is painted
// from it at once, every figure as old as it is, while its own verification is on its way; the answer replaces it.
test('a pool the copy names is painted from it at once, and its own verification replaces it', async () => {
  const previous = globalThis.window
  const copied = { route: 'overview', state: 'ok', data: { pools: [] }, provenance: { receivedAt: 1 } }
  const painted = []
  const { PoolDetail, verifications } = poolPage(`#/pool/${id('a')}`, {
    appPaint: { load: () => null },
    paintedPool: (memory, poolId, tokenKey) => (painted.push([poolId, tokenKey]), { overview: copied, option: { ...option('a'), block: 600 } }),
  })
  const host = mount(PoolDetail, { poolId: id('a') })
  try {
    assert.deepEqual(painted, [[id('a'), addr('5')]], 'the copy asked for the pool and the token it is verified against')
    const early = part(host, 'PoolWorkspace')
    assert.equal(early.props.option.block, 600, 'the copy’s pool, at once')
    assert.equal(early.props.painted, copied, 'and its figures')
    assert.equal(verifications.length, 1, 'its own verification still goes')
    verifications[0].resolve({ failure: null, option: option('a'), restarted: false }); await flush(); host.render()
    assert.equal(part(host, 'PoolWorkspace').props.option.block, 700, 'the answer replaces it')
  } finally { host.unmount(); globalThis.window = previous }
})

test('a late verification cannot land on a page that moved to another pool', async () => {
  const previous = globalThis.window
  const { PoolDetail, verifications } = poolPage(`#/pool/${id('a')}`)
  const host = mount(PoolDetail, { poolId: id('a') })
  try {
    globalThis.window.location.hash = `#/pool/${id('b')}/${addr('7')}`
    host.props = { poolId: id('b') }; host.render()
    assert.equal(verifications.length, 2)
    assert.equal(verifications[0].signal.aborted, true, 'leaving a pool cancels its verification')
    const writes = host.writes
    verifications[0].resolve({ failure: null, option: option('a'), restarted: false }); await flush(); host.render()
    assert.equal(host.writes, writes, 'the cancelled answer changed nothing')
    assert.equal(part(host, 'PoolWorkspace'), undefined)
    verifications[1].resolve({ failure: null, option: option('b'), restarted: false }); await flush(); host.render()
    assert.equal(part(host, 'PoolWorkspace').props.option.key, id('b'))
  } finally { host.unmount(); globalThis.window = previous }
})

test('the quiet re-asks one pool spent are its own: the next pool, and the same pool opened again, start from none', async () => {
  const previous = globalThis.window
  const asks = []
  const { PoolDetail, verifications } = poolPage(`#/pool/${id('a')}`, {
    askAgainLater(outcome, attempt, signal) { const pending = deferred(); asks.push({ outcome, attempt, signal, ...pending }); return pending.promise },
  })
  const busy = { state: 'busy', retryAfterSeconds: 7 }
  const host = mount(PoolDetail, { poolId: id('a') })
  const go = (hash, poolId) => { globalThis.window.location.hash = hash; host.props = { poolId }; host.render() }
  try {
    // Pool a: busy three times, so its fourth wait would be its last.
    for (let n = 0; n < 3; n += 1) {
      verifications.at(-1).resolve({ failure: busy, option: null, restarted: false }); await flush(); host.render()
      asks.at(-1).resolve(true); await flush(); host.render()
    }
    verifications.at(-1).resolve({ failure: busy, option: null, restarted: false }); await flush(); host.render()
    assert.deepEqual(asks.map(({ attempt }) => attempt), [0, 1, 2, 3], 'pool a spent its re-asks one by one')
    // Pool b, while pool a's last wait is still pending: its own count starts at none.
    go(`#/pool/${id('b')}/${addr('7')}`, id('b'))
    assert.equal(asks.at(-1).signal.aborted, true, 'leaving pool a ends its wait')
    assert.equal(verifications.at(-1).poolId, id('b'))
    verifications.at(-1).resolve({ failure: busy, option: null, restarted: false }); await flush(); host.render()
    assert.equal(asks.at(-1).attempt, 0, 'pool b is asked again from its first wait, not from where pool a left off')
    // Back to pool a: a new visit, so a new count.
    go(`#/pool/${id('a')}`, id('a'))
    assert.equal(verifications.at(-1).poolId, id('a'))
    verifications.at(-1).resolve({ failure: busy, option: null, restarted: false }); await flush(); host.render()
    assert.equal(asks.at(-1).attempt, 0, 'coming back to pool a starts from none too')
  } finally { host.unmount(); globalThis.window = previous }
})

// --- the pool page's chain cards and the estimate, rendered for real ---

// Unlike load() above, every import here is the real module: the cards are
// plain presentational components over validated payloads, so what they
// draw is checked as markup, from the package fixtures.
const realCache = new Map()
function real(relative, expose = '') {
  const file = resolve(root, relative)
  const key = `${file}:${expose}`
  if (realCache.has(key)) return realCache.get(key).exports
  const mod = { exports: {} }; realCache.set(key, mod)
  const code = ts.transpileModule(readFileSync(file, 'utf8') + (expose ? `\nexport { ${expose} };` : ''), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText
  const local = (name) => {
    if (!name.startsWith('.')) return createRequire(file)(name)
    const path = resolve(dirname(file), name)
    const typed = ['.ts', '.tsx', '/index.ts', '/index.tsx'].map((suffix) => path + suffix).find(existsSync)
    return typed ? real(typed) : createRequire(file)(name)
  }
  new Function('require', 'module', 'exports', code)(local, mod, mod.exports)
  return mod.exports
}
const gatewayFixture = (name) => JSON.parse(readFileSync(resolve(root, `../api-contracts/read-v1/fixtures/gateway/${name}.json`), 'utf8'))
const readToken = (address, symbol, decimals) => ({ origin: 'read', chainId: 4663, address, symbol, decimals, readStatus: 'available', artwork: null })
const NATIVE = addr('0')
const TOKEN_1 = addr('1')
/** The fixture pool as the pools read gives it: native ETH (18 decimals) and TOKEN (6). */
const fixturePool = (decimals = [18, 6]) => ({ ...option('a'), currencies: [readToken(NATIVE, 'ETH', decimals[0]), readToken(TOKEN_1, 'TOKEN', decimals[1])] })
const okRead = (route, name, mutate = (body) => body) => ({ route, state: 'ok', data: runtime.assertResponse(route, mutate(gatewayFixture(name))), provenance: { transport: 'fixture', contract: null, receivedAt: 0, attempts: 1 } })
const markupText = (html) => html.replace(/<p role="status" class="sr-only">.*?<\/p>/gs, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
const rowCells = (html, row) => [...new RegExp(`<tr data-activity-row="${row}">(.*?)</tr>`, 's').exec(html)[1].matchAll(/<td>(.*?)<\/td>/gs)].map(([, cell]) => cell)

/**
 * A pool the activity index does not hold yet is served from a live window:
 * the read is bounded by a block count, and blocks on this chain are far
 * shorter than a second, so the range reaches back hours. Derived from the
 * stored fixture and proved against the contract runtime, because the
 * producer package ships no live_window_only fixture yet.
 */
const liveWindowActivity = (body) => {
  const covered = 7500
  const through = body.snapshot.timestamp
  const lower = through - covered
  return {
    ...body,
    mode: 'live_window_only',
    revision: null,
    storedEventCount: 0,
    coverage: {
      startBlock: body.coverage.startBlock,
      indexedThrough: null,
      initializedBlock: body.coverage.initializedBlock,
      initializedAt: body.coverage.initializedAt,
      scope: 'live_window_only',
      canonicality: 'block_hash_rechecked',
      rpcCompleteness: 'single_provider_assumption',
      windowStartBlock: body.snapshot.number - 600,
      windowStartTimestamp: lower,
    },
    window24h: {
      ...body.window24h,
      requestedSeconds: covered,
      fromTimestampExclusive: lower,
      throughTimestamp: through,
      observedSinceTimestamp: Math.max(body.coverage.initializedAt, lower),
      observedSeconds: Math.min(covered, through - body.coverage.initializedAt),
      completeWindow: true,
      status: 'covered_as_of',
      usableAsCurrent24h: false,
    },
    liquidity: {
      status: 'live_state_only',
      activeLiquidityRaw: body.liquidity.activeLiquidityRaw,
      rangeCount: null,
      isTvl: false,
      tvlUsd: null,
      tvlReason: 'pool_activity_not_indexed',
      positionAccounting: gatewayFixture('pool-activity.unavailable').liquidity.positionAccounting,
    },
  }
}

test('a live window says the span it actually covered and never calls it a day (#177)', () => {
  const { PoolActivityCard } = real('src/components/read/screens/PoolActivityCard.tsx')
  const html = renderToStaticMarkup(
    React.createElement(PoolActivityCard, { read: okRead('pool-activity', 'pool-activity.success', liveWindowActivity), option: fixturePool() }),
  )
  const text = markupText(html)
  assert.match(text, /Swaps \(2 h 5 min\) 4/, 'the count is labelled with the span it came from')
  assert.match(text, /Window 2 h 5 min covered/)
  assert.match(text, /Pool age Older than 2 h 5 min/)
  assert.match(text, /Turnover \(2 h 5 min\)/)
  assert.match(text, /LP fees \(2 h 5 min\)/)
  assert.match(text, /Blocks covered 100 to 700/, 'the window start, not the pool\u2019s initialize')
  assert.match(html, /data-activity-live=""/)
  assert.match(text, /not in the activity index yet/)
  // Only the note may say "24 hours", and only to deny it: no figure claims a day the read never saw.
  assert.doesNotMatch(markupText(html.replace(/<p class="dm-note mt-3" data-activity-live="">.*?<\/p>/s, '')), /24 ?h/)

  // The stored window is unchanged: it really is the last 24 hours.
  const stored = markupText(renderToStaticMarkup(React.createElement(PoolActivityCard, { read: okRead('pool-activity', 'pool-activity.success'), option: fixturePool() })))
  assert.match(stored, /Swaps \(24h\) 4 Pool age Older than 24 h Window 24 h covered/)
  assert.doesNotMatch(stored, /data-activity-live|activity index/)
})

test('G11: the activity card shows the 24h turnover, the LP fees and the LP assets in each token’s units, the exact amount in each title, and no USD figure or APR', () => {
  const { PoolActivityCard } = real('src/components/read/screens/PoolActivityCard.tsx')
  const html = renderToStaticMarkup(React.createElement(PoolActivityCard, { read: okRead('pool-activity', 'pool-activity.success'), option: fixturePool() }))
  assert.match(html, /data-pool-activity="ok"/)
  assert.deepEqual(rowCells(html, 'turnover'), ['<span class="tnum" title="0.000028926913445278">0.0000289269</span>', '<span class="tnum" title="1,635,670.293697">1,635,670</span>'])
  // Changed on purpose 2026-10-01 (audit E7): an amount under a millionth of a token reads "<0.000001", every digit of it
  // in its title, as the Wallet card and the position screens write it.
  assert.deepEqual(rowCells(html, 'lp-fees'), ['<span class="tnum" title="0.000000086412877935">&lt;0.000001</span>', '<span class="tnum" title="300.000002">300</span>'])
  assert.deepEqual(rowCells(html, 'lp-assets'), ['<span class="tnum" title="0.000000001012536287">&lt;0.000001</span>', '<span class="tnum" title="20,025,853.294226">20,025,853</span>'])
  const text = markupText(html)
  assert.match(text, /Swaps \(24h\) 4/)
  assert.match(text, /Pool age Older than 24 h/)
  assert.match(text, /Window 24 h covered/)
  assert.match(text, /Blocks covered 10 to 700/)
  assert.match(text, /ETH TOKEN/, 'the columns are the pool’s tokens, in its order')
  assert.doesNotMatch(text, /\$|APR|USD|stale|Retry|again/i)
  assert.doesNotMatch(html, /money-wait|dm-inset/)

  // A young pool says its age; decimals nobody read leave that token’s amounts a dash, the raw amount in the title.
  const young = renderToStaticMarkup(React.createElement(PoolActivityCard, { read: okRead('pool-activity', 'pool-activity.partial'), option: fixturePool([18, null]) }))
  assert.match(markupText(young), /Pool age 19 s Window 19 s observed/)
  assert.equal(rowCells(young, 'turnover')[1], '<span class="text-fg-subtle" title="Raw amount 1635670293697: the token’s decimals were not read">—</span>')

  // Stale, a few minutes behind: the same figures in the same ink; how far behind is the card’s title and data.
  const stale = renderToStaticMarkup(React.createElement(PoolActivityCard, { read: okRead('pool-activity', 'pool-activity.stale'), option: fixturePool(), now: { wall: 0 } }))
  assert.match(stale, /data-pool-activity="stale"[^>]*title="Stale: indexed 5 min behind the chain head, at block 700\."/)
  assert.doesNotMatch(markupText(stale), /stale/i)
  assert.match(markupText(stale), /Swaps \(24h\) 4 Pool age Older than 24 h Window 24 h covered/)

  // Fees and positions not reconciled: dashes, each saying why.
  const unreconciled = renderToStaticMarkup(React.createElement(PoolActivityCard, { read: okRead('pool-activity', 'pool-activity.unavailable'), option: fixturePool() }))
  assert.deepEqual(rowCells(unreconciled, 'lp-fees'), Array(2).fill('<span class="text-fg-subtle" title="Unavailable: fee ledger catching up">—</span>'))
  assert.deepEqual(rowCells(unreconciled, 'lp-assets'), Array(2).fill('<span class="text-fg-subtle" title="Unavailable: position ledger catching up">—</span>'))
})

test('G11: an unregistered pool keeps the card without figures, the reason in its title; while reading, the figures rest', () => {
  const { PoolActivityCard } = real('src/components/read/screens/PoolActivityCard.tsx')
  const unregistered = { route: 'pool-activity', state: 'unavailable', cause: { kind: 'producer', code: 'activity_pool_not_registered', status: 503 }, retryable: false, provenance: { transport: 'bridge', contract: null, receivedAt: 0, attempts: 1 } }
  const html = renderToStaticMarkup(React.createElement(PoolActivityCard, { read: unregistered, option: fixturePool() }))
  assert.match(html, /data-pool-activity="unavailable" data-activity-reason="activity_pool_not_registered" title="Activity isn’t indexed for this pool\. The read service answered: activity pool not registered\."/)
  const text = markupText(html)
  assert.equal(text.replace(/[^—]/g, '').length, 10, 'every figure is a dash')
  // What the card covers is its heading's title, never a line under it.
  assert.match(text, /^On-chain activity Swaps \(24h\) —/)
  // 2026-09-24 (V2 P2): module titles are .dm-title (DESIGN-V2 §2.8); the heading's words and title are unchanged.
  assert.match(html, /<h2 id="pool-activity-title" class="dm-title" title="Swaps and fees over the 24 hours up to the last indexed block, from indexed chain events\.">On-chain activity<\/h2>/)
  assert.doesNotMatch(text, /indexed chain events|The last 24 hours/)
  assert.doesNotMatch(html, /<button|dm-inset|money-wait/)
  assert.match(html, /<p role="status" class="sr-only">Activity isn’t indexed for this pool\. The read service answered: activity pool not registered\.<\/p>/)

  const reading = renderToStaticMarkup(React.createElement(PoolActivityCard, { read: null, option: fixturePool() }))
  assert.match(reading, /data-pool-activity="loading"/)
  assert.match(reading, /<p role="status" class="sr-only">Reading pool activity…<\/p>/)
  assert.doesNotMatch(markupText(reading), /—/)
})

test('G11: activity far behind the chain is never the last 24 hours: past 15 minutes every figure is a dash, how far behind only in the title, and no pool age or window from it', () => {
  const { PoolActivityCard } = real('src/components/read/screens/PoolActivityCard.tsx')
  const figures = real('src/lib/read/screens/figures.ts')
  assert.equal(figures.ACTIVITY_FRESH_SECONDS, 120, 'pool-activity’s own fresh line')
  assert.equal(figures.ACTIVITY_SHOWN_SECONDS, 900)
  const behind = (seconds, name = 'pool-activity.stale') => okRead('pool-activity', name, (body) => ({ ...body, freshness: { ...body.freshness, ageSeconds: seconds, status: seconds > 120 ? 'stale' : 'fresh' } }))
  const card = (read, now = { wall: 0 }) => renderToStaticMarkup(React.createElement(PoolActivityCard, { read, option: fixturePool(), now }))

  // The dev lane's WETH/USDG answer (2026-09-15): status stale, 4,891,659 s behind the head, still a covered window of 116 swaps.
  const months = card(behind(4_891_659))
  assert.match(months, /data-pool-activity="unavailable" data-activity-reason="activity_stale" title="Stale: indexed 56 days behind the chain head, at block 700, too far behind to show as the last 24 hours\."/)
  const text = markupText(months)
  assert.equal(text.replace(/[^—]/g, '').length, 10, 'every figure is a dash, the table’s amounts included')
  assert.doesNotMatch(text, /Older than 24 h|24 h covered|observed|\b4\b|10 to 700|0\.0000289269|1,635,670|stale|behind/i, 'no count, window, pool age, blocks or amount from it, and nothing said on the card')
  assert.match(months, /<p role="status" class="sr-only">Stale: indexed 56 days behind the chain head, at block 700, too far behind to show as the last 24 hours\.<\/p>/, 'a screen reader hears why')
  assert.deepEqual([...months.matchAll(/title="([^"]*)">—</g)].map(([, title]) => title), Array(10).fill('Stale: indexed 56 days behind the chain head, at block 700, too far behind to show as the last 24 hours.'))

  // A young pool's age is never worked out from a snapshot that far behind either.
  const young = card(behind(1_426_855, 'pool-activity.partial'))
  assert.doesNotMatch(markupText(young), /19 s|observed/)
  assert.match(young, /indexed 16 days behind/)

  // Up to the bound it is shown, stale in its title; one second past it, it is not.
  assert.match(card(behind(900)), /data-pool-activity="stale"[^>]*title="Stale: indexed 15 min behind the chain head, at block 700\."/)
  assert.match(card(behind(901)), /data-pool-activity="unavailable" data-activity-reason="activity_stale"/)

  // The age counts on while the card is open: fresh at 10 s, stale once past 120 s, too far behind past 900 s.
  const read = { ...okRead('pool-activity', 'pool-activity.success'), provenance: { transport: 'bridge', contract: null, receivedAt: 5_000, receivedMonotonic: 2_000, attempts: 1 } }
  assert.match(card(read, { wall: 5_000, monotonic: 2_000 }), /data-pool-activity="ok"/)
  assert.doesNotMatch(card(read, { wall: 5_000, monotonic: 2_000 }), /<section[^>]*title=/, 'fresh: nothing in the title')
  assert.match(card(read, { wall: 5_000, monotonic: 112_000 }), /data-pool-activity="ok"/, '120 s behind is still fresh')
  assert.match(card(read, { wall: 5_000, monotonic: 113_000 }), /data-pool-activity="stale"[^>]*title="Stale: indexed 2 min behind the chain head, at block 700\."/)
  assert.match(card(read, { wall: 999_999_999, monotonic: 2_000 }), /data-pool-activity="ok"/, 'counted on the monotonic clock: a wall-clock jump moves nothing')
  assert.match(card(read, { wall: 5_000, monotonic: 893_000 }), /data-pool-activity="unavailable" data-activity-reason="activity_stale" title="Stale: indexed 15 min behind the chain head, at block 700, too far behind to show as the last 24 hours\."/)
})

test('G12: positions in this pool: counts, LP assets in token units, and each position’s range with its NFT and owner at the block where resolved, never as proof of control', () => {
  const { PoolPositionsCard, POSITION_ROWS } = real('src/components/read/screens/PoolPositionsCard.tsx')
  const html = renderToStaticMarkup(React.createElement(PoolPositionsCard, { read: okRead('pool-positions', 'pool-positions.success'), option: fixturePool() }))
  const text = markupText(html)
  assert.match(html, /data-pool-positions="ok"/)
  assert.match(text, /Positions 3 With liquidity 2 Block 700/)
  assert.match(text, /LP assets &lt;0\.000001 20,025,853/)
  const rows = [...html.matchAll(/<tr data-pool-position="([^"]+)" data-position-liquidity="([^"]+)">(.*?)<\/tr>/gs)].map(([, key, liquidity, cells]) => [key.slice(0, 6), liquidity, markupText(cells)])
  assert.deepEqual(rows, [['0x09e7', 'some', '-60000 to 60000 — —'], ['0x9b7a', 'some', '-60 to 60 — —'], ['0xbb6a', 'none', '-60000 to 60000 — —']], 'no NFT or owner resolved: dashes that say so')
  assert.match(html, /title="Whoever held the position’s NFT at the snapshot block: public data, not proof of control">Owner at block 700/)
  assert.doesNotMatch(text, /\byour\b|you own|controls? this/i)

  // An owner resolved at the block is shown short, whole in its title, as public data at that block.
  const OWNER = addr('3')
  const resolved = (body) => {
    const item = body.positionAccounting.items[1]
    item.nft = { tokenId: '42', status: 'owner_verified_at_snapshot', owner: OWNER, positionManager: addr('4'), poolId: body.poolId, poolKey: body.poolKey, tickLower: item.tickLower, tickUpper: item.tickUpper, salt: item.salt, liquidityRaw: item.liquidityRaw, coreOwner: item.coreOwner, corePositionId: item.corePositionId, nftOwnershipResolved: true, ownershipBasis: 'ownerOf_at_pinned_block', walletControlVerified: false, isWithdrawalQuote: false, executionAvailable: false }
    body.positionAccounting.items[2].nft = { tokenId: '43', status: 'position_info_empty_at_snapshot', owner: null, corePositionId: null, nftOwnershipResolved: false }
    return body
  }
  const owned = renderToStaticMarkup(React.createElement(PoolPositionsCard, { read: okRead('pool-positions', 'pool-positions.success', resolved), option: fixturePool() }))
  const ownedRows = [...owned.matchAll(/<tr data-pool-position="[^"]+"[^>]*>(.*?)<\/tr>/gs)].map(([, cells]) => cells)
  assert.match(ownedRows[1], /<span title="42" translate="no">#42<\/span>/)
  assert.match(ownedRows[1], new RegExp(`title="${OWNER}: the NFT’s owner at block 700, public data\\. It proves nothing about who controls a wallet\\."`))
  assert.match(ownedRows[2], /#43[\s\S]*title="The position was empty at block 700">—/)

  // Past the first rows, the rest fold away under their count.
  const many = (body) => {
    const [first] = body.positionAccounting.items
    body.positionAccounting.items = Array.from({ length: POSITION_ROWS + 3 }, (_, i) => ({ ...first, corePositionId: `0x${i.toString(16).padStart(64, '0')}` }))
    return body
  }
  const long = renderToStaticMarkup(React.createElement(PoolPositionsCard, { read: okRead('pool-positions', 'pool-positions.success', many), option: fixturePool() }))
  assert.match(long, /<summary>3 more positions<\/summary>/)
  assert.equal([...long.matchAll(/data-pool-position=/g)].length, POSITION_ROWS + 3)

  // Position accounting not caught up: the section without figures, the reason in its title.
  const behind = renderToStaticMarkup(React.createElement(PoolPositionsCard, { read: okRead('pool-positions', 'pool-positions.unavailable'), option: fixturePool() }))
  assert.match(behind, /data-pool-positions="unavailable" data-positions-reason="position_ledger_not_caught_up" title="Unavailable: position ledger catching up"/)
  assert.doesNotMatch(behind, /data-pool-position=/)
})

test('G14: the detailed estimate lists its inputs and takes its title from its own limitations; with no estimate it is a neutral dash, the reason in its title', () => {
  const { PoolAprEstimate } = real('src/components/read/screens/PoolAprEstimate.tsx')
  const producer = (name) => v2.assertResponse('pool-market', JSON.parse(readFileSync(resolve(root, `../api-contracts/read-v2/fixtures/producer/pool-market.${name}.json`), 'utf8')))
  const observed = (estimate) => ({ data: estimate, receivedAt: 0, receivedMonotonic: 0 })
  const now = { wall: 0, monotonic: 0 }
  const html = renderToStaticMarkup(React.createElement(PoolAprEstimate, { observation: observed(producer('available').estimate), now, detailed: true }))
  const inputs = [...html.matchAll(/<dt>(.*?)<\/dt><dd[^>]*>(.*?)<\/dd>/g)].map(([, dt, dd]) => [dt, dd])
  assert.deepEqual(inputs.slice(0, 5), [['LP fee', '0.30%'], ['Protocol fee', 'None'], ['24h volume, provider-reported', '$1.0K'], ['TVL, provider-reported', '$10.0K'], ['Method', '365 × LP fee × (1 − protocol fee) × 24h volume ÷ TVL']])
  assert.match(html, /title="From a market data provider’s reported 24h volume and TVL, not reconciled\. The provider’s update time is unknown\. Current TVL, not time-weighted\. Assumes the current fixed LP fee for the whole 24h volume\. The protocol fee’s effect is not reconciled\. Full-day coverage is not proven\. Excludes rewards, gas, service fees and price changes\. Pool estimate, not position APR or APY\. Not a return forecast or a recommendation\." data-apr-figure="">11\.0% est\. APR/)
  // Changed on purpose 2026-10-01 (audit E21): the figure by the one APR rule; the exact estimate stays in the inputs.
  assert.match(html, /<dt>Exact estimate<\/dt><dd class="tnum break-all text-fg-muted">10\.95%<\/dd>/)

  const protocolFee = producer('protocol-fee').estimate
  const protocol = renderToStaticMarkup(React.createElement(PoolAprEstimate, { observation: observed(protocolFee), now, detailed: true }))
  assert.match(protocol, /<dt>Protocol fee<\/dt><dd class="tnum text-fg-muted" title="Selling the pool’s first token \/ its second\. Packed value \d+\.">\d\.\d+%/)
  // The Method line is the read service's arithmetic (backend/pool_apr.py): the LP fee applies to what the protocol fee leaves.
  assert.match(protocol, /<dt>Method<\/dt><dd class="text-fg-muted">365 × LP fee × \(1 − protocol fee\) × 24h volume ÷ TVL<\/dd>/)
  const { currentLpFeePips, protocolFeeRaw, volume24hUsd, reportedLiquidityUsd } = protocolFee.inputs
  assert.equal((protocolFeeRaw & 0xfff), protocolFeeRaw >> 12, 'the fixture’s protocol fee is the same both ways')
  const byMethod = 365 * (currentLpFeePips / 1e6) * (1 - (protocolFeeRaw & 0xfff) / 1e6) * Number(volume24hUsd) / Number(reportedLiquidityUsd) * 100
  assert.equal(byMethod.toFixed(5), protocolFee.feeAprEstimate24hPercent, 'the line, worked on the payload’s own inputs, gives the payload’s estimate')

  const none = renderToStaticMarkup(React.createElement(PoolAprEstimate, { observation: { data: null, reason: 'estimate_not_enabled', receivedAt: 0 }, now, detailed: true }))
  assert.match(none, /title="Pool estimate, not position APR, APY or a return forecast\. Estimated APR is not enabled on this connection\." data-apr-figure="">—<\/span>/)
  // Beside a label, as the pool page's APR details show it, the same figure and title.
  const labelled = renderToStaticMarkup(React.createElement(PoolAprEstimate, { observation: { data: null, reason: 'estimate_not_enabled', receivedAt: 0 }, now, detailed: true, label: 'Estimated APR' }))
  assert.match(labelled, /<span class="text-fg-muted">Estimated APR<\/span><span class="tnum whitespace-nowrap font-medium text-fg-subtle" title="Pool estimate, [^"]*" data-apr-figure="">—<\/span>/)
  assert.doesNotMatch(markupText(none), /enabled|connection|unavailable/i, 'no words about the connection on the page')
  assert.doesNotMatch(none, /<dl/)
})

test('the range slider: a handle on its own band edge is inside, so a range’s Min and Max handles wear the same ring; only a handle past the band is neutral', () => {
  const { PriceSlider } = real('src/components/PriceSlider.tsx')
  const ring = (value, lower = -600, upper = 900) => {
    const html = renderToStaticMarkup(React.createElement(PriceSlider, { id: 'bound', label: 'Bound', min: -3000, max: 3000, step: 60, value, onChange() {}, lower, upper, format: String }))
    return /inset 0 0 0 1\.5px (var\(--[a-z-]+\))/.exec(html)?.[1]
  }
  // As the range planner draws them: the Min slider's value is the band's lower tick, the Max slider's its upper tick.
  assert.equal(ring(-600), 'var(--primary-ink)', 'Min on the lower edge')
  assert.equal(ring(900), 'var(--primary-ink)', 'Max on the upper edge, the same ring')
  assert.equal(ring(0), 'var(--primary-ink)', 'inside')
  assert.equal(ring(-660), 'var(--fg-faint)', 'below the band')
  assert.equal(ring(960), 'var(--fg-faint)', 'above the band')
  assert.equal(ring(0, undefined, undefined), 'var(--primary-ink)', 'no band drawn')
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(PriceSlider, { id: 'b', label: 'B', min: 0, max: 10, value: 12, onChange() {}, lower: 1, upper: 2 })), /money-wait/)
})

test('the pool explorer on Setup offers existing pools only, and describes nothing that is not there', () => {
  // Setup mounts it only for a signed-in wallet, through the app's read context, so its source is checked as written.
  const source = readFileSync(resolve(root, 'src/components/read/screens/PoolExplorer.tsx'), 'utf8')
  assert.match(source, /Explore range/)
  assert.doesNotMatch(source, /Create a new pool|coming later|newPool|isn’t available|coming soon/i)
})

test('the pool pickers say nothing that is not there: no new-pool note, no status panel while pools are read', () => {
  const { PoolPicker } = real('src/components/read/screens/PoolPicker.tsx')
  const html = renderToStaticMarkup(React.createElement(PoolPicker, { source: { transport: 'bridge', read() { throw new Error('no read on render') } }, token: TOKEN_1, paired: null, pending: null, onPending() {}, catalogue: true, compact: false }))
  assert.doesNotMatch(html, /Creating a new pool|isn’t available here|dm-inset px-4 py-3|Retry|money-wait/)
  assert.match(html, /data-pools-state="loading"/)
  assert.match(html, /<p role="status" aria-live="polite" class="sr-only">Reading existing pools…<\/p>/, 'the loading words are for assistive technology only')
})

/** The pool picker over a deferred read boundary and deferred quiet waits, with the real copy and the real re-ask rule. */
function picker(props = {}) {
  const reads = []
  const asks = []
  const hinted = []
  const readWithin = (_source, route, request, options) => { const pending = deferred(); reads.push({ route, request, options, ...pending }); return pending.promise }
  const hintsWithin = (token, paired, signal) => { const pending = deferred(); hinted.push({ token, paired, signal, ...pending }); return pending.promise }
  // Changed on purpose 2026-09-28 (speed wave): New position's read is the flow's (src/lib/create/poolsAhead.ts), the real
  // module over the same deferred boundaries, one per picker, so what this checks of the picker's read holds as before.
  const ahead = load('src/lib/create/poolsAhead.ts', { readWithin, hintsWithin, usablePoolsRequest: real('src/lib/read/screens/poolsList.ts').usablePoolsRequest })
  // 2026-10-06 (rugged97's delta of 6 Oct §4): a row of Base or Arbitrum One names DEX Screener (the real rules, tested in
  // tests/v2/multichain-journey.test.mjs); this picker's rows are Robinhood Chain's, which they leave as they were.
  const others = real('src/lib/create/otherChains.ts')
  const { PoolPicker } = load('PoolPicker', {
    poolOnOtherChain: others.poolOnOtherChain, networkFigureNote: others.networkFigureNote, networkAprNote: others.networkAprNote, figuresShownUntil: others.figuresShownUntil,
    readNow: () => ({ wall: 1001000, monotonic: 0 }),
    keptCreatePools: ahead.keptCreatePools, readCreatePools: ahead.readCreatePools,
    readWithin,
    askAgainLater(outcome, attempt, signal) { const pending = deferred(); asks.push({ outcome, attempt, signal, ...pending }); return pending.promise },
    asksAgain: real('src/lib/read/screens/transient.ts').asksAgain,
    failureCode: real('src/lib/read/screens/quietRead.ts').failureCode,
    COPY: real('src/lib/read/screens/copy.ts').COPY,
    poolsRequest: (token, paired) => (paired ? { token, pairedToken: paired } : { token }),
    neutralOrder: (options) => options,
    // New position's variant (2026-09-24): its pool-id hints are a deferred boundary too; its request and its
    // projection (usable pools only, in TVL order) are the real ones.
    hintsWithin,
    usablePoolsRequest: real('src/lib/read/screens/poolsList.ts').usablePoolsRequest,
    projectPoolsView: real('src/lib/read/screens/poolsList.ts').projectPoolsView,
    rowApr: real('src/lib/read/screens/rowApr.ts').rowApr, rowAprReasonText: real('src/lib/read/screens/rowApr.ts').rowAprReasonText,
  })
  const host = mount(PoolPicker, { source: { transport: 'bridge' }, token: TOKEN_1, paired: null, pending: null, onPending() {}, catalogue: false, compact: true, ...props })
  return { host, reads, asks, hinted }
}
const pickerLine = (host) => elements(host.tree, (node) => node.props?.['data-pools-unavailable'] !== undefined)[0]
const failed = (s) => ({ route: 'pools', provenance: { transport: 'bridge', contract: null, receivedAt: 0, attempts: 1 }, ...s })

test('a pool list that failed for good leaves one plain muted line, its code in data and its reason in the title; while it waits to be asked again, its rows rest', async () => {
  const { host, reads, asks } = picker()
  const transient = failed({ state: 'unavailable', cause: { kind: 'producer', code: 'upstream_unavailable', status: 503 }, retryable: true })
  reads[0].resolve(transient); await flush(); host.render()
  assert.equal(pickerLine(host), undefined, 'nothing is said while the list will be asked again')
  assert.ok(elements(host.tree, (node) => node.type === parts.Skeleton).length > 0, 'its rows rest meanwhile')
  assert.deepEqual(asks.map(({ attempt }) => attempt), [0])

  asks[0].resolve(true); await flush(); host.render()
  assert.equal(reads.length, 2, 'asked again, on its own')
  // The dev lane's name-search walk: pools {token} answered 502 upstream_contract_mismatch. A gateway that does not stamp
  // its mid-hop failures sends that for a hop that is only flapping, so it too is asked again (transient.ts).
  reads[1].resolve(failed({ state: 'incompatible', reason: 'upstream_contract_mismatch' })); await flush(); host.render()
  assert.equal(pickerLine(host), undefined, 'nothing is said while a hop’s refusal will be asked again')
  assert.deepEqual(asks.map(({ attempt }) => attempt), [0, 1])
  asks[1].resolve(true); await flush(); host.render()
  assert.equal(reads.length, 3, 'asked again, on its own, after the hop’s refusal')
  // The lane's other 502, a reply the hop could not read at all, is the same reply next time.
  reads[2].resolve(failed({ state: 'unavailable', cause: { kind: 'producer', code: 'upstream_invalid_response', status: 502 }, retryable: false })); await flush(); host.render()
  const line = pickerLine(host)
  assert.ok(line, 'the line is on the page')
  assert.equal(line.props.children, 'No pools to show for this token.')
  assert.equal(line.props['data-pools-unavailable'], 'upstream_invalid_response', 'the code, for data')
  assert.equal(line.props.title, 'Unavailable. No response', 'the reason, for the title')
  assert.match(line.props.className, /text-fg-muted/)
  assert.equal(elements(host.tree, (node) => node.type === parts.Skeleton).length, 0, 'no resting rows once it is final')
  const markup = renderToStaticMarkup(host.tree)
  assert.doesNotMatch(markup.replace(/<p role="status"[^>]*>.*?<\/p>/gs, ''), />—</, 'never a bare dash')
  assert.doesNotMatch(markup, /Retry|again|dm-inset/)
  host.unmount()

  const pair = picker({ paired: addr('2') })
  pair.reads[0].resolve(failed({ state: 'disabled', reason: 'route_not_enabled' })); await flush(); pair.host.render()
  assert.equal(pickerLine(pair.host).props.children, 'No pools to show for this pair.')
  assert.equal(pickerLine(pair.host).props['data-pools-unavailable'], 'route_not_enabled')
  pair.host.unmount()
})

test('the pool picker’s quiet re-asks belong to its token: a new token starts from none, and spent re-asks end in the plain line', async () => {
  const { host, reads, asks } = picker()
  const busy = failed({ state: 'busy', retryAfterSeconds: 2 })
  for (let n = 0; n < 4; n += 1) {
    reads.at(-1).resolve(busy); await flush(); host.render()
    if (n < 3) { asks.at(-1).resolve(true); await flush(); host.render() }
  }
  assert.deepEqual(asks.map(({ attempt }) => attempt), [0, 1, 2, 3])
  assert.equal(pickerLine(host), undefined, 'the fourth wait is still ahead')
  asks.at(-1).resolve(true); await flush(); host.render()
  reads.at(-1).resolve(busy); await flush(); host.render()
  assert.equal(pickerLine(host)?.props['data-pools-unavailable'], 'busy', 'busy after its last re-ask: final, said plainly')

  host.props = { ...host.props, token: addr('3') }; host.render()
  assert.equal(pickerLine(host), undefined, 'the other token’s line is not this one’s')
  assert.deepEqual(reads.at(-1).request, { token: addr('3') })
  reads.at(-1).resolve(busy); await flush(); host.render()
  assert.equal(asks.at(-1).attempt, 0, 'the new token is asked again from its first wait')
  host.unmount()
})

// Added 2026-09-24 (owner): New position's first step lists only pools Domino can open a position in, largest TVL
// first. It first asks which pools are worth verifying and names them in the one pools read; without an answer
// in time it reads as before. A pool with hooks never becomes a row, and how many were left out is data only.
test('New position’s picker names the hinted pools in its one pools read, lists only usable pools by TVL, and reads without hints when there are none', async () => {
  const { host, reads, asks, hinted } = picker({ variant: 'create' })
  assert.equal(reads.length, 0, 'the pools read waits for the hints')
  assert.deepEqual(hinted.map(({ token, paired }) => [token, paired]), [[TOKEN_1, null]])
  hinted[0].resolve([id('c'), id('a'), id('b')]); await flush(); host.render()
  assert.deepEqual(reads.map(({ route, request }) => [route, request]), [['pools', { token: TOKEN_1, maxPools: 3, poolIds: [id('c'), id('a'), id('b')] }]])
  const base = gatewayFixture('pools.success').pools[0]
  const metrics = (usd) => ({ ...base.providerMetrics, reportedLiquidityUsd: usd })
  reads[0].resolve(okRead('pools', 'pools.success', (body) => ({ ...body, pools: [
    { ...base, poolId: id('a'), providerMetrics: metrics('10.00') },
    { ...base, poolId: id('b'), poolKey: { ...base.poolKey, hooks: addr('a') }, integrationClass: 'requires_separate_adapter', providerMetrics: metrics('9000000') },
    { ...base, poolId: id('c'), providerMetrics: metrics('5000') },
  ], unverifiedCandidates: [{ poolId: id('d'), reason: 'pool_id_mismatch' }] })))
  await flush(); host.render()
  const rows = elements(host.tree, (node) => node.type?.name === 'PoolRow')
  assert.deepEqual(rows.map((row) => row.props.option.key), [id('c'), id('a')], 'the hooked pool is not a row; the larger TVL is first')
  assert.ok(rows.every((row) => row.props.plain === true), 'New position’s plain rows')
  assert.equal(host.tree.props['data-pools-state'], 'ok')
  assert.equal(host.tree.props['data-pools-hidden'], 1, 'left out, for data only')
  assert.equal(host.tree.props['data-pools-rejected'], 1)
  const markup = renderToStaticMarkup(host.tree)
  assert.doesNotMatch(markup, /<details|data-rejected-pools|data-pools-coverage|data-catalogue/, 'no coverage, rejected or catalogue panel')
  assert.doesNotMatch(markup.replace(/<[^>]+>/g, ' '), /Rejected|coverage|verified pool|catalogue|hooks/i, 'none of it in words, and hooks are never mentioned')
  host.unmount()

  // No hints (none listed, none in time, or a failure: hintsWithin answers [] for all three): today's plain read.
  const plain = picker({ variant: 'create', paired: addr('2') })
  plain.hinted[0].resolve([]); await flush(); plain.host.render()
  assert.deepEqual(plain.reads[0].request, { token: TOKEN_1, pairedToken: addr('2') })
  // Every pool left out: the same muted line as an empty list, marked as data, never a sentence about hooks.
  plain.reads[0].resolve(okRead('pools', 'pools.success', (body) => ({ ...body, pools: body.pools.map((pool) => ({ ...pool, poolKey: { ...pool.poolKey, hooks: addr('a') }, integrationClass: 'requires_separate_adapter' })) })))
  await flush(); plain.host.render()
  const empty = elements(plain.host.tree, (node) => node.props?.['data-pools-empty'] !== undefined)[0]
  assert.equal(empty?.props.children, 'No pools to show for this pair.')
  assert.match(empty.props.className, /text-fg-muted/)
  assert.equal(elements(plain.host.tree, (node) => node.type?.name === 'PoolRow').length, 0)
  assert.doesNotMatch(renderToStaticMarkup(plain.host.tree), /hooks|No verified pool was found/i)
  plain.host.unmount()

  // A transient failure: the rows keep resting, nothing is said, and it is asked again on its own.
  const busy = picker({ variant: 'create' })
  busy.hinted[0].resolve([]); await flush(); busy.host.render()
  busy.reads[0].resolve(failed({ state: 'busy', retryAfterSeconds: 2 })); await flush(); busy.host.render()
  assert.equal(pickerLine(busy.host), undefined)
  assert.ok(elements(busy.host.tree, (node) => node.type === parts.Skeleton).length > 0, 'its rows rest meanwhile')
  assert.deepEqual(busy.asks.map(({ attempt }) => attempt), [0])
  busy.host.unmount()

  // Leaving before the hints answer: nothing is read at all.
  const gone = picker({ variant: 'create' })
  gone.host.unmount()
  assert.equal(gone.hinted[0].signal.aborted, true, 'the wait is cancelled')
  gone.hinted[0].resolve([id('a')]); await flush()
  assert.equal(gone.reads.length, 0)
  assert.deepEqual(asks, [])
})

test('asking again quietly: only a busy or transient failure, at most four times, at doubling waits of about 4 s give or take a quarter, and only while the page is shown', async () => {
  const { quietRetryDelay, askAgainLater, QUIET_ATTEMPTS } = real('src/lib/read/screens/screenRead.ts')
  const busy = { state: 'busy', retryAfterSeconds: 7 }
  const lowest = () => 0
  const middle = () => 0.5
  const highest = () => 1
  assert.equal(QUIET_ATTEMPTS, 4)
  // The jitter is ±25% around the doubled wait, and a busy service's own Retry-After is a floor it never goes under.
  assert.deepEqual([0, 1, 2, 3, 4].map((n) => quietRetryDelay(busy, n, lowest)), [7000, 10500, 21000, 42000, null], 'the earliest: never before the service’s own 7 s')
  assert.deepEqual([0, 1, 2, 3, 4].map((n) => quietRetryDelay(busy, n, highest)), [8750, 17500, 35000, 70000, null], 'the latest: a quarter past the doubled wait')
  assert.deepEqual([quietRetryDelay({ state: 'busy', retryAfterSeconds: 1 }, 0, lowest), quietRetryDelay({ state: 'busy', retryAfterSeconds: 1 }, 0, highest)], [3000, 5000], 'a short Retry-After waits about 4 s')
  const drawn = [0.1, 0.9]
  assert.notEqual(quietRetryDelay(busy, 1, () => drawn[0]), quietRetryDelay(busy, 1, () => drawn[1]), 'two screens that failed together do not come back together')
  for (let i = 0; i < 200; i += 1) {
    const wait = quietRetryDelay(busy, 0)
    assert.ok(wait >= 7000 && wait <= 8750, `${wait} ms, drawn with Math.random`)
  }
  for (const transient of [
    { state: 'unavailable', cause: { kind: 'producer', code: 'upstream_unavailable', status: 503 }, retryable: true },
    { state: 'unavailable', cause: { kind: 'network' }, retryable: false },
    { state: 'unavailable', cause: { kind: 'edge', status: 502 }, retryable: false },
    { state: 'unavailable', cause: { kind: 'read_deadline', limit: 'read' }, retryable: true },
    { state: 'unavailable', cause: { kind: 'queue_full' }, retryable: true },
    { state: 'gate_unavailable' },
    { state: 'local', code: 'screen_budget_exceeded' },
    { state: 'restart_required', code: 'catalogue_revision_changed' },
  ]) assert.deepEqual([quietRetryDelay(transient, 1, lowest), quietRetryDelay(transient, 1, middle), quietRetryDelay(transient, 1, highest)], [6000, 8000, 10000], JSON.stringify(transient))
  for (const final of [
    { state: 'unavailable', cause: { kind: 'producer', code: 'activity_pool_not_registered', status: 503 }, retryable: false },
    { state: 'unavailable', cause: { kind: 'edge', status: 403 }, retryable: false },
    { state: 'invalid', reason: 'identity_mismatch' },
    { state: 'incompatible', reason: 'contract_version_not_accepted' },
    { state: 'disabled', reason: 'route_not_enabled' },
    { state: 'not_connected', reason: 'bridge_unavailable' },
    { state: 'gate_required' },
    { state: 'request_rejected', code: 'invalid_request', status: 422 },
    { state: 'restart_required', code: 'invalid_or_expired_cursor' },
    { state: 'aborted' },
  ]) assert.equal(quietRetryDelay(final, 0, middle), null, JSON.stringify(final))

  const slept = []
  const clock = { sleep: async (ms, signal) => { if (signal?.aborted) throw new Error('aborted'); slept.push(ms) } }
  const page = () => {
    const listeners = new Set()
    return { hidden: false, listeners, addEventListener: (_type, fn) => listeners.add(fn), removeEventListener: (_type, fn) => listeners.delete(fn), show() { this.hidden = false; for (const fn of [...listeners]) fn() } }
  }
  const shown = page()
  assert.equal(await askAgainLater(busy, 2, new AbortController().signal, { clock, page: shown, random: middle }), true)
  assert.deepEqual(slept, [28000])
  // Without a random of its own, the wait draws on the clock's: a test clock decides it.
  assert.equal(await askAgainLater(busy, 2, new AbortController().signal, { clock: { ...clock, random: highest }, page: shown }), true)
  assert.deepEqual(slept, [28000, 35000])
  assert.equal(await askAgainLater({ state: 'invalid', reason: 'response_contract' }, 0, new AbortController().signal, { clock, page: shown }), false, 'a final answer is never asked again')
  assert.equal(await askAgainLater(busy, 4, new AbortController().signal, { clock, page: shown }), false, 'nor past the fourth time')
  assert.deepEqual(slept, [28000, 35000], 'and neither waited')

  const hidden = page(); hidden.hidden = true
  let settled = null
  void askAgainLater(busy, 0, new AbortController().signal, { clock, page: hidden }).then((value) => { settled = value })
  await flush()
  assert.equal(settled, null, 'a hidden page waits to be shown')
  hidden.show(); await flush()
  assert.equal(settled, true)
  assert.equal(hidden.listeners.size, 0, 'and stops listening')

  const leaving = page(); leaving.hidden = true
  const controller = new AbortController()
  const waiting = askAgainLater(busy, 0, controller.signal, { clock, page: leaving })
  await flush(); controller.abort()
  assert.equal(await waiting, false, 'leaving the page ends the wait')
  assert.equal(leaving.listeners.size, 0)
})

/** The range planner's stale-price read, alone: the real hook over a deferred verification and deferred quiet waits. */
function staleRead() {
  const verifications = []
  const asks = []
  const chosen = []
  const { useStalePriceRead } = load('PoolRangeControls', {
    verifyCandidate(_source, token, paired, poolId, options) { const pending = deferred(); verifications.push({ token, paired, poolId, signal: options.signal, ...pending }); return pending.promise },
    askAgainLater(outcome, attempt, signal) { const pending = deferred(); asks.push({ outcome, attempt, signal, ...pending }); return pending.promise },
    COPY: real('src/lib/read/screens/copy.ts').COPY,
  })
  const source = { transport: 'bridge' }
  const Probe = ({ poolKey }) => useStalePriceRead(source, addr('1'), addr('2'), poolKey, (option) => chosen.push(option))
  const host = mount(Probe, { poolKey: id('a') })
  host.render()
  return { host, verifications, asks, chosen, change: (stale = true) => { host.tree.readIfStale(stale); host.render() } }
}

test('a stale price is read again on the next range change, one read at a time; a busy read waits its quiet turn with range changes sending nothing, and a final one is not read again until the person comes back', async () => {
  const busy = failed({ state: 'busy', retryAfterSeconds: 2 })
  const probe = staleRead()
  probe.change(false)
  assert.equal(probe.verifications.length, 0, 'a price that is not stale is not read')
  probe.change(); probe.change(); probe.change()
  assert.equal(probe.verifications.length, 1, 'dragging a handle sends one read, not one per step')
  assert.equal(probe.host.tree.said.code, 'loading')

  probe.verifications[0].resolve({ failure: busy, option: null, restarted: false }); await flush(); probe.host.render()
  assert.deepEqual(probe.asks.map(({ attempt }) => attempt), [0], 'the busy read waits by the quiet re-ask policy')
  probe.change(); probe.change()
  assert.equal(probe.verifications.length, 1, 'range changes during the wait send nothing')
  probe.asks[0].resolve(true); await flush(); probe.host.render()
  assert.equal(probe.verifications.length, 2, 'asked again on its own after the wait')
  probe.verifications[1].resolve({ failure: busy, option: null, restarted: false }); await flush(); probe.host.render()
  assert.deepEqual(probe.asks.map(({ attempt }) => attempt), [0, 1], 'counted')
  probe.asks[1].resolve(false); await flush(); probe.host.render()
  for (let n = 0; n < 5; n += 1) probe.change()
  assert.equal(probe.verifications.length, 2, 'once its re-asks are spent, nothing is read again on this visit')
  probe.host.unmount()
  assert.equal(probe.asks[1].signal.aborted, true, 'leaving cancels it')

  // Coming back is a new visit: the stale price is read again.
  const back = staleRead()
  back.change()
  assert.equal(back.verifications.length, 1)
  back.verifications[0].resolve({ failure: failed({ state: 'invalid', reason: 'identity_mismatch' }), option: null, restarted: false }); await flush(); back.host.render()
  assert.equal(back.host.tree.said.code, 'offline', 'why, for the live region and data only')
  back.asks[0].resolve(false); await flush(); back.host.render()
  back.change(); back.change()
  assert.equal(back.verifications.length, 1, 'a final failure is not read again until the person leaves and returns')
  back.host.unmount()

  // An answer brings the price up to date through the page's own onOption; the next stale change reads again.
  const ok = staleRead()
  ok.change()
  ok.verifications[0].resolve({ failure: null, option: option('a'), restarted: false }); await flush(); ok.host.render()
  assert.deepEqual(ok.chosen.map((chosen) => chosen.key), [id('a')])
  assert.equal(ok.host.tree.said.text, 'Price read again at block 700.')
  ok.change()
  assert.equal(ok.verifications.length, 2, 'a price that turned stale again is read again')
  ok.verifications[1].resolve({ failure: null, option: null, restarted: false }); await flush(); ok.host.render()
  assert.equal(ok.host.tree.said.code, 'not_found')
  ok.change()
  assert.equal(ok.verifications.length, 2, 'a pool the pools route did not return is not asked for on every change')
  // Another pool on the same planner is its own question.
  ok.host.props = { poolKey: id('b') }; ok.host.render()
  assert.equal(ok.verifications[1].signal.aborted, true)
  ok.change()
  assert.deepEqual(ok.verifications.map(({ poolId }) => poolId), [id('a'), id('a'), id('b')])
  ok.host.unmount()
})

// --- the token lookup on Explore ---

function lookup() {
  const reads = []
  const found = []
  // Quiet re-asks the component scheduled: the wait it asked for, and the call that would make it.
  const scheduled = []
  const candidate = (data, wire) => ({ key: wire.toLowerCase(), wire, token: token('1'), kind: 'erc20_candidate', why: null, reasonCode: null, decimalsUnavailable: false, source: 'pasted', balance: null, page: null, old: false, block: data.snapshot.number })
  const { TokenLookup } = load('TokenLookup', {
    readWithin(_source, route, request, options) { const pending = deferred(); reads.push({ route, request, options, ...pending }); return pending.promise },
    candidateFromToken: candidate,
    // The real hand-off rule (tokens.ts): a search's selectable read of exactly this wire.
    handoffFor: load('src/lib/read/screens/tokens.ts', {}).handoffFor,
    // The quiet re-ask restated: a failure that can pass (here: unavailable) is asked again four times.
    reaskDelayMs: (failure, attempt) => (failure.state === 'unavailable' && attempt < 4 ? 4000 * 2 ** attempt : null),
    whenVisibleAfter: (ms, run) => { const entry = { ms, run, cancelled: false }; scheduled.push(entry); return () => { entry.cancelled = true } },
    failureCode: (failure) => failure.state,
    quietTitle: () => 'Unavailable. No response',
    unreadToken: (address) => ({ ...token('1'), address, symbol: null, decimals: null }),
  })
  return { TokenLookup, reads, found, scheduled, candidate, props: { source: { transport: 'bridge' }, wire: `0x${'A'.repeat(40)}`, onFound: (found_) => found.push(found_) } }
}

/** The read token card's block and chain (its data attributes) and its token row's title. */
function lookupReadAt(host) {
  const card = elements(host.tree, (node) => node.props?.['data-token-lookup'] === 'ok')[0]
  const row = elements(host.tree, (node) => node.props?.className === 'dm-mkt-lookup-token')[0]
  return { block: card?.props['data-token-block'], chain: card?.props['data-token-chain'], title: row?.props.title }
}

test('the lookup is one token read with the address exactly as written; a new address cancels the old read and shows nothing from it', async () => {
  const fixture = lookup(); const host = mount(fixture.TokenLookup, fixture.props)
  assert.deepEqual(fixture.reads.map(({ route, request }) => ({ route, request })), [{ route: 'token', request: { token: `0x${'A'.repeat(40)}` } }], 'sent as typed, upper-case digits kept')
  assert.ok(elements(host.tree, (node) => node.type === parts.Skeleton).length > 0, 'rests while reading')
  host.props = { ...host.props, wire: addr('2') }; host.render()
  assert.equal(fixture.reads.length, 2)
  assert.equal(fixture.reads[0].options.signal.aborted, true)
  fixture.reads[0].resolve({ state: 'ok', data: { snapshot: { number: 1 } } }); await flush(); host.render()
  assert.deepEqual(fixture.found, [], 'the cancelled read announced no token')
  fixture.reads[1].resolve({ state: 'ok', data: { snapshot: { number: 700 } } }); await flush(); host.render()
  assert.equal(fixture.found.length, 1)
  assert.equal(fixture.found[0].key, addr('2'))
  const visible = renderToStaticMarkup(host.tree).replace(/<[^>]+>/g, '')
  assert.match(visible, /ERC-20 token/)
  assert.match(visible, /18 decimals/, 'one short fact beside the kind')
  // Where and when it was read is the row's title and the card's data, never a caption on the card.
  assert.doesNotMatch(visible, /Read at block|Robinhood Chain/)
  assert.deepEqual(lookupReadAt(host), { block: 700, chain: 4663, title: 'Read at block 700 on Robinhood Chain.' })
  host.unmount()
  assert.equal(fixture.reads[1].options.signal.aborted, true)
})

test('a failed lookup shows no status and no Retry: the address with a dash, its reason in the title, asked again on its own while the failure can pass', async () => {
  const fixture = lookup(); const host = mount(fixture.TokenLookup, fixture.props)
  fixture.reads[0].resolve({ state: 'unavailable' }); await flush(); host.render()
  assert.doesNotMatch(renderToStaticMarkup(host.tree), /data-screen-status|dm-inset/, 'no status panel')
  for (const label of ['Retry', 'Read again']) assert.equal(buttonNamed(host, label), undefined, label)
  const card = elements(host.tree, (node) => node.props?.['data-token-lookup'] === 'failed')[0]
  assert.ok(card, 'the failed card is on the page')
  assert.deepEqual([card.props['data-token-lookup-reason'], card.props.title], ['unavailable', 'Unavailable. No response'])
  const visible = renderToStaticMarkup(host.tree).replace(/<[^>]+>/g, '')
  assert.match(visible, /—/)
  assert.doesNotMatch(visible, /No response/, 'the reason is not printed')
  assert.doesNotMatch(visible, /Robinhood Chain/, 'nor the chain: it is the card’s data')
  assert.equal(card.props['data-token-chain'], 4663)
  // The quiet re-ask: one, after its wait, of the same address.
  assert.deepEqual(fixture.scheduled.map((entry) => entry.ms), [4000])
  fixture.scheduled[0].run(); host.render()
  assert.equal(fixture.reads.length, 2)
  assert.deepEqual(fixture.reads[1].request, fixture.reads[0].request)
  fixture.reads[1].resolve({ state: 'disabled' }); await flush(); host.render()
  assert.equal(fixture.scheduled.length, 1, 'a failure that cannot pass is not asked again')
  host.unmount()
  assert.equal(fixture.reads[1].options.signal.aborted, true)
})

test('a token a search already read for exactly this address is shown as handed over, with no read of its own; any other view reads', async () => {
  const fixture = lookup()
  const wire = `0x${'A'.repeat(40)}`
  const handed = fixture.candidate({ snapshot: { number: 700 } }, wire)
  const host = mount(fixture.TokenLookup, { ...fixture.props, initial: handed })
  assert.equal(fixture.reads.length, 0, 'the search’s answer is not asked for again')
  assert.deepEqual(fixture.found, [handed], 'and the page hears about it as if read')
  assert.equal(lookupReadAt(host).block, 700, 'the handed-over read is the one shown')
  host.unmount()

  const other = lookup()
  const spelled = mount(other.TokenLookup, { ...other.props, initial: other.candidate({ snapshot: { number: 700 } }, wire.toLowerCase()) })
  assert.equal(other.reads.length, 1, 'another spelling of the address is another question: the view reads')
  spelled.unmount()
  const linked = lookup()
  const opened = mount(linked.TokenLookup, linked.props)
  assert.equal(linked.reads.length, 1, 'a view opened by a link reads the token itself')
  opened.unmount()

  // A search whose read said the token couldn't be read (an RPC error can pass) hands nothing over: the view reads it itself.
  const unreadable = lookup()
  const shaky = { ...unreadable.candidate({ snapshot: { number: 700 } }, wire), kind: 'unknown', why: 'unreadable', reasonCode: 'rpc_error' }
  const view = mount(unreadable.TokenLookup, { ...unreadable.props, initial: shaky })
  assert.equal(unreadable.reads.length, 1, 'an unreadable answer is asked for again by the view')
  assert.deepEqual(unreadable.found, [], 'and the page hears nothing until that read answers')
  unreadable.reads[0].resolve({ state: 'ok', data: { snapshot: { number: 701 } } }); await flush(); view.render()
  assert.deepEqual(unreadable.found.map((c) => [c.why, c.block]), [[null, 701]], 'the view’s own read is what the page hears')
  view.unmount()
})

// --- the routes Markets and the pool page read for themselves ---

test('hash routes: a token or a pool id is taken only in its exact shape, and older section links are forwarded', () => {
  const routes = load('src/components/explore/routes.ts', {})
  const upper = `0x${'A'.repeat(40)}`
  assert.deepEqual(routes.parseExploreHash(`#/markets/${upper}`), { token: upper, linkedPool: null }, 'as written, case kept')
  assert.deepEqual(routes.parseExploreHash('#/markets'), { token: null, linkedPool: null })
  assert.deepEqual(routes.parseExploreHash('#/markets/0x1234'), { token: null, linkedPool: null }, 'not an address: ignored')
  assert.deepEqual(routes.parseExploreHash(`#/explore/${upper}`), { token: upper, linkedPool: null }, 'the older Explore spelling still reads, case kept')
  assert.deepEqual(routes.parseExploreHash('#/explore'), { token: null, linkedPool: null })
  assert.deepEqual(routes.parseExploreHash('#/explore/0x1234'), { token: null, linkedPool: null }, 'not an address: ignored')
  assert.deepEqual(routes.parseExploreHash(`#/explore/0X${'a'.repeat(40)}`), { token: null, linkedPool: null }, 'an upper-case prefix is not the contract’s shape')
  assert.deepEqual(routes.parseExploreHash(`#/pools#${id('A')}`), { token: null, linkedPool: id('a') }, 'the old Pools link opens its pool')
  assert.deepEqual(routes.parseExploreHash(`#/pool/${id('a')}`), { token: null, linkedPool: null }, 'another page’s route is not Explore’s')
  assert.deepEqual(routes.parsePoolHash(`#/pool/${id('A')}/${upper}`), { poolId: id('a'), token: upper })
  assert.deepEqual(routes.parsePoolHash(`#/pool/${id('a')}`), { poolId: id('a'), token: null })
  assert.deepEqual(routes.parsePoolHash(`#/pool/${id('a')}/nope`), { poolId: id('a'), token: null })
  assert.deepEqual(routes.parsePoolHash('#/pool/abc'), { poolId: null, token: null })
  assert.deepEqual(routes.parsePoolHash(`#/pool/${id('a')}#section`), { poolId: id('a'), token: null }, 'the section part is not a segment')
  assert.equal(routes.poolHref(id('a')), `#/pool/${id('a')}`)
  assert.equal(routes.poolHref(id('a'), upper), `#/pool/${id('a')}/${upper}`)
  assert.equal(routes.exploreHref(), '#/markets')
  assert.equal(routes.exploreHref(upper), `#/markets/${upper}`)
  assert.equal(routes.newPositionHref(), '#/new')
  assert.equal(routes.newPositionHref(id('a')), `#/new/${id('a')}`)
  // Added 2026-09-27 (round 6): New position's link can name the token to verify the pool with, as the pool page's does.
  assert.equal(routes.newPositionHref(id('a'), upper), `#/new/${id('a')}/${upper}`)
  assert.deepEqual(routes.parseNewHash(`#/new/${id('a')}/${upper}`), { poolId: id('a'), token: upper })
  assert.deepEqual(routes.parseNewHash(`#/new/${id('a')}`), { poolId: id('a'), token: null })
  assert.deepEqual(routes.parseNewHash(`#/new/${id('a')}/nope`), { poolId: id('a'), token: null })
  assert.deepEqual(routes.parseNewHash(`#/pool/${id('a')}/${upper}`), { poolId: null, token: null })
  // The docs: a section link always carries its route, since a bare #<id> would open Home.
  assert.equal(routes.docsHref(), '#/docs')
  assert.equal(routes.docsHref('non-custodial'), '#/docs/non-custodial')
  assert.equal(routes.docsHref('fees', 'service-fee'), '#/docs/fees#service-fee')
  assert.deepEqual(routes.hashParts(routes.docsHref('fees', 'service-fee')), { segments: ['docs', 'fees'], section: 'service-fee' }, 'what a docs link writes, the route reads back')
  for (const href of [routes.poolHref(id('a'), upper), routes.exploreHref(upper)]) {
    assert.deepEqual(routes.parseExploreHash(href).token ?? routes.parsePoolHash(href).token, upper, 'what a link writes, the page reads back')
  }
})

// Added 2026-09-20. OverviewResponse.acquisitionAccepted is the producer saying
// whether it took the acquisition on at all; false is its capacity ceiling. The
// page read only `acquisition.status`, so a refused batch looked identical to a
// running one: "Collecting data" forever, re-asked every five seconds, for work
// that had not started and could not start until the ceiling drained.
test('a refused acquisition is said, and asked about less often, not more', async () => {
  for (const [accepted, pending, expected, state] of [[true, true, 5_000, 'pending'], [false, true, 30_000, 'at_capacity'], [true, false, 60_000, 'settled']]) {
    const reads = []; const waits = [];
    const data = JSON.parse(readFileSync(resolve(root, '../api-contracts/read-v3/fixtures/overview.json'), 'utf8'));
    const token = data.tokens[0].address;
    data.selectedToken = token; data.requestedPoolIds = []; data.hasMore = false; data.nextAfterPoolId = null;
    data.acquisitionAccepted = accepted;
    data.tokens[0].acquisition = { ...data.tokens[0].acquisition, status: pending ? 'pending' : 'ready' };
    const { StoredTokenExplorer } = load('src/components/read/screens/StoredTokenExplorer.tsx', {
      MarketsContext: { Provider: Container }, overviewRows: () => [row(id('a'))],
      candidateFromToken: (value) => ({ token: { ...value.asset, chainId: 4663 } }),
      readWithin(_s, route, request, options) { const p = deferred(); reads.push({ route, request, options, ...p }); return p.promise; },
      whenVisibleAfter(ms, run) { const wait = { ms, run, cancelled: false }; waits.push(wait); return () => { wait.cancelled = true }; },
    });
    const host = mount(StoredTokenExplorer, { source: { transport: 'bridge' }, token });
    reads[0].resolve({ state: 'ok', route: 'overview', data, provenance: { receivedAt: 1010_000, receivedMonotonic: 0, attempts: 1 } });
    await flush(); host.render();
    assert.equal(waits[0].ms, expected, `accepted=${accepted} pending=${pending}`);
    const markup = renderToStaticMarkup(host.tree);
    assert.match(markup, new RegExp(`data-acquisition="${state}"`), `accepted=${accepted} pending=${pending}`);
    if (state === 'at_capacity') {
      assert.match(markup, /Domino’s data service is busy, so only the pools already stored are shown\./, 'the refusal is said in plain words (audit E19), not left as "Collecting data"');
      assert.doesNotMatch(markup, /Collecting data/, 'nothing is being collected');
    }
    if (state === 'pending') assert.match(markup, /Collecting data/);
    host.unmount();
  }
});

// Added 2026-09-20. HistoryResponse.reason was read by nothing, so a chart that
// could not be built said only "History is unavailable for this pool." and kept
// the cause to itself. The producer's own default reasons restate the status
// (backend/public_history.py), so appending those would say it twice.
test('the history card gives the cause when there is one, and does not restate the status', () => {
  const chart = readFileSync(resolve(root, 'src/components/read/screens/PoolHistoryChart.tsx'), 'utf8');
  // Changed on purpose (2026-09-27, round 6): history_partial restates the missing hours the card names in plain words.
  assert.match(chart, /const RESTATED = \['history_refresh_pending', 'history_acquisition_pending', 'history_partial'\]/);
  assert.match(chart, /data\?\.reason && !RESTATED\.includes\(data\.reason\)/, 'a default reason is not appended');
  assert.match(chart, /data-history-reason=\{data\?\.reason \?\? undefined\}/, 'the raw closed code stays an attribute');
  assert.match(chart, /reasonText\(code\)/, 'the code reaches the page as words, never raw');
  // The provider name must not have come back with rugged's new chart.
  assert.doesNotMatch(chart, /GeckoTerminal\.|USD · GeckoTerminal/, 'no provider name in text a person reads');
  assert.match(chart, /title=\{CANDLES_TITLE\}/, 'one copy of that sentence, shared with the v1 chart');
});

// --- round 6 (2026-09-27): the pool page for someone who knows nothing about liquidity pools -------------------------
// The owner: "Many things there look inactive or unconfigured. Rework the whole page for beginners, keep only what
// matters, and add useful functions." What the page now says in plain words, what it estimates, and how often it asks.

test('round 6: plain words: prices in USDG where the pool holds it, a yearly rate as a person says it, an amount’s earnings', () => {
  const plain = real('src/components/pool/plain.ts')
  const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
  assert.equal(plain.quoteSide([{ address: addr('3') }, { address: USDG }]), 1, 'PONS/USDG: USDG for 1 PONS')
  assert.equal(plain.quoteSide([{ address: USDG }, { address: addr('9') }]), 0, 'USDG/MARLIN: USDG for 1 MARLIN, not the other way round')
  assert.equal(plain.quoteSide([{ address: addr('3') }, { address: addr('9') }]), 1, 'no USDG: the pool’s own order')
  // Added 2026-09-28 (one-sided): ETH comes next, the app's one rule (lib/read/orientation.ts): ETH/MARLIN reads in ETH.
  assert.equal(plain.quoteSide([{ address: addr('0') }, { address: addr('9') }]), 0, 'ETH/MARLIN: ETH for 1 MARLIN')
  assert.equal(plain.quoteSide([{ address: addr('0') }, { address: USDG }]), 1, 'ETH/USDG: USDG for 1 ETH')
  // Changed on purpose 2026-10-01 (audit E21): the one APR rule of every screen (lib/format/apr.ts), so the sentence says
  // the figure its tile shows: one decimal under 100%, whole from there.
  assert.deepEqual([100.35, 32.13, 2.16, 0.05, 1234.5, 0, 99.96].map(plain.aboutPercent), ['100%', '32.1%', '2.2%', 'less than 0.1%', '1,235%', '0%', '100%'])
  assert.deepEqual(['1,000', '$250.5', ' 10 000 ', '0', '-5', 'abc', '1e3', '10000000000'].map(plain.parseAmount), [1000, 250.5, 10000, null, null, null, null, null])
  const month = plain.earnings(1000, 100.35)
  assert.equal(plain.usdText(month.month), '$83.63')
  assert.equal(plain.usdText(month.year), '$1,004', 'whole dollars from $1,000')
  assert.equal(plain.usdText(month.day), '$2.75')
  assert.equal(plain.usdText(0.004), 'less than $0.01')
  // Added 2026-09-28 (round 6 review): money added shares the pool's fees with the money already in it. USDG/MARLIN in
  // the harness: TVL $13.4K at 181.25% a year. $10,000 holds 10/23.4 of the pool then, so about $10.4K a year, $865 a
  // month, where the pool's whole rate on the amount alone said $18,125 and $1,510.
  const marlin = plain.earnings(10_000, 181.25, 13_400)
  assert.deepEqual([plain.usdText(marlin.month), plain.usdText(marlin.year)], ['$864.94', '$10,379'])
  assert.ok(Math.abs(marlin.year - (1.8125 * 13_400 * 10_000) / 23_400) < 1e-9)
  assert.equal(plain.usdText(plain.earnings(10_000, 181.25).month), '$1,510', 'with no TVL, the pool’s rate alone')
  assert.equal(plain.usdText(plain.earnings(10_000, 181.25, 0).month), '$1,510', 'a TVL of nothing is no TVL')
  const crumb = plain.earnings(100, 181.25, 13_400).year
  assert.ok(crumb < 181.25 && crumb > 179.9, 'a small amount barely dilutes it: $179.91 a year where the plain rate says $181.25')
  assert.deepEqual([[0.62, 0.67], [0.67, 0.62], [1, 1.0004]].map(([a, b]) => plain.moveWords(a, b)), ['rose 8.1%', 'fell 7.5%', 'barely moved'])
})

test('round 6: a typical range reads low to high in the page’s direction, with how far each end is from the price now', () => {
  const plain = real('src/components/pool/plain.ts')
  // PONS/USDG (18 and 6 decimals, USDG second): the pool's own order.
  const forward = plain.rangeGuide({ lower: -3600, upper: 4080 }, 0, [6, 6], 1)
  assert.deepEqual([forward.low, forward.high, forward.below, forward.above], ['0.697689', '1.50378', '−30%', '+50%'])
  // USDG first in the pool: the same ticks read the other way round, the pool's upper tick the low end.
  const flipped = plain.rangeGuide({ lower: -4080, upper: 3600 }, 0, [6, 6], 0)
  assert.deepEqual([flipped.low, flipped.high, flipped.below, flipped.above], ['0.697689', '1.50378', '−30%', '+50%'])
  assert.ok(flipped.values.low < flipped.values.now && flipped.values.now < flipped.values.high)
  assert.equal(plain.rangeGuide({ lower: -60, upper: 60 }, 0, [0, 40], 1), null, 'a price that cannot be written draws no range')
  // Added 2026-09-28 (one-sided): the preset the page draws is taken on its own price (presetFor), so a USDG-first pool
  // reads −30% and +50% too, at any tick.
  const { presetFor } = real('src/lib/read/screens/poolRange.ts')
  const usdgFirst = { tick: 338460, tickSpacing: 60, inverted: true }
  const guided = plain.rangeGuide(presetFor(usdgFirst, 'standard'), 338460, [6, 18], 0)
  assert.deepEqual([guided.below, guided.above], ['−30%', '+50%'])
  assert.ok(guided.values.low < guided.values.now && guided.values.now < guided.values.high)
  const day = plain.daySpan({ candles: [{ startTimestamp: 0, high: '2', low: '1', close: '1.5' }, { startTimestamp: 3600, high: '3', low: '1.2', close: '2.5' }], requestedWindow: { startTimestamp: 0 }, resolutionSeconds: 3600 }, addr('1'))
  assert.deepEqual(day, { base: addr('1'), low: '1', high: '3', first: '1.5', last: '2.5', whole: true })
})

test('round 6: the earnings estimate says a month, a year and a day at the pool’s rate, and one calm line without one', () => {
  const { PoolEarnings } = real('src/components/pool/PoolEarnings.tsx')
  const text = (props) => renderToStaticMarkup(React.createElement(PoolEarnings, props)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  const ready = text({ apr: 100.35, tvl: null, loading: false })
  assert.match(ready, /If you put in/)
  assert.match(ready, /You could earn about \$83\.63 a month/)
  assert.match(ready, /\$1,004 a year · \$2\.75 a day/)
  assert.match(ready, /At the pool’s recent rate, about 100% a year\./)
  assert.match(ready, /Fees are earned only inside your range/)
  const disclosure = renderToStaticMarkup(React.createElement(PoolEarnings, { apr: 100.35, tvl: null, loading: false }))
  assert.match(disclosure, /<details class="dm-pool-disclosure" data-pool-earnings-basis="">/, 'secondary estimates stay in a closed disclosure')
  assert.doesNotMatch(disclosure, /<details[^>]+open/)
  assert.match(renderToStaticMarkup(React.createElement(PoolEarnings, { apr: 100.35, tvl: null, loading: false })), /data-pool-earnings="ready"/)
  // Added 2026-09-28 (round 6 review): with the pool's TVL the amount shares its fees, and the note says with how much.
  const shared = text({ apr: 181.25, tvl: 13_400, loading: false })
  assert.match(shared, /You could earn about \$140\.55 a month/, '$1,000 in a $13.4K pool: 1.8125 × 13,400 × 1,000 / 14,400')
  assert.match(shared, /\$1,687 a year/)
  assert.match(shared, /At the pool’s recent rate, about 181% a year, shared with the \$13\.4K already in the pool\./)
  assert.match(text({ apr: 100, tvl: null, loading: false, saved: true }), /Estimate from saved figures/)
  // Changed on purpose (2026-09-28, round 6 review): with no rate there is nothing to type, and no "yet": a rate refused
  // for a lasting reason (a protocol fee, say) never comes.
  const none = renderToStaticMarkup(React.createElement(PoolEarnings, { apr: null, tvl: 13_400, loading: false }))
  assert.match(none, /data-pool-earnings="none"/)
  assert.match(none.replace(/<[^>]+>/g, ''), /There’s no recent fee rate for this pool to estimate from\./)
  assert.doesNotMatch(none, /<input|<button|yet/, 'no amount to type and no presets without a rate')
  assert.doesNotMatch(text({ apr: null, tvl: null, loading: false }), /You could earn|a month|If you put in/, 'no figure without a rate')
  const resting = renderToStaticMarkup(React.createElement(PoolEarnings, { apr: null, tvl: null, loading: true }))
  assert.match(resting, /data-pool-earnings="loading"/)
  assert.match(resting, /dm-skel/)
  assert.doesNotMatch(text({ apr: 5, tvl: null, loading: false }), /Retry|again|Refresh/i)
})

test('round 6: a typical range draws the band, the price now and the last day, and says whether the day stayed inside', () => {
  const { PoolRangeGuide } = real('src/components/pool/PoolRangeGuide.tsx')
  const plain = real('src/components/pool/plain.ts')
  const guide = plain.rangeGuide({ lower: -3600, upper: 4080 }, 0, [6, 6], 1)
  const draw = (day) => renderToStaticMarkup(React.createElement(PoolRangeGuide, { guide, day, unit: 'USDG for 1 PONS' }))
  const inside = draw({ base: addr('1'), low: '0.9', high: '1.1', first: '1', last: '1.05', whole: true })
  assert.match(inside, /data-pool-range-guide="ready"/)
  assert.match(inside.replace(/<[^>]+>/g, ''), /This starting range is 30% below the pool price to 50% above it\./)
  assert.match(inside, /Over the last day the price stayed inside it\./)
  assert.match(inside, /<details class="dm-pool-disclosure" data-pool-range-basis="">/, 'range method is a closed disclosure')
  assert.match(inside, /class="dm-pool-guide-day"/)
  const outside = draw({ base: addr('1'), low: '0.5', high: '1.1', first: '1', last: '1.05', whole: true })
  assert.match(outside.replace(/<[^>]+>/g, ''), /Over the last day the price went past it at times\./)
  const noDay = draw(null)
  assert.doesNotMatch(noDay, /dm-pool-guide-day|last day/i, 'no day, no claim about it')
  const none = renderToStaticMarkup(React.createElement(PoolRangeGuide, { guide: null, day: null, unit: '' }))
  assert.match(none, /data-pool-range-guide="none"/)
  assert.match(none, /This pool’s price can’t be drawn as a range here\./)
})

test('round 6: what Domino can do in a pool: the three features with their fees where a position can be opened, one line where not', () => {
  const { PoolAutomation } = real('src/components/pool/PoolAutomation.tsx')
  const yes = renderToStaticMarkup(React.createElement(PoolAutomation, { usable: true, why: '' }))
  const text = yes.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  assert.match(yes, /data-pool-automation="available"/)
  assert.match(text, /Plain position No service fee Fees wait in the position until you collect them\./)
  assert.match(text, /Auto-compound 2% of fees Fees go back into the same position\./)
  assert.match(text, /Domino-compound 4% of fees Fees can fund the next range one step higher\./)
  assert.deepEqual([...yes.matchAll(/href="([^"]+)"/g)].map(([, href]) => href), ['#/docs/earned-fees', '#/docs/auto-compound', '#/docs/domino-compound'])
  const no = renderToStaticMarkup(React.createElement(PoolAutomation, { usable: false, why: 'it runs extra code on every swap (hooks)' }))
  assert.match(no, /data-pool-automation="unavailable"/)
  assert.match(no.replace(/<[^>]+>/g, ''), /Domino can’t open positions in this pool: it runs extra code on every swap \(hooks\)\./)
  assert.doesNotMatch(no, /Auto-compound|href=/)
})

test('round 6: recent activity is the last day in words, from the chain where it can, from the 24h volume where it cannot', () => {
  const { PoolActivitySummary } = real('src/components/pool/PoolActivitySummary.tsx')
  const draw = (props) => renderToStaticMarkup(React.createElement(PoolActivitySummary, { option: fixturePool(), now: { wall: 0 }, day: null, usd: null, volume: '$6.2M', loading: false, listed: true, ...props }))
  const words = (html) => markupText(html)
  const chain = draw({ read: okRead('pool-activity', 'pool-activity.success') })
  assert.match(chain, /data-pool-activity-summary="ready"/)
  assert.match(words(chain), /4 swaps in the last 24 hours, worth about \$6\.2M ?\./)
  // Changed on purpose 2026-10-01 (audit E7): an amount under a millionth reads as one.
  assert.match(words(chain), /People who provide the pool’s money earned &lt;0\.000001 ETH and 300 TOKEN in fees\./, 'in each token without USDG')
  // With USDG in the pool, its fees in dollars at the pool's own price: 300 TOKEN at $1 plus the ETH side at 2,000.
  assert.match(words(draw({ read: okRead('pool-activity', 'pool-activity.success'), usd: { usdgIndex: 1, price: 2000 } })), /earned about \$300\.00 in fees\./)
  const day = { base: NATIVE, low: '1', high: '2', first: '1.6', last: '1.2', whole: true }
  assert.match(words(draw({ read: okRead('pool-activity', 'pool-activity.success'), day })), /The price fell 25% over the last day\./)
  // Added 2026-09-28 (round 6 review follow-up): swaps that paid the providers nothing say so, never "earned about $0.00".
  const unpaid = okRead('pool-activity', 'pool-activity.success', (body) => ({ ...body, window24h: { ...body.window24h, lpFeesRaw: ['0', '0'] }, fees: { ...body.fees, accounting: { ...body.fees.accounting, lpFeesRaw: ['0', '0'] } } }))
  for (const usd of [null, { usdgIndex: 1, price: 2000 }]) {
    const said = words(draw({ read: unpaid, usd }))
    assert.match(said, /These swaps paid no fees to the people who provide the pool’s money\./)
    assert.doesNotMatch(said, /earned|\$0\.00/)
  }
  // No chain activity for this pool: the volume still speaks, and nothing says why on the page.
  const refused = { state: 'unavailable', cause: { kind: 'producer', code: 'activity_pool_not_registered', status: 503 }, retryable: false }
  const market = draw({ read: refused })
  assert.match(words(market), /People swapped about \$6\.2M here in the last 24 hours\./)
  assert.doesNotMatch(words(market), /not registered|indexed|Unavailable/i)
  assert.match(draw({ read: null }), /data-pool-activity-summary="loading"/, 'rests while the chain read is out, so no sentence is swapped for another')
  const nothing = draw({ read: refused, volume: null })
  assert.match(nothing, /data-pool-activity-summary="none"/)
  assert.match(words(nothing), /Recent activity for this pool isn’t available right now\./)
})

test('round 6: the page asks the stored overview again every 5 s only while the pool is collected, else once a minute', async () => {
  for (const [acquisition, accepted, expected] of [['pending', true, 5_000], ['pending', false, 30_000], ['ready', true, 60_000]]) {
    const reads = []; const waits = []
    const source = { transport: 'bridge', supportsStoredReads: true, routeEnabled: async (route) => ({ state: route === 'overview' ? 'enabled' : 'not_enabled' }) }
    const { PoolWorkspace, OVERVIEW_EVERY } = load('PoolWorkspace', {
      readWithin(_s, route, request, options) { const p = deferred(); reads.push({ route, request, options, ...p }); return p.promise },
      whenVisibleAfter(ms, run) { const wait = { ms, run }; waits.push(wait); return () => {} },
      storedPoolRead: () => ({ state: 'ok', data: { poolId: id('a') } }), overviewPoolOption: () => null,
    })
    assert.deepEqual(OVERVIEW_EVERY, { collecting: 5_000, refused: 30_000, settled: 60_000 })
    const host = mount(PoolWorkspace, { source, option: option('a'), onOption() {} })
    await flush(); host.render()
    assert.deepEqual(reads.map(({ route, request }) => [route, request]), [['overview', { poolIds: [id('a')] }]])
    reads[0].resolve({ state: 'ok', data: { acquisitionAccepted: accepted, pools: [{ poolId: id('a'), acquisition: { status: acquisition } }], generatedAt: 1 }, provenance: {} })
    await flush(); host.render()
    assert.deepEqual(waits.map(({ ms }) => ms), [expected], `${acquisition}, accepted ${accepted}`)
    host.unmount()
  }
})

test('round 6: the page opens with what the pool is and what it earns, and gives the estimate the pool’s own rate', async () => {
  const projectMarketRow = ({ market }) => ({ ...row(market.data.poolId), feeAprEstimate: { data: { feeAprEstimate24hPercent: '100.349999941681629604' }, receivedAt: 0 } })
  const fixture = workspace({ dependencies: { projectMarketRow } }); const host = mount(fixture.PoolWorkspace, fixture.props)
  assert.equal(part(host, 'PoolEarnings').props.apr, null)
  assert.equal(part(host, 'PoolEarnings').props.loading, true, 'resting while the figures are read')
  fixture.reads[0].resolve(ok()); await flush(); host.render()
  const intro = elements(host.tree, (node) => node.props?.['data-pool-intro'] === '')[0]
  assert.match(renderToStaticMarkup(intro).replace(/<[^>]+>/g, ''), /^Add tokens to share the fees when people swap {2}and \.$/, 'symbols are stubbed out here; APR is not repeated in the intro')
  assert.equal(part(host, 'PoolEarnings').props.apr, 100.349999941681629604)
  assert.equal(part(host, 'PoolAutomation').props.usable, true)
  assert.equal(part(host, 'PoolHistoryChart').props.quote, 1, 'the chart opens on the page’s direction')
  assert.equal(typeof part(host, 'PoolHistoryChart').props.onDay, 'function')
  const details = elements(host.tree, (node) => node.props?.['data-pool-details'] === '')[0]
  assert.equal(details.type, 'details', 'everything technical is in one closed Details')
  assert.equal(details.props.open, undefined)
  host.unmount()

  // A pool Domino cannot open a position in says why, with no New position anywhere on its cards.
  // Changed on purpose (2026-09-28, round 6 review): and it has no earnings estimate or typical range, which could only
  // say it has no rate or talk of creating a position there; what Domino can do here carries the row beside the chart.
  const refusals = [
    [{ hooks: addr('a'), integration: 'requires_separate_adapter' }, 'it runs extra code on every swap (hooks)'],
    [{ feePips: 8388608, fee: 'Dynamic', integration: 'requires_separate_adapter' }, 'its fee changes over time'],
  ]
  for (const [refused, why] of refusals) {
    // As the read service answers for such a pool: its figures, and no estimate (hooked_pool_unsupported and the like).
    const hooked = workspace({ option: { ...option('a'), ...refused } }); const page = mount(hooked.PoolWorkspace, hooked.props)
    hooked.reads[0].resolve(ok()); await flush(); page.render()
    assert.match(visibleText(page), /APR +Not estimated for this pool/, 'under its APR dash (the estimate, stubbed here), words that say it never comes')
    assert.deepEqual(part(page, 'PoolAutomation').props, { usable: false, why })
    assert.equal(part(page, 'PoolEarnings'), undefined, 'no estimate that can never answer')
    assert.equal(part(page, 'PoolRangeGuide'), undefined, 'no typical range beside “Domino can’t open positions”')
    assert.match(page.tree.props.className, /dm-pool-layout--follow/, 'the grid without those two cards')
    assert.doesNotMatch(renderToStaticMarkup(page.tree), /create a position|Estimate your earnings|A typical range/i)
    page.unmount()
  }
  // A pool Domino can open positions in keeps both, on the plain grid, and the estimate gets the pool's TVL.
  const open = workspace({ dependencies: { projectMarketRow } }); const usable = mount(open.PoolWorkspace, open.props)
  open.reads[0].resolve(ok()); await flush(); usable.render()
  assert.ok(part(usable, 'PoolEarnings') && part(usable, 'PoolRangeGuide'))
  assert.equal(part(usable, 'PoolEarnings').props.tvl, 42, 'the TVL figure the page shows, as a number')
  assert.equal(usable.tree.props.className, 'dm-pool-layout')
  assert.doesNotMatch(visibleText(usable), /Not estimated/)
  usable.unmount()
})

test('saved-data labels name only retained displayed figures; missing, partial and qualified values do not become saved data', async () => {
  for (const [state, value, expected] of [['stale', '42', true], ['stale', null, false], ['unavailable', '42', false], ['partial', '42', false], ['qualified', '0', false]]) {
    const fixture = workspace({ dependencies: { projectMarketRow: ({ market }) => ({ ...row(market.data.poolId), tvlUsd: { ...metric, state, value }, feeAprEstimate: { data: { feeAprEstimate24hPercent: '10' }, receivedAt: 0 } }) } })
    const host = mount(fixture.PoolWorkspace, fixture.props)
    fixture.reads[0].resolve(ok()); await flush(); host.render()
    const label = elements(host.tree, (node) => node.props?.['data-saved-data'] === 'figures')
    assert.equal(label.length, expected ? 1 : 0, `${state}, ${value}`)
    assert.equal(part(host, 'PoolEarnings').props.saved, expected, 'only a retained input actually used by the estimate is labelled saved')
    if (expected) {
      assert.match(renderToStaticMarkup(label[0]), /Saved figures: TVL\./)
      assert.match(label[0].props.title, /retrieved 12 s ago/, 'the original observation time remains accessible')
    }
    host.unmount()
  }
  const stalePrice = workspace({ dependencies: { poolPrice: () => ({ state: 'usable', tick: 0, tickSpacing: 60, text: '≈1', base: token('1'), quote: token('2'), inverted: false, decimals: [18, 18], block: 700, stale: true, partial: false }) } })
  const host = mount(stalePrice.PoolWorkspace, stalePrice.props)
  assert.match(visibleText(host), /Saved pool price/, 'the on-chain price has its own freshness label')
  assert.equal(part(host, 'PoolRangeGuide').props.saved, true)
  assert.equal(elements(host.tree, (node) => node.props?.['data-saved-data'] === 'figures').length, 0, 'a saved price never labels unrelated figures as saved')
  host.unmount()
})

test('round 6: the pool page’s button is “Create a position”, into the same New position flow with the pool chosen', async () => {
  const previous = globalThis.window
  const { PoolDetail, verifications } = poolPage(`#/pool/${id('a')}`)
  const host = mount(PoolDetail, { poolId: id('a') })
  try {
    verifications[0].resolve({ failure: null, option: option('a'), restarted: false }); await flush(); host.render()
    const [button] = elements(part(host, 'PoolWorkspace').props.actions, (node) => node.type === parts.LinkButton)
    assert.deepEqual([button.props.children, button.props.href], ['Create a position', `#/new/${id('a')}`])
  } finally { host.unmount(); globalThis.window = previous }
})

// Added 2026-09-28 (round 6 review): the typical range used to be worked out once, when the pool was checked, while the
// price moved on with every read; past one of its ends the sentence read "−9% above it". It is now drawn on the price now.
test('round 6: the typical range is worked out on the price now, so a price that moved past an end still reads −30% to +50%', async () => {
  // Changed on purpose 2026-09-28 (one-sided): the page's preset is presetFor, the real one.
  const { presetFor } = real('src/lib/read/screens/poolRange.ts')
  const usablePrice = (chosen) => ({ state: 'usable', tick: chosen.tick, tickSpacing: chosen.tickSpacing, text: '≈1', base: token('1'), quote: token('2'), inverted: false, decimals: [6, 6], block: 700, stale: false, partial: false })
  const fixture = workspace({ dependencies: { presetFor, poolPrice: usablePrice } })
  const host = mount(fixture.PoolWorkspace, fixture.props)
  fixture.reads[0].resolve(ok()); await flush(); host.render()
  const at = () => { const { guide } = part(host, 'PoolRangeGuide').props; return [guide.below, guide.above, guide.values.low < guide.values.now && guide.values.now < guide.values.high] }
  assert.deepEqual(at(), ['−30%', '+50%', true])
  // The price rises 65% (tick 5000), past the upper end of the range it opened on (tick 4080).
  host.props = { ...host.props, option: { ...option('a'), tick: 5000 } }; host.render()
  assert.deepEqual(at(), ['−30%', '+50%', true], 'measured from the price now, never "−9% above it"')
  // And falls 40% (tick −5100), past the lower end it opened on (tick −3600).
  host.props = { ...host.props, option: { ...option('a'), tick: -5100 } }; host.render()
  assert.deepEqual(at(), ['−30%', '+50%', true], 'never "+5% below it"')
  assert.match(renderToStaticMarkup(React.createElement(real('src/components/pool/PoolRangeGuide.tsx').PoolRangeGuide, { ...part(host, 'PoolRangeGuide').props, unit: 'USDG for 1 PONS' })).replace(/<[^>]+>/g, ''), /30% below the pool price to 50% above it\./)
  host.unmount()
})

// 2026-09-27 (round 6, finishing the pool page): the range guide and the recent activity keep the last day in the page's
// direction. A day the chart hears while a person has flipped it the other way round is not that, and must not wipe it.
test('round 6: the last day heard with the chart flipped the other way round leaves the page’s own last day in place', async () => {
  const fixture = workspace(); const host = mount(fixture.PoolWorkspace, fixture.props)
  fixture.reads[0].resolve(ok()); await flush(); host.render()
  const hear = part(host, 'PoolHistoryChart').props.onDay
  const own = { base: addr('1'), low: '0.9', high: '1.1', first: '1', last: '1.05', whole: true }
  hear(own); host.render()
  assert.deepEqual(part(host, 'PoolRangeGuide').props.day, own, 'the page’s direction: token 1 priced in token 2')
  assert.deepEqual(part(host, 'PoolActivitySummary').props.day, own)
  hear({ base: addr('2'), low: '0.91', high: '1.11', first: '1', last: '0.95', whole: true }); host.render()
  assert.deepEqual(part(host, 'PoolRangeGuide').props.day, own, 'the flipped day is not kept over it')
  assert.deepEqual(part(host, 'PoolActivitySummary').props.day, own)
  host.unmount()
})

// --- the pool page, audit 2026-10-01: B8, A12, A25, I1, B2 ---

/** A pool page over a source that lists the stored overview, its reads deferred. */
function storedPoolPage(hash, dependencies = {}) {
  const reads = []
  const waits = []
  const source = { transport: 'bridge', supportsStoredReads: true, routeEnabled: async () => ({ state: 'enabled' }) }
  const page = poolPage(hash, {
    useReadSource: () => source,
    readWithin(_source, route, request) { const pending = deferred(); reads.push({ route, request, ...pending }); return pending.promise },
    whenVisibleAfter(ms, run) { const wait = { ms, run, cancelled: false }; waits.push(wait); return () => { wait.cancelled = true } },
    overviewPoolOption: (overview) => overview.data.option ?? null,
    ...dependencies,
  })
  return { ...page, reads, waits }
}
const overviewOk = (data) => ({ state: 'ok', route: 'overview', data: { generatedAt: 1000, acquisitionAccepted: true, pools: [], ...data }, provenance: { receivedAt: 1 } })

test('B8: a link that names no token rests until the list answers, then is verified by its id alone and opens with the pool’s own currencies', async () => {
  const previous = globalThis.window
  let featured = { source: 'bundled', entries: [], listId: null, settled: false, withdrawn: new Set() }
  const { PoolDetail, reads, verifications } = storedPoolPage(`#/pool/${id('b')}`, { useFeatured: () => featured })
  const host = mount(PoolDetail, { poolId: id('b') })
  try {
    await flush(); host.render()
    assert.equal(elements(host.tree, (node) => node.type?.name === 'Pending').length, 1, 'the resting page, never a false message')
    assert.equal(part(host, 'EmptyState'), undefined)
    assert.equal(reads.length, 0, 'nothing read before the list answers')
    featured = { ...featured, settled: true }
    host.render(); await flush(); host.render()
    assert.deepEqual(reads.map(({ route, request }) => [route, request]), [['overview', { poolIds: [id('b')] }]], 'by its id alone')
    reads[0].resolve(overviewOk({ option: option('b') })); await flush(); host.render()
    assert.equal(part(host, 'PoolWorkspace').props.option.key, id('b'))
    assert.equal(verifications.length, 0)
  } finally { host.unmount(); globalThis.window = previous }
})

test('B8: without the stored overview a link that names no token says so in plain words, with no hex id', async () => {
  const previous = globalThis.window
  const { PoolDetail } = poolPage(`#/pool/${id('b')}`)
  const host = mount(PoolDetail, { poolId: id('b') })
  try {
    const empty = part(host, 'EmptyState')
    assert.equal(empty.props.title, 'Open this pool from Markets')
    assert.doesNotMatch(String(empty.props.body), /selected six|32-byte|0x/)
    const bad = poolPage('#/pool/not-a-pool')
    const junk = mount(bad.PoolDetail, { poolId: 'not-a-pool' })
    assert.doesNotMatch(String(part(junk, 'EmptyState').props.body), /32-byte/)
    junk.unmount()
  } finally { host.unmount(); globalThis.window = previous }
})

test('A12: a pool still being collected says so, is checked on chain once so it can open, and is asked again at the store’s pace, a bounded number of times', async () => {
  const previous = globalThis.window
  const pendingPool = (nextAttemptAt) => ({ poolId: id('a'), acquisition: { status: 'pending', refreshing: false, reason: null, nextAttemptAt } })
  // The pools route confirms it on the first pending answer: the page opens.
  const opened = storedPoolPage(`#/pool/${id('a')}`)
  let host = mount(opened.PoolDetail, { poolId: id('a') })
  try {
    await flush(); host.render()
    opened.reads[0].resolve(overviewOk({ pools: [pendingPool(1010)] })); await flush(); host.render()
    const pending = elements(host.tree, (node) => node.type?.name === 'Pending')[0]
    assert.equal(pending.props.note, 'collecting', 'said in plain words')
    assert.equal(opened.verifications.length, 1, 'checked on chain through the pools route')
    opened.verifications[0].resolve({ failure: null, option: option('a'), restarted: false }); await flush(); host.render()
    assert.equal(part(host, 'PoolWorkspace').props.option.key, id('a'), 'it opens while the store collects it')
  } finally { host.unmount() }
  // Not confirmed: asked again at the store's next attempt plus a margin, 5 s at the soonest, 30 s at the most; 30 s at capacity.
  const waiting = storedPoolPage(`#/pool/${id('a')}`)
  host = mount(waiting.PoolDetail, { poolId: id('a') })
  try {
    await flush(); host.render()
    waiting.reads[0].resolve(overviewOk({ pools: [pendingPool(1010)] })); await flush(); host.render()
    waiting.verifications[0].resolve({ failure: null, option: null, restarted: false }); await flush(); host.render()
    assert.deepEqual(waiting.waits.map((wait) => wait.ms), [11_500], 'the store’s own next attempt, 10 s on, plus 1.5 s')
    for (let attempt = 1; attempt < 12; attempt += 1) {
      waiting.waits.at(-1).run(); host.render(); await flush(); host.render()
      waiting.reads.at(-1).resolve(overviewOk({ acquisitionAccepted: attempt % 2 === 0, pools: [pendingPool(1500)] })); await flush(); host.render()
    }
    assert.equal(waiting.verifications.length, 1, 'checked on chain once, not at every ask')
    assert.deepEqual(waiting.waits.slice(1).map((wait) => wait.ms), Array(10).fill(30_000), 'at capacity 30 s; a far collection 30 s at the most')
    assert.equal(waiting.reads.length, 12, 'twelve asks at the most')
    const last = elements(host.tree, (node) => node.type?.name === 'Pending')[0]
    assert.equal(last.props.verifying, false)
    assert.equal(last.props.reason.code, 'collecting')
  } finally { host.unmount(); globalThis.window = previous }
})

test('A25: a copy already painted stays on screen through a failure that can clear by itself; one that cannot shows the dashes', async () => {
  const previous = globalThis.window
  const copied = { route: 'overview', state: 'ok', data: { pools: [] }, provenance: { receivedAt: 1 } }
  for (const [failure, painted] of [[{ state: 'busy', retryAfterSeconds: 5 }, true], [{ state: 'invalid', reason: 'response_contract' }, false]]) {
    const { PoolDetail, verifications } = poolPage(`#/pool/${id('a')}`, {
      appPaint: { load: () => null },
      paintedPool: () => ({ overview: copied, option: { ...option('a'), block: 600 } }),
      isTransient: (outcome) => outcome.state === 'busy',
    })
    const host = mount(PoolDetail, { poolId: id('a') })
    try {
      verifications[0].resolve({ failure, option: null, restarted: false }); await flush(); host.render()
      assert.equal(part(host, 'PoolWorkspace') !== undefined, painted, failure.state)
      if (!painted) assert.equal(elements(host.tree, (node) => node.type?.name === 'Pending')[0].props.verifying, false)
    } finally { host.unmount() }
  }
  globalThis.window = previous
})

test('I1 and B2: a pool with a token that passes for USDG, or one the list withdrew for safety, opens with a plain warning and no way into New position', async () => {
  const previous = globalThis.window
  const fake = { ...option('a'), currencies: [token('1'), { ...token('2'), symbol: 'USDG' }] }
  const warnings = {
    poolWarning: (tokens) => (tokens.some((t) => t.symbol === 'USDG') ? { kind: 'lookalike', address: addr('2'), main: 'USDG' } : null),
    warningText: () => 'This isn’t the USDG Domino uses. Adding money to this pool can lose it.',
  }
  try {
    const look = poolPage(`#/pool/${id('a')}`, warnings)
    let host = mount(look.PoolDetail, { poolId: id('a') })
    look.verifications[0].resolve({ failure: null, option: fake, restarted: false }); await flush(); host.render()
    let workspace = part(host, 'PoolWorkspace')
    assert.equal(workspace.props.actions, undefined, 'no Create a position')
    assert.match(renderToStaticMarkup(workspace.props.notice), /data-pool-warning="lookalike"[^>]*>This isn’t the USDG Domino uses\. Adding money to this pool can lose it\./)
    host.unmount()

    const withdrawn = poolPage(`#/pool/${id('a')}`, { useFeatured: () => ({ source: 'server', entries: [], listId: 'x', settled: true, withdrawn: new Set([id('a')]) }) })
    host = mount(withdrawn.PoolDetail, { poolId: id('a') })
    withdrawn.verifications[0].resolve({ failure: null, option: option('a'), restarted: false }); await flush(); host.render()
    workspace = part(host, 'PoolWorkspace')
    assert.equal(workspace.props.actions, undefined, 'withdrawn for safety: no way into New position, as New position refuses its link')
    assert.match(renderToStaticMarkup(workspace.props.notice), /data-pool-warning="withdrawn"/)
    host.unmount()

    // A pool on neither list: its page names both contracts in full, and keeps its way into New position.
    const off = poolPage(`#/pool/${id('b')}/${addr('7')}`)
    host = mount(off.PoolDetail, { poolId: id('b') })
    off.verifications[0].resolve({ failure: null, option: option('b'), restarted: false }); await flush(); host.render()
    workspace = part(host, 'PoolWorkspace')
    const notice = renderToStaticMarkup(workspace.props.notice)
    assert.match(notice, /Not on Domino’s list/)
    assert.ok(notice.includes(addr('1')) && notice.includes(addr('2')), 'both contracts in full')
    assert.notEqual(workspace.props.actions, undefined)
    host.unmount()
  } finally { globalThis.window = previous }
})

test('B8: a token-less link whose overview cannot be asked for good says how to open the pool; one that failed in passing is asked again', async () => {
  const previous = globalThis.window
  try {
    for (const [outcome, says] of [[{ state: 'not_connected' }, true], [{ state: 'busy', retryAfterSeconds: 5 }, false]]) {
      const asks = []
      const source = { transport: 'bridge', supportsStoredReads: true, routeEnabled: async (route) => (route === 'overview' ? { state: 'failed', outcome } : { state: 'enabled' }) }
      const { PoolDetail } = poolPage(`#/pool/${id('b')}`, {
        useReadSource: () => source,
        askAgainLater(failure, attempt, signal) { const pending = deferred(); asks.push({ failure, attempt, signal, ...pending }); return pending.promise },
      })
      const host = mount(PoolDetail, { poolId: id('b') })
      await flush(); host.render()
      if (says) {
        assert.equal(part(host, 'EmptyState').props.title, 'Open this pool from Markets', outcome.state)
        assert.equal(asks.length, 0)
      } else {
        assert.equal(elements(host.tree, (node) => node.type?.name === 'Pending')[0].props.verifying, false, outcome.state)
        assert.equal(asks.length, 1, 'asked again on its own')
      }
      host.unmount()
    }
  } finally { globalThis.window = previous }
})
