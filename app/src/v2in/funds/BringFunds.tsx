import type { ChainBalancesResponse } from 'api-contracts/read-v6/types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AmountField } from '../../components/create/fields'
import { Button, Card, KeyValue, KeyValueList, Select, Skeleton } from '../../components/ui'
import {
  browserDepositJournal,
  browserOriginWallet,
  browserUnsettledStore,
  createOriginSender,
  OriginStepError,
  quoteKeyOf,
  type OriginSender,
  type UnsettledOffer,
  type UnsettledStore,
} from '../../finance/v2/crosschain'
import { CANDIDATE_ORIGINS, readHoldingsReport, type Holding, type HoldingsReport } from '../../finance/v2/holdings'
import { openWalletDialog } from '../../finance/signedOut'
import { maxSpend } from '../../lib/create/reviewPlan'
import { formatUsd } from '../../lib/format/usd'
import { formatUnits } from '../../lib/read/decimal'
import { v2Chain } from '../../v2/chains'
import { cleanSymbol, formatUnitsExact, knownDecimals } from '../../v2/crosschain/amounts'
import { quoteDeadlineMono, type Timing } from '../../v2/crosschain/client'
import { ADD_ORIGIN, FAILURE_COPY, fill, NO_ROUTE } from '../../v2/crosschain/copy'
import { destinationChoices, naming, presentOrigins } from '../../v2/crosschain/present'
import { SEND_MARGIN_MS } from '../../v2/crosschain/steps'
import type { CrosschainRequests, OriginsList, QuotePlan } from '../../v2/crosschain/types'
import type { V2Gate } from '../../v2/gate'
import { readChainBalances } from '../../v2/read/v6'
import { routeServes } from '../../v2/routes'
import type { V2ChainId } from '../../v2/types'
import { switchToChain, switchToOrigin, v2SwitchNotice, type ChainSwitchOutcome } from '../../wallet/port'
import { FUNDS_AUTO_REQUOTES, FUNDS_DEFAULT_SLIPPAGE_BPS, FUNDS_DESTINATION_GAS_DEFAULT_ON, FUNDS_RECEIPT_POLL_MS } from './constants'
import { FUNDS_TEXT, senderCopy } from './copy'
import { DepositStatus, type TrackedDeposit } from './DepositStatus'
import { runDeposit, type FlowOutcome, type FlowStage } from './flow'
import {
  amountRawOf,
  convertUnits,
  holdingFor,
  offerDestinationGas,
  originToken,
  quoteRequestOf,
  requestFailure,
  slippageBpsOf,
  slippageText,
  type Lack,
  type RequestFailure,
  withMargin,
  balancesRequest,
  holdingsFromChainBalances,
  totalUsdOn,
} from './model'
import { IDLE_STEPS, QuoteView, type StepsView } from './QuoteView'
import type { FundsServices } from './services'
import { v2Transports } from '../transports'

const ZERO = '0x0000000000000000000000000000000000000000'
const lower = (value: string) => value.toLowerCase()

type OriginsState = { state: 'loading' } | { state: 'ok'; list: OriginsList } | { state: 'failed'; failure: RequestFailure }

/**
 * Changed on purpose 2026-10-05 (the owner, testing the offer: "it keeps asking me to sign in ... the networks don't show
 * ... very hard to understand; it has to happen behind the scenes, whoever uses Domino has no experience"): a deposit comes
 * from Domino's own networks only, Robinhood Chain, Base and Arbitrum One, the ones the page keeps the session across
 * (session/machine.ts keptChains), never the destination. Ethereum and OP Mainnet closed the session at each visit.
 */
const SOURCE_CHAINS: readonly V2ChainId[] = [4663, 8453, 42161]

/** Where the one click "Bring it from {network}" stands: done for the person, said in one line. */
type Pick =
  | { chainId: V2ChainId; stage: 'signing' | 'switching' | 'reading' | 'quoting' }
  | { chainId: V2ChainId; stage: 'empty'; copy: string }
  | { chainId: V2ChainId; stage: 'failed'; copy: string; code: string }


type QuoteState =
  | { state: 'idle' }
  | { state: 'loading'; key: string; note: string | null }
  | { state: 'ok'; key: string; quote: QuotePlan; timing: Timing; source: FundsServices['source']; request: CrosschainRequests['quote']; note: string | null }
  | { state: 'failed'; key: string; failure: RequestFailure }
  | { state: 'expired'; key: string }

function stepsAfter(previous: StepsView, stage: FlowStage): StepsView {
  switch (stage.stage) {
    case 'switching':
    case 'reviewing':
      return { ...previous, stage }
    case 'approval_wallet':
      return { ...previous, stage, approval: 'wallet' }
    case 'approval_sent':
      return { ...previous, stage, approval: 'sent' }
    case 'approval_done':
      return { ...previous, stage, approval: stage.receipt }
    case 'approval_skipped':
      return { ...previous, stage, approval: 'skipped' }
    case 'deposit_wallet':
      return { ...previous, stage, deposit: 'wallet' }
  }
}

/** The page's one store of steps held unsettled (finance/v2/crosschain.ts): kept across offers and chains. */
let pageStore: UnsettledStore | null = null
const pageUnsettled = (): UnsettledStore => (pageStore ??= browserUnsettledStore())

const forgetSenderOn = (ref: { current: Promise<OriginSender> | null }, error: unknown) => {
  if (error instanceof OriginStepError && error.code === 'wallet_identity_changed') ref.current = null
}

/**
 * A step handed to the wallet on an origin with no usable answer (F1): what is known, and the one way out V1 offers
 * ("I rejected it in my wallet", heard only while the chain shows its nonce still free). One whose nonce the chain has
 * taken is a deposit that may have gone: the person checks the wallet's activity, and may remove the card.
 */
function HeldOffer({
  offer,
  origin,
  native,
  notice,
  busy,
  onForget,
  onRemove,
}: {
  offer: UnsettledOffer
  origin: string
  native: string
  notice: { copy: string; code: string | null } | null
  busy: boolean
  onForget: () => void
  onRemove: () => void
}) {
  return (
    <Card level={2} className="grid gap-2 p-4" data-funds-held={offer.originChainId} data-funds-held-state={offer.state} data-funds-held-kind={offer.kind}>
      <span className="dm-subtitle">{FUNDS_TEXT.heldTitle(offer.kind, origin)}</span>
      <p role="status" className="text-body" data-funds-held-text="">
        {offer.state === 'open' ? FUNDS_TEXT.heldOpen(offer.kind, origin) : senderCopy('deposit_may_have_gone', { origin, native })}
      </p>
      {notice && notice.copy && (
        <p role="alert" className={notice.code ? 'dm-error' : 'text-body'} data-error-code={notice.code ?? undefined} data-funds-held-notice="">
          {notice.copy}
        </p>
      )}
      <details className="dm-details">
        <summary>{FUNDS_TEXT.details}</summary>
        <KeyValueList>
          <KeyValue label={`Nonce on ${origin}`} mono>
            {offer.nonce}
          </KeyValue>
          <KeyValue label="Handed to your wallet">{new Date(offer.at * 1000).toLocaleString()}</KeyValue>
        </KeyValueList>
      </details>
      {offer.state === 'open' ? (
        <Button variant="outline" size="sm" className="justify-self-start" disabled={busy} onClick={onForget} data-funds-held-forget="">
          {FUNDS_TEXT.rejectedInWallet}
        </Button>
      ) : (
        <Button variant="ghost" size="sm" className="justify-self-start" onClick={onRemove} data-funds-held-remove="">
          {FUNDS_TEXT.remove}
        </Button>
      )}
    </Card>
  )
}

/**
 * "Bring {token} from {network}" (spec F7 §3, §8.2 S2), inline in New position's amount step: a deposit from another
 * network to the person's OWN wallet on the position's chain, through Relay or Across, quoted by Domino's crosschain-v1
 * service; then the SAME position continues with what arrived. One compact card under the amounts,
 * shown only while the position can't be funded on its chain at all, counting the one-token swap (decided [owner,
 * 2026-10-02 evening]; ./model.ts lackingTokens), or while a deposit it started is under way. The app never calls Relay
 * or Across.
 *
 * Holdings on the connected origin are read automatically; other origins still require explicit wallet permission
 * (./Holdings.tsx over finance/v2/holdings.ts; no qualified multi-chain balance route exists). Nothing is guessed, no public RPC is read, and
 * no test data stands in for a reading (the owner, 2026-10-02 night: real data only; a function that cannot run yet
 * says so).
 * Changed on purpose 2026-10-06 (rugged97's delta of 5 Oct, item 3: read-v6's chain-balances): Domino's service reads the
 * balances on the other networks, shown under each network's button before anything is chosen; the one click then asks
 * the quote with the wallet where it is, and the wallet moves to that network only when the person presses the button
 * that sends (./flow.ts runDeposit). Without the service's answer, the wallet's own read on that network, as before.
 *
 * `services` (./services.ts): the crosschain-v1 client under a `live` gate (the crosschain route's own capabilities say it
 * serves), or null under `preview` (the route off or not deployed yet). Without it the card is LOCKED and immediately says
 * S2's own plain sentence (decided [owner, 2026-10-02 evening]: "Bringing funds from another network isn't available
 * yet.", FUNDS_TEXT.locked, in place of the gate's sentence about Domino's contracts); no origins are asked, no quote
 * form, no deposit. With it, on a `live` gate, the whole offer: the origins listing, the quote, and the closed sender
 * (finance/v2/crosschain.ts), which does every read and send on the origin, two transactions and no batch, never twice;
 * Bring then prefills the form from the holding where the listing bridges it.
 */
export function BringFunds({
  gate,
  services,
  chainId,
  wallet,
  access,
  walletChainId,
  lacks,
  nativeOnDestination,
  poolTokens,
  onUse,
  onUseToken,
  onArrived,
}: {
  gate: Exclude<V2Gate, { mode: 'off' }>
  /** The crosschain-v1 client and clock, or null while the service is not wired: the card is then locked. */
  services: FundsServices | null
  /** The position's chain: where the deposit arrives. */
  chainId: V2ChainId
  /** The connected wallet (lowercase): the sender's owner on a live chain. */
  wallet: string
  /** Read-only session state; changes invalidate the private listing and quote. */
  access: string
  /** The chain the connected wallet is on. */
  walletChainId: number | null
  lacks: readonly Lack[]
  /** The wallet's ETH on the position's chain from the amount step's own reading, raw; null when it read none. */
  nativeOnDestination: string | null
  /** The position's two tokens (lowercase), in pool order. */
  poolTokens: readonly string[]
  /** The same position continues with `text` of the token on `side` (the amount step's own handlers). */
  onUse: (side: 0 | 1, text: string) => void
  /** V2 accepts an exact delivered token as the new deposit, including one outside the pool. */
  onUseToken?: (token: string, text: string) => void
  /** Added 2026-10-05: a deposit arrived and the wallet is back on the position's chain; its balances are read again. */
  onArrived?: () => void
}) {
  const chain = v2Chain(chainId)
  // The whole offer runs only on a live chain with the service to ask; the closed sender is never built otherwise.
  const live = gate.mode === 'live' && services !== null
  const sessionReady = access.startsWith('ready:')
  // Decided [owner, 2026-10-02 evening]: S2's own sentence, not the gate's about Domino's contracts (S2 uses none).
  const locked = services === null ? FUNDS_TEXT.locked : null
  // Discovery starts with the insufficient-balance offer; it never waits for a disclosure click.
  const opened = lacks.length > 0

  // The token to bring: the first the position lacks (Changed on purpose 2026-10-05: no choice of token to make), kept
  // while a quote or a deposit is about it.
  const [kept, setKept] = useState<string | null>(null)
  const target = lacks[0]?.token ?? kept
  const lack = lacks.find((l) => l.token === target) ?? null
  const choice = useMemo(() => destinationChoices().find((d) => d.chainId === chainId)?.tokens.find((t) => lower(t.address) === target) ?? null, [chainId, target])
  const symbol = choice?.symbol ?? ''

  // Changed only through a live sender (never while the offer is locked).
  const journal = useMemo(() => (live ? browserDepositJournal() : null), [live])
  const walletChain = useRef(walletChainId)
  useEffect(() => {
    walletChain.current = walletChainId
  }, [walletChainId])

  // Steps handed to the wallet with no usable answer (F1): this page's, and a reload's from storage. Live chains only.
  const unsettled = live ? pageUnsettled() : null
  const [held, setHeld] = useState<readonly UnsettledOffer[]>(() => unsettled?.list(wallet) ?? [])
  const refreshHeld = useCallback(() => setHeld(unsettled?.list(wallet) ?? []), [unsettled, wallet])
  const [heldNotice, setHeldNotice] = useState<{ origin: number; copy: string; code: string | null } | null>(null)
  /** Quotes whose deposit this page handed to the wallet: never offered again (the sender refuses them too). */
  const [handedQuotes, setHandedQuotes] = useState<ReadonlySet<string>>(() => new Set())

  // The closed sender, made once per wallet on first use, on a live chain only: while locked it is never built.
  const senderRef = useRef<Promise<OriginSender> | null>(null)
  const sender = useCallback((): Promise<OriginSender> => {
    if (!live || services === null) return Promise.reject(new OriginStepError('quote_synthetic'))
    if (!senderRef.current) {
      senderRef.current = browserOriginWallet()
        .then((own) => createOriginSender(own, { runtime: services.runtime, monoMs: services.clock.monoMs, journal, unsettled: unsettled ?? undefined }))
        .catch((error: unknown) => {
          senderRef.current = null
          throw error
        })
    }
    return senderRef.current
  }, [live, services, journal, unsettled])

  // ---- the deposits this offer tracks (live chains) ------------------------------------------------------------------
  const [deposits, setDeposits] = useState<TrackedDeposit[]>(() =>
    (journal?.list(chainId, wallet) ?? []).map((record) => ({ record, destinationToken: null, originLabel: null, review: null, journaled: true })),
  )
  const [steps, setSteps] = useState<StepsView>(IDLE_STEPS)

  // ---- the balances on the other networks, read by Domino's service (Added 2026-10-06) ------------------------------
  // read-v6's chain-balances (rugged97's item 3): public chain data, no session and no wallet move; each network's ETH,
  // WETH and stable, shown under its button. Read again for each pick, so a choice rests on the chain now.
  const transports = useMemo(() => (live ? v2Transports(gate) : null), [live, gate])
  const sources = SOURCE_CHAINS.filter((id) => id !== chainId)
  const readServed = useCallback(async (): Promise<ChainBalancesResponse | null> => {
    if (transports === null) return null
    try {
      if (!routeServes(await transports.routeState('readV6'), 'chain-balances')) return null
      const reply = await readChainBalances(transports.read, transports.readRuntime, wallet, balancesRequest(chainId, SOURCE_CHAINS))
      return reply.kind === 'ok' ? reply.body : null
    } catch {
      return null
    }
  }, [transports, wallet, chainId])
  const [served, setServed] = useState<{ key: string; answer: ChainBalancesResponse } | null>(null)
  const servedKey = live && opened ? `${wallet}|${chainId}` : null
  useEffect(() => {
    if (servedKey === null) return
    let alive = true
    void readServed().then((answer) => {
      if (alive && answer) setServed({ key: servedKey, answer })
    })
    return () => {
      alive = false
    }
  }, [servedKey, readServed])
  const servedNow = served !== null && served.key === servedKey ? served.answer : null

  // ---- origins (§3.3), asked automatically when funds are insufficient, with a service to ask ----------------------
  const originsKey = target === null ? null : `${chainId}|${target}|${access}`
  const [originsAnswer, setOriginsAnswer] = useState<{ key: string; value: OriginsState } | null>(null)
  const origins: OriginsState = originsAnswer !== null && (originsAnswer.key === originsKey || steps.running) ? originsAnswer.value : { state: 'loading' }
  const [featureOff, setFeatureOff] = useState<RequestFailure | null>(null)
  useEffect(() => {
    if (!opened || !sessionReady || services === null || target === null || originsKey === null) return
    let alive = true
    let cancelTimer: (() => void) | null = null
    const controller = new AbortController()
    let attempt = 0
    const ask = async () => {
      const request = { destinationChainId: chainId, destinationToken: target }
      const outcome = await services.client.origins(request, { owner: services.owner, signal: controller.signal })
      if (!alive) return
      if (outcome.ok) {
        attempt = 0
        setOriginsAnswer({ key: originsKey, value: { state: 'ok', list: outcome.data.origins } })
        return
      }
      attempt += 1
      const failure = requestFailure(outcome.failure, attempt)
      if (failure.featureOff) setFeatureOff(failure)
      setOriginsAnswer({ key: originsKey, value: { state: 'failed', failure } })
      if (failure.retryMs !== null) cancelTimer = services.clock.setTimer(() => void ask(), failure.retryMs)
    }
    void ask()
    return () => {
      alive = false
      controller.abort()
      cancelTimer?.()
    }
  }, [opened, sessionReady, services, chainId, target, originsKey])

  const list = origins.state === 'ok' ? origins.list : null
  const name = useMemo(() => naming(list), [list])
  const originsView = useMemo(() => (list ? presentOrigins(list) : null), [list])

  // ---- the form ----------------------------------------------------------------------------------------------------
  const [chosenChainId, setOriginChainId] = useState<number | null>(null)
  const [chosenAddress, setOriginAddress] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [slippage, setSlippage] = useState(slippageText(FUNDS_DEFAULT_SLIPPAGE_BPS))
  const [gasChosen, setGasChosen] = useState(FUNDS_DESTINATION_GAS_DEFAULT_ON)
  const [readDecimals, setReadDecimals] = useState<{ key: string; decimals: number | null } | null>(null)
  const [nativeRead, setNativeRead] = useState<{ key: string; raw: string } | null>(null)

  // A listing keeps the choice only where it still lists it.
  const originChainId = list && chosenChainId !== null && list.chains.some((c) => c.chainId === chosenChainId) ? chosenChainId : null
  const originAddress = list && originChainId !== null && originToken(list, originChainId, chosenAddress) ? chosenAddress : null
  const network = originChainId !== null ? (name.origin(originChainId) ?? null) : null

  const listed = list ? originToken(list, originChainId, originAddress) : null
  const listedAddress = listed ? lower(listed.address) : null
  const listedDecimals = listed ? listed.decimals : null
  const tokenKey = listedAddress !== null && originChainId !== null ? `${originChainId}:${listedAddress}` : null
  // §3.3: decimals from the listing; when it has none, read decimals() on the origin through the wallet's provider while
  // the wallet is there (live chains only); otherwise the amount is taken in raw units only. Never guessed.
  const decimals = knownDecimals(listedDecimals) ? listedDecimals : readDecimals && readDecimals.key === tokenKey ? readDecimals.decimals : null
  useEffect(() => {
    if (!live || listedAddress === null || tokenKey === null || originChainId === null || knownDecimals(listedDecimals) || listedAddress === ZERO) return
    if (walletChainId !== originChainId) return
    let alive = true
    void sender()
      .then((own) => own.decimals(originChainId, listedAddress))
      .then((read) => {
        if (alive) setReadDecimals({ key: tokenKey, decimals: read })
      })
      .catch((error: unknown) => forgetSenderOn(senderRef, error))
    return () => {
      alive = false
    }
  }, [live, listedAddress, listedDecimals, tokenKey, originChainId, walletChainId, sender])

  // §3.9: the ETH on the position's chain: the amount step's own reading when the pool holds ETH; else, on a live chain,
  // read through the wallet's provider while the wallet is there; otherwise not known (the person decides).
  const nativeDelivery = target === ZERO
  const nativeKey = live && !nativeDelivery && nativeOnDestination === null && walletChainId === chainId ? `${chainId}` : null
  useEffect(() => {
    if (nativeKey === null) return
    let alive = true
    void sender()
      .then((own) => own.balance(chainId, ZERO))
      .then((raw) => {
        if (alive) setNativeRead({ key: nativeKey, raw })
      })
      .catch((error: unknown) => forgetSenderOn(senderRef, error))
    return () => {
      alive = false
    }
  }, [nativeKey, chainId, sender])
  const nativeHere = nativeOnDestination ?? (nativeKey !== null && nativeRead?.key === nativeKey ? nativeRead.raw : null)
  const gasOffered = target === null ? null : offerDestinationGas(target, nativeHere)

  const amountRaw = listed ? amountRawOf(amount, decimals) : null
  const slippageBps = slippageBpsOf(slippage)
  const request =
    listed && originChainId !== null && amountRaw !== null && slippageBps !== null && target !== null
      ? quoteRequestOf({
          originChainId,
          originToken: listed.address,
          destinationChainId: chainId,
          destinationToken: target,
          amountRaw,
          slippageBps,
          destinationGas: gasOffered !== null && gasChosen,
        })
      : null
  const requestKey = request && sessionReady ? `${access}|${JSON.stringify(request)}` : null

  // ---- the quote (§3.4, §3.5) ----------------------------------------------------------------------------------------
  const [asked, setQuote] = useState<QuoteState>({ state: 'idle' })
  // A quote answers the form it was asked for: change the form and it is gone. While the wallet steps run, the form is
  // locked, so the quote they run on stays.
  const quote: QuoteState = asked.state === 'idle' || asked.key === requestKey || steps.running ? asked : { state: 'idle' }
  const quoteAsk = useRef<(() => void) | null>(null)
  const autoRequotes = useRef(0)
  const generation = useRef(0)
  const accessBefore = useRef(access)
  useEffect(() => {
    if (accessBefore.current === access) return
    accessBefore.current = access
    quoteAsk.current?.()
    autoRequotes.current = 0
    // A bridge already approved by the person keeps tracking its wallet steps/journal.
    // An unsubmitted quote is never carried into a new private session.
    // The session-scoped requestKey above already excludes the previous quote synchronously.
    // A new explicit quote request resets its steps; no effect-derived state is needed here.
  }, [access, steps.running])
  useEffect(
    () => () => {
      generation.current += 1
      quoteAsk.current?.()
    },
    [],
  )
  // And any ask still waiting for the old form stops asking.
  useEffect(() => {
    if (asked.state !== 'idle' && asked.key !== requestKey && !steps.running) quoteAsk.current?.()
  }, [asked, requestKey, steps.running])

  const askQuote = useCallback(
    (wanted: CrosschainRequests['quote'], key: string, firstNote: string | null): void => {
      if (services === null) return
      quoteAsk.current?.()
      let alive = true
      let cancelTimer: (() => void) | null = null
      const controller = new AbortController()
      quoteAsk.current = () => {
        alive = false
        controller.abort()
        cancelTimer?.()
      }
      void (async () => {
        let note = firstNote
        for (let attempt = 1; alive; attempt += 1) {
          setQuote({ state: 'loading', key, note })
          const outcome = await services.client.quote(wanted, { owner: services.owner, signal: controller.signal })
          if (!alive) return
          if (outcome.ok) {
            setQuote({ state: 'ok', key, quote: outcome.data.quote, timing: outcome.timing, source: outcome.source, request: wanted, note })
            return
          }
          const failure = requestFailure(outcome.failure, attempt)
          if (failure.featureOff) setFeatureOff(failure)
          if (failure.requote && attempt <= 1) {
            note = FAILURE_COPY.expired
            continue
          }
          setQuote({ state: 'failed', key, failure })
          const wait = failure.retryMs
          if (wait === null) return
          // The page asks again by itself; the wait ends early only when this ask is let go (then nothing follows).
          await new Promise<void>((done) => {
            cancelTimer = services.clock.setTimer(done, wait)
          })
          note = null
        }
      })()
    },
    [services],
  )

  // Past its deadline a quote is asked again by itself ("The quote expired. Getting a new one…"), a few times in a row.
  // Not a quote whose deposit was handed to the wallet: that one stays on screen, said as sent.
  const askedHanded = asked.state === 'ok' && handedQuotes.has(quoteKeyOf(asked.quote))
  useEffect(() => {
    if (services === null || asked.state !== 'ok' || steps.running || asked.key !== requestKey || askedHanded) return
    const deadline = quoteDeadlineMono(asked.quote, asked.timing) - SEND_MARGIN_MS
    return services.deadlineTimer(
      () => {
        if (autoRequotes.current < FUNDS_AUTO_REQUOTES) {
          autoRequotes.current += 1
          setSteps(IDLE_STEPS)
          askQuote(asked.request, asked.key, FAILURE_COPY.expired)
        } else {
          setQuote({ state: 'expired', key: asked.key })
        }
      },
      Math.max(0, deadline - services.clock.monoMs()),
    )
  }, [asked, requestKey, steps.running, askQuote, services, askedHanded])

  // ---- the deposit (§3.6), live chains only --------------------------------------------------------------------------
  const originWords = (id: number) => name.origin(id) ?? `network ${id}`
  const nativeWords = (id: number) => cleanSymbol(list ? originToken(list, id, ZERO)?.symbol : null) ?? 'its network token'

  const outcomeNotice = (outcome: FlowOutcome, origin: number): StepsView['notice'] => {
    const values = { origin: originWords(origin), native: nativeWords(origin) }
    switch (outcome.kind) {
      // A quote that did not come from the service (the sender's own guard, never met here: every quote of the offer is the service's).
      case 'synthetic':
        return { copy: senderCopy('quote_synthetic', values), code: 'quote_synthetic' }
      case 'not_sendable':
        return { copy: outcome.reason === 'no_decision' ? NO_ROUTE : senderCopy(`quote_${outcome.reason}`, values), code: `quote_${outcome.reason}` }
      case 'switch':
        return outcome.outcome === 'unknown_chain'
          ? { copy: fill(ADD_ORIGIN, { origin: values.origin }), code: 'unknown_chain' }
          : { copy: v2SwitchNotice(outcome.outcome as Exclude<ChainSwitchOutcome, 'switched'>, values.origin), code: `switch_${outcome.outcome}` }
      case 'error':
        return { copy: senderCopy(outcome.code, values), code: outcome.code }
      case 'approval_reverted':
        return { copy: FUNDS_TEXT.approvalReverted(values.origin), code: 'approval_reverted' }
      default:
        return null
    }
  }

  /** A quote's deposit, once handed to the wallet on this page (or held unsettled since a reload), is never offered again (F1). */
  const handedOver = (offered: QuotePlan) => {
    const key = quoteKeyOf(offered)
    return handedQuotes.has(key) || held.some((offer) => offer.kind === 'deposit' && offer.quote === key)
  }

  /**
   * "I rejected it in my wallet" for a step held on `origin` (V1's control): the wallet goes to that origin, then the
   * sender lets the hold go only while the chain shows its nonce still free with nothing pending. Nothing is sent.
   */
  const forgetHeld = async (origin: number) => {
    if (!live) return
    setHeldNotice(null)
    const values = { origin: originWords(origin), native: nativeWords(origin) }
    if (walletChain.current !== origin) {
      const switched = await switchToOrigin(origin)
      if (switched !== 'switched') {
        setHeldNotice(
          switched === 'unknown_chain'
            ? { origin, copy: fill(ADD_ORIGIN, { origin: values.origin }), code: 'unknown_chain' }
            : { origin, copy: v2SwitchNotice(switched, values.origin), code: `switch_${switched}` },
        )
        return
      }
    }
    try {
      const result = await (await sender()).forgetUnsettled(origin)
      if (result === 'forgotten') setHeldNotice({ origin, copy: FUNDS_TEXT.forgotten, code: null })
      else if (result === 'passed') setHeldNotice(null)
      else if (result === 'pending') setHeldNotice({ origin, copy: senderCopy('pending_wallet_transaction', values), code: 'pending_wallet_transaction' })
    } catch (error) {
      forgetSenderOn(senderRef, error)
      const code = error instanceof OriginStepError ? error.code : 'wallet_error'
      setHeldNotice({ origin, copy: senderCopy(code, values), code })
    }
    refreshHeld()
    // The steps' own notice was about this hold: it is answered on the card now.
    setSteps((previous) => (previous.notice?.code === 'wallet_request_open' ? { ...previous, notice: null } : previous))
  }

  const deposit = async () => {
    // Never while locked (Deposit is not even offered); a quote that did not come over HTTP would stop in the sender anyway.
    if (!live || !sessionReady || services === null || quote.state !== 'ok' || steps.running || handedOver(quote.quote)) return
    autoRequotes.current = 0
    const mine = ++generation.current
    const { quote: offered, timing, source, request: sentRequest, key } = quote
    const origin = offered.request.originChainId
    let own: OriginSender | null = null
    const lazy = async () => (own ??= await sender())
    setPick(null)
    setSteps({ ...IDLE_STEPS, running: true })
    const outcome = await runDeposit(
      {
        runtime: services.runtime,
        owner: wallet,
        sender: {
          review: async (input) => (await lazy()).review(input),
          send: async (reviewed, kind) => (await lazy()).send(reviewed, kind),
          receipt: async (reviewed, hash) => (await lazy()).receipt(reviewed, hash),
        },
        switchToOrigin,
        walletChainId: () => walletChain.current,
        monoMs: services.clock.monoMs,
        wait: services.wait,
        aborted: () => mine !== generation.current,
        receiptPollMs: FUNDS_RECEIPT_POLL_MS,
      },
      { quote: offered, timing, source },
      (stage) => {
        if (mine === generation.current) setSteps((previous) => stepsAfter(previous, stage))
      },
    )
    if (mine !== generation.current) return
    // Changed on purpose 2026-10-06: the run moves the wallet to the origin when it is elsewhere (the one click no longer
    // does), and the session's epoch moves with the wallet: the quote and what the run said are kept under the new one.
    const rekeyed = `${latest.current.access}|${JSON.stringify(sentRequest)}`
    if (rekeyed !== key && latest.current.access.startsWith('ready:')) setQuote((previous) => (previous.state === 'ok' && previous.key === key ? { ...previous, key: rekeyed } : previous))
    if (outcome.kind === 'error') forgetSenderOn(senderRef, new OriginStepError(outcome.code))
    // A deposit handed to the wallet with no usable answer is sent for this page: this quote never offers it again (F1).
    if (outcome.kind === 'error' && outcome.offered && outcome.step === 'deposit') setHandedQuotes((previous) => new Set(previous).add(quoteKeyOf(offered)))
    refreshHeld()
    switch (outcome.kind) {
      case 'sent': {
        const { record, journaled } = outcome.sent
        if (record) {
          const tracked: TrackedDeposit = {
            record,
            destinationToken: lower(offered.request.destinationToken),
            originLabel: cleanSymbol(name.book(origin, offered.request.originToken)?.symbol) ?? null,
            review: outcome.review,
            journaled,
          }
          setDeposits((previous) => [tracked, ...previous.filter((d) => d.record.depositTxHash !== record.depositTxHash)])
        }
        setSteps(IDLE_STEPS)
        setQuote({ state: 'idle' })
        setAmount('')
        return
      }
      case 'expired':
        setSteps(IDLE_STEPS)
        askQuote(sentRequest, latest.current.access.startsWith('ready:') ? rekeyed : key, outcome.approved ? FUNDS_TEXT.newQuoteApproved : FUNDS_TEXT.newQuote)
        return
      case 'aborted':
        return
      default:
        setSteps((previous) => ({ ...previous, running: false, deposit: 'waiting', notice: outcomeNotice(outcome, origin) }))
    }
  }

  // ---- "Bring it from {network}": one click, the rest done for the person (Changed on purpose 2026-10-05) ----------------
  const [pick, setPick] = useState<Pick | null>(null)
  const pickTurn = useRef(0)
  const latest = useRef({ access, list, slippage, gasChosen })
  useEffect(() => {
    latest.current = { access, list, slippage, gasChosen }
  })
  useEffect(
    () => () => {
      pickTurn.current += 1
    },
    [],
  )

  /** Waits until `check` holds, a little at a time, while this pick is the current one; false at `ms` or when let go. */
  const until = async (check: () => boolean, alive: () => boolean, ms: number): Promise<boolean> => {
    if (services === null) return false
    const end = services.clock.monoMs() + ms
    while (alive()) {
      if (check()) return true
      if (services.clock.monoMs() > end) return false
      await services.wait(250)
    }
    return false
  }

  /**
   * The person picked a network: signed in if needed (the wallet's own dialog, once: the session then holds across
   * Domino's three networks), the wallet moved there, its balances read, the token and the amount chosen for them (what
   * the position lacks, 1% more for the bridge's fees, never more than they hold, ETH's gas reserve kept), and the
   * quote asked. What comes back is the quote and its one button.
   */
  const bringFrom = async (origin: V2ChainId) => {
    if (!live || services === null || target === null || steps.running) return
    const turn = ++pickTurn.current
    const alive = () => turn === pickTurn.current
    const ready = () => latest.current.access.startsWith('ready:')
    const network = v2Chain(origin).name
    const fail = (copy: string, code: string) => {
      if (alive()) setPick({ chainId: origin, stage: 'failed', copy, code })
    }
    quoteAsk.current?.()
    setQuote({ state: 'idle' })
    setSteps(IDLE_STEPS)
    if (!ready()) {
      setPick({ chainId: origin, stage: 'signing' })
      openWalletDialog()
      if (!(await until(ready, alive, 180_000))) return fail(FUNDS_TEXT.signInFirst, 'signed_out')
    }
    const candidate = CANDIDATE_ORIGINS.find((c) => c.chainId === origin)
    if (!candidate) return fail(FUNDS_TEXT.readFailed(network), 'no_candidate')
    // Changed on purpose 2026-10-06: the balances there as Domino's service reads them now, the wallet staying where it is
    // (it moves to that network only to send). Without that answer, the wallet's own read there, as before.
    setPick({ chainId: origin, stage: 'reading' })
    const fresh = await readServed()
    if (!alive()) return
    if (fresh) setServed({ key: `${wallet}|${chainId}`, answer: fresh })
    let report: HoldingsReport | null = fresh ? holdingsFromChainBalances(fresh, candidate) : null
    if (report === null) {
      if (walletChain.current !== origin) {
        setPick({ chainId: origin, stage: 'switching' })
        const switched = await switchToChain(origin)
        if (!alive()) return
        if (switched !== 'switched') return fail(switched === 'unknown_chain' ? fill(ADD_ORIGIN, { origin: network }) : v2SwitchNotice(switched, network), `switch_${switched}`)
        // The session held there (session/machine.ts heldAway) is ready again once the move settles.
        if (!(await until(ready, alive, 20_000))) return fail(FUNDS_TEXT.signInFirst, 'signed_out')
      }
      setPick({ chainId: origin, stage: 'reading' })
      try {
        report = await readHoldingsReport(await browserOriginWallet(), candidate)
      } catch {
        return fail(FUNDS_TEXT.readFailed(network), 'read_failed')
      }
      if (!alive()) return
    }
    const holdings: readonly Holding[] = report.holdings
    // The listing for this token, asked again since the session moved with the wallet.
    if (!(await until(() => latest.current.list !== null, alive, 20_000))) return fail(FUNDS_TEXT.readFailed(network), 'origins_unavailable')
    const listing = latest.current.list
    if (!alive() || listing === null) return
    const tokens = candidate.tokens.map((t) => t.symbol)
    const named = tokens.length > 1 ? `${tokens.slice(0, -1).join(', ')} or ${tokens[tokens.length - 1]}` : (tokens[0] ?? '')
    // A balance that could not be read is never said to be zero.
    if (holdings.every((h) => h.raw === 0n)) {
      return report.unread.length > 0 ? fail(FUNDS_TEXT.readFailed(network), 'read_partial') : setPick({ chainId: origin, stage: 'empty', copy: FUNDS_TEXT.noneThere(named, network) })
    }
    const holding = holdingFor(holdings, target, chainId, origin, listing)
    if (!holding) return setPick({ chainId: origin, stage: 'empty', copy: FUNDS_TEXT.notBridged(network) })
    const listed = originToken(listing, origin, holding.token)
    if (!listed) return setPick({ chainId: origin, stage: 'empty', copy: FUNDS_TEXT.notBridged(network) })
    setPick({ chainId: origin, stage: 'quoting' })
    const available = maxSpend(holding.raw, holding.token === ZERO)
    if (available <= 0n) return setPick({ chainId: origin, stage: 'empty', copy: FUNDS_TEXT.noneThere(named, network) })
    const slippageBps = slippageBpsOf(latest.current.slippage) ?? FUNDS_DEFAULT_SLIPPAGE_BPS
    const requestFor = (raw: bigint) =>
      quoteRequestOf({ originChainId: origin, originToken: listed.address, destinationChainId: chainId, destinationToken: target, amountRaw: raw.toString(), slippageBps, destinationGas: false })
    // What to send: the same kind converts by decimals; another kind by one quote of everything held (its own rate).
    const short = lack?.shortRaw ?? null
    let amountRaw = available
    if (short !== null && short > 0n && lack !== null) {
      const etherAt = (chain: V2ChainId, token: string) => token === ZERO || token === v2Chain(chain).wrappedNative.address
      if (etherAt(chainId, target) === etherAt(origin, holding.token)) {
        amountRaw = withMargin(convertUnits(short, lack.decimals ?? holding.decimals, holding.decimals))
      } else {
        const probe = await services.client.quote(requestFor(available), { owner: services.owner })
        if (!alive()) return
        const winner = probe.ok ? probe.data.quote.candidates.find((c) => c.provider === probe.data.quote.decision) : undefined
        const out = winner?.outputRaw ? BigInt(winner.outputRaw) : 0n
        if (out > 0n) amountRaw = withMargin((short * available + out - 1n) / out)
      }
      if (amountRaw > available) amountRaw = available
    }
    const units = formatUnitsExact(amountRaw.toString(), holding.decimals)
    if (units === null) return fail(FUNDS_TEXT.readFailed(network), 'units')
    // The form takes what was chosen (the person may change it under "Change amount"); the quote is asked for exactly it.
    setOriginChainId(origin)
    setOriginAddress(lower(listed.address))
    // The listing may not say the token's decimals; the network's own currency says them (Added 2026-10-06: the wallet
    // need not be there to read them).
    if (!knownDecimals(listed.decimals)) setReadDecimals({ key: `${origin}:${lower(listed.address)}`, decimals: holding.decimals })
    setAmount(units.replace(/,/g, ''))
    setKept(target)
    const wanted = requestFor(amountRaw)
    autoRequotes.current = 0
    askQuote(wanted, `${latest.current.access}|${JSON.stringify(wanted)}`, null)
  }
  const pickBusy = pick !== null && (pick.stage === 'signing' || pick.stage === 'switching' || pick.stage === 'reading' || (pick.stage === 'quoting' && quote.state === 'idle'))
  const pickWords = (current: Pick): string => {
    const network = v2Chain(current.chainId).name
    switch (current.stage) {
      case 'signing':
        return FUNDS_TEXT.signingIn
      case 'switching':
        return FUNDS_TEXT.switchingTo(network)
      case 'reading':
        return FUNDS_TEXT.checking(network)
      case 'quoting':
        return FUNDS_TEXT.finding
      case 'empty':
      case 'failed':
        return current.copy
    }
  }

  // Shown while the position lacks a token a deposit can deliver, or while something of the offer's own is under way.
  const underWay = deposits.length > 0 || held.length > 0 || heldNotice !== null || steps.running || quote.state !== 'idle'
  if ((lacks.length === 0 && !underWay) || target === null) return null

  const busy = steps.running

  // The form under "Change amount" offers Domino's own networks only, as the one click does.
  const chains = (originsView?.chains ?? []).filter((c) => SOURCE_CHAINS.includes(c.chainId as V2ChainId) && c.chainId !== chainId)
  const tokens = chains.find((c) => c.chainId === originChainId)?.tokens ?? []
  const unit = listed ? (cleanSymbol(listed.symbol) ?? `${listed.address.slice(0, 6)}…${listed.address.slice(-4)}`) : ''
  // What the service read on each network (Added 2026-10-06): the amounts held, about how much in USD when it could value
  // them all; nothing at all when it could not read that network (never a zero).
  const holdsOn = (id: V2ChainId): { code: 'holds' | 'none'; text: string } | null => {
    const candidate = CANDIDATE_ORIGINS.find((c) => c.chainId === id)
    const report = servedNow && candidate ? holdingsFromChainBalances(servedNow, candidate) : null
    if (!report) return null
    if (report.holdings.length === 0) return report.unread.length > 0 ? null : { code: 'none', text: FUNDS_TEXT.nothingThere }
    const amounts = report.holdings.map((h) => {
      const units = formatUnits(h.raw.toString(), h.decimals)
      return `${units && units.kind === 'units' ? units.text : h.raw.toString()} ${h.symbol}`
    })
    const usd = servedNow ? totalUsdOn(servedNow, id) : null
    return { code: 'holds', text: FUNDS_TEXT.holdsThere(amounts, report.unread.length === 0 && usd !== null ? formatUsd(usd) : null) }
  }
  const shortUnits = lack && lack.shortRaw !== null ? formatUnitsExact(lack.shortRaw.toString(), lack.decimals) : null
  const shortText = shortUnits !== null ? `${shortUnits} ${symbol}` : null
  return (
    <section
      className="dm-funds-offer"
      data-funds-offer=""
      data-funds-mode={gate.mode}
      data-funds-services={services === null ? 'none' : services.source}
      data-funds-token={target}
      aria-label="Fund this position"
    >
      <div className="dm-funds-heading">
        <span className="dm-funds-icon" aria-hidden="true">↗</span>
        <div>
          <h4 data-funds-title="">{FUNDS_TEXT.title(symbol, network)}</h4>
          {lack && (
            <p data-funds-lack={shortText !== null ? 'short' : lack.haveRaw === 0n ? 'none' : 'swap'}>
              {shortText !== null
                ? FUNDS_TEXT.youNeed(shortText, chain.name)
                : onUseToken
                  ? `Use ${symbol} as a new deposit, then review the swap.`
                  : lack.haveRaw === 0n
                    ? FUNDS_TEXT.holdsNone(symbol, chain.name)
                    : FUNDS_TEXT.cantFund(chain.name)}
            </p>
          )}
        </div>
      </div>
      <div className="dm-funds-body" data-funds-body="">
        {locked ? (
          <p role="status" className="dm-funds-unavailable" data-funds-locked="">
            {locked}
          </p>
        ) : featureOff ? (
          <p role="status" className="text-body text-fg-muted" data-funds-off={featureOff.code ?? 'not_deployed'} data-error-code={featureOff.code ?? undefined}>
            {featureOff.copy}
          </p>
        ) : (
          services !== null && (
            <>
              {/* The one choice (Changed on purpose 2026-10-05): a network; signing in, the switch, the balance, the token
                  and the amount follow by themselves (bringFrom). */}
              {!steps.running && quote.state !== 'ok' && lacks.length > 0 && (
                <div className="grid gap-2" data-funds-sources="">
                  <p className="text-body">{FUNDS_TEXT.bringFrom}</p>
                  <div className="flex flex-wrap gap-3">
                    {sources.map((id) => {
                      const holds = holdsOn(id)
                      return (
                        <div key={id} className="grid justify-items-start gap-1">
                          <Button
                            type="button"
                            size="sm"
                            variant={pick?.chainId === id ? 'secondary' : 'outline'}
                            aria-pressed={pick?.chainId === id}
                            disabled={pickBusy}
                            onClick={() => void bringFrom(id)}
                            data-funds-network={id}
                          >
                            {v2Chain(id).name}
                          </Button>
                          {holds && (
                            <span className="dm-hint tnum" data-funds-network-holds={id} data-funds-holds={holds.code}>
                              {holds.text}
                            </span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                  <p className="dm-hint">{FUNDS_TEXT.howItWorks(chain.name)}</p>
                </div>
              )}
              {pick && quote.state === 'idle' && !steps.running && (
                <p
                  role="status"
                  className={pick.stage === 'failed' ? 'dm-error' : 'text-body text-fg-muted'}
                  aria-busy={pickBusy || undefined}
                  data-funds-pick={pick.stage}
                  data-funds-pick-network={pick.chainId}
                  data-error-code={pick.stage === 'failed' ? pick.code : undefined}
                >
                  {pickWords(pick)}
                </p>
              )}
              {(deposits.length > 0 || held.length > 0 || heldNotice !== null) && (
                <section className="grid gap-3" data-funds-deposits="">
                  <h4 className="dm-subtitle">{FUNDS_TEXT.onTheWay}</h4>
                  {heldNotice && !held.some((offer) => offer.originChainId === heldNotice.origin) && (
                    <p role="status" className={heldNotice.code ? 'dm-error' : 'text-body'} data-error-code={heldNotice.code ?? undefined} data-funds-held-notice="">
                      {heldNotice.copy}
                    </p>
                  )}
                  {held.map((offer) => (
                    <HeldOffer
                      key={`held-${offer.originChainId}`}
                      offer={offer}
                      origin={originWords(offer.originChainId)}
                      native={nativeWords(offer.originChainId)}
                      notice={heldNotice?.origin === offer.originChainId ? heldNotice : null}
                      busy={busy}
                      onForget={() => void forgetHeld(offer.originChainId)}
                      onRemove={() => {
                        unsettled?.drop(wallet, offer.originChainId)
                        refreshHeld()
                      }}
                    />
                  ))}
                  {deposits.map((d) => (
                    <DepositStatus
                      key={`${d.record.originChainId}:${d.record.depositTxHash}`}
                      deposit={d}
                      services={services}
                      owner={wallet}
                      journal={journal}
                      name={name}
                      walletChainId={walletChainId}
                      access={access}
                      onArrived={onArrived}
                      sender={sender}
                      poolTokens={poolTokens}
                      onUse={onUse}
                      onUseToken={onUseToken}
                      onRemove={() => {
                        try {
                          journal?.drop(wallet, d.record)
                        } catch {
                          // Kept in storage; gone from this list.
                        }
                        setDeposits((previous) => previous.filter((other) => other !== d))
                      }}
                    />
                  ))}
                </section>
              )}

              {quote.state === 'loading' && (
                <p role="status" className="text-body text-fg-muted" data-funds-quote-loading="">
                  {quote.note ?? FUNDS_TEXT.quoting}
                </p>
              )}
              {quote.state === 'failed' && quote.failure.copy && (
                <p role="alert" className="dm-error" data-error-code={quote.failure.code ?? undefined} data-funds-quote-error="">
                  {quote.failure.copy}
                </p>
              )}
              {quote.state === 'expired' && (
                <p role="status" className="text-body" data-funds-quote-expired="">
                  {FUNDS_TEXT.quoteExpired}
                </p>
              )}
              {quote.state === 'ok' && (
                <QuoteView
                  quote={quote.quote}
                  name={name}
                  note={quote.note}
                  walletChainId={live ? walletChainId : null}
                  steps={steps}
                  handedOver={handedOver(quote.quote)}
                  locked={locked}
                  onDeposit={() => void deposit()}
                  onForget={() => void forgetHeld(quote.quote.request.originChainId)}
                />
              )}

              {/* Once a network is chosen, its transfer can be changed (the quote then waits for Get a quote). */}
              {originChainId !== null && !steps.running && (
                <details className="dm-funds-edit" data-funds-edit="">
                  <summary>{FUNDS_TEXT.changeTransfer}</summary>
                <div className="dm-funds-form">
              <div className="grid gap-3" data-funds-origins={origins.state}>
                {origins.state === 'loading' && (
                  <p className="text-caption text-fg-muted" aria-busy="true">
                    <Skeleton className="mr-2 inline-block h-3 w-24 align-middle" />
                    {FUNDS_TEXT.loadingNetworks}
                  </p>
                )}
                {origins.state === 'failed' && origins.failure.copy && (
                  <p role="alert" className="dm-error" data-error-code={origins.failure.code ?? undefined} data-funds-origins-error="">
                    {origins.failure.copy}
                  </p>
                )}
                {originsView && (
                  <>
                    <ul className="grid gap-1 text-caption text-fg-muted" data-funds-providers="">
                      {originsView.providers.map((p) => (
                        <li key={p.provider} hidden={p.available} data-funds-provider={p.provider} data-funds-available={p.available ? 'yes' : 'no'}>
                          {p.available ? FUNDS_TEXT.providerListed(p.name) : p.text}
                        </li>
                      ))}
                    </ul>
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="dm-acct-lf">
                        <span className="dm-label">{FUNDS_TEXT.network}</span>
                        <Select<string>
                          id="funds-origin-chain"
                          label={FUNDS_TEXT.network}
                          value={originChainId === null ? '' : String(originChainId)}
                          options={[{ value: '', label: FUNDS_TEXT.chooseNetwork }, ...chains.map((c) => ({ value: String(c.chainId), label: c.name }))]}
                          onChange={(next) => {
                            if (busy) return
                            setOriginChainId(next === '' ? null : Number(next))
                            setOriginAddress(null)
                            if (target !== null) setKept(target)
                          }}
                        />
                      </div>
                      {originChainId !== null && (
                        <div className="dm-acct-lf">
                          <span className="dm-label">{FUNDS_TEXT.token}</span>
                          {tokens.length === 0 ? (
                            <span className="text-caption text-fg-muted">{FUNDS_TEXT.noTokens}</span>
                          ) : (
                            <Select<string>
                              id="funds-origin-token"
                              label={FUNDS_TEXT.token}
                              value={originAddress === null ? '' : lower(originAddress)}
                              options={[
                                { value: '', label: FUNDS_TEXT.chooseToken },
                                ...tokens.map((t) => ({
                                  value: lower(t.address),
                                  label: (
                                    <span data-funds-origin-token={lower(t.address)}>
                                      {t.label} <span className="text-fg-muted">· {t.providers.join(', ')}</span>
                                    </span>
                                  ),
                                })),
                              ]}
                              onChange={(next) => {
                                if (busy) return
                                setOriginAddress(next === '' ? null : next)
                              }}
                            />
                          )}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>

              {listed && (
                <div className="grid gap-3" data-funds-amount="">
                  <AmountField
                    id="funds-amount"
                    label={FUNDS_TEXT.amount}
                    unit={unit}
                    inputMode={decimals === null ? 'numeric' : 'decimal'}
                    placeholder="0"
                    value={amount}
                    disabled={busy}
                    data-funds-amount-input=""
                    data-funds-raw-units={decimals === null ? '' : undefined}
                    error={amount !== '' && amountRaw === null ? FUNDS_TEXT.amountInvalid : null}
                    below={decimals === null ? <p className="dm-hint" data-funds-raw-hint="">{FUNDS_TEXT.rawUnits}</p> : null}
                    onChange={(event) => setAmount(event.target.value)}
                  />
                  {live && decimals === null && originChainId !== null && walletChainId !== originChainId && listedAddress !== ZERO && (
                    <Button variant="secondary" size="sm" className="justify-self-start" disabled={busy} onClick={() => void switchToOrigin(originChainId)}>
                      {FUNDS_TEXT.readDecimals(originWords(originChainId))}
                    </Button>
                  )}
                  {/* §3.9 rev2: suggested when the balance read there lacks; with no balance read, shown for the person to decide. */}
                  {gasOffered !== null && (
                    <div className="grid gap-1" data-funds-destination-gas={gasOffered}>
                      <label className="dm-acct-check">
                        <input type="checkbox" checked={gasChosen} disabled={busy} onChange={(event) => setGasChosen(event.target.checked)} />
                        {FUNDS_TEXT.gasOffer(chain.name)}
                      </label>
                      <p className="dm-hint">{gasOffered === 'suggested' ? FUNDS_TEXT.gasWhy(chain.name) : FUNDS_TEXT.gasUnread(chain.name)}</p>
                    </div>
                  )}
                  <details className="dm-details" data-funds-slippage="">
                    <summary>
                      <span>{FUNDS_TEXT.slippageTitle}</span>
                      <span className="dm-flow-advanced-value">{slippageBps === null ? '—' : `${slippageText(slippageBps)}%`}</span>
                    </summary>
                    <label className="dm-acct-lf mt-2">
                      <span className="dm-label">{FUNDS_TEXT.slippage}</span>
                      <input
                        className="dm-field"
                        inputMode="decimal"
                        autoComplete="off"
                        spellCheck={false}
                        disabled={busy}
                        value={slippage}
                        aria-invalid={slippageBps === null ? true : undefined}
                        data-funds-slippage-input=""
                        onChange={(event) => setSlippage(event.target.value)}
                      />
                    </label>
                    <p className={slippageBps === null ? 'dm-error' : 'dm-hint'} role={slippageBps === null ? 'alert' : undefined}>
                      {slippageBps === null ? FUNDS_TEXT.slippageInvalid : FUNDS_TEXT.slippageHelp}
                    </p>
                  </details>
                  <Button
                    variant="secondary"
                    className="justify-self-start"
                    disabled={!request || busy || quote.state === 'loading'}
                    data-funds-get-quote=""
                    onClick={() => {
                      if (!request || !requestKey) return
                      autoRequotes.current = 0
                      setSteps(IDLE_STEPS)
                      setKept(target)
                      askQuote(request, requestKey, null)
                    }}
                  >
                    {quote.state === 'loading' ? FUNDS_TEXT.quoting : FUNDS_TEXT.getQuote}
                  </Button>
                </div>
              )}
                </div>
                </details>
              )}
            </>
          )
        )}
      </div>
    </section>
  )
}
