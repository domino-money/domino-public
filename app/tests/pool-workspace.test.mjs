import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { test } from 'node:test'

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
const option = (letter) => ({ key: id(letter), currencies: [token('1'), token('2')], fee: '0.3%', tickSpacing: 60, hooks: addr('0'), block: 700, tick: 0, sqrtPriceX96: '79228162514264337593543950336' })
const metric = { value: '42', state: 'provider', source: 'GeckoTerminal', asOf: 1000 }
const row = (poolId) => ({ poolId, tokens: { base: token('1'), quote: token('2') }, tvlUsd: metric, volume24hUsd: metric, provenance: { block: 700, market: { status: 'available', receivedAt: 0, ageSeconds: 0, cacheAgeSeconds: 0, freshForSeconds: 60 } } })
const Container = ({ children }) => React.createElement('div', null, children)
const stub = (name) => Object.defineProperty(() => null, 'displayName', { value: name })
const parts = Object.fromEntries([
  'PoolPicker', 'PoolSelectionDialog', 'PoolWorkspace', 'TokenPicker', 'TokenLookup', 'CatalogueCandidates', 'WalletCandidates', 'PoolPriceChart', 'PoolRangeControls', 'ScreenStatus',
  'PoolAprEstimate', 'PoolCatalogueIdentity', 'PoolTokenLabel', 'TokenMark', 'TokenMarkPair', 'SymbolText', 'Address', 'MetricCell', 'TurnoverCell', 'Tabs', 'Skeleton',
  'CopyButton', 'ProviderFigure', 'EmptyState', 'LinkButton', 'SelectedPoolsTable', 'TokensTable', 'SearchField', 'PageHeader',
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
    presentMetric: (value) => value.state === 'provider' || value.state === 'stale' ? { kind: 'value', text: '$42', source: value.source, asOf: value.asOf, stale: value.state === 'stale' } : { kind: 'unavailable' },
    projectMarketRow: ({ market }) => row(market.data.poolId),
    failureText: () => ({ code: 'offline', title: 'Unavailable', detail: 'No response', retry: true }),
    addressKey: (value) => value, poolIdKey: (value) => value, shortAddress: (value) => `${value.slice(0, 6)}…${value.slice(-4)}`, NATIVE_CURRENCY: addr('0'),
    parseAddressInput: (raw) => (/^0x[0-9a-fA-F]{40}$/.test(raw) ? { ok: true, wire: raw, key: raw.toLowerCase() } : { ok: false, reason: 'length' }),
    poolPrice: () => ({ state: 'usable', tick: 0, tickSpacing: 60, text: '≈1', base: token('1'), quote: token('2'), block: 700, stale: false, partial: false }), presetRange: () => ({ lower: -60, upper: 60 }),
    selectable: (candidate) => candidate.why === null, whyText: () => null, reasonText: (code) => String(code), activityFacts: (data) => data,
    COPY: { range: { problems: { decimals_unknown: 'Decimals unknown', tick_mismatch: 'Tick mismatch', not_initialized: 'Not initialised', beyond_display: 'Beyond display' } }, picker: { hookless: 'No hooks, fixed fee', needsAdapter: 'Needs a separate adapter', partialMetadata: '', providerConflict: '', checking: 'Checking…' }, figures: { activityLoading: '' }, selection: { decimalsUnavailable: 'decimals unavailable' } },
    SELECTED_POOL_CATALOGUE: [{ poolId: id('a'), labels: ['A', 'B'], fee: '0.3%' }], SELECTED_POOLS_COMMON_TOKEN: addr('5'),
    ...dependencies,
  }
  new Function('require', 'module', 'exports', code)((name) => name === 'react' ? hooks : name === 'react/jsx-runtime' ? require(name) : common, mod, mod.exports)
  return mod.exports
}
function workspace() {
  const reads = []
  const source = { transport: 'bridge' }
  const module = load('PoolWorkspace', { readWithin(_source, route, request, options) { const pending = deferred(); reads.push({ route, request, options, ...pending }); return pending.promise } }, 'PoolActivity')
  const props = { source, option: option('a'), range: null, onOption() {}, onRange() {} }
  return { ...module, reads, props }
}

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

test('activity is mounted on demand and leaving it cancels the owned read', async () => {
  const fixture = workspace(); const host = mount(fixture.PoolWorkspace, fixture.props)
  assert.equal(elements(host.tree, (node) => node.type === fixture.PoolActivity).length, 0)
  assert.equal(fixture.reads.length, 1)
  assert.ok(part(host, 'PoolRangeControls'), 'the range planner is on the page from the first render, with no view to switch to')
  const readActivity = buttonNamed(host, 'Read activity')
  assert.ok(readActivity, 'activity waits behind a Read activity button')
  readActivity.props.onClick(); host.render()
  const activityElement = elements(host.tree, (node) => node.type === fixture.PoolActivity)[0]
  const activity = mount(fixture.PoolActivity, activityElement.props)
  assert.equal(fixture.reads.length, 2)
  assert.equal(fixture.reads[1].route, 'pool-activity')
  assert.deepEqual(fixture.reads[1].request, { poolId: id('a') })
  activity.unmount()
  assert.ok(part(host, 'PoolRangeControls'), 'the range planner holds the existing controls')
  assert.equal(fixture.reads[1].options.signal.aborted, true)
  const writes = activity.writes
  fixture.reads[1].resolve({ state: 'unavailable' }); await flush()
  assert.equal(activity.writes, writes)
  host.unmount()
})

test('a successful reread clears the previous market error', async () => {
  const fixture = workspace(); const host = mount(fixture.PoolWorkspace, fixture.props)
  fixture.reads[0].resolve({ state: 'unavailable' }); await flush(); host.render()
  assert.ok(part(host, 'ScreenStatus').props.line)
  assert.equal(elements(host.tree, (node) => node.type === parts.Skeleton).length, 0, 'a failed read never leaves a resting block in place of a figure')
  host.props = { ...host.props, option: { ...host.props.option, currencies: [...host.props.option.currencies] } }; host.render()
  fixture.reads[1].resolve({ state: 'ok', data: { poolId: id('a') } }); await flush(); host.render()
  assert.equal(part(host, 'ScreenStatus').props.line, null)
  host.unmount()
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

function poolPage(hash) {
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
    assert.match(part(host, 'EmptyState').props.title, /could not be verified/)
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

// --- the token lookup on Explore ---

function lookup() {
  const reads = []
  const found = []
  const { TokenLookup } = load('TokenLookup', {
    readWithin(_source, route, request, options) { const pending = deferred(); reads.push({ route, request, options, ...pending }); return pending.promise },
    candidateFromToken: (data, wire) => ({ key: wire.toLowerCase(), wire, token: token('1'), kind: 'erc20_candidate', why: null, reasonCode: null, decimalsUnavailable: false, source: 'pasted', balance: null, page: null, old: false, block: data.snapshot.number }),
  })
  return { TokenLookup, reads, found, props: { source: { transport: 'bridge' }, wire: `0x${'A'.repeat(40)}`, onFound: (candidate) => found.push(candidate) } }
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
  assert.match(visible, /Read at block 700/)
  assert.match(visible, /ERC-20 token/)
  host.unmount()
  assert.equal(fixture.reads[1].options.signal.aborted, true)
})

test('a failed lookup offers Retry, which is one more read of the same address', async () => {
  const fixture = lookup(); const host = mount(fixture.TokenLookup, fixture.props)
  fixture.reads[0].resolve({ state: 'unavailable' }); await flush(); host.render()
  const status = part(host, 'ScreenStatus')
  assert.equal(status.props.line.title, 'Unavailable')
  status.props.onRetry(); host.render()
  assert.equal(fixture.reads.length, 2)
  assert.deepEqual(fixture.reads[1].request, fixture.reads[0].request)
  host.unmount()
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
  for (const href of [routes.poolHref(id('a'), upper), routes.exploreHref(upper)]) {
    assert.deepEqual(routes.parseExploreHash(href).token ?? routes.parsePoolHash(href).token, upper, 'what a link writes, the page reads back')
  }
})
