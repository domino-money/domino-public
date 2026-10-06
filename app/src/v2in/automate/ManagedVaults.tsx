import { useEffect, useMemo, useState } from 'react'
import { positionHref } from '../../components/explore/routes'
import type { VaultSnapshot } from '../../finance/v2/vault'
import { MANAGED_APPEAR, MANAGED_LINE, NOTHING_YET_BOTH, type CardShows } from '../../lib/automationCards'
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
 * Managed positions with Domino's vaults (Domino V2 integration; spec F7 rev3/rev4 §2.13, §5.6): Positions' Managed
 * positions card in a build that carries V2, one row per vault read-v6 lists (`portfolio.vaults`, by owner, never from a
 * root NFT: a vault whose root was closed, burned or transferred stays listed with its reserves). Each row: the root
 * position, its chain, the vault's state, the fees waiting in it and the one primary way out ("Return my reserves", "Turn
 * back on" or "Withdraw to wallet"), which opens its dialog; the position's own page has the rest (./VaultCard.tsx).
 *
 * Data: the connected wallet's own vaults, from the site's route, under `preview` and `live` alike (Changed on purpose
 * (data) 2026-10-02, the owner: real data only, no example rows); under `preview` the dialogs stop at their review. A
 * route simply not on yet says nothing (./read6.tsx routeQuiet). When it has rows, the card tells Positions it has
 * something to show.
 *
 * Changed on purpose 2026-10-06 (rugged's answer of 6 Oct, §3: performance-v2 is off on purpose, it is V1's "Start
 * tracking", and V1 is off since 2026-10-05; "in V2, state and receipts come from read-v6's portfolio and activity"): V1's
 * Performance is no longer drawn here, so nothing in this build asks performance-v2. With no row the card has nothing of
 * its own to say, so it says what the Receipts card says (`quietWord`), and Positions' one line for both cards stands as
 * before (V1's Performance said the same, from the same session); when shown, its plate says the vaults appear here.
 */

const CHAINS: readonly V2ChainId[] = [4663, 8453, 42161]

type Shows = (shows: CardShows | null) => void

const CONTENT: CardShows = Object.freeze({ kind: 'content' })
const NOTHING_YET: CardShows = Object.freeze({ kind: 'none', reason: 'empty', text: NOTHING_YET_BOTH, action: null })

/**
 * What the card tells Positions while it lists no vault (lib/automationCards.ts), from `receipts`, what the Receipts card
 * told it: the same "nothing", so the one line for both cards is Receipts' own (no session, or nothing yet once signed in);
 * not known while Receipts has not said; plainly nothing yet beside a Receipts card that has something (both are drawn).
 */
function quietWord(receipts: CardShows | null): CardShows | null {
  if (receipts === null) return null
  return receipts.kind === 'none' ? receipts : NOTHING_YET
}

export default function ManagedVaults({ onShows, receipts = null }: { onShows?: Shows; receipts?: CardShows | null }) {
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

  // The person's own vaults always give this card something to show; without one, Receipts' word (`quietWord`).
  const hasRows = rows.length > 0
  const word = useMemo(() => (hasRows ? CONTENT : quietWord(receipts)), [hasRows, receipts])
  useEffect(() => {
    onShows?.(word)
  }, [onShows, word])

  const tokensOf = (view: VaultView) => {
    if (!view.pool || !body) return null
    return poolTokens(v2Chain(view.chainId), view.pool, tokenMetaOf(body.tokens, view.chainId))
  }
  const hrefOf = (view: VaultView): string => (view.chainId === 4663 && view.dex === 4 ? positionHref(view.rootTokenId.toString()) : v2PositionHref({ chainId: view.chainId, dex: view.dex, tokenId: view.rootTokenId }))
  const dialogGate = dialog ? gates[dialog.view.chainId] : null

  return (
    <>
      {/* No vault listed (none yet, or not read yet): the card's line and its plate, in V1's Performance's own words. */}
      {!hasRows && (
        <>
          <p className="dm-acct-desc">{MANAGED_LINE}</p>
          <div className="dm-acct-plot" data-v2in-vaults-empty="">
            <span>{MANAGED_APPEAR}</span>
          </div>
        </>
      )}
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
