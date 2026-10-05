import { useEffect, useId, useMemo, useState } from 'react'
import { Button, KeyValue, KeyValueList, Segmented } from '../../components/ui'
import { ActionSheet, SheetCard } from '../../components/positions/ActionSheet'
import { AUTO_EXIT_TEXT, autoExitFeeRule, autoExitWarnings, type MandateBatch, type MandateReview } from '../../finance/v2/autoExit'
import type { VaultCreateBatch, VaultCreateReview } from '../../finance/v2/vault'
import { profileRank, v2Chain } from '../../v2/chains'
import type { V2Gate } from '../../v2/gate'
import type { Address, Dex, V2ChainId } from '../../v2/types'
import { describeError, errorLabels, PROTECTION_CONSENT_TEXT, STEPS_INSTEAD, type ErrorView } from '../automate/copy'
import { bpsText, protectionSettings } from '../automate/form'
import { openAutomation, type AutomationSession } from '../automate/session'
import { recordVaultEvents, rememberMandate, rememberVault } from '../automate/store'
import { useStepsRun, WalletSteps, type WalletStep } from '../automate/steps'
import { dateWords, shortAddress, type TokenView } from '../automate/tokens'
import { Check, Details, ErrorLine, Fact, LockedNote } from '../automate/ui'
import { AUTO_EXIT_PROTECTION_ONLY_TEXT, AUTO_EXIT_SLIPPAGE_SHORTCUTS_BPS, AUTO_EXIT_UI_MAX_SLIPPAGE_BPS } from './constants'
import { defaultMandateForm, mandateProblemField, mandateProblemText, mandateTermsFrom, moveOf, type MandateForm, type ReceiveChoice } from './form'
import { defaultOrientation } from './orientation'
import { exitPriceDistance, exitReferencePrice, exitShortcutPrice, reorientExitForm, type ExitPriceSnapshot } from './priceContext'
import { feeRuleWords, groupedPrice, receiveWords, triggerWords, unitWords } from './words'

/**
 * "Stop-loss / take-profit" on a position (spec F7 §4.2–§4.4, §4.6, §4.7, §8.2 "Auto-exit"; decisions #18, #19, #20,
 * #25, #28), in the look of the position page's action dialogs:
 *   1. the order: "falls to" / "rises to" in a human price, in the orientation the person picks; receive both tokens or
 *      only one (explicit, never read from convertTo); slippage on top of the pool fee, 0.5%, 1% (the default) or 2%, or
 *      a value of the person's own up to 5%; how long it stays valid;
 *   2. the review: every term of the `ExitMandate` with what it means, each trigger with both values ("Your wallet will
 *      show this as {sqrtPriceX96}", decision #20), the fee rule of the chosen way to receive, and every mandatory
 *      warning (§4.7; the v3 one only for a v3 pool), which the person ticks as read;
 *   3. the wallet: for a position already in one of the wallet's vaults (its root or an active successor), the order
 *      signed, then turning auto-exit on for the vault (when it is off) and the registration, as ONE EIP-5792 batch when
 *      the wallet has it; for a plain position, first its protection-only vault (decision #25: created paused, Auto-
 *      compound with one position recorded, nothing reinvested; "Protection only"), approval and creation in one batch
 *      when the wallet has it, then the order on that vault.
 * Under the gate's `preview` the dialog stops at the review: `lockedCopy` stands where the wallet would be asked.
 */

export interface ExitTarget {
  chainId: V2ChainId
  dex: Dex
  tokenId: bigint
  pool: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }
  tokens: readonly [TokenView, TokenView]
  /** Price from the same position read shown on the page, with its freshness kept. */
  price?: ExitPriceSnapshot | null
  /** The wallet's vault the position is in (its root or an active successor), or null: a plain position. */
  vault: { address: Address; role: 'root' | 'successor'; autoExitEnabled: boolean } | null
}

type Phase = 'form' | 'review'

export function MandateDialog({ target, gate, onClose, onChanged }: {
  target: ExitTarget
  gate: Exclude<V2Gate, { mode: 'off' }>
  onClose: () => void
  /** An order or a vault was made: the caller reads again. */
  onChanged: () => void
}) {
  const locked = gate.mode === 'preview'
  const chain = v2Chain(target.chainId)
  const { tokens, pool, tokenId, dex } = target
  const [form, setForm] = useState<MandateForm>(() => defaultMandateForm(defaultOrientation(target.chainId, pool)))
  const [phase, setPhase] = useState<Phase>('form')
  const [ownSlippage, setOwnSlippage] = useState(false)
  const [settingsExpanded, setSettingsExpanded] = useState(false)
  const [consent, setConsent] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [now] = useState(() => Math.floor(Date.now() / 1000))
  const fieldId = useId()
  // Memoized on the form: the review's effect below depends on the terms, which must not change while nothing was typed.
  const check = useMemo(() => mandateTermsFrom(form, pool, { decimals0: tokens[0].decimals, decimals1: tokens[1].decimals }, now), [form, pool, tokens, now])
  const problems = check.ok ? [] : check.problems
  const problemAt = (field: ReturnType<typeof mandateProblemField>) => {
    const found = problems.find((p) => mandateProblemField(p) === field)
    return found ? mandateProblemText(found) : null
  }
  const typed = form.fallsTo.trim() !== '' || form.risesTo.trim() !== ''
  const decimals = { decimals0: tokens[0].decimals, decimals1: tokens[1].decimals }
  const reference = exitReferencePrice(target.price, decimals, form.orientation)
  const base = tokens[form.orientation === 'token1PerToken0' ? 0 : 1]
  const quote = tokens[form.orientation === 'token1PerToken0' ? 1 : 0]
  const otherOrientation = form.orientation === 'token1PerToken0' ? 'token0PerToken1' : 'token1PerToken0'
  const reoriented = reorientExitForm(form, decimals, otherOrientation)
  const fallsDistance = exitPriceDistance(form.fallsTo, reference)
  const risesDistance = exitPriceDistance(form.risesTo, reference)
  const referenceReady = reference !== null && target.price?.saved === false
  const positionOf = (distance: number) => Math.max(4, Math.min(96, 50 + distance * 45 / Math.max(20, Math.abs(fallsDistance?.percent ?? 0), Math.abs(risesDistance?.percent ?? 0))))
  const settingsInvalid = Boolean(problemAt('slippagePercent') || problemAt('validityDays'))
  const plain = target.vault === null
  const warnings = autoExitWarnings(dex).filter((key) => key !== 'autoexit_fee_line')
  const labels = useMemo(() => errorLabels(target.chainId, (address) => tokens.find((t) => t.address === address.toLowerCase())?.label ?? shortAddress(address)), [target.chainId, tokens])
  const set = (patch: Partial<MandateForm>) => setForm((old) => ({ ...old, ...patch }))

  // ----- live: the session, the vault (made first for a plain position), the order's review, the steps -----
  const [session, setSession] = useState<AutomationSession | null>(null)
  const [sessionError, setSessionError] = useState<ErrorView | null>(null)
  const [createReview, setCreateReview] = useState<VaultCreateReview | null>(null)
  const [vault, setVault] = useState<Address | null>(target.vault?.address ?? null)
  const [mandate, setMandate] = useState<MandateReview | null>(null)
  const [reviewError, setReviewError] = useState<ErrorView | null>(null)
  const [createPath, setCreatePath] = useState<'batch' | 'steps'>('steps')
  const [orderPath, setOrderPath] = useState<'batch' | 'steps'>('steps')
  const [signed, setSigned] = useState(false)
  const [registered, setRegistered] = useState(false)
  const reviewing = phase === 'review' && check.ok && !locked

  useEffect(() => {
    if (!reviewing || session) return
    let alive = true
    openAutomation(target.chainId, gate.contracts).then(
      (opened) => { if (alive) setSession(opened) },
      (failure: unknown) => { if (alive) setSessionError(describeError(failure, 'autoExit', labels)) },
    )
    return () => {
      alive = false
    }
  }, [reviewing, session, target.chainId, gate.contracts, labels])

  // A plain position: its protection-only vault reviewed once the consent is given (decision #25).
  useEffect(() => {
    if (!reviewing || !session || !plain || vault !== null || !consent) return
    let alive = true
    void (async () => {
      try {
        const { policy, limits } = protectionSettings()
        const next = await session.serial(() => session.vault.reviewCreate({ dex, tokenId, policy, limits, startPaused: true, consentToUncollectedFees: true }))
        const atomic = next.steps.length > 1 ? await session.serial(() => session.vault.atomicSupport()) : 'unsupported'
        if (!alive) return
        setCreatePath(atomic === 'ready' || atomic === 'supported' ? 'batch' : 'steps')
        setCreateReview(next)
        setReviewError(null)
      } catch (failure) {
        if (alive) setReviewError(describeError(failure, 'vault', labels))
      }
    })()
    return () => {
      alive = false
    }
  }, [reviewing, session, plain, vault, consent, dex, tokenId, labels])

  // The order reviewed by the client once the warnings are ticked and the vault exists (a fresh random nonce, §4.4).
  useEffect(() => {
    if (!reviewing || !session || vault === null || !acknowledged || !check.ok || mandate) return
    let alive = true
    const { terms } = check
    void (async () => {
      try {
        const request = { vault, tokenId, triggerBelowSqrtPriceX96: terms.triggerBelowSqrtPriceX96, triggerAboveSqrtPriceX96: terms.triggerAboveSqrtPriceX96, receiveMode: terms.receiveMode, convertTo: terms.convertTo, maxSlippageBps: terms.maxSlippageBps, validUntil: terms.validUntil, acknowledgedWarnings: true }
        const next = await session.serial(() => session.autoExit.reviewMandate(request))
        const atomic = next.steps[0]?.kind === 'enable-exit-module' ? await session.serial(() => session.autoExit.atomicSupport()) : 'unsupported'
        if (!alive) return
        setOrderPath(atomic === 'ready' || atomic === 'supported' ? 'batch' : 'steps')
        setMandate(next)
        setReviewError(null)
      } catch (failure) {
        if (alive) setReviewError(describeError(failure, 'autoExit', labels))
      }
    })()
    return () => {
      alive = false
    }
  }, [reviewing, session, vault, acknowledged, mandate, tokenId, labels, check])

  const createSteps = useMemo<readonly WalletStep[]>(() => {
    if (!session || !createReview) return []
    if (createPath === 'batch' && createReview.steps.length > 1) {
      return [{
        key: 'create-batch',
        title: `Approve position #${tokenId} and set up Protection only`,
        note: 'One confirmation in your wallet, two calls together. Both run, or neither does.',
        batch: {
          prepareBatch: () => session.vault.prepareCreateBatch(createReview, null),
          send: (batch) => session.vault.sendBatch(batch as VaultCreateBatch, true),
          receipt: (id) => session.vault.batchReceipt(id),
        },
      }]
    }
    return createReview.steps.map((step, index) => ({
      key: step.kind,
      title: step.kind === 'approve-root' ? `Approve position #${tokenId} for your automation` : 'Set up Protection only',
      tx: { client: session.vault, prepare: () => session.vault.prepareStep(createReview, index, null) },
    }))
  }, [session, createReview, createPath, tokenId])

  const orderSteps = useMemo<readonly WalletStep[]>(() => {
    if (!session || !mandate) return []
    const sign: WalletStep = {
      key: 'sign-mandate',
      title: 'Sign your exit order',
      sign: async () => {
        const result = await session.autoExit.signMandate(mandate)
        rememberMandate({ chainId: target.chainId, owner: session.owner, id: mandate.id, nonce: mandate.mandate.nonce, vault: mandate.vault, tokenId: mandate.mandate.tokenId, registered: false })
        setSigned(true)
        return result
      },
    }
    if (orderPath === 'batch') {
      return [sign, {
        key: 'register-batch',
        title: 'Turn on auto-exit and register your order',
        note: 'One confirmation in your wallet, two calls together. Both run, or neither does.',
        batch: {
          prepareBatch: () => session.autoExit.prepareRegisterBatch(mandate, null),
          send: (batch) => session.autoExit.sendRegisterBatch(batch as MandateBatch, true),
          receipt: (id) => session.autoExit.registerBatchReceipt(id),
        },
      }]
    }
    return mandate.steps.map((step, index) => (step.kind === 'sign-mandate' ? sign : {
      key: step.kind,
      title: step.kind === 'enable-exit-module' ? 'Turn on auto-exit for your automation' : 'Register your exit order',
      tx: { client: session.autoExit, prepare: () => session.autoExit.prepareStep(mandate, index, null) },
    }))
  }, [session, mandate, orderPath, target.chainId])

  const createRun = useStepsRun({
    session,
    steps: createSteps,
    context: 'vault',
    labels,
    onStepDone: (outcome) => {
      if (!createReview || !session) return
      if (outcome.receipt) recordVaultEvents(target.chainId, createReview.vault, outcome.receipt.events)
      if (outcome.step.key === 'create-vault' || outcome.step.key === 'create-batch') {
        const made = outcome.receipt?.events.find((event) => event.eventName === 'VaultCreated')?.args.vault
        const address = (typeof made === 'string' ? made.toLowerCase() : createReview.vault) as Address
        rememberVault(target.chainId, session.owner, address)
        setVault(address)
        onChanged()
      }
    },
    onError: (error) => {
      if (STEPS_INSTEAD.has(error.code) && createPath === 'batch') {
        setCreatePath('steps')
        return true
      }
      if (error.code === 'vault_nonce_moved' || error.code === 'UnexpectedNonce' || error.code === 'vault_review_stale') {
        // Another vault of this wallet landed first: the vault is predicted and approved again (§5.1 "Corrida").
        setCreateReview(null)
        return true
      }
      return false
    },
  })

  const orderRun = useStepsRun({
    session,
    steps: orderSteps,
    context: 'autoExit',
    labels,
    done: signed ? ['sign-mandate'] : [],
    onStepDone: (outcome) => {
      if (!mandate || !session) return
      if (outcome.receipt) recordVaultEvents(target.chainId, mandate.vault, outcome.receipt.events)
      if (outcome.step.key === 'register-mandate' || outcome.step.key === 'register-batch') {
        rememberMandate({ chainId: target.chainId, owner: session.owner, id: mandate.id, nonce: mandate.mandate.nonce, vault: mandate.vault, tokenId: mandate.mandate.tokenId, registered: true })
        setRegistered(true)
        onChanged()
      }
    },
    onError: (error) => {
      if (STEPS_INSTEAD.has(error.code) && orderPath === 'batch') {
        // The wallet cannot batch these calls: the same order, its signature kept, one confirmation per step.
        setOrderPath('steps')
        return true
      }
      return false
    },
  })

  // ----- what the review shows -----
  const terms = check.ok ? check.terms : null
  const below = mandate ? mandate.mandate.triggerBelowSqrtPriceX96 : terms?.triggerBelowSqrtPriceX96 ?? 0n
  const above = mandate ? mandate.mandate.triggerAboveSqrtPriceX96 : terms?.triggerAboveSqrtPriceX96 ?? 0n
  const rule = mandate ? mandate.feeRule : terms ? autoExitFeeRule(terms.receiveMode, terms.convertTo, pool, profileRank(chain, pool.currency0), profileRank(chain, pool.currency1)) : null
  const previewSteps: WalletStep[] = [
    ...(plain ? [{ key: 'create-batch', title: `Approve position #${tokenId} and set up Protection only`, note: 'One confirmation when your wallet can send both together; otherwise two.' }] : []),
    { key: 'sign-mandate', title: 'Sign your exit order' },
    ...(plain || target.vault?.autoExitEnabled === false
      ? [{ key: 'register-batch', title: 'Turn on auto-exit and register your order', note: 'One confirmation when your wallet can send both together; otherwise two.' }]
      : [{ key: 'register-mandate', title: 'Register your exit order' }]),
  ]
  const inCreate = plain && vault === null
  const run = inCreate ? createRun : orderRun
  const ready = acknowledged && (!plain || consent)
  const canPress = !locked && ready && !run.running && (inCreate ? createSteps.length > 0 : orderSteps.length > 0) && !registered
  // As the page's own action dialogs say it; the signature and the registration name what the wallet does.
  const primary = inCreate ? 'Confirm in wallet' : signed ? 'Register in wallet' : 'Sign in wallet'

  const receiveItems: { key: ReceiveChoice; label: string }[] = [
    { key: 'both', label: 'Both tokens' },
    { key: 'token0', label: tokens[0].label },
    { key: 'token1', label: tokens[1].label },
  ]

  if (phase === 'form' || !terms) {
    return (
      <ActionSheet
        id="v2in-mandate"
        data-v2in-dialog="mandate"
        data-mandate-phase="form"
        title="Stop-loss / take-profit"
        lede="Set a lower price, an upper price, or both."
        onClose={onClose}
        footer={
          <Button type="button" variant="primary" size="lg" className="w-full" disabled={!check.ok} onClick={() => setPhase('review')} data-mandate-review="">
            {check.ok ? 'Review order' : typed ? 'Check your exit prices' : 'Choose an exit price'}
          </Button>
        }
      >
        <SheetCard className="dm-exit-targets">
          <div className="dm-exit-reference" data-mandate-reference={reference === null ? 'unavailable' : target.price?.saved ? 'saved' : 'current'} data-price-block={target.price?.block ?? undefined}>
            <div>
              <span className="dm-label">{reference === null ? 'Pool price unavailable' : target.price?.saved ? 'Saved pool price' : 'Pool price now'}</span>
              <p className="dm-exit-price"><span>1 {base.label} =</span> <strong data-mandate-current-price="">{reference === null ? '—' : groupedPrice(reference)}</strong> <span>{quote.label}</span></p>
            </div>
            <div data-mandate-field="orientation">
              <button type="button" className="dm-exit-switch" data-mandate-switch="" aria-label="Switch price units" title={reoriented ? `Show ${unitWords(tokens, otherOrientation)}` : 'Finish or clear your prices before switching units.'} disabled={!reoriented} onClick={() => { if (reoriented) setForm(reoriented) }}><span aria-hidden="true">⇄</span></button>
            </div>
          </div>
          {(!referenceReady) && <p className="dm-exit-price-note" data-mandate-price-note="">{reference === null ? tokens.some((token) => token.decimals === null) ? 'Token details are still unavailable. Exit prices will be ready when they return.' : 'The pool price is unavailable. You can still enter an exit price.' : 'Saved price. Choose an exact exit price, or wait for a fresh read to use percentages.'}</p>}
          {reference !== null && <div className="dm-exit-price-map" data-mandate-price-map="" aria-hidden="true">
            <div className="dm-exit-price-rail"><span className="dm-exit-price-now" /><span className="dm-exit-price-pin" data-move="falls" hidden={!fallsDistance} style={{ left: `${positionOf(fallsDistance?.percent ?? 0)}%` }} /><span className="dm-exit-price-pin" data-move="rises" hidden={!risesDistance} style={{ left: `${positionOf(risesDistance?.percent ?? 0)}%` }} /></div>
            <div className="dm-exit-map-labels"><span>Price falls</span><span>{target.price?.saved ? 'Saved' : 'Now'}</span><span>Price rises</span></div>
          </div>}
          <div className="dm-exit-target-grid">
            {(['falls', 'rises'] as const).map((move) => {
              const value = move === 'falls' ? form.fallsTo : form.risesTo
              const field = move === 'falls' ? 'fallsTo' : 'risesTo'
              const distance = move === 'falls' ? fallsDistance : risesDistance
              const reached = distance !== null && (move === 'falls' ? distance.percent >= 0 : distance.percent <= 0)
              return <div key={move} className="dm-exit-target" data-direction={move} data-selected={value.trim() !== '' ? '' : undefined}>
                <div className="dm-exit-target-head"><div><span className="dm-exit-direction" aria-hidden="true">{move === 'falls' ? '↘' : '↗'}</span><span>{move === 'falls' ? 'Stop-loss' : 'Take-profit'}</span><span className="dm-exit-target-hint">{move === 'falls' ? 'If the price falls' : 'If the price rises'}</span></div>{value && <button type="button" className="dm-exit-clear" aria-label={`Clear ${move === 'falls' ? 'lower' : 'upper'} exit`} onClick={() => set({ [field]: '' })}>Clear</button>}</div>
                <div className="dm-exit-shortcuts" aria-label={`${move === 'falls' ? 'Lower' : 'Upper'} exit shortcuts`}>
                  {[5, 10, 20].map((percent) => <button key={percent} type="button" disabled={!referenceReady} data-mandate-shortcut={`${move}-${percent}`} aria-pressed={value !== '' && value === exitShortcutPrice(reference, move, percent)} onClick={() => { const price = exitShortcutPrice(reference, move, percent); if (price) set({ [field]: price }) }}>{move === 'falls' ? '−' : '+'}{percent}%</button>)}
                </div>
                <label className="dm-label dm-acct-lf" data-mandate-field={move}>
                  <span>{move === 'falls' ? 'Exit below' : 'Exit above'}<span>{quote.label} per {base.label}</span></span>
                  <input className="dm-field dm-acct-mono-field" aria-label={`Exit if the price ${move} to (${unitWords(tokens, form.orientation)})`} inputMode="decimal" autoComplete="off" spellCheck={false} placeholder="Not set" value={value} onChange={(event) => set({ [field]: event.target.value })} data-mandate-input={move} aria-invalid={typed && problemAt(field) ? true : undefined} aria-describedby={typed && problemAt(field) ? `${fieldId}-${move}` : undefined} />
                </label>
                <p className="dm-exit-distance" data-mandate-distance={move} data-reached={reached ? '' : undefined}>{distance ? reached ? 'The pool price has already passed this exit.' : distance.text : 'Off until you choose a price'}</p>
                {typed && problemAt(field) && <p id={`${fieldId}-${move}`} className="dm-error" data-mandate-problem={move}>{problemAt(field)}</p>}
              </div>
            })}
          </div>
          {typed && problemAt('triggers') && <p className="dm-error" data-mandate-problem="triggers">{problemAt('triggers')}</p>}
        </SheetCard>
        <div className="dm-exit-receive" data-mandate-field="receive">
          <span className="dm-label">You receive</span>
          <Segmented label="Receive" items={receiveItems} value={form.receive} onChange={(next) => set({ receive: next })} />
        </div>
        <details className="dm-exit-settings" open={settingsExpanded || settingsInvalid} onToggle={(event) => setSettingsExpanded(event.currentTarget.open)}>
          <summary onClick={(event) => {
            if (!settingsInvalid) return
            event.preventDefault()
            event.currentTarget.parentElement?.querySelector<HTMLInputElement>('input[aria-invalid="true"]')?.focus()
          }}><span>More settings</span><span className="dm-exit-settings-value">{form.slippagePercent}% slippage · {form.validityDays} days</span></summary>
          <div className="dm-exit-settings-body">
          <div className="grid gap-2" data-mandate-field="slippage">
          <span className="dm-label">Max slippage, on top of the pool fee</span>
          <Segmented
            label="Max slippage"
            items={[...AUTO_EXIT_SLIPPAGE_SHORTCUTS_BPS.map((bps) => ({ key: bpsText(bps), label: `${bpsText(bps)}%` })), { key: 'own', label: 'Other' }]}
            value={ownSlippage ? 'own' : form.slippagePercent}
            onChange={(next) => {
              if (next === 'own') setOwnSlippage(true)
              else {
                setOwnSlippage(false)
                set({ slippagePercent: next })
              }
            }}
          />
          {ownSlippage && (
            <label className="dm-label dm-acct-lf">
              {`Your own value, from 0.01% to ${bpsText(AUTO_EXIT_UI_MAX_SLIPPAGE_BPS)}%`}
              <input className="dm-field dm-acct-mono-field" inputMode="decimal" autoComplete="off" value={form.slippagePercent} onChange={(event) => set({ slippagePercent: event.target.value })} data-mandate-input="slippage" aria-invalid={problemAt('slippagePercent') ? true : undefined} aria-describedby={problemAt('slippagePercent') ? `${fieldId}-slippage` : undefined} />
            </label>
          )}
          {problemAt('slippagePercent') && <p id={`${fieldId}-slippage`} className="dm-error">{problemAt('slippagePercent')}</p>}
        </div>
        <label className="dm-label dm-acct-lf" data-mandate-field="validity">
          Valid for (days)
          <input className="dm-field dm-acct-mono-field" inputMode="numeric" autoComplete="off" value={form.validityDays} onChange={(event) => set({ validityDays: event.target.value })} data-mandate-input="validity" aria-invalid={problemAt('validityDays') ? true : undefined} aria-describedby={problemAt('validityDays') ? `${fieldId}-validity` : undefined} />
        </label>
        {problemAt('validityDays') && <p id={`${fieldId}-validity`} className="dm-error">{problemAt('validityDays')}</p>}
          </div>
        </details>
        {plain && <p className="dm-exit-protection" data-protection-only="">{AUTO_EXIT_PROTECTION_ONLY_TEXT}</p>}
        {locked && <p className="dm-exit-availability" data-mandate-availability="preview">You can review your choices. Activating this order opens when Domino’s service is live on {chain.name}.</p>}
      </ActionSheet>
    )
  }

  const lines = [
    ['below', triggerWords('triggerBelowSqrtPriceX96', below, tokens, form.orientation), below] as const,
    ['above', triggerWords('triggerAboveSqrtPriceX96', above, tokens, form.orientation), above] as const,
  ]
  const footer = registered ? (
    <Button type="button" variant="outline" size="lg" className="w-full" onClick={onClose} data-v2in-close="">
      Back to position
    </Button>
  ) : (
    <>
      <Button type="button" variant="primary" size="lg" className="w-full" disabled={!canPress} aria-busy={run.running || undefined} data-mandate-send="" onClick={() => void run.press()}>
        {locked ? (plain ? 'Confirm in wallet' : 'Sign in wallet') : primary}
      </Button>
      {locked && <LockedNote copy={gate.lockedCopy} />}
    </>
  )
  return (
    <ActionSheet
      id="v2in-mandate"
      data-v2in-dialog="mandate"
      data-mandate-phase="review"
      title="Review your exit order"
      onClose={onClose}
      back={!run.running && !signed && !registered ? { onClick: () => { setPhase('form'); setMandate(null); setAcknowledged(false) }, 'data-mandate-edit': '' } : null}
      footer={footer}
    >
      <KeyValueList className="dm-exit-review" data-mandate-terms="">
        <KeyValue label="Position">Position #{tokenId.toString()}</KeyValue>
        {lines.map(([key, words, raw]) => (
          <KeyValue key={key} label={moveOf(key === 'below' ? 'triggerBelowSqrtPriceX96' : 'triggerAboveSqrtPriceX96', form.orientation) === 'falls' ? 'Lower exit' : 'Upper exit'} data-mandate-trigger={key}>
            {words ?? 'Off'}
            {raw !== 0n && (
              <details className="dm-exit-wallet-value"><summary>Wallet value</summary><span className="dm-acct-note dm-mono" translate="no" data-wallet-shows={key}>Your wallet will show this as {raw.toString()}</span></details>
            )}
          </KeyValue>
        ))}
        <KeyValue label="Receive" data-mandate-receive="">{receiveWords(terms.receiveMode, terms.convertTo, tokens)}</KeyValue>
        <KeyValue label="Max slippage, on top of the pool fee">{bpsText(terms.maxSlippageBps)}%</KeyValue>
        <KeyValue label="Valid until">{dateWords(terms.validUntil)}</KeyValue>
      </KeyValueList>
      <SheetCard className="dm-exit-fee" data-mandate-fee="">
        <p className="text-body">{AUTO_EXIT_TEXT.autoexit_fee_line}</p>
        {rule && <p className="text-body text-fg-muted" data-fee-rule={rule.key}>{feeRuleWords(rule, tokens)}</p>}
      </SheetCard>
      <div className="dm-exit-acknowledgements">
      <ul className="dm-v2in-warnings" data-mandate-warnings="">
        {warnings.map((key) => (
          <li key={key} data-warning={key}>{AUTO_EXIT_TEXT[key]}</li>
        ))}
      </ul>
      <Check checked={acknowledged} onChange={setAcknowledged} disabled={run.running || signed} data-mandate-ack="">
        I have read these warnings.
      </Check>
      {plain && (
        <>
          <Check checked={consent} onChange={setConsent} disabled={run.running || vault !== null} data-protection-consent="">
            {PROTECTION_CONSENT_TEXT}
          </Check>
          {createReview?.warnings.includes('vault_v3_owed_to_wallet') && <p className="text-body text-fg-muted">Amounts waiting to be collected from this position will be sent to your wallet when automation starts.</p>}
        </>
      )}
      </div>
      {locked ? (
        <WalletSteps steps={previewSteps} name="mandate-preview" />
      ) : (
        <>
          {plain && createSteps.length > 0 && <WalletSteps steps={createSteps} phases={createRun.phases} name="mandate-vault" />}
          {orderSteps.length > 0 && <WalletSteps steps={orderSteps} phases={orderRun.phases} name="mandate-order" />}
          {ready && !reviewError && !sessionError && (inCreate ? createSteps.length === 0 : orderSteps.length === 0) && (
            <p role="status" className="text-body text-fg-muted">
              Checking…
            </p>
          )}
        </>
      )}
      {registered && (
        <p role="status" className="text-body text-fg" data-mandate-registered="">
          Your exit order is registered. It fires once, when the reference price reaches it.
        </p>
      )}
      <ErrorLine error={sessionError ?? reviewError ?? run.notice} />
      <Details data-mandate-details="">
        <Fact label="Owner">Your wallet</Fact>
        <Fact label="Automation">{target.vault ? target.vault.address : vault ?? 'New, only protects this position'}</Fact>
        <Fact label="Receive mode">{String(terms.receiveMode)}</Fact>
        <Fact label="Convert to">{terms.convertTo}</Fact>
        <Fact label="Max slippage (bps)">{String(terms.maxSlippageBps)}</Fact>
        <Fact label="Valid until (Unix time)">{terms.validUntil.toString()}</Fact>
        {mandate && <Fact label="Order number (nonce)">{mandate.mandate.nonce.toString()}</Fact>}
        {mandate && <Fact label="Order id">{mandate.id}</Fact>}
        {mandate && <Fact label="Signed digest">{mandate.digest}</Fact>}
        {mandate && <Fact label="Auto-exit module">{mandate.autoExit}</Fact>}
        {createReview && <Fact label="New automation">{createReview.vault}</Fact>}
      </Details>
    </ActionSheet>
  )
}
