/**
 * Named fixture scenarios: which package fixture answers which request.
 *
 * The package ships one canonical request per route, and a few gateway
 * fixtures answer a different question than that request asks (the native
 * token, a market without history, an NFT snapshot at an older block, an NFT
 * answer about one position). Those get the request that fits them here, so
 * the identity checks can stay strict.
 *
 * Mutations change a parsed copy of a real fixture and must still pass the
 * package runtime; the tests check that. Nothing here is a hand-written payload.
 */
import type { FixtureCatalog, ReplyScript, RouteScript } from './fixtureSource'
import { BRIDGE_RETRY, type RetryPolicy } from './pipeline'
import type { ReadRequests, ReadRoute } from './types'

export const FIXTURE_POOL = '0x0911afcb281d7bcae2d71443ceaeebd0f89b4537708449970d797622b4b4c941'
export const FIXTURE_TOKEN = '0x1111111111111111111111111111111111111111'
export const NATIVE = '0x0000000000000000000000000000000000000000'

export const gateway = (name: string) => `fixtures/gateway/${name}.json`
export const errorFixture = (name: string) => `fixtures/error/${name}.json`
export const invalidFixture = (name: string) => `fixtures/invalid/${name}.json`

/** Fixtures the canonical request does not describe, and the request that does. */
export const REQUEST_OVERRIDES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  [gateway('token.native')]: { token: NATIVE },
  [gateway('pool-market.not-requested')]: { includePriceHistory: false },
  // Answered at block 650 for a request of block 700: "latest" is the question it fits.
  [gateway('nft-positions.stale')]: { blockNumber: null, tokenIds: ['1'] },
  // One position each: the question they answer asks for that one id.
  [gateway('nft-positions.empty')]: { tokenIds: ['1'] },
  [gateway('nft-positions.zero')]: { tokenIds: ['1'] },
}

export function canonicalRequest<R extends ReadRoute>(catalog: FixtureCatalog, route: R): ReadRequests[R] {
  return JSON.parse(catalog.text(`fixtures/requests/${route}.json`)) as ReadRequests[R]
}

export function requestFor<R extends ReadRoute>(catalog: FixtureCatalog, route: R, fixture?: string): ReadRequests[R] {
  return { ...canonicalRequest(catalog, route), ...(fixture ? REQUEST_OVERRIDES[fixture] : undefined) }
}

type Json = Record<string, unknown>
const obj = (value: unknown) => value as Json

/**
 * A continuation handle the fixture does not already contain elsewhere. The
 * package's own handle is the snapshot hash without its 0x, so a test looking
 * for it on the page would find the hash; this one can only come from the pager.
 */
export const MUTATED_CURSOR = `${'c0ffee'.repeat(10)}c0ff`

export const withCursor = (cursor: string) => (body: unknown) => {
  obj(obj(body).inventory).nextCursor = cursor
  return body
}

/** The catalogue fixtures are single pages; this one claims a second page after the fixture pool. */
export const withNextCataloguePage = (body: unknown) => {
  const b = obj(body)
  b.hasMore = true
  b.nextAfterPoolId = FIXTURE_POOL
  return body
}

/** The table asks without price history, so its market replies carry none. */
export const withoutHistory = (body: unknown) => {
  obj(body).priceHistory = { status: 'not_requested', reason: null, data: null, cache: null }
  return body
}

/** A pool id the fixtures never use: an answer about it is an answer to another question. */
export const OTHER_POOL = `0x${'ab'.repeat(32)}`

export const withPoolId = (poolId: string) => (body: unknown) => {
  obj(body).poolId = poolId
  return body
}

/**
 * Stale qualified metrics whose capital would fail qualification even if the
 * snapshot were fresh: reconciled over one hour only, or not reconciled at
 * all. The package runtime accepts both; neither was ever a current figure.
 */
export const withCapitalIncomplete = (body: unknown) => {
  const capital = obj(obj(body).capital)
  capital.complete24h = false
  capital.observedSeconds = 3600
  return body
}

export const withCapitalUnavailable = (body: unknown) => {
  obj(body).capital = {
    status: 'unavailable',
    reason: 'reconciled_position_tail_required',
    current: null,
    integralRawSeconds: null,
    complete24h: false,
    methodologyVersion: 1,
  }
  return body
}

export const withSymbol = (symbol: string) => (body: unknown) => {
  obj(obj(body).asset).symbol = symbol
  return body
}

/** Right-to-left override, zero-width space and markup: all valid symbol text, all hostile to a naive renderer. */
export const HOSTILE_SYMBOL = '‮evil‬​<b>WETH</b>-looking-long-symbol'

// ---------------------------------------------------------------------------
// Market rows: the real MarketsTable and Ticker over one fixture pool
// ---------------------------------------------------------------------------

export interface MarketCase {
  id: string
  title: string
  script: RouteScript
  policy?: RetryPolicy
  /** The pools the table reads: the fixture pool, unless a case says otherwise. */
  poolIds?: readonly string[]
}

const tokens = (script: ReplyScript = { fixture: gateway('token.success') }): ReplyScript[] => [
  { fixture: gateway('token.native'), expectRequest: { token: NATIVE } },
  { ...script, expectRequest: { token: FIXTURE_TOKEN } },
]

/**
 * A case of the lean table: pool-market without price history, then each
 * token. Every pool-market reply answers only that exact request, so a table
 * asking anything else gets the bridge's refusal on screen. No case scripts
 * pool-metrics: the table never asks for it, and a fixture source with no
 * reply for a route answers it as not enabled.
 */
function marketCase(id: string, title: string, market: ReplyScript | ReplyScript[], token?: ReplyScript, policy?: RetryPolicy): MarketCase {
  const lean = { poolId: FIXTURE_POOL, includePriceHistory: false }
  return {
    id,
    title,
    policy,
    script: {
      'pool-market': (Array.isArray(market) ? market : [market]).map((step) => ({ ...step, expectRequest: lean })),
      token: tokens(token),
    },
  }
}

const m = (name: string): ReplyScript => ({ fixture: gateway(`pool-market.${name}`), mutate: withoutHistory })

export const MARKET_CASES: MarketCase[] = [
  marketCase('provider', 'Provider figures', m('success')),
  marketCase('zero', 'Provider zero', m('zero')),
  marketCase('missing', 'Provider fields not reported', m('missing')),
  marketCase('stale', 'Stale provider figures', m('stale')),
  marketCase('expired', 'Expired cache with retained age', m('expired')),
  marketCase('rejected-currencies', 'Service-level identity rejection', m('rejected-currencies')),
  marketCase('rejected-dex', 'Exchange unconfirmed', m('rejected')),
  marketCase('timeout', 'Adapter-level identity failure as unavailable', m('provider-timeout')),
  marketCase('rate-limited', 'Provider rate limited', m('provider-rate-limited')),
  marketCase('untrusted-symbol', 'HTML-like symbol', m('success'), { fixture: gateway('token.untrusted-symbol') }),
  marketCase('hostile-symbol', 'Bidi, zero-width and markup symbol', m('success'), { fixture: gateway('token.success'), mutate: withSymbol(HOSTILE_SYMBOL) }),
  marketCase('retry-recovers', 'One 429, asked again after its Retry-After', [{ fixture: errorFixture('pool-market.read_capacity_busy'), retryAfter: '1' }, m('success')], undefined, BRIDGE_RETRY),
  { id: 'no-pools', title: 'No pools selected: nothing is read', script: {}, poolIds: [] },
  // Table-wide: nothing may render.
  marketCase('gate401', 'Beta gate refusal', { transport: 'gate401' }),
  marketCase('gate503', 'Beta gate misconfigured', { transport: 'gate503' }),
  marketCase('not-connected', 'No read bridge behind the /api forwarder', { transport: 'forwarder503' }),
  marketCase('not-found', 'The /api forwarder does not serve this address', { transport: 'forwarder404' }),
  marketCase('no-forwarder', 'No /api function: the site answers with its index page', { transport: 'spaHtml200' }),
  marketCase('route-disabled', 'Pool reads switched off on the server', { transport: 'routeNotAvailable404' }),
  marketCase('edge502', 'Edge error page', { transport: 'edgeHtml502' }),
  marketCase('access', 'Access redirect', { transport: 'opaqueRedirect' }),
  marketCase('header-missing', 'Contract header missing', { ...m('success'), transport: 'headerMissing' }),
  marketCase('header-rc2', 'Contract header rc.2', { ...m('success'), transport: 'headerRc2' }),
  marketCase('invalid', 'Payload fails validation', { fixture: invalidFixture('pool-market.incompatible-version') }),
  marketCase('busy', 'Read capacity busy', { fixture: errorFixture('pool-market.read_capacity_busy'), retryAfter: '7' }),
  marketCase('transient', 'A 503, shown for the person to retry', { fixture: errorFixture('pool-market.upstream_unavailable') }, undefined, BRIDGE_RETRY),
]

// ---------------------------------------------------------------------------
// Row projection with pool-metrics: the rules projectMarketRow applies when
// metrics are given. The lean table never reads them; these keep the
// qualification rules under test for the day the read service provides a
// current APR. Tests only.
// ---------------------------------------------------------------------------

export interface ProjectionCase {
  id: string
  market: ReplyScript
  metrics: ReplyScript
  token?: ReplyScript
}

/** The token replies a projected row reads: the native currency and the fixture token. */
export const projectionTokens = (token?: ReplyScript) => tokens(token)

const q = (name: string): ReplyScript => ({ fixture: gateway(`pool-metrics.${name}`) })

export const PROJECTION_CASES: ProjectionCase[] = [
  { id: 'qualified', market: m('success'), metrics: q('qualified') },
  { id: 'provider', market: m('success'), metrics: q('unqualified') },
  { id: 'zero', market: m('zero'), metrics: q('unqualified') },
  { id: 'missing', market: m('missing'), metrics: q('unqualified') },
  { id: 'stale', market: m('stale'), metrics: q('stale') },
  { id: 'expired', market: m('expired'), metrics: q('capital-unavailable') },
  { id: 'stale-capital-partial', market: m('expired'), metrics: { ...q('stale'), mutate: withCapitalIncomplete } },
  { id: 'stale-capital-unavailable', market: m('expired'), metrics: { ...q('stale'), mutate: withCapitalUnavailable } },
  { id: 'rejected-currencies', market: m('rejected-currencies'), metrics: q('unqualified') },
  { id: 'rejected-dex', market: m('rejected'), metrics: q('unqualified') },
  { id: 'timeout', market: m('provider-timeout'), metrics: q('price-capacity') },
  { id: 'rate-limited', market: m('provider-rate-limited'), metrics: q('missing-prices') },
  { id: 'reference', market: m('provider-timeout'), metrics: q('reference-analytics') },
  { id: 'partial', market: m('provider-timeout'), metrics: q('partial') },
  { id: 'metrics-invalid', market: m('success'), metrics: { fixture: invalidFixture('pool-metrics.reference-claimed-current') } },
  { id: 'metrics-other-pool', market: m('success'), metrics: { ...q('qualified'), mutate: withPoolId(OTHER_POOL) } },
]

// ---------------------------------------------------------------------------
// Family panels: every gateway fixture of every route, plus pagination
// ---------------------------------------------------------------------------

export interface FamilyCase {
  id: string
  route: ReadRoute
  request: ReadRequests[ReadRoute]
  script: RouteScript
  pager?: 'wallet' | 'catalogue'
}

export function familyCases(catalog: FixtureCatalog): FamilyCase[] {
  const cases: FamilyCase[] = catalog.index.fixtures
    .filter((entry) => entry.kind === 'gateway' && entry.route !== 'capabilities')
    .map((entry) => {
      const route = entry.route as ReadRoute
      const id = entry.file.replace(/^fixtures\/gateway\//, '').replace(/\.json$/, '')
      return {
        id,
        route,
        request: requestFor(catalog, route, entry.file),
        script: { [route]: [{ fixture: entry.file }] },
        pager: route === 'wallet-assets' ? ('wallet' as const) : route === 'catalogue' ? ('catalogue' as const) : undefined,
      }
    })

  const wallet = canonicalRequest(catalog, 'wallet-assets')
  const firstPage: ReplyScript = { fixture: gateway('wallet-assets.opaque-page'), mutate: withCursor(MUTATED_CURSOR), expectRequest: wallet }
  const catalogue = canonicalRequest(catalog, 'catalogue')
  const secondCatalogue = { ...catalogue, afterPoolId: FIXTURE_POOL, revision: 2 }
  const firstCatalogue: ReplyScript = { fixture: gateway('catalogue.success'), mutate: withNextCataloguePage, expectRequest: catalogue }

  cases.push(
    {
      id: 'wallet-assets.pages',
      route: 'wallet-assets',
      request: wallet,
      pager: 'wallet',
      script: { 'wallet-assets': [firstPage, { fixture: gateway('wallet-assets.last-page'), expectRequest: { ...wallet, cursor: MUTATED_CURSOR } }] },
    },
    {
      id: 'wallet-assets.cursor-expired',
      route: 'wallet-assets',
      request: wallet,
      pager: 'wallet',
      script: { 'wallet-assets': [firstPage, { fixture: errorFixture('wallet-assets.invalid_or_expired_cursor'), expectRequest: { ...wallet, cursor: MUTATED_CURSOR } }] },
    },
    {
      id: 'catalogue.pages',
      route: 'catalogue',
      request: catalogue,
      pager: 'catalogue',
      script: { catalogue: [firstCatalogue, { fixture: gateway('catalogue.empty'), expectRequest: secondCatalogue }] },
    },
    {
      id: 'catalogue.revision-changed',
      route: 'catalogue',
      request: catalogue,
      pager: 'catalogue',
      // The package's only 409 fixture is filed under pools; the body is the same for any route.
      script: { catalogue: [firstCatalogue, { fixture: errorFixture('pools.catalogue_revision_changed'), expectRequest: secondCatalogue }] },
    },
    {
      id: 'pools.revision-changed',
      route: 'pools',
      request: canonicalRequest(catalog, 'pools'),
      script: { pools: [{ fixture: errorFixture('pools.catalogue_revision_changed') }, { fixture: gateway('pools.catalogue') }] },
    },
  )
  return cases
}
