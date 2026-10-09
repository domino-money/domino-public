import { useMemo, useState, useSyncExternalStore } from 'react'
import { Button } from '../../components/ui'
import { SheetCard, SheetFact, SheetFacts, SheetStatus } from '../../components/positions/ActionSheet'
import { readDirectCloseManyReceipt, type DirectCloseDescription, type DirectCloseMany } from '../../finance/v2/direct'
import { beginClose, pendingClose, rememberCloseHash, settleClose, type PendingClose } from '../../finance/v2/closeJournal'
import { refused } from '../../finance/v2/transact'
import { refreshFeeStates } from '../../lib/fees/useFeeHistory'
import { v2Gate } from '../../v2/gate'
import type { Hex } from '../../v2/types'
import { v2Chain } from '../../v2/chains'
import { v2PageProbe } from '../transports'
import { actionError, type ActionError } from '../position/errors'
import { ActionDialog, ErrorLine, Note, Tick } from '../position/ui'
import { connectPosition, connectPositionReceipt, inTurn, onChain, type PositionConnection } from '../position/wallet'
import { canCloseTogether, closeGroups } from './closeGroups'
import { amountWords, tokenNamer, weiWords, type PositionRowView, type TokenName } from './model'
import { positionChanged } from './positionSync'
import { forgetLocalClose, recordLocalClose } from './localReceipts'
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
  const prepare = async (groups: readonly PositionRowView[][], index: number) => {
    if (['reading', 'wallet', 'sent', 'waiting', 'unknown'].includes(state.stage)) return
    update({ stage: 'reading', groups, index, prepared: null, error: null, hash: null })
    try {
      const earlier = pendingClose(owner)
      if (earlier) { pending = earlier; update({ groups: [recoveryRows(earlier)], index: 0, stage: earlier.hash ? 'waiting' : 'unknown', hash: earlier.hash }); return }
      const group = groups[index]
      const gate = await v2Gate('s1', group[0].chainId, undefined, v2PageProbe)
      if (gate.mode !== 'live') throw new Error('route_unavailable')
      connection = await connectPosition(gate)
      if (connection.wallet.owner.toLowerCase() !== owner.toLowerCase()) throw new Error('wallet_identity_changed')
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
    try {
      for (let attempt = 0; attempt < 60; attempt++) {
        const { receipt, description, replacement } = await (async (): Promise<{ receipt: Awaited<ReturnType<PositionConnection['direct']['receipt']>>; description: DirectCloseDescription | null; replacement: { replaced: boolean; final: boolean } | null }> => {
          if (prepared && knownSenderHash === hash) return { receipt: await connection!.direct.receipt(hash), description: prepared, replacement: null }
          const result = await (recovery?.recoverCloseMany ?? connection!.direct.recoverCloseMany)({ ...intent, hash, originalHash: intent.hash ?? undefined, tokenIds: intent.tokenIds.map(BigInt) })
          return { receipt: result.receipt, description: result.description, replacement: { replaced: result.replaced, final: result.replacementFinal } }
        })()
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
        }
        await new Promise((resolve) => setTimeout(resolve, typeof document !== 'undefined' && document.visibilityState === 'hidden' ? 15_000 : 5_000))
      }
      update({ stage: 'waiting' })
    } catch (error) { update({ stage: state.hash ? 'waiting' : 'unknown', error: actionError(error, intent.chainId) }) }
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
      if (!hash) return
      try {
        update({ error: null })
        if (!connection) {
          recovery = await connectPositionReceipt(pending.chainId)
          if (recovery.wallet.owner.toLowerCase() !== owner) { recovery = null; throw new Error('wallet_identity_changed') }
        }
        else await onChain(connection)
        void poll(hash)
      } catch (error) { update({ error: actionError(error, current()[0].chainId) }) }
    },
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
  const totals = (values: readonly (readonly [bigint, bigint])[]) => {
    const amounts = new Map<string, bigint>()
    prepared?.positions.forEach((position, index) => [position.pool.currency0, position.pool.currency1].forEach((token, side) => amounts.set(token, (amounts.get(token) ?? 0n) + values[index][side])))
    return [...amounts].map(([address, amount]) => amountWords(amount, tokens.get(address) ?? fallback(prepared!.chainId, address))).join(' + ')
  }
  if (eligible.length < 2 && state.stage === 'selection') return null
  const close = () => { setOpen(false); setPause(false) }
  let footer
  if (state.stage === 'selection') footer = <Button disabled={chosen.length < 2} onClick={() => run.start(chosen)}>Review {chosen.length || ''} positions</Button>
  else if (state.stage === 'review') footer = <Button disabled={!!prepared?.pausesAutomation.length && !pause} onClick={() => void run.send(pause)}>Close {current.length} {current.length === 1 ? 'position' : 'positions'}</Button>
  else if (state.stage === 'failed') footer = <Button onClick={() => { setPause(false); run.review() }}>Review again</Button>
  else if (state.stage === 'waiting' || state.stage === 'unknown' && (state.hash || /^0x[0-9a-fA-F]{64}$/.test(recoveryHash))) footer = <Button onClick={() => void run.check(recoveryHash)}>Check status</Button>
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
          <span><bdi>{pairName(row)}</bdi><small>{row.chain} · #{row.tokenId}</small></span>
        </label>)}</div>
        <Note>Positions are grouped to use fewer wallet confirmations. Network fees apply to each group.</Note>
      </> : <>
        {state.completed > 0 && <Note>{state.completed} {state.completed === 1 ? 'position already closed' : 'positions already closed'}.</Note>}
        {state.stage === 'reading' && <SheetStatus>Checking your positions…</SheetStatus>}
        {prepared && state.stage === 'review' && <>
          <SheetCard caption="Estimated to your wallet"><p className="dm-bulk-total tnum">{totals(prepared.receive)}</p><p className="dm-bulk-names">{current.map((row) => pairName(row)).join(' · ')}</p></SheetCard>
          <SheetFacts><SheetFact label="Network fee, at most">{weiWords(prepared.step.networkFeeWei)}</SheetFact><SheetFact label="Domino fee">None</SheetFact></SheetFacts>
          <details className="dm-bulk-details"><summary>Details</summary><SheetFacts><SheetFact label="Minimum returned">{totals(prepared.minimums)}</SheetFact><SheetFact label="Slippage tolerance">0.5%</SheetFact></SheetFacts><p>Closes #{current.map((row) => row.tokenId).join(', #')}. The empty position NFTs stay in your wallet.</p></details>
          {prepared.vaultRoots.length > 0 && <Note>Any funds or other positions held by your automation stay there. You can manage them inside the position.</Note>}
          {prepared.pausesAutomation.length > 0 && <Tick checked={pause} onChange={setPause}>I understand that closing these positions stops their automation.</Tick>}
        </>}
        {state.stage === 'wallet' && <SheetStatus>Confirm in your wallet.</SheetStatus>}
        {state.stage === 'sent' && <SheetStatus>Confirming on {current[0].chain}…</SheetStatus>}
        {state.stage === 'waiting' && <Note>Your transaction is still being checked. Nothing will be sent again.</Note>}
        {state.stage === 'unknown' && <Note>Your wallet may have sent this transaction. Check its activity before continuing. Nothing will be sent again here.</Note>}
        {['unknown', 'waiting'].includes(state.stage) && current.length > 0 && <details className="dm-bulk-details" open={recoveryHash.length > 0}><summary>{state.hash ? 'Updated transaction in your wallet?' : 'Find your transaction'}</summary><label htmlFor="close-recovery-hash">Transaction hash from your wallet</label><input id="close-recovery-hash" value={recoveryHash} onChange={(event) => setRecoveryHash(event.currentTarget.value.trim())} placeholder="0x…" autoComplete="off" /></details>}
        {state.stage === 'done' && <SheetStatus state="done">Withdrawal confirmed.</SheetStatus>}
        <ErrorLine error={state.error} />
      </>}
    </ActionDialog>}
  </>
}
