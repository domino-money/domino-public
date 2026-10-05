import { useEffect, useRef, useState } from 'react'
import { positionHref } from '../../components/explore/routes'
import { SheetCard, SheetFact, SheetFacts, SheetMore, TokenRow, TokenRows } from '../../components/positions/ActionSheet'
import { Button, FigureDash, LinkButton, Skeleton } from '../../components/ui'
import { slippageBpsFrom } from '../../lib/create/slippage'
import { useWalletIdentity } from '../../lib/walletIdentity'
import { ethText, priceText, rangeBothWays } from '../../v2/plan/present'
import type { S1PlanRequest } from '../../v2/plan/types'
import type { ActionName, Address } from '../../v2/types'
import { v2PositionHref } from '../route'
import { CHANGE_RANGE_BURNS_WHEN_ALL, EXIT_BURNS, POSITION_SLIPPAGE_DEFAULT_BPS, POSITION_SLIPPAGE_MIN_BPS, ROOT_PAUSE_COPY, type Share } from './constants'
import { COPY } from './copy'
import { useDirectExit } from './directRun'
import { AmountsField, RangeField, RangePicture, ReceiveField, ShareField } from './Fields'
import { initialAmounts, initialRange, inputsOf, shareOf, ticksOf, type AmountsValue, type RangeValue } from './forms'
import type { ActionPosition, VaultReserves } from './model'
import { DirectReceiptView, ZapReceiptView } from './Receipt'
import { Review } from './Review'
import { useActionRun } from './run'
import { Slippage } from './Slippage'
import { StepButton, StepsList, stepsDone } from './Steps'
import { amountText, decimalsOf, labelOf, type TokenBook } from './tokens'
import { ActionDialog, ErrorLine, Locked, Mark, Note, Pair, PairName, Progress, Rows, Tick } from './ui'
import { offerVault } from './vaultHandoff'
import type { OpenGate } from './wallet'

export type PositionMode = 'increase' | 'changeRange' | 'exit' | 'collect'
type ExitWay = 'both' | 'convert'

/** "1.5 USDG + 0.001 ETH": a vault's reserves above zero, in their tokens' own units; null when none is. */
export function reservesText(book: TokenBook, reserves: VaultReserves): string | null {
  const above = (reserves.reserves ?? []).filter((reserve) => reserve.amount > 0n)
  return above.length ? above.map((reserve) => amountText(book, reserve.token, reserve.amount)).join(' + ') : null
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
export function PositionDialog({ gate, position, mode, book, reserves = null, onClose, onDone }: {
  gate: OpenGate
  position: ActionPosition
  mode: PositionMode
  book: TokenBook
  /** The vault's reserves as read-v6 read them, when the position is a vault's root (rev3 §2.13). */
  reserves?: VaultReserves | null
  onClose: () => void
  /** The action is on chain: the page reads again (with the block it was included in, when known). */
  onDone: (block?: bigint) => void
}) {
  const chainId = gate.chainId
  const pool = position.pool
  const [phase, setPhase] = useState<'form' | 'review'>(mode === 'collect' ? 'review' : 'form')
  const [amounts, setAmounts] = useState<AmountsValue>(() => initialAmounts(pool))
  const [range, setRange] = useState<RangeValue>(initialRange)
  const [slippage, setSlippage] = useState(String(POSITION_SLIPPAGE_DEFAULT_BPS))
  const [way, setWay] = useState<ExitWay>('both')
  const [share, setShare] = useState<Share>('100')
  const [convertTo, setConvertTo] = useState<Address>(pool.currency1)
  const bps = slippageBpsFrom(slippage)
  const inputs = mode === 'increase' ? inputsOf(amounts, pool, book) : null
  const ticks = mode === 'changeRange' && position.tick !== null ? ticksOf(range, pool, position.tick, book) : null
  const sameRange = ticks !== null && ticks.tickLower === position.tickLower && ticks.tickUpper === position.tickUpper
  const removing = shareOf(position.liquidity, share)
  const action: ActionName = mode === 'collect' ? 'exit' : mode
  const label = (token: Address) => labelOf(book, token)
  const run = useActionRun({
    gate,
    action,
    inputs: inputs ?? [],
    label,
    request: (consent): S1PlanRequest => {
      const base = { chainId, consent, position: { dex: position.dex, tokenId: position.tokenId }, slippageBps: bps ?? POSITION_SLIPPAGE_DEFAULT_BPS }
      const liquidityToRemove = share === '100' ? ('all' as const) : removing
      if (mode === 'increase') return { ...base, action: 'increase', inputs: inputs ?? [] }
      if (mode === 'changeRange') return { ...base, action: 'changeRange', tickLower: ticks?.tickLower ?? position.tickLower, tickUpper: ticks?.tickUpper ?? position.tickUpper, liquidityToRemove, burn: share === '100' && CHANGE_RANGE_BURNS_WHEN_ALL }
      return { ...base, action: 'exit', liquidityToRemove, burn: share === '100' && EXIT_BURNS, receive: { convertTo } }
    },
  })
  const direct = useDirectExit(gate, position, label)
  const usesDirect = mode === 'collect' || (mode === 'exit' && way === 'both')
  // A direct action reads the position through the wallet, on the position's chain (the live path switches it there
  // first, §1.3). Under `preview` nothing is sent, so the wallet is never asked to switch for a read: off the position's
  // chain the review shows what was chosen, as the zap actions' preview does.
  const identity = useWalletIdentity()
  const directReads = gate.mode === 'live' || (identity.kind === 'connected' && identity.chainId === chainId)
  const view = run.view
  const reviewed = view.reviewed
  const ready = bps !== null && (mode === 'increase' ? inputs !== null : mode === 'changeRange' ? ticks !== null && !sameRange && position.liquidity > 0n : position.liquidity > 0n)
  // What a waiting Review button says is missing (Changed on purpose 2026-10-03: never a dead grey bar).
  const missing = bps === null ? COPY.form.checkSlippage : mode === 'increase' && inputs === null ? COPY.form.enterAmount : mode === 'changeRange' && ticks === null ? COPY.form.enterPrices : mode === 'changeRange' && sameRange ? COPY.form.differentRange : COPY.form.review

  // A collect opens straight on its review, as V1's Collect fees does: the position read through the wallet.
  const opened = useRef(false)
  useEffect(() => {
    if (mode !== 'collect' || opened.current) return
    opened.current = true
    if (directReads) void direct.quote('collect', POSITION_SLIPPAGE_DEFAULT_BPS, 0n)
  }, [mode, direct, directReads])

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
    doneRef.current()
  }, [done])

  // Rev3/rev4 §2.13: an exit of a vault's root (armed or not) leaves the fees waiting to be reinvested in the vault. The
  // review says so with the vault's reserves; once the exit is on chain the automation panel opens at them.
  // The chain's own word once the review or the preparation read it (the zap client's and the direct client's root
  // probes, armed or not); before that, read-v6's.
  const rootVault = reviewed ? reviewed.review.vaultRoot : direct.prepared ? direct.prepared.vaultRoot : position.vault?.role === 'root' ? position.vault.address : null
  const exitVault = mode === 'exit' ? rootVault : null
  const leavesReserves = exitVault !== null
  const handedToReserves = useRef(false)
  useEffect(() => {
    if (!leavesReserves || !done || handedToReserves.current || !exitVault) return
    handedToReserves.current = true
    offerVault({ chainId, vault: exitVault, focus: 'reserves' })
  }, [leavesReserves, done, exitVault, chainId])
  const reservesWarning = leavesReserves && exitVault
    ? (reserves && reserves.vault === exitVault && reserves.reserves !== null
        ? (reservesText(book, reserves) ? COPY.reserves.exitWarning(reservesText(book, reserves) as string) : null)
        : COPY.reserves.exitWarningUnread)
    : null
  // Decision #5: at the end of an armed root's add, withdrawal or collect, the page offers to turn automation back on (the
  // automation panel does it); not after a withdrawal of everything, which leaves the root empty (its reserves go first).
  const pausedVault = zapDone ? view.rearm : directDone ? direct.prepared?.pausesAutomation ?? null : null
  const rearmVault = pausedVault !== null && !(mode === 'exit' && share === '100') ? pausedVault : null

  const review = () => {
    setPhase('review')
    if (!usesDirect) run.start()
    else if (directReads) void direct.quote(mode === 'collect' ? 'collect' : 'close', bps ?? POSITION_SLIPPAGE_DEFAULT_BPS, removing)
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
          <Button type="button" variant="primary" size="lg" data-position-rearm={rearmVault} onClick={() => { offerVault({ chainId, vault: rearmVault, focus: 'rearm' }); onClose() }}>
            {COPY.wallet.rearm}
          </Button>
        )}
        <Button type="button" variant="secondary" size="lg" onClick={onClose} data-position-back="">
          {COPY.wallet.backToPosition}
        </Button>
      </>
    )
  } else if (phase === 'form') {
    footer = (
      <Button type="button" variant="primary" size="lg" disabled={!ready} onClick={review} data-position-continue={mode}>
        {ready ? COPY.form.review : missing}
      </Button>
    )
  } else if (gate.mode === 'preview') {
    footer = <Locked copy={gate.lockedCopy} />
  } else if (usesDirect) {
    const blocked = direct.prepared?.pausesAutomation != null && !direct.ticked
    const offer = direct.stage === 'ready' || (direct.stage === 'failed' && direct.retry)
    footer = (
      <Button type="button" variant="primary" size="lg" disabled={!offer || blocked} aria-busy={direct.stage === 'reading' || direct.stage === 'wallet' || direct.stage === 'sent' || undefined} onClick={() => void direct.send()} data-position-send={mode === 'collect' ? 'collect' : 'close'}>
        {mode === 'collect' ? COPY.wallet.collectInWallet : COPY.wallet.withdrawInWallet}
      </Button>
    )
  } else {
    footer = <StepButton view={view} onConfirm={run.confirm} blocked={reviewed !== null && reviewed.review.pausesAutomation !== null && !view.pauseAcknowledged} />
  }
  // The review's way back to the form: a chevron left of the title (not on Collect fees, which has no form, nor once done).
  const backTo = phase === 'review' && !done && mode !== 'collect' ? { onClick: back, disabled: view.busy || direct.stage === 'wallet' || direct.stage === 'sent', 'data-position-review-back': '' } : null

  return (
    <ActionDialog id={mode} title={COPY.title[mode]} lede={COPY.lede[mode]} back={backTo} onClose={onClose} footer={footer} data-position-dialog={`v2-${mode}`} data-position-gate={gate.mode}>
      {position.vault?.role === 'root' && position.vault.armed === true && !done && <Note tone="warn" data-position-root-note="">{ROOT_PAUSE_COPY}</Note>}

      {phase === 'form' && mode === 'increase' && <AmountsField chainId={chainId} position={position} book={book} value={amounts} onChange={setAmounts} />}
      {phase === 'form' && mode === 'changeRange' && <RangeField position={position} book={book} value={range} onChange={setRange} ticks={ticks} sameRange={sameRange} />}
      {phase === 'form' && (mode === 'changeRange' || mode === 'exit') && <ShareField value={share} onChange={setShare} label={mode === 'changeRange' ? 'Amount to move' : undefined} />}
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
          {view.stage === 'quoting' && <Progress data-position-quoting="">{view.requoting ? COPY.review.requoting : COPY.review.quoting}</Progress>}
          {view.stage === 'failed' && <ErrorLine error={view.error} onRejected={run.forgetUnsettled} busy={view.busy} />}
          {view.stage === 'failed' && view.error?.recovery === 'offer-both' && (
            <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={receiveBoth} data-position-receive-both="">{COPY.review.receiveBoth}</Button>
          )}
          {view.stage === 'preview' && (
            <RequestSummary chainId={chainId} mode={mode} position={position} book={book} inputs={inputs ?? []} ticks={ticks} share={share} way={way} convertTo={convertTo} bps={bps ?? POSITION_SLIPPAGE_DEFAULT_BPS} />
          )}
          {reviewed && !view.receipt && (
            <>
              <Review chainId={chainId} book={book} reply={reviewed.reply} request={reviewed.request} review={reviewed.review} steps={view.steps} feePerGas={view.feePerGas} at={reviewed.at} onLowerSlippage={lowerSlippage} onReceiveBoth={receiveBoth}>
                {reservesWarning && <Note tone="warn" data-position-reserves-stay="">{reservesWarning}</Note>}
                {reviewed.review.pausesAutomation !== null && (
                  <Tick checked={view.pauseAcknowledged} disabled={view.pauseAcknowledged} onChange={(next) => next && run.acknowledgePause()} data-position-pause-confirm="">{ROOT_PAUSE_COPY}</Tick>
                )}
                <StepsList chainId={chainId} view={view} action={action} book={book} onCancelSignature={run.cancelSignature} onKeepSignature={run.keepSignature} onRejected={run.forgetUnsettled} />
                {!stepsDone(view) && reviewed.review.pausesAutomation !== null && !view.pauseAcknowledged && <Note data-position-tick-first="">{COPY.wallet.tickFirst}</Note>}
              </Review>
            </>
          )}
          {view.receipt && <ZapReceiptView chainId={chainId} view={view.receipt} book={book} />}
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
          {!direct.receipt && (
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
                {mode === 'exit' && (
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
          {direct.prepared && direct.prepared.pausesAutomation === null && direct.prepared.state.subscriber !== null && direct.prepared.state.subscriber !== '0x0000000000000000000000000000000000000000' && !done && (
            <Note tone="warn" data-position-warning="automation">{COPY.review.stopsAutomation}</Note>
          )}
          {reservesWarning && !done && <Note tone="warn" data-position-reserves-stay="">{reservesWarning}</Note>}
          {direct.prepared?.pausesAutomation != null && !done && gate.mode === 'live' && (
            <Tick checked={direct.ticked} disabled={direct.ticked} onChange={(next) => next && direct.tick()} data-position-pause-confirm="">{ROOT_PAUSE_COPY}</Tick>
          )}
          <ErrorLine error={direct.error} />
          {direct.stage === 'wallet' && <Progress data-position-progress="wallet">{COPY.wallet.inWallet}</Progress>}
          {direct.stage === 'sent' && !direct.receipt && <Progress data-position-progress="chain">{COPY.wallet.pendingNetwork}</Progress>}
          {direct.stage === 'unknown' && <Note data-position-direct-unknown="">{COPY.wallet.sentUnknown}</Note>}
          {direct.receipt && <DirectReceiptView chainId={chainId} receipt={direct.receipt} book={book} />}
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
