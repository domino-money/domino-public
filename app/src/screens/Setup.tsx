import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { PoolExplorer } from '../components/read/screens/PoolExplorer'
import type { PoolOption } from '../lib/read/screens/poolsList'
import { livePort, } from '../session/livePort'
import { sessionKey } from '../session/port'
import { realClock } from '../lib/clock'
import { financialFetch } from '../finance/http'
import { liveWalletHandoff } from '../finance/wallet'
import { createHttpDepositTransport } from '../deposit/httpTransport'
import { createDepositClient } from '../deposit/client'
import { DEPOSIT_RUNTIME } from '../deposit/contract'
import { createDepositFlow } from '../deposit/flow'
import { createMemory, localStorageBackend } from '../deposit/memory'
import { checkPreSign } from '../deposit/presign'
import { presentOperation, type ActionId } from '../deposit/present'
import type { DepositSelection } from '../deposit/types'
import { OperationPanel } from '../components/deposit/OperationPanel'
import { Button, Card, Display } from '../components/ui'
import AdvancedSetup from './AdvancedSetup'

const initial = { amountRaw: '', budget0Raw: '', budget1Raw: '', tickLower: '', tickUpper: '', slippageBps: '50',
  nativeGasReserveRaw: '', maxGasLimitRaw: '', maxFeePerGasRaw: '', maxPriorityFeePerGasRaw: '' }
const labels: Record<keyof typeof initial, string> = { amountRaw: 'Input amount (smallest token units)', budget0Raw: 'Maximum token 0 spend (smallest units)',
  budget1Raw: 'Maximum token 1 spend (smallest units)', tickLower: 'Lower tick', tickUpper: 'Upper tick', slippageBps: 'Slippage limit (basis points)',
  nativeGasReserveRaw: 'Keep native gas reserve (wei)', maxGasLimitRaw: 'Maximum gas units', maxFeePerGasRaw: 'Maximum gas price (wei)', maxPriorityFeePerGasRaw: 'Maximum priority fee (wei)' }
export default function Setup() {
  const session = useSyncExternalStore(livePort.subscribe, livePort.getSnapshot)
  const scope = sessionKey(session)
  const [pool, setPool] = useState<PoolOption | null>(null), [form, setForm] = useState(initial)
  const [approval, setApproval] = useState<string | null>(null), [sending, setSending] = useState(false), [notice, setNotice] = useState<string | null>(null)
  const [creation, setCreation] = useState(false)
  const deps = useMemo(() => {
    const client = createDepositClient({ session: livePort, runtime: DEPOSIT_RUNTIME, transport: createHttpDepositTransport({ fetch: financialFetch, clock: realClock }) })
    const memory = createMemory(localStorageBackend())
    return { client, memory, flow: createDepositFlow({ client, session: livePort, memory, clock: realClock, handoff: liveWalletHandoff }) }
  }, [])
  const state = useSyncExternalStore(deps.flow.subscribe, deps.flow.getState)
  useEffect(() => deps.flow.start(), [deps])
  useEffect(() => { let key = sessionKey(livePort.getSnapshot()); return livePort.subscribe(() => { const next = sessionKey(livePort.getSnapshot()); if (next !== key) { key = next; setApproval(null); setPool(null); setForm(initial); setNotice(null); setSending(false); setCreation(false) } }) }, [])
  const current = state.current
  const approvalKey = `${scope}|${current?.op.id}|${current?.op.version}`
  const ack = approval === approvalKey
  const setAck = (value: boolean) => setApproval(value ? approvalKey : null)
  const shown = current ? presentOperation(current.op, current.walletStep, { monoNowMs: realClock.monoMs(), walletStepDeadlineMono: current.walletStepDeadlineMono,
    issueWalletStepAllowed: deps.flow.issueWalletStepAllowed, latched: Boolean(state.latched[current.op.id]), busy: state.busy !== null || sending,
    walletSendAvailable: true }) : null
  const check = current ? checkPreSign({ response: current.prepareResponse, runtime: DEPOSIT_RUNTIME, sessionOwner: session.kind === 'signed_in' ? session.owner : null,
    wallet: { chainId: session.kind === 'signed_in' ? session.chainId : null, account: session.kind === 'signed_in' ? session.owner : null },
    monoNowMs: realClock.monoMs(), walletStepDeadlineMono: current.walletStepDeadlineMono, summaryAcknowledged: ack, handoff: liveWalletHandoff }) : null
  async function create() {
    if (session.kind !== 'signed_in' || !pool || creation || state.busy || sending) return
    if (pool.integration !== 'hookless_fixed_fee') { setNotice('This pool needs a separate integration.'); return }
    const numeric = [form.tickLower, form.tickUpper, form.slippageBps]
    if (!numeric.every(value => /^-?(0|[1-9]\d{0,6})$/.test(value))) { setNotice('Enter valid ticks and slippage.'); return }
    const selection: DepositSelection = { chainId: 4663, poolId: pool.key, poolKey: { currency0: pool.currencies[0].address,
      currency1: pool.currencies[1].address, fee_pips: pool.feePips, tick_spacing: pool.tickSpacing, hooks: '0x0000000000000000000000000000000000000000' },
      independentToken: pool.currencies[0].address, ...form, tickLower: Number(form.tickLower), tickUpper: Number(form.tickUpper), slippageBps: Number(form.slippageBps) }
    const body = { idempotencyKey: crypto.randomUUID(), selection }
    if (!DEPOSIT_RUNTIME.validateRequest('create', body)) { setNotice('Check token amounts, ticks and gas limits. All limits must be explicit.'); return }
    setCreation(true); setNotice(null)
    const key = scope, outcome = await deps.client.create(body, { epoch: session.epoch })
    if (sessionKey(livePort.getSnapshot()) !== key) return
    setCreation(false)
    if (!outcome.ok) { setNotice(outcome.failure.kind === 'error' ? outcome.failure.code.replaceAll('_', ' ') : 'The deposit service is unavailable. No transaction was sent.'); return }
    deps.memory.remember(outcome.data.operation.id)
    deps.flow.dispatch({ t: 'user', action: 'open', id: outcome.data.operation.id })
  }
  async function send() {
    const latest = deps.flow.getState().current, signed = livePort.getSnapshot()
    if (!latest || signed.kind !== 'signed_in' || sending || deps.flow.getState().busy) return
    const valid = checkPreSign({ response: latest.prepareResponse, runtime: DEPOSIT_RUNTIME, sessionOwner: signed.owner,
      wallet: { chainId: signed.chainId, account: signed.owner }, monoNowMs: realClock.monoMs(), walletStepDeadlineMono: latest.walletStepDeadlineMono,
      summaryAcknowledged: ack, handoff: liveWalletHandoff })
    if (!valid.ok || !latest.walletStep) return
    setSending(true); setAck(false); setNotice(null)
    try {
      const hash = await liveWalletHandoff.send(latest.walletStep, { chainId: 4663, from: signed.owner, isCurrent: () =>
        sessionKey(livePort.getSnapshot()) === scope && deps.flow.getState().current === latest
        && latest.walletStepDeadlineMono !== null && realClock.monoMs() < latest.walletStepDeadlineMono
        && DEPOSIT_RUNTIME.validateResponse('prepare', latest.prepareResponse) })
      if (sessionKey(livePort.getSnapshot()) !== scope) return
      deps.flow.dispatch({ t: 'user', action: 'report', hash })
      setNotice(`Wallet returned ${hash}. Check status to reconcile the canonical receipt.`)
    } catch {
      if (sessionKey(livePort.getSnapshot()) === scope) setNotice('The wallet step has been offered once. If rejected or its result is unclear, check status and your wallet activity before preparing again. It will not be sent again from this page.')
    } finally { if (sessionKey(livePort.getSnapshot()) === scope) setSending(false) }
  }
  const action = (id: ActionId, hash?: string) => { if (sending) return; deps.flow.dispatch({ t: 'user', action: id === 'check_allowances' ? 'allowances' : id, hash }) }
  return <main className="mx-auto max-w-[1100px] px-5 py-10">
    <Display as="h1" className="text-[38px]">Create or recover a position</Display>
    <p className="mt-3 text-sm text-fg-muted">Choose a pool, review token budgets and approve each step in your wallet. Direct deposits carry no Domino percentage fee. Gas and Uniswap pool fees still apply.</p>
    {session.kind !== 'signed_in' ? <Card className="mt-6 p-5">Sign in with your wallet to prepare a deposit or view its receipts.</Card> : <>
      {notice && <p className="mt-5 break-all" role="status">{notice}</p>}
      {state.notice && <p className="mt-5" role="status">{state.notice.text}</p>}
      <Card className="mt-6 p-5"><h2 className="font-medium">Existing deposits</h2>{state.items.length ? state.items.map(item => <Button key={item.id} variant="outline" className="mt-2 mr-2" onClick={() => deps.flow.dispatch({ t: 'user', action: 'open', id: item.id })}>{item.state} · {item.id.slice(0, 8)}</Button>) : <p className="mt-2 text-sm text-fg-muted">No deposits returned for this session.</p>}</Card>
      {current && shown && <div className="mt-6"><OperationPanel op={current.op} view={shown} onAction={action} preSign={check?.rows ?? null} summaryAcknowledged={ack}
        onAcknowledge={setAck} allowances={current.allowances} handoffAvailable />{current.walletStep && <Button className="mt-4" disabled={!check?.ok || sending || state.busy !== null} onClick={() => { void send() }}>{sending ? 'Waiting for wallet…' : 'Review and send in wallet'}</Button>}</div>}
      <PoolExplorer onSelection={setPool} />
      {pool && <form className="mt-5 grid gap-3 rounded-xl border p-5 sm:grid-cols-2" onSubmit={event => { event.preventDefault(); void create() }}>
        <h2 className="font-medium sm:col-span-2">Deposit budgets · {pool.fee} pool</h2><p className="break-all text-xs sm:col-span-2">Token 0: {pool.currencies[0].address}<br />Token 1: {pool.currencies[1].address}</p>
        {(Object.keys(initial) as (keyof typeof initial)[]).map(name => <label key={name} className="text-sm">{labels[name]}<input className="mt-1 block w-full rounded border bg-surface-1 p-2" value={form[name]} onChange={event => setForm(old => ({ ...old, [name]: event.target.value }))} /></label>)}
        <Button type="submit" disabled={creation || state.busy !== null || sending}>Create deposit draft</Button><p className="text-xs text-fg-muted">This saves your selection. Each approval and mint is reviewed separately before your wallet opens.</p>
      </form>}
    </>}
    <AdvancedSetup />
  </main>
}
