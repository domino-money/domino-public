import { Fragment, useEffect, useRef, useState } from 'react'
import { positionHref } from '../../components/explore/routes'
import { SheetCard, SheetFact, SheetFacts, SheetMore, TokenRow, TokenRows } from '../../components/positions/ActionSheet'
import { Button, FigureDash, LinkButton, Skeleton } from '../../components/ui'
import { slippageBpsFrom } from '../../lib/create/slippage'
import { useWalletIdentity } from '../../lib/walletIdentity'
import { v2Chain } from '../../v2/chains'
import { v2TxUrl } from '../../v2/explorers'
import { ethText, keptWhileRequoting, priceText, rangeBothWays } from '../../v2/plan/present'
import type { S1PlanRequest } from '../../v2/plan/types'
import type { ActionName, Address } from '../../v2/types'
import { v2PositionHref } from '../route'
import { CHANGE_RANGE_BURNS_WHEN_ALL, EXIT_BURNS, EXIT_PAUSE_COPY, EXIT_REARM_COPY, POSITION_SLIPPAGE_DEFAULT_BPS, POSITION_SLIPPAGE_MIN_BPS, ROOT_PAUSE_COPY, type Share } from './constants'
import { COPY } from './copy'
import { useDirectExit } from './directRun'
import { AmountsField, RangeField, RangePicture, ReceiveField, ShareField } from './Fields'
import { initialAmounts, initialRange, inputsOf, shareOf, ticksOf, type AmountsValue, type RangeValue } from './forms'
import type { ActionPosition, VaultReserves } from './model'
import { DirectReceiptUnread, DirectReceiptView, ZapReceiptView } from './Receipt'
import { Review } from './Review'
import { useActionRun, type RunView } from './run'
import { Slippage } from './Slippage'
import { StepButton, StepsList, stepsDone } from './Steps'
import { decimalsOf, labelOf, shortAmountText, type TokenBook } from './tokens'
import { ActionDialog, ErrorLine, Locked, Mark, Note, Pair, PairName, Progress, Rows, Tick } from './ui'
import { offerVault, type VaultHandoff } from './vaultHandoff'
import type { OpenGate } from './wallet'

/**
 * Added 2026-10-15 (the owner: "o certo seria sempre ter o botão close position", the same as Robinhood's): `close` is
 * Withdraw of everything in both tokens (the same direct exit at Uniswap: tokens and fees to the wallet, the empty NFT
 * kept), opened straight on its review as V1's Close position is, its slippage under Advanced.
 */
export type PositionMode = 'increase' | 'changeRange' | 'exit' | 'collect' | 'close'
type ExitWay = 'both' | 'convert'

/** What the last review drew, kept for the next quote of the same choices. */
interface KeptReview {
  reviewed: NonNullable<RunView['reviewed']>
  feePerGas: bigint | null
  /**
   * Its steps as they last stood (the run's own list, which a new quote replaces rather than changes): the review's one
   * network fee line reads a batch's own ceiling and the approvals still to send from them (present.ts networkFeeLine).
   */
  steps: RunView['steps']
}

/**
 * Changed on purpose 2026-10-06 (the owner's point 4: a small cue, never a blank): while the same choices are quoted
 * again (the price moved, the quote ran out, or a signature was cancelled; ./run.ts clears its review for it), the dialog
 * keeps drawing the last review, greyed and marked busy, under "Getting a fresh quote…", until the new one replaces it
 * (present.ts keptWhileRequoting). Forgotten when a quote for new choices starts or the run is reset.
 */
function useKeptReview(view: RunView): KeptReview | null {
  const [last, setLast] = useState<KeptReview | null>(null)
  const now: KeptReview | null = view.reviewed ? { reviewed: view.reviewed, feePerGas: view.feePerGas, steps: view.steps } : null
  if (now && (last === null || last.reviewed !== now.reviewed || last.feePerGas !== now.feePerGas || last.steps !== now.steps)) setLast(now)
  else if (!now && last !== null && (view.stage === 'idle' || view.stage === 'preview' || (view.stage === 'quoting' && !view.requoting))) setLast(null)
  return keptWhileRequoting(now, view.stage === 'quoting' && view.requoting, last).stale ? last : null
}

/** "1.5 USDG + 0.001 ETH": a vault's reserves above zero, in their tokens' own units; null when none is. */
export function reservesText(book: TokenBook, reserves: VaultReserves): string | null {
  const above = (reserves.reserves ?? []).filter((reserve) => reserve.amount > 0n)
  return above.length ? above.map((reserve) => shortAmountText(book, reserve.token, reserve.amount)).join(' + ') : null
}

/**
 * A position's own Domino V2 actions (spec F7 rev2 §2.6.2–§2.6.4, §2.13; rev3/rev4 §2.13), each in the page's action
 * dialog (components/positions/ActionSheet.tsx, the family V1's Collect fees and Close position draw too: the title and
 * its plain line, the body, one button at the foot, and on the review a Back chevron left of the title):
 *   - Add liquidity: one of the pool's tokens, both, or another token, through the zap (a swap when needed, its Domino
 *     fee); on v4 "Uncollected fees will also be sent to your wallet.";
 *   - Change range: a new NFT (the old one burned when everything moves), through the zap;
 *   - Withdraw: all or part, in both tokens straight at Uniswap (finance/v2/direct.ts: no zap, no Domino fee), or in one
 *     token through the zap (0.65% of the amount swapped; how much is converted at least and how much may come back as
 *     is, with a lower slippage or both tokens offered when that rest is large);
 *   - Collect fees (a position this page reads from read-v6, where V1's own Collect is not offered): straight at Uniswap.
 * On a vault's armed root every one asks for the pause warning first and offers to turn automation back on at the end;
 * an exit of a vault's root says its waiting fees stay in the vault and, once on chain, goes to them (the automation
 * panel). Under the gate's `preview` (before the deploy) each runs to its review and says the gate's sentence where the
 * wallet's button would be: what the person chose, with no figure invented; a direct action's figures come from the
 * chain, through the wallet, only while the wallet is already on the position's chain (nothing is sent, so no switch is
 * asked for a read). Every money step goes through the closed clients.
 *
 * Changed on purpose 2026-10-03 (the owner, point 9: "literally ugly"): the forms are New position's (./Fields.tsx), the
 * review leads with what moves as token rows, the settings sit under a quiet Advanced at the foot of the form, a waiting
 * Review button says what is missing, and before the deploy the button's place is a locked slot. Same flows and hooks.
 */
export function PositionDialog({ gate, position, mode, book, reserves = null, available = null, onClose, onDone }: {
  gate: OpenGate
  position: ActionPosition
  mode: PositionMode
  book: TokenBook
  /** The vault's reserves as read-v6 read them, when the position is a vault's root (rev3 §2.13). */
  reserves?: VaultReserves | null
  /**
   * (QA round 2, WD-MAX) The tokens in the position now, in the pool's order (currency0, currency1), as the page already
   * read them (its read at the pool's price): shown above Withdraw's How much, rounded down, so the amount All takes out is
   * in view. Null when the page has none: nothing is drawn, and nothing is read for it.
   */
  available?: readonly [bigint, bigint] | null
  onClose: () => void
  /** The action is on chain: the page reads again (with the block it was included in, when known). */
  onDone: (block?: bigint) => void
}) {
  const chainId = gate.chainId
  const pool = position.pool
  const [phase, setPhase] = useState<'form' | 'review'>(mode === 'collect' || mode === 'close' ? 'review' : 'form')
  const [amounts, setAmounts] = useState<AmountsValue>(() => initialAmounts(pool))
  const [range, setRange] = useState<RangeValue>(initialRange)
  const [slippage, setSlippage] = useState(String(POSITION_SLIPPAGE_DEFAULT_BPS))
  const [way, setWay] = useState<ExitWay>('both')
  const [share, setShare] = useState<Share>('100')
  const [convertTo, setConvertTo] = useState<Address>(pool.currency1)
  // The person's tick that this action pauses Auto-exit, where the zap client asks for none (below, `ownTick`).
  const [exitTicked, setExitTicked] = useState(false)
  const bps = slippageBpsFrom(slippage)
  const inputs = mode === 'increase' ? inputsOf(amounts, pool, book) : null
  const ticks = mode === 'changeRange' && position.tick !== null ? ticksOf(range, pool, position.tick, book) : null
  const sameRange = ticks !== null && ticks.tickLower === position.tickLower && ticks.tickUpper === position.tickUpper
  const removing = shareOf(position.liquidity, share)
  // Changed on purpose 2026-10-15 (the review of Close position): a direct exit of everything (Close position, Withdraw
  // of all in both tokens) takes what the chain holds when it is read, as V1's Close position and the zap's 'all' do,
  // never read-v6's figure: an automation that re-added fees since would leave the rest in the NFT, and less on chain
  // than read-v6 says would refuse the exit. Part of it is still read-v6's share.
  const directPart = mode === 'close' || share === '100' ? undefined : removing
  const action: ActionName = mode === 'collect' || mode === 'close' ? 'exit' : mode
  const label = (token: Address) => labelOf(book, token)
  const exitLive = position.vault?.exitLive === true
  const run = useActionRun({
    gate,
    action,
    inputs: inputs ?? [],
    label,
    exitLive,
    book,
    request: (consent): S1PlanRequest => {
      const base = { chainId, consent, position: { dex: position.dex, tokenId: position.tokenId }, slippageBps: bps ?? POSITION_SLIPPAGE_DEFAULT_BPS }
      const liquidityToRemove = share === '100' ? ('all' as const) : removing
      if (mode === 'increase') return { ...base, action: 'increase', inputs: inputs ?? [] }
      if (mode === 'changeRange') return { ...base, action: 'changeRange', tickLower: ticks?.tickLower ?? position.tickLower, tickUpper: ticks?.tickUpper ?? position.tickUpper, liquidityToRemove, burn: share === '100' && CHANGE_RANGE_BURNS_WHEN_ALL }
      return { ...base, action: 'exit', liquidityToRemove, burn: share === '100' && EXIT_BURNS, receive: { convertTo } }
    },
  })
  const direct = useDirectExit(gate, position, label, book)
  const usesDirect = mode === 'collect' || mode === 'close' || (mode === 'exit' && way === 'both')
  // A direct action reads the position through the wallet, on the position's chain (the live path switches it there
  // first, §1.3). Under `preview` nothing is sent, so the wallet is never asked to switch for a read: off the position's
  // chain the review shows what was chosen, as the zap actions' preview does.
  const identity = useWalletIdentity()
  const directReads = gate.mode === 'live' || (identity.kind === 'connected' && identity.chainId === chainId)
  const view = run.view
  const switching = identity.kind === 'connected' && identity.chainId !== chainId && gate.mode === 'live' &&
    (direct.stage === 'reading' || direct.stage === 'wallet' || view.stage === 'quoting' || view.busy)
  const reviewed = view.reviewed
  const kept = useKeptReview(view)
  const ready = bps !== null && (mode === 'increase' ? inputs !== null : mode === 'changeRange' ? ticks !== null && !sameRange && position.liquidity > 0n : position.liquidity > 0n)
  // What a waiting Review button says is missing (Changed on purpose 2026-10-03: never a dead grey bar).
  const missing = bps === null ? COPY.form.checkSlippage : mode === 'increase' && inputs === null ? COPY.form.enterAmount : mode === 'changeRange' && ticks === null ? COPY.form.enterPrices : mode === 'changeRange' && sameRange ? COPY.form.differentRange : COPY.form.review

  // A collect opens straight on its review, as V1's Collect fees does: the position read through the wallet. A close
  // too (V1's Close position), all of it, and again at a new slippage (Advanced, under its review).
  const opened = useRef(false)
  useEffect(() => {
    if (mode !== 'collect' || opened.current) return
    opened.current = true
    if (directReads) void direct.quote('collect', POSITION_SLIPPAGE_DEFAULT_BPS, 0n)
  }, [mode, direct, directReads])
  // Read again at a new slippage once the person stops typing (never while the wallet has it or once it is sent).
  const closeAsked = useRef<number | null>(null)
  const directNow = useRef(direct)
  useEffect(() => {
    directNow.current = direct
  })
  useEffect(() => {
    if (mode !== 'close' || !directReads || bps === null || closeAsked.current === bps) return
    const stage = directNow.current.stage
    if (stage === 'wallet' || stage === 'sent' || stage === 'done' || stage === 'unknown') return
    const timer = setTimeout(() => {
      closeAsked.current = bps
      void directNow.current.quote('close', bps, undefined)
    }, closeAsked.current === null ? 0 : 400)
    return () => clearTimeout(timer)
  }, [mode, directReads, bps])
  /** V1's "Try again": a close whose read failed reads again. */
  const readAgain = () => {
    if (bps === null) return
    closeAsked.current = bps
    void direct.quote('close', bps, undefined)
  }

  const zapDone = view.receipt !== null && (view.receipt.state === 'included' || view.receipt.state === 'finalized')
  const directDone = direct.stage === 'done'
  const done = zapDone || directDone
  // The page reads again once the action is on chain (V1's onChanged), once.
  const told = useRef(false)
  const doneRef = useRef(onDone)
  useEffect(() => {
    doneRef.current = onDone
  })
  useEffect(() => {
    if (!done || told.current) return
    told.current = true
    doneRef.current(usesDirect ? direct.includedBlock : view.receipt?.includedBlock)
  }, [done, usesDirect, direct.includedBlock, view.receipt?.includedBlock])

  // Rev3/rev4 §2.13: an exit of a vault's root (armed or not) leaves the fees waiting to be reinvested in the vault. The
  // review says so with the vault's reserves; once the exit is on chain the automation panel opens at them.
  // The chain's own word once the review or the preparation read it (the zap client's and the direct client's root
  // probes, armed or not); before that, read-v6's.
  const rootVault = reviewed ? reviewed.review.vaultRoot : direct.prepared ? direct.prepared.vaultRoot : position.vault?.role === 'root' ? position.vault.address : null
  const exitVault = mode === 'exit' || mode === 'close' ? rootVault : null
  const leavesReserves = exitVault !== null
  const afterClose = useRef<VaultHandoff | null>(null)
  const closedByUser = useRef(false)
  useEffect(() => {
    if (leavesReserves && done && exitVault) afterClose.current = { chainId, vault: exitVault, focus: 'reserves' }
  }, [leavesReserves, done, exitVault, chainId])
  useEffect(() => () => {
    // Only an explicit close hands over the completed action. Navigation/StrictMode never opens another popup.
    const next = afterClose.current
    if (closedByUser.current && next) { afterClose.current = null; offerVault(next) }
  }, [])
  const closeDialog = () => { closedByUser.current = true; onClose() }
  const reservesWarning = leavesReserves && exitVault
    ? (reserves && reserves.vault === exitVault && reserves.reserves !== null
        ? (reservesText(book, reserves) ? COPY.reserves.exitWarning(reservesText(book, reserves) as string) : null)
        : COPY.reserves.exitWarningUnread)
    : null
  // Changed on purpose 2026-10-06 (the integration review, rugged-literal #1): on the root of Auto-exit's own automation,
  // its Auto-exit on or paused, only the zap's approval step pauses anything (an exit needs the approval alone): an action
  // that keeps the approval (Collect fees, Withdraw to both tokens, Add liquidity on v3) asks for no tick and offers
  // nothing after; one that moves it says so in Auto-exit's words, and offers to approve the position again.
  const quiet = exitLive && (usesDirect || reviewed?.review.replacesApproval === null)
  const pauseCopy = exitLive ? EXIT_PAUSE_COPY : ROOT_PAUSE_COPY
  // The same where the root reads disarmed (an earlier Collect fees on v4 disarms it): the zap client then asks for no
  // pause, yet its approval still replaces the one Auto-exit's exit needs, so this dialog asks for the tick itself.
  const ownTick = exitLive && !usesDirect && reviewed !== null && reviewed.review.replacesApproval !== null && reviewed.review.pausesAutomation === null
  const pauseTick = reviewed !== null && (reviewed.review.pausesAutomation !== null ? !quiet : ownTick)
  const pauseTicked = ownTick ? exitTicked : view.pauseAcknowledged
  // Decision #5: at the end of an armed root's add, withdrawal or collect, the page offers to turn automation back on (the
  // automation panel does it); not after a withdrawal of everything, which leaves the root empty (its reserves go first).
  const pausedVault = zapDone ? view.rearm ?? (ownTick ? position.vault?.address ?? null : null) : directDone ? direct.prepared?.pausesAutomation ?? null : null
  const rearmVault = pausedVault !== null && mode !== 'close' && !(mode === 'exit' && share === '100') && !quiet ? pausedVault : null

  const review = () => {
    setPhase('review')
    if (!usesDirect) run.start()
    else if (directReads) void direct.quote(mode === 'collect' ? 'collect' : 'close', bps ?? POSITION_SLIPPAGE_DEFAULT_BPS, directPart)
  }
  const back = () => {
    run.reset()
    direct.reset()
    setPhase('form')
  }
  /** §2.6.4's offers for a converted exit whose unconverted rest is large: a lower slippage, or both tokens. */
  const lowerSlippage = () => {
    const now = bps ?? POSITION_SLIPPAGE_DEFAULT_BPS
    setSlippage(String(Math.max(POSITION_SLIPPAGE_MIN_BPS, Math.floor(now / 2))))
    back()
  }
  const receiveBoth = () => {
    setWay('both')
    back()
  }
  const newTokenId = view.receipt?.read?.summary.tokenId ?? null
  const newHref = mode === 'changeRange' && newTokenId !== null && newTokenId !== position.tokenId
    ? (chainId === 4663 && position.dex === 4 && position.source === 'chain' ? positionHref(newTokenId.toString()) : v2PositionHref({ chainId, dex: position.dex, tokenId: newTokenId }))
    : null

  let footer
  if (done) {
    footer = (
      <>
        {rearmVault && (
          <Button type="button" variant="primary" size="lg" data-position-rearm={rearmVault} onClick={() => { afterClose.current = { chainId, vault: rearmVault, focus: 'rearm' }; closeDialog() }}>
            {exitLive ? EXIT_REARM_COPY : COPY.wallet.rearm}
          </Button>
        )}
        <Button type="button" variant="secondary" size="lg" onClick={closeDialog} data-position-back="">
          {COPY.wallet.backToPosition}
        </Button>
      </>
    )
  } else if (phase === 'form') {
    // V4's rolling label (.as-cta): the waiting reason leaves upward as "Review" rises in once the form is ready. The
    // button's name stays the label in view; the label out of view is hidden (never read, never in its text).
    const reviewShown = ready || missing === COPY.form.review
    const waiting = missing !== COPY.form.review ? missing : mode === 'increase' ? COPY.form.enterAmount : mode === 'changeRange' ? COPY.form.enterPrices : COPY.form.checkSlippage
    footer = (
      <Button type="button" variant="primary" size="lg" disabled={!ready} onClick={review} data-position-continue={mode} aria-label={ready ? COPY.form.review : missing} className="dm-pa-cta">
        <span className="dm-pa-cta-l" data-on={reviewShown ? undefined : ''} aria-hidden="true">{waiting}</span>
        <span className="dm-pa-cta-l dm-pa-cta-a" data-on={reviewShown ? '' : undefined} aria-hidden="true">{COPY.form.review}</span>
      </Button>
    )
  } else if (gate.mode === 'preview') {
    footer = <Locked copy={gate.lockedCopy} />
  } else if (mode === 'close' && direct.stage === 'failed' && !direct.retry) {
    footer = <Button type="button" variant="primary" size="lg" disabled={bps === null} onClick={readAgain} data-position-retry="">{COPY.wallet.tryAgain}</Button>
  } else if (usesDirect) {
    // V1's Close position: no send at a slippage it does not accept.
    const blocked = (direct.prepared?.pausesAutomation != null && !direct.ticked && !quiet) || (mode === 'close' && bps === null)
    const offer = direct.stage === 'ready' || (direct.stage === 'failed' && direct.retry)
    footer = (
      <Button type="button" variant="primary" size="lg" disabled={!offer || blocked} aria-busy={direct.stage === 'reading' || direct.stage === 'wallet' || direct.stage === 'sent' || undefined} onClick={() => void direct.send()} data-position-send={mode === 'collect' ? 'collect' : 'close'}>
        {mode === 'collect' ? COPY.wallet.collectInWallet : mode === 'close' ? COPY.wallet.closeInWallet : COPY.wallet.withdrawInWallet}
      </Button>
    )
  } else {
    footer = <StepButton view={view} onConfirm={run.confirm} blocked={pauseTick && !pauseTicked} />
  }
  // The review's way back to the form: a chevron left of the title (not on Collect fees or Close position, which have no
  // form, nor once done).
  const backTo = phase === 'review' && !done && mode !== 'collect' && mode !== 'close' ? { onClick: back, disabled: view.busy || direct.stage === 'wallet' || direct.stage === 'sent', 'data-position-review-back': '' } : null

  return (
    <ActionDialog id={mode} title={COPY.title[mode]} lede={COPY.lede[mode]} back={backTo} onClose={closeDialog} footer={<Fragment key={done ? 'done' : phase}>{footer}</Fragment>} data-position-dialog={`v2-${mode}`} data-position-gate={gate.mode}>
      {position.vault?.role === 'root' && position.vault.armed === true && !done && !exitLive && <Note tone="warn" data-position-root-note="">{ROOT_PAUSE_COPY}</Note>}

      {phase === 'form' && mode === 'increase' && <AmountsField chainId={chainId} position={position} book={book} value={amounts} onChange={setAmounts} />}
      {phase === 'form' && mode === 'changeRange' && <RangeField position={position} book={book} value={range} onChange={setRange} ticks={ticks} sameRange={sameRange} />}
      {/* (QA round 2, WD-MAX) What there is to take out, as token rows; Max (the default) takes every bit of it, by the same
          full exit as Close position, so nothing is ever typed. */}
      {phase === 'form' && mode === 'exit' && available && (
        <div className="dm-pa-field" data-position-available="">
          <span className="dm-pa-label">{COPY.form.inPosition}</span>
          <Pair chainId={chainId} book={book} tokens={[pool.currency0, pool.currency1]} amounts={available} />
        </div>
      )}
      {phase === 'form' && (mode === 'changeRange' || mode === 'exit') && <ShareField value={share} onChange={setShare} label={mode === 'changeRange' ? 'Amount to move' : undefined} all={mode === 'exit' ? COPY.form.max : undefined} />}
      {phase === 'form' && mode === 'exit' && (
        <ReceiveField chainId={chainId} book={book} position={position} way={way} convertTo={convertTo} onChange={(nextWay, token) => { setWay(nextWay); setConvertTo(token) }} />
      )}
      {phase === 'form' && mode === 'increase' && pool.dex === 4 && <Note data-position-fees-sent="">{COPY.review.feesSent}</Note>}
      {phase === 'form' && mode !== 'collect' && (
        <SheetMore label={COPY.form.advanced} value={bps === null ? undefined : `${COPY.form.slippage} ${bps / 100}%`} data-position-advanced="">
          <Slippage id={`position-v2-${mode}-slippage`} bps={slippage} onChange={setSlippage} />
        </SheetMore>
      )}

      {phase === 'review' && !usesDirect && (
        <div className="dm-pa-field" data-position-review-stage={view.stage}>
          {switching ? <Progress data-position-progress="switching">Switch to {v2Chain(chainId).name} in your wallet…</Progress> : view.stage === 'quoting' && <Progress key={view.requoting ? 'requoting' : 'quoting'} data-position-quoting="">{view.requoting ? COPY.review.requoting : COPY.review.quoting}</Progress>}
          {view.stage === 'failed' && <ErrorLine error={view.error} onRejected={run.forgetUnsettled} busy={view.busy} />}
          {view.stage === 'failed' && view.error?.recovery === 'offer-both' && (
            <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={receiveBoth} data-position-receive-both="">{COPY.review.receiveBoth}</Button>
          )}
          {view.stage === 'preview' && (
            <RequestSummary chainId={chainId} mode={mode} position={position} book={book} inputs={inputs ?? []} ticks={ticks} share={share} way={way} convertTo={convertTo} bps={bps ?? POSITION_SLIPPAGE_DEFAULT_BPS} />
          )}
          {/* The last review, greyed, while the same choices are quoted again (2026-10-06, the owner's point 4: never a blank). */}
          {!reviewed && kept && !view.receipt && (
            <Review chainId={chainId} book={book} reply={kept.reviewed.reply} request={kept.reviewed.request} review={kept.reviewed.review} steps={kept.steps} feePerGas={kept.feePerGas} at={kept.reviewed.at} stale>
              {reservesWarning && <Note tone="warn" data-position-reserves-stay="">{reservesWarning}</Note>}
            </Review>
          )}
          {reviewed && !view.receipt && (
            <>
              <Review chainId={chainId} book={book} reply={reviewed.reply} request={reviewed.request} review={reviewed.review} steps={view.steps} feePerGas={view.feePerGas} at={reviewed.at} onLowerSlippage={lowerSlippage} onReceiveBoth={receiveBoth}>
                {reservesWarning && <Note tone="warn" data-position-reserves-stay="">{reservesWarning}</Note>}
                {pauseTick && (
                  <Tick checked={pauseTicked} disabled={pauseTicked} onChange={(next) => next && (ownTick ? setExitTicked(true) : run.acknowledgePause())} data-position-pause-confirm="">{pauseCopy}</Tick>
                )}
                <StepsList chainId={chainId} view={view} action={action} book={book} onCancelSignature={run.cancelSignature} onKeepSignature={run.keepSignature} onRejected={run.forgetUnsettled} />
                {!stepsDone(view) && pauseTick && !pauseTicked && <Note data-position-tick-first="">{COPY.wallet.tickFirst}</Note>}
              </Review>
            </>
          )}
          {view.receipt && <ZapReceiptView chainId={chainId} view={view.receipt} book={book} signed={view.steps.length} />}
          {newHref && (
            <LinkButton href={newHref} variant="outline" size="sm" className="justify-self-start" data-position-new-nft={newTokenId?.toString() ?? ''}>
              {COPY.receipt.newPosition}
            </LinkButton>
          )}
        </div>
      )}

      {phase === 'review' && usesDirect && !directReads && (
        <>
          <RequestSummary chainId={chainId} mode={mode} position={position} book={book} inputs={[]} ticks={null} share={share} way={way} convertTo={convertTo} bps={bps ?? POSITION_SLIPPAGE_DEFAULT_BPS} />
          {reservesWarning && <Note tone="warn" data-position-reserves-stay="">{reservesWarning}</Note>}
        </>
      )}

      {phase === 'review' && usesDirect && directReads && (
        <div className="dm-pa-field" data-position-direct={direct.stage}>
          {!direct.receipt && !directDone && (
            <div className="dm-pa-field" data-position-receive={mode === 'collect' ? 'collect' : 'close'}>
              <SheetCard caption={COPY.wallet.youReceive}>
                {direct.prepared ? (
                  <Pair chainId={chainId} book={book} tokens={[pool.currency0, pool.currency1]} amounts={direct.prepared.receive} size="lg" />
                ) : direct.stage === 'reading' ? (
                  <TokenRows>
                    {[pool.currency0, pool.currency1].map((token) => <TokenRow key={token} mark={<Mark chainId={chainId} book={book} token={token} size={28} />} amount={<Skeleton className="dm-receipt-skel" />} />)}
                  </TokenRows>
                ) : (
                  <p className="dm-pa-hero">
                    <FigureDash reason={direct.error?.copy ?? COPY.page.notRead} />
                  </p>
                )}
              </SheetCard>
              <SheetFacts>
                {mode !== 'collect' && (
                  <SheetFact label={COPY.review.atLeast} data-position-at-least="">
                    {direct.prepared ? <Pair chainId={chainId} book={book} tokens={[pool.currency0, pool.currency1]} amounts={direct.prepared.atLeast} /> : <FigureDash reason={direct.error?.copy ?? COPY.page.notRead} />}
                  </SheetFact>
                )}
                <SheetFact label="Domino fee">{COPY.review.noFee}</SheetFact>
                <SheetFact label={COPY.review.networkFee} data-position-network-fee="">
                  {direct.prepared ? <span className="tnum">{COPY.review.networkFeeUpTo(ethText(direct.prepared.step.networkFeeWei))}</span> : direct.stage === 'reading' ? <Skeleton className="ml-auto h-4 w-20" /> : <FigureDash reason={direct.error?.copy ?? COPY.page.notRead} />}
                </SheetFact>
              </SheetFacts>
            </div>
          )}
          {direct.prepared && direct.prepared.pausesAutomation === null && direct.prepared.state.subscriber !== null && direct.prepared.state.subscriber !== '0x0000000000000000000000000000000000000000' && !done && !quiet && (
            <Note tone="warn" data-position-warning="automation">{COPY.review.stopsAutomation}</Note>
          )}
          {reservesWarning && !done && <Note tone="warn" data-position-reserves-stay="">{reservesWarning}</Note>}
          {direct.prepared?.pausesAutomation != null && !done && gate.mode === 'live' && !quiet && (
            <Tick checked={direct.ticked} disabled={direct.ticked} onChange={(next) => next && direct.tick()} data-position-pause-confirm="">{ROOT_PAUSE_COPY}</Tick>
          )}
          {/* Done with an error only when the receipt can't be read exactly: said under the receipt's own "Confirmed". */}
          <ErrorLine error={directDone ? null : direct.error} />
          {switching ? <Progress data-position-progress="switching">Switch to {v2Chain(chainId).name} in your wallet…</Progress> : direct.stage === 'wallet' && <Progress data-position-progress="wallet">{COPY.wallet.inWallet}</Progress>}
          {/* Changed on purpose 2026-10-14 (C3 review): reads failing on the wallet's network or account say to switch back. */}
          {direct.stage === 'sent' && !direct.receipt && <Progress key={direct.away ?? (direct.slow ? 'slow' : 'pending')} data-position-progress="chain">{direct.away === 'chain' ? COPY.wallet.walletAway(v2Chain(chainId).name) : direct.away === 'account' ? COPY.wallet.accountAway : direct.slow ? COPY.wallet.stillWaiting : COPY.wallet.pendingNetwork}</Progress>}
          {/* Added 2026-10-14 (incident C3): the exit sent 20 s ago whose block is not seen yet, read again by itself (./directRun.ts). */}
          {direct.stage === 'sent' && direct.slow && direct.hash && v2TxUrl(chainId, direct.hash) && <a className="underline" href={v2TxUrl(chainId, direct.hash) ?? undefined} target="_blank" rel="noreferrer noopener" data-step-explorer="">{COPY.wallet.explorer}</a>}
          {direct.stage === 'unknown' && <Note data-position-direct-unknown="">{COPY.wallet.sentUnknown}</Note>}
          {direct.receipt && <DirectReceiptView chainId={chainId} receipt={direct.receipt} book={book} />}
          {directDone && !direct.receipt && <DirectReceiptUnread code={direct.error?.code ?? 'receipt_invalid'} />}
          {/* V1's Close position: its slippage under a closed Advanced at the foot of the review. */}
          {mode === 'close' && !done && direct.stage !== 'wallet' && direct.stage !== 'sent' && direct.stage !== 'unknown' && (
            <SheetMore label={COPY.form.advanced} value={bps === null ? undefined : `${COPY.form.slippage} ${bps / 100}%`} data-close-advanced="">
              <Slippage id="position-v2-close-slippage" bps={slippage} onChange={setSlippage} />
            </SheetMore>
          )}
        </div>
      )}
    </ActionDialog>
  )
}

/**
 * Before the deploy (the gate's `preview`, Changed on purpose (data) 2026-10-02, the owner: real data only): what the
 * person chose, with no figure invented; the footer says the gate's sentence, once. Changed on purpose 2026-10-03 (the
 * owner, point 9): one card, its main choice large (the tokens put in with their marks, the share, the range, the pair)
 * and the rest as facts under it; a change of range is drawn above it (its words stay the card's).
 */
function RequestSummary({ chainId, mode, position, book, inputs, ticks, share, way, convertTo, bps }: {
  chainId: OpenGate['chainId']
  mode: PositionMode
  position: ActionPosition
  book: TokenBook
  inputs: readonly { token: Address; amount: bigint }[]
  ticks: { tickLower: number; tickUpper: number } | null
  share: Share
  way: ExitWay
  convertTo: Address
  bps: number
}) {
  const pool = position.pool
  const pair: readonly [Address, Address] = [pool.currency0, pool.currency1]
  const l0 = labelOf(book, pool.currency0)
  const l1 = labelOf(book, pool.currency1)
  const both = ticks ? rangeBothWays(ticks.tickLower, ticks.tickUpper, decimalsOf(book, pool.currency0), decimalsOf(book, pool.currency1)) : null
  const slippage = <SheetFact label={COPY.review.slippageLabel}>{`${bps / 100}%`}</SheetFact>
  if (mode === 'collect') {
    return (
      <SheetCard caption={COPY.receipt.position} data-position-request={mode}>
        <p className="dm-pa-hero dm-pa-hero--md">
          <PairName chainId={chainId} book={book} tokens={pair} size={24} />
        </p>
      </SheetCard>
    )
  }
  if (mode === 'increase') {
    return (
      <SheetCard caption={COPY.review.youPut} data-position-request={mode}>
        {inputs.length === 0 ? <p className="dm-pa-hero">—</p> : <Rows chainId={chainId} book={book} items={inputs} />}
        <SheetFacts>{slippage}</SheetFacts>
      </SheetCard>
    )
  }
  if (mode === 'changeRange') {
    return (
      <>
        <SheetCard>
          <RangePicture position={position} ticks={ticks} />
        </SheetCard>
        <SheetCard caption={COPY.form.range} data-position-request={mode}>
          {both && <p className="dm-pa-hero dm-pa-hero--md">{`1 ${l0} = ${priceText(both.forward.low) ?? '—'} to ${priceText(both.forward.high) ?? '—'} ${l1}`}</p>}
          <SheetFacts>
            <SheetFact label={COPY.form.howMuch}>{share === '100' ? COPY.form.all : `${share}%`}</SheetFact>
            {slippage}
          </SheetFacts>
        </SheetCard>
      </>
    )
  }
  return (
    <SheetCard caption={COPY.form.howMuch} data-position-request={mode}>
      <p className="dm-pa-hero">{share === '100' ? COPY.form.all : `${share}%`}</p>
      <SheetFacts>
        <SheetFact label={COPY.form.receive}>
          {way === 'both' ? (
            <PairName chainId={chainId} book={book} tokens={pair} size={18} />
          ) : (
            <span className="dm-pa-pair-name">
              <Mark chainId={chainId} book={book} token={convertTo} size={18} />
              <span>{labelOf(book, convertTo)}</span>
            </span>
          )}
        </SheetFact>
        {slippage}
      </SheetFacts>
    </SheetCard>
  )
}
