import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { TOKEN_LOOKALIKE, type NetworkResolved, type NetworkToken, type OtherChains } from '../../../lib/create/otherChains'
import type { MarketsProvider, MarketsState } from '../../../lib/read/marketsProvider'
import { networkMarketRows } from '../../../lib/read/networkMarkets'
import { splitFlagged } from '../../../lib/read/tokenPools'
import { COPY } from '../../../lib/read/screens/copy'
import type { TokenDisplay } from '../../../lib/read/types'
import { MarketsContext } from '../../../lib/read/useMarkets'
import type { NetworkTokenLocation } from '../../explore/routes'
import { poolNetworkHref } from '../../explore/poolNetwork'
import { whenVisibleAfter } from '../../../lib/read/screens/quietRead'
import { MarketsTable } from '../../MarketsTable'
import { chainMarkProps } from '../../../lib/chainMarks'
import { networkName } from '../../../lib/networkName'
import { TokenMark } from '../../TokenIcon'
import { Button, Card, Display, Skeleton } from '../../ui'
import { Address } from './Address'
import { useNetworkPools } from './PoolPicker'
import { SymbolText } from './SymbolText'

/**
 * How long the token page waits before it reads a token again that did not read (QA round 2, the owner's rule of
 * 2026-10-30: no "temporarily unavailable" and no Try again on a read surface): a few quiet re-asks, then it rests.
 */
const READ_AGAIN_MS = [2_000, 5_000, 15_000, 30_000] as const

/** The title rises in after the breadcrumb, as Robinhood Chain's token page's does (screens/Explore.tsx). */
const rise = (step: number) => ({ '--delay': `${step * 40}ms` }) as CSSProperties

/**
 * A token of Base or Arbitrum One as its pages hold it (moved out of NetworkTokenExplorer on purpose 2026-11-06, no change
 * of behaviour, so a pool's page reads its token the same way): the row the search already holds, else the token read on
 * its network (`others.resolve`), bound to the network and the address it was asked for; a read that did not answer is
 * asked again quietly, a few times (READ_AGAIN_MS), while the page is visible. `warned`: the token passes for one of the
 * network's own currencies, refused for good, its warning in words. `resting`: still read, or waiting to be read again;
 * `spent`: its last quiet re-ask did not read it either.
 */
export function useNetworkToken(location: { chainId: NetworkTokenLocation['chainId']; token: string }, others: OtherChains | null, checking: boolean, initial: NetworkToken | null = null) {
  const { chainId, token: wire } = location
  const address = wire.toLowerCase()
  const identity = `${chainId}:${address}`
  const network = others?.name(chainId) ?? null
  const [attempt, setAttempt] = useState(0)
  const [answer, setAnswer] = useState<{ identity: string; source: OtherChains; result: NetworkResolved } | null>(null)
  const result = answer?.source === others && answer?.identity === identity ? answer.result : null
  useEffect(() => {
    if (!others || !network) return
    const controller = new AbortController()
    const known = initial?.chainId === chainId && initial.token.address.toLowerCase() === address ? initial : others.tokens(address).find((row) => row.chainId === chainId && row.token.address.toLowerCase() === address)
    const row: NetworkToken = known ?? {
      chainId, network, unread: true,
      token: { origin: 'read', chainId, address, symbol: null, decimals: null, readStatus: 'partial', artwork: null },
    }
    // Changed on purpose 2026-11-02 (review M1): a search hit listed with its warning (it passes for one of the network's
    // own currencies) is resolved too, so its page says why instead of offering New position on it; it was used as found.
    const read = row.unread || row.warning !== undefined ? others.resolve({ ...row, unread: true }, controller.signal) : Promise.resolve({ ok: true, token: row.token } as const)
    void read.then((resolved) => {
      if (controller.signal.aborted) return
      // An answer for a different currency is never used, even if its address alone happens to match.
      const bound = !resolved.ok || (resolved.token.chainId === chainId && resolved.token.address.toLowerCase() === address)
      setAnswer({ identity, source: others, result: bound ? resolved : { ok: false, code: 'identity_mismatch', reason: 'Token details could not be verified on this network.' } })
    }, () => {
      if (!controller.signal.aborted) setAnswer({ identity, source: others, result: { ok: false, code: 'unavailable', reason: 'Token details are temporarily unavailable.' } })
    })
    return () => controller.abort()
  }, [others, network, chainId, address, identity, initial, attempt])
  const token = result?.ok ? result.token : null
  // A token that did not read is read again on its own, quietly and a few times, while the page is visible; an answer
  // about another token (identity_mismatch) is not asked again.
  const failedCode = result && !result.ok ? result.code : null
  // Added 2026-11-02 (review M1): a token that passes for one of the network's own currencies is refused for good: its
  // warning is said, as Robinhood Chain's token page says it (StoredTokenExplorer), and nothing opens New position on it.
  const warned = result && !result.ok && result.code === TOKEN_LOOKALIKE ? result.reason : null
  useEffect(() => {
    if (failedCode === null || failedCode === 'identity_mismatch' || failedCode === TOKEN_LOOKALIKE || attempt >= READ_AGAIN_MS.length) return
    return whenVisibleAfter(READ_AGAIN_MS[attempt], () => { setAnswer(null); setAttempt((value) => value + 1) })
  }, [failedCode, attempt])
  // Still read, or waiting to be read again; `spent`: a token that did not read after its last quiet re-ask. An answer
  // about another token, and an origin where the network is closed, rest blank.
  const asked = !!others && !!network && failedCode !== 'identity_mismatch' && failedCode !== TOKEN_LOOKALIKE
  const spent = asked && failedCode !== null && attempt >= READ_AGAIN_MS.length
  const resting = checking || (asked && !spent)
  return { token, network, address, failedCode, warned, resting, spent, attempt }
}

/**
 * V4: the card's rise plays once (StoredTokenExplorer's own rule). A figures dialog holds it still while open
 * (v4-markets.css); once it has risen, or its rise was cut short, the card says so (data-risen). Presentation only.
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

/**
 * The token's pools as Robinhood Chain's token page lists them (StoredTokenExplorer): the Markets table, one row a pool
 * with its price, TVL, 24h volume and APR, each row opening the pool's own page; the flagged pools behind Show all. Read
 * from the network's pools read and DEX Screener's figures (useNetworkPools, lib/read/networkMarkets.ts). Until the list
 * is in, the card above rests (`onResting`). Changed on purpose 2026-11-06 (review UI-3): a list that did not read after its
 * quiet re-asks draws no table and tells the card (`onFailed`, its code), which then says what Robinhood Chain's token page
 * says of pools it could not read, "Reload the page to see this token’s pools." (StoredTokenExplorer). It drew the table
 * with "No pools to show for this token.", as if the token had none; that line stays for a read that answered with none.
 */
function NetworkTokenPools({ token, others, onResting, onFailed }: { token: TokenDisplay; others: OtherChains; onResting: (resting: boolean) => void; onFailed: (code: string | null) => void }) {
  // Changed on purpose 2026-11-07 (Elysium's screens): the token's own network, any V2 chain beside Robinhood Chain (Elysium
  // too where the build serves it); it was Arbitrum One or else Base.
  const network = token.chainId as NetworkTokenLocation['chainId']
  const { result, options, waiting, readingAgain } = useNetworkPools((signal) => others.pools(token, signal))
  const [showAll, setShowAll] = useState(false)
  const settled = (result.kind === 'ok' && !waiting) || (result.kind === 'failed' && !readingAgain)
  useEffect(() => {
    onResting(!settled)
  }, [settled, onResting])
  const failed = settled && result.kind === 'failed' ? result.code : null
  useEffect(() => {
    onFailed(failed)
  }, [failed, onFailed])
  const rows = networkMarketRows(options)
  const split = splitFlagged(rows)
  const shown = showAll ? rows : split.shown
  // The table's one source: this list, as Robinhood Chain's token page hands its rows to the same table. The rows are
  // drawn again as their figures arrive or age (useNetworkPools), and the table with them.
  const state: MarketsState = { phase: 'ready', result: { source: 'live', chainId: token.chainId, network: others.name(token.chainId) ?? '', markets: shown }, problems: [] }
  const provider: MarketsProvider = { kind: 'bridge', getSnapshot: () => state, subscribe: () => () => {}, ensure() {}, refresh() {} }
  const revealed = useMemo(() => new Set(showAll ? split.hidden.map((row) => row.poolId) : []), [showAll, split.hidden])
  if (!settled || failed !== null) return null
  return (
    <>
      <MarketsContext.Provider value={provider}>
        <MarketsTable
          variant="full"
          includeCatalogue={false}
          poolToken={token.address}
          poolLink={(market) => poolNetworkHref(network, market.poolId, token.address)}
          revealed={revealed}
          empty={<p className="p-5 text-body text-fg-muted" data-pools-empty="">{split.hidden.length > 0 ? 'Every pool of this token has a very high fee, or is one Domino can’t open positions in.' : COPY.picker.poolsNone}</p>}
        />
      </MarketsContext.Provider>
      <div className="flex flex-wrap items-center gap-3">
        {split.hidden.length > 0 && (
          <Button variant="ghost" onClick={() => setShowAll((all) => !all)} data-show-all-pools={showAll ? 'shown' : 'hidden'} title="Pools with a fee above 10% of every swap, and pools Domino can’t open positions in.">
            {showAll ? `Hide ${split.hidden.length} flagged ${split.hidden.length === 1 ? 'pool' : 'pools'}` : `Show all ${rows.length} pools`}
          </Button>
        )}
      </div>
    </>
  )
}

/**
 * A chain-qualified token page: Robinhood Chain's token page on Base or Arbitrum One. Its parent supplies the navigation.
 *
 * Changed on purpose 2026-11-06 (the owner's replica rule: Base and Arbitrum are an exact copy of Robinhood Chain's
 * screens, only the network changes): laid out as Robinhood Chain's token page is (screens/Explore.tsx's title, then
 * StoredTokenExplorer's card): "Token" over the exchange, the network and the address; one card with the token's mark,
 * its name, its address and any warning, then its pools in the Markets table (price, TVL, 24h volume, APR) with Show all,
 * each row opening the pool's own page. Gone: the New position button beside the title and the plain pool rows that each
 * opened New position (QA round 2, N5), which stood in while these networks had no pool page; New position is reached
 * from the pool's page, as on Robinhood Chain.
 */
export function NetworkTokenExplorer({ location, others, checking, initial = null, navigation }: {
  location: NetworkTokenLocation
  others: OtherChains | null
  /** Whether the other networks are still being checked. Since 2026-10-15 (pack 7) nothing is said meanwhile ("Loading token data…" is gone). */
  checking: boolean
  initial?: NetworkToken | null
  navigation: ReactNode
}) {
  const { chainId } = location
  const { token, network, address, failedCode, warned, resting, spent, attempt } = useNetworkToken(location, others, checking, initial)
  const name = network ?? networkName(chainId)
  // The token's pools still on their way: the card rests as Robinhood Chain's does while its first page is read.
  const [poolsResting, setPoolsResting] = useState(true)
  // (Review UI-3) The token's pools read, failed for good: its code, as data; the card says what to do.
  const [poolsFailed, setPoolsFailed] = useState<string | null>(null)
  const said = (!token && spent) || (token !== null && poolsFailed !== null) ? 'Reload the page to see this token’s pools.' : ''

  return (
    <div data-network-token-view={chainId}>
      <nav aria-label="Breadcrumb" className="dm-mkt-crumbs animate-rise">
        {navigation}
      </nav>
      <div className="dm-mkt-titlebar mt-4 animate-rise" style={rise(1)}>
        <div className="min-w-0">
          <Display as="h1" className="dm-display-h1">Token</Display>
          <div className="dm-mkt-tags mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <span className="dm-chip">Uniswap</span>
            <span className="dm-chip" data-chain-chip={chainId} {...chainMarkProps(chainId)}>{name}</span>
            <span className="dm-pool-id"><Address value={address} short /></span>
          </div>
        </div>
      </div>
      {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): no "Loading token data…" while the token is
          read (the status line stays, empty). Changed on purpose 2026-10-30 (QA round 2, the owner's rule: missing data
          stays out of sight, no Try again on a read surface): a token that did not read is read again on its own
          (READ_AGAIN_MS) and says nothing until its quiet re-asks are spent, then what to do, in Robinhood Chain's words.
          The state stays as data. `data-stored-token` and the title's id are Robinhood Chain's token card's hooks
          (v4-markets.css), so this card is drawn exactly as that one. A closed network's page rests blank. */}
      {!token && <p role="status" className="sr-only" data-network-token-state={checking ? 'checking' : failedCode ?? (others && network ? 'reading' : 'closed')} />}
      {(resting || spent || warned || token) && (
        <section className="mt-6 grid gap-4 dm-lit" aria-labelledby="stored-token-title" data-stored-token={address} data-network-token={chainId} ref={holdRise}>
          <Card pad="md">
            {/* V4 (D-M5): the token's mark beside its name, decoration only. */}
            {token && <span aria-hidden="true" className="dm-mkt-token-mark"><TokenMark token={token} size={44} /></span>}
            <h2 id="stored-token-title" className="dm-title" title={`Pools of this token, each checked on ${name}, with figures a market data provider reports. The list does not imply complete chain history.`}>{token ? <SymbolText token={token} /> : 'Token data'}</h2>
            <p className="mt-2 text-caption text-fg-muted"><Address value={address} /></p>
            {warned && <p role="alert" className="dm-pool-warning mt-3" data-token-warning="lookalike">{warned}</p>}
            {((!token && resting) || (token !== null && poolsResting)) && <Skeleton className="mt-3 h-5 w-48" />}
            {said && <p className="mt-3 text-caption text-fg-muted" data-network-token-spent="" data-pools-unavailable={token !== null ? (poolsFailed ?? undefined) : undefined}>{said}</p>}
          </Card>
          {token && others && <NetworkTokenPools key={`${chainId}:${address}:${attempt}`} token={token} others={others} onResting={setPoolsResting} onFailed={setPoolsFailed} />}
        </section>
      )}
    </div>
  )
}
