/** The compiled app behind its real beta gate and Worker, with only the
 * private gateway replaced by contract fixtures. No network or credentials
 * outside the local test server are used. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright-core'
import { closeBrowser } from './support/close-browser.mjs'
import { createWorker } from '../../bridge/src/worker.mjs'
import { BRIDGE_DIST, DIST, createGatedServer } from '../scripts/gated-server.mjs'
import { historyFor, overviewFor, SELECTED } from './markets-cards.fixtures.mjs'
import { withPendingPools, withStalePools } from './support/stale-store.mjs'
// 2026-09-28 (speed wave): the read-v1 fixture pool and the contract versions, for New position's link tests below.
import { FIXTURE_POOL } from './support/read-stub.mjs'
import { CONTRACT_VERSION as READ_V1 } from '../../api-contracts/read-v1/runtime.mjs'
import { CONTRACT_VERSION as READ_V5 } from '../../api-contracts/read-v5/runtime.mjs'

const fixture = name => JSON.parse(readFileSync(new URL(`../../api-contracts/read-v3/fixtures/${name}.json`, import.meta.url), 'utf8'))
const TOKEN = '0x1111111111111111111111111111111111111111'
const POOL = fixture('overview').pools[0].poolId
const PASSWORD = 'public-data-browser-fixture'
const APP = 'https://app.test'
const env = { APP_ORIGIN: APP, READ_BRIDGE_ENABLED: 'true', ENABLED_READS: '',
  READ_V2_BRIDGE_ENABLED: 'false', ENABLED_V2_READS: '',
  READ_V3_BRIDGE_ENABLED: 'true', ENABLED_V3_READS: 'overview,history,search',
  GATEWAY_ORIGIN: 'https://gateway.test', ACCESS_CLIENT_ID: 'fixture-client', ACCESS_CLIENT_SECRET: 'fixture-secret' }
const calls = []
let releaseHistory
const worker = createWorker({ getClientIp: () => '198.51.100.31', fetch: async (url, init) => {
  const route = new URL(url).pathname.split('/').at(-1), request = JSON.parse(init.body)
  calls.push({ route, request })
  const body = fixture(route)
  if (route === 'overview') {
    body.selectedToken = request.token ?? null
    body.requestedPoolIds = request.poolIds ?? []
  } else if (route === 'history') {
    await new Promise(resolve => { releaseHistory = resolve })
    body.currency = request.currency
    body.quoteCurrency = request.currency === TOKEN ? '0x0000000000000000000000000000000000000000' : TOKEN
  }
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': '3.0.0-rc.1' } })
} })
let server, browser, origin
before(async () => {
  server = createGatedServer({ dist: BRIDGE_DIST,
    env: { BETA_PASSWORD: PASSWORD, BETA_COOKIE_KEY: 'BrowserPublicFixtureKey_0123456789_abcdefgh' },
    api: async request => {
      const url = new URL(request.url), headers = new Headers(request.headers)
      if (headers.get('origin') === url.origin) headers.set('origin', APP)
      headers.delete('host')
      return worker.fetch(new Request(new URL(url.pathname, APP), { method: request.method, headers,
        body: request.method === 'POST' ? await request.text() : undefined }), env)
    },
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  const launches = process.env.DOMINO_BROWSER_PATH ? [{ executablePath: process.env.DOMINO_BROWSER_PATH }] : [{ channel: 'chrome' }, { channel: 'chromium' }, { channel: 'msedge' }, {}]
  for (const options of launches) { try { browser = await chromium.launch(options); break } catch {} }
  if (!browser) throw new Error('Chromium is required; set DOMINO_BROWSER_PATH')
})
after(async () => {
  releaseHistory?.()
  await closeBrowser(browser)
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
})

test('a token outside the selected list opens from one stored overview and pool figures precede history', { timeout: 30000 }, async () => {
  const context = await browser.newContext(), page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort())
  const login = await context.request.post(`${origin}/__beta/login`, { form: { password: PASSWORD }, headers: { Origin: origin }, maxRedirects: 0 })
  assert.equal(login.status(), 303)
  await page.goto(`${origin}/#/markets/${TOKEN}`)
  const explorer = page.locator('[data-stored-token]')
  await explorer.getByRole('link', { name: /TOKEN/ }).first().waitFor()
  assert.match(await explorer.innerText(), /10\.95/)
  assert.deepEqual(calls.map(call => call.route), ['overview'])
  assert.deepEqual(calls[0].request, { token: TOKEN, limit: 24 })
  const link = explorer.locator(`a[href="#/pool/${POOL}/${TOKEN}"]`).first()
  assert.equal(await link.count(), 1, 'generic pool links preserve the verified token identity')
  await link.click()
  await page.locator('[data-pool-ratio-chart]').waitFor()
  await page.waitForFunction(() => document.querySelector('[data-pool-ratio-chart]')?.getAttribute('data-ratio-status') === 'reading')
  assert.match(await page.locator('main').innerText(), /10\.95/)
  assert.equal(calls.filter(call => call.route === 'overview').length, 2, 'verification and workspace share their identical overview')
  await page.waitForFunction(() => document.querySelector('[data-pool-ratio-chart]') !== null)
  // Wait on the request event, bounded by the test deadline, rather than a
  // fixed delay that could hide a scheduler regression.
  for (let tries = 0; !releaseHistory && tries < 50; tries++) await page.waitForTimeout(100)
  assert.ok(releaseHistory, 'the independent history request started')
  releaseHistory()
  await page.locator('[data-ratio-status="partial"]').waitFor()
  // Changed on purpose (2026-09-27, round 6, the pool page for beginners): missing hours are said in plain words.
  assert.match(await page.locator('[data-pool-ratio-chart]').innerText(), /Some hours are missing: they are shaded\./)
  assert.equal(calls.some(call => ['token', 'pools', 'pool-market'].includes(call.route)), false)
  assert.deepEqual(errors, [])
  await context.close()
})

/**
 * POST arrivals at the edge within the gateway's per-client budget (backend ClientBudgets: a burst of five, 30 a minute).
 * Changed on purpose (2026-09-26, after review): the featured list's POST is answered at the edge, never by the gateway
 * (here the Worker's own route_not_available; once on, the Pages Function's cache, featured pools v1 §10.6), so the page
 * spends none of its budget on it (scheduler.ts EDGE_ANSWERED) and it is not counted here. Changed 2026-09-28 (speed
 * wave, item 4): the page takes a read from its budget for the list and gives it back when the edge cache answered, or
 * the read Worker refused a route switched off there (scheduler.ts EDGE_CACHED, UNCOUNTED), as this Worker does.
 */
function assertWithinBudget(allPosts) {
  const posts = allPosts.filter(post => post.path !== '/api/read/v5/featured-pools')
  let tokens = 5
  for (let i = 0; i < posts.length; i++) {
    if (i > 0) tokens = Math.min(5, tokens + (posts[i].at - posts[i - 1].at) / 2000)
    tokens -= 1
    // A few milliseconds of transit either way, which the page's quarter of a read in hand absorbs.
    assert.ok(tokens >= -0.05, `POST ${i} (${posts[i].path}) arrived over the budget: ${posts.map(post => post.at - posts[0].at).join(', ')} ms`)
  }
}

// Added 2026-09-24. The owner: none of the six Markets cards showed its chart, and some took very long. Each card
// made its own live provider read, only while 60% in view, queued behind the table's five-second refresh. Now,
// where read-v3 lists `history`, every card reads the pool's stored price at mount, paced like every other read.
// This runs the deployable build (the six selected pools): `npm run build` first, as for gate.browser.test.mjs.
test('Markets on the deployable build: all six cards draw a real chart within seconds from paced history reads, and a pool not built yet shows its 24h volume', { timeout: 60000 }, async () => {
  if (!existsSync(join(DIST, 'index.html'))) throw new Error('dist/index.html is missing. Run `npm run build` before this test.')
  const notBuilt = SELECTED[1]
  const reads = [], edge = []
  const sixWorker = createWorker({ getClientIp: () => '198.51.100.32', fetch: async (url, init) => {
    const route = new URL(url).pathname.split('/').at(-1), request = JSON.parse(init.body)
    reads.push({ route, request })
    const body = route === 'overview' ? overviewFor(request) : route === 'history' ? historyFor(request, { built: request.poolId !== notBuilt }) : fixture(route)
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': '3.0.0-rc.1' } })
  } })
  const site = createGatedServer({ dist: DIST,
    env: { BETA_PASSWORD: PASSWORD, BETA_COOKIE_KEY: 'BrowserPublicFixtureKey_0123456789_abcdefgh' },
    observe: request => { const url = new URL(request.url); if (url.pathname.startsWith('/api/')) edge.push({ method: request.method, path: url.pathname, at: Date.now() }) },
    api: async request => {
      const url = new URL(request.url), headers = new Headers(request.headers)
      if (headers.get('origin') === url.origin) headers.set('origin', APP)
      headers.delete('host')
      return sixWorker.fetch(new Request(new URL(url.pathname, APP), { method: request.method, headers,
        body: request.method === 'POST' ? await request.text() : undefined }), env)
    },
  })
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve))
  const at = `http://127.0.0.1:${site.address().port}`
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors = []
  try {
    page.on('pageerror', error => errors.push(error.message))
    await context.route('**/*', route => route.request().url().startsWith(at) ? route.continue() : route.abort())
    const login = await context.request.post(`${at}/__beta/login`, { form: { password: PASSWORD }, headers: { Origin: at }, maxRedirects: 0 })
    assert.equal(login.status(), 303)
    const opened = Date.now()
    await page.goto(`${at}/#/markets`)
    await page.waitForFunction(() => {
      const cards = [...document.querySelectorAll('#market-rail [data-market-card]')]
      return cards.length === 6 && cards.every(card => card.querySelector('[data-price-line], [data-volume-bar], [data-chart-unavailable]'))
    }, null, { timeout: 20000 })
    const took = Date.now() - opened
    // 2026-09-25 (r4/metrics): 12 s before, when every stored read waited 1.1 s for the one before it.
    assert.ok(took < 9000, `the six cards took ${took} ms to draw`)
    assert.equal(await page.locator('#market-rail').getAttribute('aria-label'), 'Selected pools, last 24 hours')
    const shown = await page.locator('#market-rail [data-market-card]').evaluateAll(cards => cards.map(card => [card.getAttribute('data-market-card'),
      card.querySelector('[data-price-line]') ? 'line' : card.querySelector('[data-volume-bar]') ? 'bars' : card.querySelector('[data-chart-unavailable]').getAttribute('data-chart-unavailable')]))
    assert.deepEqual(shown, SELECTED.map(poolId => [poolId, poolId === notBuilt ? 'not_built' : 'line']), 'five pools draw their price; the one not built yet shows its figure')
    const figure = page.locator(`[data-market-card="${notBuilt}"] [data-chart-unavailable] [data-metric]`)
    assert.equal(await figure.innerText(), '$1.0K', 'the row’s own 24h volume, drawn in the plot')
    const captions = await page.locator('#market-rail .dm-mkt-card-caption').allInnerTexts()
    assert.deepEqual(captions, SELECTED.map(poolId => poolId === notBuilt ? '24h volume' : 'Price · 24h'))
    // Pointing along a line names one hour: its close in the quote token, and its swaps. Changed on purpose 2026-09-27
    // (r6/marketsdata, the owner's plain-price rule): written as the table writes a price, one of a token first.
    const line = page.locator(`[data-market-card="${SELECTED[0]}"] [data-price-line]`)
    const box = await line.boundingBox()
    await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2)
    // Changed on purpose 2026-09-28 (one-sided): the card asks the history of the token the app prices, TOKEN in ETH
    // (lib/read/orientation.ts), and the stub answers its fixed close for whichever token is asked.
    assert.match(await page.locator(`[data-market-card="${SELECTED[0]}"] .dm-mkt-card-caption`).innerText(), /^\d\d:00 UTC · 1 TOKEN = 123\.5 ETH · 4 swaps$/)

    const posts = edge.filter(read => read.method === 'POST')
    assert.equal(posts.filter(read => read.path.startsWith('/api/read/v1/')).length, 0, 'no provider read: no read-v1 pool-market, nothing else of read-v1')
    // Changed on purpose (2026-09-26, featured pools v1 §11.1): the featured list's one POST comes first; this Worker
    // has no read-v5, so the page keeps the embedded six and its title.
    assert.deepEqual(posts.map(read => read.path), ['/api/read/v5/featured-pools', '/api/read/v3/overview', ...SELECTED.map(() => '/api/read/v3/history')], 'the list, the table’s one overview, then one history read per card')
    // Added 2026-09-26 after review: the list's POST spends none of the tab's budget, so the six cards' history reads
    // go when they did before it: the last about 4.5 s after the table's overview (measured 4.50 s), not 6.5 s.
    const overviewAt = posts[1].at, lastHistoryAt = posts.at(-1).at
    assert.ok(lastHistoryAt - overviewAt < 5500, `the last card's history read went ${lastHistoryAt - overviewAt} ms after the overview: ${posts.map(post => post.at - posts[0].at).join(', ')} ms`)
    // Changed 2026-09-25 (r4/metrics): stored reads are no longer held 1.1 s apart, a rule of the gateway's provider
    // lane its stored lane does not have (scheduler.ts). They keep the gateway's per-client budget, counted here as
    // the gateway counts it, at arrival: a burst of five, then one every two seconds.
    assertWithinBudget(posts)
    // Changed on purpose 2026-09-28 (one-sided): each card asks the history of the token the app prices (TOKEN, priced
    // in ETH, lib/read/orientation.ts), where it asked ETH's.
    assert.deepEqual(reads.filter(read => read.route === 'history').map(read => read.request).sort((a, b) => a.poolId.localeCompare(b.poolId)),
      SELECTED.map(poolId => ({ poolId, currency: '0x1111111111111111111111111111111111111111', windowSeconds: 86400, resolutionSeconds: 3600 })).sort((a, b) => a.poolId.localeCompare(b.poolId)))
    assert.deepEqual(edge.filter(read => read.method === 'GET').map(read => read.path), ['/api/read/v3/capabilities'], 'the cards decided from the capabilities the page already held')
    assert.doesNotMatch(await page.locator('#market-rail').innerText(), /Reading|Retry|unavailable|\bv4\b|not enabled|read-only/i, 'no status words on the cards')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
    await new Promise(resolve => { site.close(resolve); site.closeAllConnections() })
  }
})


// Added 2026-09-25 (r4/metrics). The owner, on production: Home's Selected pools figures and the ticker's APR took
// long to appear, and ETH/USDG and PONS/USDG said "Unavailable" on Home while Markets had their figures. Home, the
// ticker and Markets read one provider, so they can disagree only in time: the store had served those two without
// figures (aged past its five minutes) and the page asked again a minute later. The recorded data is the harness
// world's stored overview at block 71,396,966 (support/selected-overview.recorded.json, written by the harness's
// tools/record-selected-overview.mjs): its figures, not the ones on the owner's screenshots. It holds main's six
// selected pools and r4/featured's six, so this test reads whichever six the build selects. The first answer is the
// store's before it caught up on the last two; a later visit meets a store whose collection of those two failed.
const RECORDED_FIGURES = {
  // main's six, 2026-09-23 to 2026-09-25
  '0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6': ['$375.1K', '$1.7M', '32.13% est.'],
  '0xdb922f0619e11b0c1e6c3a142798f0243060b8a4331ea4f4e7de80e898cc02e7': ['$13.4K', '$1.3K', '181.25% est.'],
  '0x94c62eebf6454231b2fcd0259ede448ae3c6ad8617718cd88dab20b30cfae48a': ['$1.0M', '$449.4K', '23.86% est.'],
  '0xf399bd1544377680d48c62fd85c2105b869e55906c4189cc5ab3b4e83446928c': ['$3.0M', '$2.4M', '2.16% est.'],
  '0x24107d152f14a76d292123265ae3f3c71f863fc2f4ef7ba49d64e78d28ea379e': ['$381.4K', '$7.5M', '71.93% est.'],
  // in both lists
  '0x4be9657ec9002e528f4f17a5c43edc525a07f888f7b180c2afbf75e096c4f38a': ['$6.8M', '$6.2M', '100.35% est.'],
  // r4/featured's other five (the owner's list of 2026-09-25)
  '0xa92a3df27a00a276183ff7265fd8affa11df1fe8bb23ddfaf13f6c879a3f818b': ['$2.5M', '$2.3M', '92.37% est.'],
  '0x7aebd80541bfaaf23dbb6e99ce13d4d31c1a84c91414f971eadbff7db5f85995': ['$1.8M', '$4.3M', '195.00% est.'],
  '0x778a632fdd85577efe9cfce4a2c9ac91b9decdb24c351f9b56e25d38fbe587b4': ['$1.7M', '$2.0M', '396.75% est.'],
  '0xebd2fbb46948c5b21ca32dcd0be5ae851fed99362cfcf198d060a63a8689cd66': ['$204.5K', '$35.3K', '125.31% est.'],
  '0x031fe000f185cdf1b8850821d22bdf4ed1e337909be7caa00c2b68594da83f03': ['$70.9K', '$25.8K', '529.83% est.'],
}

test('Home, its ticker, Markets and its cards show one set of figures for the six pools; pools the store is still collecting wait for theirs, and pools whose collection failed say Unavailable at once', { timeout: 90000 }, async () => {
  if (!existsSync(join(DIST, 'index.html'))) throw new Error('dist/index.html is missing. Run `npm run build` before this test.')
  const recorded = JSON.parse(readFileSync(new URL('./support/selected-overview.recorded.json', import.meta.url), 'utf8'))
  for (const poolId of SELECTED) assert.ok(RECORDED_FIGURES[poolId] && recorded.pools.some(entry => entry.poolId === poolId), `${poolId} is selected but not recorded: add it with the harness's tools/record-selected-overview.mjs --add`)
  const behind = SELECTED.slice(-2)
  const currencies = new Map(recorded.pools.map(entry => [entry.poolId, entry.value.market.pool.currencies]))
  const edge = []
  let overviews = 0
  /** How the store answers: still collecting the last two at the first answer, or their collection failed. */
  let store = 'collecting'
  const recordedWorker = createWorker({ getClientIp: () => '198.51.100.33', fetch: async (url, init) => {
    const route = new URL(url).pathname.split('/').at(-1), request = JSON.parse(init.body)
    let body
    if (route === 'overview') {
      overviews += 1
      const pools = request.poolIds.map(poolId => recorded.pools.find(entry => entry.poolId === poolId))
      const wanted = new Set(pools.flatMap(entry => currencies.get(entry.poolId)))
      const answer = { ...recorded, requestedPoolIds: request.poolIds, pools, tokens: recorded.tokens.filter(entry => wanted.has(entry.address)) }
      body = store === 'failed' ? withStalePools(answer, behind, { reason: 'collection_failed', inSeconds: 240 })
        : overviews === 1 ? withStalePools(answer, behind) : answer
    } else if (route === 'history') {
      // Not built yet, so each card shows its row's 24h volume: one more place the figures must agree.
      body = historyFor(request, { built: false })
      body.quoteCurrency = currencies.get(request.poolId).find(currency => currency !== request.currency) ?? null
    } else body = fixture(route)
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': '3.0.0-rc.1' } })
  } })
  const site = createGatedServer({ dist: DIST,
    env: { BETA_PASSWORD: PASSWORD, BETA_COOKIE_KEY: 'BrowserPublicFixtureKey_0123456789_abcdefgh' },
    observe: request => { const url = new URL(request.url); if (url.pathname.startsWith('/api/')) edge.push({ method: request.method, path: url.pathname, at: Date.now() }) },
    api: async request => {
      const url = new URL(request.url), headers = new Headers(request.headers)
      if (headers.get('origin') === url.origin) headers.set('origin', APP)
      headers.delete('host')
      return recordedWorker.fetch(new Request(new URL(url.pathname, APP), { method: request.method, headers,
        body: request.method === 'POST' ? await request.text() : undefined }), env)
    },
  })
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve))
  const at = `http://127.0.0.1:${site.address().port}`
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors = []
  /** Each selected pool's row in `scope`, by pool id: its three figures as shown, and whether any still waits. */
  const rowsIn = scope => page.evaluate(scope => Object.fromEntries([...document.querySelectorAll(`${scope} tbody tr.dm-mkt-row:not([data-pool-catalogue])`)].map(row => {
    const cells = row.querySelectorAll('td')
    const text = cell => cell.innerText.trim().replace(/\s+/g, ' ')
    return [row.querySelector('a.dm-mkt-name').getAttribute('href').split('/')[2], { tvl: text(cells[2]), volume: text(cells[3]), apr: text(cells[4]),
      waiting: row.querySelector('[data-metric="pending"], [data-apr-estimate="pending"]') !== null }]
  })), scope)
  /** The ticker's APR per pool: its text and its state. */
  const tickerApr = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.dm-marquee > a.dm-ticker-item')]
    .map(item => { const apr = item.querySelector('[data-apr-estimate]'); return [item.getAttribute('href').split('/')[2], { text: apr?.innerText.trim() ?? null, state: apr?.getAttribute('data-apr-estimate') ?? null }] })))
  const percent = text => text?.match(/([<\d.,]+)%/)?.[1] ?? null
  try {
    page.on('pageerror', error => errors.push(error.message))
    await context.route('**/*', route => route.request().url().startsWith(at) ? route.continue() : route.abort())
    const login = await context.request.post(`${at}/__beta/login`, { form: { password: PASSWORD }, headers: { Origin: at }, maxRedirects: 0 })
    assert.equal(login.status(), 303)
    const opened = Date.now()
    await page.goto(`${at}/#/`)
    await page.waitForFunction(() => document.querySelectorAll('#pools tbody tr.dm-mkt-row:not([data-pool-catalogue])').length === 6, null, { timeout: 15000 })
    const rowsAt = Date.now()
    assert.ok(rowsAt - opened < 5000, `Home's rows took ${rowsAt - opened} ms`)

    // The first answer: four pools with figures at once; the two the store is collecting wait, in the table and in
    // the ticker, and nothing says Unavailable.
    const first = await rowsIn('#pools')
    assert.deepEqual(SELECTED.map(poolId => first[poolId].waiting), [false, false, false, false, true, true])
    assert.doesNotMatch(await page.locator('#pools table').innerText(), /Unavailable/)
    for (const poolId of SELECTED.slice(0, 4)) assert.match(first[poolId].tvl, /^\$/)
    const waitingTicker = await tickerApr()
    for (const poolId of behind) assert.deepEqual(waitingTicker[poolId], { text: 'Est. APR —', state: 'pending' }, `the ticker for ${poolId}`)
    // The figures dialog of a waiting row says the same: loading, not "no provider figure".
    await page.locator(`#pools tr.dm-mkt-row:has(a.dm-mkt-name[href^="#/pool/${behind[0]}"]) [data-pool-figures]`).click()
    const dialog = page.locator('[data-pool-figures-dialog]')
    await dialog.waitFor()
    assert.equal(await dialog.locator('[data-figures-provider] [data-metric="pending"]').count(), 1)
    assert.equal(await dialog.locator('[data-no-provider-figure]').count(), 0)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })

    // Asked again just after the store's next attempt (5 s, plus 1.5 s, within 10%), not a minute later.
    await page.waitForFunction(() => document.querySelectorAll('#pools [data-metric="pending"], #pools [data-apr-estimate="pending"]').length === 0, null, { timeout: 20000 })
    const caughtUp = Date.now() - rowsAt
    assert.ok(caughtUp >= 5000 && caughtUp < 10_000, `the two pools caught up after ${caughtUp} ms`)
    assert.equal(overviews, 2)
    const home = await rowsIn('#pools')
    // The recorded figures, as recorded: nothing invented, nothing left out.
    assert.deepEqual(SELECTED.map(poolId => [home[poolId].tvl, home[poolId].volume, home[poolId].apr]), SELECTED.map(poolId => RECORDED_FIGURES[poolId]))
    const ticker = await tickerApr()
    for (const poolId of SELECTED) assert.equal(percent(ticker[poolId].text), percent(home[poolId].apr), `the ticker's APR for ${poolId}`)

    // Markets: the same answer, so the same figures in its table and on its cards.
    await page.evaluate(() => { window.location.hash = '#/markets' })
    await page.waitForFunction(() => {
      const cards = [...document.querySelectorAll('#market-rail [data-market-card]')]
      return document.querySelectorAll('[data-selected-pools] tbody tr[data-pool-row]').length === 6 && cards.length === 6 && cards.every(card => card.querySelector('[data-chart-unavailable] [data-metric]'))
    }, null, { timeout: 20000 })
    const markets = await rowsIn('[data-selected-pools]')
    const cards = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#market-rail [data-market-card]')].map(card => [card.getAttribute('data-market-card'),
      { tvl: card.querySelector('.dm-mkt-card-tvl [data-metric]')?.innerText.trim(), volume: card.querySelector('[data-chart-unavailable] [data-metric]')?.innerText.trim() }])))
    for (const poolId of SELECTED) {
      assert.deepEqual(markets[poolId], home[poolId], `Markets and Home for ${poolId}`)
      assert.deepEqual(cards[poolId], { tvl: home[poolId].tvl, volume: home[poolId].volume }, `the card and the table for ${poolId}`)
    }
    assert.doesNotMatch(await page.locator('main').innerText(), /Unavailable/)

    const posts = edge.filter(read => read.method === 'POST')
    // Changed on purpose (2026-09-26): the featured list is read once, first; a catch-up seconds later reads the markets alone.
    assert.deepEqual(posts.map(read => read.path), ['/api/read/v5/featured-pools', '/api/read/v3/overview', '/api/read/v3/overview', ...SELECTED.map(() => '/api/read/v3/history')], 'the list, the table’s overview and its one catch-up, then the cards; no provider read')
    assertWithinBudget(posts)

    // Added after review, 2026-09-25: a later visit meets a store whose collection of those two failed (backed off
    // four minutes, which a request does not bring forward). Their figures are not coming, so the rows say
    // Unavailable at once, as before this change, and the page asks nothing more before its minute.
    store = 'failed'
    const visit = edge.length
    await page.goto(`${at}/#/`)
    await page.reload()
    await page.waitForFunction(() => document.querySelectorAll('#pools tbody tr.dm-mkt-row:not([data-pool-catalogue])').length === 6, null, { timeout: 15000 })
    // Changed on purpose 2026-09-27 (r6/marketsdata): the reload paints this browser's copy of the last overview at
    // once (marketsPaint.ts), the two pools' figures included; the live answer then says what it has.
    await page.waitForFunction(ids => ids.every(id => document.querySelector(`#pools tr.dm-mkt-row:has(a.dm-mkt-name[href^="#/pool/${id}"]) td:nth-child(3)`)?.innerText.trim() === 'Unavailable'), behind, { timeout: 15000 })
    const failed = await rowsIn('#pools')
    for (const poolId of behind) assert.deepEqual(failed[poolId], { tvl: 'Unavailable', volume: 'Unavailable', apr: '—', waiting: false }, `the failed pool ${poolId}`)
    for (const poolId of SELECTED.slice(0, 4)) assert.deepEqual(failed[poolId], home[poolId], `the other pools for ${poolId}`)
    const failedTicker = await tickerApr()
    for (const poolId of behind) assert.equal(failedTicker[poolId].state, 'unavailable', `the ticker for ${poolId}`)
    await new Promise(resolve => setTimeout(resolve, 8000))
    assert.deepEqual(edge.slice(visit).filter(read => read.method === 'POST').map(read => read.path), ['/api/read/v5/featured-pools', '/api/read/v3/overview'], 'the list and one overview for the visit, no catch-up')
    assert.equal(await page.locator('#pools [data-metric="pending"], #pools [data-apr-estimate="pending"]').count(), 0)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
    await new Promise(resolve => { site.close(resolve); site.closeAllConnections() })
  }
})

// Added 2026-09-27 (r6/marketsdata). The owner, on production: the pool figures on Home, the ticker and Markets
// sometimes took very long to appear. Measured with production's latency (support/markets-latency.mjs): a first
// overview that met a gateway down for a moment left Home without figures until a reload, and every visit started from
// nothing. Now a load that read nothing is asked again after 5 s, and a later visit paints this browser's copy of the
// last overview at once, before its own read has answered, and keeps it through a failed one.
test('Home asks again soon after a first overview that failed, and a later visit paints the last figures at once and keeps them', { timeout: 60000 }, async () => {
  if (!existsSync(join(DIST, 'index.html'))) throw new Error('dist/index.html is missing. Run `npm run build` before this test.')
  const { startLatencySite, signIn } = await import('./support/markets-latency.mjs')
  const refuse = () => new Response(JSON.stringify({ error: 'upstream_unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': '3.0.0-rc.1' } })
  // The first overview of each visit meets the gateway down for a moment.
  const site = await startLatencySite({ latency: { edge: 20, featured: 60, overview: 150, history: 100, asset: 0 }, store: (body, n) => (n === 1 || n === 3 ? refuse() : body) })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  /** Home's rows that show a dollar figure. */
  const figured = () => [...document.querySelectorAll('#pools tbody tr.dm-mkt-row')].filter(row => /\$/.test(row.querySelectorAll('td')[2]?.innerText ?? '')).length
  const settled = async n => { for (let i = 0; i < 300 && !(site.counts.overview >= n && site.edge.filter(read => read.path.endsWith('/overview')).every(read => read.done !== null)); i++) await new Promise(resolve => setTimeout(resolve, 50)) }
  const errors = []
  try {
    await context.route('**/*', route => route.request().url().startsWith(site.origin) ? route.continue() : route.abort())
    await signIn(context, site.origin)
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${site.origin}/#/`)
    await settled(1)
    assert.equal(await page.evaluate(figured), 0, 'the first overview failed: nothing to show yet')
    await page.waitForFunction(() => [...document.querySelectorAll('#pools tbody tr.dm-mkt-row')].filter(row => /\$/.test(row.querySelectorAll('td')[2]?.innerText ?? '')).length === 6, null, { timeout: 15000 })
    assert.equal(site.counts.overview, 2, 'the failed overview, then one more')
    const asked = site.edge.filter(read => read.path.endsWith('/overview')).map(read => read.at)
    assert.ok(asked[1] - asked[0] >= 4500 && asked[1] - asked[0] < 9000, `asked again ${asked[1] - asked[0]} ms later`)

    // A later visit: its own first overview fails too, and the figures stand from the start and never leave.
    const again = await context.newPage()
    again.on('pageerror', error => errors.push(error.message))
    await again.addInitScript(() => {
      window.__lost = 0
      let shown = 0
      setInterval(() => {
        const now = [...document.querySelectorAll('#pools tbody tr.dm-mkt-row')].filter(row => /\$/.test(row.querySelectorAll('td')[2]?.innerText ?? '')).length
        if (now < shown) window.__lost += 1
        shown = now
      }, 10)
    })
    await again.goto(`${site.origin}/#/`)
    await again.waitForFunction(() => [...document.querySelectorAll('#pools tbody tr.dm-mkt-row')].filter(row => /\$/.test(row.querySelectorAll('td')[2]?.innerText ?? '')).length === 6, null, { timeout: 5000 })
    assert.ok(site.counts.overview <= 3, 'the figures came before any answer of this visit')
    await settled(4)
    assert.equal(site.counts.overview, 4, 'its failed overview was asked again')
    assert.equal(await again.evaluate(figured), 6)
    assert.equal(await again.evaluate(() => window.__lost), 0, 'no figure left the table meanwhile')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
    await site.close()
  }
})

// Added 2026-09-28. The owner, on production, the first day of the daily list: Home's "Top pools · last 24h" showed
// ETH/NOTE and PONS/USDG with Unavailable TVL and 24h volume, and the Worker saw the overview asked at 12:53:13, :16
// and :19, then nothing. The store serves a pool's cache age as null whenever its collector holds no provider figures
// for it (backend/market_cache.py), and a pool it never collected with no stored value; the page waited for neither,
// and a collection the provider was rate limited for ended a wait at once. Here the first answer serves one pool with
// no figures in the collector, its collection under way, and one pool never collected; the second, one collection
// later, has the new pool's figures and the other rate limited once more; the third has them all.
test('Home on the first day of the daily list: a pool the collector holds no figures for, rate limited once, and a pool never collected wait for their first collection, and nothing says Unavailable', { timeout: 60000 }, async () => {
  if (!existsSync(join(DIST, 'index.html'))) throw new Error('dist/index.html is missing. Run `npm run build` before this test.')
  const { startLatencySite, signIn } = await import('./support/markets-latency.mjs')
  const [limited, fresh] = SELECTED.slice(-2)
  const noFigures = { neverCovered: true, providerBusy: true, refreshing: true }
  const site = await startLatencySite({ latency: { edge: 10, featured: 20, overview: 40, history: 20, asset: 0 }, store: (body, n) =>
    n === 1 ? withPendingPools(withStalePools(body, [limited], noFigures), [fresh])
      : n === 2 ? withStalePools(body, [limited], { ...noFigures, observedAt: body.generatedAt + 3 })
        : body })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const errors = []
  try {
    await context.route('**/*', route => route.request().url().startsWith(site.origin) ? route.continue() : route.abort())
    await signIn(context, site.origin)
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    // Watches the table from the first paint: any "Unavailable", and the new pool's catalogue row showing dashes.
    await page.addInitScript(fresh => {
      window.__said = 0
      window.__dashes = 0
      setInterval(() => {
        const table = document.querySelector('#pools table')
        if (!table) return
        if (/Unavailable/.test(table.innerText)) window.__said += 1
        const row = table.querySelector(`tr[data-pool-catalogue="${fresh}"]`)
        if (row && !row.hasAttribute('data-row-loading')) window.__dashes += 1
      }, 10)
    }, fresh)
    const opened = Date.now()
    await page.goto(`${site.origin}/#/`)
    // The first answer: five rows read; the pool with no figures waits in its row, the new one in its catalogue row.
    await page.waitForFunction(() => document.querySelectorAll('#pools tbody tr.dm-mkt-row:not([data-pool-catalogue])').length === 5, null, { timeout: 15000 })
    assert.equal(site.counts.overview, 1)
    assert.equal(await page.locator(`#pools tr.dm-mkt-row:has(a.dm-mkt-name[href^="#/pool/${limited}"]) [data-metric="pending"]`).count(), 2, 'TVL and 24h volume wait')
    assert.equal(await page.locator(`#pools tr[data-pool-catalogue="${fresh}"][data-row-loading]`).count(), 1, 'the new pool keeps its placeholder')
    // Asked again at the store's collection, then once more after the rate limited one, within seconds.
    await page.waitForFunction(() => document.querySelectorAll('#pools [data-metric="pending"], #pools [data-apr-estimate="pending"], #pools tr[data-row-loading]').length === 0
      && document.querySelectorAll('#pools tbody tr.dm-mkt-row:not([data-pool-catalogue])').length === 6, null, { timeout: 20000 })
    const caughtUp = Date.now() - opened
    assert.ok(caughtUp < 12_000, `the two pools had their figures after ${caughtUp} ms`)
    assert.equal(site.counts.overview, 3, 'the first answer and two catch-ups')
    for (const poolId of [limited, fresh]) {
      const cells = await page.locator(`#pools tr.dm-mkt-row:has(a.dm-mkt-name[href^="#/pool/${poolId}"]) td`).allInnerTexts()
      assert.deepEqual(cells.slice(2, 5).map(text => text.trim().replace(/\s+/g, ' ')), RECORDED_FIGURES[poolId], `the recorded figures for ${poolId}`)
    }
    assert.equal(await page.evaluate(() => window.__said), 0, 'no row said Unavailable meanwhile')
    assert.equal(await page.evaluate(() => window.__dashes), 0, 'the new pool never showed dashes meanwhile')
    const posts = site.edge.filter(read => read.method === 'POST')
    assert.deepEqual(posts.map(read => read.path), ['/api/read/v5/featured-pools', '/api/read/v3/overview', '/api/read/v3/overview', '/api/read/v3/overview'], 'the list, the overview and its two catch-ups; no provider read')
    const asked = posts.filter(read => read.path.endsWith('/overview')).map(read => read.at)
    assert.ok(asked[1] - asked[0] >= 2400 && asked[1] - asked[0] < 4500, `the first catch-up ${asked[1] - asked[0]} ms later`)
    assertWithinBudget(posts)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
    await site.close()
  }
})

// ---------------------------------------------------------------------------
// Added 2026-09-28 (speed wave, after review; study item 31). A #/new/<pool>/<token> link's verification is asked at
// once, against the token the list on screen names then, beside the featured list's first answer instead of after it;
// that answer still decides (Journey.tsx). Only the deployable build reads the list (featuredSource.ts), so these run on
// dist behind the gate and the Worker, the gateway answering from the package fixtures. The list's answer is held until
// a pools read reaches the edge, or 1 s after it was asked (inside its 1.5 s): a verification asked only once the list
// has answered reaches the edge after it is released, never before. Where the list keeps the read, it is held until the
// page has that read's whole answer instead (fixed 2026-09-28): an early read dropped for the list's answer is then
// asked again, a second read at the edge, rather than joined in flight by the scheduler, which no test could tell from
// a read kept.
const ZERO = '0x0000000000000000000000000000000000000000'
const LINK_ENV = { APP_ORIGIN: APP, READ_BRIDGE_ENABLED: 'true', ENABLED_READS: 'token,pools,pool-market,wallet-assets,nft-positions,catalogue,pool-activity',
  READ_V2_BRIDGE_ENABLED: 'false', ENABLED_V2_READS: '', READ_V5_BRIDGE_ENABLED: 'true', ENABLED_V5_READS: 'featured-pools',
  GATEWAY_ORIGIN: 'https://gateway.test', ACCESS_CLIENT_ID: 'fixture-client', ACCESS_CLIENT_SECRET: 'fixture-secret' }
const gatewayV1 = name => readFileSync(new URL(`../../api-contracts/read-v1/fixtures/gateway/${name}.json`, import.meta.url), 'utf8')
const featuredV5 = name => JSON.parse(readFileSync(new URL(`../../api-contracts/read-v5/fixtures/valid/${name}.json`, import.meta.url), 'utf8'))
const verification = token => ({ token, maxPools: 1, poolIds: [FIXTURE_POOL] })

/**
 * The deployable build at `hash`, the featured list answering `featured` once released, and a pools read the gateway
 * holds while `hold(request)` says so (until the visit closes). The list is released when a pools read reaches the
 * edge, or, with `listAfter: 'answer'`, only once the page has a pools read's whole answer. `events` is what reached the
 * edge and when the list was released, in order; `failed` the pools reads the page cancelled after sending them and
 * before their answer arrived, complete once `offTheWire()` has resolved.
 */
async function linkVisit(hash, { featured, hold = () => false, listAfter = 'edge' }) {
  if (!existsSync(join(DIST, 'index.html'))) throw new Error('dist/index.html is missing. Run `npm run build` before this test.')
  const events = [], failed = [], errors = [], held = []
  // The page's pools reads still on the wire, and the ones an answer arrived for.
  const onWire = new Set(), answered = new WeakSet()
  const isPools = request => new URL(request.url()).pathname === '/api/read/v1/pools'
  let released = false, answerList
  const listed = new Promise(resolve => { answerList = resolve })
  const release = () => {
    if (released) return
    released = true
    events.push('list released')
    answerList()
  }
  const worker = createWorker({ getClientIp: () => '198.51.100.34', fetch: async (url, init) => {
    const [, , , version, route] = new URL(url).pathname.split('/'), request = JSON.parse(init.body)
    if (version === 'v5') {
      setTimeout(release, 1000)
      await listed
      return new Response(JSON.stringify(featured), { headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': READ_V5 } })
    }
    if (route === 'pools' && hold(request)) await new Promise(resolve => held.push(resolve))
    const name = route === 'token' ? (request.token === ZERO ? 'token.native' : 'token.success')
      : route === 'pool-market' ? 'pool-market.not-requested' : route === 'wallet-assets' ? 'wallet-assets.last-page' : `${route}.success`
    return new Response(gatewayV1(name), { headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': READ_V1 } })
  } })
  const site = createGatedServer({ dist: DIST,
    env: { BETA_PASSWORD: PASSWORD, BETA_COOKIE_KEY: 'BrowserPublicFixtureKey_0123456789_abcdefgh' },
    api: async request => {
      const url = new URL(request.url), headers = new Headers(request.headers)
      if (headers.get('origin') === url.origin) headers.set('origin', APP)
      headers.delete('host')
      const body = request.method === 'POST' ? await request.text() : undefined
      if (url.pathname === '/api/read/v1/pools') {
        events.push({ pools: JSON.parse(body) })
        if (listAfter === 'edge') release()
      }
      return worker.fetch(new Request(new URL(url.pathname, APP), { method: request.method, headers, body }), LINK_ENV)
    },
  })
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve))
  const at = `http://127.0.0.1:${site.address().port}`
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }), page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (isPools(request)) onWire.add(request) })
  page.on('response', response => answered.add(response.request()))
  page.on('requestfinished', request => {
    if (!isPools(request)) return
    onWire.delete(request)
    if (listAfter === 'answer') release()
  })
  page.on('requestfailed', request => {
    if (!isPools(request)) return
    onWire.delete(request)
    if (listAfter === 'answer' && answered.has(request)) release()
    // Fixed 2026-09-28 (PR #262's CI): a read whose answer arrived is not one the page cancelled. Under this file's
    // interception (context.route below), Chromium sometimes reports an answered read as net::ERR_ABORTED: the
    // response, then its whole body, then loadingFailed with canceled, although the page never aborted its signal nor
    // cancelled its body, and went on to preselect the pool from that very answer (21 of 830 local runs, none of 300
    // without the interception). The cancellation item 31 is about, a verification dropped for the list's answer, is
    // one sent and stopped before its answer, which is still counted. One stopped after its answer and never used
    // would leave the pool unverified or be asked again, which the other assertions catch.
    if (!answered.has(request)) failed.push({ pools: JSON.parse(request.postData()), error: request.failure()?.errorText })
  })
  await context.route('**/*', route => route.request().url().startsWith(at) ? route.continue() : route.abort())
  const login = await context.request.post(`${at}/__beta/login`, { form: { password: PASSWORD }, headers: { Origin: at }, maxRedirects: 0 })
  assert.equal(login.status(), 303)
  await page.goto(`${at}/${hash}`)
  return { page, events, failed, errors,
    /** Once every pools read the page sent has finished or failed: `failed` is then complete for what was sent. */
    async offTheWire() {
      for (const until = Date.now() + 10000; onWire.size > 0;) {
        if (Date.now() > until) throw new Error(`pools reads still on the wire after 10 s: ${[...onWire].map(request => request.postData()).join(', ')}`)
        await page.waitForTimeout(25)
      }
    },
    async close() {
      await context.close()
      release()
      for (const resolve of held) resolve()
      await new Promise(resolve => { site.close(resolve); site.closeAllConnections() })
    },
  }
}

test('a #/new link on the deployable build is verified beside the featured list’s first answer, which keeps that one read', { timeout: 30000 }, async () => {
  const visit = await linkVisit(`#/new/${FIXTURE_POOL}/${TOKEN}`, { featured: featuredV5('none'), listAfter: 'answer' })
  try {
    await visit.page.locator('[data-stage="token"][data-preselect="verified"]').waitFor({ timeout: 20000 })
    await visit.offTheWire()
    assert.equal(await visit.page.locator('[data-chosen-pool]').getAttribute('data-chosen-pool'), FIXTURE_POOL)
    assert.deepEqual(visit.events, [{ pools: verification(TOKEN) }, 'list released'], 'the verification reached the edge while the list’s answer was still held, and was the only one')
    assert.deepEqual(visit.failed, [], 'the list kept it: nothing cancelled')
    assert.deepEqual(visit.errors, [])
  } finally { await visit.close() }
})

test('a #/new link to a pool the featured list withdrew: the verification asked early is cancelled, and the pool is refused as before', { timeout: 30000 }, async () => {
  const featured = { ...featuredV5('none-with-withdrawn'), withdrawn: [{ at: 1790430634, poolId: FIXTURE_POOL, reason: 'tvl_collapse' }] }
  // The gateway holds the verification, so the list's answer lands while it is out.
  const visit = await linkVisit(`#/new/${FIXTURE_POOL}/${TOKEN}`, { featured, hold: () => true })
  try {
    await visit.page.locator('[data-stage="token"][data-preselect="withdrawn"] [data-preselect-withdrawn]').waitFor({ timeout: 20000 })
    await visit.offTheWire()
    assert.deepEqual(visit.failed, [{ pools: verification(TOKEN), error: 'net::ERR_ABORTED' }], 'the early verification was cancelled once the list withdrew the pool')
    await visit.page.waitForTimeout(1500)
    assert.deepEqual(visit.events, [{ pools: verification(TOKEN) }, 'list released'], 'asked early, and never again')
    assert.equal(await visit.page.locator('[data-chosen-pool]').count(), 0, 'nothing preselected')
    assert.deepEqual(visit.errors, [])
  } finally { await visit.close() }
})

test('a #/new link whose pool the featured list names with another token: the verification asked early is cancelled, and the pool is verified with the list’s token', { timeout: 30000 }, async () => {
  // The pool is in neither embedded list, so before the answer it is verified with the link's token; the served list
  // names it as ETH / TOKEN, which is verified with TOKEN.
  const OTHER = `0x${'2'.repeat(40)}`
  const current = featuredV5('current')
  const entry = { ...current.pools[1], poolId: FIXTURE_POOL, poolKey: { ...current.pools[1].poolKey, currency0: ZERO, currency1: TOKEN },
    tokens: [{ address: ZERO, decimals: 18, symbol: 'ETH' }, { address: TOKEN, decimals: 6, symbol: 'TOKEN' }] }
  const visit = await linkVisit(`#/new/${FIXTURE_POOL}/${OTHER}`, { featured: { ...current, pools: [current.pools[0], entry] }, hold: request => request.token === OTHER })
  try {
    await visit.page.locator('[data-stage="token"][data-preselect="verified"]').waitFor({ timeout: 20000 })
    await visit.offTheWire()
    assert.equal(await visit.page.locator('[data-chosen-pool]').getAttribute('data-chosen-pool'), FIXTURE_POOL)
    assert.deepEqual(visit.events, [{ pools: verification(OTHER) }, 'list released', { pools: verification(TOKEN) }], 'asked early with the link’s token, then with the list’s once it answered')
    assert.deepEqual(visit.failed, [{ pools: verification(OTHER), error: 'net::ERR_ABORTED' }], 'the early verification was cancelled, and decided nothing')
    assert.deepEqual(visit.errors, [])
  } finally { await visit.close() }
})
