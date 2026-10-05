import { useEffect, useMemo, useRef, useState } from 'react'
import type { PortfolioResponse } from 'api-contracts/read-v6/types'
import { Button } from '../../components/ui'
import { useAutomation } from '../../lib/automationState'
import type { WalletPosition } from '../../lib/walletPositions'
import type { VaultSnapshot } from '../../finance/v2/vault'
import { useWalletIdentity } from '../../lib/walletIdentity'
import { v2Chain } from '../../v2/chains'
import type { V2Gate } from '../../v2/gate'
import { ZERO_ADDRESS, type Address, type Dex, type V2ChainId } from '../../v2/types'
import { exitOrderKey, offerExitOrder, onExitOrderAsked } from '../autoexit/entry'
import { MandateDialog, type ExitTarget } from '../autoexit/MandateDialog'
import { defaultOrientation } from '../autoexit/orientation'
import { exitTokenMeta, positionExitPrice, type ExitPriceSnapshot } from '../autoexit/priceContext'
import { ExitOrders, useUnclaimed } from '../autoexit/Orders'
import { gateOpen, useGate } from './gate'
import { onVaultOffered, takeVault } from './handoff'
import { IndexStatus } from './IndexStatus'
import { chainView, creditsOn, mandatesOf, mergeCredits, tokenMetaOf, vaultsOfPosition } from './portfolio'
import { routeQuiet, usePortfolio } from './read6'
import { poolTokens, walletTokenMeta } from './tokens'
import { VaultCard } from './VaultCard'
import { VaultDialog, type VaultDialogKind, type VaultDialogSubject } from './VaultDialog'
import { reservesOffer, shownVaultView, type VaultView } from './vaultView'

/**
 * A position's automation on its own page (Domino V2 integration; spec F7 rev3/rev4 §2.13, §4, §5): mounted once from
 * screens/PositionDetail.tsx, under the page's own cards, in every phase of the page (a burned root's page included,
 * whose vault still holds its fees).
 *
 *   - The wallet's vaults this position belongs to, from read-v6's `portfolio.vaults` (rev3: never from the NFT): the
 *     vault whose root it is, in any state of that root, or the one that holds it as an active successor. Each as a card
 *     with its state, why it waits, what it holds and the owner's actions (./VaultCard.tsx, ./VaultDialog.tsx).
 *   - "Stop-loss / take-profit": the position's exit orders (../autoexit/Orders.tsx) and a new one
 *     (../autoexit/MandateDialog.tsx): for a member of the wallet's vault (its armed root or an active successor), or, for
 *     a plain position the connected wallet holds, through a protection-only vault first (decisions #18, #25).
 *   - The hand-over of §2.13 (./handoff.ts): after a manual action on this position (decision #5's rearm, rev3's reserves
 *     after an S1 exit, "Leave automation"), the matching dialog opens by itself, for the person to confirm.
 *
 * Data: read-v6 over the site's route, about the connected wallet, under `preview` and `live` alike (Changed on purpose
 * (data) 2026-10-02, the owner: real data only); a vault appears here only from such an answer (the route, or a browser
 * suite's stand-in for it).
 */

export interface PositionAutomationProps {
  /** The page's NFT id, in decimal. */
  tokenId: string
  /** The page's own chain read of the NFT, while it has one. */
  position: WalletPosition | null
  /** The NFT's owner at that read (lowercase), when known. */
  holder: string | null
  priceContext?: Pick<ExitPriceSnapshot, 'block' | 'saved'> | null
  /** The chain and DEX of the page: V1's position page is Robinhood Chain's Uniswap v4. */
  chainId?: V2ChainId
  dex?: Dex
  /** The V2 page already read this portfolio and custody; never re-read V1's subscriber on another chain. */
  indexed?: { portfolio: PortfolioResponse; subscriber: string | null }
  onChanged?: () => void
}

type Open = { kind: VaultDialogKind; vault: VaultView; subject: VaultDialogSubject | null } | { kind: 'mandate'; target: ExitTarget } | null

/** The pool of a page's position, in pool order (by address, whichever way V1's read lists the pair); null when the read is not one. */
function poolOfPosition(position: WalletPosition): ExitTarget['pool'] | null {
  const [a, b] = position.currencies.map((c) => c.address.toLowerCase() as Address).sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : BigInt(x) > BigInt(y) ? 1 : 0))
  if (!/^0x[0-9a-f]{40}$/.test(a) || !/^0x[0-9a-f]{40}$/.test(b) || BigInt(a) >= BigInt(b)) return null
  return Object.freeze({ currency0: a, currency1: b, fee: position.fee, tickSpacing: position.tickSpacing, hooks: position.hooks.toLowerCase() as Address })
}

/** A decimal id as a bigint (a module-level helper: the React compiler reads a capitalized call in render as a component). */
const idOf = (text: string): bigint => BigInt(text)

/** The gate an action spanning two services runs under: live only when both are live; else the preview's words. */
function joined(a: V2Gate | null, b: V2Gate | null): Exclude<V2Gate, { mode: 'off' }> | null {
  if (!gateOpen(a) || !gateOpen(b)) return null
  if (a.mode === 'live' && b.mode === 'live') return a
  return a.mode === 'preview' ? a : b
}

export default function PositionAutomation({ tokenId, position, holder, priceContext, chainId = 4663, dex = 4, indexed, onChanged }: PositionAutomationProps) {
  const vaultGate = useGate('vault', chainId)
  const exitGate = useGate('autoExit', chainId)
  const identity = useWalletIdentity()
  const connected = identity.kind === 'connected' ? (identity.address.toLowerCase() as Address) : null
  const [version, setVersion] = useState(0)
  const readGate = gateOpen(vaultGate) ? vaultGate : gateOpen(exitGate) ? exitGate : null
  const mode = readGate ? readGate.mode : null
  const answer = usePortfolio(indexed ? null : connected, readGate, version)
  const [now] = useState(() => Math.floor(Date.now() / 1000))
  const [open, setOpen] = useState<Open>(null)
  // The vaults this page acted on, as read on chain right after (./vaultView.ts shownVaultView), by address.
  const [fresh, setFresh] = useState<ReadonlyMap<string, VaultSnapshot>>(() => new Map())
  // V1's own reading of the NFT's subscriber: a plain position is offered the protection-only path; one in V1's
  // automation, or tied to another app, is not (the vault would refuse it: ForeignSubscriber).
  const v1 = useAutomation(!indexed && position ? tokenId : null)
  const chain = v2Chain(chainId)

  const body = indexed?.portfolio ?? (answer && answer.reply.kind === 'ok' ? answer.reply.body : null)
  const views = useMemo(
    () => (body && connected ? vaultsOfPosition(body, chainId, tokenId, dex).map((entry) => ({ role: entry.role, view: shownVaultView(entry.vault, body, connected, now, fresh.get(entry.vault.address.toLowerCase()) ?? null) })) : []),
    [body, connected, chainId, tokenId, dex, now, fresh],
  )
  const pagePool = useMemo(() => (position ? poolOfPosition(position) : null), [position])
  const pageTokens = useMemo(() => {
    if (!pagePool || !position) return null
    const fromIndex = body ? tokenMetaOf(body.tokens, chainId) : null
    const fromPage = walletTokenMeta(position.currencies)
    return poolTokens(chain, pagePool, (address) => exitTokenMeta(fromPage(address), fromIndex?.(address) ?? null))
  }, [pagePool, position, body, chainId, chain])
  const indexTokens = useMemo(() => (body ? tokenMetaOf(body.tokens, chainId) : null), [body, chainId])
  const tokensOfView = (view: VaultView) => (view.pool ? poolTokens(chain, view.pool, indexTokens ?? undefined) : pageTokens)

  // §2.13: a manual action on this position handed one of its vaults over; its dialog opens by itself.
  useEffect(() => {
    const show = (vault: Address, focus: 'rearm' | 'reserves' | 'leave') => {
      const found = views.find((entry) => entry.view.vault === vault)
      if (!found) return
      const kind: VaultDialogKind = focus === 'rearm' ? 'rearm' : focus === 'leave' ? 'leave' : reservesOffer(found.view).returnable ? 'return' : 'withdraw'
      setOpen({ kind, vault: found.view, subject: null })
    }
    for (const entry of views) {
      const taken = takeVault(chainId, entry.view.vault)
      if (taken) {
        show(taken.vault, taken.focus)
        break
      }
    }
    return onVaultOffered((handoff) => {
      if (handoff.chainId !== chainId || !views.some((entry) => entry.view.vault === handoff.vault)) return
      const taken = takeVault(chainId, handoff.vault)
      if (taken) show(taken.vault, taken.focus)
    })
  }, [views, chainId])
  // §4.8: `unclaimed(owner, token)` for the pool's two tokens, read on chain while the auto-exit gate is live and the wallet
  // is on this chain (../autoexit/Orders.tsx useUnclaimed); null otherwise, and read again after anything this page did.
  const liveCredits = useUnclaimed(exitGate, pagePool, connected, version)

  const rootView = views.find((entry) => entry.role === 'root')?.view ?? null
  const memberView = views.find((entry) => entry.role === 'successor')?.view ?? null
  // §4.4: a new order only for a member of the wallet's vault: its armed root, or an active successor.
  const member = rootView && rootView.armed === true && rootView.ownedByWallet ? { view: rootView, role: 'root' as const } : memberView && memberView.ownedByWallet ? { view: memberView, role: 'successor' as const } : null
  const liquid = position !== null && position.liquidity !== '0'
  const holds = connected !== null && holder !== null && holder.toLowerCase() === connected
  const plainCustody = indexed ? indexed.subscriber === null || indexed.subscriber === ZERO_ADDRESS : v1.phase === 'ready' && v1.state.automation === 'plain'
  const plain = !rootView && !memberView && holds && liquid && pagePool !== null && pagePool.hooks === ZERO_ADDRESS && plainCustody
  // Under V1's own automation (its vault holds the NFT's one individual approval, §1.5): the option is said, not offered;
  // Domino's new vault takes a position over once the person leaves V1's automation (spec §1.1: no migration flow).
  const v1Automated = !indexed && !rootView && !memberView && holds && liquid && pagePool !== null && v1.phase === 'ready' && v1.state.automation !== 'plain'
  const orderGate = member ? (gateOpen(exitGate) ? exitGate : null) : joined(vaultGate, exitGate)
  const pagePrice = positionExitPrice(position, priceContext)
  const target: ExitTarget | null = orderGate && pagePool && pageTokens && (member || plain)
    ? { chainId, dex, tokenId: idOf(tokenId), pool: pagePool, tokens: pageTokens, price: pagePrice, vault: member ? { address: member.view.vault, role: member.role, autoExitEnabled: member.view.autoExitEnabled } : null }
    : null
  // The orders already on this position, in whichever of its vaults holds them.
  const ordersVault = member?.view ?? rootView ?? memberView
  const orders = body && ordersVault ? mandatesOf(body, chainId, ordersVault.vault).filter((order) => order.tokenId === tokenId) : []
  // §4.8: what exits could not deliver, from the index, joined with the chain's own figures for the pool's two tokens (the
  // index off or behind lists none): the chain's figure wins for a token it was read for.
  const indexCredits = body && gateOpen(exitGate) ? creditsOn(body, chainId, exitGate.contracts.addresses.autoExit) : []
  const credits = mergeCredits(indexCredits, liveCredits)
  const ordersTarget: ExitTarget | null = target?.vault
    ? target
    : ordersVault && pagePool && pageTokens
      ? { chainId, dex, tokenId: idOf(tokenId), pool: pagePool, tokens: pageTokens, vault: { address: ordersVault.vault, role: rootView ? 'root' : 'successor', autoExitEnabled: ordersVault.autoExitEnabled } }
      // A credit with no vault of this position known (the index off): the claim alone, on this position's pool.
      : credits.length > 0 && pagePool && pageTokens
        ? { chainId, dex, tokenId: idOf(tokenId), pool: pagePool, tokens: pageTokens, vault: null }
        : null
  const chainState = body ? chainView(body.chains, chainId) : null
  const showExit = gateOpen(exitGate) && (target !== null || orders.length > 0 || credits.length > 0 || v1Automated)
  const changed = (snapshot?: VaultSnapshot) => {
    if (snapshot) setFresh((old) => new Map(old).set(snapshot.vault, snapshot))
    setVersion((n) => n + 1)
    onChanged?.()
  }
  // The read about the connected wallet failed (not answering, or an answer the validator refused): said, never "no
  // automation". A route simply not on yet (before the deploy) is nothing to say: the page is V1's.
  const unread = connected !== null && answer !== null && answer.reply.kind !== 'ok' && !routeQuiet(answer)

  // The page's actions row offers "Stop-loss / take-profit" while an order can be set here, and a pick there opens this
  // panel's own order dialog (../autoexit/entry.ts; the owner, 2026-10-04: inside the position, as a button there).
  const offered = gateOpen(exitGate) && target !== null
  const entryKey = exitOrderKey(tokenId, chainId, dex)
  // The latest target, for an ask that comes between renders (the target is drawn anew on every render).
  const latestTarget = useRef<ExitTarget | null>(null)
  useEffect(() => {
    latestTarget.current = target
  })
  useEffect(() => {
    offerExitOrder(entryKey, offered)
    return () => offerExitOrder(entryKey, false)
  }, [entryKey, offered])
  useEffect(
    () =>
      onExitOrderAsked((asked) => {
        const at = latestTarget.current
        if (asked === entryKey && at) setOpen({ kind: 'mandate', target: at })
      }),
    [entryKey],
  )

  if (!gateOpen(vaultGate) && !gateOpen(exitGate)) return null

  return (
    <div className="grid gap-4" data-v2in-position={tokenId} data-v2in-mode={mode ?? 'off'}>
      {/* The chain's status before any figure of it: behind or unavailable, and §5.3's halt banner (the owner's actions stay). */}
      {body && views.length > 0 && chainState && (chainState.state !== 'current' || chainState.halted === true) && <IndexStatus chains={body.chains} chainId={chainId} what="Your automation" />}
      {unread && answer && answer.reply.kind !== 'ok' && <IndexStatus failed={answer.reply} chainId={chainId} what="Your automation" />}
      {views.map(({ view }) => (
        <VaultCard key={view.vault} view={view} tokens={tokensOfView(view)} variant="page" nowSeconds={now} onAction={(kind, subject) => setOpen({ kind, vault: view, subject: subject ?? null })} />
      ))}
      {showExit && gateOpen(exitGate) && (
        // One title, one line, one button (the owner, 2026-10-03: few words, the detail inside the dialog, which says what
        // an order can and cannot do and the eight warnings before anything is signed).
        <section hidden={orders.length === 0 && credits.length === 0 && !v1Automated} className="dm-card dm-pos-card" aria-labelledby={`v2in-exit-${tokenId}`} data-v2in-exit={target ? (target.vault ? 'member' : 'plain') : 'orders'}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id={`v2in-exit-${tokenId}`} className="dm-title">
              Stop-loss / take-profit
            </h2>
            {target && (
              <Button type="button" variant={target.vault || orders.length > 0 ? 'outline' : 'primary'} size="sm" onClick={() => setOpen({ kind: 'mandate', target })} data-v2in-open="mandate">
                {target.vault || orders.length > 0 ? 'New order' : 'Set up'}
              </Button>
            )}
          </div>
          <p className="text-body text-fg-muted" data-v2in-exit-line={target ? 'open' : v1Automated ? 'v1' : 'orders'}>
            {target
              ? 'Withdraw this position by itself when the price falls or rises to a level you set. Cancel at any time.'
              : v1Automated
                ? 'Available once this position leaves its current automation.'
                : 'Your orders on this position.'}
          </p>
          {ordersTarget && (orders.length > 0 || credits.length > 0 || target?.vault) && (
            <ExitOrders target={ordersTarget} orders={orders} credits={credits} gate={exitGate} owner={connected} orientation={defaultOrientation(chainId, ordersTarget.pool)} nowSeconds={now} onChanged={changed} />
          )}
        </section>
      )}
      {open?.kind === 'mandate' && orderGate && <MandateDialog target={{ ...open.target, tokens: pageTokens ?? open.target.tokens, price: pagePrice }} gate={orderGate} onClose={() => setOpen(null)} onChanged={changed} />}
      {open && open.kind !== 'mandate' && gateOpen(vaultGate) && (
        <VaultDialog kind={open.kind} view={open.vault} tokens={tokensOfView(open.vault)} gate={vaultGate} subject={open.subject} onClose={() => setOpen(null)} onChanged={changed} />
      )}
    </div>
  )
}
