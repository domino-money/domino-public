import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, LinkButton } from '../../components/ui'
import { ActionSheet, SheetAlert, SheetCard, SheetFact, SheetFacts, SheetLocked, SheetMore, SheetNote, SheetStatus } from '../../components/positions/ActionSheet'
import { AUTO_EXIT_TEXT, autoExitWarnings, type AutoExitTextKey, type MandateBatch, type MandateReview, type ProtectBatch } from '../../finance/v2/autoExit'
import type { VaultCreateRequest, VaultCreateReview } from '../../finance/v2/vault'
import type { V2Gate } from '../../v2/gate'
import type { Address, Dex, V2ChainId } from '../../v2/types'
import { describeError, errorLabels, PROTECTION_CONSENT_TEXT, STEPS_INSTEAD, type ErrorView } from '../automate/copy'
import { protectionSettings } from '../automate/form'
import { openAutomation, type AutomationSession } from '../automate/session'
import { recordVaultEvents, rememberMandate, rememberVault } from '../automate/store'
import { useStepsRun, WalletSteps, type WalletStep } from '../automate/steps'
import { dateWords, shortAddress, type TokenView } from '../automate/tokens'
import { Fact } from '../automate/ui'
import { AUTO_EXIT_DEFAULT_SLIPPAGE_BPS, AUTO_EXIT_PROTECTION_ONLY_TEXT } from './constants'
import { autoExitTerms, edgePrice, exitEdges, nearEdge, type EdgesProblem, type ExitEdges, type ExitRange } from './form'
import { defaultOrientation } from './orientation'
import { freshSqrtPrice, snapshotSqrtPrice, type ExitPriceSnapshot } from './priceContext'
import { edgesOf, runLine, unitWords } from './words'

/**
 * Auto-exit on a position (spec F7 §4.2–§4.4, §4.6, §4.7, §8.2; decisions #18, #19, #20, #25), in the look of the position
 * page's action dialogs.
 *
 * Changed on purpose 2026-10-06 (the owner's point 5; rugged97: "this stop loss-take profit product was named wrong. It
 * is AUTO-EXIT. Someone makes an LP to buy or sell; when the price hits the edge of the range we close the position
 * automatically and send the tokens to the wallet. It must be automatic. Auto-exit has no fee compounding"): no price is
 * typed, no shortcut, no units to turn round. The dialog says in one sentence what happens, shows the range's edges it
 * closes at (./form.ts: both while the price is inside the range; only the far one for a position born beside the
 * price), the 0.2% fee at exit, and ONE button, "Turn on Auto-exit". Everything else, the §4.7 warnings, the fixed terms
 * (both tokens, 1% slippage on top of the pool fee, a year's validity), each trigger as the wallet shows it (decision #20)
 * and the wallet's steps, is under ONE Details. Pressing the button is the acknowledgement: nothing is signed before it.
 *
 * Changed on purpose 2026-10-06 (the review of point 5: an edge the price has already crossed closes the position at
 * once, with the fee): the edges a review arms are chosen against the pool's own price, read on chain through the wallet
 * once the session is open (finance/v2/autoExit.ts readPoolPrice), never against the page's read; the client reads it
 * again at the review, before the signature and before the batch, and refuses an edge it has reached
 * (`mandate_trigger_reached`): the dialog then reads the price again and, once something was signed, asks for a new
 * signature. The page's own current price only fills the card until then; under the gate's `preview`, where no wallet
 * is asked anything, the page's price (even a saved one) is all there is. The card says the price now, and one line
 * warns when an edge is within the 1% slippage band of it. A range that covers every price the pool allows has nothing
 * to close at: said, with no button.
 *
 * The wallet (spec §4.4, with today's contracts; the study p5-auto-exit.md, "activation"):
 *   - a plain position: the order signed for the vault the wallet's next createVault makes, then ONE EIP-5792 batch,
 *     approve + createVault (the protection-only vault: paused, Auto-compound's mode with one position, never
 *     reinvesting) + setExitModule + registerMandate. A signature plus one confirmation; without batching, the same calls
 *     one by one;
 *   - a position already in its protection-only vault: the signature, then the registration (with the module turned on in
 *     the same batch when it is off).
 * While a step is with the wallet, ONE line says where it stands ("Step 1 of 2 · Sign in your wallet"). Under the gate's
 * `preview` the dialog stops before the wallet: the gate's sentence stands where the button would be.
 */

export interface ExitTarget {
  chainId: V2ChainId
  dex: Dex
  tokenId: bigint
  pool: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }
  tokens: readonly [TokenView, TokenView]
  /** Added 2026-10-06 (the owner's point 5): the position's range, Auto-exit's edges; null when it was not read. */
  range: ExitRange | null
  /** Price from the same position read shown on the page, with its freshness kept. */
  price?: ExitPriceSnapshot | null
  /** The wallet's protection-only vault the position is the root of, or null: a plain position. */
  vault: { address: Address; role: 'root' | 'successor'; autoExitEnabled: boolean } | null
}

type Path = 'batch' | 'steps'

/** §4.7's warnings as this dialog shows them: not the two Auto-exit cannot meet (it never converts; one per position). */
const shownWarnings = (dex: Dex): readonly AutoExitTextKey[] =>
  autoExitWarnings(dex).filter((key) => key !== 'autoexit_fee_line' && key !== 'autoexit_warning_slippage_on_top' && key !== 'autoexit_warning_other_orders')

/**
 * What pauses Auto-exit without any word from the person (spec §4.5): the position moved or approved elsewhere. Changed on
 * purpose 2026-10-06 (the integration review, rugged-literal #1): not any change: an exit needs the approval alone, so
 * Collect fees and Withdraw to both tokens leave it on.
 */
const CHANGES_PAUSE = "Moving this position or approving another app on it pauses Auto-exit until you approve it again. Collecting fees doesn't."
const LEDE = 'When the price reaches the end of your range, Domino closes this position and sends the tokens to your wallet.'
const FEE = "0.2% of the position's value, only if it closes"
/** Added 2026-10-06 (the review of point 5): an edge within the slippage band of the price now. */
const NEAR = 'The price is close to the end of your range, so Auto-exit may close this position soon.'
/** Added 2026-10-06 (the review of point 5): the price crossed an edge after the signature; the new edges need a new one. */
const PRICE_MOVED = 'The price just reached the end of your range. Check where Auto-exit closes now, then press again.'
/** Why there is nothing to close at (./form.ts EdgesProblem), as the card says it. */
const PROBLEM: Readonly<Record<EdgesProblem, string>> = {
  full_range: 'This position covers every price the pool allows, so it never reaches the end of its range.',
  edges_unreachable: 'The far end of this position’s range is beyond any price the pool can reach, so Auto-exit could never close it.',
  range_invalid: "This position's range couldn't be read. Try again in a moment.",
  price_unknown: "The pool's price isn't available right now. Try again in a moment.",
}
/** The steps' titles (the list under Details, and the counts of the one status line). */
const TITLE = {
  sign: 'Sign Auto-exit',
  batch: 'Turn on Auto-exit',
  // Not named `approve`: the source guards keep `approve(` to the closed clients (tests/session.source-guard.test.mjs).
  approval: (tokenId: bigint) => `Approve position #${tokenId}`,
  create: 'Set up Auto-exit for this position',
  enable: 'Turn on Auto-exit',
  register: 'Register Auto-exit',
} as const
/** How many times in a row the dialog follows the pool's price by itself (a new read, a new review) before it waits for a press. */
const FOLLOW_MAX = 3

/** The protection-only vault (decision #25) a plain position's Auto-exit is set up in. */
function protectionRequest(dex: Dex, tokenId: bigint): VaultCreateRequest {
  const { policy, limits } = protectionSettings()
  return { dex, tokenId, policy, limits, startPaused: true, consentToUncollectedFees: true }
}

/** The codes after which the prediction the order was signed for moved: a new review, and a new signature, next press. */
const PREDICTION_MOVED: ReadonlySet<string> = new Set(['vault_nonce_moved', 'UnexpectedNonce', 'vault_review_stale', 'mandate_review_stale'])
const REACHED = 'mandate_trigger_reached'

const sameEdges = (a: ExitEdges | null, b: ExitEdges | null) =>
  a !== null && b !== null && a.triggerBelowSqrtPriceX96 === b.triggerBelowSqrtPriceX96 && a.triggerAboveSqrtPriceX96 === b.triggerAboveSqrtPriceX96

export function MandateDialog({ target, gate, onClose, onChanged, done }: {
  target: ExitTarget
  gate: Exclude<V2Gate, { mode: 'off' }>
  onClose: () => void
  /** Auto-exit was turned on, or a vault was made: the caller reads again. */
  onChanged: () => void
  /**
   * Added 2026-10-06 (the review of point 5): what the button says once Auto-exit is on, and where it leads (a route), for
   * a dialog opened away from the position's page (Set up automation). Default: "Back to position", closing the dialog.
   */
  done?: { label: string; href?: string }
}) {
  const locked = gate.mode === 'preview'
  const { tokens, tokenId, dex } = target
  const plain = target.vault === null
  const orientation = useMemo(() => defaultOrientation(target.chainId, target.pool), [target.chainId, target.pool])
  const labels = useMemo(() => errorLabels(target.chainId, (address) => tokens.find((t) => t.address === address.toLowerCase())?.label ?? shortAddress(address)), [target.chainId, tokens])
  const spacing = target.pool.tickSpacing
  const tickLower = target.range?.tickLower ?? null
  const tickUpper = target.range?.tickUpper ?? null
  const range = useMemo<ExitRange | null>(() => (tickLower === null || tickUpper === null ? null : { tickLower, tickUpper }), [tickLower, tickUpper])

  // ----- live: the session (the wallet on the position's chain), the pool's price, the reviews, the steps -----
  const [attempt, setAttempt] = useState(0)
  const [session, setSession] = useState<AutomationSession | null>(null)
  const [sessionError, setSessionError] = useState<ErrorView | null>(null)
  // The pool's own price, read on chain (live only): from readPoolPrice, then from each review's own block, with the read
  // round it answers (a review waits for the answer to the latest round).
  const [chain, setChain] = useState<{ sqrtPriceX96: bigint; round: number } | null>(null)
  const [priceRound, setPriceRound] = useState(0)
  const priceRoundNow = useRef(priceRound)
  useEffect(() => {
    priceRoundNow.current = priceRound
  }, [priceRound])
  const [priceError, setPriceError] = useState<ErrorView | null>(null)
  // How many times in a row the dialog followed the price by itself (reset by a press).
  const follow = useRef(0)
  const chainPrice = locked ? null : chain?.sqrtPriceX96 ?? null
  const priceCurrent = chain !== null && chain.round === priceRound

  // ----- the edges (./form.ts): the range against the pool's price, held still once the button is pressed -----
  // The price the card is drawn with: the pool's own once read; until then the page's current one (live), or the page's
  // read whatever its age under the preview, where nothing is armed.
  const pagePrice = locked ? snapshotSqrtPrice(target.price) : freshSqrtPrice(target.price)
  const basis = chainPrice ?? pagePrice
  const priceSource = chainPrice !== null ? 'chain' : pagePrice === null ? 'none' : target.price?.saved ? 'saved' : 'page'
  const fromBasis = useMemo(() => exitEdges(range, basis, spacing), [range, basis, spacing])
  const [held, setHeld] = useState<ExitEdges | null>(null)
  const edges = held ?? (fromBasis.ok ? fromBasis.edges : null)
  const problem = held || fromBasis.ok ? null : fromBasis.problem
  // What a review arms: the edges against the pool's own price, never the page's.
  const armed = chainPrice !== null && fromBasis.ok ? fromBasis.edges : null
  const edgeKey = armed ? `${armed.triggerBelowSqrtPriceX96}|${armed.triggerAboveSqrtPriceX96}` : null
  const words = useMemo(() => (edges ? edgesOf(edges, tokens, orientation) : []), [edges, tokens, orientation])
  const [now] = useState(() => Math.floor(Date.now() / 1000))
  const terms = useMemo(() => (armed ? autoExitTerms(armed, now) : null), [armed, now])
  // The terms under Details: the armed ones, or, until the pool's price is in (and under the preview), the shown ones.
  const shownTerms = terms ?? (edges ? autoExitTerms(edges, now) : null)
  const unit = unitWords(tokens, orientation)
  const priceNow = basis !== null ? edgePrice(basis, { decimals0: tokens[0].decimals, decimals1: tokens[1].decimals }, orientation) : null
  const near = edges !== null && basis !== null && nearEdge(edges, basis, AUTO_EXIT_DEFAULT_SLIPPAGE_BPS)
  const createRequest = useMemo(() => protectionRequest(dex, tokenId), [dex, tokenId])

  // The reviews, with the edges and round they were made for: only those that match what the dialog shows are pressed.
  const [reviewed, setReviewed] = useState<{ key: string; createReview: VaultCreateReview | null; mandate: MandateReview } | null>(null)
  const [reviewError, setReviewError] = useState<ErrorView | null>(null)
  const [path, setPath] = useState<Path>('steps')
  const [round, setRound] = useState(0)
  const [signed, setSigned] = useState(false)
  const [registered, setRegistered] = useState(false)
  // A refusal said until the next press (the run's own notice goes with its list when the list changes).
  const [note, setNote] = useState<ErrorView | null>(null)
  // The batch gave way to the steps: the same press goes on with them (read in effects only).
  const again = useRef(false)

  useEffect(() => {
    if (locked || session) return
    let alive = true
    openAutomation(target.chainId, gate.contracts).then(
      (opened) => { if (alive) setSession(opened) },
      (failure: unknown) => { if (alive) setSessionError(describeError(failure, 'autoExit', labels)) },
    )
    return () => {
      alive = false
    }
  }, [locked, session, target.chainId, gate.contracts, labels, attempt])

  const wantKey = edgeKey !== null ? `${edgeKey}|${round}|${target.vault?.address ?? 'new'}` : null
  const current = reviewed && reviewed.key === wantKey ? reviewed : null
  const mandate = current?.mandate ?? null
  const createReview = current?.createReview ?? null

  const steps = useMemo<readonly WalletStep[]>(() => {
    if (!session || !mandate) return []
    const sign: WalletStep = {
      key: 'sign-mandate',
      title: TITLE.sign,
      context: 'autoExit',
      sign: async () => {
        const result = await session.autoExit.signMandate(mandate)
        rememberMandate({ chainId: target.chainId, owner: session.owner, id: mandate.id, nonce: mandate.mandate.nonce, vault: mandate.vault, tokenId: mandate.mandate.tokenId, registered: false, triggers: { below: mandate.mandate.triggerBelowSqrtPriceX96, above: mandate.mandate.triggerAboveSqrtPriceX96 } })
        setSigned(true)
        return result
      },
    }
    const at = (kind: string) => mandate.steps.findIndex((step) => step.kind === kind)
    const enable: WalletStep = { key: 'enable-exit-module', title: TITLE.enable, context: 'autoExit', tx: { client: session.autoExit, prepare: () => session.autoExit.prepareStep(mandate, at('enable-exit-module'), null) } }
    const register: WalletStep = { key: 'register-mandate', title: TITLE.register, context: 'autoExit', tx: { client: session.autoExit, prepare: () => session.autoExit.prepareStep(mandate, at('register-mandate'), null) } }
    if (createReview) {
      if (path === 'batch') {
        return [sign, {
          key: 'protect-batch',
          title: TITLE.batch,
          note: 'One confirmation: your position approved, Auto-exit set up and turned on, together.',
          context: 'autoExit',
          batch: {
            prepareBatch: () => session.autoExit.prepareProtectBatch(mandate, createRequest, null),
            send: (batch) => session.autoExit.sendProtectBatch(batch as ProtectBatch, true),
            receipt: (id) => session.autoExit.protectBatchReceipt(id),
          },
        }]
      }
      const create = createReview.steps.map((step, index): WalletStep => ({
        key: step.kind,
        title: step.kind === 'approve-root' ? TITLE.approval(tokenId) : TITLE.create,
        context: 'vault',
        tx: { client: session.vault, prepare: () => session.vault.prepareStep(createReview, index, null) },
      }))
      return [sign, ...create, enable, register]
    }
    if (at('enable-exit-module') === -1) return [sign, register]
    if (path === 'batch') {
      return [sign, {
        key: 'register-batch',
        title: TITLE.batch,
        note: 'One confirmation: Auto-exit turned on and registered together.',
        context: 'autoExit',
        batch: {
          prepareBatch: () => session.autoExit.prepareRegisterBatch(mandate, null),
          send: (batch) => session.autoExit.sendRegisterBatch(batch as MandateBatch, true),
          receipt: (id) => session.autoExit.registerBatchReceipt(id),
        },
      }]
    }
    return [sign, enable, register]
  }, [session, mandate, createReview, path, createRequest, tokenId, target.chainId])

  /** A fresh start after the chain moved under a signature: a new price, a new review, a new signature on the next press. */
  const startOver = (said: ErrorView) => {
    setNote(said)
    setSigned(false)
    setHeld(null)
    setReviewed(null)
    setRound((n) => n + 1)
  }

  const run = useStepsRun({
    session,
    steps,
    context: 'autoExit',
    labels,
    done: signed ? ['sign-mandate'] : [],
    onStepDone: (outcome) => {
      if (!mandate || !session) return
      if (outcome.receipt) recordVaultEvents(target.chainId, mandate.vault, outcome.receipt.events)
      if (outcome.step.key === 'create-vault' || outcome.step.key === 'protect-batch') rememberVault(target.chainId, session.owner, mandate.vault)
      if (outcome.step.key === 'register-mandate' || outcome.step.key === 'register-batch' || outcome.step.key === 'protect-batch') {
        rememberMandate({ chainId: target.chainId, owner: session.owner, id: mandate.id, nonce: mandate.mandate.nonce, vault: mandate.vault, tokenId: mandate.mandate.tokenId, registered: true, triggers: { below: mandate.mandate.triggerBelowSqrtPriceX96, above: mandate.mandate.triggerAboveSqrtPriceX96 } })
        setRegistered(true)
        onChanged()
      }
    },
    onError: (error) => {
      if (STEPS_INSTEAD.has(error.code) && path === 'batch') {
        // The wallet cannot send these calls together: the same calls, one confirmation each, the signature kept.
        again.current = true
        setPath('steps')
        return true
      }
      if (PREDICTION_MOVED.has(error.code)) {
        // Another automation of this wallet landed first: its next vault moved, so a new review and a new signature.
        startOver(error)
        return true
      }
      if (error.code === REACHED) {
        // The price reached an armed edge before the wallet's turn (the client refused it): read again, sign again.
        startOver({ text: PRICE_MOVED, code: REACHED })
        follow.current = 0
        setPriceRound((n) => n + 1)
        return true
      }
      return false
    },
  })

  // The reviews, while nothing has been asked of the wallet yet (a later read of the page never replaces them then).
  const quiet = !run.running && !signed && !registered
  const inputs = useRef({ terms, target, createRequest, labels, range, spacing, armed })
  useEffect(() => {
    inputs.current = { terms, target, createRequest, labels, range, spacing, armed }
  })

  // The pool's own price, once the session is open, and again when a refusal says it moved (Added 2026-10-06, the review
  // of point 5). A failed read is said, and the button reads it again.
  useEffect(() => {
    if (locked || !session) return
    let alive = true
    const { target: at, labels: named } = inputs.current
    const asked = priceRound
    void session.serial(() => session.autoExit.readPoolPrice(at.dex, at.tokenId)).then(
      (read) => {
        if (!alive) return
        setChain({ sqrtPriceX96: read.sqrtPriceX96, round: asked })
        setPriceError(null)
      },
      (failure: unknown) => { if (alive) setPriceError(describeError(failure, 'autoExit', named)) },
    )
    return () => {
      alive = false
    }
  }, [locked, session, priceRound])

  const reviewKey = !locked && session && quiet && !priceError && priceCurrent ? wantKey : null
  useEffect(() => {
    if (reviewKey === null || !session) return
    const { terms: chosen, target: at, createRequest: request, labels: named, range: ends, spacing: step, armed: arming } = inputs.current
    if (!chosen) return
    let alive = true
    void (async () => {
      try {
        const created = at.vault === null ? await session.serial(() => session.vault.reviewCreate(request)) : null
        const vault = created ? created.vault : (at.vault as NonNullable<ExitTarget['vault']>).address
        const next = await session.serial(() => session.autoExit.reviewMandate({ vault, ...(created ? { newVault: { dex: at.dex } } : {}), tokenId: at.tokenId, ...chosen, acknowledgedWarnings: true }))
        const batchable = created !== null || next.steps.some((step) => step.kind === 'enable-exit-module')
        const atomic = batchable ? await session.serial(() => session.autoExit.atomicSupport()) : 'unsupported'
        if (!alive) return
        setReviewed({ key: reviewKey, createReview: created, mandate: next })
        setPath(atomic === 'ready' || atomic === 'supported' ? 'batch' : 'steps')
        setReviewError(null)
        // The review's own block may put the price on another side of the range: the edges follow it (a new review),
        // a few times at most. The edges it armed are safe either way: none is reached at its block.
        const there = exitEdges(ends, next.sqrtPriceX96, step)
        if (there.ok && !sameEdges(there.edges, arming) && follow.current < FOLLOW_MAX) {
          follow.current++
          setChain({ sqrtPriceX96: next.sqrtPriceX96, round: priceRoundNow.current })
        }
      } catch (failure) {
        if (!alive) return
        const said = describeError(failure, at.vault === null ? 'vault' : 'autoExit', named)
        setReviewed(null)
        if (said.code === REACHED && follow.current < FOLLOW_MAX) {
          // The price reached an edge between its read and the review: read it again, choose the edges anew, review anew.
          follow.current++
          setRound((n) => n + 1)
          setPriceRound((n) => n + 1)
          return
        }
        setReviewError(said)
      }
    })()
    return () => {
      alive = false
    }
  }, [reviewKey, session])

  // The batch gave way to the steps: the press goes on with them (each still the person's to confirm in the wallet).
  useEffect(() => {
    if (!again.current || run.running || steps.length === 0 || path !== 'steps') return
    again.current = false
    void run.press()
  }, [run, steps, path])

  const press = () => {
    setNote(null)
    follow.current = 0
    if (sessionError) {
      setSessionError(null)
      setSession(null)
      setAttempt((n) => n + 1)
      return
    }
    if (priceError) {
      setPriceError(null)
      setPriceRound((n) => n + 1)
      return
    }
    if (reviewError) {
      setReviewError(null)
      setRound((n) => n + 1)
      setPriceRound((n) => n + 1)
      return
    }
    if (edges) setHeld(edges)
    void run.press()
  }

  const error = note ?? sessionError ?? priceError ?? reviewError ?? run.notice
  const line = runLine(run.phases)
  const retry = sessionError !== null || priceError !== null || reviewError !== null
  const preparing = !locked && !error && !registered && steps.length === 0 && (edges !== null || problem === 'price_unknown')
  const canPress = !locked && !registered && !run.running && (retry || (edges !== null && steps.length > 0))
  const previewSteps: WalletStep[] = plain
    ? [{ key: 'sign-mandate', title: TITLE.sign }, { key: 'protect-batch', title: TITLE.batch, note: 'One confirmation when your wallet can send the calls together; otherwise one each.' }]
    : target.vault?.autoExitEnabled === false
      ? [{ key: 'sign-mandate', title: TITLE.sign }, { key: 'register-batch', title: TITLE.batch, note: 'One confirmation when your wallet can send both together; otherwise two.' }]
      : [{ key: 'sign-mandate', title: TITLE.sign }, { key: 'register-mandate', title: TITLE.register }]
  // Nothing to close at, for good (a full range), or not from this side of the range now: no button, the sentence says why.
  const nothing = problem === 'full_range' || problem === 'edges_unreachable'

  const footer = registered ? (
    done?.href ? (
      <LinkButton href={done.href} variant="outline" size="lg" className="w-full" data-v2in-close="">
        {done.label}
      </LinkButton>
    ) : (
      <Button type="button" variant="outline" size="lg" className="w-full" onClick={onClose} data-v2in-close="">
        {done?.label ?? 'Back to position'}
      </Button>
    )
  ) : locked ? (
    <SheetLocked data-v2-locked="">{gate.lockedCopy}</SheetLocked>
  ) : nothing ? null : (
    <Button type="button" variant="primary" size="lg" className="w-full" disabled={!canPress} aria-busy={run.running || undefined} data-mandate-send="" onClick={press}>
      Turn on Auto-exit
    </Button>
  )

  return (
    <ActionSheet id="v2in-mandate" data-v2in-dialog="mandate" data-mandate-phase={registered ? 'on' : 'form'} title="Auto-exit" lede={LEDE} onClose={onClose} footer={footer}>
      {words.length > 0 ? (
        <SheetCard
          caption="Closes if the price"
          aside={priceNow ? <span data-mandate-now={basis?.toString()}>Now {priceNow}</span> : undefined}
          className="dm-exit-edges"
          data-mandate-edges={edges?.side ?? ''}
          data-mandate-price={held ? 'held' : priceSource}
        >
          <ul className="dm-exit-edge-list">
            {words.map((edge) => (
              <li key={edge.field} className="dm-exit-edge" data-mandate-edge={edge.move} data-mandate-trigger={edge.field === 'triggerBelowSqrtPriceX96' ? 'below' : 'above'} data-exact={edge.sqrtPriceX96.toString()}>
                <span className="dm-exit-direction" aria-hidden="true">{edge.move === 'falls' ? '↘' : '↗'}</span>
                <span className="dm-exit-edge-move">{edge.move === 'falls' ? 'falls to' : 'rises to'}</span>
                <span className="dm-exit-edge-price tnum">
                  {edge.price ?? '—'} <bdi className="dm-exit-edge-unit">{unit}</bdi>
                </span>
              </li>
            ))}
          </ul>
        </SheetCard>
      ) : problem === 'price_unknown' && !locked ? (
        // Live: the pool's price is being read through the wallet (or the alert below says why it could not be).
        !priceError && !sessionError && <SheetStatus data-mandate-problem="price">Reading the pool price…</SheetStatus>
      ) : (
        <SheetNote tone="warn" data-mandate-problem={problem ?? 'range'}>
          {PROBLEM[problem ?? 'range_invalid']}
        </SheetNote>
      )}
      {near && !registered && <SheetNote tone="warn" data-mandate-near="">{NEAR}</SheetNote>}
      <SheetFacts data-mandate-fee="">
        <SheetFact label="Fee">{FEE}</SheetFact>
      </SheetFacts>
      {registered ? (
        <SheetStatus state="done" data-mandate-registered="">Auto-exit is on. Domino closes this position at the end of its range.</SheetStatus>
      ) : line ? (
        <SheetStatus data-mandate-status="">{line}</SheetStatus>
      ) : preparing && words.length > 0 ? (
        <SheetStatus data-mandate-status="checking">Checking…</SheetStatus>
      ) : null}
      {error && !registered && <SheetAlert data-error-code={error.code}>{error.text}</SheetAlert>}
      <SheetMore label="Details" data-mandate-details="">
        <ul className="dm-v2in-warnings dm-exit-warnings" data-mandate-warnings="">
          {shownWarnings(dex).map((key) => (
            <li key={key} data-warning={key}>{AUTO_EXIT_TEXT[key]}</li>
          ))}
          <li data-warning="changes-pause">{CHANGES_PAUSE}</li>
        </ul>
        <SheetFacts data-mandate-terms="">
          <SheetFact label="You receive">Both tokens, as withdrawn</SheetFact>
          <SheetFact label="Slippage limit">{`${AUTO_EXIT_DEFAULT_SLIPPAGE_BPS / 100}% on top of the pool fee`}</SheetFact>
          {shownTerms && <SheetFact label="Valid until">{dateWords(shownTerms.validUntil)}</SheetFact>}
        </SheetFacts>
        <p className="dm-acct-note" data-protection-only="">{AUTO_EXIT_PROTECTION_ONLY_TEXT} {PROTECTION_CONSENT_TEXT}</p>
        {createReview?.warnings.includes('vault_v3_owed_to_wallet') && <p className="dm-acct-note">Amounts waiting to be collected from this position will be sent to your wallet when Auto-exit starts.</p>}
        {words.map((edge) => (
          <Fact key={edge.field} label={`Your wallet shows the ${edge.move === 'falls' ? 'lower' : 'upper'} price as`}>
            <span data-wallet-shows={edge.field === 'triggerBelowSqrtPriceX96' ? 'below' : 'above'}>{edge.sqrtPriceX96.toString()}</span>
          </Fact>
        ))}
        <Fact label="Automation">{target.vault ? target.vault.address : createReview?.vault ?? 'New, only for this position'}</Fact>
        {locked ? <WalletSteps steps={previewSteps} name="mandate-preview" /> : steps.length > 0 && <WalletSteps steps={steps} phases={run.phases} name="mandate-steps" />}
      </SheetMore>
    </ActionSheet>
  )
}
