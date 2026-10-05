import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react'
import { positionHref } from '../../components/explore/routes'
import type { VaultSnapshot } from '../../finance/v2/vault'
import type { CardShows } from '../../lib/automationCards'
import { sameShows } from '../../lib/automationCards'
import { useWalletIdentity } from '../../lib/walletIdentity'
import { v2Chain } from '../../v2/chains'
import type { V2Gate } from '../../v2/gate'
import type { Address, V2ChainId } from '../../v2/types'
import { v2PositionHref } from '../route'
import { gateOpen, useGate } from './gate'
import { IndexStatus } from './IndexStatus'
import { tokenMetaOf } from './portfolio'
import { routeQuiet, usePortfolio } from './read6'
import { poolTokens } from './tokens'
import { VaultCard } from './VaultCard'
import { VaultDialog, type VaultDialogKind, type VaultDialogSubject } from './VaultDialog'
import { shownVaultView, type VaultView } from './vaultView'

/**
 * Managed positions with Domino's vaults (Domino V2 integration; spec F7 rev3/rev4 §2.13, §5.6): mounted in Positions'
 * Managed positions card, around V1's own Performance (which it draws unchanged), and adding one row per vault read-v6
 * lists (`portfolio.vaults`, by owner, never from a root NFT: a vault whose root was closed, burned or transferred stays
 * listed with its reserves). Each row: the root position, its chain, the vault's state, the fees waiting in it and the
 * one primary way out ("Return my reserves", "Turn back on" or "Withdraw to wallet"), which opens its dialog; the
 * position's own page has the rest (./VaultCard.tsx).
 *
 * Data: the connected wallet's own vaults, from the site's route, under `preview` and `live` alike (Changed on purpose
 * (data) 2026-10-02, the owner: real data only, no example rows); under `preview` the dialogs stop at their review. A
 * route simply not on yet says nothing (./read6.tsx routeQuiet). When it has rows, the card tells Positions it has
 * something to show, so the card stays in view whatever V1's Performance says.
 */

const CHAINS: readonly V2ChainId[] = [4663, 8453, 42161]

type Shows = (shows: CardShows | null) => void

export default function ManagedVaults({ performance: Performance, onShows }: { performance: ComponentType<{ onShows?: Shows }>; onShows?: Shows }) {
  const robinhood = useGate('vault', 4663)
  const base = useGate('vault', 8453)
  const arbitrum = useGate('vault', 42161)
  const gates: Record<V2ChainId, V2Gate | null> = useMemo(() => ({ 4663: robinhood, 8453: base, 42161: arbitrum }), [robinhood, base, arbitrum])
  // One read for the three chains: the connected wallet's own vaults on every open chain (the route).
  const shownChains = useMemo(() => CHAINS.filter((chainId) => gateOpen(gates[chainId])), [gates])
  const readGate = shownChains.length === 0 ? null : gates[shownChains[0]]
  const mode = readGate && readGate.mode !== 'off' ? readGate.mode : null
  const identity = useWalletIdentity()
  const connected = identity.kind === 'connected' ? (identity.address.toLowerCase() as Address) : null
  const [version, setVersion] = useState(0)
  const answer = usePortfolio(connected, readGate, version)
  const [now] = useState(() => Math.floor(Date.now() / 1000))
  const [dialog, setDialog] = useState<{ kind: VaultDialogKind; view: VaultView; subject: VaultDialogSubject | null } | null>(null)
  // The vaults acted on here, as read on chain right after (./vaultView.ts shownVaultView), by chain and address.
  const [fresh, setFresh] = useState<ReadonlyMap<string, VaultSnapshot>>(() => new Map())
  const body = answer && answer.reply.kind === 'ok' ? answer.reply.body : null
  const rows = useMemo(() => {
    if (!body || !answer) return []
    return body.vaults
      .filter((vault) => shownChains.includes(vault.chainId))
      .map((vault) => shownVaultView(vault, body, answer.wallet, now, fresh.get(`${vault.chainId}|${vault.address.toLowerCase()}`) ?? null))
  }, [body, answer, now, shownChains, fresh])

  // What read-v6 says of a chain, on every open chain (a vault there that cannot be listed is said).
  const statusChains = shownChains

  // V1's Performance tells what it shows; the person's own vaults always give this card something to show.
  const [perf, setPerf] = useState<CardShows | null>(null)
  const tell = useCallback<Shows>((next) => setPerf((old) => (sameShows(old, next) ? old : next)), [])
  const hasRows = rows.length > 0
  useEffect(() => {
    onShows?.(hasRows ? { kind: 'content' } : perf)
  }, [onShows, hasRows, perf])

  const tokensOf = (view: VaultView) => {
    if (!view.pool || !body) return null
    return poolTokens(v2Chain(view.chainId), view.pool, tokenMetaOf(body.tokens, view.chainId))
  }
  const hrefOf = (view: VaultView): string => (view.chainId === 4663 && view.dex === 4 ? positionHref(view.rootTokenId.toString()) : v2PositionHref({ chainId: view.chainId, dex: view.dex, tokenId: view.rootTokenId }))
  const dialogGate = dialog ? gates[dialog.view.chainId] : null

  return (
    <>
      <Performance onShows={tell} />
      {mode && (hasRows || (answer && answer.reply.kind !== 'ok' && !routeQuiet(answer))) && (
        <section aria-label="Your automation" className="dm-v2in-vaults" data-v2in-vaults={rows.length}>
          {hasRows && <p className="dm-acct-note">Fees waiting to be reinvested, and your ways out.</p>}
          {answer && answer.reply.kind !== 'ok' && <IndexStatus failed={answer.reply} chainId={4663} what="Your automation" />}
          {body && statusChains.map((chainId) => <IndexStatus key={chainId} chains={body.chains} chainId={chainId} what="Your automation" />)}
          {hasRows && (
            <ul className="dm-mp-list">
              {rows.map((view) => (
                <VaultCard key={`${view.chainId}|${view.vault}`} view={view} tokens={tokensOf(view)} variant="row" nowSeconds={now} positionHref={hrefOf(view)} onAction={(kind, subject) => setDialog({ kind, view, subject: subject ?? null })} />
              ))}
            </ul>
          )}
        </section>
      )}
      {dialog && gateOpen(dialogGate) && (
        <VaultDialog kind={dialog.kind} view={dialog.view} tokens={tokensOf(dialog.view)} gate={dialogGate} subject={dialog.subject} onClose={() => setDialog(null)} onChanged={(snapshot) => {
            if (snapshot) setFresh((old) => new Map(old).set(`${snapshot.chainId}|${snapshot.vault}`, snapshot))
            setVersion((n) => n + 1)
          }} />
      )}
    </>
  )
}
