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
}

const tokens = (script: ReplyScript = { fixture: gateway('token.success') }): ReplyScript[] => [
  { fixture: gateway('token.native'), expectRequest: { token: NATIVE } },
  { ...script, expectRequest: { token: FIXTURE_TOKEN } },
]

function marketCase(id: string, title: string, market: ReplyScript | ReplyScript[], metrics: ReplyScript | null, token?: ReplyScript, policy?: RetryPolicy): MarketCase {
  return {
    id,
    title,
    policy,
    script: {
      'pool-market': Array.isArray(market) ? market : [market],
      'pool-metrics': metrics ? [metrics] : [],
      token: tokens(token),
    },
  }
}

const m = (name: string): ReplyScript => ({ fixture: gateway(`pool-market.${name}`), mutate: withoutHistory })
const q = (name: string): ReplyScript => ({ fixture: gateway(`pool-metrics.${name}`) })

export const MARKET_CASES: MarketCase[] = [
  marketCase('qualified', 'Qualified metrics', m('success'), q('qualified')),
  marketCase('provider', 'Provider figures, metrics unqualified', m('success'), q('unqualified')),
  marketCase('zero', 'Provider zero', m('zero'), q('unqualified')),
  marketCase('missing', 'Provider fields not reported', m('missing'), q('unqualified')),
  marketCase('stale', 'Stale provider and stale metrics', m('stale'), q('stale')),
  marketCase('expired', 'Expired cache with retained age', m('expired'), q('capital-unavailable')),
  marketCase('stale-capital-partial', 'Stale metrics, capital over 1 h only', m('expired'), { ...q('stale'), mutate: withCapitalIncomplete }),
  marketCase('stale-capital-unavailable', 'Stale metrics, capital unavailable', m('expired'), { ...q('stale'), mutate: withCapitalUnavailable }),
  marketCase('rejected-currencies', 'Service-level identity rejection', m('rejected-currencies'), q('unqualified')),
  marketCase('rejected-dex', 'Exchange unconfirmed', m('rejected'), q('unqualified')),
  marketCase('timeout', 'Adapter-level identity failure as unavailable', m('provider-timeout'), q('price-capacity')),
  marketCase('rate-limited', 'Provider rate limited', m('provider-rate-limited'), q('missing-prices')),
  marketCase('reference', 'Reference analytics', m('provider-timeout'), q('reference-analytics')),
  marketCase('partial', 'Partial window', m('provider-timeout'), q('partial')),
  marketCase('untrusted-symbol', 'HTML-like symbol', m('success'), q('qualified'), { fixture: gateway('token.untrusted-symbol') }),
  marketCase('hostile-symbol', 'Bidi, zero-width and markup symbol', m('success'), q('qualified'), { fixture: gateway('token.success'), mutate: withSymbol(HOSTILE_SYMBOL) }),
  marketCase('metrics-invalid', 'Metrics payload fails validation', m('success'), { fixture: invalidFixture('pool-metrics.reference-claimed-current') }),
  marketCase('metrics-other-pool', 'Qualified metrics answered for another pool', m('success'), { ...q('qualified'), mutate: withPoolId(OTHER_POOL) }),
  marketCase('retry-recovers', 'One 429, asked again after its Retry-After', [{ fixture: errorFixture('pool-market.read_capacity_busy'), retryAfter: '1' }, m('success')], q('qualified'), undefined, BRIDGE_RETRY),
  // Table-wide: nothing may render.
  marketCase('gate401', 'Beta gate refusal', { transport: 'gate401' }, null),
  marketCase('gate503', 'Beta gate misconfigured', { transport: 'gate503' }, null),
  marketCase('edge502', 'Edge error page', { transport: 'edgeHtml502' }, null),
  marketCase('access', 'Access redirect', { transport: 'opaqueRedirect' }, null),
  marketCase('header-missing', 'Contract header missing', { ...m('success'), transport: 'headerMissing' }, null),
  marketCase('header-rc2', 'Contract header rc.2', { ...m('success'), transport: 'headerRc2' }, null),
  marketCase('invalid', 'Payload fails validation', { fixture: invalidFixture('pool-market.incompatible-version') }, null),
  marketCase('busy', 'Read capacity busy', { fixture: errorFixture('pool-market.read_capacity_busy'), retryAfter: '7' }, null),
  marketCase('transient', 'A 503, shown for the person to retry', { fixture: errorFixture('pool-market.upstream_unavailable') }, null, undefined, BRIDGE_RETRY),
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
