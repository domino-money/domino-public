/**
 * Read-v3 answers for the six selected pools, built from the package's own
 * fixtures, for the Markets cards' browser test (read-public.browser.test.mjs,
 * added 2026-09-24). Only pool ids and history candles change; every answer
 * still passes read-v3's own runtime, which the Worker checks on the way out.
 */
import { readFileSync } from 'node:fs'

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../api-contracts/read-v3/fixtures/${name}.json`, import.meta.url), 'utf8'))
export const SELECTED = readFileSync(new URL('../src/config/selectedPools.ts', import.meta.url), 'utf8').match(/0x[0-9a-f]{64}/g)
const TEMPLATE = fixture('overview')
const TEMPLATE_POOL = TEMPLATE.pools[0].poolId

/** The stored overview for exactly the pools asked for, each the fixture pool under its own id. */
export function overviewFor(request) {
  const body = fixture('overview')
  body.selectedToken = request.token ?? null
  body.requestedPoolIds = request.poolIds ?? []
  if (!request.token) body.pools = body.requestedPoolIds.map((poolId) => JSON.parse(JSON.stringify(TEMPLATE.pools[0]).replaceAll(TEMPLATE_POOL, poolId)))
  return body
}

/**
 * The pool's stored hourly ratio over the 24 hours to the current hour: every
 * hour covered and closed, a gentle rise, and a few swaps each. `built: false`
 * is a pool whose history lane has not built it yet.
 */
export function historyFor(request, { built = true, nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  const body = fixture('history')
  const end = Math.floor(nowSeconds / 3600) * 3600
  const start = end - (request.windowSeconds ?? 86400)
  const other = TEMPLATE.pools[0].value.market.pool.currencies.find((currency) => currency !== request.currency) ?? null
  Object.assign(body, { poolId: request.poolId, currency: request.currency, quoteCurrency: other, requestedWindow: { startTimestamp: start, endTimestamp: end },
    resolutionSeconds: request.resolutionSeconds ?? 3600, snapshot: { ...body.snapshot, timestamp: nowSeconds } })
  if (!built) return Object.assign(body, { status: 'not_built', reason: 'history_acquisition_pending', snapshot: null, covered: [], gaps: [{ startTimestamp: start, endTimestamp: end }], candles: [] })
  const candles = Array.from({ length: 24 }, (_, hour) => {
    const close = `${100 + hour}.5`
    return { startTimestamp: start + hour * 3600, open: close, high: close, low: close, close, swapCount: 2 + (hour % 3), complete: true }
  })
  return Object.assign(body, { status: 'available', reason: null, covered: [{ startTimestamp: start, endTimestamp: end }], gaps: [], candles })
}
