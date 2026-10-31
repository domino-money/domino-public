import { useEffect, useMemo, useState } from 'react'
import type { ReadRequests, ReadSource } from '../../../lib/read/types'
import type { MarketsProvider, MarketsState } from '../../../lib/read/marketsProvider'
import type { Market } from '../../../lib/markets'
import { overviewRows } from '../../../lib/read/publicOverview'
import { candidateFromToken } from '../../../lib/read/screens/tokens'
import { askAgainLater, readWithin, type ScreenOutcome } from '../../../lib/read/screens/screenRead'
import { whenVisibleAfter } from '../../../lib/read/screens/quietRead'
import { hintsWithin } from '../../../lib/read/screens/poolHints'
import { usablePoolsRequest } from '../../../lib/read/screens/poolsList'
import { featuredPoolIds } from '../../../lib/read/screens/featuredPools'
import { useKnownMarkets } from '../../../lib/read/screens/knownMarkets'
import { tokenWarning, warningText } from '../../../lib/read/screens/lookalike'
import { addressKey } from '../../../lib/read/screens/identity'
import { discoveryRows, mergeTokenPools, splitFlagged } from '../../../lib/read/tokenPools'
import { dexStore } from '../../../lib/read/dexFigures'
import { useFeatured } from '../../../lib/read/featuredSource'
import { MarketsContext } from '../../../lib/read/useMarkets'
import { MarketsTable } from '../../MarketsTable'
import { Button, Card, Skeleton } from '../../ui'
import { TokenMark } from '../../TokenIcon'
import { Address } from './Address'
import { SymbolText } from './SymbolText'

type Page = Pick<ReadRequests['overview'], 'afterPoolId' | 'revision'>
type Success = Extract<ScreenOutcome<'overview'>, { state: 'ok' }>

/**
 * The pools DEX Screener lists for the token, verified on chain by the read service's pools route, as New position
 * reads them (audit V2, 2026-10-01): the hints first (one token-pairs GET, shared with the artwork, through our own
 * edge), then one pools read naming today's listed pools that hold the token and the most liquid of the hints. Asked
 * again on its own, a few times, when the read service was busy or briefly out; nothing on screen says how it went.
 */
function useDiscoveredPools(source: ReadSource, token: string): Market[] {
  const [rows, setRows] = useState<{ token: string; rows: Market[] } | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    void (async () => {
      // Only where the deployment lists the pools route: a capabilities answer, no read of the budget.
      if (!source.routeEnabled) return
      const check = await source.routeEnabled('pools', { signal })
      if (signal.aborted || check.state !== 'enabled') return
      const key = addressKey(token)
      const request = usablePoolsRequest(key, null, await hintsWithin(key, null, signal))
      if (signal.aborted) return
      let outcome = await readWithin(source, 'pools', request, { signal })
      if (outcome.state === 'restart_required' && outcome.code === 'catalogue_revision_changed') outcome = await readWithin(source, 'pools', request, { signal, deadlineAt: outcome.provenance.deadlineAt })
      if (signal.aborted || outcome.state === 'aborted') return
      if (outcome.state === 'ok') setRows({ token, rows: discoveryRows(outcome.data, outcome.provenance) })
      else if (await askAgainLater(outcome, attempt, signal)) setAttempt((n) => n + 1)
    })()
    return () => controller.abort()
  }, [source, token, attempt])
  return rows?.token === token ? rows.rows : NONE
}

const NONE: Market[] = []

/** The read's answers that are not asked again on their own: they need the person (a gate to pass, a reload). */
const STOPPED: readonly string[] = ['gate_required', 'gate_unavailable', 'access_required', 'disabled', 'not_connected', 'incompatible', 'invalid']

/** One bounded page at a time. Storage acquisition survives leaving the page;
 * this consumer only refreshes visible observations and never waits for full
 * historical coverage before showing current values.
 *
 * Changed 2026-10-01 (audit V2, B6, I1): the first page also lists the pools the pools route verified for the token
 * (useDiscoveredPools), each pool once; today's Top pools that hold the token first, then by liquidity; the pools with
 * a very high fee or that Domino can't open positions in are flagged and left out until "Show all"; how many pools are
 * still being collected is said; and a token that passes for one of the site's main tokens says so first. */
/**
 * V4: the card's rise plays once. A figures dialog holds it still while open (v4-markets.css); once it has risen, or its
 * rise was cut short, the card says so (data-risen) and no later state replays it. Presentation only.
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

export function StoredTokenExplorer({ source, token }: { source: ReadSource; token: string }) {
  const [pages, setPages] = useState<Page[]>([{}])
  const [refresh, setRefresh] = useState(0)
  const [answer, setAnswer] = useState<{ key: string; outcome: ScreenOutcome<'overview'> } | null>(null)
  const [retained, setRetained] = useState<{ key: string; outcome: Success } | null>(null)
  const [showAll, setShowAll] = useState(false)
  const page = pages[pages.length - 1]
  const key = `${token}:${page.afterPoolId ?? ''}:${page.revision ?? ''}`
  const outcome = answer?.key === key ? answer.outcome : null
  const value = outcome?.state === 'ok' ? outcome : retained?.key === key ? retained.outcome : null
  const featured = useFeatured()
  const discovered = useDiscoveredPools(source, token)

  useEffect(() => {
    const controller = new AbortController()
    let cancel: (() => void) | null = null
    const load = async () => {
      const read = await readWithin(source, 'overview', { token, ...page, limit: 24 }, { signal: controller.signal })
      if (controller.signal.aborted || read.state === 'aborted') return
      if (read.state === 'restart_required' && pages.length > 1) {
        setPages([{}]); setAnswer(null); setRetained(null)
        return
      }
      setAnswer({ key, outcome: read })
      if (read.state === 'ok') setRetained({ key, outcome: read })
      // Only a page with something still being acquired earns the fast poll.
      // A settled page asked again every five seconds was twelve reads a minute
      // through a gateway that serves one at a time, for figures that had
      // already arrived. And when the producer REFUSED the acquisition —
      // acquisitionAccepted false, its capacity ceiling — asking harder is
      // exactly wrong: it cannot start until the ceiling drains, so back off and
      // let it.
      const stop = STOPPED.includes(read.state)
      const busy = read.state === 'ok' && (read.data.tokens.some((entry) => entry.acquisition.status === 'pending') || read.data.pools.some((entry) => entry.acquisition.status === 'pending'))
      const refused = read.state === 'ok' && read.data.acquisitionAccepted === false
      const after = read.state !== 'ok' ? 60_000 : busy ? (refused ? 30_000 : 5_000) : 60_000
      if (!stop) cancel = whenVisibleAfter(after, () => setRefresh((n) => n + 1))
    }
    if (typeof document === 'undefined' || !document.hidden) void load()
    else cancel = whenVisibleAfter(0, () => void load())
    return () => { controller.abort(); cancel?.() }
  }, [source, token, page, key, pages.length, refresh])

  const firstPage = pages.length === 1
  const stored = useMemo(() => (value ? overviewRows(value) : NONE), [value])
  // Today's Top pools that hold the token come first (B6), then the largest by liquidity; DEX Screener's figure orders a
  // pool whose own figures the provider refused.
  const listed = useMemo(() => featuredPoolIds(addressKey(token), null, featured.entries), [token, featured.entries])
  // QA round 2, N10: a pool of today's list the token's stored page does not hold takes the row Markets already shows for
  // it (read before, never here), ahead of the pools route's row without figures: the token's own row first, then the
  // Markets row, then the route's.
  const known = useKnownMarkets()
  const listedRows = useMemo(() => {
    if (!firstPage || !known || listed.length === 0) return NONE
    const held = new Set(stored.map((row) => row.poolId))
    const wanted = new Set(listed.map((poolId) => poolId.toLowerCase()))
    return known.filter((row) => wanted.has(row.poolId) && !held.has(row.poolId))
  }, [firstPage, known, listed, stored])
  const merged = useMemo(() => mergeTokenPools(listedRows.length ? [...stored, ...listedRows] : stored, firstPage ? discovered : NONE, { listed, liquidity: (poolId) => dexStore.pool(poolId)?.liquidityUsd ?? null }), [stored, listedRows, discovered, firstPage, listed])
  const split = useMemo(() => splitFlagged(merged), [merged])
  const rows = showAll ? merged : split.shown
  // The flagged pools Show all brings in rise into place (V4 token.html); none while they are folded away.
  const revealed = useMemo(() => new Set(showAll ? split.hidden.map((row) => row.poolId) : []), [showAll, split])
  const provider = useMemo<MarketsProvider>(() => {
    const state: MarketsState = { phase: 'ready', result: { source: 'live', chainId: 4663, network: 'Robinhood Chain', markets: rows }, problems: [] }
    return { kind: 'bridge', getSnapshot: () => state, subscribe: () => () => {}, ensure() {}, refresh() { setRefresh((n) => n + 1) } }
  }, [rows])
  const selected = value?.data.tokens.find((entry) => entry.address === token)
  const candidate = selected?.value ? candidateFromToken(selected.value, token) : null
  const warning = candidate ? tokenWarning(candidate.token) : null
  const collecting = value?.data.pools.filter((entry) => entry.acquisition.status === 'pending').length ?? 0
  const pending = value?.data.tokens.some((entry) => entry.acquisition.status === 'pending') || collecting > 0
  // The producer says whether it took the acquisition on. Refused and pending
  // is not "collecting": nothing is collecting, and saying so forever is a lie
  // a person cannot act on. Same words the history chart already uses.
  const atCapacity = pending === true && value?.data.acquisitionAccepted === false
  // Changed on purpose 2026-10-30 (QA round 2, the owner's rule: no "unavailable" notices; missing data rests as loading
  // and is asked again quietly): a read that failed and is asked again on its own rests as loading, saying nothing (it
  // used to print the failure's title, e.g. "Pool data unavailable"); one that is not asked again says what to do.
  const stopped = !!outcome && STOPPED.includes(outcome.state)
  const loading = !value && !stopped && merged.length === 0
  // Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): the line under the token no longer says how the
  // reads went: gone are the failed read's title (e.g. "Pool data unavailable"), "Domino’s data service is busy, so only
  // the pools already stored are shown.", "Collecting figures for N pools. The rest are below." and "Collecting data.
  // Available figures are shown below." A token that could not be verified still says so (a caution before adding
  // money), and "Reading pools…" stays for assistive technology only, beside the loading bubble.
  // (2026-10-15, pack 7 review): a failed read with no pool to show kept main's line, its title. Changed on purpose
  // 2026-10-30 (above): only a read that is not asked again keeps a line, and it says what to do.
  const said = stopped && merged.length === 0 ? 'Reload the page to see this token’s pools.' : selected?.acquisition.status === 'rejected' ? 'This token could not be verified.' : loading ? 'Reading pools…' : ''

  return (
    <section className="mt-6 grid gap-4 dm-lit" aria-labelledby="stored-token-title" data-stored-token={token} data-acquisition={atCapacity ? 'at_capacity' : pending ? 'pending' : 'settled'} data-pools-merged={merged.length} data-pools-discovered={discovered.length} ref={holdRise}>
      <Card pad="md">
        {/* V4 (D-M5): the token's mark beside its name, decoration only. */}
        {candidate && <span aria-hidden="true" className="dm-mkt-token-mark"><TokenMark token={candidate.token} size={44} /></span>}
        <h2 id="stored-token-title" className="dm-title" title="Pools stored for this token, and the ones a market data provider lists for it, each checked on Robinhood Chain. The list does not imply complete chain history.">{candidate ? <SymbolText token={candidate.token} /> : 'Token data'}</h2>
        <p className="mt-2 text-caption text-fg-muted"><Address value={token} /></p>
        {warning && <p role="alert" className="dm-pool-warning mt-3" data-token-warning={warning.kind}>{warningText(warning, 'token')}</p>}
        {!value && !stopped && <Skeleton className="mt-3 h-5 w-48" />}
        <p role="status" className={said && !loading ? 'mt-3 text-caption text-fg-muted' : 'sr-only'}>{said}</p>
      </Card>
      {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): while the token's pools are still being
          collected (or the producer is at capacity) the empty table rests as a loading bubble; it used to say "Domino’s
          data service is busy, and no pools of this token are stored yet." or "Pool data is being collected." */}
      {(value || merged.length > 0) && <MarketsContext.Provider value={provider}><MarketsTable variant="full" includeCatalogue={false} poolToken={token} revealed={revealed} empty={atCapacity || pending ? <div className="p-5"><Skeleton className="mx-auto h-10 max-w-[30rem]" /></div> : <p className="p-5 text-body text-fg-muted">{split.hidden.length > 0 ? 'Every pool of this token has a very high fee, or is one Domino can’t open positions in.' : 'No verified pools are stored for this token yet.'}</p>} /></MarketsContext.Provider>}
      <div className="flex flex-wrap items-center gap-3">
        {split.hidden.length > 0 && (
          <Button variant="ghost" onClick={() => setShowAll((all) => !all)} data-show-all-pools={showAll ? 'shown' : 'hidden'} title="Pools with a fee above 10% of every swap, and pools Domino can’t open positions in.">
            {showAll ? `Hide ${split.hidden.length} flagged ${split.hidden.length === 1 ? 'pool' : 'pools'}` : `Show all ${merged.length} pools`}
          </Button>
        )}
        {pages.length > 1 && <Button variant="ghost" onClick={() => { setPages((prior) => prior.slice(0, -1)); setAnswer(null); setRetained(null) }}>Previous pools</Button>}
        {value?.data.hasMore && value.data.nextAfterPoolId && <Button onClick={() => { setPages((prior) => [...prior, { afterPoolId: value.data.nextAfterPoolId, revision: value.data.revision }]); setAnswer(null); setRetained(null) }}>More pools</Button>}
      </div>
    </section>
  )
}
