import { useEffect, useState, type ReactNode } from 'react'
import { TOKEN_LOOKALIKE, type NetworkResolved, type NetworkToken, type OtherChains } from '../../../lib/create/otherChains'
import type { PoolOption } from '../../../lib/read/screens/poolsList'
import type { TokenDisplay } from '../../../lib/read/types'
import type { NetworkTokenLocation } from '../../explore/routes'
import { whenVisibleAfter } from '../../../lib/read/screens/quietRead'
import { TokenMark } from '../../TokenIcon'
import { Card, Display, Skeleton } from '../../ui'
import { Address } from './Address'
import { NetworkPoolPicker } from './PoolPicker'
import { SymbolText } from './SymbolText'

/**
 * How long the token page waits before it reads a token again that did not read (QA round 2, the owner's rule of
 * 2026-10-30: no "temporarily unavailable" and no Try again on a read surface): a few quiet re-asks, then it rests.
 */
const READ_AGAIN_MS = [2_000, 5_000, 15_000, 30_000] as const

/** A chain-qualified read view. Its parent supplies navigation and actions for the verified token. */
export function NetworkTokenExplorer({ location, others, checking, initial = null, navigation, actions, openPool }: {
  location: NetworkTokenLocation
  others: OtherChains | null
  /** Whether the other networks are still being checked. Since 2026-10-15 (pack 7) nothing is said meanwhile ("Loading token data…" is gone). */
  checking: boolean
  initial?: NetworkToken | null
  navigation: ReactNode
  actions: (token: TokenDisplay) => ReactNode
  /** QA round 2, N5: what opening one of the token's pools does (the caller's: New position on this network, the pool proposed). */
  openPool?: (token: TokenDisplay, option: PoolOption) => void
}) {
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

  return (
    <div data-network-token-view={chainId}>
      <nav aria-label="Breadcrumb" className="dm-mkt-crumbs animate-rise">
        {navigation}
      </nav>
      <header className="dm-mkt-titlebar mt-4 animate-rise">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            {token && <TokenMark token={token} size={36} />}
            <Display as="h1" className="dm-display-h1">{token ? <SymbolText token={token} /> : 'Token'}</Display>
          </div>
          <div className="dm-mkt-tags mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <span className="dm-chip">Uniswap</span>
            <span className="dm-chip" data-chain-chip={chainId}>{network ?? (chainId === 8453 ? 'Base' : 'Arbitrum One')}</span>
            <span className="dm-pool-id"><Address value={address} short /></span>
          </div>
        </div>
        {token && actions(token)}
      </header>
      {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): no "Loading token data…" while the token is
          read (the status line stays, empty). Changed on purpose 2026-10-30 (QA round 2, the owner's rule: missing data
          stays out of sight, no Try again on a read surface): a token that did not read is read again on its own
          (READ_AGAIN_MS) and says nothing; gone are its reason on screen ("Token details are temporarily unavailable.",
          "Token details could not be verified on this network."), the Try again button and "Pool discovery is
          unavailable on this network." on an origin where the network is closed. The state stays as data. */}
      {!token && <p role="status" className="sr-only" data-network-token-state={checking ? 'checking' : failedCode ?? (others && network ? 'reading' : 'closed')} />}
      {/* QA round 2 review: while the token is read, or read again, the page rests (as the Robinhood Chain token page does,
          StoredTokenExplorer); once its quiet re-asks are spent it says what to do, in the Robinhood Chain page's words. */}
      {!token && resting && <Skeleton className="mt-6 h-5 w-48" />}
      {!token && spent && <p className="mt-6 text-body text-fg-muted" data-network-token-spent="">Reload the page to see this token’s pools.</p>}
      {warned && <p role="alert" className="dm-pool-warning mt-6" data-token-warning="lookalike">{warned}</p>}
      {token && others && <section className="dm-mkt-found animate-rise" aria-labelledby="network-found-pools-title" data-found-pools="">
        <h2 id="network-found-pools-title" className="dm-title">Pools</h2>
        <Card className="mt-3 p-2 dm-lit">
          <NetworkPoolPicker key={`${chainId}:${address}:${attempt}`} read={(signal) => others.pools(token, signal)} network={network} pending={null} onPending={() => undefined} browse onOpen={openPool ? (option) => openPool(token, option) : undefined} />
        </Card>
      </section>}
    </div>
  )
}
