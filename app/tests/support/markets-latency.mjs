/**
 * The deployable build behind its real beta gate and read Worker, with the private gateway replaced by the recorded
 * stored overview of the selected pools (support/selected-overview.recorded.json) and, on every hop, the latency a
 * visitor meets on production. Added 2026-09-27 (r6/marketsdata) to measure where the time to the first pool figures
 * goes on Home and Markets, and to keep it there: tests/read-public.browser.test.mjs uses it.
 *
 * Latency is per edge route, in milliseconds, on top of the local server's own time:
 *   - `edge`: every /api request's round trip to the edge (the Worker answers capabilities itself);
 *   - `featured`, `overview`, `history`: the gateway's answer for that route, through the tunnel;
 *   - `asset`: every static file (the bundle and its chunks).
 * `store(body, overviews)` may rewrite an overview answer (a pool behind, a collection failed), or answer with a
 * Response of its own (a refusal). `history(request, body)` may rewrite a card's history answer (not built, by default).
 */
import { readFileSync } from 'node:fs'
import { createWorker } from '../../../bridge/src/worker.mjs'
import { DIST, createGatedServer } from '../../scripts/gated-server.mjs'
import { historyFor } from '../markets-cards.fixtures.mjs'

const v3 = (name) => JSON.parse(readFileSync(new URL(`../../../api-contracts/read-v3/fixtures/${name}.json`, import.meta.url), 'utf8'))
const v5 = (name) => JSON.parse(readFileSync(new URL(`../../../api-contracts/read-v5/fixtures/valid/${name}.json`, import.meta.url), 'utf8'))
export const RECORDED = JSON.parse(readFileSync(new URL('./selected-overview.recorded.json', import.meta.url), 'utf8'))
export const LATENCY_PASSWORD = 'markets-latency-fixture'

/** Production-like hops, measured on the owner's side of the world: an edge round trip, and the tunnel to the VM behind it. */
export const TYPICAL = Object.freeze({ edge: 90, featured: 350, overview: 700, history: 600, asset: 25 })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The recorded overview for exactly the pools asked for, as the store serves it. */
export function recordedOverview(request) {
  const currencies = new Map(RECORDED.pools.map((entry) => [entry.poolId, entry.value.market.pool.currencies]))
  const pools = request.poolIds.map((poolId) => RECORDED.pools.find((entry) => entry.poolId === poolId))
  const wanted = new Set(pools.flatMap((entry) => currencies.get(entry.poolId)))
  return { ...RECORDED, requestedPoolIds: request.poolIds, pools, tokens: RECORDED.tokens.filter((entry) => wanted.has(entry.address)) }
}

/**
 * Starts the site. Returns its origin, the edge log (`{ method, path, at, done }`, ms since `startedAt`) and `close`.
 */
export async function startLatencySite({ latency = TYPICAL, store = null, history = null, featured = 'none', dist = DIST } = {}) {
  const env = { APP_ORIGIN: 'https://app.test', READ_BRIDGE_ENABLED: 'true', ENABLED_READS: '',
    READ_V2_BRIDGE_ENABLED: 'false', ENABLED_V2_READS: '',
    READ_V3_BRIDGE_ENABLED: 'true', ENABLED_V3_READS: 'overview,history,search',
    READ_V5_BRIDGE_ENABLED: 'true', ENABLED_V5_READS: 'featured-pools',
    GATEWAY_ORIGIN: 'https://gateway.test', ACCESS_CLIENT_ID: 'fixture-client', ACCESS_CLIENT_SECRET: 'fixture-secret' }
  const edge = []
  const counts = { overview: 0, history: 0, featured: 0 }
  const startedAt = Date.now()
  const worker = createWorker({ getClientIp: () => '198.51.100.40', fetch: async (url, init) => {
    const route = new URL(url).pathname.split('/').at(-1), request = JSON.parse(init.body)
    let body
    if (route === 'overview') {
      counts.overview += 1
      await sleep(latency.overview)
      body = recordedOverview(request)
      if (store) body = store(body, counts.overview)
      // A store may answer with a refusal of its own (a Response): passed on as the gateway sent it.
      if (body instanceof Response) return body
    } else if (route === 'history') {
      counts.history += 1
      await sleep(latency.history)
      body = historyFor(request, { built: false })
      body.quoteCurrency = RECORDED.pools.find((entry) => entry.poolId === request.poolId)?.value.market.pool.currencies.find((currency) => currency !== request.currency) ?? null
      if (history) body = history(request, body)
    } else if (route === 'featured-pools') {
      counts.featured += 1
      await sleep(latency.featured)
      body = { ...v5(featured), servedAt: Math.floor(Date.now() / 1000) }
    } else body = v3(route)
    // The list's own version (read-v5 answers rc.1 or rc.2 while the VM moves to rc.2, 2026-09-28): the Worker refuses
    // a list that names another version than its header.
    const contract = route === 'featured-pools' ? body.contractVersion : '3.0.0-rc.1'
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': contract } })
  } })
  const site = createGatedServer({ dist,
    env: { BETA_PASSWORD: LATENCY_PASSWORD, BETA_COOKIE_KEY: 'BrowserLatencyFixtureKey_0123456789_abcdefgh' },
    api: async (request) => {
      const url = new URL(request.url), headers = new Headers(request.headers)
      const entry = { method: request.method, path: url.pathname, at: Date.now() - startedAt, done: null }
      edge.push(entry)
      if (headers.get('origin') === url.origin) headers.set('origin', env.APP_ORIGIN)
      headers.delete('host')
      await sleep(latency.edge)
      const response = await worker.fetch(new Request(new URL(url.pathname, env.APP_ORIGIN), { method: request.method, headers,
        body: request.method === 'POST' ? await request.text() : undefined }), env)
      entry.done = Date.now() - startedAt
      return response
    },
  })
  // Static files meet their own latency: the bundle is not free on production either.
  const handler = site.listeners('request')[0]
  site.removeAllListeners('request')
  site.on('request', (req, res) => {
    if (latency.asset && !req.url.startsWith('/api/') && !req.url.startsWith('/__beta')) setTimeout(() => handler(req, res), latency.asset)
    else handler(req, res)
  })
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${site.address().port}`
  return {
    origin, edge, counts, startedAt,
    close: () => new Promise((resolve) => { site.close(resolve); site.closeAllConnections() }),
  }
}

/** Signs a browser context in through the gate. */
export async function signIn(context, origin) {
  const login = await context.request.post(`${origin}/__beta/login`, { form: { password: LATENCY_PASSWORD }, headers: { Origin: origin }, maxRedirects: 0 })
  if (login.status() !== 303) throw new Error(`gate login answered ${login.status()}`)
}

/**
 * Marks, in ms since navigation (performance.now()), the first moment each is on screen: Home's table rows read,
 * its first and its sixth figure, the ticker's first and sixth APR, Markets' rows and figures, and its six cards.
 * Also counts how often a Home row with figures lost them again (`flicker`).
 */
export const PROBE = `(() => {
  const marks = {}; let flicker = 0; let shown = new Set()
  const mark = (name) => { if (!(name in marks)) marks[name] = Math.round(performance.now()) }
  const figured = (rows) => rows.filter((row) => /\\$/.test(row.querySelectorAll('td')[2]?.innerText ?? ''))
  const scan = () => {
    const home = [...document.querySelectorAll('#pools tbody tr.dm-mkt-row')]
    if (home.length) {
      const read = home.filter((row) => !row.hasAttribute('data-pool-catalogue'))
      if (read.length) mark('home_first_row')
      if (read.length === home.length) mark('home_all_rows')
      const figs = figured(home)
      if (figs.length) mark('home_first_figure')
      if (figs.length === home.length) mark('home_all_figures')
      const now = new Set(figs.map((row) => row.querySelector('a')?.getAttribute('href')))
      for (const id of shown) if (!now.has(id)) flicker += 1
      shown = now
    }
    const apr = [...document.querySelectorAll('.dm-marquee > a.dm-ticker-item')].filter((item) => /% est|% APR/.test(item.innerText))
    if (apr.length) mark('ticker_first_apr')
    if (apr.length >= 6) mark('ticker_all_apr')
    const markets = [...document.querySelectorAll('[data-selected-pools] tbody tr.dm-mkt-row')]
    if (markets.length) {
      const figs = figured(markets)
      if (figs.length) mark('markets_first_figure')
      if (figs.length === markets.length) mark('markets_all_figures')
    }
    const cards = [...document.querySelectorAll('#market-rail [data-market-card]')]
    if (cards.length && cards.every((card) => card.querySelector('[data-price-line], [data-volume-bar], [data-chart-unavailable] [data-metric]'))) mark('cards_all')
    window.__md = { marks, flicker }
  }
  setInterval(scan, 10)
})()`
