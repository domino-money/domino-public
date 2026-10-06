import type { ChainBalancesResponse } from 'api-contracts/read-v6/types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AmountField } from '../../components/create/fields'
import { TokenMark } from '../../components/TokenIcon'
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
import { CANDIDATE_ORIGINS, readHoldingsReport, type Holding } from '../../finance/v2/holdings'
import { openWalletDialog } from '../../finance/signedOut'
import { formatUsd } from '../../lib/format/usd'
import { v2Chain } from '../../v2/chains'
import { cleanSymbol, formatUnitsExact, knownDecimals } from '../../v2/crosschain/amounts'
import { quoteDeadlineMono, type Timing } from '../../v2/crosschain/client'
import { ADD_ORIGIN, FAILURE_COPY, fill, NO_ROUTE } from '../../v2/crosschain/copy'
import { destinationChoices, naming, providersDown, shortAmountText } from '../../v2/crosschain/present'
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
  balancesRequest,
  bestHolding,
  bringChoice,
  deliverableTokens,
  firstAsk,
  fixedFeeOf,
  heldMayArrive,
  heldOrigins,
  holdingArtwork,
  holdingFor,
  holdingsFromChainBalances,
  holdingText,
  holdOffers,
  kindOf,
  kindPrices,
  nativeOn,
  networkHolds,
  offerDestinationGas,
  originToken,
  otherNetworks,
  quoteBudgetWait,
  quoteRequestOf,
  requestFailure,
  sendable,
  sizeStep,
  typedQuoteWait,
  usableHoldings,
  winningMinimum,
  type KindPrices,
  type Lack,
  type LineHolding,
  type NetworkHolds,
  type RequestFailure,
} from './model'
import { FundsLine } from './PayWith'
import { IDLE_STEPS, QuoteView, type StepsView } from './QuoteView'
import type { FundsServices } from './services'
import { v2Transports } from '../transports'

const ZERO = '0x0000000000000000000000000000000000000000'
const lower = (value: string) => value.toLowerCase()

type OriginsState = { state: 'loading' } | { state: 'ok'; list: OriginsList } | { state: 'failed'; failure: RequestFailure }
type QuoteOutcome = Awaited<ReturnType<FundsServices['client']['quote']>>

/**
 * Changed on purpose 2026-10-05 (the owner, testing the offer: "it keeps asking me to sign in ... the networks don't show
 * ... very hard to understand; it has to happen behind the scenes, whoever uses Domino has no experience"): the one click
 * comes from Domino's own networks, Robinhood Chain, Base and Arbitrum One, never the destination; Domino's service reads
 * their balances. Changed on purpose 2026-10-06 (the owner's point 2a): the other networks crosschain-v1 lists are offered
 * too, behind ONE "Other networks" entry (model.ts otherNetworks); the session is held there (session/machine.ts).
 */
const SOURCE_CHAINS: readonly V2ChainId[] = [4663, 8453, 42161]

/** Where the one click "Bring it from {network}" stands: done for the person, said in one line. */
type Pick =
  | { chainId: V2ChainId; stage: 'signing' | 'switching' | 'reading' | 'quoting' }
  | { chainId: V2ChainId; stage: 'enter' }
  /** `down`: the copy also says which bridge the listing could not list (Added 2026-10-06, the integration review). */
  | { chainId: V2ChainId; stage: 'empty'; copy: string; down?: boolean }
  | { chainId: V2ChainId; stage: 'failed'; copy: string; code: string }

type QuoteState =
  | { state: 'idle' }
  /** `previous`: the quote shown before this one was asked, greyed while it comes (Added 2026-10-06). */
  | { state: 'loading'; key: string; note: string | null; previous: Extract<QuoteState, { state: 'ok' }> | null }
  | { state: 'ok'; key: string; quote: QuotePlan; timing: Timing; source: FundsServices['source']; request: CrosschainRequests['quote']; note: string | null }
  | { state: 'failed'; key: string; failure: RequestFailure }
  | { state: 'expired'; key: string }

/** What a one click brought the quote for, so a change of the typed amount sizes it again (Added 2026-10-06). */
interface Picked {
  origin: V2ChainId
  holding: Holding
  /** The listed address sent (lowercase) and the decimals it is sent in. */
  token: string
  decimals: number
  target: string
  /** The need the quote was sized for; null: everything held there (before an amount). */
  need: bigint | null
  /** Added 2026-10-06 (the review): whether it was sized with "Get gas on {destination}": a change sizes it again. */
  gas: boolean
}

/** One choice of the person's at a time (Added 2026-10-06, the review): a newer one lets this one go, its quotes too. */
interface Turn {
  alive: () => boolean
  signal: AbortSignal
}

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

/** A raw amount as the amount field takes it ("1234.5", no grouping); null when the decimals are not usable. */
const fieldUnits = (raw: bigint, decimals: number): string | null => formatUnitsExact(raw.toString(), decimals)?.replace(/,/g, '') ?? null

/**
 * Whether the header's wallet dialog, where signing in happens, is open: its button says so (aria-expanded), as
 * finance/signedOut.ts openWalletDialog presses it. Added 2026-10-06 (the integration review).
 */
const walletDialogOpen = (): boolean => typeof document !== 'undefined' && document.querySelector('header [aria-haspopup="dialog"]')?.getAttribute('aria-expanded') === 'true'

/**
 * How long a sign-in is waited for (Changed on purpose 2026-10-06, the integration review: a dialog closed without signing
 * in froze the offer for three minutes): while the wallet's dialog is open, or a signature is on its way, up to
 * SIGN_IN_OPEN_MS; once the dialog is closed with neither, at once, past SIGN_IN_GRACE_MS (the moment the dialog takes to
 * open after its button is pressed).
 */
const SIGN_IN_OPEN_MS = 180_000
const SIGN_IN_GRACE_MS = 1_000

/**
 * The listing's bridges that could not list (busy or unavailable) in the spec's own words (§3.4: "Relay is busy. Try
 * again shortly."), as one line; null while every one is listed. Added 2026-10-06 (the integration review).
 */
function downText(listing: OriginsList | null): string | null {
  const texts = listing ? providersDown(listing) : []
  return texts.length > 0 ? texts.join(' ') : null
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
 * Added 2026-10-06 (the owner's point 1: "the bridge option has to show on this screen ... before the person types an
 * amount she doesn't have, or nobody will ever find it"): ONE discreet line under the two amounts, before Advanced, only
 * when Domino's service read something to bring on another network: the token's mark with a small arrow (she has a token
 * there, and it will be bridged), what she has and where, about how much in USD from a qualified price, and "Bring it
 * here". Nothing at all when every network read is empty. Changed on purpose 2026-10-06 (the review): the token's mark by
 * its address (TokenMark: bundled art for ETH, WETH and USDG, a calm disc otherwise), never a file named after a symbol.
 * Changed on purpose 2026-10-06 (the integration review): it names what the click brings, native ETH less the gas Review
 * keeps (sendable), with that part's USD.
 */
function DiscreetLine({ line, onBring }: { line: LineHolding; onBring: () => void }) {
  const amount = holdingText({ ...line.holding, raw: sendable(line.holding) })
  const { chainId, token, symbol, decimals } = line.holding
  // Its markup is ./PayWith.tsx FundsLine since 2026-10-06 (the same line offers paying with one other token), unchanged.
  return (
    <FundsLine
      onClick={onBring}
      data-funds-line={line.chainId}
      data-funds-line-token={line.holding.token}
      data-funds-line-target={line.target}
      mark={
        <>
          <TokenMark token={{ origin: 'read', chainId: line.chainId, address: token, symbol, decimals, readStatus: 'available', artwork: holdingArtwork(chainId, token) }} size={20} />
          <span className="dm-funds-line-arrow">↗</span>
        </>
      }
      text={FUNDS_TEXT.youHave(amount, line.network)}
      extra={line.valueUsd !== null && <> {FUNDS_TEXT.aboutUsd(formatUsd(line.valueUsd))}</>}
      action={FUNDS_TEXT.bringItHere}
    />
  )
}

/**
 * "Bring {token} from {network}" (spec F7 §3, §8.2 S2), inline in New position's amount step: a deposit from another
 * network to the person's OWN wallet on the position's chain, through Relay or Across, quoted by Domino's crosschain-v1
 * service; then the SAME position continues with what arrived. The app never calls Relay or Across.
 *
 * Changed on purpose 2026-10-06 (the owner's points 1, 2, 4 and 7; C:/dwt/v2/PLANO_EXECUCAO_2026-10-06.md, workstream A):
 *   - Before an amount (`discreet`, the owner's own amount step): Domino's service reads the balances on Domino's other
 *     networks as the step opens, silently (read-v6 chain-balances: public chain data, no sign-in, no wallet move), with
 *     the destination's ETH for "Get gas on {destination}". ONE discreet line names what can be brought (DiscreetLine);
 *     clicking it brings everything held there, less the gas Review keeps (the owner's default), signing in only then.
 *   - After an amount the wallet can't fund, even with the swap (./model.ts lackingTokens): the "short" box. Each of
 *     Domino's other networks with what the service read there; a network read as empty is gone; when every network read
 *     is empty, one sentence; a network NOT read keeps its button (the wallet's own read there, never a zero). What is
 *     brought, and as which token, is chosen together (model.ts bringChoice: a holding that covers what the position
 *     lacks first, a plain bridge first); the amount is what the position lacks, sized from the service's own quote so its
 *     guaranteed minimum covers it (one quote, and at most one more; model.ts firstAsk, sizeStep), for another kind of
 *     token too; never everything held once an amount is typed; a holding smaller than the need is said in one line. The
 *     amount step already says the wallet is short (`shortSaid`): the box does not say it again. While a deposit is on its
 *     way, neither the line nor the networks show; once it is settled, the balances are read again.
 *   - The target follows the holding (dollar to the stable, ether to ETH or WETH, else the other token a deposit can
 *     deliver), and the origins listing is asked for that target whenever one is chosen, not only while the wallet lacks.
 *   - The quote card (./QuoteView.tsx): two lines, one button, one live line, the discrete line; the rest in one Details.
 *   - "Change amount": the amount (a new quote by itself after a pause, at most a few a minute), the network and token,
 *     and "Get gas on {destination}" while the destination's ETH is none or unread (never pre-chosen). No provider names,
 *     no bridge slippage (V1's 0.5%), no "Get a quote".
 *   - "Other networks": the listing's other networks with both Relay and Across, for the person to pick, with the amount
 *     typed (the service reads no balance there yet); the wallet moves there only to send.
 *   - A token on a network with no ETH to send it is not offered (said under its button).
 *
 * Changed on purpose 2026-10-06 (the integration review, C:/dwt/v2/estudo-2026-10-06/integration-findings.md):
 *   - a sign-in the person closes ends the wait at once, said calmly with a "Sign in" button; the line, the networks and
 *     Other networks stay usable meanwhile;
 *   - once a network is picked the title names the network alone (the button names what leaves the wallet);
 *   - the sizing keeps a quote's fixed part (Relay's gas top-up) whole, asks a failed first quote again rather than
 *     leaving it unsized, and a quote that still guarantees less than the need says so;
 *   - a range that takes one token alone is brought that token, and "Use" never makes another one the amount's token;
 *   - a held step closes only its own origin; only a deposit that may still arrive here holds every offer back;
 *   - a bridge the listing could not list is said in one line; amounts that leave the wallet, fees and needs round up.
 *
 * `services` (./services.ts): the crosschain-v1 client under a `live` gate, or null under `preview`: the card is then
 * LOCKED and says S2's own plain sentence (decided [owner, 2026-10-02 evening], FUNDS_TEXT.locked); no origins are asked,
 * no quote, no deposit, and no discreet line.
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
  discreet = false,
  shortSaid = false,
  keep = null,
  takes = null,
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
  /** Added 2026-10-06: no amount is typed in the owner's amount step: the discreet line may show. */
  discreet?: boolean
  /** Added 2026-10-06: the amount step already says the wallet is short (PairedAmounts): the box does not repeat it. */
  shortSaid?: boolean
  /** Added 2026-10-06: the typed amount, once the wallet covers it: "Use" after an arrival keeps it. */
  keep?: { side: 0 | 1; text: string; label: string } | null
  /**
   * Added 2026-10-06 (the integration review): the one pool token a range beside today's price takes (lib/create/journey.ts
   * takesOnly), on its `side`, with its symbol; null when the range takes both. What is brought before an amount is that
   * token where a deposit can deliver it, and an arrival of the other one never becomes the amount's token.
   */
  takes?: { side: 0 | 1; symbol: string | null } | null
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
  // Changed on purpose 2026-10-06 (the integration review): a range that takes one token alone is funded in it: the token
  // brought before an amount is that one where a deposit can deliver it (the swap then pays with another kind brought).
  const takenToken = takes === null ? null : (poolTokens[takes.side] ?? null)
  const deliverable = useMemo(() => {
    const taken = takenToken === null ? [] : deliverableTokens(chainId, [takenToken])
    return taken.length > 0 ? taken : deliverableTokens(chainId, poolTokens)
  }, [chainId, poolTokens, takenToken])
  // What the position lacks now, as one key: a new amount typed in the step changes it.
  const lacksKey = lacks.map((l) => `${l.token}:${l.shortRaw ?? ''}`).join('|')

  // What the page's async steps read as it is now (updated after each render, below).
  const latest = useRef<{
    access: string
    list: OriginsList | null
    listTarget: string | null
    gasFlag: boolean
    lacks: readonly Lack[]
    lacksKey: string
    request: CrosschainRequests['quote'] | null
    served: ChainBalancesResponse | null
    servedGen: number
  }>({ access, list: null, listTarget: null, gasFlag: false, lacks, lacksKey, request: null, served: null, servedGen: 0 })

  // Changed only through a live sender (never while the offer is locked).
  const journal = useMemo(() => (live ? browserDepositJournal() : null), [live])
  // ---- the deposits this offer tracks (live chains) ------------------------------------------------------------------
  const [deposits, setDeposits] = useState<TrackedDeposit[]>(() =>
    (journal?.list(chainId, wallet) ?? []).map((record) => ({ record, destinationToken: null, originLabel: null, review: null, journaled: true })),
  )

  const [steps, setSteps] = useState<StepsView>(IDLE_STEPS)
  const [asked, setQuote] = useState<QuoteState>({ state: 'idle' })
  /** Added 2026-10-06: what a one click sized the quote for (a change of the typed amount sizes it again). */
  const [picked, setPicked] = useState<Picked | null>(null)
  /** Added 2026-10-06: "Other networks" chosen: the form offers the listing's other networks. */
  const [otherMode, setOtherMode] = useState(false)
  // Where a one click stands, said in one line; one that came to nothing is forgotten once another amount is typed.
  const [said, setSaid] = useState<{ pick: Pick; at: string } | null>(null)
  const tell = (next: Pick | null) => setSaid(next === null ? null : { pick: next, at: latest.current.lacksKey })
  const pick = said && (said.pick.stage === 'empty' || said.pick.stage === 'failed') && said.at !== lacksKey ? null : (said?.pick ?? null)
  const picking = pick !== null && (pick.stage === 'signing' || pick.stage === 'switching' || pick.stage === 'reading' || pick.stage === 'quoting')

  // The token to bring: the one a choice was made for (the holding's kind, model.ts targetFor), kept while a quote, a
  // pick or a deposit is about it, or until another amount is typed; else the first the position lacks.
  const [kept, setKeptState] = useState<{ token: string; at: string } | null>(null)
  const setKept = (token: string | null) => setKeptState(token === null ? null : { token, at: latest.current.lacksKey })
  const keptOn = kept !== null && (kept.at === lacksKey || asked.state !== 'idle' || steps.running || picking || otherMode || picked !== null || deposits.length > 0)
  const target = keptOn && kept !== null ? kept.token : (lacks[0]?.token ?? null)
  const lack = lacks.find((l) => l.token === target) ?? null
  // What the position lacks now of the token a one click sized its quote for; and that quote, once that token is no longer
  // lacking (the wallet covers the amount typed): no longer offered, nor asked again (Added 2026-10-06).
  const pickedNeed = picked !== null ? (lacks.find((l) => l.token === picked.target)?.shortRaw ?? null) : null
  const obsolete = picked !== null && picked.need !== null && pickedNeed === null && !steps.running
  const choice = useMemo(() => destinationChoices().find((d) => d.chainId === chainId)?.tokens.find((t) => lower(t.address) === target) ?? null, [chainId, target])
  const symbol = choice?.symbol ?? ''

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


  // ---- the balances on the other networks, read by Domino's service (Added 2026-10-06) ------------------------------
  // read-v6's chain-balances (rugged97's item 3): public chain data, no session and no wallet move. Changed on purpose
  // 2026-10-06 (the owner's point 1): read as soon as the amount step opens (`discreet`), not only once the wallet lacks,
  // with the destination's ETH; read again for each pick, so a choice rests on the chain now.
  const transports = useMemo(() => (live ? v2Transports(gate) : null), [live, gate])
  const readServed = useCallback(async (): Promise<ChainBalancesResponse | null> => {
    if (transports === null) return null
    try {
      if (!routeServes(await transports.routeState('readV6'), 'chain-balances')) return null
      const reply = await readChainBalances(transports.read, transports.readRuntime, wallet, balancesRequest(chainId))
      return reply.kind === 'ok' ? reply.body : null
    } catch {
      return null
    }
  }, [transports, wallet, chainId])
  const [served, setServed] = useState<{ key: string; answer: ChainBalancesResponse | null } | null>(null)
  const ownKey = `${wallet}|${chainId}`
  // Changed on purpose 2026-10-06 (the review: after a deposit the line offered the funds just bridged once more): read
  // again, as a new generation, once a deposit or a held step is settled; only the current generation's answer is used.
  const [servedGen, setServedGen] = useState(0)
  const readAgain = useCallback(() => setServedGen((n) => n + 1), [])
  const servedFor = `${ownKey}|${servedGen}`
  const servedKey = live && (discreet || lacks.length > 0 || pick !== null) ? servedFor : null
  useEffect(() => {
    if (servedKey === null) return
    let alive = true
    void readServed().then((answer) => {
      if (alive) setServed((previous) => (answer === null && previous?.key === servedKey && previous.answer !== null ? previous : { key: servedKey, answer }))
    })
    return () => {
      alive = false
    }
  }, [servedKey, readServed])
  const servedHere = served !== null && served.key === servedFor ? served : null
  const servedNow = servedHere?.answer ?? null
  // 'loading' until the first answer (or its absence) for this wallet, chain and generation.
  const servedState: 'loading' | 'read' | 'none' = servedHere === null ? 'loading' : servedHere.answer === null ? 'none' : 'read'
  /** Deposits whose card says nothing more will come of them here (arrived, refunded, stopped for good). */
  const [settled, setSettled] = useState<ReadonlySet<string>>(() => new Set())
  // A deposit this page sent on its way, or a deposit held unsettled for this position's network: what the position
  // lacks may change by itself, so neither the line nor the networks offer anything meanwhile (Added 2026-10-06, the
  // review; model.ts holdOffers). Changed on purpose 2026-10-06 (the integration review): any other held step closes only
  // its own origin (`closed`), as the sender refuses only that one.
  const inFlight = holdOffers(
    deposits.map((d) => ({ sentHere: d.review !== null, hash: d.record.depositTxHash })),
    settled,
    held,
    chainId,
  )
  const closed = useMemo(() => heldOrigins(held), [held])

  // ---- origins (§3.3), asked for the token chosen, with a service to ask and a session ----------------------------
  // Changed on purpose 2026-10-06 (the study's correction): asked whenever a target is chosen, not only while the
  // position lacks (the discreet line opens the offer with nothing lacking). Changed on purpose 2026-10-06 (the review: a
  // run that moved the wallet dropped the card and its notice while the listing was asked again): the listing for this
  // token stays while the one for a new session is on its way.
  const originsKey = target === null ? null : `${chainId}|${target}|${access}`
  const [originsAnswer, setOriginsAnswer] = useState<{ key: string; target: string; value: OriginsState } | null>(null)
  const origins: OriginsState =
    originsAnswer !== null && (originsAnswer.key === originsKey || steps.running || (originsAnswer.target === target && originsAnswer.value.state === 'ok')) ? originsAnswer.value : { state: 'loading' }
  const [featureOff, setFeatureOff] = useState<RequestFailure | null>(null)
  useEffect(() => {
    if (!sessionReady || services === null || target === null || originsKey === null) return
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
        setOriginsAnswer({ key: originsKey, target, value: { state: 'ok', list: outcome.data.origins } })
        return
      }
      attempt += 1
      const failure = requestFailure(outcome.failure, attempt)
      if (failure.featureOff) setFeatureOff(failure)
      setOriginsAnswer({ key: originsKey, target, value: { state: 'failed', failure } })
      if (failure.retryMs !== null) cancelTimer = services.clock.setTimer(() => void ask(), failure.retryMs)
    }
    void ask()
    return () => {
      alive = false
      controller.abort()
      cancelTimer?.()
    }
  }, [sessionReady, services, chainId, target, originsKey])

  const list = origins.state === 'ok' ? origins.list : null
  const name = useMemo(() => naming(list), [list])
  const others = useMemo(() => (list ? otherNetworks(list, chainId) : []), [list, chainId])
  // Added 2026-10-06 (the integration review; spec F7 §3.3 "each provider's availability"): a bridge the listing could not
  // list (busy or unavailable) says so in one line, since the networks and tokens only it bridges are missing meanwhile;
  // nothing while both are listed.
  const downLine = useMemo(() => downText(list), [list])

  // ---- the form ----------------------------------------------------------------------------------------------------
  const [chosenChainId, setOriginChainId] = useState<number | null>(null)
  const [chosenAddress, setOriginAddress] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [gasChosen, setGasChosen] = useState(FUNDS_DESTINATION_GAS_DEFAULT_ON)
  const [readDecimals, setReadDecimals] = useState<{ key: string; decimals: number | null } | null>(null)
  const [nativeRead, setNativeRead] = useState<{ key: string; raw: string } | null>(null)
  /** Added 2026-10-06: the person changed the form themselves (a new quote follows by itself, after a pause). */
  const [touched, setTouched] = useState(false)
  /** Added 2026-10-06: "Change amount" open (it opens by itself when the person must type the amount). */
  const [editOpen, setEditOpen] = useState(false)
  /** Added 2026-10-06: the one line when the holding is smaller than the need, and a quote being sized again. */
  const [shortNote, setShortNote] = useState<string | null>(null)
  const [sizing, setSizing] = useState(false)

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

  // §3.9: the ETH on the position's chain: the amount step's own reading when the pool holds ETH; else the service's
  // (Added 2026-10-06: read with the other networks' balances); else, on a live chain, read through the wallet's provider
  // while the wallet is there; otherwise not known (the person decides).
  const nativeDelivery = target === ZERO
  const servedNative = servedNow ? nativeOn(servedNow, chainId) : null
  const nativeKey = live && !nativeDelivery && nativeOnDestination === null && servedNative === null && walletChainId === chainId ? `${chainId}` : null
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
  const nativeHere = nativeOnDestination ?? (servedNative !== null ? servedNative.toString() : null) ?? (nativeKey !== null && nativeRead?.key === nativeKey ? nativeRead.raw : null)
  const gasOffered = target === null ? null : offerDestinationGas(target, nativeHere)
  const gasFlag = gasOffered !== null && gasChosen

  const amountRaw = listed ? amountRawOf(amount, decimals) : null
  const request =
    listed && originChainId !== null && amountRaw !== null && target !== null
      ? quoteRequestOf({
          originChainId,
          originToken: listed.address,
          destinationChainId: chainId,
          destinationToken: target,
          amountRaw,
          slippageBps: FUNDS_DEFAULT_SLIPPAGE_BPS,
          destinationGas: gasFlag,
        })
      : null
  const requestKey = request && sessionReady ? `${access}|${JSON.stringify(request)}` : null

  // ---- the quote (§3.4, §3.5) ----------------------------------------------------------------------------------------
  // A quote answers the form it was asked for: change the form and it is gone. While the wallet steps run, the form is
  // locked, so the quote they run on stays.
  // A quote sized for a token the position no longer lacks is gone too (Changed on purpose 2026-10-06, the review).
  const quote: QuoteState = (asked.state === 'idle' || asked.key === requestKey || steps.running) && !obsolete ? asked : { state: 'idle' }
  // What a one click sized is due to be sized again: the amount typed in the step changed what the position lacks, or
  // "Get gas on {destination}" changed (Added 2026-10-06, the review: the old quote stayed sendable while it waited).
  const resizeDue = picked !== null && !touched && !steps.running && pickedNeed !== null && pickedNeed > 0n && (pickedNeed !== picked.need || gasFlag !== picked.gas)
  // Added 2026-10-06 (the owner's point 4: a small sign, never a blank): while a new quote is on its way (a change the
  // person made, waiting for its pause; the quote asked; a one click sized again, or due to be), the last one stays,
  // greyed, its button closed.
  const stale = asked.state === 'ok' && !steps.running && !obsolete && (sizing || resizeDue || (touched && requestKey !== null && asked.key !== requestKey)) ? asked : null
  const previous = quote.state === 'loading' ? quote.previous : stale
  useEffect(() => {
    latest.current = { access, list, listTarget: originsAnswer?.value.state === 'ok' ? originsAnswer.target : null, gasFlag, lacks, lacksKey, request, served: servedNow, servedGen }
  })
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

  // Changed on purpose 2026-10-06 (the review: the cap bounded typed changes only): every quote this page asks, on the
  // page clock, so that none goes past FUNDS_TYPED_QUOTES_PER_MINUTE in a minute (model.ts quoteBudgetWait).
  const quotesAsked = useRef<number[]>([])
  const countQuote = useCallback(() => {
    if (services === null) return
    const now = services.clock.monoMs()
    quotesAsked.current = [...quotesAsked.current.filter((at) => now - at < 60_000), now]
  }, [services])

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
          setQuote((before) => ({ state: 'loading', key, note, previous: before.state === 'ok' ? before : before.state === 'loading' ? before.previous : null }))
          // Within the page's few quotes a minute: past them, this one waits until it fits.
          const budgetWait = quoteBudgetWait(quotesAsked.current, services.clock.monoMs())
          if (budgetWait > 0) {
            await new Promise<void>((done) => {
              cancelTimer = services.clock.setTimer(done, budgetWait)
            })
            if (!alive) return
          }
          countQuote()
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
    [services, countQuote],
  )

  // Past its deadline a quote is asked again by itself ("The quote expired. Getting a new one…"), a few times in a row.
  // Not a quote whose deposit was handed to the wallet: that one stays on screen, said as sent.
  const askedHanded = asked.state === 'ok' && handedQuotes.has(quoteKeyOf(asked.quote))
  useEffect(() => {
    if (services === null || asked.state !== 'ok' || steps.running || asked.key !== requestKey || askedHanded || obsolete) return
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
  }, [asked, requestKey, steps.running, askQuote, services, askedHanded, obsolete])

  // Added 2026-10-06 (the review: past the automatic new quotes, "The quote expired." had no way out): "Get a new quote",
  // and the page asks by itself once it is looked at again (the person came back to the tab).
  const renew = () => {
    const wanted = latest.current.request
    if (asked.state !== 'expired' || asked.key !== requestKey || wanted === null || requestKey === null) return
    autoRequotes.current = 0
    setSteps(IDLE_STEPS)
    askQuote(wanted, requestKey, null)
  }
  const renewRef = useRef(renew)
  useEffect(() => {
    renewRef.current = renew
  })
  useEffect(() => {
    if (asked.state !== 'expired' || typeof document === 'undefined') return
    const again = () => {
      if (document.visibilityState === 'visible') renewRef.current()
    }
    document.addEventListener('visibilitychange', again)
    window.addEventListener('focus', again)
    return () => {
      document.removeEventListener('visibilitychange', again)
      window.removeEventListener('focus', again)
    }
  }, [asked.state])

  // Added 2026-10-06 (the owner's point 4: no "Get a quote" button): a change the person makes under "Change amount" asks
  // for its quote by itself, after a pause, within the page's few quotes a minute (model.ts typedQuoteWait).
  useEffect(() => {
    if (!touched || requestKey === null || steps.running || services === null) return
    if (asked.state !== 'idle' && asked.key === requestKey) return
    return services.clock.setTimer(() => {
      const wanted = latest.current.request
      if (!wanted) return
      autoRequotes.current = 0
      setSteps(IDLE_STEPS)
      askQuote(wanted, requestKey, null)
    }, typedQuoteWait(quotesAsked.current, services.clock.monoMs()))
  }, [touched, requestKey, steps.running, services, asked, askQuote])

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
    // What is on each network is read again before anything more is offered (Added 2026-10-06, the review).
    readAgain()
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
    tell(null)
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
        setPicked(null)
        setShortNote(null)
        setTouched(false)
        setEditOpen(false)
        setOtherMode(false)
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
  // One choice at a time: a newer one lets this one go, and the quotes it has in flight stop (Changed on purpose
  // 2026-10-06, the review: a "Get gas" changed again still made its two quotes).
  const pickTurn = useRef(0)
  const pickAbort = useRef<AbortController | null>(null)
  const newTurn = useCallback((): Turn => {
    pickAbort.current?.abort()
    const controller = new AbortController()
    pickAbort.current = controller
    const turn = ++pickTurn.current
    return { alive: () => turn === pickTurn.current, signal: controller.signal }
  }, [])
  useEffect(
    () => () => {
      pickTurn.current += 1
      pickAbort.current?.abort()
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
   * Signed in, through the wallet's own dialog, once (the session then holds across Domino's networks and the deposit's
   * origin). Changed on purpose 2026-10-06 (the integration review: a beginner who closed the dialog met a box with
   * nothing to press for three minutes): the wait ends as soon as the dialog is closed with no session and no signature
   * on its way (SIGN_IN_OPEN_MS, SIGN_IN_GRACE_MS); meanwhile the line, the networks and a "Sign in" button stay usable.
   */
  const signIn = async (chainOf: V2ChainId, alive: () => boolean): Promise<boolean> => {
    const ready = () => latest.current.access.startsWith('ready:')
    if (ready()) return true
    tell({ chainId: chainOf, stage: 'signing' })
    openWalletDialog()
    if (services === null) return false
    const started = services.clock.monoMs()
    const waiting = () => {
      if (!alive()) return false
      if (ready()) return true
      // The dialog open, or the session signing in ('pending': the wallet's own prompt may be open over a closed dialog).
      if (walletDialogOpen() || latest.current.access === 'pending') return true
      return services.clock.monoMs() - started < SIGN_IN_GRACE_MS
    }
    return until(ready, waiting, SIGN_IN_OPEN_MS)
  }
  /** The pick a sign-in stopped, to run again from its "Sign in" button (Added 2026-10-06, the integration review). */
  const lastPick = useRef<{ origin: V2ChainId; named: LineHolding | null } | 'others' | null>(null)

  /**
   * Added 2026-10-06 (the owner's point 2b): the quote for what the position lacks, sized from the service's own quote.
   * Changed on purpose 2026-10-06 (the review of 2026-10-06: for another kind of token the first quote was of everything
   * held there, and it stood): the first quote asks for the need in the token sent, with room for the fees (by decimals
   * for the same kind; for another kind, at the prices Domino's service read, never shown; with none, all that can be
   * sent); then model.ts sizeStep decides between that quote and one more, for the need at its rate, never more than
   * what is held there (the one line then says so). A first ask of everything held never stands as the amount. Each quote
   * within the page's few a minute, and let go with the choice. The form takes the amount chosen ("Change amount").
   */
  const sizeBring = async (p: Picked, need: bigint, gas: boolean, turn: Turn, prices: KindPrices) => {
    if (services === null) return
    const { alive, signal } = turn
    const network = v2Chain(p.origin).name
    const available = sendable(p.holding)
    const needDecimals = destinationChoices().find((d) => d.chainId === chainId)?.tokens.find((t) => lower(t.address) === p.target)?.decimals ?? null
    const requestFor = (raw: bigint) =>
      quoteRequestOf({ originChainId: p.origin, originToken: p.token, destinationChainId: chainId, destinationToken: p.target, amountRaw: raw.toString(), slippageBps: FUNDS_DEFAULT_SLIPPAGE_BPS, destinationGas: gas })
    const keyFor = (wanted: CrosschainRequests['quote']) => `${latest.current.access}|${JSON.stringify(wanted)}`
    const show = (raw: bigint, outcome: QuoteOutcome | null, short: boolean) => {
      setSizing(false)
      // The quote takes over from the pick's own line.
      tell(null)
      const units = fieldUnits(raw, p.decimals)
      if (units === null) return tell({ chainId: p.origin, stage: 'failed', copy: FUNDS_TEXT.readFailed(network), code: 'units' })
      setAmount(units)
      setPicked({ ...p, need, gas })
      setShortNote(short ? FUNDS_TEXT.allYouHave(network) : null)
      const wanted = requestFor(raw)
      autoRequotes.current = 0
      if (outcome && outcome.ok) {
        quoteAsk.current?.()
        setQuote({ state: 'ok', key: keyFor(wanted), quote: outcome.data.quote, timing: outcome.timing, source: outcome.source, request: wanted, note: null })
      } else askQuote(wanted, keyFor(wanted), null)
    }
    // No figure the page can stand behind: the person types the amount.
    const enter = () => {
      setSizing(false)
      setAmount('')
      setEditOpen(true)
      setTouched(true)
      tell({ chainId: p.origin, stage: 'enter' })
    }
    if (available <= 0n) return tell({ chainId: p.origin, stage: 'empty', copy: FUNDS_TEXT.noneThere(p.holding.symbol, network) })
    if (needDecimals === null) return enter()
    const ask = async (raw: bigint): Promise<QuoteOutcome | null> => {
      // Within the page's few quotes a minute: past them, this one waits its turn.
      const wait = quoteBudgetWait(quotesAsked.current, services.clock.monoMs())
      if (wait > 0) await services.wait(wait)
      if (!alive()) return null
      countQuote()
      return services.client.quote(requestFor(raw), { owner: services.owner, signal })
    }
    const first = firstAsk({ need, needDecimals, needKind: kindOf(chainId, p.target), sentDecimals: p.decimals, sentKind: kindOf(p.origin, p.holding.token), available, prices })
    tell({ chainId: p.origin, stage: 'quoting' })
    setSizing(true)
    let probe = await ask(first.amount)
    // A first quote that did not come back is asked again after the page's own wait (said meanwhile), never shown as the
    // amount. Changed on purpose 2026-10-06 (the integration review: a sized first ask that timed out stood on screen as
    // the amount, its quote never sized): a sized first ask as well as one of everything held.
    for (let attempt = 1; probe !== null && !probe.ok && alive(); attempt += 1) {
      const failure = requestFailure(probe.failure, attempt)
      if (failure.featureOff) setFeatureOff(failure)
      if (failure.requote && attempt <= 1) {
        // A quote that came back already expired: asked again at once, as the page's own ask does.
        probe = await ask(first.amount)
        continue
      }
      tell({ chainId: p.origin, stage: 'failed', copy: failure.copy || FUNDS_TEXT.noRoutes, code: failure.code ?? 'quote_failed' })
      if (failure.retryMs === null) {
        // Nothing will help by itself: said, with no quote left standing for another amount; the person picks again.
        quoteAsk.current?.()
        setQuote({ state: 'idle' })
        setPicked(null)
        return setSizing(false)
      }
      await services.wait(failure.retryMs)
      if (!alive()) return
      tell({ chainId: p.origin, stage: 'quoting' })
      probe = await ask(first.amount)
    }
    if (probe === null || !alive() || !probe.ok) return
    // The part of the quote that does not shrink with the amount (Relay's gas top-up) is kept whole (model.ts fixedFeeOf).
    const step = sizeStep({ need, asked: first.amount, available, minimum: winningMinimum(probe.data.quote), blind: first.blind, fee: fixedFeeOf(probe.data.quote) })
    if (step.step === 'enter') return enter()
    if (step.step === 'show') return show(first.amount, probe, step.short)
    const final = await ask(step.amount)
    if (final === null || !alive()) return
    show(step.amount, final, step.short)
  }
  const sizeRef = useRef(sizeBring)
  useEffect(() => {
    sizeRef.current = sizeBring
  })

  /**
   * The person picked a network (or the discreet line's holding): what is there, from Domino's service (else, signed in,
   * from the wallet's own read on that network), what to bring and as which token (model.ts bringChoice, the owner's
   * target rule), signed in if needed (the wallet's own dialog, once), the listing for that token, then the quote: before
   * an amount, everything held there less the gas Review keeps (the owner's default); after one, what the position lacks,
   * sized from the service's quote; with no figure, the amount field opens for the person. What comes back is the quote
   * and its one button.
   */
  const bringFrom = async (origin: V2ChainId, named: LineHolding | null = null) => {
    if (!live || services === null || steps.running) return
    const turn = newTurn()
    const { alive } = turn
    lastPick.current = { origin, named }
    const network = v2Chain(origin).name
    const fail = (copy: string, code: string) => {
      if (alive()) tell({ chainId: origin, stage: 'failed', copy, code })
    }
    const empty = (copy: string, down = false) => {
      if (alive()) tell({ chainId: origin, stage: 'empty', copy, down })
    }
    quoteAsk.current?.()
    setQuote({ state: 'idle' })
    setSteps(IDLE_STEPS)
    setTouched(false)
    setEditOpen(false)
    setOtherMode(false)
    setPicked(null)
    setShortNote(null)
    setSizing(false)
    const candidate = CANDIDATE_ORIGINS.find((c) => c.chainId === origin)
    if (!candidate) return fail(FUNDS_TEXT.readFailed(network), 'no_candidate')
    const tokensWords = FUNDS_TEXT.orList(candidate.tokens.map((t) => t.symbol))
    // 1. What is there now, as Domino's service reads it; Changed on purpose 2026-10-06 (the review): the line's holding
    //    too, which may have gone since the line was drawn. Else the line's own; else the wallet's own read there.
    tell({ chainId: origin, stage: 'reading' })
    const fresh = await readServed()
    if (!alive()) return
    if (fresh) setServed({ key: `${ownKey}|${latest.current.servedGen}`, answer: fresh })
    const report = fresh ? holdingsFromChainBalances(fresh, candidate) : null
    let holdings: Holding[] | null = null
    if (fresh && report) {
      const { usable, gasless } = usableHoldings(report.holdings, nativeOn(fresh, origin))
      if (named) {
        const now = usable.find((h) => h.token === named.holding.token)
        const dry = gasless.find((h) => h.token === named.holding.token)
        if (now) holdings = [now]
        else if (dry) return empty(FUNDS_TEXT.noGasThere(holdingText(dry), network))
        else if (report.unread.includes(named.holding.symbol)) holdings = [named.holding]
        else return empty(FUNDS_TEXT.noneThere(named.holding.symbol, network))
      } else if (usable.length > 0) holdings = usable
      else if (report.unread.length > 0) return fail(FUNDS_TEXT.readFailed(network), 'read_partial')
      else if (gasless.length > 0) return empty(FUNDS_TEXT.noGasThere(FUNDS_TEXT.orList(gasless.map(holdingText)), network))
      else return empty(FUNDS_TEXT.noneThere(tokensWords, network))
    } else if (named) holdings = [named.holding]
    if (holdings === null) {
      // The wallet's own read there: signed in first (sign-in starts on Robinhood Chain only), then the wallet moves.
      if (!(await signIn(origin, alive))) return fail(FUNDS_TEXT.signInFirst, 'signed_out')
      if (walletChain.current !== origin) {
        tell({ chainId: origin, stage: 'switching' })
        const switched = await switchToChain(origin)
        if (!alive()) return
        if (switched !== 'switched') return fail(switched === 'unknown_chain' ? fill(ADD_ORIGIN, { origin: network }) : v2SwitchNotice(switched, network), `switch_${switched}`)
        // The session held there (session/machine.ts heldAway) is ready again once the move settles.
        if (!(await until(() => latest.current.access.startsWith('ready:'), alive, 20_000))) return fail(FUNDS_TEXT.signInFirst, 'signed_out')
      }
      tell({ chainId: origin, stage: 'reading' })
      let report
      try {
        report = await readHoldingsReport(await browserOriginWallet(), candidate)
      } catch {
        return fail(FUNDS_TEXT.readFailed(network), 'read_failed')
      }
      if (!alive()) return
      // A balance that could not be read is never said to be zero.
      if (report.holdings.length === 0) return report.unread.length > 0 ? fail(FUNDS_TEXT.readFailed(network), 'read_partial') : empty(FUNDS_TEXT.noneThere(tokensWords, network))
      const native = report.holdings.find((h) => h.token === ZERO)?.raw ?? (report.unread.includes('ETH') ? null : 0n)
      const { usable, gasless } = usableHoldings(report.holdings, native)
      if (usable.length === 0) return gasless.length > 0 ? empty(FUNDS_TEXT.noGasThere(FUNDS_TEXT.orList(gasless.map(holdingText)), network)) : empty(FUNDS_TEXT.noneThere(tokensWords, network))
      holdings = usable
    }
    // 2. What to bring and as which token: the line's holding, as the pool token of its kind; else, Changed on purpose
    //    2026-10-06 (the review: a little ETH was brought while the USDC there covered the position), the lack and the
    //    holding chosen together (model.ts bringChoice: one that covers what the position lacks first, a plain bridge first).
    const prices = kindPrices(fresh ?? latest.current.served)
    const choice = named ? { lack: null, holding: holdings[0], target: named.target } : bringChoice({ lacks: latest.current.lacks, holdings, destination: chainId, origin, deliverable, prices })
    if (choice === null) return empty(FUNDS_TEXT.notBridged(network))
    const wanted = choice.target
    const lackNow = choice.lack
    setKept(wanted)
    // 3. Signed in (the listing and the quote need it), then the listing for that token.
    if (!(await signIn(origin, alive))) return fail(FUNDS_TEXT.signInFirst, 'signed_out')
    tell({ chainId: origin, stage: 'quoting' })
    if (!(await until(() => latest.current.list !== null && latest.current.listTarget === wanted, alive, 20_000))) return fail(FUNDS_TEXT.noRoutes, 'origins_unavailable')
    const listing = latest.current.list
    if (!alive() || listing === null) return
    // 4. What to send: the holding chosen, where the listing bridges it; else the best one it does for that token.
    const needRaw = lackNow?.shortRaw ?? null
    const holding = originToken(listing, origin, choice.holding.token)
      ? choice.holding
      : named
        ? null
        : holdingFor(holdings, wanted, chainId, origin, listing, needRaw !== null && lackNow ? { raw: needRaw, decimals: lackNow.decimals } : null)
    // A bridge the listing could not list is said too (Changed on purpose 2026-10-06, the integration review).
    const down = downText(listing)
    const notBridged = down === null ? FUNDS_TEXT.notBridged(network) : `${FUNDS_TEXT.notBridged(network)} ${down}`
    if (!holding) return empty(notBridged, down !== null)
    const sent = originToken(listing, origin, holding.token)
    if (!sent) return empty(notBridged, down !== null)
    const available = sendable(holding)
    if (available <= 0n) return empty(FUNDS_TEXT.noneThere(tokensWords, network))
    // The form takes what was chosen (the person may change it under "Change amount").
    setOriginChainId(origin)
    setOriginAddress(lower(sent.address))
    // The listing may not say the token's decimals; the network's own currency says them (Added 2026-10-06: the wallet
    // need not be there to read them).
    if (!knownDecimals(sent.decimals)) setReadDecimals({ key: `${origin}:${lower(sent.address)}`, decimals: holding.decimals })
    const p: Picked = { origin, holding, token: lower(sent.address), decimals: holding.decimals, target: wanted, need: null, gas: latest.current.gasFlag }
    const typed = !named && latest.current.lacks.length > 0
    if (typed && (needRaw === null || needRaw <= 0n)) {
      // No figure (the zap path's alternatives, no price for the swap): never everything held; the person types it.
      setAmount('')
      setEditOpen(true)
      setTouched(true)
      return tell({ chainId: origin, stage: 'enter' })
    }
    if (!typed || needRaw === null) {
      // Before an amount: everything held there, less the gas Review keeps (the owner's default).
      const units = fieldUnits(available, holding.decimals)
      if (units === null) return fail(FUNDS_TEXT.readFailed(network), 'units')
      setAmount(units)
      setPicked(p)
      const wantedRequest = quoteRequestOf({ originChainId: origin, originToken: sent.address, destinationChainId: chainId, destinationToken: wanted, amountRaw: available.toString(), slippageBps: FUNDS_DEFAULT_SLIPPAGE_BPS, destinationGas: latest.current.gasFlag })
      autoRequotes.current = 0
      tell(null)
      return askQuote(wantedRequest, `${latest.current.access}|${JSON.stringify(wantedRequest)}`, null)
    }
    await sizeBring(p, needRaw, latest.current.gasFlag, turn, prices)
  }

  // Added 2026-10-06 (the owner's point 2b): a quote a one click sized follows the typed amount: when what the position
  // lacks changes (the person typed another amount, or typed one after the discreet line), or "Get gas on {destination}"
  // does (Changed on purpose 2026-10-06, the review: through the same pause and the same cap), it is sized again.
  useEffect(() => {
    if (!resizeDue || picked === null || pickedNeed === null || services === null || asked.state === 'loading') return
    const turn = newTurn()
    const gas = gasFlag
    return services.clock.setTimer(() => void sizeRef.current(picked, pickedNeed, gas, turn, kindPrices(latest.current.served)), typedQuoteWait(quotesAsked.current, services.clock.monoMs()))
  }, [resizeDue, picked, pickedNeed, gasFlag, services, asked.state, newTurn])

  /** "Get gas on {destination}" changed (§3.9): a quote a one click sized for the need is sized again with it (above); any other is asked again as it is. */
  const chooseGas = (chosen: boolean) => {
    setGasChosen(chosen)
    if (picked === null || picked.need === null || touched) {
      setSizing(false)
      setTouched(true)
    }
  }

  /** The person changed the form: what a one click chose is theirs now, and its quote follows by itself (Added 2026-10-06). */
  const edited = () => {
    newTurn()
    setPicked(null)
    setShortNote(null)
    setSizing(false)
    setTouched(true)
  }

  /** "Other networks" (Added 2026-10-06, the owner's point 2a): the listing's other networks, for the person to pick. */
  const openOthers = async () => {
    if (!live || services === null || steps.running || target === null) return
    const { alive } = newTurn()
    lastPick.current = 'others'
    quoteAsk.current?.()
    setQuote({ state: 'idle' })
    setSteps(IDLE_STEPS)
    setPicked(null)
    setShortNote(null)
    setSizing(false)
    tell(null)
    setKept(target)
    setOriginChainId(null)
    setOriginAddress(null)
    setAmount('')
    if (!(await signIn(chainId, alive))) {
      if (alive()) tell({ chainId, stage: 'failed', copy: FUNDS_TEXT.signInFirst, code: 'signed_out' })
      return
    }
    if (!alive()) return
    tell(null)
    setOtherMode(true)
    setEditOpen(true)
    setTouched(true)
  }

  // A pick under way, while no quote is on screen yet. Changed on purpose 2026-10-06 (the integration review): never one
  // waiting for a sign-in: another network or the line may be chosen meanwhile (the newer choice lets it go).
  const pickBusy = picking && pick?.stage !== 'signing' && (pick?.stage !== 'quoting' || quote.state === 'idle')

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
      case 'enter':
        return FUNDS_TEXT.enterAmount
      case 'empty':
      case 'failed':
        return current.copy
    }
  }

  // ---- what is drawn -----------------------------------------------------------------------------------------------
  // A pick that came to nothing, said in its line (Changed on purpose 2026-10-06, the review: before an amount the line
  // stayed hidden behind it, with no way to try again): nothing of the page's own is under way any more.
  const pickDone = pick !== null && (pick.stage === 'failed' || pick.stage === 'empty')
  // Something of this page's own under way: a pick, a quote, the wallet's steps, Other networks.
  const ownWay = steps.running || quote.state !== 'idle' || (pick !== null && !pickDone) || otherMode
  // Changed on purpose 2026-10-06: a deposit or a held step this browser follows keeps the box drawn even when nothing is
  // lacking (the amount step reads its balances again as one arrives, and nothing lacks while it reads: the card must not
  // be dropped and drawn again then, or its arrival would be told, and the balances read, once more).
  const underWay = ownWay || heldNotice !== null || held.length > 0 || deposits.length > 0
  // A pick waiting for a sign-in leaves the line usable (Changed on purpose 2026-10-06, the integration review).
  const signing = pick?.stage === 'signing' && quote.state === 'idle' && !steps.running && !otherMode
  // Before an amount, the discreet line (or nothing); never while the offer is locked, nor beside a pick or a quote, nor
  // while a deposit is on its way (Changed on purpose 2026-10-06, the review: it named the funds just bridged once more);
  // never from an origin a held step keeps closed (Changed on purpose 2026-10-06, the integration review).
  const line = discreet && live && lacks.length === 0 && (!ownWay || signing) && !inFlight && servedNow ? bestHolding(servedNow, chainId, deliverable, closed) : null
  const lineView = line ? <DiscreetLine line={line} onBring={() => void bringFrom(line.chainId, line)} /> : null
  // A sign-in the person has not given yet (Added 2026-10-06, the integration review): said calmly, never as an error, with
  // a button that opens the wallet's dialog while the pick waits, or runs the pick again once the wait is over.
  const signedOut = pick !== null && pick.stage === 'failed' && pick.code === 'signed_out'
  const pickClass = (current: Pick) => (current.stage === 'failed' && !signedOut ? 'dm-error' : current.stage === 'signing' ? 'dm-funds-status' : 'dm-hint')
  const signInAgain = () => {
    const last = lastPick.current
    if (last === 'others') void openOthers()
    else if (last !== null) void bringFrom(last.origin, last.named)
  }
  const signInButton =
    pick !== null && (pick.stage === 'signing' || signedOut) ? (
      <Button variant="outline" size="sm" onClick={() => (pick.stage === 'signing' ? openWalletDialog() : signInAgain())} data-funds-pick-sign-in={pick.stage}>
        {FUNDS_TEXT.signIn}
      </Button>
    ) : null
  if (lacks.length === 0 && !underWay) {
    if (!pickDone || pick === null || !discreet) return lineView
    // What the line's pick came to, under it; the line itself is the way to try again.
    return (
      <div className="grid gap-2">
        {lineView}
        <div className="dm-funds-pick-row">
          <p role="status" className={pickClass(pick)} data-funds-pick={pick.stage} data-funds-pick-network={pick.chainId} data-error-code={pick.stage === 'failed' ? pick.code : undefined}>
            {pickWords(pick)}
          </p>
          {signInButton}
        </div>
      </div>
    )
  }

  const busy = steps.running
  const sources = SOURCE_CHAINS.filter((id) => id !== chainId)
  // Changed on purpose 2026-10-06 (the integration review): a network a held step keeps closed is not offered; the others
  // are, with Other networks.
  const open = sources.filter((id) => !closed.has(id))
  const holdsOf = (id: V2ChainId): NetworkHolds => {
    const candidate = CANDIDATE_ORIGINS.find((c) => c.chainId === id)
    return candidate ? networkHolds(servedNow, candidate) : { state: 'unread' }
  }
  const networks = open.map((id) => ({ id, holds: holdsOf(id) })).filter((n) => n.holds.state !== 'empty')
  // What can be sent there (Changed on purpose 2026-10-06, the integration review: native ETH less the gas Review keeps).
  const holdsText = (holds: NetworkHolds): string | null =>
    holds.state === 'holds'
      ? FUNDS_TEXT.holdsThere(holds.holdings.map((h) => holdingText({ ...h, raw: sendable(h) })), holds.usd !== null ? formatUsd(holds.usd) : null)
      : holds.state === 'no_gas'
        ? FUNDS_TEXT.noGasHint(FUNDS_TEXT.orList(holds.holdings.map(holdingText)))
        : null
  // The networks to choose from: while nothing else is on screen (no quote, none coming, no form the person is filling),
  // and no deposit is on its way (Changed on purpose 2026-10-06, the review: their balances are about to change).
  const showSources = lacks.length > 0 && !inFlight && !steps.running && quote.state === 'idle' && previous === null && !otherMode && pick?.stage !== 'enter' && !(touched && originChainId !== null)
  // Change amount: beside a quote (or one coming), or while the person fills it.
  const showEdit = originChainId !== null && !steps.running && !(otherMode && quote.state === 'idle') && (quote.state !== 'idle' || previous !== null || touched || pick?.stage === 'enter')
  // The form's networks: Domino's own the listing bridges, then, with "Other networks", the listing's others.
  const ownChains = (list?.chains ?? []).filter((c) => SOURCE_CHAINS.includes(c.chainId as V2ChainId) && c.chainId !== chainId).map((c) => ({ chainId: c.chainId, name: name.origin(c.chainId) ?? c.name }))
  const formChains = [...ownChains, ...others.map((o) => ({ chainId: o.chainId, name: o.name }))]
  // On Domino's own networks, their ETH, WETH and stable the listing bridges; elsewhere, the listing's tokens (otherNetworks).
  const ownTokens = (id: number) => (CANDIDATE_ORIGINS.find((c) => c.chainId === id)?.tokens ?? []).filter((t) => list !== null && originToken(list, id, t.address) !== null).map((t) => ({ address: lower(t.address), label: t.symbol }))
  const formTokens = originChainId === null ? [] : (others.find((o) => o.chainId === originChainId)?.tokens ?? ownTokens(originChainId))
  const unit = listed ? (cleanSymbol(listed.symbol) ?? `${listed.address.slice(0, 6)}…${listed.address.slice(-4)}`) : ''
  // What is still needed, rounded UP (Changed on purpose 2026-10-06, the integration review): bringing the figure shown
  // with another service never leaves the position short.
  const shortText = lack && lack.shortRaw !== null && lack.shortRaw > 0n ? shortAmountText(lack.shortRaw.toString(), lack.token, { symbol, decimals: lack.decimals }, 'up') : null
  const shownQuote = quote.state === 'ok' && !sizing ? quote : previous
  const gasInCard = gasOffered === 'suggested' ? { destination: chain.name, chosen: gasChosen, disabled: busy || quote.state === 'loading', onChange: chooseGas } : null
  // Added 2026-10-06 (the integration review): a quote a one click sized whose guaranteed minimum is below what the
  // position lacks says so in one line (the holding being all there is says it its own way).
  const sizedMinimum = picked !== null && picked.need !== null && quote.state === 'ok' && !sizing && lower(quote.quote.request.destinationToken) === picked.target ? winningMinimum(quote.quote) : null
  const shortView =
    shortNote !== null
      ? { text: shortNote, kind: 'holding' as const }
      : sizedMinimum !== null && picked !== null && picked.need !== null && sizedMinimum < picked.need
        ? { text: FUNDS_TEXT.bringsLess, kind: 'quote' as const }
        : null
  // The deposits followed here: "On the way" only while one may still arrive here (Changed on purpose 2026-10-06, the
  // integration review: an arrived card sat under it, and so it did beside a held approval, where nothing moves, or a
  // deposit held for another network): one not settled yet, or one held for this network (model.ts heldMayArrive).
  const following = deposits.some((d) => !settled.has(d.record.depositTxHash)) || heldMayArrive(held, chainId)
  // A bridge the listing could not list, said once: beside the networks or the form, unless the pick's own line says it.
  const downSaid = pick !== null && pick.stage === 'empty' && pick.down === true && quote.state === 'idle' && !steps.running
  const downView =
    downLine !== null && !downSaid ? (
      <p className="dm-hint" data-funds-providers="">
        {downLine}
      </p>
    ) : null

  const form = (
    <div className="dm-funds-form" data-funds-origins={origins.state}>
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
      {downView}
      {list && (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="dm-acct-lf">
            <span className="dm-label">{FUNDS_TEXT.network}</span>
            <Select<string>
              id="funds-origin-chain"
              label={FUNDS_TEXT.network}
              value={originChainId === null ? '' : String(originChainId)}
              options={[
                { value: '', label: FUNDS_TEXT.chooseNetwork },
                // Domino's own networks first, then, apart, the other networks (Added 2026-10-06).
                ...formChains.map((c, index) => ({ value: String(c.chainId), label: <span data-funds-origin-chain={c.chainId}>{c.name}</span>, separatorAfter: index === ownChains.length - 1 && others.length > 0 })),
              ]}
              onChange={(next) => {
                if (busy) return
                const id = next === '' ? null : Number(next)
                // One of Domino's networks: the same as its button, the rest done by itself (Changed on purpose 2026-10-06).
                if (id !== null && SOURCE_CHAINS.includes(id as V2ChainId)) return void bringFrom(id as V2ChainId)
                setOriginChainId(id)
                setOriginAddress(null)
                setAmount('')
                edited()
                if (target !== null) setKept(target)
              }}
            />
          </div>
          {originChainId !== null && (
            <div className="dm-acct-lf">
              <span className="dm-label">{FUNDS_TEXT.token}</span>
              {formTokens.length === 0 ? (
                <span className="text-caption text-fg-muted">{FUNDS_TEXT.noTokens}</span>
              ) : (
                <Select<string>
                  id="funds-origin-token"
                  label={FUNDS_TEXT.token}
                  value={originAddress === null ? '' : lower(originAddress)}
                  options={[
                    { value: '', label: FUNDS_TEXT.chooseToken },
                    ...formTokens.map((t) => ({ value: t.address, label: <span data-funds-origin-token={t.address}>{t.label}</span> })),
                  ]}
                  onChange={(next) => {
                    if (busy) return
                    setOriginAddress(next === '' ? null : next)
                    // Another token: the person says how much of it (an amount in one token never stands for another).
                    setAmount('')
                    edited()
                  }}
                />
              )}
            </div>
          )}
        </div>
      )}
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
            onChange={(event) => {
              setAmount(event.target.value)
              edited()
            }}
          />
          {live && decimals === null && originChainId !== null && walletChainId !== originChainId && listedAddress !== ZERO && (
            <Button variant="secondary" size="sm" className="justify-self-start" disabled={busy} onClick={() => void switchToOrigin(originChainId)}>
              {FUNDS_TEXT.readDecimals(originWords(originChainId))}
            </Button>
          )}
        </div>
      )}
      {/* §3.9 rev2: with no balance read, shown for the person to decide; never pre-chosen. When the balance reads none, it is in the card. */}
      {gasOffered === 'undecided' && listed && (
        <div className="grid gap-1" data-funds-destination-gas={gasOffered}>
          <label className="dm-acct-check">
            <input type="checkbox" checked={gasChosen} disabled={busy} onChange={(event) => chooseGas(event.target.checked)} />
            {FUNDS_TEXT.gasOffer(chain.name)}
          </label>
          <p className="dm-hint">{FUNDS_TEXT.gasUnread(chain.name)}</p>
        </div>
      )}
    </div>
  )

  return (
    <>
      {lineView}
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
            <h4 data-funds-title="">{FUNDS_TEXT.title(symbol || 'funds', network)}</h4>
            {/* The zap path has no amount step's own line: the shortfall is said here once. */}
            {lack && !shortSaid && (
              <p data-funds-lack={shortText !== null ? 'short' : lack.haveRaw === 0n ? 'none' : 'swap'}>
                {shortText !== null ? FUNDS_TEXT.youNeed(shortText, chain.name) : onUseToken ? FUNDS_TEXT.asNewDeposit(symbol) : lack.haveRaw === 0n ? FUNDS_TEXT.holdsNone(symbol, chain.name) : FUNDS_TEXT.cantFund(chain.name)}
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
                {/* The one choice (Changed on purpose 2026-10-05): a network; signing in, the balance, the token and the
                    amount follow by themselves (bringFrom). Changed on purpose 2026-10-06: what the service read, a network
                    read as empty gone, one sentence when every network read is empty, and "Other networks". */}
                {showSources && (
                  <div className="grid gap-2" data-funds-sources="" data-funds-served={servedState}>
                    {servedState === 'loading' ? (
                      <p role="status" className="dm-funds-status" data-funds-checking="">
                        {FUNDS_TEXT.checkingNetworks}
                      </p>
                    ) : networks.length === 0 ? (
                      open.length > 0 && (
                        <p className="text-body text-fg-muted" data-funds-nothing="">
                          {FUNDS_TEXT.nothingElsewhere(FUNDS_TEXT.orList(open.map((id) => v2Chain(id).name)))}
                        </p>
                      )
                    ) : (
                      <>
                        <p className="text-body">{FUNDS_TEXT.bringFrom}</p>
                        <div className="dm-funds-networks">
                          {networks.map(({ id, holds }) => {
                            const words = holdsText(holds)
                            return (
                              <div key={id} className="dm-funds-network">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant={pick?.chainId === id ? 'secondary' : 'outline'}
                                  aria-pressed={pick?.chainId === id}
                                  disabled={pickBusy || holds.state === 'no_gas'}
                                  onClick={() => void bringFrom(id)}
                                  data-funds-network={id}
                                  data-funds-holds={holds.state}
                                >
                                  {v2Chain(id).name}
                                </Button>
                                {words && (
                                  <span className={holds.state === 'no_gas' ? 'dm-hint' : 'dm-hint tnum'} data-funds-network-holds={id} data-funds-holds={holds.state === 'holds' ? 'holds' : 'no_gas'}>
                                    {words}
                                  </span>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </>
                    )}
                    {servedState !== 'loading' && downView}
                    {servedState !== 'loading' && (
                      <button type="button" className="dm-funds-more" disabled={pickBusy} onClick={() => void openOthers()} data-funds-other="">
                        {FUNDS_TEXT.otherNetworks}
                      </button>
                    )}
                  </div>
                )}
                {pick && quote.state === 'idle' && !steps.running && (
                  <div className="dm-funds-pick-row">
                    <p
                      role="status"
                      className={pick.stage === 'failed' ? pickClass(pick) : picking ? 'dm-funds-status' : 'text-body text-fg-muted'}
                      aria-busy={pickBusy || undefined}
                      data-funds-pick={pick.stage}
                      data-funds-pick-network={pick.chainId}
                      data-error-code={pick.stage === 'failed' ? pick.code : undefined}
                    >
                      {pickWords(pick)}
                    </p>
                    {signInButton}
                  </div>
                )}
                {(deposits.length > 0 || held.length > 0 || heldNotice !== null) && (
                  <section className="grid gap-3" data-funds-deposits="">
                    {following && <h4 className="dm-subtitle">{FUNDS_TEXT.onTheWay}</h4>}
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
                          // Its deposit may have gone: what is there is read again before anything is offered.
                          readAgain()
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
                        keep={keep}
                        takes={takes}
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
                        onSettled={() => {
                          // Nothing more comes of it here: what is on each network is read again (Added 2026-10-06, the review).
                          setSettled((previous) => new Set(previous).add(d.record.depositTxHash))
                          readAgain()
                        }}
                      />
                    ))}
                  </section>
                )}

                {otherMode && quote.state === 'idle' && !steps.running && (
                  <div className="grid gap-3" data-funds-others="">
                    <p className="text-body">{FUNDS_TEXT.otherNetworks}</p>
                    {form}
                  </div>
                )}

                {(quote.state === 'loading' || previous !== null) && (
                  <p role="status" className="dm-funds-status" data-funds-quote-loading="">
                    {quote.state === 'loading' ? (quote.note ?? FUNDS_TEXT.quoting) : FUNDS_TEXT.quoting}
                  </p>
                )}
                {quote.state === 'failed' && quote.failure.copy && (
                  <p role="alert" className="dm-error" data-error-code={quote.failure.code ?? undefined} data-funds-quote-error="">
                    {quote.failure.copy}
                  </p>
                )}
                {quote.state === 'expired' && (
                  <div className="grid gap-2 justify-items-start" data-funds-quote-expired="">
                    <p role="status" className="text-body">
                      {FUNDS_TEXT.quoteExpired}
                    </p>
                    <Button variant="secondary" size="sm" onClick={renew} data-funds-renew="">
                      {FUNDS_TEXT.renewQuote}
                    </Button>
                  </div>
                )}
                {shownQuote && (
                  <div className={previous ? 'dm-funds-quote-wrap dm-funds-stale' : 'dm-funds-quote-wrap'} aria-busy={previous ? true : undefined} data-funds-quote-stale={previous ? '' : undefined}>
                    <QuoteView
                      quote={shownQuote.quote}
                      name={name}
                      note={previous ? null : shownQuote.note}
                      steps={previous ? IDLE_STEPS : steps}
                      handedOver={handedOver(shownQuote.quote)}
                      locked={locked}
                      waiting={previous !== null}
                      gas={gasInCard}
                      short={previous ? null : shortView}
                      onDeposit={() => void deposit()}
                      onForget={() => void forgetHeld(shownQuote.quote.request.originChainId)}
                    />
                  </div>
                )}

                {/* Once a network is chosen, its transfer can be changed; a change asks for its quote by itself. */}
                {showEdit && (
                  <details
                    className="dm-details dm-funds-details dm-funds-edit"
                    data-funds-edit=""
                    open={editOpen || pick?.stage === 'enter' || undefined}
                    onToggle={(event) => setEditOpen((event.currentTarget as HTMLDetailsElement).open)}
                  >
                    <summary>{FUNDS_TEXT.changeTransfer}</summary>
                    {form}
                  </details>
                )}
              </>
            )
          )}
        </div>
      </section>
    </>
  )
}
