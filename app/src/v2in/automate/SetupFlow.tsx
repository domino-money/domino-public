import { useEffect, useMemo, useRef, useState } from 'react'
import { CompoundPreview } from '../../components/automate/CompoundPreview'
import { ModeArt, PlainArt } from '../../components/automate/ModeArt'
import { ModeSummary } from '../../components/automate/ModeSummary'
import { PositionPicker } from '../../components/automate/PositionPicker'
import { SuccessorAxis } from '../../components/automate/SuccessorAxis'
import { positionHref } from '../../components/explore/routes'
import { Button, Card, LinkButton } from '../../components/ui'
import { automationFeeText, VAULT_TEXT, type VaultCreateBatch, type VaultCreateReview } from '../../finance/v2/vault'
import { preselected } from '../../lib/automate/picker'
import { useAutomation } from '../../lib/automationState'
import { CREATE } from '../../lib/create/copy'
import { SEQUENCE_DEFAULTS, type SequenceForm } from '../../lib/create/sequenceDefaults'
import type { WalletPosition } from '../../lib/walletPositions'
import { v2Chain } from '../../v2/chains'
import type { V2Gate } from '../../v2/gate'
import { ZERO_ADDRESS, type Address } from '../../v2/types'
import { MandateDialog, type ExitTarget } from '../autoexit/MandateDialog'
import { VAULT_AUTOMATION_START_PAUSED } from './constants'
import { describeError, errorLabels, STEPS_INSTEAD, type ErrorView } from './copy'
import { bpsText, defaultSettingsForm, intervalWords, observationAgeWords, settingsFrom, type VaultSettingsForm } from './form'
import { gateOpen } from './gate'
import { LimitsFields } from './LimitsFields'
import { openAutomation, type AutomationSession } from './session'
import { recordVaultEvents, rememberVault } from './store'
import { useStepsRun, WalletSteps, type WalletStep } from './steps'
import { poolTokens, shortAddress, walletTokenMeta } from './tokens'
import { ErrorLine, LockedNote } from './ui'
import type { SetupMode } from './intent'

/**
 * Set up automation with Domino's vault (spec F7 rev2/rev3 §5.1, §5.2, §4; decisions #12, #18, #25, #27): the same
 * page, steps and look as V1's (screens/SequenceCreate.tsx), its choices the vault's: Auto-compound (2%),
 * Domino-compound (4%) and Protection only, with no default (#12: nothing is chosen for the person; a link the person
 * followed from Automate names their own choice).
 *
 *   - Auto-compound / Domino-compound: the limits of §5.2 (slippage and band up to 5%, the band's growing warnings, the
 *     reference age and the minimum interval fixed at 300 s and 600 s and said, never edited), the consent on earned fees
 *     in the mode's own words; then `predictVault` → the individual approval → `createVault`, one EIP-5792 batch when the
 *     wallet has it; the vault starts running (#12: startPaused false).
 *   - Protection only (#18, #25): a vault created paused, Auto-compound with one position recorded (nothing is ever
 *     reinvested while paused), its auto-exit module turned on with the person's stop-loss / take-profit order: the order's
 *     own dialog (../autoexit/MandateDialog.tsx) runs the whole of it.
 *
 * All three are the vault's under `preview` (the preview alias, the development server: each runs up to its review and
 * the locked sentence; the owner, 2026-10-02 night) and under `live` (through the closed vault client). V1's own sequence
 * is production's, where the gate is off (./SetupEntry.tsx).
 */


const MODES: readonly { key: SetupMode; title: string; line: string; fee: string | null }[] = [
  { key: 'compound', title: CREATE.automation.options.compound.title, line: CREATE.automation.options.compound.line, fee: automationFeeText(1) },
  { key: 'domino', title: CREATE.automation.options.domino.title, line: CREATE.automation.options.domino.line, fee: automationFeeText(2) },
  { key: 'protection', title: 'Protection only', line: "Domino doesn't reinvest this position. It only watches your stop-loss and take-profit. 0.2% only if an exit runs.", fee: null },
]

/** The pool of a V1 position, in pool order (by address, whichever way V1's read lists the pair); null when the read is not one. */
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
function quoteIsCurrency0(pool: { currency0: Address; currency1: Address }): boolean {
  const chain = v2Chain(4663)
  const rank = (token: Address) => chain.chargeCurrencies.find((c) => c.address === token)?.rank ?? 0
  const [r0, r1] = [rank(pool.currency0), rank(pool.currency1)]
  // The charge currency of the best (lowest) rank, else currency1 (`quoteCurrency()`, F3 "Domino rules").
  if (r0 > 0 && (r1 === 0 || r0 < r1)) return true
  return false
}

export function SetupFlow({ positions, intent, gate, exitGate }: {
  positions: readonly WalletPosition[]
  intent: { mode: SetupMode | null; tokenId: string | null }
  /** The vault's gate on Robinhood Chain (V1's positions are there). */
  gate: Exclude<V2Gate, { mode: 'off' }>
  /** The auto-exit's gate there (Protection only needs both). */
  exitGate: V2Gate | null
}) {
  const [tokenId, setTokenId] = useState(() => preselected(positions, intent.tokenId))
  const preset = tokenId === null ? preselected(positions, intent.tokenId) : null
  if (preset !== null) setTokenId(preset)
  const [mode, setMode] = useState<SetupMode | null>(intent.mode)
  const [settings, setSettings] = useState<VaultSettingsForm>(() => ({ ...defaultSettingsForm(), mode: intent.mode === 'domino' ? 2 : intent.mode === 'compound' ? 1 : null }))
  const [consent, setConsent] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [orderOpen, setOrderOpen] = useState(false)
  const [created, setCreated] = useState<{ vault: Address; tokenId: string; mode: 1 | 2 } | null>(null)
  const chain = v2Chain(4663)
  const position = positions.find((entry) => entry.tokenId === tokenId) ?? null
  const automation = useAutomation(position?.tokenId ?? null)
  // A position already automated (V1's sequence) or tied to another app cannot take a vault: said before anything else.
  const taken = automation.phase === 'ready' && automation.state.automation !== 'plain'
  const usable = taken ? null : position
  const pool = usable ? poolOf(usable) : null
  const tokens = useMemo(() => (pool && usable ? poolTokens(chain, pool, walletTokenMeta(usable.currencies)) : null), [pool, usable, chain])
  const compounding = mode === 'compound' || mode === 'domino'
  const check = useMemo(() => settingsFrom(settings, 4), [settings])
  const labels = useMemo(() => errorLabels(4663, (address) => tokens?.find((t) => t.address === address.toLowerCase())?.label ?? shortAddress(address)), [tokens])
  const protectionGate: Exclude<V2Gate, { mode: 'off' }> | null = gateOpen(exitGate) ? (gate.mode === 'live' && exitGate.mode === 'live' ? gate : gate.mode === 'preview' ? gate : exitGate) : null
  const live = gate.mode === 'live'

  // ----- live: the client's review of the creation, made once the choices and the consent are in -----
  const [session, setSession] = useState<AutomationSession | null>(null)
  // The session once opened, for the next review (read in effects only).
  const opened = useRef<AutomationSession | null>(null)
  const [review, setReview] = useState<VaultCreateReview | null>(null)
  const [reviewError, setReviewError] = useState<ErrorView | null>(null)
  const [path, setPath] = useState<'batch' | 'steps'>('steps')
  const [round, setRound] = useState(0)
  const ready = !!usable && compounding && check.ok && consent
  useEffect(() => {
    if (!live || !ready || !usable || !check.ok) return
    let alive = true
    void (async () => {
      try {
        const current = opened.current ?? (await openAutomation(4663, gate.contracts))
        opened.current = current
        const next = await current.serial(() => current.vault.reviewCreate({ dex: 4, tokenId: idOf(usable.tokenId), policy: check.policy, limits: check.limits, startPaused: VAULT_AUTOMATION_START_PAUSED, consentToUncollectedFees: true }))
        const atomic = next.steps.length > 1 ? await current.serial(() => current.vault.atomicSupport()) : 'unsupported'
        if (!alive) return
        setSession(current)
        setPath(atomic === 'ready' || atomic === 'supported' ? 'batch' : 'steps')
        setReview(next)
        setReviewError(null)
      } catch (failure) {
        if (!alive) return
        setReview(null)
        setReviewError(describeError(failure, 'vault', { ...labels, consentGiven: true }))
      }
    })()
    return () => {
      alive = false
    }
  }, [live, ready, usable, check, round, gate.contracts, labels])

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
      tx: { client: session.vault, prepare: () => session.vault.prepareStep(review, index, null) },
    }))
  }, [session, review, path])

  const run = useStepsRun({
    session,
    steps,
    context: 'vault',
    labels,
    onStepDone: (outcome) => {
      if (!review || !session) return
      if (outcome.receipt) recordVaultEvents(4663, review.vault, outcome.receipt.events)
      if (outcome.step.key === 'create-vault' || outcome.step.key === 'create-batch') {
        const made = outcome.receipt?.events.find((event) => event.eventName === 'VaultCreated')?.args.vault
        const vault = (typeof made === 'string' ? made.toLowerCase() : review.vault) as Address
        rememberVault(4663, session.owner, vault)
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

  /** A new choice clears what an earlier press said. */
  const choosePosition = (next: string) => {
    if (next === tokenId) return
    setTokenId(next)
    setConsent(false)
    setReviewing(false)
  }
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
          <LinkButton href={positionHref(created.tokenId)} size="lg" className="dm-seq-done-link">
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
  const target: ExitTarget | null = usable && pool && tokens && pool.hooks === ZERO_ADDRESS ? { chainId: 4663, dex: 4, tokenId: idOf(usable.tokenId), pool, tokens, vault: null } : null
  const previewSteps: WalletStep[] = [
    { key: 'create-batch', title: usable ? `Approve position #${usable.tokenId} and set up your automation` : 'Approve your position and set up your automation', note: 'One confirmation when your wallet can send both together; otherwise two.' },
  ]
  const busy = run.running
  const consentText = settings.mode === null ? null : VAULT_TEXT.vault_consent_uncollected_fees.replace('{fee}', automationFeeText(settings.mode))
  const reason = !position
    ? 'Choose one of your positions.'
    : taken
      ? 'This position already has automation. Choose another one.'
      : !chosen
        ? 'Choose what Domino does for it.'
        : mode === 'protection'
          ? protectionGate ? 'Set your stop-loss and take-profit. Your wallet confirms once.' : 'Protection only is not available on this network yet.'
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
            <PositionPicker positions={positions} selected={position?.tokenId ?? null} onSelect={choosePosition} disabled={busy} />
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
                    {entry.key === 'protection' ? <PlainArt /> : <ModeArt mode={entry.key} size="card" play={mode === entry.key ? 'once' : 'none'} />}
                    <ModeSummary mode={entry.key} title={entry.title} fee={entry.fee} />
                  </Button>
                ))}
              </div>
              {chosen && <p className="dm-seq-hint">{mode === 'protection' ? "Earned fees stay in your position. Domino doesn't reinvest them." : 'The service fee applies once to earned fees used. Your original deposit is not charged.'}</p>}
            </fieldset>
          )}
          {usable && mode === 'protection' && (
            <fieldset className="dm-acct-fieldset" data-state="current">
              {legend(3, false, 'Stop-loss and take-profit')}
              <p className="dm-seq-hint">Your order says at which prices this position leaves the pool, and what you receive. It fires once; cancel it at any time.</p>
            </fieldset>
          )}
          {usable && compounding && (
            <fieldset disabled={busy} className="dm-acct-fieldset" data-state={consent ? 'done' : 'current'}>
              {legend(3, consent, 'Limits')}
              <LimitsFields form={settings} onChange={(next) => { setSettings(next); setConsent(false); setReviewing(false) }} problems={check.ok ? [] : check.problems} dex={4} disabled={busy} />
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
          {usable && mode === 'domino' && pool && <SuccessorAxis root={{ tokenId: usable.tokenId, lower: usable.tickLower, upper: usable.tickUpper, spacing: usable.tickSpacing }} inverse={quoteIsCurrency0(pool)} form={axisForm(settings)} />}
          {usable && mode === 'compound' && <CompoundPreview />}
          {usable && compounding && (live ? steps.length > 0 && <WalletSteps steps={steps} phases={run.phases} name="setup" /> : <WalletSteps steps={previewSteps} name="setup-preview" />)}
          {mode === 'protection' ? (
            <Button type="button" variant="primary" size="xl" className="w-full" disabled={!target || !protectionGate} onClick={() => setOrderOpen(true)} data-sequence-action="protection">
              Set stop-loss / take-profit
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
              onClick={() => (live ? void run.press() : setReviewing(true))}
            >
              {live ? 'Set up automation' : 'Review'}
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
          <ErrorLine error={reviewError ?? run.notice} />
        </aside>
      </div>
      {orderOpen && target && protectionGate && <MandateDialog target={target} gate={protectionGate} onClose={() => setOrderOpen(false)} onChanged={() => undefined} />}
    </Card>
  )
}
