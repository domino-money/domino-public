import { useEffect, useRef, useState } from 'react'
import type { Hex } from 'viem'
import { AUTOMATION_FEE_BPS, sequenceReadError, sequenceReadStage, type createSequenceClient, type PreparedSequence } from '../finance/sequence'
import type { GasBudget } from '../finance/setup'
import { errorCode, financeErrorText } from '../finance/words'
import { CREATE } from '../lib/create/copy'
import { SEQUENCE_DEFAULTS, sequenceOptionsFrom, type SequenceForm, type SequenceMode } from '../lib/create/sequenceDefaults'
import { preselected, tokenName } from '../lib/automate/picker'
import { noteAutomation, useAutomation } from '../lib/automationState'
import { positionHref } from '../components/explore/routes'
import type { WalletPosition } from '../lib/walletPositions'
import { Button, Card, LinkButton } from '../components/ui'
import { IconChevronRight } from '../components/icons'
import { ModeArt } from '../components/automate/ModeArt'
import { LimitControl } from '../components/automate/LimitControl'
import { SuccessorAxis } from '../components/automate/SuccessorAxis'
import { CompoundPreview } from '../components/automate/CompoundPreview'
import { PositionPicker } from '../components/automate/PositionPicker'
import { AddressMark } from '../components/automate/marks'

/**
 * Putting a position's earned fees to work (the owner's simpler page,
 * 2026-09-24): choose one of the wallet's open positions, Auto-compound (the
 * same position, 2 %) or Domino-compound (the next range up, 4 %), the quote
 * currency, keep or change the limits, consent, and press one button. That
 * button runs the two wallet transactions in order through the same client as
 * before (finance/sequence.ts): the position's approval to its predicted
 * sequence, then the paused sequence's creation. Each is prepared against the
 * chain, simulated, offered to the wallet once and read back by hash, and the
 * list of wallet steps turns green as each lands. How any of it works is on
 * the docs pages, not here.
 *
 * The limits arrive in the units a person reads (lib/create/sequenceDefaults.ts)
 * and go out as the basis points, seconds and wei the contracts take. The
 * sequence is born paused and the position stays in the wallet; creation
 * needs no private session and no running service.
 */

type Client = ReturnType<typeof createSequenceClient>
type StepKey = 'approve-root' | 'create'
/** `chain`: sent, its receipt read while the press runs. `sent`: sent, and the press ended before its receipt settled it: no spinner, no caption, since nothing reads it any more. */
type StepState = 'upcoming' | 'reading' | 'wallet' | 'chain' | 'sent' | 'done' | 'failed'
type Notice = { text: string; code: string | null; stage: string | null }
type Receipt = Awaited<ReturnType<Client['receipt']>>['state']

export interface SequenceIntent {
  mode: SequenceMode | null
  tokenId: string | null
}

/** What pressing Set up automation needs, fresh at each press: the verified client, a network budget from the wallet's own price, and a way to keep the verified profile. */
export interface Connected {
  client: Client
  gas: GasBudget
  verified: () => void
}

/** The primary action's name: the sentences that send the owner back to it name it (finance/words.ts). */
const ACTION = 'Set up automation'
const RECEIPT_WAIT_MS = 240_000
const RECEIPT_EVERY_MS = 3_000
const SETTLED: readonly Receipt[] = ['confirming', 'finalized', 'reverted', 'reorged', 'over_budget', 'over_budget_finalized']
const BEFORE_WALLET = ['review_required', 'sequence_admission_unavailable', 'sequence_release_expired', 'sequence_activation_unavailable', 'sequence_tariff_changed', 'deployment_code_changed', 'deployment_identity_changed', 'root_approval_changed']
/**
 * Said in this screen's own words wherever the code is raised, the check a send makes before the wallet opens included;
 * every other code goes through finance/words.ts. The code stays beside the sentence.
 */
const OWN: Readonly<Record<string, string>> = {
  sequence_receipt_waiting: `The transaction is still waiting to be included. Check your wallet activity before pressing ${ACTION} again.`,
  sequence_step_reverted: `The transaction reverted: nothing changed, only network gas was spent. Press ${ACTION} to try again.`,
  sequence_step_reorged: 'The block that held the transaction left the canonical chain. Check your wallet activity before trying again.',
  // finance/words.ts sends these to the review and the network budget, which this page no longer has.
  sequence_preparation_changed: `The sequence changed since it was prepared. Press ${ACTION} again.`,
  native_gas_reserve_insufficient: 'Your ETH does not cover the network fee for this step.',
  // The chosen position is no longer this wallet's, or something is already subscribed to it (finance/sequence.ts root).
  position_not_in_wallet: 'This position is no longer in your wallet.',
  position_subscribed: 'This position is already linked to a sequence or another contract.',
}
// Once a press has sent a transaction, no sentence may claim that nothing was sent, requested or prepared: such a clause is
// left out (NOTHING), and a failure with no sentence of its own says SENT instead of the usual fallback.
const NOTHING = / (No (wallet )?transaction|Nothing) was \w+\./
const SENT = `A transaction was sent. Check your wallet activity before pressing ${ACTION} again.`
/** The picker's notes with one more position and what the chain showed about it. */
const noted = (tokenId: string, text: string) => (old: Readonly<Record<string, string>>) => ({ ...old, [tokenId]: text })

const MODES: readonly { key: SequenceMode; title: string; line: string; fee: string }[] = [
  { key: 'compound', title: CREATE.automation.options.compound.title, line: CREATE.automation.options.compound.line, fee: `${AUTOMATION_FEE_BPS.compound / 100}%` },
  { key: 'domino', title: CREATE.automation.options.domino.title, line: CREATE.automation.options.domino.line, fee: `${AUTOMATION_FEE_BPS.domino / 100}%` },
]

const LIMIT_LABELS: Record<keyof SequenceForm, string> = {
  triggerPercent: 'Trigger distance (%)',
  maxOverlapPercent: 'Maximum overlap (%)',
  sequenceCap: 'Positions in the sequence',
  upsidePercent: 'Next range higher by (%)',
  minimumIntervalMinutes: 'Minimum time between runs (minutes)',
  maxSlippagePercent: 'Maximum swap slippage (%)',
  maxPriceImpactPercent: 'Maximum price impact (%)',
  maxGasCostEth: 'Gas cap per run (ETH)',
  maxObservationAgeMinutes: 'Price reading may be this old (minutes)',
  forecastHorizonHours: 'Forecast horizon (hours)',
}
/** What a Domino-compound owner sets at a glance; everything else keeps its default under More limits. */
const DOMINO_FIELDS: (keyof SequenceForm)[] = ['upsidePercent', 'sequenceCap']
const MORE_DOMINO: (keyof SequenceForm)[] = ['triggerPercent', 'maxOverlapPercent']
const SAFETY_FIELDS: (keyof SequenceForm)[] = ['minimumIntervalMinutes', 'maxSlippagePercent', 'maxPriceImpactPercent', 'maxGasCostEth', 'maxObservationAgeMinutes', 'forecastHorizonHours']
const IDLE_STEPS: Record<StepKey, StepState> = { 'approve-root': 'upcoming', create: 'upcoming' }

/** A step that stopped because the page moved on (another wallet, another page): nothing is said. */
class Left extends Error {}

/** A failure while a step was offered to the wallet, kept apart from reads and preparation, which never reach it. */
class Offered extends Error {
  constructor(readonly inner: unknown) {
    super('offered')
  }
}

/** Reads a sent step's receipt every few seconds until it settles; throws unless it landed, and stops quietly once the page moved on. */
async function settle(client: Client, hash: Hex, here: () => boolean) {
  let state: Receipt = 'pending'
  const until = Date.now() + RECEIPT_WAIT_MS
  while (Date.now() < until && !SETTLED.includes(state)) {
    await new Promise((resolve) => setTimeout(resolve, RECEIPT_EVERY_MS))
    if (!here()) throw new Left()
    state = (await client.receipt(hash)).state
  }
  if (!SETTLED.includes(state)) throw new Error('sequence_receipt_waiting')
  if (state === 'reverted') throw new Error('sequence_step_reverted')
  if (state === 'reorged') throw new Error('sequence_step_reorged')
}

/** `sent`: this press already has a transaction hash, so nothing it says may claim that nothing was sent. */
function noticeFor(error: unknown, sent: boolean): Notice {
  const offered = error instanceof Offered
  const inner = offered ? error.inner : error
  const code = errorCode(inner)
  const text =
    code !== null && Object.hasOwn(OWN, code)
      ? OWN[code]
      : !offered
        ? financeErrorText(errorCode(error), '', 'Set up automation') || (sent ? SENT : 'The wallet read or simulation could not be completed. No transaction was sent.')
        : code !== null && BEFORE_WALLET.includes(code)
          ? `The preparation is no longer valid. No wallet transaction was requested. Press ${ACTION} again.`
          : !!inner && typeof inner === 'object' && (inner as { code?: unknown }).code === 4001
            ? `You declined in your wallet. Press ${ACTION} to try again.`
            : 'The wallet outcome may be unknown. Check wallet activity and chain state before continuing. This nonce stays protected against another offer, including after reload.'
  return { text: sent ? text.replace(NOTHING, '') : text, code, stage: sequenceReadStage(inner) }
}

export default function SequenceCreate({ positions, intent, connect, onCreated }: { positions: readonly WalletPosition[]; intent: SequenceIntent; connect: () => Promise<Connected>; onCreated?: (vault: `0x${string}`) => void }) {
  const [tokenId, setTokenId] = useState(() => preselected(positions, intent.tokenId))
  // The position a link named, arriving with a later read of the list (Sequence.tsx asks once more for it), is chosen then.
  const preset = tokenId === null ? preselected(positions, intent.tokenId) : null
  if (preset !== null) setTokenId(preset)
  const [mode, setMode] = useState<SequenceMode | null>(intent.mode)
  const [baseIsCurrency0, setBaseIsCurrency0] = useState<boolean | null>(null)
  const [form, setForm] = useState<SequenceForm>(SEQUENCE_DEFAULTS)
  const [consent, setConsent] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'running' | 'failed' | 'done'>('idle')
  const [steps, setSteps] = useState<Record<StepKey, StepState>>(IDLE_STEPS)
  const [notice, setNotice] = useState<Notice | null>(null)
  // The sequence created, and the position it was set up for (kept here, whatever the list does afterwards).
  const [created, setCreated] = useState<{ vault: string; tokenId: string } | null>(null)
  // Positions the chain showed something already subscribed to, each with that sentence: the picker shows it and never chooses one.
  const [linked, setLinked] = useState<Readonly<Record<string, string>>>({})
  const generation = useRef(0)
  const running = useRef(false)
  useEffect(() => () => void generation.current++, [])

  const position = positions.find((entry) => entry.tokenId === tokenId && !linked[entry.tokenId]) ?? null
  const chosen = MODES.find((entry) => entry.key === mode) ?? null
  // A position already in a sequence (or subscribed elsewhere) cannot start another: said before anything is asked.
  const automation = useAutomation(position?.tokenId ?? null)
  const taken = automation.phase === 'ready' && automation.state.automation !== 'plain'
  // The steps after the first open only for a position that can take a sequence.
  const usable = taken ? null : position
  const busy = phase === 'running'
  const locked = busy || phase === 'done'

  /** A new choice clears what an earlier press said, so the list and the notice never describe another sequence. */
  const changed = () => {
    if (phase === 'failed') {
      setPhase('idle')
      setSteps(IDLE_STEPS)
    }
    setNotice(null)
  }
  const choosePosition = (next: string) => {
    if (next === tokenId) return
    changed()
    setTokenId(next)
    setBaseIsCurrency0(null)
    setConsent(false)
  }
  const chooseMode = (next: SequenceMode) => {
    if (next === mode) return
    changed()
    setMode(next)
    setConsent(false)
  }
  const chooseQuote = (nextBaseIsCurrency0: boolean) => {
    changed()
    setBaseIsCurrency0(nextBaseIsCurrency0)
  }
  const edit = (name: keyof SequenceForm, value: string) => {
    changed()
    setForm((old) => ({ ...old, [name]: value }))
  }
  const mark = (key: StepKey, state: StepState, gen: number) => {
    if (generation.current === gen) setSteps((old) => ({ ...old, [key]: state }))
  }

  /** Offers one prepared step to the wallet, then reads its receipt until it settles. Returns only once it is in. `press.sent` names the step once the wallet gave its hash. */
  async function sendAndWait(client: Client, step: PreparedSequence, key: StepKey, gen: number, press: { sent: StepKey | null }) {
    mark(key, 'wallet', gen)
    let hash: Hex
    try {
      hash = await client.send(step, true)
    } catch (error) {
      throw new Offered(error)
    }
    press.sent = key
    if (generation.current !== gen) throw new Left()
    mark(key, 'chain', gen)
    await settle(client, hash, () => generation.current === gen)
    mark(key, 'done', gen)
  }

  async function setUp() {
    if (running.current || !position || taken || !mode || baseIsCurrency0 === null || !consent) return
    const checked = sequenceOptionsFrom(mode, BigInt(position.tokenId), baseIsCurrency0, form)
    if (!checked.ok) {
      setNotice({ text: checked.reason, code: null, stage: null })
      return
    }
    running.current = true
    const gen = ++generation.current
    let at: StepKey = 'approve-root'
    const press: { sent: StepKey | null } = { sent: null }
    setNotice(null)
    setPhase('running')
    setSteps({ 'approve-root': 'reading', create: 'upcoming' })
    try {
      const { client, gas, verified } = await connect()
      if (generation.current !== gen) throw new Left()
      // The position read first, as the page read it before: the deployment verified, the NFT this wallet's and in no sequence. Its
      // reads are the classified ones (a provider's reply never reaches the page), with the read snapshot behind a refused call.
      await client.inspectRoot(checked.options.rootTokenId).catch((error) => {
        throw sequenceReadError(error)
      })
      if (generation.current !== gen) throw new Left()
      let step = await client.create(checked.options, gas)
      verified()
      if (step.kind === 'approve-root') {
        await sendAndWait(client, step, 'approve-root', gen, press)
        at = 'create'
        mark('create', 'reading', gen)
        step = await client.create(checked.options, gas)
        // Its approval is in, so the creation is what the chain prepares now; anything else is no longer this sequence.
        if (step.kind !== 'create') throw new Error('sequence_preparation_changed')
      } else {
        mark('approve-root', 'done', gen)
      }
      at = 'create'
      await sendAndWait(client, step, 'create', gen, press)
      // Its receipt is in and matches what was prepared: the sequence exists at the address it was prepared for.
      if (generation.current !== gen) return
      setCreated({ vault: step.vault, tokenId: position.tokenId })
      // Positions shows the new sequence at once, and asks the chain again a few seconds later. A new sequence starts paused.
      noteAutomation({ tokenId: position.tokenId, automation: mode, paused: true, active: false, vault: step.vault })
      setPhase('done')
      onCreated?.(step.vault)
    } catch (error) {
      if (error instanceof Left || generation.current !== gen) return
      // A step the wallet gave a hash for failed only if its receipt says it reverted; otherwise it stays sent, and the
      // press ending here means nothing reads its receipt any more (`sent`, not `chain`).
      mark(at, press.sent !== at || errorCode(error) === 'sequence_step_reverted' ? 'failed' : 'sent', gen)
      const said = noticeFor(error, press.sent !== null)
      // Something is already subscribed to this NFT: the picker says so beside it and no longer offers it.
      if (said.code === 'position_subscribed') setLinked(noted(position.tokenId, said.text))
      setPhase('failed')
      setNotice(said)
    } finally {
      if (generation.current === gen) running.current = false
    }
  }

  const ready = !!position && !taken && !!chosen && baseIsCurrency0 !== null && consent
  const reason = !position
    ? 'Choose one of your positions.'
    : taken
      ? 'This position already has automation. Choose another one.'
      : !chosen
        ? 'Choose what its earned fees do.'
        : baseIsCurrency0 === null
          ? 'Choose the quote currency.'
          : !consent
            ? 'Tick the consent box to continue.'
            : busy
              ? 'Confirm each step in your wallet. The list marks each one as it is done.'
              : 'Your wallet asks you to approve the position, then to create the sequence.'

  const field = (name: keyof SequenceForm) => (
    <LimitControl key={name} name={name} value={form[name]} onEdit={(value) => edit(name, value)}>
      <label className="dm-label dm-acct-lf">
        {LIMIT_LABELS[name]}
        <input className="dm-field" inputMode="decimal" value={form[name]} onChange={(event) => edit(name, event.target.value)} />
      </label>
    </LimitControl>
  )
  const legend = (n: number, done: boolean, text: string) => (
    <legend className="dm-acct-subtitle">
      <span className="dm-seq-step" data-state={done ? 'done' : 'current'}>
        {n}
      </span>
      <span className="sr-only"> · </span>
      {text}
    </legend>
  )
  const stepList = (tokenId: string) => (
    <ol className="dm-flow-wsteps dm-seq-wsteps" data-wallet-steps="" aria-live="polite">
      {(['approve-root', 'create'] as const).map((key, index) => {
        const state = steps[key]
        const active = state === 'reading' || state === 'wallet' || state === 'chain'
        const caption = state === 'wallet' ? 'Confirm in your wallet.' : state === 'chain' ? 'Waiting for the network.' : state === 'upcoming' && key === 'create' ? 'It starts paused.' : null
        return (
          <li key={key} data-wallet-step={key} data-step-state={state}>
            <span aria-hidden="true" className="dm-step-marker" data-state={state === 'done' ? 'done' : active ? 'current' : undefined}>
              {state === 'done' ? '✓' : index + 1}
            </span>
            <span className="dm-flow-wstep-body">
              <span className="dm-flow-wstep-title">{key === 'approve-root' ? `Approve position #${tokenId}` : 'Create the sequence'}</span>
              {caption && <span className="dm-flow-wstep-note">{caption}</span>}
            </span>
          </li>
        )
      })}
    </ol>
  )

  if (created && chosen) {
    return (
      <section className="dm-card dm-acct-block dm-seq-done" aria-label="Sequence created" data-sequence-create="done" data-sequence-create-mode={chosen.key} data-sequence-created={created.vault}>
        <div className="dm-plate dm-dots-plate dm-seq-stage" data-mode={chosen.key}>
          <ModeArt mode={chosen.key} size="card" play="once" />
        </div>
        <h2 className="dm-display dm-display-card">
          {chosen.title} is set up for position #{created.tokenId}
        </h2>
        <p className="dm-seq-done-line">It starts paused, and your position stays in your wallet.</p>
        {stepList(created.tokenId)}
        <div className="dm-seq-done-links">
          <LinkButton href={positionHref(created.tokenId)} size="lg" className="dm-seq-done-link" data-sequence-created-position={created.tokenId}>
            View position
          </LinkButton>
          <LinkButton href={chosen.key === 'domino' ? '#/docs/domino-compounder#start-and-stop' : '#/docs/auto-compound#where-it-starts'} variant="outline" size="lg" className="dm-seq-done-link">
            How to switch it on
            <IconChevronRight />
          </LinkButton>
        </div>
      </section>
    )
  }

  const pair = position?.currencies ?? null
  const phaseName = busy ? 'running' : !usable ? 'position' : !chosen ? 'mode' : baseIsCurrency0 === null ? 'quote' : 'limits'
  return (
    <Card className="dm-acct-block dm-acct-panel dm-seq-create" data-sequence-create={phaseName} data-sequence-create-mode={mode ?? undefined} aria-busy={busy || undefined}>
      <div className="dm-seq-grid">
        <div className="dm-seq-steps">
          <fieldset disabled={locked} className="dm-acct-fieldset" data-state={usable ? 'done' : 'current'}>
            {legend(1, !!usable, 'Your position')}
            <PositionPicker positions={positions} selected={position?.tokenId ?? null} onSelect={choosePosition} disabled={locked} notes={linked} />
          </fieldset>
          {/* The journey ahead, numbers only, until the next step opens. */}
          {!usable && (
            <div className="dm-seq-ghosts" aria-hidden="true">
              <span>2</span>
              <span>3</span>
              <span>4</span>
            </div>
          )}
          {usable && (
            <fieldset disabled={locked} className="dm-acct-fieldset" data-state={chosen ? 'done' : 'current'}>
              {legend(2, !!chosen, 'What the earned fees do')}
              <div className="dm-acct-choices dm-seq-modes" role="radiogroup" aria-label="Automation">
                {MODES.map((entry, index) => (
                  <Button
                    key={entry.key}
                    type="button"
                    role="radio"
                    aria-checked={mode === entry.key}
                    tabIndex={(mode ?? 'compound') === entry.key ? 0 : -1}
                    variant="outline"
                    className="dm-seq-mode"
                    disabled={locked}
                    onClick={() => chooseMode(entry.key)}
                    onKeyDown={(event) => {
                      // A radio group: the arrow keys choose the other mode and move focus to it.
                      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                      const other = (index ? event.currentTarget.previousElementSibling : event.currentTarget.nextElementSibling) as HTMLElement | null
                      chooseMode(MODES[1 - index].key)
                      other?.focus()
                    }}
                    data-sequence-mode={entry.key}
                  >
                    <ModeArt mode={entry.key} size="card" play={mode === entry.key ? 'once' : 'none'} />
                    <span>
                      {entry.title} · {entry.fee}
                    </span>
                  </Button>
                ))}
              </div>
              {chosen && <p className="dm-acct-line dm-acct-wrap dm-seq-chosen">{chosen.line}</p>}
            </fieldset>
          )}
          {usable && chosen && pair && (
            <fieldset disabled={locked} className="dm-acct-fieldset" data-state={baseIsCurrency0 === null ? 'current' : 'done'}>
              {legend(3, baseIsCurrency0 !== null, 'Quote currency')}
              <p className="dm-seq-hint">Prices are counted in this token. It can’t be changed later.</p>
              <div className="dm-seq-quotes" role="radiogroup" aria-label="Quote currency">
                {/* The quote measures the base: quoting currency 0 makes currency 1 the base, and the reverse. */}
                {([
                  [pair[0], false, 'currency0'],
                  [pair[1], true, 'currency1'],
                ] as const).map(([token, base0, side]) => (
                  <button key={side} type="button" role="radio" aria-checked={baseIsCurrency0 === base0} className="dm-seq-quote" disabled={locked} data-sequence-quote={side} onClick={() => chooseQuote(base0)}>
                    <AddressMark address={token.address} size={24} />
                    <bdi>{tokenName(token)}</bdi>
                  </button>
                ))}
              </div>
            </fieldset>
          )}
          {usable && chosen && baseIsCurrency0 !== null && (
            <fieldset disabled={locked} className="dm-acct-fieldset" data-state={consent ? 'done' : 'current'}>
              {legend(4, consent, 'Limits')}
              {chosen.key === 'domino' && <div className="dm-acct-fields">{DOMINO_FIELDS.map(field)}</div>}
              <details className="dm-details dm-acct-disclosure">
                <summary>More limits</summary>
                <div className="dm-acct-disclosure-body">
                  <div className="dm-acct-fields dm-acct-fields--3">{(chosen.key === 'domino' ? [...MORE_DOMINO, ...SAFETY_FIELDS] : SAFETY_FIELDS).map(field)}</div>
                </div>
              </details>
              <label className="dm-acct-check dm-seq-consent">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => {
                    changed()
                    setConsent(event.target.checked)
                  }}
                />
                <span>
                  I consent to using this NFT’s already uncollected fees, plus future earned fees, for {chosen.title} under these limits. The service fee is {chosen.fee} of earned fees consumed, once, never principal.
                </span>
              </label>
            </fieldset>
          )}
        </div>
        <aside className="dm-seq-aside" aria-label="Wallet steps">
          {chosen && !usable && (
            <div className="dm-plate dm-dots-plate dm-seq-stage" data-mode={chosen.key}>
              <ModeArt mode={chosen.key} size="card" play="loop" />
            </div>
          )}
          {usable && chosen?.key === 'domino' && <SuccessorAxis root={{ tokenId: usable.tokenId, lower: usable.tickLower, upper: usable.tickUpper, spacing: usable.tickSpacing }} inverse={baseIsCurrency0 === false} form={form} />}
          {usable && chosen?.key === 'compound' && <CompoundPreview />}
          {usable && stepList(usable.tokenId)}
          <Button type="button" variant="primary" size="xl" className="w-full" disabled={!ready || locked} aria-busy={busy || undefined} aria-describedby="sequence-reason" data-sequence-action={phase} onClick={() => void setUp()}>
            Set up automation
          </Button>
          <p id="sequence-reason" className="dm-flow-reason" data-align="start">
            {reason}
          </p>
          {notice && (
            <p role="status" className="dm-acct-line dm-acct-wrap dm-seq-notice" data-notice-code={notice.code ?? undefined} data-notice-stage={notice.stage ?? undefined}>
              {notice.text}
            </p>
          )}
        </aside>
      </div>
    </Card>
  )
}
