import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { flushSync } from 'react-dom'
import { catalogueTokens } from '../config/selectedPoolCatalogue'
import { exploreHref, marketsHref, parseExploreHash, poolHref } from '../components/explore/routes'
import { useHash } from '../components/explore/useHash'
import { IconChevronLeft, IconSearch } from '../components/icons'
import { FilterBar } from '../components/markets/FilterBar'
import { MarketCarousel } from '../components/markets/MarketCarousel'
import { MarketsTable } from '../components/MarketsTable'
import { Address } from '../components/read/screens/Address'
import { CatalogueCandidates, PoolPicker } from '../components/read/screens/PoolPicker'
import { SymbolText } from '../components/read/screens/SymbolText'
import { TokenLookup } from '../components/read/screens/TokenLookup'
import { TokenSearch } from '../components/read/screens/TokenSearch'
import { StoredTokenExplorer } from '../components/read/screens/StoredTokenExplorer'
import { Button, Card, Display, EmptyState, PageShell } from '../components/ui'
import { parseAddressInput } from '../lib/read/screens/identity'
import { useReadSource } from '../lib/read/screens/readContext'
import { knownTokens } from '../lib/read/screens/tokenSearch'
import { handoffFor, selectable, type TokenCandidate } from '../lib/read/screens/tokens'

const NONE: ReadonlySet<string> = new Set()

/** The first four blocks of a page rise in, 60ms apart. */
const rise = (step: number) => ({ '--delay': `${step * 60}ms` }) as CSSProperties

function Title() {
  return (
    <>
      <Display as="h1" className="dm-display-title">
        Markets
      </Display>
      <p className="mt-2 text-body text-fg-muted">Uniswap pools on Robinhood Chain.</p>
    </>
  )
}

/**
 * The list: the rail of selected pools with their last 24 hours, the table
 * with its two filters, and a way to any other token's pools. Filters live in
 * this page's state only. A token chosen in either search goes to the token
 * view by the address bar.
 */
function MarketsList({ onToken }: { onToken: (candidate: TokenCandidate) => void }) {
  const source = useReadSource()
  const [asset, setAsset] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [count, setCount] = useState<{ shown: number; total: number } | null>(null)
  const [catalogueOpen, setCatalogueOpen] = useState(false)
  const known = knownTokens({ catalogue: catalogueTokens(), candidates: [] })
  // An address typed as a pair name matches no pool; the token search starts from it instead.
  const pasted = parseAddressInput(query.trim())
  const seed = pasted.ok ? pasted.wire : undefined
  const filtered = asset !== null || query.trim() !== ''
  const clear = () => {
    setAsset(null)
    setQuery('')
  }

  const empty = (
    <EmptyState
      icon={<IconSearch />}
      title="No selected pool matches"
      body="Find a listed token by name, or paste any Robinhood Chain token address to see its pools."
      className="dm-mkt-empty"
      action={
        <div className="dm-mkt-empty-actions">
          {source && <TokenSearch key={seed ?? ''} source={source} known={known} onFound={onToken} id="markets-token" label="Token name or address" initialValue={seed} />}
          <Button variant="ghost" size="sm" onClick={clear}>
            Clear filters
          </Button>
        </div>
      }
    />
  )

  return (
    <>
      <MarketCarousel heading={<Title />} />
      <section className="dm-mkt-pools animate-rise" style={rise(2)} aria-labelledby="markets-pools-title">
        <div className="dm-mkt-pools-head">
          <Display as="h2" id="markets-pools-title" className="dm-display-card">
            Selected pools
          </Display>
          {filtered && count && count.shown > 0 && (
            <span className="tnum text-caption text-fg-subtle" role="status">
              {count.shown} of {count.total}
            </span>
          )}
        </div>
        <FilterBar asset={asset} query={query} onAsset={setAsset} onQuery={setQuery} />
        <div className="mt-3">
          <MarketsTable variant="full" filter={{ asset, query }} onMatchCount={(shown, total) => setCount({ shown, total })} empty={empty} />
        </div>
      </section>
      <details className="dm-details dm-mkt-catalogue animate-rise" style={rise(3)} data-catalogue-search="" open={catalogueOpen} onToggle={(event) => setCatalogueOpen(event.currentTarget.open)}>
        <summary>Search the pool catalogue</summary>
        <div className="grid gap-4">
          <p className="max-w-[64ch] text-body text-fg-muted">For pools beyond the selected ones, choose a token by name or paste its address.</p>
          {catalogueOpen && source && (
            <div className="dm-mkt-catalogue-search">
              <TokenSearch source={source} known={known} onFound={onToken} id="markets-catalogue-token" label="Find a token by name or address" />
            </div>
          )}
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
export function Explore() {
  const source = useReadSource()
  const location = parseExploreHash(useHash())
  const [storedReads, setStoredReads] = useState<'checking' | 'enabled' | 'legacy' | 'failed'>('checking')
  useEffect(() => {
    // The selected table owns its capability check. Only a token detail
    // needs a separate choice between stored and legacy exploration.
    if (!location.token) return
    const controller = new AbortController()
    void (source?.supportsStoredReads ? source.routeEnabled?.('overview', { signal: controller.signal }) ?? Promise.resolve({ state: 'not_enabled' as const }) : Promise.resolve({ state: 'not_enabled' as const })).then((check) => {
      if (!controller.signal.aborted) setStoredReads(check.state === 'enabled' ? 'enabled' : check.state === 'not_enabled' ? 'legacy' : 'failed')
    })
    return () => controller.abort()
  }, [source, location.token])
  const [found, setFound] = useState<TokenCandidate | null>(null)
  const [finding, setFinding] = useState<string | null>(null)
  // The answer the token search read for the address it opens, handed to that token view once.
  const [handoff, setHandoff] = useState<TokenCandidate | null>(null)
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

  const open = (poolId: string, token: string) => {
    window.location.hash = poolHref(poolId, token)
  }

  const showPools = candidate !== null && finding === candidate.key && selectable(candidate)
  const canBrowse = candidate !== null && selectable(candidate)

  if (!wire) {
    return (
      <PageShell data-markets="">
        <MarketsList onToken={onToken} />
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
          <Display as="h1" className="dm-display-title">Token</Display>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <span className="dm-chip">Uniswap</span>
            <span className="dm-chip">Robinhood Chain</span>
            <span className="dm-pool-id"><Address value={searchedKey ?? wire} short /></span>
          </div>
        </div>
      </div>

      {source && storedReads === 'enabled' && searchedKey && <StoredTokenExplorer key={searchedKey} source={source} token={searchedKey} />}
      {source && storedReads === 'checking' && <p className="mt-6 text-body text-fg-muted" role="status">Loading token data…</p>}
      {source && storedReads === 'failed' && <p className="mt-6 text-body text-fg-muted" role="status">Token data is unavailable. Reload to reconnect.</p>}
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
            <Display as="h2" id="found-pools-title" className="dm-display-card">
              Pools for <SymbolText token={candidate.token} />
            </Display>
          </div>
          <Card className="mt-3 p-2">
            <PoolPicker key={candidate.key} source={source} token={candidate.key} paired={null} pending={null} onPending={() => undefined} onOpen={(option) => open(option.key, candidate.wire)} catalogue={false} compact />
          </Card>
        </section>
      )}

      {storedReads === 'legacy' && <details className="dm-details dm-mkt-catalogue" data-catalogue-browser="">
        <summary>Search the pool catalogue</summary>
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
