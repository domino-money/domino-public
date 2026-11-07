// The screens' own styles (styles/screens.css, F8): loaded with the first screen that needs them, never on Home's first paint.
import '../styles/screens.css'
import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { SELECTED_POOL_CATALOGUE, catalogueTokens } from '../config/selectedPoolCatalogue'
import { exploreHref, marketsHref, marketsNetworkHref, parseExploreHash, parseMarketsNetworkHash, poolHref } from '../components/explore/routes'
import { useHash } from '../components/explore/useHash'
import { IconChevronLeft, IconSearch } from '../components/icons'
import { FilterBar } from '../components/markets/FilterBar'
import { MarketCarousel } from '../components/markets/MarketCarousel'
import { MarketsTable } from '../components/MarketsTable'
import { Address } from '../components/read/screens/Address'
import { CatalogueCandidates, PoolPicker } from '../components/read/screens/PoolPicker'
import { SymbolText } from '../components/read/screens/SymbolText'
import { TokenLookup } from '../components/read/screens/TokenLookup'
import { NetworkTokenExplorer } from '../components/read/screens/NetworkTokenExplorer'
import { TokenSearch } from '../components/read/screens/TokenSearch'
import { StoredTokenExplorer } from '../components/read/screens/StoredTokenExplorer'
import { SectionHead } from '../components/figures'
import { Button, Card, Display, EmptyState, PageShell } from '../components/ui'
import { parseAddressInput } from '../lib/read/screens/identity'
import { featuredTitle } from '../lib/read/featuredList'
import { useFeatured } from '../lib/read/featuredSource'
import { useRouteTitle } from '../lib/routeTitle'
import { useReadSource } from '../lib/read/screens/readContext'
import { askAgainLater } from '../lib/read/screens/screenRead'
import { knownTokens } from '../lib/read/screens/tokenSearch'
import { handoffFor, selectable, type TokenCandidate } from '../lib/read/screens/tokens'
import type { NetworkToken, OtherChains } from '../lib/create/otherChains'
import { recovering } from '../lib/staleRelease'

type NetworksProps = { children: (others: OtherChains | null, checking: boolean) => ReactNode }
const MarketsNetworks = __DOMINO_V2__ ? lazy(recovering(() => import('../v2in/journey/MarketsNetworks'), () => ({ default: ({ children }: NetworksProps) => children(null, false) }))) : null

const NONE: ReadonlySet<string> = new Set()

/** The first four blocks of a page rise in, 40ms apart (first load only: navigation cross-fades). */
const rise = (step: number) => ({ '--delay': `${step * 40}ms` }) as CSSProperties

/**
 * V4: when the title drawn while the page's networks load gives way to the page's own, the page's title keeps rising
 * where the first one stood (v4-markets.css --dm-title-shift) instead of rising a second time: the first title's
 * clock is kept here, the page's own reads it once. Presentation only.
 */
let waitingTitleAt: number | null = null
const startTitleClock = (heading: HTMLHeadingElement | null) => {
  if (!heading) return
  const now = document.timeline?.currentTime
  waitingTitleAt = typeof now === 'number' ? now : null
}
const followTitleClock = (heading: HTMLHeadingElement | null) => {
  if (!heading || waitingTitleAt === null) return
  const now = document.timeline?.currentTime
  const ran = typeof now === 'number' ? now - waitingTitleAt : 0
  waitingTitleAt = null
  if (ran > 0 && ran < 1500) heading.style.setProperty('--dm-title-shift', `${-Math.round(ran)}ms`)
}

/**
 * V4: the pools card's rise plays once. A figures dialog holds it still while open (v4-markets.css); once it has risen,
 * or its rise was cut short, the card says so (data-risen) and no later state replays it. Presentation only.
 */
function holdRise(card: HTMLElement | null) {
  if (!card) return
  const done = (event: Event) => { if (event.target === card) card.setAttribute('data-risen', '') }
  card.addEventListener('animationend', done)
  card.addEventListener('animationcancel', done)
  return () => {
    card.removeEventListener('animationend', done)
    card.removeEventListener('animationcancel', done)
  }
}

/** Changed on purpose 2026-10-04 (the owner: Domino covers more than one network): the title alone, no "Uniswap pools on Robinhood Chain." under it. */
function Title({ waiting = false }: { waiting?: boolean }) {
  return (
    <Display as="h1" className="dm-display-h1" ref={waiting ? startTitleClock : followTitleClock}>
      Markets
    </Display>
  )
}

/**
 * The list: the rail of selected pools with their last 24 hours, the table
 * with its token filter, and a way to any other token's pools. The filter lives in
 * this page's state only. A token chosen in the main search goes to the token
 * view by the address bar.
 *
 * Changed on purpose 2026-10-02 (owner: only today's list on Markets): one table, today's list. The second table audit
 * B5 (2026-10-01) put under it, "Selected pools" with the embedded pools the list did not name, is gone, and the pools
 * the list does not name are not read here (tests/release.browser.test.mjs (v)).
 */
function MarketsList({ onToken, others, onNetwork }: { onToken: (candidate: TokenCandidate) => void; others: OtherChains | null; onNetwork: (row: NetworkToken) => Promise<{ ok: true }> }) {
  const source = useReadSource()
  const [asset, setAsset] = useState<string | null>(null)
  const [count, setCount] = useState<{ shown: number; total: number } | null>(null)
  const catalogueSearch = useRef<HTMLDivElement>(null)
  // The list on screen (lib/read/featuredSource.ts) names the section and the tokens the search knows by name.
  const featured = useFeatured()
  // The catalogue is always within reach. TokenSearch still reads only for an entered query.
  // The embedded list's tokens stay known by name after the list's own, so a featured list never makes one unfindable.
  const known = knownTokens({ catalogue: catalogueTokens(featured.source === 'bundled' ? featured.entries : [...featured.entries, ...SELECTED_POOL_CATALOGUE]), candidates: [] })
  const ranked = __DOMINO_POOL_SET__ === 'selected' && featured.source === 'server'
  const filtered = asset !== null
  // The count beside the title while a filter is set and something matches (QA round 2, N89).
  const counted = filtered && count !== null && count.shown > 0 ? count : null
  const clear = () => setAsset(null)

  const empty = (
    <EmptyState
      icon={<IconSearch />}
      title="No selected pool matches"
      body="Search a token name or contract address to see its pools."
      className="dm-mkt-empty"
      action={
        <div className="dm-mkt-empty-actions">
          {source && <Button size="sm" onClick={() => catalogueSearch.current?.querySelector('input')?.focus()}>Search all pools</Button>}
          <Button variant="ghost" size="sm" onClick={clear}>
            Clear filters
          </Button>
        </div>
      }
    />
  )

  return (
    <>
      <header className="dm-v3-market-heading animate-rise">
        <Title />
        {/* Changed on purpose 2026-10-30 (QA round 2, N102 and N33): the search's own label and placeholder, as in New
            position; where the other networks are searched too, "Search a token on any network". */}
        <div ref={catalogueSearch} className="dm-v3-market-search" data-catalogue-search="">
          {source && <TokenSearch source={source} known={known} onFound={onToken} id="markets-catalogue-token" home={others?.home} others={others?.tokens} othersSearch={others?.search} onOther={others ? onNetwork : undefined} />}
        </div>
      </header>
      <section className="dm-v3-market-featured animate-rise" style={rise(1)} aria-label="Featured pool charts">
        <MarketCarousel heading={null} />
      </section>
      <section className="dm-mkt-pools dm-lit animate-rise" style={rise(2)} aria-labelledby="markets-pools-title" ref={holdRise}>
        <div className="dm-mkt-pools-toolbar">
          <SectionHead
            id="markets-pools-title"
            title={featuredTitle(ranked ? 'server' : 'bundled')}
            className="dm-mkt-pools-head"
            aside={
              counted ? (
                <span className="tnum" aria-hidden="true">
                  {counted.shown} of {counted.total}
                </span>
              ) : undefined
            }
          />
          {/* QA round 2, N89: the count's live region is always there, so it is heard when the filter changes, and it says
              of what ("Showing 1 of 6 pools"); the "1 of 6" on screen is unchanged and silent. */}
          <span className="sr-only" role="status" data-pools-count="">
            {counted ? `Showing ${counted.shown} of ${counted.total} pools` : ''}
          </span>
          <FilterBar asset={asset} onAsset={setAsset} />
        </div>
        <div className="dm-mkt-pools-table">
          <MarketsTable variant="full" filter={{ asset, query: '' }} onMatchCount={(shown, total) => setCount({ shown, total })} empty={empty} />
        </div>
      </section>
      <details className="dm-details dm-mkt-guide">
        <summary>New to pools? Start here</summary>
        <div className="dm-mkt-guide-grid">
          <div><span className="dm-guide-number" aria-hidden="true">01</span><h2>Choose a pair</h2><p>A pool holds two tokens. People pay a fee to trade between them.</p></div>
          <div><span className="dm-guide-number" aria-hidden="true">02</span><h2>Compare the activity</h2><p>TVL is the money in the pool. Volume is how much people traded. APR is an estimate, not a promise.</p></div>
          <div><span className="dm-guide-number" aria-hidden="true">03</span><h2>Create your position</h2><p>Choose a price range and an amount. Review everything before your wallet signs.</p></div>
        </div>
      </details>
    </>
  )
}

/**
 * Markets: the selected pools on a rail and in a table, and a way to any other
 * pool on Robinhood Chain through its token. A searched token lives in the
 * address bar (`#/markets/<address>`), so a search can be shared and a link
 * from another page opens it; one token read answers it (the search's own,
 * handed to the view it opens, or the view's when a link opened it), and its
 * pools are read only when asked for, or at once when a link from elsewhere
 * opened it. The catalogue is paged on request, and a candidate opens its page
 * only once the pools route has verified it at the latest block.
 */
function ExploreBody({ others = null, checkingNetworks = false }: { others?: OtherChains | null; checkingNetworks?: boolean }) {
  const source = useReadSource()
  const hash = useHash()
  const location = parseExploreHash(hash)
  const networkLocation = parseMarketsNetworkHash(hash)
  // The tab's name (lib/routeTitle.ts, audit E11): Markets, or a token's pools.
  useRouteTitle(location.token || networkLocation ? 'Token pools' : 'Markets')
  const [storedReads, setStoredReads] = useState<'checking' | 'enabled' | 'legacy' | 'failed'>('checking')
  // The quiet re-asks of the token view's capabilities check, by token (audit A11, 2026-10-01).
  const [checked, setChecked] = useState<{ token: string; attempt: number } | null>(null)
  const checkAttempt = location.token && checked?.token === location.token ? checked.attempt : 0
  useEffect(() => {
    // The selected table owns its capability check. Only a token detail
    // needs a separate choice between stored and legacy exploration.
    if (!location.token) return
    const token = location.token
    const controller = new AbortController()
    void (async () => {
      const check = source?.supportsStoredReads ? ((await source.routeEnabled?.('overview', { signal: controller.signal })) ?? { state: 'not_enabled' as const }) : { state: 'not_enabled' as const }
      if (controller.signal.aborted) return
      if (check.state !== 'failed') {
        setStoredReads(check.state === 'enabled' ? 'enabled' : 'legacy')
        return
      }
      // Changed 2026-10-01 (audit A11): a check that failed for the moment is asked again on its own, as a pool's page
      // does, while the page says it is loading; past the quiet re-asks, or for a failure that cannot clear by itself,
      // the token is explored the older way. Only the gate's own answers say to reload: they need the person.
      const gate = check.outcome.state === 'gate_required' || check.outcome.state === 'gate_unavailable' || check.outcome.state === 'access_required'
      if (gate) {
        setStoredReads('failed')
        return
      }
      setStoredReads('checking')
      if (await askAgainLater(check.outcome, checkAttempt, controller.signal)) setChecked({ token, attempt: checkAttempt + 1 })
      else if (!controller.signal.aborted) setStoredReads('legacy')
    })()
    return () => controller.abort()
  }, [source, location.token, checkAttempt])
  const [found, setFound] = useState<TokenCandidate | null>(null)
  const [finding, setFinding] = useState<string | null>(null)
  // The answer the token search read for the address it opens, handed to that token view once.
  const [handoff, setHandoff] = useState<TokenCandidate | null>(null)
  const [networkHandoff, setNetworkHandoff] = useState<NetworkToken | null>(null)
  // The token chosen on this page, so a link from elsewhere is told apart
  // from a search made here: a link says "find pools", a search asks first.
  const typed = useRef<string | null>(null)
  const autoFind = useRef<string | null>(null)

  const wire = location.token
  const asked = wire ? parseAddressInput(wire) : null
  const searchedKey = asked?.ok ? asked.key : null
  const candidate = found && searchedKey && found.key === searchedKey ? found : null

  // An older link with a pool id in its section part goes straight to that pool's page.
  useEffect(() => {
    if (location.linkedPool) window.location.replace(poolHref(location.linkedPool))
  }, [location.linkedPool])

  useEffect(() => {
    if (!searchedKey) return
    if (typed.current === wire) {
      typed.current = null
      return
    }
    autoFind.current = searchedKey
  }, [wire, searchedKey])

  // TokenLookup keeps the latest callback in a ref, so this needs no memo.
  const onFound = (next: TokenCandidate) => {
    setFound(next)
    // Used once: back or forward to the same token, or a link to it, reads again.
    setHandoff(null)
    if (autoFind.current === next.key && selectable(next)) setFinding(next.key)
    autoFind.current = null
  }

  // A token chosen in a search here: its view opens by the address bar with the search's answer, and its pools wait to be asked for.
  const onToken = (chosen: TokenCandidate) => {
    typed.current = chosen.wire
    autoFind.current = null
    // Committed before the hash moves: useHash re-renders on hashchange at sync priority
    // (useSyncExternalStore), which would otherwise mount the token view before a
    // default-priority update lands, and the view would read the token again.
    flushSync(() => setHandoff(handoffFor(chosen, chosen.wire)))
    window.location.hash = exploreHref(chosen.wire)
  }

  const onNetwork = async (row: NetworkToken): Promise<{ ok: true }> => {
    flushSync(() => setNetworkHandoff(row))
    window.location.hash = marketsNetworkHref(row.chainId, row.token.address)
    return { ok: true }
  }

  const open = (poolId: string, token: string) => {
    window.location.hash = poolHref(poolId, token)
  }

  const showPools = candidate !== null && finding === candidate.key && selectable(candidate)
  const canBrowse = candidate !== null && selectable(candidate)

  if (networkLocation) {
    return <PageShell data-markets=""><NetworkTokenExplorer
      key={`${networkLocation.chainId}:${networkLocation.token.toLowerCase()}`}
      location={networkLocation} others={others} checking={checkingNetworks} initial={networkHandoff}
      navigation={<a href={marketsHref()} className="dm-mkt-back"><IconChevronLeft size={14} />Markets</a>}
      // Changed on purpose 2026-11-06 (the owner's replica rule): Robinhood Chain's token page, so no New position beside
      // the title and each pool row opens the pool's own page (#/pool/network/<chain>/<pool>/<token>), whose Create a
      // position opens New position on this network with that pool proposed. QA round 2's N5 (a row opened New position
      // directly) stood in while these networks had no pool page.
    /></PageShell>
  }

  if (!wire) {
    return (
      <PageShell data-markets="">
        <MarketsList onToken={onToken} others={others} onNetwork={onNetwork} />
      </PageShell>
    )
  }

  return (
    <PageShell data-markets="">
      <nav aria-label="Breadcrumb" className="dm-mkt-crumbs animate-rise">
        <a href={marketsHref()} className="dm-mkt-back">
          <IconChevronLeft size={14} />
          Markets
        </a>
      </nav>
      <div className="dm-mkt-titlebar mt-4 animate-rise" style={rise(1)}>
        <div className="min-w-0">
          <Display as="h1" className="dm-display-h1">Token</Display>
          <div className="dm-mkt-tags mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <span className="dm-chip">Uniswap</span>
            <span className="dm-chip">Robinhood Chain</span>
            <span className="dm-pool-id"><Address value={searchedKey ?? wire} short /></span>
          </div>
        </div>
      </div>

      {source && storedReads === 'enabled' && searchedKey && <StoredTokenExplorer key={searchedKey} source={source} token={searchedKey} />}
      {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): no "Loading token data…" while the check
          runs. The access failure below is kept on purpose: it blocks the page and says what to do. */}
      {/* Changed on purpose 2026-10-30 (QA round 2, the owner's rule: no "unavailable" notices): what to do, alone. */}
      {source && storedReads === 'failed' && <p className="mt-6 text-body text-fg-muted" role="status">Reload the page to see this token’s pools.</p>}
      {source && storedReads === 'legacy' && (
        <div className="mt-6 animate-rise" style={rise(2)}>
          <TokenLookup
            key={wire}
            source={source}
            wire={wire}
            initial={handoffFor(handoff, wire) ?? undefined}
            onFound={onFound}
            actions={(token) => (
              <Button onClick={() => setFinding(token.key)} aria-disabled={finding === token.key ? true : undefined} data-find-pools="">
                {finding === token.key ? 'Pools below' : 'Find pools'}
              </Button>
            )}
          />
        </div>
      )}

      {storedReads === 'legacy' && showPools && candidate && source && (
        <section className="dm-mkt-found animate-rise" aria-labelledby="found-pools-title" data-found-pools="">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 id="found-pools-title" className="dm-title">
              Pools for <SymbolText token={candidate.token} />
            </h2>
          </div>
          <Card className="mt-3 p-2 dm-lit">
            <PoolPicker key={candidate.key} source={source} token={candidate.key} paired={null} pending={null} onPending={() => undefined} onOpen={(option) => open(option.key, candidate.wire)} catalogue={false} compact />
          </Card>
        </section>
      )}

      {storedReads === 'legacy' && <details className="dm-details dm-mkt-catalogue dm-lit" data-catalogue-browser="">
        <summary>
          <IconSearch size={16} className="dm-mkt-catalogue-icon" />
          Search the pool catalogue
        </summary>
        <div className="grid gap-3">
          {canBrowse && candidate && source ? (
            <CatalogueCandidates key={candidate.key} source={source} token={candidate.key} paired={null} verified={NONE} verifiedNote="Verified: opening this pool." onVerified={(option) => open(option.key, candidate.wire)} />
          ) : (
            <p className="text-body text-fg-muted">The catalogue is read for one token at a time, once the token above has been read.</p>
          )}
        </div>
      </details>}
    </PageShell>
  )
}

export function Explore() {
  if (!MarketsNetworks) return <ExploreBody />
  return <Suspense fallback={<PageShell data-markets=""><Title waiting /></PageShell>}>
    <MarketsNetworks>{(others, checking) => <ExploreBody others={others} checkingNetworks={checking} />}</MarketsNetworks>
  </Suspense>
}
