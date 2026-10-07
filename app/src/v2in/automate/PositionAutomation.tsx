import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { PortfolioResponse } from 'api-contracts/read-v6/types'
import { Button } from '../../components/ui'
import { AutomateEntry } from '../../components/positions/AutomateEntry'
import { SequenceSwitch } from '../../components/positions/SequenceSwitch'
import { askAutoExitOnArrival, takeAutoExitAsk } from '../../lib/automate/autoExitAsk'
import { useAutomation } from '../../lib/automationState'
import type { WalletPosition } from '../../lib/walletPositions'
import type { VaultSnapshot } from '../../finance/v2/vault'
import { useWalletIdentity } from '../../lib/walletIdentity'
import { v2Chain } from '../../v2/chains'
import type { V2Gate } from '../../v2/gate'
import { ZERO_ADDRESS, type Address, type Dex, type V2ChainId } from '../../v2/types'
import { exitCardState, withApprovals, withExitModules, withRevoked } from '../autoexit/card'
import { exitOrderKey, offerExitOrder, onExitOrderAsked } from '../autoexit/entry'
import { fullRange } from '../autoexit/form'
import { MandateDialog, type ExitTarget } from '../autoexit/MandateDialog'
import { defaultOrientation } from '../autoexit/orientation'
import { exitTokenMeta, positionExitPrice, type ExitPriceSnapshot } from '../autoexit/priceContext'
import { AutoExitCard, sessionExits, useUnclaimed } from '../autoexit/Orders'
import { gateOpen, useGate } from './gate'
import { onVaultOffered, takeVault } from './handoff'
import { IndexStatus } from './IndexStatus'
import { chainView, creditsOn, mandatesOf, mergeCredits, tokenMetaOf, vaultsOfPosition } from './portfolio'
import { routeQuiet, usePortfolio } from './read6'
import { approvedAt, automationState, exitModuleSet, sessionMandates, sessionRevoked, subscribeAutomation } from './store'
import { poolTokens, shortAddress, walletTokenMeta } from './tokens'
import { ReservesWords, VAULT_ACTION_LABEL, VaultCard } from './VaultCard'
import { VaultDialog, type VaultDialogKind, type VaultDialogSubject } from './VaultDialog'
import { automationMode, automationStanding, currentVaultFirst, protectionVault, reservesOffer, shownVaultView, vaultActions, type VaultView } from './vaultView'
import { Details } from './ui'

/**
 * A position's automation on its own page (Domino V2 integration; spec F7 rev3/rev4 §2.13, §4, §5): mounted once from
 * screens/PositionDetail.tsx, at the top of the page, in every phase (a burned root's page included,
 * whose vault still holds its fees).
 *
 *   - The wallet's vaults this position belongs to, from read-v6's `portfolio.vaults` (rev3: never from the NFT): the
 *     vault whose root it is, in any state of that root, or the one that holds it as an active successor. Each as a card
 *     with its state, why it waits, what it holds and the owner's actions (./VaultCard.tsx, ./VaultDialog.tsx).
 *   - Auto-exit (Changed on purpose 2026-10-06, the owner's point 5; rugged97: "it is AUTO-EXIT, separate from the rest.
 *     Auto-exit has no fee compounding"): ONE card (../autoexit/Orders.tsx) with where it stands and its one control, and
 *     its dialog (../autoexit/MandateDialog.tsx), offered only on a plain position the connected wallet holds (its
 *     protection-only vault made in the same batch, decisions #18, #25) or in the position's own protection-only vault, and
 *     only while none is on: never on a running Auto-compound or Domino-compound automation, never on a successor, never a
 *     second one. That card takes the protection-only vault's own place (one card, not two); orders on other vaults
 *     still show in it, and can be turned off.
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
  const [expanded, setExpanded] = useState(false)
  // Added 2026-10-06 (the integration review, money #4): "Turn off instead" in the automation's own dialog opens the
  // Auto-exit card's Turn off.
  const [turnOff, setTurnOff] = useState(0)
  // The vaults this page acted on, as read on chain right after (./vaultView.ts shownVaultView), by address.
  const [fresh, setFresh] = useState<ReadonlyMap<string, VaultSnapshot>>(() => new Map())
  // V1's own reading of the NFT's subscriber: a plain position is offered the protection-only path; one in V1's
  // automation, or tied to another app, is not (the vault would refuse it: ForeignSubscriber).
  const v1 = useAutomation(!indexed && position ? tokenId : null)
  const chain = v2Chain(chainId)

  const store = useSyncExternalStore(subscribeAutomation, automationState, automationState)
  // Changed on purpose 2026-10-06 (the final check, F2): with the auto-exit module this page itself set (Leave automation
  // turns it off, "Turn back on" on), from that step's receipt, while the index has not reached it: the card and the
  // automation's actions say the new standing at once (../autoexit/card.ts withExitModules). Changed on purpose 2026-10-06
  // (the final check F2's review): and with the Auto-exits this page turned off (withRevoked), so its automation's word
  // agrees with the card's: after "Turn back on" then "Turn off", "Turn on" (its rearm first) is offered again at once.
  const listed = indexed?.portfolio ?? (answer && answer.reply.kind === 'ok' ? answer.reply.body : null)
  // Changed on purpose 2026-10-06 (rugged's answer of 6 Oct, §4 item 6): and with the approvals this page gave back,
  // while the index's read of the position is older (../autoexit/card.ts withApprovals): "Approve again" done, the card
  // says "On".
  const body = useMemo(
    () => (listed
      ? withApprovals(withExitModules(withRevoked(listed, chainId, sessionRevoked(store, chainId)), (id, vault, nonce) => exitModuleSet(store, id, vault, nonce)), (id, vault, tokenId) => approvedAt(store, id, vault, tokenId))
      : null),
    [listed, store, chainId],
  )
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

  const current = body ? currentVaultFirst(views.map((entry) => entry.view), body)[0] ?? null : null
  const currentRole = views.find((entry) => entry.view.vault === current?.vault)?.role ?? null
  const rootView = currentRole === 'root' ? current : null
  const memberView = currentRole === 'successor' ? current : null
  // The orders already on this position, in whichever of its vaults holds them, and the ones this page registered that
  // the index does not list yet.
  const ordersVault = rootView ?? memberView
  const orders = body && ordersVault ? mandatesOf(body, chainId, ordersVault.vault).filter((order) => order.tokenId === tokenId) : []
  const mine = connected ? sessionExits(sessionMandates(store, chainId, connected), orders, idOf(tokenId)) : []
  const exitState = exitCardState(orders, mine, sessionRevoked(store, chainId))
  // Changed on purpose 2026-10-06 (the owner's point 5; rugged97: "auto-exit has no fee compounding"; one Auto-exit per
  // position): offered only while none is on, and only on the position's own protection-only vault (paused, auto-exit on),
  // never on a running Auto-compound or Domino-compound automation and never on a successor.
  const exitOn = exitState.kind === 'on' || exitState.kind === 'paused'
  // Added 2026-10-06 (the integration review): the Auto-exit on or paused, for its own automation's dialogs (an approval
  // put back puts it in force again: VaultDialog reads the price first); null while none is on.
  const activeExit = exitState.kind === 'on' || exitState.kind === 'paused' ? { id: exitState.id, triggers: exitState.triggers } : null
  const protection = rootView && protectionVault(rootView) ? rootView : null
  const member = protection && protection.armed === true && protection.ownedByWallet ? protection : null
  const liquid = position !== null && position.liquidity !== '0'
  const holds = connected !== null && holder !== null && holder.toLowerCase() === connected
  const plainCustody = indexed ? indexed.subscriber === null || indexed.subscriber === ZERO_ADDRESS : v1.phase === 'ready' && v1.state.automation === 'plain'
  // A vault made from this page that the index does not list yet is no plain position any more.
  const madeHere = mine.length > 0
  const plain = !rootView && !memberView && !madeHere && holds && liquid && pagePool !== null && pagePool.hooks === ZERO_ADDRESS && plainCustody
  // Under V1's own automation (its vault holds the NFT's one individual approval, §1.5): the option is said, not offered;
  // Domino's new vault takes a position over once the person leaves V1's automation (spec §1.1: no migration flow).
  const v1Automated = !indexed && !rootView && !memberView && holds && liquid && pagePool !== null && v1.phase === 'ready' && v1.state.automation !== 'plain'
  const orderGate = member ? (gateOpen(exitGate) ? exitGate : null) : joined(vaultGate, exitGate)
  const pagePrice = positionExitPrice(position, priceContext)
  // Added 2026-10-06 (the owner's point 5): the range is Auto-exit's edges.
  const range = position ? { tickLower: position.tickLower, tickUpper: position.tickUpper } : null
  // Changed on purpose 2026-10-06 (the review of point 5): a range that covers every price the pool allows never reaches
  // an end, so Auto-exit is not offered on it.
  const closable = pagePool !== null && !fullRange(range, pagePool.tickSpacing)
  // Changed on purpose 2026-10-06 (rugged's answer of 6 Oct, §4 item 7: "never offer to resume"): a position Auto-exit
  // closed is never offered it again, whatever a later read of the page says of its liquidity.
  const target: ExitTarget | null = !exitOn && exitState.kind !== 'closed' && orderGate && pagePool && pageTokens && liquid && closable && (member || plain)
    ? { chainId, dex, tokenId: idOf(tokenId), pool: pagePool, tokens: pageTokens, range, price: pagePrice, vault: member ? { address: member.vault, role: 'root', autoExitEnabled: member.autoExitEnabled } : null }
    : null
  // §4.8: what exits could not deliver, from the index, joined with the chain's own figures for the pool's two tokens (the
  // index off or behind lists none): the chain's figure wins for a token it was read for.
  const indexCredits = body && gateOpen(exitGate) ? creditsOn(body, chainId, exitGate.contracts.addresses.autoExit) : []
  const credits = mergeCredits(indexCredits, liveCredits)
  // The card names the position with the page's own read; the vault its orders are in (or the one made here).
  const cardVault: ExitTarget['vault'] = ordersVault
    ? { address: ordersVault.vault, role: rootView ? 'root' : 'successor', autoExitEnabled: ordersVault.autoExitEnabled }
    : mine[0] ? { address: mine[0].vault, role: 'root', autoExitEnabled: true } : null
  const cardTarget: ExitTarget | null = pagePool && pageTokens ? { chainId, dex, tokenId: idOf(tokenId), pool: pagePool, tokens: pageTokens, range, price: pagePrice, vault: cardVault } : null
  const chainState = body ? chainView(body.chains, chainId) : null
  const showExit = gateOpen(exitGate) && cardTarget !== null && (protection !== null || current === null)
  const changed = (snapshot?: VaultSnapshot) => {
    if (snapshot) setFresh((old) => new Map(old).set(snapshot.vault, snapshot))
    setVersion((n) => n + 1)
    onChanged?.()
  }
  // The read about the connected wallet failed (not answering, or an answer the validator refused): said, never "no
  // automation". A route simply not on yet (before the deploy) is nothing to say: the page is V1's.
  const unread = connected !== null && answer !== null && answer.reply.kind !== 'ok' && !routeQuiet(answer)

  // The page's actions row offers "Auto-exit" while it can be turned on here, and a press there opens this panel's own
  // dialog (../autoexit/entry.ts; the owner, 2026-10-04: inside the position, as a button there).
  const offered = gateOpen(exitGate) && target !== null
  const entryKey = exitOrderKey(tokenId, chainId, dex)
  // The latest target, for an ask that comes between renders (the target is drawn anew on every render).
  const latestTarget = useRef<ExitTarget | null>(null)
  useEffect(() => {
    latestTarget.current = target
  })
  useEffect(() => {
    offerExitOrder(entryKey, offered)
    // Added 2026-10-06 (the review of point 5): New position's success asked for Auto-exit on its way here
    // (lib/automate/autoExitAsk.ts): its dialog opens by itself once it is offered.
    const at = latestTarget.current
    if (offered && at && takeAutoExitAsk(entryKey)) setOpen({ kind: 'mandate', target: at })
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

  const reading = connected !== null && body === null
  const legacy = !current && v1.phase === 'ready' && 'paused' in v1.state ? v1.state : null
  const label = current ? automationMode(current) : legacy ? legacy.automation === 'domino' ? 'Domino-compound' : 'Auto-compound' : mine.length > 0 ? 'Auto-exit' : 'Automation'
  const standing = unread ? 'State unavailable' : legacy ? legacy.paused ? 'Paused' : legacy.active ? 'On' : 'Off' : current ? automationStanding(current) : mine.length > 0 ? 'On' : reading ? answer === null ? 'Loading' : 'State unavailable' : liquid ? 'Off' : position ? 'Closed' : 'State unavailable'
  const recovery = views.filter(({ view }) => view.vault !== current?.vault)
  const fundsPending = views.some(({ view }) => (view.reserves.known && view.reserves.held) || view.successors.length > 0) || (showExit && credits.length > 0)
  const canShow = connected !== null && (holds || views.length > 0 || mine.length > 0 || reading || unread)
  if (!canShow) return null

  return (
    <div className="dm-position-automation" data-v2in-position={tokenId} data-v2in-mode={mode ?? 'off'}>
      <Button type="button" variant="outline" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-controls={`automation-controls-${chainId}-${dex}-${tokenId}`} data-automation-control="">
        {label} · {standing}{fundsPending ? ' · Funds available' : ''}
      </Button>
      <div id={`automation-controls-${chainId}-${dex}-${tokenId}`} hidden={!expanded} className="dm-automation-panel" data-automation-panel="">
      {/* The chain's status before any figure of it: behind or unavailable, and §5.3's halt banner (the owner's actions stay). */}
      {body && views.length > 0 && chainState && (chainState.state !== 'current' || chainState.halted === true) && <IndexStatus chains={body.chains} chainId={chainId} what="Your automation" />}
      {unread && answer && answer.reply.kind !== 'ok' && <IndexStatus failed={answer.reply} chainId={chainId} what="Your automation" />}
      {body && (body.truncated.vaults || body.truncated.mandates) && <p role="status" className="dm-acct-note">Some automation records are not included in this read. Available balances and recovery remain below.</p>}
      {current && (!protection || !showExit) && <VaultCard view={current} tokens={tokensOfView(current)} variant="page" nowSeconds={now} onAction={(kind, subject) => setOpen({ kind, vault: current, subject: subject ?? null })} />}
      {plain && <div className="dm-automation-choices">
        <p className="dm-acct-note">Choose one service for this position: compounding or Auto-exit.</p>
        {chainId === 4663 && dex === 4 && <AutomateEntry tokenId={tokenId} open variant="action" />}
        {target && <Button type="button" variant="primary" size="sm" onClick={() => setOpen({ kind: 'mandate', target })} data-v2in-open="mandate">Turn on Auto-exit</Button>}
      </div>}
      {legacy && holder && <SequenceSwitch tokenId={tokenId} holder={holder} liquid={liquid} fallback={<p className="dm-acct-note">This position uses an earlier automation. Its controls depend on that service being available.</p>} />}
      {showExit && cardTarget && gateOpen(exitGate) && (
        <AutoExitCard
          target={cardTarget}
          orders={orders}
          mine={mine}
          credits={credits}
          gate={exitGate}
          owner={connected}
          orientation={defaultOrientation(chainId, cardTarget.pool)}
          nowSeconds={now}
          offer={target ? (target.vault ? 'member' : 'plain') : null}
          protection={protection}
          v1Automated={v1Automated}
          turnOff={turnOff}
          onTurnOn={() => {
            if (target) setOpen({ kind: 'mandate', target })
          }}
          onVaultAction={(kind) => {
            if (protection) setOpen({ kind, vault: protection, subject: null })
          }}
          onChanged={changed}
        />
      )}
      {recovery.length > 0 && <Details label="Previous setup balances" data-automation-recovery="">
        <p className="dm-acct-note">Earlier setups of this position may still hold funds. Recover them here.</p>
        {recovery.map(({ view }) => <div key={view.vault} className="dm-automation-recovery" data-recovery-vault={view.vault}>
          <p className="dm-acct-note">{shortAddress(view.vault)} · <ReservesWords view={view} tokens={tokensOfView(view)} /></p>
          <div className="flex flex-wrap gap-2">{vaultActions(view).filter((kind) => ['withdraw', 'return', 'unsubscribe', 'revoke', 'recover-token', 'recover-position'].includes(kind)).map((kind) => <Button key={kind} type="button" size="sm" variant="outline" onClick={() => setOpen({ kind, vault: view, subject: null })}>{VAULT_ACTION_LABEL[kind]}</Button>)}</div>
          {view.successors.map((id) => <Button key={id.toString()} type="button" size="sm" variant="outline" onClick={() => setOpen({ kind: 'withdraw-child', vault: view, subject: { tokenId: id } })}>Withdraw position #{id.toString()}</Button>)}
        </div>)}
      </Details>}
      {current?.rootClosed === true && <p className="dm-acct-note">This position is closed. Any remaining funds can be recovered here. <a href="#/new">Create a new position</a></p>}
      </div>
      {open?.kind === 'mandate' && orderGate && <MandateDialog target={{ ...open.target, tokens: pageTokens ?? open.target.tokens, price: pagePrice }} gate={orderGate} onClose={() => setOpen(null)} onChanged={changed} />}
      {open && open.kind !== 'mandate' && gateOpen(vaultGate) && (
        <VaultDialog
          kind={open.kind}
          view={open.vault}
          tokens={tokensOfView(open.vault)}
          gate={vaultGate}
          subject={open.subject}
          // Auto-exit's own automation (Changed on purpose 2026-10-06, the integration review, rugged-literal #1, money #4):
          // its rearm is said by what it does for the Auto-exit on its root, and "Turn off instead" opens the card's Turn off.
          {...(protectionVault(open.vault) ? { exit: activeExit, onTurnOff: activeExit ? () => { setOpen(null); setTurnOff((n) => n + 1) } : undefined } : {})}
          onClose={() => setOpen(null)}
          onChanged={(snapshot) => {
            // With none on, that rearm was the first part of turning Auto-exit on: its own dialog opens next, by itself, once
            // the page offers it (the automation's root read back armed).
            if (open.kind === 'rearm' && protectionVault(open.vault) && activeExit === null) askAutoExitOnArrival(entryKey)
            changed(snapshot)
          }}
        />
      )}
    </div>
  )
}
