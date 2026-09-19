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
const option = (letter) => ({ key: id(letter), currencies: [token('1'), token('2')], fee: '0.3%', tickSpacing: 60, hooks: addr('0'), block: 700, tick: 0, sqrtPriceX96: '79228162514264337593543950336', aprReason: 'reconciled_fee_history_unavailable' })
const metric = { value: '42', state: 'provider', source: 'GeckoTerminal', asOf: 1000 }
const row = (poolId) => ({ poolId, tokens: { base: token('1'), quote: token('2') }, tvlUsd: metric, volume24hUsd: metric, provenance: { block: 700, market: { status: 'available', receivedAt: 0, ageSeconds: 0, cacheAgeSeconds: 0, freshForSeconds: 60 } } })
const Container = ({ children }) => React.createElement('div', null, children)
const stub = (name) => Object.defineProperty(() => null, 'displayName', { value: name })
const parts = Object.fromEntries([
  'PoolPicker', 'PoolSelectionDialog', 'PoolWorkspace', 'TokenPicker', 'TokenLookup', 'CatalogueCandidates', 'WalletCandidates', 'PoolPriceChart', 'PoolRangeControls',
  'PoolAprEstimate', 'PoolCatalogueIdentity', 'PoolTokenLabel', 'TokenMark', 'TokenMarkPair', 'SymbolText', 'Address', 'MetricCell', 'TurnoverCell', 'Tabs', 'Skeleton',
  'CopyButton', 'ProviderFigure', 'EmptyState', 'LinkButton', 'SelectedPoolsTable', 'TokensTable', 'SearchField', 'PageHeader', 'PoolActivityCard', 'PoolPositionsCard',
].map((name) => [name, stub(name)]))

// Deterministic effect harness around the actual component source. It models
// state, dependency cleanup and unmount; it does not simulate a browser or
// claim provider/contract acceptance. The read boundary is a deferred stub.
let active
const hooks = {
  useState(initial) { const host = active, index = host.cursor++; if (!(index in host.values)) host.values[index] = typeof initial === 'function' ? initial() : initial; return [host.values[index], (value) => { host.writes++; host.values[index] = typeof value === 'function' ? value(host.values[index]) : value }] },
  useRef(initial) { const host = active, index = host.cursor++; return host.values[index] ??= { current: initial } },
  useCallback(callback, deps) { const host = active, index = host.cursor++; const prior = host.memo[index]; if (!prior || deps.some((d, i) => !Object.is(d, prior.deps[i]))) host.memo[index] = { callback, deps }; return host.memo[index].callback },
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
    // A stat renders its label, value and source line as text, so attribution can be checked as visible words.
    Stat: ({ label, children, sub }) => React.createElement('div', null, label, ' ', children, ' ', sub ?? null),
    useNow: () => ({ wall: 1001000, monotonic: 0 }), agedMarket: (market) => market,
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
    poolPrice: () => ({ state: 'usable', tick: 0, tickSpacing: 60, text: '≈1', base: token('1'), quote: token('2'), block: 700, stale: false, partial: false }), presetRange: () => ({ lower: -60, upper: 60 }),
    selectable: (candidate) => candidate.why === null, whyText: () => null, reasonText: (code) => String(code), activityFacts: (data) => data,
    COPY: { range: { problems: { decimals_unknown: 'Decimals unknown', tick_mismatch: 'Tick mismatch', not_initialized: 'Not initialised', beyond_display: 'Beyond display' } }, picker: { hookless: 'No hooks, fixed fee', needsAdapter: 'Needs a separate adapter', partialMetadata: '', providerConflict: '', checking: 'Checking…' }, figures: { activityLoading: '' }, selection: { decimalsUnavailable: 'decimals unavailable' } },
    // An entry with no addresses keeps its order (read.test.mjs checks inPoolOrder itself).
    SELECTED_POOL_CATALOGUE: [{ poolId: id('a'), labels: ['A', 'B'], fee: '0.3%', artwork: [null, null] }], SELECTED_POOLS_COMMON_TOKEN: addr('5'), inPoolOrder: (entry) => entry,
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
  const props = { source, option: chosen, range: null, onOption() {}, onRange() {} }
  return { ...module, reads, asks, checks, props }
}
const visibleText = (host) => renderToStaticMarkup(host.tree).replace(/<[^>]+>/g, '')
const lean = { poolId: id('a'), includePriceHistory: false }
const ok = (extra = {}) => ({ state: 'ok', data: { poolId: id('a') }, ...extra })
const unavailable = { state: 'unavailable', cause: { kind: 'producer', code: 'upstream_unavailable', status: 503 }, retryable: true }
/** Every dash the page drew in place of a figure (its own Dash component), by title. */
const dashes = (host) => elements(host.tree, (node) => node.type?.name === 'Dash').map((node) => node.props.title)

test('workspace requests one lean market read and aborts/discards its result on unmount', async () => {
  const fixture = workspace(); const host = mount(fixture.PoolWorkspace, fixture.props)
  assert.deepEqual(fixture.reads.map(({ route, request }) => ({ route, request })), [{ route: 'pool-market', request: { poolId: id('a'), includePriceHistory: false } }])
  assert.equal(part(host, 'PoolPriceChart'), undefined, 'no chart until the market read names its currencies')
  assert.ok(elements(host.tree, (node) => node.type === parts.Skeleton).length > 0, 'figures rest while the read is in flight')
  host.unmount(); const before = host.writes
  assert.equal(fixture.reads[0].options.signal.aborted, true)
  fixture.reads[0].resolve({ state: 'ok', data: { poolId: id('a') } }); await flush()
  assert.equal(host.writes, before)
})

test('the chart is mounted once the market answers, and reads only when asked: still one read', async () => {
  const fixture = workspace(); const host = mount(fixture.PoolWorkspace, fixture.props)
  fixture.reads[0].resolve({ state: 'ok', data: { poolId: id('a') } }); await flush(); host.render()
  const chart = part(host, 'PoolPriceChart')
  assert.ok(chart, 'the chart is on the page')
  assert.notEqual(chart.props.autoLoad, true, 'hourly prices are a read the person asks for')
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
  assert.ok(part(host, 'PoolRangeControls'), 'the range planner is on the page, with no view to switch to')
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
  assert.ok(part(host, 'PoolPriceChart'), 'the stored figures are on screen')
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
  assert.match(shown, /GeckoTerminal\s*retrieval time unknown/)
  // The provider line is a stat's `sub`, so it is read from the markup.
  const provenance = (tree) => /data-market-provenance="" title="([^"]*)"/.exec(renderToStaticMarkup(tree))?.[1]
  assert.match(provenance(host.tree), /^GeckoTerminal market observation, as the read service stored it: stale, retrieval time unknown;/)
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
  const onPage = renderToStaticMarkup(host.tree).replace(/<p role="status"[^>]*>.*?<\/p>/gs, '').replace(/<[^>]+>/g, '')
  assert.doesNotMatch(onPage, /Unavailable|No response|Retry|\bagain\b/, 'and never words on the page: only the polite live region says it')
  assert.match(renderToStaticMarkup(host.tree), /<p role="status" aria-live="polite" class="sr-only"[^>]*>Unavailable\. No response<\/p>/)
  // Changed on purpose (qa:visual): the chart card has no caption under its heading; who reports the candles is the plot's title and data.
  assert.doesNotMatch(onPage, /Hourly candles|GeckoTerminal/, 'no caption under the chart heading')
  assert.match(renderToStaticMarkup(host.tree), /<div class="dm-pool-plot dm-dots-chart mt-4" title="Hourly candles reported by GeckoTerminal\." data-chart-provider="GeckoTerminal">/)
  assert.deepEqual(fixture.asks.map(({ outcome, attempt }) => [outcome.state, attempt]), [['unavailable', 0]])
  fixture.asks[0].resolve(true); await flush(); host.render()
  assert.deepEqual(fixture.reads.map(({ request }) => request), [lean, lean], 'one more lean read, on its own')
  fixture.reads[1].resolve(ok()); await flush(); host.render()
  assert.ok(part(host, 'PoolPriceChart'))
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
  assert.match(visibleText(host), /Est\. APR/, 'the estimate stands until then')
  fixture.reads[1].resolve({ state: 'ok', data: { poolId: id('a') } }); await flush(); host.render()
  const visible = visibleText(host)
  assert.match(visible, /24h fees/)
  assert.match(visible, /APR/)
  assert.doesNotMatch(visible, /Est\. APR/, 'a qualified APR takes the estimate’s place, as it does in the table')
  assert.match(visible, /Domino history/)
  const metricCells = elements(host.tree, (node) => node.type === parts.MetricCell).map((node) => [node.props.metric.state, node.props.percent === true])
  assert.deepEqual(metricCells.filter(([state]) => state === 'qualified'), [['qualified', false], ['qualified', true]], 'the 24h fees and the APR, both Domino’s')
  assert.match(visible, /Pool APR, Domino history158\.06%/, 'the history APR row has the figure instead of a fixed “unavailable”')
  host.unmount()

  // A failed metrics read keeps the provider’s figures; its reason is the dashes’ title.
  const failing = workspace({ listed: ['pool-metrics'], dependencies: { projectMarketRow } }); const page = mount(failing.PoolWorkspace, failing.props)
  await flush(); page.render()
  failing.reads[0].resolve(ok()); await flush(); page.render()
  failing.reads[1].resolve(unavailable); await flush(); page.render()
  assert.deepEqual(dashes(page), ['Unavailable. No response', 'Unavailable. No response'], 'the 24h fees and the history APR say why')
  assert.match(visibleText(page), /Est\. APR/)
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
  assert.match(visible, /GeckoTerminal/)
  assert.match(visible, /retrieved 12 s ago/)
  assert.match(visible, /Verified at block 700/)
  assert.ok(visible.includes(id('a')), 'the full pool id is in the page')
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
    assert.deepEqual(workspace.props.range, { lower: -60, upper: 60 }, 'a usable price starts on the closer preset')
    // The way onward is handed to the workspace as its `actions`: a route into the new-position flow for this pool, and nothing that deposits.
    const onward = elements(workspace.props.actions, (node) => node.type === parts.LinkButton)
    assert.deepEqual(onward.map((node) => node.props.href), [`#/new/${id('a')}`])
  } finally { host.unmount(); globalThis.window = previous }
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
    assert.doesNotMatch(markup.replace(/<[^>]+>/g, ''), /Hourly candles|GeckoTerminal/, 'no caption under the chart heading')
    assert.match(markup, /<div class="dm-pool-plot dm-dots-chart mt-4" title="Hourly candles reported by GeckoTerminal\." data-chart-provider="GeckoTerminal"><div class="dm-pool-plot-empty"><span class="text-fg-subtle" title="Unavailable\. No response">—<\/span>/)
    assert.deepEqual(asks.map(({ outcome, attempt }) => [outcome.state, attempt]), [['busy', 0]])
    assert.equal(verifications.length, 1)
    asks[0].resolve(true); await flush(); host.render()
    assert.equal(verifications.length, 2, 'asked again, once')
    verifications[1].resolve({ failure: null, option: option('a'), restarted: false }); await flush(); host.render()
    assert.equal(part(host, 'PoolWorkspace').props.option.key, id('a'))
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
      windowStartBlock: body.coverage.initializedBlock,
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
  assert.deepEqual(rowCells(html, 'lp-fees'), ['<span class="tnum" title="0.000000086412877935">0.0000000864129</span>', '<span class="tnum" title="300.000002">300</span>'])
  assert.deepEqual(rowCells(html, 'lp-assets'), ['<span class="tnum" title="0.000000001012536287">0.00000000101254</span>', '<span class="tnum" title="20,025,853.294226">20,025,853</span>'])
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
  assert.match(html, /<h2 id="pool-activity-title" class="dm-display dm-display-card" title="Swaps and fees over the 24 hours up to the last indexed block, from indexed chain events\.">On-chain activity<\/h2>/)
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
  assert.match(text, /LP assets 0\.00000000101254 20,025,853/)
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
  assert.deepEqual(inputs.slice(0, 5), [['LP fee', '0.30%'], ['Protocol fee', 'None'], ['24h volume, GeckoTerminal', '$1.0K'], ['TVL, GeckoTerminal', '$10.0K'], ['Method', '365 × LP fee × (1 − protocol fee) × 24h volume ÷ TVL']])
  assert.match(html, /title="From GeckoTerminal’s reported 24h volume and TVL, not reconciled\. The provider’s update time is unknown\. Current TVL, not time-weighted\. Assumes the current fixed LP fee for the whole 24h volume\. The protocol fee’s effect is not reconciled\. Full-day coverage is not proven\. Excludes rewards, gas, service fees and price changes\. Pool estimate, not position APR or APY\. Not a return forecast or a recommendation\." data-apr-figure="">10\.95% est\. APR/)

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
  const { PoolPicker } = load('PoolPicker', {
    readWithin(_source, route, request, options) { const pending = deferred(); reads.push({ route, request, options, ...pending }); return pending.promise },
    askAgainLater(outcome, attempt, signal) { const pending = deferred(); asks.push({ outcome, attempt, signal, ...pending }); return pending.promise },
    asksAgain: real('src/lib/read/screens/transient.ts').asksAgain,
    failureCode: real('src/lib/read/screens/quietRead.ts').failureCode,
    COPY: real('src/lib/read/screens/copy.ts').COPY,
    poolsRequest: (token, paired) => (paired ? { token, pairedToken: paired } : { token }),
    neutralOrder: (options) => options,
  })
  const host = mount(PoolPicker, { source: { transport: 'bridge' }, token: TOKEN_1, paired: null, pending: null, onPending() {}, catalogue: false, compact: true, ...props })
  return { host, reads, asks }
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
  // The docs: a section link always carries its route, since a bare #<id> would open Home.
  assert.equal(routes.docsHref(), '#/docs')
  assert.equal(routes.docsHref('non-custodial'), '#/docs/non-custodial')
  assert.equal(routes.docsHref('fees', 'service-fee'), '#/docs/fees#service-fee')
  assert.deepEqual(routes.hashParts(routes.docsHref('fees', 'service-fee')), { segments: ['docs', 'fees'], section: 'service-fee' }, 'what a docs link writes, the route reads back')
  for (const href of [routes.poolHref(id('a'), upper), routes.exploreHref(upper)]) {
    assert.deepEqual(routes.parseExploreHash(href).token ?? routes.parsePoolHash(href).token, upper, 'what a link writes, the page reads back')
  }
})
