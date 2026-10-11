import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { PortfolioResponse } from 'api-contracts/read-v6/types'
import { CompoundPreview } from '../../components/automate/CompoundPreview'
import { ModeArt } from '../../components/automate/ModeArt'
import { ModeSummary } from '../../components/automate/ModeSummary'
import { ExitThumb } from '../../components/home/Vignettes'
import { PositionPicker } from '../../components/automate/PositionPicker'
import { SuccessorAxis } from '../../components/automate/SuccessorAxis'
import { Button, Card, LinkButton } from '../../components/ui'
import { automationFeeText, VAULT_TEXT, type VaultCreateBatch, type VaultCreateReview } from '../../finance/v2/vault'
import { useWalletIdentity } from '../../lib/walletIdentity'
import { CREATE } from '../../lib/create/copy'
import { SEQUENCE_DEFAULTS, type SequenceForm } from '../../lib/create/sequenceDefaults'
import type { WalletPosition } from '../../lib/walletPositions'
import { v2Chain } from '../../v2/chains'
import type { V2Gate } from '../../v2/gate'
import { ZERO_ADDRESS, type Address, type V2ChainId } from '../../v2/types'
import { autoExitStanding, type AutoExitStanding } from '../autoexit/card'
import { fullRange } from '../autoexit/form'
import { MandateDialog, type ExitTarget } from '../autoexit/MandateDialog'
import { positionExitPrice } from '../autoexit/priceContext'
import { VAULT_AUTOMATION_START_PAUSED } from './constants'
import { describeError, errorLabels, STEPS_INSTEAD, type ErrorView } from './copy'
import { bpsText, defaultSettingsForm, intervalWords, observationAgeWords, settingsFrom, type VaultSettingsForm } from './form'
import { gateOpen } from './gate'
import { LimitsFields } from './LimitsFields'
import { openAutomation, type AutomationSession } from './session'
import { automationState, recordVaultEvents, rememberVault, sessionMandatesFor, sessionRevoked, subscribeAutomation } from './store'
import { useStepsRun, WalletSteps, type WalletStep } from './steps'
import { poolTokens, shortAddress, walletTokenMeta } from './tokens'
import { ErrorLine, LockedNote } from './ui'
import { setupKey, setupPositionHref, type SetupIntent, type SetupMode } from './intent'
import type { SetupPosition } from './setupPositions'

/**
 * Set up automation with Domino's vault (spec F7 rev2/rev3 §5.1, §5.2, §4; decisions #12, #18, #25, #27): the same
 * page, steps and look as V1's (screens/SequenceCreate.tsx), its choices the vault's: Auto-compound (2%),
 * Domino-compound (4%) and Auto-exit, with no default (#12: nothing is chosen for the person; a link the person
 * followed from Automate or from New position's success names their own choice).
 *
 *   - Auto-compound / Domino-compound: the limits of §5.2 (slippage and band up to 5%, the band's growing warnings, the
 *     reference age and the minimum interval fixed at 300 s and 600 s and said, never edited), the consent on earned fees
 *     in the mode's own words; then `predictVault` → the individual approval → `createVault`, one EIP-5792 batch when the
 *     wallet has it; the vault starts running (#12: startPaused false).
 *   - Auto-exit (#18, #25; Changed on purpose 2026-10-06, the owner's point 5: rugged97's name for it, its prices the
 *     range's edges): a vault created paused, Auto-compound with one position recorded (nothing is ever reinvested while
 *     paused), its auto-exit module on and its order registered, all in Auto-exit's own dialog
 *     (../autoexit/MandateDialog.tsx): one signature, then one confirmation when the wallet batches.
 *
 * All three follow the V2 gate. The picker receives only eligible read-v6 NFTs; every live review rechecks their
 * ownership and custody on chain before preparing an approval or transaction.
 */


const MODES: readonly { key: SetupMode; title: string; line: string; fee: string | null }[] = [
  { key: 'compound', title: CREATE.automation.options.compound.title, line: CREATE.automation.options.compound.line, fee: automationFeeText(1) },
  { key: 'domino', title: CREATE.automation.options.domino.title, line: CREATE.automation.options.domino.line, fee: automationFeeText(2) },
  // Changed on purpose 2026-10-06 (the owner's point 5): Auto-exit, by rugged97's name for it.
  { key: 'protection', title: 'Auto-exit', line: 'Domino closes this position at the end of its range and sends the tokens to your wallet. 0.2% only if it closes.', fee: null },
]

/** The picker position's pool in canonical currency order. */
function poolOf(position: WalletPosition): ExitTarget['pool'] | null {
  const [a, b] = position.currencies.map((c) => c.address.toLowerCase() as Address).sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : BigInt(x) > BigInt(y) ? 1 : 0))
  if (!/^0x[0-9a-f]{40}$/.test(a) || !/^0x[0-9a-f]{40}$/.test(b) || BigInt(a) >= BigInt(b)) return null
  return Object.freeze({ currency0: a, currency1: b, fee: position.fee, tickSpacing: position.tickSpacing, hooks: position.hooks.toLowerCase() as Address })
}

/** A decimal id as a bigint (module level: the React compiler reads a capitalized call in render as a component). */
const idOf = (text: string): bigint => BigInt(text)

/** V1's successor axis drawn for the vault's own Domino fields (its form shares the four names, in V1's units). */
const axisForm = (form: VaultSettingsForm): SequenceForm => ({ ...SEQUENCE_DEFAULTS, triggerPercent: form.triggerPercent, maxOverlapPercent: form.maxOverlapPercent, upsidePercent: form.upsidePercent, sequenceCap: form.maxPositions })

/** Whether the vault's reference currency is the pool's first currency (Domino-compound reads prices in it, §5.2). */
function quoteIsCurrency0(chainId: V2ChainId, pool: { currency0: Address; currency1: Address }): boolean {
  const chain = v2Chain(chainId)
  const rank = (token: Address) => chain.chargeCurrencies.find((c) => c.address === token)?.rank ?? 0
  const [r0, r1] = [rank(pool.currency0), rank(pool.currency1)]
  // The charge currency of the best (lowest) rank, else currency1 (`quoteCurrency()`, F3 "Domino rules").
  if (r0 > 0 && (r1 === 0 || r0 < r1)) return true
  return false
}

export type SetupGates = Readonly<Record<V2ChainId, V2Gate | null>>

export function SetupFlow({ positions, portfolio, intent, gates, exitGates, onHold }: {
  positions: readonly SetupPosition[]; portfolio: PortfolioResponse; intent: SetupIntent; gates: SetupGates; exitGates: SetupGates; onHold: (body: PortfolioResponse | null) => void
}) {
  const requested = intent.position ? setupKey(intent.position) : null
  const [selected, setSelected] = useState(() => positions.some((position) => position.key === requested) ? requested : null)
  const position = positions.find((entry) => entry.key === selected) ?? null
  const gate = position ? gates[position.chainId] : Object.values(gates).find(gateOpen) ?? null
  if (!gateOpen(gate)) return <p className="dm-acct-note" role="status">Automation isn’t available on this network right now.</p>
  // A different NFT/manager/network gets a fresh review, consent and wallet session. No previous steps can be sent.
  return <PositionSetup key={(position?.key ?? 'picker') + '|' + gate.mode + '|' + Object.values(gate.contracts.addresses).join(',')} positions={positions} portfolio={portfolio} intent={intent}
    position={position} onSelect={setSelected} gate={gate} exitGate={position ? exitGates[position.chainId] : null} onHold={onHold} />
}

function PositionSetup({ positions, portfolio, intent, position, onSelect, gate, exitGate, onHold }: {
  positions: readonly SetupPosition[]
  portfolio: PortfolioResponse
  intent: SetupIntent
  position: SetupPosition | null
  onSelect: (key: string) => void
  gate: Exclude<V2Gate, { mode: 'off' }>
  exitGate: V2Gate | null
  onHold: (body: PortfolioResponse | null) => void
}) {
  const [mode, setMode] = useState<SetupMode | null>(intent.mode)
  const [settings, setSettings] = useState<VaultSettingsForm>(() => ({ ...defaultSettingsForm(), mode: intent.mode === 'domino' ? 2 : intent.mode === 'compound' ? 1 : null }))
  const [consent, setConsent] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [orderOpen, setOrderOpen] = useState(false)
  const [created, setCreated] = useState<{ vault: Address; tokenId: string; mode: 1 | 2 } | null>(null)
  const chainId = position?.chainId ?? gate.chainId
  const dex = position?.dex ?? 4
  const chain = v2Chain(chainId)
  const usable = position
  // Changed on purpose 2026-10-06 (the owner's point 5; rugged97: "auto-exit has no fee compounding"): a position with
  // Auto-exit (read-v6's word, or turned on or off in this tab) is offered no compounding, and no second Auto-exit; one
  // whose Auto-exit is off but whose protection-only vault stays is turned back on from its own page (in that vault).
  const identity = useWalletIdentity()
  const connected = identity.kind === 'connected' ? (identity.address.toLowerCase() as Address) : null
  const store = useSyncExternalStore(subscribeAutomation, automationState, automationState)
  const revoked = sessionRevoked(store, chainId)
  const turnedOnHere = usable !== null && connected !== null && sessionMandatesFor(store, chainId, connected, idOf(usable.tokenId), dex).some((m) => m.registered && !revoked.has(m.id))
  const exitStanding: AutoExitStanding = turnedOnHere ? 'on' : usable !== null ? autoExitStanding(portfolio, chainId, usable.tokenId, dex, revoked) : null
  const exitHeld = exitStanding !== null
  const pool = usable ? poolOf(usable) : null
  const tokens = useMemo(() => (pool && usable ? poolTokens(chain, pool, walletTokenMeta(usable.currencies)) : null), [pool, usable, chain])
  const compounding = mode === 'compound' || mode === 'domino'
  const check = useMemo(() => settingsFrom(settings, dex), [settings, dex])
  const labels = useMemo(() => errorLabels(chainId, (address) => tokens?.find((t) => t.address === address.toLowerCase())?.label ?? shortAddress(address)), [tokens, chainId])
  const protectionGate: Exclude<V2Gate, { mode: 'off' }> | null = gateOpen(exitGate) ? (gate.mode === 'live' && exitGate.mode === 'live' ? gate : gate.mode === 'preview' ? gate : exitGate) : null
  const live = gate.mode === 'live'

  // ----- live: the client's review of the creation, made once the choices and the consent are in -----
  const [session, setSession] = useState<AutomationSession | null>(null)
  // The session once opened, for the next review (read in effects only).
  const opened = useRef<AutomationSession | null>(null)
  const [reviewed, setReviewed] = useState<{ key: string; value: VaultCreateReview } | null>(null)
  const [reviewError, setReviewError] = useState<ErrorView | null>(null)
  const [path, setPath] = useState<'batch' | 'steps'>('steps')
  const [round, setRound] = useState(0)
  const chainStatus = portfolio.chains.find((entry) => entry.chainId === chainId)
  const operationalIssue = chainStatus?.automationHalted === true ? 'Automation is temporarily paused on this network.'
    : chainStatus?.operatorsAdmitted === 0 ? 'Automation is not available on this network right now.' : null
  const ready = !!usable && compounding && !exitHeld && !operationalIssue && check.ok && consent
  // Changed on purpose 2026-10-05 (the owner: "I approved the first transaction and now the set up automation transaction
  // doesn't show, it keeps loading"). The positions list is read again after every wallet action, and each read gives new
  // position objects; this review followed those objects, so the approval's own re-read made a new review in the middle
  // of the run, which replaced its steps and left it waiting for nothing. The review now follows what it is about (the
  // position's id and the choices, as text), which a run cannot change (the form rests while it runs); only a refusal that
  // asks for a new review (`round`) makes one, once the run has ended.
  const reviewKey = live && ready && usable && check.ok ? `${usable.key}|${JSON.stringify([check.policy, check.limits], (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value))}|${round}` : null
  const review = reviewed?.key === reviewKey ? reviewed.value : null
  const inputs = useRef({ usable, check, labels })
  useEffect(() => {
    inputs.current = { usable, check, labels }
  })
  useEffect(() => {
    const { usable: position, check: choices, labels: named } = inputs.current
    if (reviewKey === null || !position || !choices.ok) return
    let alive = true
    void (async () => {
      try {
        const current = opened.current ?? (await openAutomation(chainId, gate.contracts))
        opened.current = current
        const next = await current.serial(() => current.vault.reviewCreate({ dex: position.dex, tokenId: idOf(position.tokenId), policy: choices.policy, limits: choices.limits, startPaused: VAULT_AUTOMATION_START_PAUSED, consentToUncollectedFees: true }))
        const atomic = next.steps.length > 1 ? await current.serial(() => current.vault.atomicSupport()) : 'unsupported'
        if (!alive) return
        setSession(current)
        setPath(atomic === 'ready' || atomic === 'supported' ? 'batch' : 'steps')
        setReviewed({ key: reviewKey, value: next })
        setReviewError(null)
      } catch (failure) {
        if (!alive) return
        setReviewed(null)
        setReviewError(describeError(failure, 'vault', { ...named, consentGiven: true }))
      }
    })()
    return () => {
      alive = false
    }
  }, [reviewKey, gate.contracts, chainId])

  const steps = useMemo<readonly WalletStep[]>(() => {
    if (!session || !review) return []
    if (path === 'batch' && review.steps.length > 1) {
      return [{
        key: 'create-batch',
        title: `Approve position #${review.init.root.tokenId} and set up your automation`,
        note: 'One confirmation in your wallet, two calls together. Both run, or neither does.',
        batch: {
          prepareBatch: () => session.vault.prepareCreateBatch(review, null),
          send: (batch) => session.vault.sendBatch(batch as VaultCreateBatch, true),
          receipt: (id) => session.vault.batchReceipt(id),
        },
      }]
    }
    return review.steps.map((step, index) => ({
      key: step.kind,
      title: step.kind === 'approve-root' ? `Approve position #${review.init.root.tokenId} for your automation` : 'Set up your automation',
      tx: { client: session.vault, prepare: () => session.vault.prepareStep(review, index, null), resume: () => session.vault.sentStep(review, index) },
    }))
  }, [session, review, path])

  const run = useStepsRun({
    session,
    steps,
    context: 'vault',
    labels,
    affected: review ? { positionManager: (review.init.root.dex === 3 ? chain.uniswap.v3 : chain.uniswap.v4).positionManager, tokenIds: [review.init.root.tokenId.toString()], vault: review.vault } : { tokenIds: [] },
    onStepDone: (outcome) => {
      if (!review || !session) return
      if (outcome.receipt) recordVaultEvents(chainId, review.vault, outcome.receipt.events)
      if (outcome.step.key === 'create-vault' || outcome.step.key === 'create-batch') {
        const made = outcome.receipt?.events.find((event) => event.eventName === 'VaultCreated')?.args.vault
        const vault = (typeof made === 'string' ? made.toLowerCase() : review.vault) as Address
        rememberVault(chainId, session.owner, vault)
        setCreated({ vault, tokenId: review.init.root.tokenId.toString(), mode: review.init.policy.mode })
      }
    },
    onError: (error) => {
      if (STEPS_INSTEAD.has(error.code) && path === 'batch') {
        setPath('steps')
        return true
      }
      if (['vault_nonce_moved', 'UnexpectedNonce', 'vault_review_stale', 'vault_step_out_of_order', 'vault_step_not_needed'].includes(error.code)) {
        // Another vault of this wallet landed first, or the chain moved: reviewed again, a new prediction and approval (§5.1).
        setRound((n) => n + 1)
        return true
      }
      return false
    },
  })

  // A portfolio refresh after approval/create must not unmount the review currently executing. Each money step
  // still rechecks on chain; after a failed run the latest indexed eligibility is shown again.
  useEffect(() => { onHold(run.running || created !== null || orderOpen ? portfolio : null) }, [run.running, created, orderOpen, portfolio, onHold])

  /** A new choice clears what an earlier press said. */
  const chooseMode = (next: SetupMode) => {
    if (next === mode) return
    setMode(next)
    setConsent(false)
    setReviewing(false)
    if (next !== 'protection') setSettings((old) => ({ ...old, mode: next === 'domino' ? 2 : 1 }))
  }

  if (created) {
    const title = created.mode === 2 ? 'Domino-compound' : 'Auto-compound'
    return (
      <section className="dm-card dm-acct-block dm-seq-done" aria-label="Automation set up" data-sequence-create="done" data-v2in-created={created.vault}>
        <div className="dm-plate dm-dots-plate dm-seq-stage" data-mode={created.mode === 2 ? 'domino' : 'compound'}>
          <ModeArt mode={created.mode === 2 ? 'domino' : 'compound'} size="card" play="once" />
        </div>
        <h2 className="dm-display dm-display-card">
          {title} is set up for position #{created.tokenId}
        </h2>
        <p className="dm-seq-done-line">Your automation reinvests this position's fees. Your position stays in your wallet.</p>
        <WalletSteps steps={steps} phases={run.phases} name="setup-done" />
        <div className="dm-seq-done-links">
          <LinkButton href={setupPositionHref({ chainId, dex, tokenId: idOf(created.tokenId) })} size="lg" className="dm-seq-done-link">
            View position
          </LinkButton>
        </div>
      </section>
    )
  }

  const chosen = MODES.find((entry) => entry.key === mode) ?? null
  const legend = (n: number, done: boolean, text: string) => (
    <legend className="dm-acct-subtitle">
      <span className="dm-seq-step" data-state={done ? 'done' : 'current'}>
        {n}
      </span>
      <span className="sr-only"> · </span>
      {text}
    </legend>
  )
  // Added 2026-10-06 (the owner's point 5): the position's range is Auto-exit's edges. Changed on purpose 2026-10-06 (the
  // review of point 5): the wallet list's price is a saved copy (read once, never refreshed here): the dialog chooses the
  // edges against the pool's own price, read through the wallet; a range that covers every price has no edge.
  const covers = usable !== null && fullRange({ tickLower: usable.tickLower, tickUpper: usable.tickUpper }, usable.tickSpacing)
  const target: ExitTarget | null = usable && pool && tokens && pool.hooks === ZERO_ADDRESS && !covers
    ? { chainId, dex, tokenId: idOf(usable.tokenId), pool, tokens, range: { tickLower: usable.tickLower, tickUpper: usable.tickUpper }, price: positionExitPrice(usable, { block: null, saved: true }), vault: null }
    : null
  const previewSteps: WalletStep[] = [
    { key: 'create-batch', title: usable ? `Approve position #${usable.tokenId} and set up your automation` : 'Approve your position and set up your automation', note: 'One confirmation when your wallet can send both together; otherwise two.' },
  ]
  const busy = run.running
  const consentText = settings.mode === null ? null : dex === 3
    ? `I agree to reinvest earned fees, with a ${automationFeeText(settings.mode)} service fee on the fees used.`
    : VAULT_TEXT.vault_consent_uncollected_fees.replace('{fee}', automationFeeText(settings.mode))
  const reason = !position
    ? 'Choose one of your positions.'
    : operationalIssue
      ? operationalIssue
      : !chosen
        ? 'Choose what Domino does for it.'
        : exitStanding !== null
          ? mode !== 'protection'
            ? 'This position is set up for Auto-exit, which never reinvests its fees. Choose another position.'
            : exitStanding === 'on' ? 'Auto-exit is already on for this position.' : "Auto-exit is off for this position. Turn it back on from the position's page."
        : mode === 'protection'
          // Changed on purpose 2026-10-06 (the review of point 5): one confirmation only where the wallet batches.
          ? !protectionGate ? 'Auto-exit is not available on this network yet.'
            : covers ? 'This position covers every price the pool allows, so Auto-exit could never close it. Choose another position.'
              : 'Turn on Auto-exit: one signature, then one confirmation when your wallet can send the calls together.'
          : !check.ok
            ? 'Check the limits.'
            : !consent
              ? 'Tick the consent box to continue.'
              : busy
                ? 'Confirm each step in your wallet. The list marks each one as it is done.'
                : live
                  ? path === 'batch' ? 'Your wallet asks you to sign once: the approval and your automation together.' : 'Your wallet asks you to approve the position, then to set up your automation.'
                  : 'Review what your wallet would be asked.'
  const phaseName = busy ? 'running' : !usable ? 'position' : !chosen ? 'mode' : 'limits'

  return (
    <Card className="dm-acct-block dm-acct-panel dm-seq-create" data-sequence-create={phaseName} data-sequence-create-mode={mode ?? undefined} data-v2in-setup={gate.mode} aria-busy={busy || undefined}>
      <div className="dm-seq-grid">
        <div className="dm-seq-steps">
          <fieldset disabled={busy} className="dm-acct-fieldset" data-state={usable ? 'done' : 'current'}>
            {legend(1, !!usable, 'Your position')}
            <PositionPicker positions={positions} selected={position?.key ?? null} onSelect={onSelect} disabled={busy} />
          </fieldset>
          {!usable && (
            <div className="dm-seq-ghosts" aria-hidden="true">
              <span>2</span>
              <span>3</span>
            </div>
          )}
          {usable && (
            <fieldset disabled={busy} className="dm-acct-fieldset" data-state={chosen ? 'done' : 'current'}>
              {legend(2, !!chosen, 'What Domino does for it')}
              <div className="dm-acct-choices dm-seq-modes" role="radiogroup" aria-label="Automation">
                {MODES.map((entry) => (
                  <Button key={entry.key} type="button" role="radio" aria-checked={mode === entry.key} variant="outline" className="dm-seq-mode" disabled={busy} onClick={() => chooseMode(entry.key)} data-sequence-mode={entry.key}>
                    {entry.key === 'protection' ? <ExitThumb className="dm-mode-art" /> : <ModeArt mode={entry.key} size="card" play={mode === entry.key ? 'once' : 'none'} />}
                    <ModeSummary mode={entry.key} title={entry.title} fee={entry.fee} />
                  </Button>
                ))}
              </div>
              {chosen && <p className="dm-seq-hint">{mode === 'protection' ? "Earned fees stay in your position. Domino doesn't reinvest them." : 'The service fee applies once to earned fees used. Your original deposit is not charged.'}</p>}
            </fieldset>
          )}
          {usable && mode === 'protection' && (
            <fieldset className="dm-acct-fieldset" data-state="current">
              {legend(3, false, 'Auto-exit')}
              <p className="dm-seq-hint">When the price reaches the end of this position's range, Domino closes it and sends the tokens to your wallet. Turn it off at any time.</p>
            </fieldset>
          )}
          {/* A position set up for Auto-exit is offered no compounding: no limits to set, nothing to consent to. */}
          {usable && compounding && !exitHeld && (
            <fieldset disabled={busy} className="dm-acct-fieldset" data-state={consent ? 'done' : 'current'}>
              {legend(3, consent, 'Limits')}
              <LimitsFields form={settings} onChange={(next) => { setSettings(next); setConsent(false); setReviewing(false) }} problems={check.ok ? [] : check.problems} dex={dex} disabled={busy} />
              {consentText && (
                <label className="dm-acct-check dm-seq-consent">
                  <input type="checkbox" checked={consent} onChange={(event) => { setConsent(event.target.checked); setReviewing(false) }} data-v2in-consent="" />
                  <span>{consentText}</span>
                </label>
              )}
            </fieldset>
          )}
        </div>
        <aside className="dm-seq-aside" aria-label="Wallet steps">
          <div className="dm-auto-aside-heading"><h2>Your automation</h2></div>
          {usable && mode === 'domino' && pool && !exitHeld && <SuccessorAxis root={{ tokenId: usable.tokenId, lower: usable.tickLower, upper: usable.tickUpper, spacing: usable.tickSpacing }} inverse={quoteIsCurrency0(chainId, pool)} form={axisForm(settings)} />}
          {usable && mode === 'compound' && !exitHeld && <CompoundPreview />}
          {usable && compounding && !exitHeld && (live ? steps.length > 0 && <WalletSteps steps={steps} phases={run.phases} name="setup" /> : <WalletSteps steps={previewSteps} name="setup-preview" />)}
          {mode === 'protection' ? (
            <Button type="button" variant="primary" size="xl" className="w-full" disabled={!target || !protectionGate || exitHeld || !!operationalIssue} onClick={() => { onHold(portfolio); setOrderOpen(true) }} data-sequence-action="protection">
              Turn on Auto-exit
            </Button>
          ) : (
            <Button
              type="button"
              variant="primary"
              size="xl"
              className="w-full"
              disabled={!ready || busy || (live ? steps.length === 0 || run.complete : false)}
              aria-busy={busy || undefined}
              data-sequence-action={live ? 'run' : 'review'}
              onClick={() => {
                if (!live) { setReviewing(true); return }
                onHold(portfolio)
                // Without a returned hash only fresh on-chain approval/custody can resolve the step. This press
                // reviews again; it never resends the uncertain approval or automatically offers the next action.
                const known = run.phases.some(phase => phase.phase === 'failed' && (phase.hash || phase.batchId))
                if (run.pending && !known) setRound(value => value + 1)
                else void run.press()
              }}
            >
              {live ? busy ? 'Waiting for confirmation…' : run.pending ? 'Check transaction' : 'Set up automation' : 'Review'}
            </Button>
          )}
          <p id="v2in-setup-reason" className="dm-flow-reason" data-align="start">
            {reason}
          </p>
          {!live && reviewing && ready && check.ok && (
            <div className="dm-auto-review" data-v2in-review="">
              <h3>Review your choices</h3>
              <dl className="dm-auto-review-facts">
                <div><dt>Position</dt><dd>#{usable?.tokenId}</dd></div>
                <div><dt>Automation</dt><dd>{chosen?.title}</dd></div>
                <div><dt>Service fee</dt><dd>{chosen?.fee} of earned fees used, once</dd></div>
                {settings.mode === 2 && <div><dt>Maximum positions</dt><dd>{check.policy.maxPositions}, including this one</dd></div>}
                <div><dt>Swap slippage limit</dt><dd>{bpsText(check.limits.maxSlippageBps)}% on top of the pool fee</dd></div>
                <div><dt>Price gap limit</dt><dd>{bpsText(check.limits.maxPriceImpactBps)}% from the reference price</dd></div>
              </dl>
              <p className="dm-seq-hint">{observationAgeWords(check.limits.maxObservationAgeSeconds)}. {intervalWords(check.policy.minimumIntervalSeconds)}</p>
              <LockedNote copy={gate.mode === 'preview' ? gate.lockedCopy : ''} />
            </div>
          )}
          {dex === 3 && review?.owed?.some((amount) => amount > 0n) && <p className="dm-seq-hint" data-v3-owed-to-wallet="">{VAULT_TEXT.vault_v3_owed_to_wallet}</p>}
          <ErrorLine error={reviewError ?? run.notice} />
        </aside>
      </div>
      {/* Changed on purpose 2026-10-06 (the review of point 5): once on, its button opens the position's page. */}
      {orderOpen && target && protectionGate && <MandateDialog target={target} gate={protectionGate} onClose={() => setOrderOpen(false)} onChanged={() => undefined} done={{ label: 'View position', href: setupPositionHref(target) }} />}
    </Card>
  )
}
