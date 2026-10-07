import { useEffect, useMemo, useState } from 'react'
import { positionHref } from '../../components/explore/routes'
import { Button } from '../../components/ui'
import { MANAGED_APPEAR, NOTHING_YET_BOTH, type CardShows } from '../../lib/automationCards'
import { useWalletIdentity } from '../../lib/walletIdentity'
import { v2Chain } from '../../v2/chains'
import type { V2Gate } from '../../v2/gate'
import type { Address, V2ChainId } from '../../v2/types'
import { ChainBadge } from '../lists/parts'
import { v2PositionHref } from '../route'
import { gateOpen, useGate } from './gate'
import { IndexStatus } from './IndexStatus'
import { tokenMetaOf } from './portfolio'
import { routeQuiet, usePortfolio } from './read6'
import { poolTokens } from './tokens'
import { automatedPositions, automationMode, automationStanding, shownVaultView, type VaultView } from './vaultView'

/** An overview of NFTs, not vault history. Transactions belong to the position's own control. */
const CHAINS: readonly V2ChainId[] = [4663, 8453, 42161]
const CONTENT: CardShows = Object.freeze({ kind: 'content' })
const NOTHING_YET: CardShows = Object.freeze({ kind: 'none', reason: 'empty', text: NOTHING_YET_BOTH, action: null })

export default function ManagedVaults({ onShows, receipts = null }: { onShows?: (shows: CardShows | null) => void; receipts?: CardShows | null }) {
  const robinhood = useGate('vault', 4663)
  const base = useGate('vault', 8453)
  const arbitrum = useGate('vault', 42161)
  const gates: Record<V2ChainId, V2Gate | null> = useMemo(() => ({ 4663: robinhood, 8453: base, 42161: arbitrum }), [robinhood, base, arbitrum])
  const shownChains = useMemo(() => CHAINS.filter((chainId) => gateOpen(gates[chainId])), [gates])
  const readGate = shownChains.length === 0 ? null : gates[shownChains[0]]
  const identity = useWalletIdentity()
  const connected = identity.kind === 'connected' ? identity.address.toLowerCase() as Address : null
  const answer = usePortfolio(connected, readGate)
  const [now] = useState(() => Math.floor(Date.now() / 1000))
  const [showInactive, setShowInactive] = useState(false)
  const body = answer?.reply.kind === 'ok' ? answer.reply.body : null
  const rows = useMemo(() => body && answer ? automatedPositions(body.vaults
    .filter((vault) => shownChains.includes(vault.chainId))
    .map((vault) => shownVaultView(vault, body, answer.wallet, now, null)), body) : [], [body, answer, shownChains, now])
  const visible = rows.filter((row) => showInactive || row.active)
  const inactive = rows.filter((row) => !row.active).length
  const hasRows = rows.length > 0
  const word = hasRows ? CONTENT : receipts === null ? null : receipts.kind === 'none' ? receipts : NOTHING_YET
  useEffect(() => { onShows?.(word) }, [onShows, word])
  const hrefOf = (view: VaultView) => view.chainId === 4663 && view.dex === 4 ? positionHref(view.rootTokenId.toString()) : v2PositionHref({ chainId: view.chainId, dex: view.dex, tokenId: view.rootTokenId })

  return (
    <>
      {!hasRows && <><p className="dm-acct-desc">Current automation and any funds waiting to be recovered.</p><div className="dm-acct-plot" data-v2in-vaults-empty=""><span>{MANAGED_APPEAR}</span></div></>}
      {(hasRows || (answer && answer.reply.kind !== 'ok' && !routeQuiet(answer))) && (
        <section aria-label="Automated positions" className="dm-v2in-vaults" data-v2in-vaults={rows.length}>
          {answer && answer.reply.kind !== 'ok' && <IndexStatus failed={answer.reply} chainId={4663} what="Your automation" />}
          {body && shownChains.map((chainId) => <IndexStatus key={chainId} chains={body.chains} chainId={chainId} what="Your automation" />)}
          {body && (body.truncated.vaults || body.truncated.mandates) && <p role="status" className="dm-acct-note">Some automation records are not included in this read. Open a position to check its available balances and controls.</p>}
          {hasRows && visible.length === 0 && <p className="dm-acct-note">No active or paused automation.</p>}
          {visible.length > 0 && <ul className="dm-mp-list">
            {visible.map((row) => {
              const view = row.current
              const standing = automationStanding(view)
              const tokens = view.pool && body ? poolTokens(v2Chain(view.chainId), view.pool, tokenMetaOf(body.tokens, view.chainId)) : null
              return <li key={row.key} className="dm-mp-row dm-automated-row" data-automated-position={row.key} data-vault-card={view.vault} data-vault-status={view.status ?? 'unknown'} data-vault-exit={view.exit ?? undefined}>
                <a className="dm-automated-link" href={hrefOf(view)}>
                  <span className="dm-mp-name">{tokens ? <><bdi>{tokens[0].label}</bdi> / <bdi>{tokens[1].label}</bdi></> : `Position #${view.rootTokenId}`}</span>
                  {tokens && <span className="dm-acct-note">Position #{view.rootTokenId.toString()}</span>}
                  <span className="dm-automated-meta"><ChainBadge name={v2Chain(view.chainId).name} chainId={view.chainId} compact /><span>{automationMode(view)} · {standing}</span></span>
                  {row.recovery && <span className="dm-acct-note">{row.vaults.some((v) => !v.reserves.known) ? 'Balances need a refresh' : 'Funds available in automation'} · Review in position</span>}
                </a>
              </li>
            })}
          </ul>}
          {inactive > 0 && <Button type="button" variant="ghost" size="sm" onClick={() => setShowInactive((value) => !value)} data-automated-history="">{showInactive ? 'Hide closed and inactive' : `Show closed and inactive (${inactive})`}</Button>}
        </section>
      )}
    </>
  )
}
