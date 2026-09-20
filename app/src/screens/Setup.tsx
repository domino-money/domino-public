import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { PoolExplorer } from '../components/read/screens/PoolExplorer'
import { CREATE } from '../lib/create/copy'
import type { SetupDraft } from '../lib/create/journey'
import { carriedFor, clearSetupDraft, setupDraftFor } from '../lib/create/setupDraft'
import { SLIPPAGE_DEFAULT_BPS, slippageBpsFrom } from '../lib/create/slippage'
import { SlippageChoice } from '../components/create/SlippageChoice'
import type { PoolOption } from '../lib/read/screens/poolsList'
import { useReadSource } from '../lib/read/screens/readContext'
import { readWithin } from '../lib/read/screens/screenRead'
import { livePort, } from '../session/livePort'
import { sessionKey } from '../session/port'
import { realClock } from '../lib/clock'
import { financialFetch } from '../finance/http'
import { liveWalletHandoff } from '../finance/wallet'
import { createHttpDepositTransport } from '../deposit/httpTransport'
import { createDepositClient, type DepositFailure } from '../deposit/client'
import { DEPOSIT_RUNTIME } from '../deposit/contract'
import { failureCopy } from '../deposit/copy'
import { blockingOperation, createDepositFlow } from '../deposit/flow'
import { createMemory, localStorageBackend } from '../deposit/memory'
import { checkPreSign } from '../deposit/presign'
import { presentListItem, presentOperation, type ActionId, type TokenBook, type TokenDetails } from '../deposit/present'
import type { DepositSelection } from '../deposit/types'
import { OperationPanel } from '../components/deposit/OperationPanel'
import { Button, Card, Display, Pill } from '../components/ui'
import AdvancedSetup from './AdvancedSetup'

const initial = { amountRaw: '', budget0Raw: '', budget1Raw: '', tickLower: '', tickUpper: '', slippageBps: String(SLIPPAGE_DEFAULT_BPS),
  nativeGasReserveRaw: '', maxGasLimitRaw: '', maxFeePerGasRaw: '', maxPriorityFeePerGasRaw: '' }
const labels: Record<keyof typeof initial, string> = { amountRaw: 'Input amount (smallest token units)', budget0Raw: 'Maximum token 0 spend (smallest units)',
  budget1Raw: 'Maximum token 1 spend (smallest units)', tickLower: 'Lower tick', tickUpper: 'Upper tick', slippageBps: 'Slippage limit',
  nativeGasReserveRaw: 'Keep native gas reserve (wei)', maxGasLimitRaw: 'Maximum gas units', maxFeePerGasRaw: 'Maximum gas price (wei)', maxPriorityFeePerGasRaw: 'Maximum priority fee (wei)' }

/** A failure as a closed code, for data attributes and titles only. */
const failureCode = (failure: DepositFailure) => failure.kind === 'error' ? failure.code : failure.kind === 'contract' ? `contract_${failure.detail}` : failure.kind
/** An action's outcome, said where the action was taken. `blocker` is the deposit that holds this one back. */
type Notice = { text: string; code: string | null; place: 'draft' | 'step'; blocker: string | null }
const NO_TOKENS: ReadonlyMap<string, TokenDetails> = new Map()

const UNKNOWN_TOKEN: TokenDetails = { symbol: null, decimals: null }
const NO_FAILURES: ReadonlyMap<string, number> = new Map()
const NOTHING_DUE: ReadonlySet<string> = new Set()
/** A failed token read is asked again on its own this many times, the first after this wait, then at doubling intervals. */
const TOKEN_ATTEMPTS = 3
const TOKEN_WAIT_MS = 4000

/**
 * Public token details for the currencies the listed deposits name: one read
 * per unknown address, one at a time on the app's paced read source, kept for
 * the page's life. Nothing is read without a deposit to show. A read that
 * fails leaves the token unknown, so its amounts stay in raw units, labelled
 * so, and it is asked again by itself a few times, spaced out and only while
 * the page is visible; the raw units stay on screen meanwhile.
 */
function useTokenBook(addresses: readonly string[], known: ReadonlyMap<string, TokenDetails>): TokenBook {
  const source = useReadSource()
  const [read, setRead] = useState<ReadonlyMap<string, TokenDetails>>(NO_TOKENS)
  // Failed attempts per address, and the failed addresses whose wait has passed.
  const [failed, setFailed] = useState<ReadonlyMap<string, number>>(NO_FAILURES)
  const [due, setDue] = useState<ReadonlySet<string>>(NOTHING_DUE)
  const wanted = [...new Set(addresses.map(address => address.toLowerCase()))].sort().join(',')
  useEffect(() => {
    const unknown = wanted ? wanted.split(',').filter(address => !known.has(address)) : []
    const next = unknown.find(address => !read.has(address)) ?? unknown.find(address => due.has(address))
    if (!source || !next) return
    const controller = new AbortController()
    const settle = (details: TokenDetails | null) => {
      if (controller.signal.aborted) return
      setRead(old => details ? new Map(old).set(next, details) : old.has(next) ? old : new Map(old).set(next, UNKNOWN_TOKEN))
      setFailed(old => {
        const counts = new Map(old)
        if (details) counts.delete(next)
        else counts.set(next, (old.get(next) ?? 0) + 1)
        return counts
      })
      setDue(old => {
        if (!old.has(next)) return old
        const rest = new Set(old)
        rest.delete(next)
        return rest
      })
    }
    readWithin(source, 'token', { token: next }, { signal: controller.signal })
      .then(outcome => settle(outcome.state === 'ok' ? { symbol: outcome.data.asset.symbol, decimals: outcome.data.asset.decimals } : null), () => settle(null))
    return () => controller.abort()
  }, [source, wanted, known, read, due])
  useEffect(() => {
    const waiting = [...failed].filter(([address, count]) => count <= TOKEN_ATTEMPTS && !due.has(address))
    if (waiting.length === 0) return
    const timers: ReturnType<typeof setTimeout>[] = []
    const ready = new Set<string>()
    const release = () => {
      if (document.hidden || ready.size === 0) return
      const addresses = [...ready]
      ready.clear()
      setDue(old => new Set([...old, ...addresses]))
    }
    document.addEventListener('visibilitychange', release)
    for (const [address, count] of waiting) {
      timers.push(setTimeout(() => {
        ready.add(address)
        release()
      }, TOKEN_WAIT_MS * 2 ** (count - 1)))
    }
    return () => {
      for (const timer of timers) clearTimeout(timer)
      document.removeEventListener('visibilitychange', release)
    }
  }, [failed, due])
  return useMemo(() => new Map(wanted ? wanted.split(',').map(address => [address, known.get(address) ?? read.get(address) ?? 'reading'] as const) : []), [wanted, known, read])
}

/** Setup's draft fields as New position's choices fill them in. Budgets and network limits stay for the owner to enter. */
const formFromDraft = (draft: SetupDraft | null): typeof initial => draft ? { ...initial, amountRaw: draft.amountRaw, tickLower: String(draft.tickLower), tickUpper: String(draft.tickUpper), slippageBps: String(draft.slippageBps) } : initial

export default function Setup() {
  const session = useSyncExternalStore(livePort.subscribe, livePort.getSnapshot)
  const scope = sessionKey(session)
  // New position's choices, when the owner continued here signed in: read once, for this session only, and sent nowhere.
  const [carried, setCarried] = useState<SetupDraft | null>(() => setupDraftFor(sessionKey(livePort.getSnapshot())))
  const [explored, setExplored] = useState<PoolOption | null>(null)
  const pool = explored ?? carried?.pool ?? null
  const [form, setForm] = useState(() => formFromDraft(carried))
  const [independent, setIndependent] = useState<0 | 1>(() => carried?.independent ?? 0)
  const [approval, setApproval] = useState<string | null>(null), [sending, setSending] = useState(false), [notice, setNotice] = useState<Notice | null>(null)
  const [creation, setCreation] = useState(false)
  const deps = useMemo(() => {
    const client = createDepositClient({ session: livePort, runtime: DEPOSIT_RUNTIME, transport: createHttpDepositTransport({ fetch: financialFetch, clock: realClock }) })
    const memory = createMemory(localStorageBackend())
    return { client, memory, flow: createDepositFlow({ client, session: livePort, memory, clock: realClock, handoff: liveWalletHandoff }) }
  }, [])
  const state = useSyncExternalStore(deps.flow.subscribe, deps.flow.getState)
  useEffect(() => deps.flow.start(), [deps])
  useEffect(() => { let key = sessionKey(livePort.getSnapshot()); return livePort.subscribe(() => { const next = sessionKey(livePort.getSnapshot()); if (next !== key) { key = next; clearSetupDraft(); setCarried(null); setExplored(null); setIndependent(0); setApproval(null); setForm(initial); setNotice(null); setSending(false); setCreation(false) } }) }, [])
  // A pool picked in the explorer other than the one New position carried: the carried token index, amount and ticks were that pool's, so they go.
  // The handler stays the same function, so the explorer hands over a selection only when the selection changes.
  const carriedNow = useRef(carried)
  useEffect(() => { carriedNow.current = carried }, [carried])
  const explore = useCallback((next: PoolOption | null) => {
    setExplored(next)
    const held = carriedNow.current
    if (held === null || carriedFor(held, next) !== null) return
    carriedNow.current = null
    clearSetupDraft(); setCarried(null); setIndependent(0)
    setForm(old => ({ ...old, amountRaw: '', tickLower: '', tickUpper: '' }))
  }, [])
  const current = state.current
  const known = useMemo(() => new Map<string, TokenDetails>(pool ? pool.currencies.flatMap(token => token.origin === 'read' ? [[token.address, { symbol: token.symbol, decimals: token.decimals }] as const] : []) : []), [pool])
  const tokens = useTokenBook([...state.items, ...(current ? [current.op] : [])].flatMap(item => [item.selection.poolKey.currency0, item.selection.poolKey.currency1]), known)
  const approvalKey = `${scope}|${current?.op.id}|${current?.op.version}`
  const ack = approval === approvalKey
  const setAck = (value: boolean) => setApproval(value ? approvalKey : null)
  const shown = current ? presentOperation(current.op, current.walletStep, { monoNowMs: realClock.monoMs(), walletStepDeadlineMono: current.walletStepDeadlineMono,
    issueWalletStepAllowed: deps.flow.issueWalletStepAllowed, latched: Boolean(state.latched[current.op.id]), busy: state.busy !== null || sending,
    walletSendAvailable: true, tokens }) : null
  const check = current ? checkPreSign({ response: current.prepareResponse, runtime: DEPOSIT_RUNTIME, sessionOwner: session.kind === 'signed_in' ? session.owner : null,
    wallet: { chainId: session.kind === 'signed_in' ? session.chainId : null, account: session.kind === 'signed_in' ? session.owner : null },
    monoNowMs: realClock.monoMs(), walletStepDeadlineMono: current.walletStepDeadlineMono, summaryAcknowledged: ack, handoff: liveWalletHandoff }) : null
  // A failed read the page made on its own is silent: its reason goes to the list's title and data attributes. A user action's failure is said in words.
  const quiet = state.notice?.automatic ? state.notice : null
  const said = state.notice && !state.notice.automatic ? state.notice : null
  const rows = state.items.map(item => presentListItem(item, tokens))
  async function create() {
    if (session.kind !== 'signed_in' || !pool || creation || state.busy || sending) return
    const say = (text: string, code: string | null = null, blocker: string | null = null) => setNotice({ text, code, place: 'draft', blocker })
    if (pool.integration !== 'hookless_fixed_fee') { say('This pool needs a separate integration.'); return }
    if (![form.tickLower, form.tickUpper].every(value => /^-?(0|[1-9]\d{0,6})$/.test(value))) { say('Enter valid ticks.'); return }
    // The limit is the person's own, inside the product's bound (lib/create/slippage.ts); the wire carries whole basis points.
    const slippageBps = slippageBpsFrom(form.slippageBps)
    if (slippageBps === null) { say(CREATE.amount.slippageRequired); return }
    const selection: DepositSelection = { chainId: 4663, poolId: pool.key, poolKey: { currency0: pool.currencies[0].address,
      currency1: pool.currencies[1].address, fee_pips: pool.feePips, tick_spacing: pool.tickSpacing, hooks: '0x0000000000000000000000000000000000000000' },
      independentToken: pool.currencies[independent].address, ...form, tickLower: Number(form.tickLower), tickUpper: Number(form.tickUpper), slippageBps }
    const body = { idempotencyKey: crypto.randomUUID(), selection }
    if (!DEPOSIT_RUNTIME.validateRequest('create', body)) { say('Check token amounts, ticks and gas limits. All limits must be explicit.'); return }
    setCreation(true); setNotice(null)
    const key = scope, outcome = await deps.client.create(body, { epoch: session.epoch })
    if (sessionKey(livePort.getSnapshot()) !== key) return
    setCreation(false)
    if (!outcome.ok) {
      const code = failureCode(outcome.failure)
      say(failureCopy(outcome.failure), code, code === 'deposit_owner_busy' ? blockingOperation(deps.flow.getState().items, null)?.id ?? null : null)
      return
    }
    deps.memory.remember(outcome.data.operation.id)
    // The carried choices have become this deposit draft.
    clearSetupDraft()
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
      setNotice({ text: `Wallet returned ${hash}. Check status to reconcile the canonical receipt.`, code: null, place: 'step', blocker: null })
    } catch {
      if (sessionKey(livePort.getSnapshot()) === scope) setNotice({ text: 'The wallet step has been offered once. If rejected or its result is unclear, check status and your wallet activity before preparing again. It will not be sent again from this page.', code: null, place: 'step', blocker: null })
    } finally { if (sessionKey(livePort.getSnapshot()) === scope) setSending(false) }
  }
  const action = (id: ActionId, hash?: string) => { if (sending) return; setNotice(null); deps.flow.dispatch({ t: 'user', action: id === 'check_allowances' ? 'allowances' : id, hash }) }
  const open = (id: string) => { setNotice(null); deps.flow.dispatch({ t: 'user', action: 'open', id }) }
  const blockerButton = (id: string | null) => id && <Button className="justify-self-start" variant="outline" size="sm" disabled={state.busy !== null} onClick={() => open(id)}>Open the blocking deposit</Button>
  return <main className="dm-page dm-page--narrow">
    <Display as="h1" className="dm-display-title">Create or recover a position</Display>
    <p className="dm-acct-lede">Choose a pool, review token budgets and approve each step in your wallet. Direct deposits carry no Domino percentage fee. You pay network gas; Uniswap pool fees apply only if you swap.</p>
    {session.kind !== 'signed_in' ? <Card className="dm-acct-block dm-acct-signin">Sign in with your wallet to prepare a deposit or view its receipts.</Card> : <>
      <Card className="dm-acct-block dm-acct-panel" data-deposits={state.phase} data-deposits-reason={quiet ? failureCode(quiet.failure) : undefined}
        title={quiet ? `Deposits could not be read: ${failureCode(quiet.failure).replaceAll('_', ' ')}` : undefined}>
        <h2 className="dm-acct-panel-title">Your deposits</h2>
        {rows.length ? <div className="dm-rows dm-acct-oplist" aria-label="Your deposits">{rows.map(row =>
          <Button key={row.id} variant="ghost" className="dm-acct-oprow h-auto min-h-[44px] flex-wrap gap-x-3 gap-y-0.5 whitespace-normal py-2 text-left"
            aria-current={current?.op.id === row.id ? 'true' : undefined} disabled={state.busy !== null} onClick={() => open(row.id)} data-deposit-row={row.id}>
            <span className="font-medium">{row.pair}</span>
            <span className="tnum text-fg-muted" title={row.amount === null ? 'Reading token details' : undefined}>{row.amount ?? '—'}</span>
            <span className="text-fg-subtle">{row.state} · {row.updated}</span>
            {row.reserved && <Pill>Reserved slot</Pill>}
          </Button>)}</div>
          : <p className="dm-acct-panel-note">Deposits you create appear here.</p>}
        {state.hasMore && state.nextBefore !== null && <Button className="justify-self-start" variant="ghost" size="sm" disabled={state.busy !== null} onClick={() => { setNotice(null); deps.flow.dispatch({ t: 'user', action: 'load_more' }) }}>{state.busy === 'list' ? 'Reading deposits…' : 'More deposits'}</Button>}
      </Card>
      {said && <div className="dm-acct-block dm-acct-stack">
        <p className="dm-acct-line dm-acct-wrap" role="status" data-deposit-notice={failureCode(said.failure)}>{said.text}</p>
        {blockerButton(state.blockerId)}
      </div>}
      {current && shown && <div className="dm-acct-block dm-acct-stack"><OperationPanel op={current.op} view={shown} onAction={action} preSign={check?.rows ?? null} summaryAcknowledged={ack}
        onAcknowledge={setAck} allowances={current.allowances} handoffAvailable />{current.walletStep && <Button className="justify-self-start" variant="accent" disabled={!check?.ok || sending || state.busy !== null} onClick={() => { void send() }}>{sending ? 'Waiting for wallet…' : 'Review and send in wallet'}</Button>}
        {notice?.place === 'step' && <p className="dm-acct-line dm-acct-wrap" role="status">{notice.text}</p>}</div>}
      <PoolExplorer onSelection={explore} />
      {pool && <form className="dm-card dm-acct-block dm-acct-draft" data-setup-draft={carried && pool.key === carried.pool.key ? 'new-position' : 'typed'} onSubmit={event => { event.preventDefault(); void create() }}>
        <h2 className="dm-acct-panel-title dm-acct-span">Deposit budgets · {pool.fee} pool</h2><p className="dm-acct-hash dm-acct-span">Token 0: {pool.currencies[0].address}<br />Token 1: {pool.currencies[1].address}</p>
        {carried && pool.key === carried.pool.key && <p className="dm-hint dm-acct-span">Filled in from New position. Enter the budgets and network limits, then create the draft. Nothing is sent before that.</p>}
        <label className="dm-label dm-acct-lf">Input amount is in<select className="dm-field dm-acct-mono-field" value={independent} onChange={event => setIndependent(event.target.value === '1' ? 1 : 0)}><option value={0}>Token 0</option><option value={1}>Token 1</option></select></label>
        {(Object.keys(initial) as (keyof typeof initial)[]).map(name => name === 'slippageBps'
          // The same presets and exact box as New position's amount step, over the same bound; a choice carried from there is the one shown.
          ? <SlippageChoice key={name} id="setup-slippage" label={labels.slippageBps} bps={form.slippageBps} onChange={text => setForm(old => ({ ...old, slippageBps: text }))} />
          : <label key={name} className="dm-label dm-acct-lf">{labels[name]}<input className="dm-field dm-acct-mono-field" value={form[name]} onChange={event => setForm(old => ({ ...old, [name]: event.target.value }))} /></label>)}
        <Button type="submit" className="justify-self-start" disabled={creation || state.busy !== null || sending}>Create deposit draft</Button><p className="dm-hint dm-acct-span">This saves your selection. Each approval and mint is reviewed separately before your wallet opens.</p>
        {notice?.place === 'draft' && <div className="dm-acct-span dm-acct-stack">
          <p className="dm-acct-line dm-acct-wrap" role="status" data-deposit-notice={notice.code ?? undefined}>{notice.text}</p>
          {blockerButton(notice.blocker)}
        </div>}
      </form>}
    </>}
    {/* The draft's limit is the balancing swap's too, until the owner sets the swap's own. */}
    <AdvancedSetup slippageBps={session.kind === 'signed_in' && pool ? form.slippageBps : undefined} />
  </main>
}
