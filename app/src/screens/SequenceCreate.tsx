import { useEffect, useRef, useState } from 'react'
import type { Hex } from 'viem'
import { AUTOMATION_FEE_BPS, sequenceReadError, sequenceReadStage, type PreparedSequence } from '../finance/sequence'
import { RECEIPT_EVERY_MS, RECEIPT_WAIT_MS, settleStep, type Connected, type SequenceClient } from '../finance/sequenceLive'
import type { GasBudget } from '../finance/setup'
import type { AtomicStatus } from '../finance/batch'
import { errorCode, financeErrorText } from '../finance/words'
import { personRefused } from '../finance/nonce'
import { CREATE } from '../lib/create/copy'
import { SEQUENCE_DEFAULTS, sequenceOptionsFrom, type SequenceForm, type SequenceMode } from '../lib/create/sequenceDefaults'
import { preselected, tokenName } from '../lib/automate/picker'
import { noteAutomation, useAutomation } from '../lib/automationState'
import { positionHref } from '../components/explore/routes'
import type { WalletPosition } from '../lib/walletPositions'
import { Button, Card, LinkButton } from '../components/ui'
import { IconChevronRight } from '../components/icons'
import { ModeArt } from '../components/automate/ModeArt'
import { ModeSummary } from '../components/automate/ModeSummary'
import { LimitControl } from '../components/automate/LimitControl'
import { SuccessorAxis } from '../components/automate/SuccessorAxis'
import { CompoundPreview } from '../components/automate/CompoundPreview'
import { PositionPicker } from '../components/automate/PositionPicker'
import { AddressMark } from '../components/automate/marks'
import { SequenceSwitch } from '../components/positions/SequenceSwitch'
import { readAfterReplaced } from '../components/positions/walletSteps'

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

type Client = SequenceClient
/** `batch`: the approval and the creation as one batch (EIP-5792), one signature, when the wallet can. */
type StepKey = 'approve-root' | 'create' | 'batch'
/** `chain`: sent, its receipt read while the press runs. `sent`: sent, and the press ended before its receipt settled it: no spinner, no caption, since nothing reads it any more. */
type StepState = 'upcoming' | 'reading' | 'wallet' | 'chain' | 'sent' | 'done' | 'failed'
type Notice = { text: string; code: string | null; stage: string | null }

export interface SequenceIntent {
  mode: SequenceMode | null
  tokenId: string | null
}

/** What pressing Set up automation needs, fresh at each press (finance/sequenceLive.ts connectSequence). */
export type { Connected }

/** The primary action's name: the sentences that send the owner back to it name it (finance/words.ts). */
const ACTION = 'Set up automation'
// wallet_review_expired: a batch's review that ran out while its latch was claimed, freed before the wallet was asked (finance/batch.ts).
const BEFORE_WALLET = ['review_required', 'sequence_admission_unavailable', 'sequence_release_expired', 'sequence_activation_unavailable', 'sequence_tariff_changed', 'deployment_code_changed', 'deployment_identity_changed', 'root_approval_changed', 'wallet_review_expired']
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
  // The creation as one batch (EIP-5792; finance/batch.ts, finance/sequence.ts prepareCreateBatch).
  batch_upgrade_declined: `You declined turning on your wallet’s smart account. Nothing was created. Press ${ACTION} to go step by step, or sign both steps at once again.`,
  batch_simulation_reverted: `The batch would fail on chain now. Nothing was sent. Press ${ACTION} again.`,
  invalid_simulation_reply: 'The batch could not be checked just now. Nothing was sent. Try again in a moment.',
  batch_coordination_unavailable: `This browser cannot keep track of a batch here. Nothing was sent. Press ${ACTION} to go step by step.`,
  batch_already_offered: 'A batch for this sequence is already waiting in your wallet. Check your wallet activity: nothing is sent twice.',
  sequence_batch_dropped: `Your wallet did not include the batch. Nothing was created. Press ${ACTION} again.`,
  sequence_batch_unknown: `The batch’s outcome could not be read. Check your wallet activity, then press ${ACTION} again: the chain is read first, and nothing is sent twice.`,
  // 2026-10-01 (audit C14): a step the person cancelled in the wallet ("Cancel"), read back from the chain. The approval's
  // line is Create position's word for word. Changed on purpose 2026-10-01 (integration pass 3, the copy review): "the
  // creation step", not "the creation".
  sequence_approval_replaced: `Your wallet replaced the approval with another transaction, and nothing was approved. Press ${ACTION} again.`,
  sequence_creation_replaced: `Your wallet replaced the creation step with another transaction, and no automation was set up. Press ${ACTION} again.`,
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
const LIMIT_HELP: Partial<Record<keyof SequenceForm, string>> = {
  upsidePercent: 'How much higher the next range ends, compared with the top of this range.',
  sequenceCap: 'Includes this position and any following positions.',
  triggerPercent: 'How close the price must get to the top of this range before Domino can consider the next position.',
  maxOverlapPercent: 'How far the next range may extend below the top of this range.',
}
/** What a Domino-compound owner sets at a glance; everything else keeps its default under More limits. */
const DOMINO_FIELDS: (keyof SequenceForm)[] = ['upsidePercent', 'sequenceCap']
const MORE_DOMINO: (keyof SequenceForm)[] = ['triggerPercent', 'maxOverlapPercent']
const SAFETY_FIELDS: (keyof SequenceForm)[] = ['minimumIntervalMinutes', 'maxSlippagePercent', 'maxPriceImpactPercent', 'maxGasCostEth', 'maxObservationAgeMinutes', 'forecastHorizonHours']
const IDLE_STEPS: Record<StepKey, StepState> = { 'approve-root': 'upcoming', create: 'upcoming', batch: 'upcoming' }

/** A step that stopped because the page moved on (another wallet, another page): nothing is said. */
class Left extends Error {}

/** A failure while a step was offered to the wallet, kept apart from reads and preparation, which never reach it. */
class Offered extends Error {
  constructor(readonly inner: unknown) {
    super('offered')
  }
}

/**
 * Reads a sent step's receipt every few seconds until it settles (finance/sequenceLive.ts); throws unless it landed or
 * the wallet replaced it (2026-10-01, audit C14: the caller reads the chain again), and stops quietly once the page
 * moved on.
 */
async function settle(client: Client, hash: Hex, here: () => boolean): Promise<'landed' | 'replaced'> {
  const settled = await settleStep(client, hash, here)
  if (settled === 'left') throw new Left()
  return settled
}

/**
 * Whether the sequence a creation the wallet replaced was prepared for stands at its address now (audit C14): a sped-up
 * creation made it, a cancelled one did not (no code there yet). Read until it does, a few times (walletSteps.ts
 * readAfterReplaced); throws Left once the page moved on, and what cannot be read. Nothing is sent from here.
 */
async function createdAfterReplaced(client: Client, vault: `0x${string}`, here: () => boolean): Promise<boolean> {
  const exists = () => client.inspect(vault).then(() => true, (error: unknown) => {
    if (errorCode(error) === 'unqualified_sequence') return false
    throw error
  })
  const made = await readAfterReplaced(exists, (found) => found, here)
  if (made === null) throw new Left()
  return made
}

/**
 * Reads a sent creation batch until the vault stands at its predicted address; throws when it cannot, and stops quietly
 * once the page moved on. A read that fails (a busy wallet, a node behind) is read again at the next beat.
 */
async function settleBatch(client: Client, id: string, prepared: { vault: `0x${string}`; sequenceId: Hex }, here: () => boolean): Promise<`0x${string}`> {
  const until = Date.now() + RECEIPT_WAIT_MS
  for (let beat = 0; ; beat++) {
    if (!here()) throw new Left()
    let read: Awaited<ReturnType<Client['createBatchStatus']>> | null = null
    try {
      read = await client.createBatchStatus(id, prepared)
    } catch (error) {
      if (Date.now() > until) throw error
    }
    if (read?.state === 'created') return read.vault
    if (read?.state === 'dropped') throw new Error('sequence_batch_dropped')
    if (read?.state === 'reverted') throw new Error('sequence_step_reverted')
    if (read?.state === 'unknown') throw new Error('sequence_batch_unknown')
    if (Date.now() > until) throw new Error('sequence_receipt_waiting')
    await new Promise((resolve) => setTimeout(resolve, RECEIPT_EVERY_MS))
  }
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
          : personRefused(inner)
            ? `You declined in your wallet. Press ${ACTION} to try again.`
            // Changed on purpose 2026-10-01 (audit E3): no "nonce" on screen; the latch it names still holds the step.
            : 'Your wallet may or may not have sent it. Check your wallet activity before trying again. This step won’t be offered twice, even after a reload.'
  return { text: sent ? text.replace(NOTHING, '') : text, code, stage: sequenceReadStage(inner) }
}

export default function SequenceCreate({ positions, intent, connect, capabilities, onCreated }: { positions: readonly WalletPosition[]; intent: SequenceIntent; connect: () => Promise<Connected>; capabilities?: () => Promise<AtomicStatus>; onCreated?: (vault: `0x${string}`) => void }) {
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
  // What the connected wallet can do with a batch (EIP-5792), asked once: nothing is signed or sent for it.
  const [atomic, setAtomic] = useState<AtomicStatus | null>(null)
  // Whether the last press asked for one signature: the list shows one step, and its line says so.
  const [batching, setBatching] = useState(false)
  useEffect(() => {
    if (!capabilities) return
    let live = true
    capabilities().then(
      (status) => { if (live) setAtomic(status) },
      () => { if (live) setAtomic('unsupported') },
    )
    return () => { live = false }
  }, [capabilities])

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

  /**
   * Offers one prepared step to the wallet, then reads its receipt until it settles. Returns once it is in, or once the
   * wallet replaced it (2026-10-01, audit C14: "Speed up" or "Cancel"; the caller reads the chain again to know whether
   * it happened, and marks the step). `press.sent` names the step once the wallet gave its hash.
   */
  async function sendAndWait(client: Client, step: PreparedSequence, key: StepKey, gen: number, press: { sent: StepKey | null }): Promise<'landed' | 'replaced'> {
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
    if ((await settle(client, hash, () => generation.current === gen)) === 'replaced') return 'replaced'
    mark(key, 'done', gen)
    return 'landed'
  }

  /**
   * The approval and the creation as one batch (EIP-5792): prepared and simulated whole, offered once, and read back
   * from the chain until the vault stands at its predicted address. Null: this wallet cannot make or simulate the batch
   * after all, and the same press goes on step by step.
   */
  async function createInOneBatch(client: Client, options: Parameters<Client['prepareCreateBatch']>[0], gas: GasBudget, gen: number, press: { sent: StepKey | null }): Promise<`0x${string}` | null> {
    mark('batch', 'reading', gen)
    let prepared: Awaited<ReturnType<Client['prepareCreateBatch']>> | null = null
    try {
      prepared = await client.prepareCreateBatch(options, gas)
    } catch (error) {
      if (errorCode(error) === 'batch_simulation_unavailable') return null
      throw error
    }
    if (generation.current !== gen) throw new Left()
    mark('batch', 'wallet', gen)
    let id = ''
    try {
      id = await client.sendCreateBatch(prepared, true)
    } catch (error) {
      if (errorCode(error) === 'batch_unsupported') {
        if (generation.current === gen) setAtomic('unsupported')
        return null
      }
      throw new Offered(error)
    }
    press.sent = 'batch'
    mark('batch', 'chain', gen)
    const vault = await settleBatch(client, id, prepared, () => generation.current === gen)
    mark('batch', 'done', gen)
    return vault
  }

  /** `batch`: one signature for the approval and the creation, for a wallet that can; by default when it can without an upgrade. */
  async function setUp(batch = atomic === 'supported') {
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
    setBatching(batch)
    setSteps({ 'approve-root': batch ? 'upcoming' : 'reading', create: 'upcoming', batch: 'upcoming' })
    try {
      const { client, gas, verified } = await connect()
      if (generation.current !== gen) throw new Left()
      // The position read first, as the page read it before: the deployment verified, the NFT this wallet's and in no sequence. Its
      // reads are the classified ones (a provider's reply never reaches the page), with the read snapshot behind a refused call.
      await client.inspectRoot(checked.options.rootTokenId).catch((error) => {
        throw sequenceReadError(error)
      })
      if (generation.current !== gen) throw new Left()
      if (batch) {
        at = 'batch'
        const vault = await createInOneBatch(client, checked.options, gas, gen, press)
        if (vault) {
          verified()
          if (generation.current !== gen) return
          setCreated({ vault, tokenId: position.tokenId })
          noteAutomation({ tokenId: position.tokenId, automation: mode, paused: true, active: false, vault })
          setPhase('done')
          onCreated?.(vault)
          return
        }
        // This wallet cannot batch after all: the same press goes on step by step.
        at = 'approve-root'
        if (generation.current === gen) {
          setBatching(false)
          setSteps({ 'approve-root': 'reading', create: 'upcoming', batch: 'upcoming' })
        }
      }
      let step = await client.create(checked.options, gas)
      verified()
      if (step.kind === 'approve-root') {
        if ((await sendAndWait(client, step, 'approve-root', gen, press)) === 'replaced') {
          // 2026-10-01 (audit C14): an approval the wallet replaced is in only if the chain shows the NFT approved to the
          // sequence now (a sped-up one); a cancelled one stops this press at its own step, and is never asked again in it.
          const root = checked.options.rootTokenId
          const approved = await readAfterReplaced(() => client.inspectRoot(root), (read) => read.approved === read.vault, () => generation.current === gen)
          if (approved === null) throw new Left()
          if (!approved) throw new Error('sequence_approval_replaced')
          mark('approve-root', 'done', gen)
        }
        at = 'create'
        mark('create', 'reading', gen)
        step = await client.create(checked.options, gas)
        // Its approval is in, so the creation is what the chain prepares now; anything else is no longer this sequence.
        if (step.kind !== 'create') throw new Error('sequence_preparation_changed')
      } else {
        mark('approve-root', 'done', gen)
      }
      at = 'create'
      // 2026-10-01 (audit C14): a creation the wallet replaced is made only if the sequence stands at its address now.
      if ((await sendAndWait(client, step, 'create', gen, press)) === 'replaced') {
        if (!(await createdAfterReplaced(client, step.vault, () => generation.current === gen))) throw new Error('sequence_creation_replaced')
        mark('create', 'done', gen)
      }
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
      // A batch the wallet did not include failed as surely as one that reverted: nothing of it can execute. So did a step
      // the wallet replaced that the chain does not show (2026-10-01, audit C14).
      mark(at, press.sent !== at || ['sequence_step_reverted', 'sequence_batch_dropped', 'sequence_approval_replaced', 'sequence_creation_replaced'].includes(errorCode(error) ?? '') ? 'failed' : 'sent', gen)
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
              ? batching
                ? 'Confirm the batch in your wallet: one signature for both steps. The list marks it as it goes.'
                : 'Confirm each step in your wallet. The list marks each one as it is done.'
              : atomic === 'supported'
                ? 'Your wallet asks you to sign once: the approval and the sequence together.'
                : 'Your wallet asks you to approve the position, then to create the sequence.'
  // A wallet that could batch once it turns on its smart account: offered beside the steps, never chosen for the person.
  const offerBatch = atomic === 'ready' && ready && !locked

  const field = (name: keyof SequenceForm) => (
    <LimitControl key={name} name={name} value={form[name]} onEdit={(value) => edit(name, value)}>
      <label className="dm-label dm-acct-lf">
        {LIMIT_LABELS[name]}
        <input className="dm-field" inputMode="decimal" value={form[name]} onChange={(event) => edit(name, event.target.value)} />
      </label>
      {LIMIT_HELP[name] && <p className="dm-seq-hint">{LIMIT_HELP[name]}</p>}
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
      {(batching ? (['batch'] as const) : (['approve-root', 'create'] as const)).map((key, index) => {
        const state = steps[key]
        const active = state === 'reading' || state === 'wallet' || state === 'chain'
        const caption = state === 'wallet' ? 'Confirm in your wallet.' : state === 'chain' ? 'Waiting for the network.' : state === 'upcoming' && key !== 'approve-root' ? 'It starts paused.' : null
        return (
          <li key={key} data-wallet-step={key} data-step-state={state}>
            <span aria-hidden="true" className="dm-step-marker" data-state={state === 'done' ? 'done' : active ? 'current' : undefined}>
              {state === 'done' ? '✓' : index + 1}
            </span>
            <span className="dm-flow-wstep-body">
              <span className="dm-flow-wstep-title">{key === 'approve-root' ? `Approve position #${tokenId}` : key === 'batch' ? `Approve position #${tokenId} and create the sequence` : 'Create the sequence'}</span>
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
          {/* Turn on once the automation service says it is ready for this sequence (2026-09-25); until then, the docs. */}
          <SequenceSwitch
            tokenId={created.tokenId}
            liquid
            signIn={false}
            size="lg"
            fallback={
              <LinkButton href={chosen.key === 'domino' ? '#/docs/domino-compound#start-and-stop' : '#/docs/auto-compound#where-it-starts'} variant="outline" size="lg" className="dm-seq-done-link">
                How to switch it on
                <IconChevronRight />
              </LinkButton>
            }
          />
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
                    <ModeSummary mode={entry.key} title={entry.title} fee={entry.fee} />
                  </Button>
                ))}
              </div>
              <p className="dm-seq-hint">The service fee applies once to earned fees used. Your original deposit is not charged.</p>
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
                  I consent to using this NFT’s already uncollected fees, plus future earned fees, for {chosen.title} under these limits. The service fee is {chosen.fee} of the earned fees it uses, once, never principal.
                </span>
              </label>
            </fieldset>
          )}
        </div>
        <aside className="dm-seq-aside" aria-label="Wallet steps">
          <div className="dm-auto-aside-heading"><h2>Your automation</h2></div>
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
          {offerBatch && (
            <>
              <Button type="button" variant="outline" size="md" className="w-full" onClick={() => void setUp(true)} data-sequence-batch="offer" aria-describedby="sequence-batch-note">
                Sign both steps at once
              </Button>
              <p id="sequence-batch-note" className="dm-flow-reason" data-align="start">
                {CREATE.review.batchOfferNote}
              </p>
            </>
          )}
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
