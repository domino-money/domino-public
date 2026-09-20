/** The compiled app behind its real beta gate and Worker, with only the
 * private gateway replaced by contract fixtures. No network or credentials
 * outside the local test server are used. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright-core'
import { createWorker } from '../../bridge/src/worker.mjs'
import { BRIDGE_DIST, createGatedServer } from '../scripts/gated-server.mjs'

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
  await browser?.close()
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
