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
  assert.match(await page.locator('[data-pool-ratio-chart]').innerText(), /Partial coverage/)
  assert.equal(calls.some(call => ['token', 'pools', 'pool-market'].includes(call.route)), false)
  assert.deepEqual(errors, [])
  await context.close()
})

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
    assert.ok(took < 12000, `the six cards took ${took} ms to draw`)
    assert.equal(await page.locator('#market-rail').getAttribute('aria-label'), 'Selected pools, last 24 hours')
    const shown = await page.locator('#market-rail [data-market-card]').evaluateAll(cards => cards.map(card => [card.getAttribute('data-market-card'),
      card.querySelector('[data-price-line]') ? 'line' : card.querySelector('[data-volume-bar]') ? 'bars' : card.querySelector('[data-chart-unavailable]').getAttribute('data-chart-unavailable')]))
    assert.deepEqual(shown, SELECTED.map(poolId => [poolId, poolId === notBuilt ? 'not_built' : 'line']), 'five pools draw their price; the one not built yet shows its figure')
    const figure = page.locator(`[data-market-card="${notBuilt}"] [data-chart-unavailable] [data-metric]`)
    assert.equal(await figure.innerText(), '$1.0K', 'the row’s own 24h volume, drawn in the plot')
    const captions = await page.locator('#market-rail .dm-mkt-card-caption').allInnerTexts()
    assert.deepEqual(captions, SELECTED.map(poolId => poolId === notBuilt ? '24h volume' : 'Price · 24h'))
    // Pointing along a line names one hour: its close in the quote token, and its swaps.
    const line = page.locator(`[data-market-card="${SELECTED[0]}"] [data-price-line]`)
    const box = await line.boundingBox()
    await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2)
    assert.match(await page.locator(`[data-market-card="${SELECTED[0]}"] .dm-mkt-card-caption`).innerText(), /^\d\d:00 UTC · 123\.5 TOKEN per ETH · 4 swaps$/)

    const posts = edge.filter(read => read.method === 'POST')
    assert.equal(posts.filter(read => read.path.startsWith('/api/read/v1/')).length, 0, 'no provider read: no read-v1 pool-market, nothing else of read-v1')
    assert.deepEqual(posts.map(read => read.path), ['/api/read/v3/overview', ...SELECTED.map(() => '/api/read/v3/history')], 'the table’s one overview, then one history read per card')
    for (let i = 1; i < posts.length; i++) assert.ok(posts[i].at - posts[i - 1].at >= 1050, `POST starts ${posts[i].at - posts[i - 1].at} ms apart`)
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
