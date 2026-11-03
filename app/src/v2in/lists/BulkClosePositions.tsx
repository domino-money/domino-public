import { useMemo, useState, useSyncExternalStore } from 'react'
import { Button } from '../../components/ui'
import { SheetCard, SheetFact, SheetFacts, SheetStatus } from '../../components/positions/ActionSheet'
import { readDirectCloseManyReceipt, type DirectCloseDescription, type DirectCloseMany, type LostClose } from '../../finance/v2/direct'
import { beginClose, includedClose, includedCloses, pendingClose, rememberCloseHash, settleClose, type IncludedClose, type PendingClose } from '../../finance/v2/closeJournal'
import { refused, type V2Receipt } from '../../finance/v2/transact'
import { receiptPause, receiptSettled, receiptWalletAway } from '../receiptWait'
import { refreshFeeStates } from '../../lib/fees/useFeeHistory'
import { v2Gate } from '../../v2/gate'
import type { Hex } from '../../v2/types'
import { v2Chain } from '../../v2/chains'
import { v2PageProbe } from '../transports'
import { actionError, REJECTED_IN_WALLET, STILL_PENDING_COPY, type ActionError } from '../position/errors'
import { ActionDialog, ErrorLine, Note, Tick } from '../position/ui'
import { connectPosition, connectPositionReceipt, inTurn, onChain, type PositionConnection } from '../position/wallet'
import { canCloseTogether, closeGroups } from './closeGroups'
import { amountWords, tokenNamer, weiWords, type PositionRowView, type TokenName } from './model'
import { positionChanged } from './positionSync'
import { forgetLocalClose, recordLocalClose } from './localReceipts'
import { closeProof, createCloseHold, type CloseProof } from './closeHold'
import { Marks, TokenHalf } from './parts'
import '../../styles/bulk-close.css'

type Stage = 'selection' | 'reading' | 'review' | 'wallet' | 'sent' | 'waiting' | 'unknown' | 'done' | 'failed'
interface RunState {
  stage: Stage
  groups: readonly PositionRowView[][]
  index: number
  prepared: DirectCloseMany | null
  error: ActionError | null
  hash: Hex | null
  completed: number
}
const INITIAL: RunState = { stage: 'selection', groups: [], index: 0, prepared: null, error: null, hash: null, completed: 0 }
/**
 * Added 2026-11-02 (review A1): what the chain, or the person, said of a close whose wallet answer never came
 * (finance/v2/direct.ts settleLost). `settled` and `forgotten` let it go; the others keep it, and say why.
 */
const LOST_SAID: Record<LostClose, ActionError> = {
  settled: { code: 'close_request_expired', copy: 'This request can no longer go through. Check your wallet’s activity, then review your positions again.', recovery: 'none' },
  forgotten: { code: 'close_request_forgotten', copy: 'Nothing was sent. Review your positions again to continue.', recovery: 'none' },
  open: { code: 'wallet_request_open', copy: 'Your wallet may still be showing this request. Approve or reject it there. If you already rejected or closed it, say so below.', recovery: 'none' },
  pending: { code: 'pending_wallet_transaction', copy: STILL_PENDING_COPY, recovery: 'none' },
  passed: { code: 'close_request_passed', copy: 'Your wallet has sent a transaction since this request, so it may have gone through. Enter its hash below to check, or check again in a few minutes.', recovery: 'none' },
}

function recoveryRows(pending: PendingClose): PositionRowView[] {
  return pending.tokenIds.map((tokenId) => ({ key: `${pending.chainId}:${pending.positionManager}:${tokenId}`, positionManager: pending.positionManager,
    chainId: pending.chainId, chain: v2Chain(pending.chainId).name, dex: pending.dex, dexName: `Uniswap v${pending.dex}`, tokenId,
    block: null, href: '', status: 'not_read', tab: 'pending', tokens: null, fee: null, state: 'unread', unread: null,
    value: null, fees: null, valueUsd: null, feesUsd: null, stale: null, vault: null, hooked: false, family: null }))
}
/** A durable intent precedes the wallet request. Reload restores checks only, never permission to send again. */
function createRun(owner: string) {
  let state = INITIAL
  let pending: PendingClose | null = null
  try {
    pending = pendingClose(owner)
    if (pending) state = { ...INITIAL, groups: [recoveryRows(pending)], stage: pending.hash ? 'waiting' : 'unknown', hash: pending.hash }
  } catch { state = { ...INITIAL, stage: 'unknown', error: { code: 'signature_journal_unavailable', copy: 'This browser can’t recover your earlier wallet request. Nothing will be sent again.', recovery: 'none' } } }
  let connection: PositionConnection | null = null
  let recovery: Awaited<ReturnType<typeof connectPositionReceipt>> | null = null
  let knownSenderHash: Hex | null = null
  let polling = false
  const listeners = new Set<() => void>()
  const update = (change: Partial<RunState>) => { state = { ...state, ...change }; listeners.forEach((listener) => listener()) }
  const current = () => state.groups[state.index]
  /**
   * The money client's own read of a close: the sender's for the hash it sent (`direct`), the recovery's for any other,
   * without its description. Moved on purpose 2026-10-14 (second review of C3 on main) to ./closeHold.ts `closeProof`,
   * unchanged, so a test runs it.
   */
  const proofOf = closeProof
  /** Added 2026-10-14 (incident C3): a close in a block held until final (./closeHold.ts, moved there by the C3 review). */
  const holdUntilFinal = createCloseHold(owner)
  /** The run's own close proved in a block: among the included closes, and held until final. False: it stays where it is. */
  const included = async (intent: PendingClose, hash: Hex, receipt: Extract<V2Receipt, { blockHash: Hex }>, read: CloseProof): Promise<boolean> => {
    let row: IncludedClose
    try { row = await includedClose(intent, hash, Number(receipt.blockNumber), receipt.blockHash) } catch { return false }
    const wallet = (connection ?? recovery)?.wallet ?? null
    holdUntilFinal(row, read, () => !wallet || !wallet.current() ? 'gone' : wallet.chainId() === row.chainId ? 'ready' : 'paused')
    return true
  }
  const prepare = async (groups: readonly PositionRowView[][], index: number) => {
    if (['reading', 'wallet', 'sent', 'waiting', 'unknown'].includes(state.stage)) return
    update({ stage: 'reading', groups, index, prepared: null, error: null, hash: null })
    const restore = (earlier: PendingClose, error: ActionError | null = null) => { pending = earlier; update({ groups: [recoveryRows(earlier)], index: 0, stage: earlier.hash ? 'waiting' : 'unknown', hash: earlier.hash, error }) }
    try {
      const group = groups[index]
      const earlier = pendingClose(owner)
      // Changed on purpose 2026-11-02 (review A1): an earlier close whose wallet answer never came (no hash), on this
      // group's network, is asked of the chain below and no longer stops the group once it can no longer run. Any other
      // earlier close comes back to be checked, as before.
      if (earlier && (earlier.hash !== null || earlier.chainId !== group[0].chainId)) { restore(earlier); return }
      const gate = await v2Gate('s1', group[0].chainId, undefined, v2PageProbe)
      if (gate.mode !== 'live') throw new Error('route_unavailable')
      connection = await connectPosition(gate)
      recovery = null
      if (connection.wallet.owner.toLowerCase() !== owner.toLowerCase()) throw new Error('wallet_identity_changed')
      if (earlier) {
        const said = await inTurn(() => connection!.direct.settleLostClose(earlier))
        if (said !== 'settled') { restore(earlier, LOST_SAID[said]); return }
      }
      // Added 2026-10-14 (incident C3): an included close of this network left by an earlier page (a reload) is held
      // again until final, through this connection; one this run holds already is not asked again.
      const wallet = connection.wallet
      for (const row of includedCloses(owner)) if (row.chainId === group[0].chainId) holdUntilFinal(row, proofOf(row, row.hash, row.hash, null, connection.direct.recoverCloseMany), () => !wallet.current() ? 'gone' : wallet.chainId() === row.chainId ? 'ready' : 'paused')
      const prepared = await inTurn(() => connection!.direct.prepareCloseMany(group[0].dex, group.map((row) => BigInt(row.tokenId)), 50))
      update({ stage: 'review', prepared })
    } catch (error) { update({ stage: 'failed', error: actionError(error, groups[index][0].chainId) }) }
  }
  const poll = async (candidate?: Hex) => {
    if (polling || (!connection && !recovery) || !pending || !(state.hash ?? candidate)) return
    polling = true
    const hash = (candidate ?? state.hash)!
    const { prepared } = state
    const intent = pending
    let announced: string | null = null
    update({ stage: 'sent' })
    const sender = prepared && knownSenderHash === hash ? connection!.direct : null
    const recover = recovery?.recoverCloseMany ?? connection!.direct.recoverCloseMany
    const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'
    let failures = 0
    try {
      for (let attempt = 0; attempt < 60; attempt++) {
        let read: { receipt: Awaited<ReturnType<PositionConnection['direct']['receipt']>>; description: DirectCloseDescription | null; replacement: { replaced: boolean; final: boolean } | null }
        try {
          read = await (async () => {
            if (sender) return { receipt: await sender.receipt(hash), description: prepared, replacement: null }
            const result = await recover({ ...intent, hash, originalHash: intent.hash ?? undefined, tokenIds: intent.tokenIds.map(BigInt) })
            return { receipt: result.receipt, description: result.description, replacement: { replaced: result.replaced, final: result.replacementFinal } }
          })()
          failures = 0
        } catch (error) {
          // Changed on purpose 2026-10-14 (incident C3: waiting never locks): a read that failed is asked again, slower each
          // time (../receiptWait.ts). It ended the wait, and the dialog asked for "Check status". Only the money client's
          // word that this is not the transaction reviewed ends it, as before.
          if (receiptSettled(error)) throw error
          // Changed on purpose 2026-10-14 (C3 review): the wallet now on another network or account ends the wait too,
          // where the read goes through it (Base and Arbitrum One, and a recovered close's description): "Check status"
          // switches it back and reads again. It waited about an hour on "Confirming…" with the button disabled. A close
          // on Robinhood Chain read by its sender comes from the site's own reader, so it is asked again there.
          if (receiptWalletAway(error) && !(sender && intent.chainId === 4663)) throw error
          failures++
          await new Promise((resolve) => setTimeout(resolve, Math.max(hidden() ? 15_000 : 5_000, receiptPause(attempt, failures))))
          continue
        }
        const { receipt, description, replacement } = read
        if (intent.hash && intent.hash !== hash && ['included', 'finalized', 'reverted'].includes(receipt.state)) forgetLocalClose(owner, intent.chainId, intent.positionManager, intent.hash)
        if (replacement?.replaced) {
          if (replacement.final) {
            if (intent.hash) forgetLocalClose(owner, intent.chainId, intent.positionManager, intent.hash)
            await settleClose(intent); pending = null
            update({ stage: 'failed', prepared: null, hash: null, error: { code: 'wallet_transaction_replaced', copy: 'This transaction was replaced in your wallet. Review your positions again to continue.', recovery: 'none' } })
            return
          }
          await new Promise((resolve) => setTimeout(resolve, 5_000))
          continue
        }
        if (receipt.state === 'pending') {
          forgetLocalClose(owner, intent.chainId, intent.positionManager, hash)
          announced = null
          if (!state.hash) { update({ stage: 'unknown', error: { code: 'receipt_pending', copy: 'This transaction has not been found yet. Check the hash in your wallet’s activity.', recovery: 'none' } }); return }
        }
        if (receipt.state === 'included' || receipt.state === 'finalized' || receipt.state === 'reverted') {
          if (receipt.state === 'included') await rememberCloseHash(intent, hash, intent.hash ?? undefined)
          pending = { ...intent, hash }
          update({ hash })
        }
        if (receipt.state === 'reorged' || receipt.state === 'reverted') {
          forgetLocalClose(owner, intent.chainId, intent.positionManager, hash)
          announced = null
        }
        if (receipt.state === 'reverted') {
          await settleClose(intent)
          pending = null
          update({ stage: 'failed', prepared: null, error: { code: 'batch_simulation_reverted', copy: 'This group was not closed. Review it again to continue.', recovery: 'review-again' } })
          return
        }
        if (receipt.state === 'included' || receipt.state === 'finalized') {
          const proof = `${receipt.blockNumber}:${receipt.blockHash}`
          if (announced !== proof) {
            const row = current()[0]
            positionChanged({ chainId: row.chainId, positionManager: row.positionManager, tokenIds: current().map((one) => one.tokenId), wallet: owner, block: receipt.blockNumber })
            if (row.chainId === 4663 && row.dex === 4) refreshFeeStates(current().map((one) => one.tokenId), Number(receipt.blockNumber))
            announced = proof
          }
          try {
            const read = description ? readDirectCloseManyReceipt(description, (connection ?? recovery)!.wallet.owner, receipt) : null
            recordLocalClose({ wallet: owner, chainId: intent.chainId, positionManager: intent.positionManager, dex: intent.dex, hash,
              block: Number(receipt.blockNumber), blockHash: receipt.blockHash, tokenIds: intent.tokenIds, amounts: read?.paid.map(({ token, amount }) => ({ token, amount: amount?.toString() ?? null })) ?? [],
              at: null, state: receipt.state, gas: { gasUsed: receipt.gasUsed.toString(), effectiveGasPrice: receipt.effectiveGasPrice.toString(), l1Fee: receipt.l1Fee?.toString() ?? null } })
          } catch { /* A confirmed close is never repeated because its detailed receipt could not be decoded. */ }
          if (receipt.state === 'finalized') { await settleClose(intent); pending = null; update({ stage: 'done', completed: state.completed + current().length }); return }
          // Changed on purpose 2026-10-14 (incident C3: screens finish at inclusion): in a block is done, and the next group
          // may start; the intent is held until final among the included closes (`included` above). It was done only at
          // finality, about 16 minutes per group on Robinhood Chain. An intent that cannot move there (8 already wait)
          // stays where it is, and this group waits for its finality as before.
          if (await included(intent, hash, receipt, proofOf(intent, hash, intent.hash, sender, recover))) { pending = null; update({ stage: 'done', completed: state.completed + current().length }); return }
        }
        await new Promise((resolve) => setTimeout(resolve, hidden() ? 15_000 : 5_000))
      }
      update({ stage: 'waiting' })
    } catch (error) { update({ stage: state.hash ? 'waiting' : 'unknown', error: actionError(error, intent.chainId) }) }
    finally { polling = false }
  }
  /**
   * Added 2026-11-02 (review A1): the earlier close whose wallet answer never came (kept with no hash), asked of the chain
   * through a client of its own network, or let go on the person's word (`rejected`). It held the group, and every
   * direct exit of its positions, in this browser for good: only a pasted hash or clearing the site's data let it go.
   * Let go (`settled`, `forgotten`), the dialog goes back to review; otherwise it stays, saying why. Nothing is sent.
   */
  const lost = async (rejected: boolean) => {
    const intent = pending
    if (state.stage !== 'unknown' || !intent || intent.hash !== null || polling) return
    polling = true
    update({ error: null })
    try {
      let client: Pick<PositionConnection['direct'], 'settleLostClose'>
      if (connection && connection.chainId === intent.chainId) { await onChain(connection); client = connection.direct }
      else {
        const reader = await connectPositionReceipt(intent.chainId)
        if (reader.wallet.owner.toLowerCase() !== owner) throw new Error('wallet_identity_changed')
        client = reader
      }
      const said = await client.settleLostClose(intent, rejected)
      if (said === 'settled' || said === 'forgotten') { pending = null; update({ stage: 'failed', prepared: null, hash: null, error: LOST_SAID[said] }); return }
      update({ error: LOST_SAID[said] })
    } catch (error) { update({ error: actionError(error, intent.chainId) }) }
    finally { polling = false }
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    snapshot: () => state,
    start: (rows: readonly PositionRowView[]) => { const groups = closeGroups(rows); if (groups.length) void prepare(groups, 0) },
    review: () => void prepare(state.groups, state.index),
    next: () => { if (state.stage === 'done' && state.index + 1 < state.groups.length) void prepare(state.groups, state.index + 1) },
    reset: () => { if (!['reading', 'wallet', 'sent', 'waiting', 'unknown'].includes(state.stage)) { state = INITIAL; listeners.forEach((listener) => listener()) } },
    check: async (candidate?: string) => {
      if (!['waiting', 'unknown'].includes(state.stage) || !pending || polling) return
      const hash = /^0x[0-9a-fA-F]{64}$/.test(candidate ?? '') ? candidate!.toLowerCase() as Hex : state.hash
      // Changed on purpose 2026-11-02 (review A1): with no hash, the chain is asked whether the request can still go through.
      if (!hash) return lost(false)
      try {
        update({ error: null })
        // Changed on purpose 2026-11-02 (review B2): a close on another network than this run's connection (another tab's,
        // restored here) is read through that network's own reader; it was read through the connection's, and stayed
        // "pending" until a reload.
        if (!connection || connection.chainId !== pending.chainId) {
          recovery = await connectPositionReceipt(pending.chainId)
          if (recovery.wallet.owner.toLowerCase() !== owner) { recovery = null; throw new Error('wallet_identity_changed') }
        }
        else { recovery = null; await onChain(connection) }
        void poll(hash)
      } catch (error) { update({ error: actionError(error, current()[0].chainId) }) }
    },
    /** Review A1: "I rejected it in my wallet", for a close whose wallet answer never came. */
    rejected: () => lost(true),
    send: async (pause: boolean) => {
      if (state.stage !== 'review' || !state.prepared || !connection) return
      const prepared = state.prepared
      update({ stage: 'wallet', error: null })
      try {
        await onChain(connection)
        const transaction = prepared.step.transaction
        const intent: PendingClose = { wallet: owner, chainId: prepared.chainId, positionManager: current()[0].positionManager,
          dex: prepared.dex, tokenIds: prepared.positions.map((position) => String(position.tokenId)), data: transaction.data.toLowerCase() as Hex,
          nonce: `0x${BigInt(transaction.nonce).toString(16)}`, hash: null }
        await beginClose(intent)
        pending = intent
        const hash = await connection.direct.sendCloseMany(prepared, true, pause, async () => {
          // The wallet may deliver an explicit refusal after the request timed out. That proof releases both latches.
          try { await settleClose(intent); pending = null; update({ stage: 'failed', prepared: null, hash: null, error: { code: 'wallet_refused', copy: 'You declined this request in your wallet.', recovery: 'none' } }) }
          catch { update({ stage: 'unknown', error: null }) }
        })
        knownSenderHash = hash
        update({ hash, stage: 'sent' })
        await rememberCloseHash(intent, hash)
        pending = { ...intent, hash }
        void poll()
      } catch (error) {
        if (!refused(error) && connection.direct.wasGroupOffered(prepared)) update({ stage: 'unknown', error: null })
        else {
          if (pending) { try { await settleClose(pending); pending = null } catch { update({ stage: 'unknown', error: null }); return } }
          update({ stage: 'failed', prepared: null, error: actionError(error, current()[0].chainId) })
        }
      }
    },
  }
}
const runs = new Map<string, ReturnType<typeof createRun>>()
const runFor = (owner: string) => { const key = owner.toLowerCase(); let run = runs.get(key); if (!run) { run = createRun(key); runs.set(key, run) } return run }

const pairName = (row: PositionRowView) => row.tokens ? row.tokens.map((token) => token.label).join(' / ') : `Position #${row.tokenId}`

/** The list has one quiet entry point. Checkboxes appear only after choosing to close positions. */
export function BulkClosePositions({ owner, rows }: { owner: string; rows: readonly PositionRowView[] }) {
  const run = useMemo(() => runFor(owner), [owner])
  const state = useSyncExternalStore(run.subscribe, run.snapshot, run.snapshot)
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [pause, setPause] = useState(false)
  const [recoveryHash, setRecoveryHash] = useState('')
  const eligible = rows.filter(canCloseTogether)
  const chosen = eligible.filter((row) => selected.has(row.key))
  const current = state.groups[state.index] ?? []
  const busy = ['reading', 'wallet', 'sent'].includes(state.stage)
  const prepared = state.prepared
  const tokens = new Map<string, TokenName>(current.flatMap((row) => (row.tokens ?? []).map((token) => [token.address, token] as const)))
  const fallback = tokenNamer([])
  const totalWords = (values: readonly (readonly [bigint, bigint])[]) => {
    const amounts = new Map<string, bigint>()
    prepared?.positions.forEach((position, index) => [position.pool.currency0, position.pool.currency1].forEach((token, side) => amounts.set(token, (amounts.get(token) ?? 0n) + values[index][side])))
    return [...amounts].map(([address, amount]) => amountWords(amount, tokens.get(address) ?? fallback(prepared!.chainId, address)))
  }
  const totals = (values: readonly (readonly [bigint, bigint])[]) => totalWords(values).join(' + ')
  /** V4 (look only, positions.html .tot): the same words as `totals`, each amount's symbol in its own quieter ink. */
  const totalInks = (values: readonly (readonly [bigint, bigint])[]) => totalWords(values).map((words, index) => {
    const cut = words.lastIndexOf(' ')
    return <span key={index}>{index > 0 && <span className="dm-bulk-plus"> + </span>}{cut > 0 ? <span className="dm-bulk-amt">{words.slice(0, cut)}<span className="dm-bulk-sym"> {words.slice(cut + 1)}</span></span> : <span className="dm-bulk-amt">{words}</span>}</span>
  })
  if (eligible.length < 2 && state.stage === 'selection') return null
  const close = () => { setOpen(false); setPause(false) }
  // Where the stage stands, and how many are already closed: the same lines in the same words, drawn beside the dominoes
  // while a group is under way (V4, positions.html .prog), in the body's flow otherwise.
  const stageLine = state.stage === 'reading' ? <SheetStatus>Checking your positions…</SheetStatus>
    : state.stage === 'wallet' ? <SheetStatus>Confirm in your wallet.</SheetStatus>
    : state.stage === 'sent' ? <SheetStatus>Confirming on {current[0].chain}…</SheetStatus>
    : state.stage === 'waiting' ? <Note>Your transaction is still being checked. Nothing will be sent again.</Note>
    : state.stage === 'unknown' ? <Note>Your wallet may have sent this transaction. Check its activity before continuing. Nothing will be sent again here.</Note>
    : state.stage === 'done' ? <SheetStatus state="done">Withdrawal confirmed.</SheetStatus>
    : null
  const completedLine = state.completed > 0 && <Note>{state.completed} {state.completed === 1 ? 'position already closed' : 'positions already closed'}.</Note>
  const progress = ['reading', 'wallet', 'sent', 'waiting', 'unknown', 'done'].includes(state.stage) && current.length > 0
  let footer
  if (state.stage === 'selection') footer = <Button disabled={chosen.length < 2} onClick={() => run.start(chosen)}>Review {chosen.length || ''} positions</Button>
  else if (state.stage === 'review') footer = <Button disabled={!!prepared?.pausesAutomation.length && !pause} onClick={() => void run.send(pause)}>Close {current.length} {current.length === 1 ? 'position' : 'positions'}</Button>
  else if (state.stage === 'failed') footer = <Button onClick={() => { setPause(false); run.review() }}>Review again</Button>
  // Changed on purpose 2026-11-02 (review A1): Check status with no hash entered asks the chain whether the request can still go through.
  else if (state.stage === 'waiting' || state.stage === 'unknown' && current.length > 0) footer = <Button onClick={() => void run.check(recoveryHash)}>Check status</Button>
  else if (state.stage === 'done' && state.index + 1 < state.groups.length) footer = <Button onClick={() => { setPause(false); run.next() }}>Continue to next group</Button>
  else if (state.stage === 'done') footer = <Button onClick={() => { run.reset(); setSelected(new Set()); close() }}>Done</Button>
  else footer = <Button disabled={busy} onClick={close}>{state.stage === 'unknown' ? 'Close' : 'Confirming…'}</Button>
  return <>
    <Button variant="ghost" size="sm" onClick={() => setOpen(true)} data-bulk-close-open="">{['wallet', 'sent', 'waiting', 'unknown'].includes(state.stage) ? 'View closing progress' : 'Close positions'}</Button>
    {open && <ActionDialog id="close-many" title="Close positions" onClose={close} footer={footer} data-bulk-close={state.stage}
      lede={state.stage === 'selection' ? 'Choose positions to close. Both tokens return to your wallet.' : current.length ? `${current[0].chain} · Group ${state.index + 1} of ${state.groups.length}` : undefined}
      back={['review', 'failed'].includes(state.stage) ? { onClick: () => { run.reset(); setPause(false) } } : null}>
      {state.stage === 'selection' ? <>
        <div className="dm-bulk-choices">{eligible.map((row) => <label key={row.key} className="dm-bulk-choice" aria-label={`Close ${pairName(row)}, position ${row.tokenId} on ${row.chain}`}>
          <input type="checkbox" checked={selected.has(row.key)} onChange={(event) => { const checked = event.currentTarget.checked; setSelected((before) => { const next = new Set(before); if (checked) next.add(row.key); else next.delete(row.key); return next }) }} />
          <Marks tokens={row.tokens} size={28} />
          <span><bdi>{pairName(row)}</bdi><small>{row.chain} · #{row.tokenId}</small></span>
        </label>)}</div>
        <Note>Positions are grouped to use fewer wallet confirmations. Network fees apply to each group.</Note>
      </> : <>
        {/* V4: the group stands as dominoes, one tile a position, its two tokens its halves; they lean as it is signed and
            sent, and fall once it is closed (decoration only, from the stage and the group shown). Beside them (positions.html
            .prog): where it stands, the group's pairs, and how many are already closed. */}
        {progress ? <div className="dm-bulk-prog">
          <div className="dm-bulk-dom" data-st={state.stage} aria-hidden="true">
            {current.slice(0, 2).map((row) => <span key={row.key} className="dm-bulk-dt">{row.tokens && <><TokenHalf token={row.tokens[0]} size={14} /><TokenHalf token={row.tokens[1]} size={14} /></>}</span>)}
          </div>
          <div className="dm-bulk-pst">
            {stageLine}
            <p className="dm-bulk-names">{current.map((row) => pairName(row)).join(' · ')}</p>
            {completedLine}
          </div>
        </div> : <>
          {completedLine}
          {state.stage === 'reading' && stageLine}
        </>}
        {prepared && state.stage === 'review' && <>
          <SheetCard caption="Estimated to your wallet"><p className="dm-bulk-total tnum">{totalInks(prepared.receive)}</p><p className="dm-bulk-names">{current.map((row) => pairName(row)).join(' · ')}</p></SheetCard>
          <SheetFacts><SheetFact label="Network fee, at most">{weiWords(prepared.step.networkFeeWei)}</SheetFact><SheetFact label="Domino fee">None</SheetFact></SheetFacts>
          <details className="dm-bulk-details"><summary>Details</summary><SheetFacts><SheetFact label="Minimum returned">{totals(prepared.minimums)}</SheetFact><SheetFact label="Slippage tolerance">0.5%</SheetFact></SheetFacts><p>Closes #{current.map((row) => row.tokenId).join(', #')}. The empty position NFTs stay in your wallet.</p></details>
          {prepared.vaultRoots.length > 0 && <Note>Any funds or other positions held by your automation stay there. You can manage them inside the position.</Note>}
          {prepared.pausesAutomation.length > 0 && <Tick checked={pause} onChange={setPause}>I understand that closing these positions stops their automation.</Tick>}
        </>}
        {!progress && state.stage !== 'reading' && stageLine}
        {['unknown', 'waiting'].includes(state.stage) && current.length > 0 && <details className="dm-bulk-details" open={recoveryHash.length > 0}><summary>{state.hash ? 'Updated transaction in your wallet?' : 'Find your transaction'}</summary><label htmlFor="close-recovery-hash">Transaction hash from your wallet</label><input id="close-recovery-hash" value={recoveryHash} onChange={(event) => setRecoveryHash(event.currentTarget.value.trim())} placeholder="0x…" autoComplete="off" /></details>}
        <ErrorLine error={state.error} />
        {/* Added 2026-11-02 (review A1): V1's way out of a request whose wallet answer never came. */}
        {state.stage === 'unknown' && !state.hash && current.length > 0 && <Button variant="outline" size="sm" className="justify-self-start" onClick={() => void run.rejected()} data-bulk-close-rejected="">{REJECTED_IN_WALLET}</Button>}
      </>}
    </ActionDialog>}
  </>
}
