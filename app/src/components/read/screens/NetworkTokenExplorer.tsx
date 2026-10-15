import { useEffect, useState, type ReactNode } from 'react'
import type { NetworkResolved, NetworkToken, OtherChains } from '../../../lib/create/otherChains'
import type { TokenDisplay } from '../../../lib/read/types'
import type { NetworkTokenLocation } from '../../explore/routes'
import { TokenMark } from '../../TokenIcon'
import { Button, Card, Display } from '../../ui'
import { Address } from './Address'
import { NetworkPoolPicker } from './PoolPicker'
import { SymbolText } from './SymbolText'

/** A chain-qualified read view. Its parent supplies navigation and actions for the verified token. */
export function NetworkTokenExplorer({ location, others, checking, initial = null, navigation, actions }: {
  location: NetworkTokenLocation
  others: OtherChains | null
  /** Whether the other networks are still being checked. Since 2026-10-15 (pack 7) nothing is said meanwhile ("Loading token data…" is gone). */
  checking: boolean
  initial?: NetworkToken | null
  navigation: ReactNode
  actions: (token: TokenDisplay) => ReactNode
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
    const read = row.unread ? others.resolve(row, controller.signal) : Promise.resolve({ ok: true, token: row.token } as const)
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
  const retry = () => { setAnswer(null); setAttempt((value) => value + 1) }

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
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <span className="dm-chip">Uniswap</span>
            <span className="dm-chip" data-chain-chip={chainId}>{network ?? (chainId === 8453 ? 'Base' : 'Arbitrum One')}</span>
            <span className="dm-pool-id"><Address value={address} short /></span>
          </div>
        </div>
        {token && actions(token)}
      </header>
      {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): no "Loading token data…" while the token is
          read (the status line stays, empty). Kept on purpose: a failure that blocks the page, with its Try again, and
          "Pool discovery is unavailable on this network." on an origin where the network is closed (a feature gate). */}
      {!token && <div className="mt-6 grid justify-items-start gap-3">
        <p role="status" className="text-body text-fg-muted">
          {checking || (others && network && result === null) ? '' : result && !result.ok ? result.reason : 'Pool discovery is unavailable on this network.'}
        </p>
        {result && !result.ok && <Button variant="outline" size="sm" onClick={retry}>Try again</Button>}
      </div>}
      {token && others && <section className="dm-mkt-found animate-rise" aria-labelledby="network-found-pools-title" data-found-pools="">
        <h2 id="network-found-pools-title" className="dm-title">Pools</h2>
        <Card className="mt-3 p-2">
          <NetworkPoolPicker key={`${chainId}:${address}:${attempt}`} read={(signal) => others.pools(token, signal)} network={network} pending={null} onPending={() => undefined} browse />
        </Card>
      </section>}
    </div>
  )
}
