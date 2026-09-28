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
import { withStalePools } from './support/stale-store.mjs'

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
 * spends none of its budget on it (scheduler.ts EDGE_ANSWERED) and it is not counted here.
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
    assert.match(await page.locator(`[data-market-card="${SELECTED[0]}"] .dm-mkt-card-caption`).innerText(), /^\d\d:00 UTC · 1 ETH = 123\.5 TOKEN · 4 swaps$/)

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
    assert.deepEqual(reads.filter(read => read.route === 'history').map(read => read.request).sort((a, b) => a.poolId.localeCompare(b.poolId)),
      SELECTED.map(poolId => ({ poolId, currency: '0x0000000000000000000000000000000000000000', windowSeconds: 86400, resolutionSeconds: 3600 })).sort((a, b) => a.poolId.localeCompare(b.poolId)))
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
