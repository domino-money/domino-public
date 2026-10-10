import type { ChainBalancesResponse } from 'api-contracts/read-v6/types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../../components/ui'
import { browserBatchJournal, browserDepositJournal, browserOriginWallet, browserUnsettledStore, createOriginSender, OriginStepError, type OriginSender } from '../../finance/v2/crosschain'
import { browserFundingStorage, withFundingLock } from '../../finance/v2/fundingJournal'
import { CANDIDATE_ORIGINS, type Holding } from '../../finance/v2/holdings'
import { openWalletDialog } from '../../finance/signedOut'
import { REVIEW_GAS_RESERVE_WEI } from '../../lib/create/reviewPlan'
import { v2Chain } from '../../v2/chains'
import { quoteDeadlineMono } from '../../v2/crosschain/client'
import { naming, originGasDetail, presentQuote, shortAmountText } from '../../v2/crosschain/present'
import type { CrosschainRequests, OriginsList } from '../../v2/crosschain/types'
import { SEND_MARGIN_MS } from '../../v2/crosschain/steps'
import type { V2Gate } from '../../v2/gate'
import { readChainBalances } from '../../v2/read/v6'
import { routeServes } from '../../v2/routes'
import type { V2ChainId } from '../../v2/types'
import { switchToOrigin } from '../../wallet/port'
import { v2Transports } from '../transports'
import { FUNDS_RECEIPT_POLL_MS, FUNDS_TYPED_QUOTE_DEBOUNCE_MS } from './constants'
import { FUNDS_TEXT, senderCopy } from './copy'
import { DepositStatus, PendingDeposit, type TrackedDeposit } from './DepositStatus'
import { runDeposit, type FlowStage } from './flow'
import { balanceChainsRequest, balancesRequest, holdingsFromChainBalances, kindOf, mergeBalances, nativeOn, originCandidate, originName, originToken, requestFailure, sendable, valueUsdOf, type FundingBudget, type Lack } from './model'
import { freezeFunding, fundingSpendable, fundingStorageKey, gasRecoveryKey, outstandingLegs, parseFunding, planFunding, planGasRecovery, requestForLeg, respectsLeg, withGasFailure, type FundingIntent, type PricedLeg } from './fundingIntent'
import type { FundsServices } from './services'
import { invalidateFundingBalances, readFundingBalanceGroup } from './balanceCache'
import { fundingOrigins, fundingWait } from './originsCache'
import { canDiscardFunding, fundingNeverSent } from './fundingLifecycle'

const ZERO = '0x0000000000000000000000000000000000000000'
const rawValue = (raw: string | null) => raw !== null && /^\d+$/.test(raw) ? BigInt(raw) : null
type Screen = 'checking' | 'quoting' | 'ready' | 'running' | 'tracking' | 'paused' | 'empty' | 'unavailable'
type Proposal = { intent: FundingIntent; quotes: PricedLeg[]; recoveryFrom?: string }
const GAS_RECOVERY_COPY = 'Ethereum needs more ETH for its network fee. Review another way to fund this position; your position amount stays the same.'
class FundingError extends Error {
  constructor(readonly copy: string, readonly code: string, readonly retryMs: number | null = null) { super(code) }
}
function findHoldings(answer: ChainBalancesResponse | null, chainId: V2ChainId, closedKey: string, target: string | null): Holding[] {
  if (!answer) return []
  const closed = new Set(closedKey.split(',').filter(Boolean).map(Number))
  const out: Holding[] = []
  for (const profile of CANDIDATE_ORIGINS) {
    const candidate = originCandidate(profile.chainId)
    if (!candidate || candidate.chainId === chainId || closed.has(candidate.chainId)) continue
    const gas = nativeOn(answer, candidate.chainId)
    if (gas === null || gas <= 0n) continue
    out.push(...(holdingsFromChainBalances(answer, candidate)?.holdings ?? []).filter((holding) => sendable(holding) > 0n))
  }
  return out.sort((a, b) => {
    const dollars = (h: Holding) => { const text = valueUsdOf(answer, h.chainId, h.token); return text && /^\d+(\.\d+)?$/.test(text) ? Number(text) * Number(sendable(h)) / Number(h.raw) : null }
    const avUsd = dollars(a), bvUsd = dollars(b)
    if (avUsd !== null && bvUsd !== null && avUsd !== bvUsd) return bvUsd - avUsd
    const sameA = kindOf(a.chainId, a.token) === kindOf(chainId, target ?? '')
    const sameB = kindOf(b.chainId, b.token) === kindOf(chainId, target ?? '')
    if (sameA !== sameB) return sameA ? -1 : 1
    const av = sendable(a) * 10n ** BigInt(b.decimals), bv = sendable(b) * 10n ** BigInt(a.decimals)
    return av > bv ? -1 : av < bv ? 1 : a.chainId - b.chainId
  })
}

export interface BringFundsProps {
  gate: Exclude<V2Gate, { mode: 'off' }>
  services: FundsServices | null
  chainId: V2ChainId
  wallet: string
  access: string
  walletChainId: number | null
  lacks: readonly Lack[]
  nativeOnDestination: string | null
  poolTokens: readonly string[]
  /** Pool/range and the original user input, excluding prices and balances. */
  intentKey?: string
  /** Pool/range/payment choice, excluding the amount: typing keeps an opened alternative open. */
  selectionKey?: string
  /** An explicit alternative budget, never a fabricated deficit in the current wallet. */
  remoteBudget?: FundingBudget | null
  discreet?: boolean
  /** A usable local payment is already offered. Remote funds stay available without unsolicited quotes. */
  optional?: boolean
  /** Preserve the last verified deficit while the destination's balances refresh. */
  checking?: boolean
  shortSaid?: boolean
  keep?: { side: 0 | 1; text: string; label: string } | null
  takes?: { side: 0 | 1; symbol: string | null } | null
  onUse: (side: 0 | 1, text: string) => void
  onUseToken?: (token: string, text: string) => void
  /** Select a received payment token after verified arrival; never creates or signs a position. */
  onRemoteUse?: (token: string, paymentRaw: string) => void
  onArrived?: () => void
}

/** One proposal; validated independent transfers into the same wallet. Never an atomic cross-chain promise. */
export function BringFunds(props: BringFundsProps) {
  return <FundingOffer key={`${props.wallet.toLowerCase()}:${props.chainId}`} {...props} />
}

function FundingOffer({ gate, services, chainId, wallet, access, walletChainId, lacks, nativeOnDestination, poolTokens, intentKey, selectionKey, remoteBudget = null, discreet = false, optional = false, checking = false, keep = null, takes = null, onUse, onUseToken, onRemoteUse, onArrived }: BringFundsProps) {
  const live = gate.mode === 'live' && services !== null
  const ready = access.startsWith('ready:')
  const destination = v2Chain(chainId)
  const journal = useMemo(() => live ? browserDepositJournal() : null, [live])
  const unsettled = useMemo(() => browserUnsettledStore(), [])
  const batches = useMemo(() => browserBatchJournal(), [])
  const storage = useMemo(() => browserFundingStorage(), [])
  const storageKey = fundingStorageKey(wallet, chainId)
  const readIntent = useCallback((strict = false) => {
    const raw = storage.get(storageKey), parsed = parseFunding(raw, wallet, chainId)
    if (strict && raw !== null && parsed === null) throw new FundingError('The saved transfer needs checking before another can be sent.', 'funding_storage_invalid')
    return parsed
  }, [storage, storageKey, wallet, chainId])
  const [intent, setIntent] = useState<FundingIntent | null>(() => live ? readIntent() : null)
  const intentRef = useRef(intent)
  const [deposits, setDeposits] = useState<TrackedDeposit[]>(() => (journal?.list(chainId, wallet) ?? []).map((record) => ({
    record, destinationToken: intent?.legs.some((leg) => leg.depositTxHash === record.depositTxHash) ? intent.destinationToken : null,
    originLabel: null, review: null, journaled: true,
  })))
  const [settled, setSettled] = useState<Set<string>>(() => new Set())
  const [revision, setRevision] = useState(0)
  const [readSnapshot, setReadSnapshot] = useState<{ data: ChainBalancesResponse | null; complete: boolean } | null>(null)
  const readDone = readSnapshot !== null
  const balances = readSnapshot?.data ?? null
  const [reading, setReading] = useState(true)
  const lastGroups = useRef<(ChainBalancesResponse | null)[]>([null, null])
  const [listing, setListing] = useState<OriginsList | null>(null)
  const [screen, setScreen] = useState<Screen>('checking')
  const [notice, setNotice] = useState<{ copy: string; code: string } | null>(null)
  const [prepared, setProposal] = useState<Proposal | null>(null)
  const [stage, setStage] = useState<{ origin: number; value: FlowStage } | null>(null)
  const [run, setRun] = useState(false)
  const running = useRef(false)
  const senderRef = useRef<Promise<OriginSender> | null>(null)
  const generation = useRef(0)
  const preparation = useRef<AbortController | null>(null)
  const attempted = useRef('')
  const automaticAttempts = useRef(0)
  const retryAfter = useRef(0)
  const [prepareRevision, setPrepareRevision] = useState(0)
  const [remoteSelection, setRemoteSelection] = useState<string | null>(null)
  const [visible, setVisible] = useState(typeof document === 'undefined' || !document.hidden)
  const [expired, setExpired] = useState(false)
  const mounted = useRef(true)
  const scope = intentKey ?? poolTokens.join(':')
  const selection = selectionKey ?? scope
  const remoteOpened = remoteSelection === selection
  const latest = useRef({ ready, walletChainId, scope })
  useEffect(() => { latest.current = { ready, walletChainId, scope } }, [ready, walletChainId, scope])
  const knownNative = rawValue(nativeOnDestination) ?? (balances ? nativeOn(balances, chainId) : null)
  const gasOnly = !discreet && lacks.length === 0 && knownNative !== null && knownNative < REVIEW_GAS_RESERVE_WEI
  const observedLack: Lack | null = lacks.find((lack) => lack.shortRaw !== null && lack.shortRaw > 0n) ?? (gasOnly ? {
    side: 0, token: ZERO, symbol: 'ETH', decimals: 18, haveRaw: knownNative ?? 0n, shortRaw: REVIEW_GAS_RESERVE_WEI - (knownNative ?? 0n),
  } : null)
  const [previousLack, setPreviousLack] = useState<{ scope: string; lack: Lack | null }>({ scope, lack: observedLack })
  if (!checking && (previousLack.scope !== scope || previousLack.lack?.token !== observedLack?.token || previousLack.lack?.shortRaw !== observedLack?.shortRaw || previousLack.lack?.haveRaw !== observedLack?.haveRaw)) setPreviousLack({ scope, lack: observedLack })
  const targetLack = checking && previousLack.scope === scope ? previousLack.lack : observedLack
  // A selected alternative may fund the whole budget even when local tokens already cover it.
  const budget = remoteBudget && remoteBudget.requiredRaw > 0n && (optional || !targetLack) ? remoteBudget : null
  const targetAmount = budget ?? targetLack
  const target = targetAmount?.token ?? lacks[0]?.token ?? null
  const need = budget?.requiredRaw ?? targetLack?.shortRaw ?? null
  const [shownContext, setShownContext] = useState({ scope, target, selection })
  if (shownContext.scope !== scope || shownContext.target !== target || shownContext.selection !== selection) {
    setShownContext({ scope, target, selection })
    if (shownContext.scope !== scope || shownContext.target !== target) {
      setProposal(null); setNotice(null); setExpired(false)
      if (!run) setScreen(intent ? 'tracking' : 'checking')
    }
    if (shownContext.selection !== selection) setRemoteSelection(null)
  }
  const wantedKey = `${scope}|${target}|${need?.toString() ?? ''}`
  const proposal = prepared?.intent.scope === scope && prepared.intent.destinationToken === target && (prepared.recoveryFrom ? intent !== null && prepared.recoveryFrom === gasRecoveryKey(intent) : need !== null && (rawValue(prepared.intent.requiredRaw) ?? 0n) >= need) ? prepared : null
  const displayScreen = screen === 'ready' && !proposal && !intent ? 'checking' : screen
  const held = unsettled.list(wallet)
  const closedKey = held.map((entry) => entry.originChainId).join(',')
  const pending = batches.list(wallet).filter((entry) => entry.destinationChainId === chainId)
  const activeDeposits = deposits.filter((deposit) => !settled.has(deposit.record.depositTxHash))
  const hasUnknown = intent?.legs.some((leg) => leg.state === 'unknown' || leg.state === 'sending') ?? false
  const foreignPending = held.some((entry) => entry.kind === 'deposit' && entry.destinationChainId === chainId) || pending.length > 0 || activeDeposits.length > 0
  const name = useMemo(() => naming(listing), [listing])
  useEffect(() => { mounted.current = true; generation.current++; return () => { mounted.current = false; preparation.current?.abort() } }, [])
  useEffect(() => {
    generation.current++; preparation.current?.abort(); attempted.current = ''; automaticAttempts.current = 0
  }, [scope, target, access])
  useEffect(() => {
    const update = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  const save = useCallback((next: FundingIntent | null, changedLeg?: string) => {
    // A delayed observation from another tab must not rewind any other leg. Storage is authoritative.
    const previous = readIntent(true)
    if (previous && (next?.id ?? intentRef.current?.id) !== previous.id) throw new FundingError('This transfer changed in another tab. Check it there before continuing.', 'funding_other_tab')
    if (next && previous?.id === next.id) next = { ...next, legs: next.legs.map((leg) => {
      const old = previous.legs.find((entry) => entry.id === leg.id)
      return old && (leg.id !== changedLeg || old.state === 'settled' && old.depositTxHash === leg.depositTxHash) ? old : leg
    }) }
    if (next === null) storage.drop(storageKey)
    else storage.put(storageKey, JSON.stringify(next))
    intentRef.current = next
    if (mounted.current) setIntent(next)
  }, [storage, storageKey, readIntent])
  const clearChangedUnsent = useCallback(async (expectedId: string, showBusy = false) => {
    if (!live || running.current) return
    try {
      await withFundingLock(wallet, async () => {
        if (!mounted.current || latest.current.scope !== scope || running.current) return
        const stored = readIntent(true)
        if (stored?.id !== expectedId) return
        if (!canDiscardFunding(stored, scope, { running: running.current,
          deposits: Math.max(deposits.length, journal?.list(chainId, wallet).length ?? 0),
          pending: batches.list(wallet).length, unsettled: unsettled.list(wallet).length })) return
        save(null); setProposal(null); setNotice(null); setExpired(false); setScreen('checking')
        attempted.current = ''; setPrepareRevision((value) => value + 1)
      }, () => {
        if (showBusy && mounted.current) setNotice({ copy: 'This transfer is being checked in another tab. Return there before choosing new funds.', code: 'funding_other_tab' })
      })
    } catch {
      if (mounted.current) setNotice({ copy: 'The previous transfer needs checking before new funds can be chosen.', code: 'funding_storage_unavailable' })
    }
  }, [live, wallet, scope, readIntent, deposits.length, journal, chainId, batches, unsettled, save])
  useEffect(() => {
    if (intent && intent.scope !== scope && fundingNeverSent(intent) && !run) void clearChangedUnsent(intent.id)
  }, [intent, scope, run, clearChangedUnsent])
  const observe = (legId: string, state: 'sent' | 'settled' | 'stopped', hash: string | null = null) => {
    void withFundingLock(wallet, async () => {
      const current = readIntent(true)
      const leg = current?.legs.find((entry) => entry.id === legId)
      if (!current || !leg || (state === 'settled' && leg.depositTxHash !== hash) || (state === 'stopped' && leg.state !== 'unknown' && leg.state !== 'sending')) return
      save({ ...current, legs: current.legs.map((entry) => entry.id === legId ? { ...entry, state, depositTxHash: hash ?? entry.depositTxHash } : entry) }, legId)
    }, () => { throw new Error('funding_storage_unavailable') }, true).catch(() => {
      if (mounted.current) setNotice({ copy: 'The transfer is still tracked, but its progress could not be saved in this browser.', code: 'funding_storage_unavailable' })
    })
  }
  const senderDeps = useRef({ live, services, journal, unsettled, batches })
  useEffect(() => { senderDeps.current = { live, services, journal, unsettled, batches } }, [live, services, journal, unsettled, batches])
  const sender = useCallback(() => {
    const { live, services, journal, unsettled, batches } = senderDeps.current
    if (!live || !services) return Promise.reject(new OriginStepError('quote_synthetic'))
    return senderRef.current ??= browserOriginWallet().then((own) => createOriginSender(own, {
      runtime: services.runtime, monoMs: services.clock.monoMs, journal, unsettled, batches,
    })).catch((error: unknown) => { senderRef.current = null; throw error })
  }, [])
  const transports = useMemo(() => live ? v2Transports(gate) : null, [live, gate])
  const read = useCallback(async (progress?: (index: number, answer: ChainBalancesResponse | null) => void) => {
    if (!transports || !routeServes(await transports.routeState('readV6'), 'chain-balances')) return null
    const answers = await Promise.all([balancesRequest(chainId), balanceChainsRequest(chainId)].map(async (tokens, index) => {
      const done = (answer: ChainBalancesResponse | null) => { progress?.(index, answer); return answer }
      if (!tokens.length) return null
      for (let attempt = 0; attempt < 3 && mounted.current; attempt++) {
        try {
          const reply = await readFundingBalanceGroup(wallet, tokens, () => readChainBalances(transports.read, transports.readRuntime, wallet, tokens))
          if (reply.kind === 'ok') return done(reply.body)
          if (reply.kind !== 'unavailable' || !['network', 'read_capacity_busy', 'upstream_unavailable'].includes(reply.reason) || attempt === 2) return done(null)
          await new Promise<void>((done) => setTimeout(done, (reply.retryAfterSeconds ?? 2 ** attempt) * 1_000))
        } catch { return done(null) }
      }
      return done(null)
    }))
    return mergeBalances(answers[0] ?? null, answers[1] ?? null)
  }, [transports, wallet, chainId])
  useEffect(() => {
    if (!live) return
    let active = true
    let busy = false
    let lastRead = 0
    const refresh = async () => {
      if (!active || document.hidden || busy || Date.now() - lastRead < 10_000) return
      lastRead = Date.now(); busy = true; setReading(true)
      const succeeded = [false, false]
      try {
        await read((index, answer) => {
          if (!active) return
          succeeded[index] = answer?.coverage === 'complete'
          if (answer) lastGroups.current[index] = answer
          setReadSnapshot({ data: mergeBalances(lastGroups.current[0], lastGroups.current[1]), complete: succeeded.every(Boolean) })
        })
      } catch { /* Keep the last observed balances; a failed read is not a zero balance. */ }
      finally {
        busy = false
        if (active) { setReading(false); setReadSnapshot((previous) => previous ?? { data: null, complete: false }) }
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 30_000)
    const wake = () => void refresh()
    window.addEventListener('focus', wake); document.addEventListener('visibilitychange', wake)
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', wake); document.removeEventListener('visibilitychange', wake) }
  }, [live, read, revision])
  useEffect(() => storage.subscribe(() => {
    if (running.current) return
    generation.current++
    const restored = readIntent()
    intentRef.current = restored; setIntent(restored); setProposal(null)
    setDeposits((previous) => (journal?.list(chainId, wallet) ?? []).map((record) => previous.find((d) => d.record.depositTxHash === record.depositTxHash) ?? {
      record, destinationToken: restored?.legs.some((leg) => leg.depositTxHash === record.depositTxHash) ? restored.destinationToken : null,
      originLabel: null, review: null, journaled: true,
    }))
    setRevision((n) => n + 1)
  }), [storage, readIntent, chainId, wallet, journal])

  const holdings = findHoldings(balances, chainId, closedKey, target)
  const quote = useCallback(async (request: CrosschainRequests['quote'], current: () => boolean, signal?: AbortSignal, priority: 'preview' | 'action' = 'preview'): Promise<Omit<PricedLeg, 'holding'>> => {
    if (!services) throw new FundingError(FUNDS_TEXT.locked, 'not_deployed')
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (!current() || !latest.current.ready || signal?.aborted) throw new FundingError('Your transfer is paused.', 'funding_cancelled')
      const result = await services.client.quote(request, { owner: wallet, signal, priority })
      if (!current()) throw new FundingError('Your transfer is paused.', 'funding_cancelled')
      if (result.ok) return { quote: result.data.quote, timing: result.timing }
      const failure = requestFailure(result.failure, attempt)
      if (failure.retryMs !== null && attempt < 3) { await fundingWait(services.wait(failure.retryMs), signal); continue }
      throw new FundingError(failure.copy || 'Could not update this transfer.', failure.code ?? result.failure.kind, failure.retryMs)
    }
    throw new FundingError('Could not update this transfer.', 'quote_unavailable')
  }, [services, wallet])
  const prepare = async () => {
    if (!live || !services || !ready || !targetAmount || need === null || need <= 0n || intentRef.current || foreignPending || running.current || preparation.current || !holdings.length || !visible || optional && !remoteOpened) return
    const controller = new AbortController()
    preparation.current = controller
    attempted.current = wantedKey
    const mine = ++generation.current
    const current = () => mounted.current && !controller.signal.aborted && generation.current === mine && latest.current.scope === scope
    const stopDeadline = services.deadlineTimer(() => {
      if (!current()) return
      retryAfter.current = services.clock.monoMs() + 10_000
      setNotice({ copy: 'Transfer costs are taking longer to load. Your wallet balances are still available.', code: 'funding_plan_timeout' })
      setScreen('unavailable'); controller.abort()
    }, 120_000)
    setScreen('quoting'); setNotice(null); setProposal(null); setExpired(false)
    try {
      const reply = await fundingWait(fundingOrigins(services, access, { destinationChainId: chainId, destinationToken: targetAmount.token }), controller.signal)
      if (!current()) return
      if (!reply.ok) { const failure = requestFailure(reply.failure, 1); throw new FundingError(failure.copy, failure.code ?? reply.failure.kind, failure.retryMs) }
      const list = reply.data.origins; setListing(list)
      const usable = holdings.filter((holding) => { const token = originToken(list, holding.chainId, holding.token); return token !== null && token.decimals === holding.decimals })
      if (!usable.length) throw new FundingError('No supported transfer is available for these tokens right now.', 'funding_routes_busy')
      const native = nativeOnDestination ?? (balances ? nativeOn(balances, chainId)?.toString() ?? null : null)
      if (targetAmount.token !== ZERO && native === null) throw new FundingError('Checking the ETH needed for network fees. Try again shortly.', 'funding_gas_unread')
      const gas = targetAmount.token !== ZERO && native !== null && BigInt(native) < REVIEW_GAS_RESERVE_WEI
      const quoted = await planFunding({ destinationChainId: chainId, destinationToken: targetAmount.token,
        required: need, holdings: usable, destinationGas: gas, monoMs: services.clock.monoMs, signal: controller.signal,
        quote: (request, options) => quote(request, current, options?.signal), cancelled: () => !current() })
      if (!current()) return
      if (!quoted) { setScreen('empty'); setNotice({ copy: 'No available transfer covers this amount and its costs. Choose a smaller amount or check again.', code: 'funding_insufficient' }); return }
      const next = freezeFunding({ id: crypto.randomUUID(), owner: wallet.toLowerCase(), destinationChainId: chainId,
        destinationToken: targetAmount.token, scope, requiredRaw: need.toString(),
        ...(budget?.paymentRaw ? { paymentRaw: budget.paymentRaw.toString() } : {}),
        createdAt: Math.max(...quoted.map((entry) => entry.quote.retrievedAt)) * 1_000 }, quoted)
      automaticAttempts.current = 0
      setProposal({ intent: next, quotes: quoted }); setScreen('ready')
    } catch (error) {
      if (!current()) return
      const failure = error instanceof FundingError ? error : new FundingError('Transfer costs are taking longer to load. Your wallet balances are still available.', error instanceof Error ? error.message : 'funding_unavailable')
      retryAfter.current = services.clock.monoMs() + Math.max(5_000, failure.retryMs ?? 10_000)
      setNotice({ copy: failure.copy, code: failure.code }); setScreen('unavailable')
    } finally {
      stopDeadline()
      if (preparation.current === controller) preparation.current = null
      if (mounted.current) setPrepareRevision((value) => value + 1)
    }
  }
  const prepareRef = useRef<(() => Promise<void>) | null>(null)
  useEffect(() => { prepareRef.current = prepare })
  const holdingsKey = holdings.map((holding) => `${holding.chainId}:${holding.token}:${holding.raw}`).join('|')
  useEffect(() => { attempted.current = ''; automaticAttempts.current = 0 }, [holdingsKey])
  useEffect(() => {
    if (!readDone || !ready || !need || intent || foreignPending || run || checking || !visible || !holdingsKey || proposal || preparation.current || optional && !remoteOpened) return
    const retry = attempted.current === wantedKey
    if (retry && screen !== 'unavailable') return
    const delay = Math.max(retry && automaticAttempts.current >= 2 ? 60_000 : FUNDS_TYPED_QUOTE_DEBOUNCE_MS, retryAfter.current - (services?.clock.monoMs() ?? 0))
    const timer = setTimeout(() => { if (retry) automaticAttempts.current++; void prepareRef.current?.() }, delay)
    return () => clearTimeout(timer)
  }, [wantedKey, readDone, ready, need, intent, foreignPending, run, checking, visible, holdingsKey, proposal, optional, remoteOpened, screen, prepareRevision, services])
  useEffect(() => {
    if (!visible) { generation.current++; preparation.current?.abort(); attempted.current = '' }
  }, [visible])
  useEffect(() => {
    if (!proposal || !services || run || intent) return
    const expires = Math.min(...proposal.quotes.map((leg) => quoteDeadlineMono(leg.quote, leg.timing))) - services.clock.monoMs() - SEND_MARGIN_MS
    return services.deadlineTimer(() => setExpired(true), Math.max(1_000, expires))
  }, [proposal, services, run, intent])

  const prepareGasRecovery = async () => {
    if (!live || !services || !ready || running.current) return
    preparation.current?.abort()
    const controller = new AbortController()
    preparation.current = controller
    const mine = ++generation.current
    const current = () => mounted.current && !controller.signal.aborted && generation.current === mine && latest.current.scope === scope
    setScreen('quoting'); setNotice(null); setProposal(null)
    try {
      const before = readIntent(true)
      if (!before?.gasRecovery?.reviewNeeded || before.scope !== scope || before.legs.some((leg) => leg.state === 'unknown' || leg.state === 'sending')) { setScreen('paused'); return }
      invalidateFundingBalances(wallet)
      const fresh = await fundingWait(read(), controller.signal)
      if (!fresh) throw new FundingError('Could not check your balances. Try again shortly.', 'funding_gas_retry')
      const reply = await fundingWait(fundingOrigins(services, access, { destinationChainId: chainId, destinationToken: before.destinationToken }), controller.signal)
      if (!current()) return
      if (!reply.ok) throw new FundingError('Could not check the available transfers. Try again shortly.', 'funding_gas_retry')
      setListing(reply.data.origins)
      const available = findHoldings(fresh, chainId, closedKey, before.destinationToken).filter((holding) => originToken(reply.data.origins, holding.chainId, holding.token)?.decimals === holding.decimals)
      const revised = await planGasRecovery(before, available, (request, options) => quote(request, current, options?.signal, 'action'), () => !current(), crypto.randomUUID(), { monoMs: services.clock.monoMs, signal: controller.signal })
      if (!current()) return
      if (!revised) throw new FundingError(before.gasRecovery.mode === 'token'
        ? 'No other network can cover this amount right now. Add ETH on Ethereum for its network fee, or wait for a lower fee.'
        : 'Keeping more ETH for the network fee leaves too little for this position. Add funds, choose a smaller position amount, or wait for a lower fee.', 'funding_gas_retry')
      setProposal(revised); setScreen('ready')
    } catch (error) {
      if (!current()) return
      setNotice({ copy: error instanceof FundingError ? error.copy : 'Could not update your transfer. Try again shortly.', code: 'funding_gas_retry' }); setScreen('paused')
    } finally {
      if (preparation.current === controller) preparation.current = null
    }
  }

  const execute = async () => {
    if (!services || !ready || running.current) return
    const recovery = proposal?.recoveryFrom ? proposal : null
    const chosen = recovery?.intent ?? intentRef.current ?? proposal?.intent
    if (!chosen || chosen.scope !== latest.current.scope || hasUnknown) return
    if (!intentRef.current && (need === null || need > BigInt(chosen.requiredRaw))) return
    running.current = true; setRun(true); setScreen('running'); setNotice(null)
    generation.current++
    const current = () => mounted.current && latest.current.scope === chosen.scope
    try {
      await withFundingLock(wallet, async () => {
        const stored = readIntent(true)
        if (stored && (stored.id !== chosen.id || stored.scope !== chosen.scope)) throw new FundingError('This transfer is being handled in another tab.', 'funding_other_tab')
        if (stored?.legs.some((leg) => leg.state === 'unknown' || leg.state === 'sending')) throw new FundingError('Check the open request in your wallet before continuing.', 'funding_unknown')
        if (recovery && (!stored || recovery.recoveryFrom !== gasRecoveryKey(stored))) throw new FundingError('Your transfer changed. Review the remaining amount again.', 'funding_gas_retry')
        if (stored?.gasRecovery?.reviewNeeded && !recovery) throw new FundingError(GAS_RECOVERY_COPY, 'funding_gas_retry')
        let accepted = recovery ? chosen : stored ?? chosen
        const remaining = outstandingLegs(accepted)
        if (!remaining.length) return
        invalidateFundingBalances(wallet)
        const fresh = await read()
        if (!current()) return
        const priced = new Map<string, Omit<PricedLeg, 'holding'>>()
        for (const leg of remaining) {
          const candidate = originCandidate(leg.originChainId)
          const heldNow = fresh && candidate ? holdingsFromChainBalances(fresh, candidate)?.holdings.find((holding) => holding.token === leg.originToken) : null
          const native = fresh ? nativeOn(fresh, leg.originChainId) : null
          if (!heldNow || fundingSpendable(heldNow, leg) < BigInt(leg.maxInputRaw) || native === null || native <= 0n) throw new FundingError(`Your balance on ${originName(leg.originChainId)} changed. Review your transfer again.`, 'funding_balance_changed')
          const remembered = leg.state === 'ready' && proposal?.intent.id === accepted.id ? proposal.quotes.find((entry) => entry.holding.chainId === leg.originChainId && entry.holding.token === leg.originToken) : null
          const checked = remembered && quoteDeadlineMono(remembered.quote, remembered.timing) > services.clock.monoMs() + SEND_MARGIN_MS + 15_000 ? remembered : await quote(requestForLeg(accepted, leg), current, undefined, 'action')
          if (!respectsLeg(accepted, leg, checked.quote)) throw new FundingError('Transfer costs changed. Your spending limit is unchanged. Review before continuing.', 'funding_quote_changed')
          const fee = checked.quote.candidates.find((candidate) => candidate.provider === checked.quote.decision)?.originGas?.feeRaw
          if (fee != null && native < BigInt(fee) + (leg.originToken === ZERO ? BigInt(leg.maxInputRaw) : 0n)) {
            // A revised proposal is not accepted until every source passes preflight.
            const retry = !recovery && withGasFailure(accepted, leg.id, 'funding_gas_short', false)
            if (retry) save(retry)
            throw new FundingError(retry ? GAS_RECOVERY_COPY : `There is not enough ETH on ${originName(leg.originChainId)} for the network fee.`, retry ? 'funding_gas_retry' : 'funding_gas_short')
          }
          priced.set(leg.id, checked)
        }
        if (!current()) return
        save(accepted)
        const own = await sender()
        for (const leg of remaining) {
          if (!current() || !latest.current.ready) break
          if (unsettled.list(wallet).some((entry) => entry.originChainId === leg.originChainId) || batches.list(wallet).some((entry) => entry.originChainId === leg.originChainId)) throw new FundingError('Finish the open request in your wallet before continuing.', 'funding_wallet_pending')
          let checked = priced.get(leg.id)!
          if (quoteDeadlineMono(checked.quote, checked.timing) <= services.clock.monoMs() + SEND_MARGIN_MS) {
            checked = await quote(requestForLeg(accepted, leg), current, undefined, 'action')
            if (!respectsLeg(accepted, leg, checked.quote)) throw new FundingError('Transfer costs changed. Received funds stay in your wallet. Review the remaining transfer.', 'funding_quote_changed')
          }
          if (!current()) break
          accepted = { ...accepted, legs: accepted.legs.map((entry) => entry.id === leg.id ? { ...entry, state: 'sending' } : entry) }; save(accepted, leg.id)
          let depositOffered = false
          const result = await runDeposit({ runtime: services.runtime, owner: wallet, sender: own, switchToOrigin,
            walletChainId: () => latest.current.walletChainId, monoMs: services.clock.monoMs, wait: services.wait,
            aborted: () => !current(), receiptPollMs: FUNDS_RECEIPT_POLL_MS }, { ...checked, source: services.source },
            (value) => { if (value.stage === 'deposit_wallet' || value.stage === 'batch_wallet') depositOffered = true; if (mounted.current) setStage({ origin: leg.originChainId, value }) })
          if (result.kind === 'sent' && result.sent.record) {
            const record = result.sent.record
            if (mounted.current) setDeposits((previous) => [{ record, destinationToken: accepted.destinationToken, originLabel: leg.symbol, review: result.review, journaled: result.sent.journaled }, ...previous.filter((entry) => entry.record.depositTxHash !== record.depositTxHash)])
            accepted = { ...accepted, legs: accepted.legs.map((entry) => entry.id === leg.id ? { ...entry, state: 'sent', depositTxHash: record.depositTxHash } : entry) }; save(accepted, leg.id)
          } else {
            const unknown = result.kind === 'sent' || (result.kind === 'aborted' && depositOffered) || (result.kind === 'error' && result.offered)
            accepted = { ...accepted, legs: accepted.legs.map((entry) => entry.id === leg.id ? { ...entry, state: unknown ? 'unknown' : 'stopped', depositTxHash: result.kind === 'sent' ? result.sent.hash : entry.depositTxHash } : entry) }
            const retry = result.kind === 'error' ? withGasFailure(accepted, leg.id, result.code, result.offered) : null
            if (retry) accepted = retry
            save(accepted, leg.id)
            const code = result.kind === 'error' ? result.code : result.kind === 'switch' ? `switch_${result.outcome}` : result.kind
            throw new FundingError(retry ? GAS_RECOVERY_COPY : unknown ? 'Check the open request in your wallet. We will not send it again while its result is unknown.' : result.kind === 'expired' ? 'Your quote expired while the wallet was open. Continue to refresh it within the same spending limit.' : result.kind === 'error' ? senderCopy(result.code, { origin: originName(leg.originChainId), native: 'ETH' }) : 'Transfer paused. Received funds stay in your wallet.', retry ? 'funding_gas_retry' : code)
          }
        }
      }, () => { throw new FundingError('This transfer is being handled in another tab. Return there to continue.', 'funding_other_tab') })
      if (mounted.current) setScreen('tracking')
    } catch (error) {
      if (mounted.current) {
        if (recovery && intentRef.current?.gasRecovery?.reviewNeeded) setProposal(null)
        const failure = error instanceof FundingError ? error : error instanceof Error && error.message === 'funding_storage_unavailable'
          ? new FundingError('This browser could not save your transfer progress. No further transfer will be sent. Keep this page open to follow anything already sent.', 'funding_storage_unavailable')
          : new FundingError(error instanceof OriginStepError ? senderCopy(error.code, { origin: 'this network', native: 'ETH' }) : 'Your transfer is paused. No further transfer will be sent.', error instanceof OriginStepError ? error.code : 'funding_paused')
        setNotice({ copy: failure.copy, code: failure.code }); setScreen('paused')
      }
    } finally { running.current = false; if (mounted.current) { setRun(false); setStage(null); setRevision((n) => n + 1) } }
  }
  const resolveUnknown = async (origin: number) => {
    if (running.current) return
    setNotice(null)
    try {
      await withFundingLock(wallet, async () => {
        const before = readIntent(true)
        const heldLeg = before?.legs.find((leg) => leg.originChainId === origin)
        if (heldLeg && (heldLeg.state !== 'unknown' || heldLeg.depositTxHash !== null)) throw new FundingError('This transfer is already tracked. It will not be sent again.', 'funding_unknown')
        if (latest.current.walletChainId !== origin && await switchToOrigin(origin) !== 'switched') return
        const answer = await (await sender()).forgetUnsettled(origin)
        if (answer !== 'forgotten') { setNotice({ copy: 'This transfer may still be pending. Check your wallet activity; it will not be sent again.', code: 'funding_unknown' }); return }
        const current = readIntent(true)
        const recovered = current?.legs.find((leg) => leg.originChainId === origin && leg.state === 'unknown' && leg.depositTxHash === null)
        if (current && recovered) save({ ...current, legs: current.legs.map((leg) => leg.id === recovered.id ? { ...leg, state: 'stopped' } : leg) }, recovered.id)
        setRevision((n) => n + 1)
      }, () => { throw new Error('funding_other_tab') })
    } catch { setNotice({ copy: 'Could not confirm that the wallet request was cancelled. Nothing will be sent again.', code: 'funding_unknown' }) }
  }
  const useRemotePayment = async () => {
    if (!onRemoteUse || !services?.readBalances || running.current) return
    running.current = true; setRun(true); setNotice(null)
    try {
      await withFundingLock(wallet, async () => {
        const accepted = readIntent(true)
        const current = () => mounted.current && latest.current.scope === scope && latest.current.ready
        if (!current() || !accepted?.paymentRaw || accepted.scope !== scope || !accepted.legs.every((leg) => leg.state === 'settled') || unsettled.list(wallet).length || batches.list(wallet).length) return
        const answer = await services.readBalances!(chainId, [...new Set([accepted.destinationToken, ZERO])])
        if (!current()) return
        const restored = readIntent(true)
        if (restored?.id !== accepted.id || restored.scope !== scope || !restored.legs.every((leg) => leg.state === 'settled')) return
        const have = answer.kind === 'ok' ? rawValue(answer.snapshot.balances.find((entry) => entry.token === accepted.destinationToken)?.raw ?? null) : null
        const gas = answer.kind === 'ok' ? rawValue(answer.snapshot.balances.find((entry) => entry.token === ZERO)?.raw ?? null) : null
        const payment = BigInt(accepted.paymentRaw)
        if (have === null || gas === null || gas < REVIEW_GAS_RESERVE_WEI || have < payment + (accepted.destinationToken === ZERO ? REVIEW_GAS_RESERVE_WEI : 0n)) throw new FundingError('Your funds are still being checked. Try again when your wallet balance updates.', 'funding_balance_changed')
        onRemoteUse(accepted.destinationToken, accepted.paymentRaw)
        onArrived?.()
      }, () => { throw new FundingError('This transfer is being handled in another tab. Return there to continue.', 'funding_other_tab') })
    } catch (error) {
      if (mounted.current) setNotice({ copy: error instanceof FundingError ? error.copy : 'Could not check the received funds. Your transfer is still tracked.', code: error instanceof FundingError ? error.code : 'funding_balance_unread' })
    } finally { running.current = false; if (mounted.current) setRun(false) }
  }

  const changed = intent !== null && intent.scope !== scope
  const previousUnsent = changed && intent !== null && fundingNeverSent(intent)
  const proposed = proposal?.recoveryFrom ? proposal.intent : previousUnsent ? null : intent ?? proposal?.intent
  const selected = proposed?.legs ?? []
  const networks = [...new Set(selected.map((leg) => originName(leg.originChainId)))]
  const available = [...new Set(holdings.map((holding) => originName(holding.chainId)))]
  const observedNetworks = CANDIDATE_ORIGINS.filter((profile) => {
    const candidate = originCandidate(profile.chainId)
    return balances && candidate && candidate.chainId !== chainId && (holdingsFromChainBalances(balances, candidate)?.holdings.some((holding) => holding.raw > 0n) ?? false)
  }).map((profile) => originName(profile.chainId))
  const names = (values: readonly string[]) => values.length > 1 ? `${values.slice(0, -1).join(', ')} and ${values.at(-1)}` : values[0] ?? ''
  const receiptAmount = proposed ? shortAmountText(proposed.requiredRaw, proposed.destinationToken, targetAmount ?? name.book(chainId, proposed.destinationToken), 'up') : null
  const resume = intent !== null && outstandingLegs(intent).length > 0 && !hasUnknown && !changed
  const gasReview = intent?.gasRecovery?.reviewNeeded === true
  const needsReview = notice?.code === 'funding_quote_changed' || notice?.code === 'funding_balance_changed' || gasReview && !proposal?.recoveryFrom
  const unknownOrigin = intent?.legs.find((leg) => leg.state === 'unknown')?.originChainId ?? held.find((entry) => entry.state === 'open')?.originChainId
  if (!lacks.length && !gasOnly && !budget && !intent && !deposits.length && !pending.length && !held.length) {
    if (!discreet || !readDone || !observedNetworks.length) return null
    return <div className="dm-funds-discovery" data-funds-line="" data-funds-sources=""><strong>Use funds from {names(observedNetworks)}</strong><span>Enter an amount. Domino will check the transfer and prepare the tokens for this position.</span></div>
  }
  if (optional && !remoteOpened && !intent && !deposits.length && !pending.length && !held.length) {
    if (!observedNetworks.length) return null
    return <button type="button" className="dm-funds-line dm-funds-remote" data-funds-sources="" onClick={() => setRemoteSelection(selection)}><span className="dm-funds-line-text">Funds available on {names(observedNetworks)}</span><span className="dm-funds-line-action">Use another network</span></button>
  }
  return <section className="dm-funds-offer dm-funding" data-funds-offer="" data-funds-mode={gate.mode} data-funds-services={services?.source ?? 'none'} data-funds-token={target} data-funding-state={displayScreen} aria-label="Fund this position">
    <div className="dm-funds-heading"><span className="dm-funds-icon" aria-hidden="true">↗</span><div>
      <h4 data-funds-title="">{run ? 'Getting your funds ready' : previousUnsent ? 'Choose funds for this position' : proposal?.recoveryFrom ? 'Your updated transfer' : intent || foreignPending ? 'Your transfer' : proposal ? `Use your funds on ${names(networks)}` : observedNetworks.length ? `Funds available on ${names(observedNetworks)}` : 'Find funds for this position'}</h4>
      <p data-funds-lack={targetLack && !budget ? 'short' : undefined} data-funds-lack-raw={!budget ? targetLack?.shortRaw?.toString() : undefined}>{!live ? FUNDS_TEXT.locked : previousUnsent ? 'Checking the previous request before choosing funds for this position.' : changed ? 'Your position changed. Transfers already sent continue to your wallet.' : hasUnknown ? 'Waiting for a clear answer from your wallet.' : intent || foreignPending ? 'Funds arrive in your wallet. Your position amount stays the same.' : proposal ? `Move ${receiptAmount ?? 'funds'} to ${destination.name} for this position.` : !readDone || screen === 'quoting' ? 'Finding the funds for this position…' : holdings.length ? `You have funds on ${names(available)}.` : 'Checking the networks supported by Domino.'}</p>
    </div></div>
    <div className="dm-funds-body" data-funds-body="">
      {!live && <p data-funds-locked="">{FUNDS_TEXT.locked}</p>}
      {live && !readDone && <p role="status" data-funds-checking="" className="dm-funds-status">Checking your wallet…</p>}
      {live && screen === 'quoting' && !run && <p role="status" className="dm-funds-status" data-funds-quote-loading="">Checking transfer costs…</p>}
      {notice && <p role="status" className="dm-funding-notice" data-funds-run-notice="" data-error-code={notice.code}>{notice.copy}</p>}
      {gasReview && !previousUnsent && !notice && !proposal?.recoveryFrom && screen !== 'quoting' && <p className="dm-funding-notice" data-funds-gas-recovery="">{GAS_RECOVERY_COPY}</p>}
      {proposal?.recoveryFrom && <p className="dm-hint" data-funds-gas-recovery="">{proposal.intent.legs.some((leg) => leg.reserveRaw) ? 'Keep 0.006 ETH on Ethereum for network fees. ' : 'Use another available network. '}Your position amount stays the same. Confirm the amounts below before continuing.</p>}
      {live && readDone && !proposal && !intent && !foreignPending && screen !== 'quoting' && !notice && <p className="dm-hint" data-funds-nothing="">{holdings.length === 0 ? !readSnapshot?.complete ? 'Some wallet balances could not be checked yet. We will try again automatically.' : observedNetworks.length ? 'These networks need ETH for the transfer fee. Add a little ETH there to use these tokens.' : 'No available funds found on the supported networks. Add funds or choose a smaller amount.' : need === null ? 'Enter an amount. Domino will check how to bring your funds here.' : !ready ? 'Sign in to prepare your transfer. This does not move funds.' : 'Checking a transfer for this amount.'}</p>}
      {proposed && <div className="dm-funding-summary" data-funds-quote="" data-funding-sources={selected.length}>
        {selected.map((leg) => <div className="dm-funding-leg" key={leg.id} data-funds-network={leg.originChainId} data-funding-leg-state={leg.state}>
          <span>{originName(leg.originChainId)}</span><strong>{shortAmountText(leg.maxInputRaw, leg.originToken, leg, 'up')}</strong>
          <span className="dm-funding-leg-status">{leg.state === 'sent' ? 'On the way' : leg.state === 'settled' ? 'Settled' : leg.state === 'unknown' ? 'Check wallet' : leg.state === 'sending' ? 'Confirm in wallet' : 'Maximum to send'}</span>
        </div>)}
      </div>}
      {stage && <p role="status" className="dm-funds-status" data-funds-run-status={stage.value.stage}>{stage.value.stage === 'switching' ? `Your wallet needs ${originName(stage.origin)} for this transfer.` : stage.value.stage === 'batch_wallet' ? 'Confirm approval and transfer together in your wallet.' : stage.value.stage === 'approval_wallet' ? 'Approve the token in your wallet.' : stage.value.stage === 'deposit_wallet' ? 'Confirm the transfer in your wallet.' : `Preparing your transfer from ${originName(stage.origin)}…`}</p>}
      {live && !run && ready && !changed && !hasUnknown && !needsReview && ((!intent && proposal) || resume) && <Button variant="accent" className="dm-funds-go" data-funds-deposit-button="" onClick={() => void (expired && !intent ? prepare() : execute())}>{proposal?.recoveryFrom ? 'Use this updated transfer' : resume ? 'Continue remaining transfer' : expired ? 'Update transfer' : 'Use these funds'}</Button>}
      {live && !run && ready && !changed && !hasUnknown && gasReview && !proposal?.recoveryFrom && screen !== 'quoting' && <Button variant="accent" data-funds-gas-review="" onClick={() => void prepareGasRecovery()}>Review transfer</Button>}
      {live && !ready && !run && (lacks.length > 0 || gasOnly || budget !== null) && !hasUnknown && <Button variant="accent" data-funds-signin="" onClick={openWalletDialog}>Continue with wallet</Button>}
      {optional && remoteOpened && !intent && !foreignPending && !run && <Button variant="ghost" size="sm" data-funds-close="" onClick={() => { generation.current++; preparation.current?.abort(); setRemoteSelection(null); setProposal(null); setNotice(null); setExpired(false); attempted.current = ''; setScreen('checking') }}>Back to funding options</Button>}
      {onRemoteUse && intent?.paymentRaw && !changed && !run && ready && !activeDeposits.length && !pending.length && !held.length && intent.legs.every((leg) => leg.state === 'settled') && <Button variant="accent" data-funds-remote-use="" onClick={() => void useRemotePayment()}>Use these funds for this position</Button>}
      {live && !run && unknownOrigin !== undefined && <Button variant="outline" size="sm" data-funds-run-forget="" onClick={() => void resolveUnknown(unknownOrigin)}>I cancelled the request in my wallet</Button>}
      {live && !run && ready && !intent && !foreignPending && !proposal && !needsReview && readDone && (screen === 'unavailable' || screen === 'paused' || notice?.code === 'funding_insufficient' || !reading && !readSnapshot?.complete) && <Button variant="outline" size="sm" data-funds-renew="" onClick={() => { attempted.current = ''; automaticAttempts.current = 0; setNotice(null); setRevision((n) => n + 1); setPrepareRevision((n) => n + 1) }}>Check again</Button>}
      {live && !run && ready && !intent && needsReview && <Button variant="outline" size="sm" data-funding-review="" onClick={() => void prepare()}>Review transfer</Button>}
      {proposal && <details className="dm-details dm-funds-details" data-funds-details=""><summary>Transfer details</summary><div className="dm-funding-details">
        <p>Only the amounts above can leave your wallet. Network fees are separate. Different networks may need separate confirmations.</p>
        {proposal.intent.paymentRaw && <p>You will review the token conversion before creating your position.</p>}
        {proposal.quotes.map((entry) => { const view = presentQuote(entry.quote, name); const winner = entry.quote.candidates.find((candidate) => candidate.provider === entry.quote.decision)
          return <div key={`${entry.holding.chainId}:${entry.holding.token}`} data-funds-candidate={entry.quote.decision ?? 'none'}>
            <strong>{originName(entry.holding.chainId)}</strong>
            <ul data-funds-lines="" data-funds-receive="" data-funds-eta="" data-funds-destination-gas={entry.quote.request.destinationGas ? 'included' : undefined}>{view.winner?.lines?.map((line) => <li key={line}>{line}</li>)}</ul>
            <p>Network fee: {winner ? originGasDetail(entry.quote, winner, name) : 'not reported'}</p>
          </div>
        })}
      </div></details>}
      {services && (deposits.length > 0 || pending.length > 0) && <div className="dm-funding-tracking" data-funds-deposits="">
        {!run && pending.map((entry) => <PendingDeposit key={entry.batchId} entry={entry} services={services} sender={sender} name={name}
          onSent={(sent) => { if (sent.record) { const record = sent.record; const current = intentRef.current; const leg = current?.legs.find((leg) => leg.originChainId === entry.originChainId && (leg.state === 'unknown' || leg.state === 'sending')); if (leg) observe(leg.id, 'sent', record.depositTxHash); setDeposits((previous) => [{ record, destinationToken: current?.destinationToken ?? null, originLabel: null, review: null, journaled: sent.journaled }, ...previous.filter((d) => d.record.depositTxHash !== record.depositTxHash)]) }; setRevision((n) => n + 1) }}
          onOutcome={(state) => { if (state === 'unknown') return; const leg = intentRef.current?.legs.find((leg) => leg.originChainId === entry.originChainId && (leg.state === 'unknown' || leg.state === 'sending')); if (leg) observe(leg.id, 'stopped'); batches.drop(wallet, entry.batchId); setRevision((n) => n + 1) }}
          onRemove={() => { batches.drop(wallet, entry.batchId); setRevision((n) => n + 1) }} />)}
        {deposits.map((deposit) => <DepositStatus key={`${deposit.record.originChainId}:${deposit.record.depositTxHash}`} deposit={deposit} services={services} owner={wallet} journal={journal} name={name}
          walletChainId={walletChainId} access={access} sender={sender} poolTokens={changed ? [] : poolTokens} keep={changed ? null : keep} takes={takes} onUse={changed ? () => onArrived?.() : onUse} onUseToken={changed ? undefined : onUseToken}
          onArrived={() => { invalidateFundingBalances(wallet); onArrived?.(); setRevision((n) => n + 1) }}
          onSettled={() => { setSettled((previous) => new Set(previous).add(deposit.record.depositTxHash)); const leg = intentRef.current?.legs.find((leg) => leg.depositTxHash === deposit.record.depositTxHash); if (leg) observe(leg.id, 'settled', deposit.record.depositTxHash); setRevision((n) => n + 1) }}
          onRemove={() => { journal?.drop(wallet, deposit.record); setDeposits((previous) => previous.filter((entry) => entry.record.depositTxHash !== deposit.record.depositTxHash)) }} />)}
      </div>}
      {intent && !run && !hasUnknown && (!gasReview || changed) && !activeDeposits.length && !pending.length && !held.length && (changed || needsReview || intent.legs.every((leg) => leg.state === 'settled') && (lacks.length > 0 || gasOnly)) && <Button variant="outline" size="sm" data-funding-review="" onClick={() => {
        if (previousUnsent) { void clearChangedUnsent(intent.id, true); return }
        void withFundingLock(wallet, async () => {
          const stored = readIntent(true)
          if (running.current || latest.current.scope !== scope || stored?.id !== intent.id || stored.legs.some((leg) => !['ready', 'stopped', 'settled'].includes(leg.state)) || unsettled.list(wallet).length || batches.list(wallet).length || journal?.list(chainId, wallet).some((record) => !settled.has(record.depositTxHash))) return
          save(null); setProposal(null); setNotice(null); attempted.current = ''; setRevision((n) => n + 1)
        }, () => { throw new Error('busy') }).catch(() => setNotice({ copy: 'This transfer is being handled in another tab. Return there to continue.', code: 'funding_other_tab' }))
      }}>{previousUnsent ? 'Check this position' : 'Review remaining amount'}</Button>}
    </div>
  </section>
}
