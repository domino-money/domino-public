import { useEffect, useRef, useState } from 'react'
import type { Hex } from 'viem'
import { AUTOMATION_FEE_BPS, createSequenceClient, type PreparedSequence, type SequenceState } from '../finance/sequence'
import type { GasBudget } from '../finance/setup'
import { RECEIPT_TEXT, SEQUENCE_STEP_TEXT, errorCode, financeErrorText } from '../finance/words'
import { CREATE } from '../lib/create/copy'
import { SEQUENCE_DEFAULTS, sequenceOptionsFrom, type SequenceForm, type SequenceMode } from '../lib/create/sequenceDefaults'
import { formatUnits } from '../lib/read/decimal'
import { shortAddress } from '../lib/read/screens/identity'
import { Button, Card } from '../components/ui'

/**
 * Putting a position's earned fees to work, from the position: the second and
 * third things Domino does, on a position that already exists. The owner
 * names the position NFT (or arrives with it from Positions or from the
 * deposit that minted it), chooses Auto-compound (same position, 2 %) or
 * Domino-compound (the next range up, 4 %), chooses the immutable quote
 * currency, keeps or changes the limits, and
 * reviews two wallet steps: the NFT's approval to its predicted sequence, then
 * the sequence's creation. The sequence is born paused; the root NFT stays in
 * the wallet.
 *
 * The same client as the owner controls below (finance/sequence.ts): the
 * deployment is verified through the wallet, every step is prepared against
 * the chain, offered to the wallet once and read back by hash. The limits
 * arrive in the units a person reads (lib/create/sequenceDefaults.ts) and go
 * out as the basis points, seconds and wei the contracts take.
 *
 * Creation needs no private session and no running service. It does not
 * activate the vault: the owner controls check live, owner-scoped service
 * readiness before offering that separate wallet transaction.
 */

type Client = ReturnType<typeof createSequenceClient>
type Root = Awaited<ReturnType<Client['inspectRoot']>>
type Notice = { text: string; code: string | null }
type ReceiptState = keyof typeof RECEIPT_TEXT
type Sent = { hash: Hex; kind: PreparedSequence['kind']; vault: `0x${string}`; state: ReceiptState | 'checking' }
export interface SequenceIntent {
  mode: SequenceMode | null
  tokenId: string | null
}

const NATIVE_DECIMALS = 18
const RECEIPT_WAIT_MS = 240_000
const RECEIPT_EVERY_MS = 3_000
const SETTLED: readonly (ReceiptState | 'checking')[] = ['confirming', 'finalized', 'reverted', 'reorged', 'over_budget', 'over_budget_finalized']
const BEFORE_WALLET = ['review_required', 'sequence_admission_unavailable', 'sequence_release_expired', 'sequence_preparation_changed', 'sequence_activation_unavailable', 'sequence_tariff_changed', 'deployment_code_changed', 'deployment_identity_changed', 'root_approval_changed']
const costOf = (prepared: PreparedSequence): bigint => BigInt(prepared.transaction.gas) * BigInt(prepared.transaction.maxFeePerGas)
const tokenIdOf = (text: string): bigint | null => (/^[1-9]\d{0,77}$/.test(text.trim()) ? BigInt(text.trim()) : null)

const MODES: readonly { key: SequenceMode; title: string; line: string; fee: string }[] = [
  { key: 'compound', title: CREATE.automation.options.compound.title, line: CREATE.automation.options.compound.line, fee: `${AUTOMATION_FEE_BPS.compound / 100}%` },
  { key: 'domino', title: CREATE.automation.options.domino.title, line: CREATE.automation.options.domino.line, fee: `${AUTOMATION_FEE_BPS.domino / 100}%` },
]

const LIMIT_LABELS: Record<keyof SequenceForm, string> = {
  triggerPercent: 'Trigger distance (%)',
  maxOverlapPercent: 'Maximum overlap (%)',
  sequenceCap: 'Positions in the sequence',
  upsidePercent: 'Successor upside (%)',
  minimumIntervalMinutes: 'Minimum time between runs (minutes)',
  maxSlippagePercent: 'Maximum swap slippage (%)',
  maxPriceImpactPercent: 'Maximum price impact (%)',
  maxGasCostEth: 'Gas cap per run (ETH)',
  maxObservationAgeMinutes: 'Price reading may be this old (minutes)',
  forecastHorizonHours: 'Forecast horizon (hours)',
}
const DOMINO_FIELDS: (keyof SequenceForm)[] = ['upsidePercent', 'sequenceCap', 'triggerPercent', 'maxOverlapPercent']
const SAFETY_FIELDS: (keyof SequenceForm)[] = ['minimumIntervalMinutes', 'maxSlippagePercent', 'maxPriceImpactPercent', 'maxGasCostEth', 'maxObservationAgeMinutes', 'forecastHorizonHours']

export default function SequenceCreate({ client, gasFor, intent, initialRoot, onCreated }: { client: Client; gasFor: (() => Promise<GasBudget>) | null; intent: SequenceIntent; initialRoot: Root | null; onCreated?: (vault: `0x${string}`) => void }) {
  const [tokenIdText, setTokenIdText] = useState(intent.tokenId ?? '')
  const [root, setRoot] = useState<Root | null>(initialRoot)
  const [mode, setMode] = useState<SequenceMode | null>(intent.mode)
  const [baseIsCurrency0, setBaseIsCurrency0] = useState<boolean | null>(null)
  const [form, setForm] = useState<SequenceForm>(SEQUENCE_DEFAULTS)
  const [consent, setConsent] = useState(false)
  const [prepared, setPrepared] = useState<PreparedSequence | null>(null)
  const [ack, setAck] = useState(false)
  const [sent, setSent] = useState<Sent | null>(null)
  const [created, setCreated] = useState<SequenceState | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const generation = useRef(0)
  const running = useRef(false)
  const say = (text: string, code: string | null = null) => setNotice({ text, code })

  async function action(work: () => Promise<void>) {
    if (running.current) return
    running.current = true
    setBusy(true)
    setNotice(null)
    const gen = generation.current
    try {
      await work()
    } catch (error) {
      if (generation.current === gen) say(financeErrorText(errorCode(error), 'The wallet read or simulation could not be completed. No transaction was sent.', 'Read my sequences'), errorCode(error))
    } finally {
      if (generation.current === gen) {
        running.current = false
        setBusy(false)
      }
    }
  }

  /** Reads the position from chain: its pool and range, and that this wallet owns it. Reads only. */
  async function readRoot(text: string) {
    const id = tokenIdOf(text)
    if (id === null) {
      say('Enter the position NFT id: a whole number.')
      return
    }
    const gen = generation.current
    const result = await client.inspectRoot(id)
    if (generation.current === gen) setRoot(result)
  }
  useEffect(() => () => void generation.current++, [])

  const invalidate = () => {
    generation.current++
    setPrepared(null)
    setAck(false)
  }
  const edit = (name: keyof SequenceForm, value: string) => {
    invalidate()
    setForm((old) => ({ ...old, [name]: value }))
  }
  const choose = (next: SequenceMode) => {
    invalidate()
    setMode(next)
    setConsent(false)
  }
  const chooseQuote = (nextBaseIsCurrency0: boolean) => {
    invalidate()
    setBaseIsCurrency0(nextBaseIsCurrency0)
  }

  async function review() {
    if (!root || !mode || baseIsCurrency0 === null || !gasFor) return
    const gen = generation.current
    const options = sequenceOptionsFrom(mode, root.tokenId, baseIsCurrency0, form)
    if (!options.ok) {
      say(options.reason)
      return
    }
    const gas = await gasFor()
    const step = await client.create(options.options, gas)
    if (generation.current === gen) setPrepared(step)
  }

  async function follow(done: Sent) {
    if (done.state === 'reverted' || done.state === 'reorged') {
      say(done.state === 'reverted' ? 'The transaction reverted: nothing changed, only network gas was spent. Read the position again and review the step again.' : 'The block that held the transaction left the canonical chain. Check your wallet activity before reviewing the step again.')
      return
    }
    if (done.kind === 'approve-root') {
      // The approval is in: the creation is the next step, reviewed on its own.
      await review()
      return
    }
    if (done.kind === 'create') {
      const state = await client.inspect(done.vault)
      setCreated(state)
      onCreated?.(done.vault)
    }
  }

  async function send() {
    if (!prepared || !ack || running.current) return
    const step = prepared
    const gen = generation.current
    running.current = true
    setBusy(true)
    setNotice(null)
    setPrepared(null)
    setAck(false)
    try {
      const hash = await client.send(step, true)
      if (generation.current !== gen) return
      let state: Sent = { hash, kind: step.kind, vault: step.vault, state: 'checking' }
      setSent(state)
      const until = Date.now() + RECEIPT_WAIT_MS
      while (Date.now() < until && !SETTLED.includes(state.state)) {
        await new Promise((resolve) => setTimeout(resolve, RECEIPT_EVERY_MS))
        if (generation.current !== gen) return
        const receipt = await client.receipt(hash)
        state = { ...state, state: receipt.state }
        setSent(state)
      }
      if (generation.current !== gen) return
      if (!SETTLED.includes(state.state)) {
        say('The transaction is still waiting to be included. Check your wallet activity, then read the position again.')
        return
      }
      await follow(state)
    } catch (error) {
      if (generation.current !== gen) return
      say(
        error instanceof Error && BEFORE_WALLET.includes(error.message)
          ? 'The preparation is no longer valid. No wallet transaction was requested. Read the position again, then review the step again.'
          : error && typeof error === 'object' && (error as { code?: unknown }).code === 4001
            ? 'Wallet request rejected. Review the step again if you want to continue.'
            : 'The wallet outcome may be unknown. Check wallet activity and chain state before continuing. This nonce stays protected against another offer, including after reload.',
        errorCode(error),
      )
    } finally {
      if (generation.current === gen) {
        running.current = false
        setBusy(false)
      }
    }
  }

  const phase = created ? 'done' : prepared ? 'review' : root ? (mode ? 'limits' : 'mode') : 'position'
  const chosen = MODES.find((entry) => entry.key === mode) ?? null

  return (
    <Card className="dm-acct-block dm-acct-panel" data-sequence-create={phase} data-sequence-create-mode={mode ?? undefined}>
      <h2 className="dm-acct-panel-title">Put a position’s earned fees to work</h2>
      <p className="dm-acct-panel-note">
        Choose one of your positions, then Auto-compound or Domino-compound. Two wallet steps: the NFT’s approval to its own sequence, then the sequence’s creation. The NFT stays in your wallet, and a created sequence starts paused.
      </p>
      {notice && (
        <p role="status" className="dm-acct-line dm-acct-wrap" data-notice-code={notice.code ?? undefined}>
          {notice.text}
        </p>
      )}
      {created ? (
        <section className="dm-inset dm-acct-stack" aria-label="Sequence created" data-sequence-created={created.vault}>
          <h3 className="dm-acct-subtitle">
            {chosen?.title ?? 'The sequence'} is set up for position NFT {created.rootTokenId.toString()}
          </h3>
          <p className="dm-acct-line dm-acct-wrap">Sequence {created.vault} · paused · operator {shortAddress(created.operator)} · your NFT stays in your wallet.</p>
          <p className="dm-acct-line dm-acct-wrap">Activation is a separate owner transaction. Owner controls offer it only after a live service check.</p>
          <p className="dm-acct-line">Pause, rules, limits and withdrawals are in the owner controls below.</p>
        </section>
      ) : (
        <>
          <fieldset disabled={busy} className="dm-acct-fieldset">
            <legend className="dm-acct-subtitle">1 · The position</legend>
            <div className="dm-acct-fields">
              <label className="dm-label dm-acct-lf">
                Position NFT id
                <input
                  className="dm-field dm-acct-mono-field"
                  inputMode="numeric"
                  value={tokenIdText}
                  onChange={(event) => {
                    invalidate()
                    setTokenIdText(event.target.value)
                    setRoot(null)
                    setBaseIsCurrency0(null)
                  }}
                />
              </label>
            </div>
            <div className="dm-acct-choices">
              <Button variant="outline" disabled={busy} onClick={() => { invalidate(); setRoot(null); setBaseIsCurrency0(null); void action(() => readRoot(tokenIdText)) }}>
                Read the position
              </Button>
            </div>
            {root && (
              <p className="dm-acct-line dm-acct-wrap" data-sequence-root={root.tokenId.toString()}>
                NFT {root.tokenId.toString()} · pool {shortAddress(root.poolId)} · ticks {root.lower} to {root.upper} · {shortAddress(root.key.currency0)} / {shortAddress(root.key.currency1)}. Yours, and not in a sequence.
              </p>
            )}
          </fieldset>
          {root && (
            <fieldset disabled={busy} className="dm-acct-fieldset">
              <legend className="dm-acct-subtitle">2 · What the earned fees do</legend>
              <div className="dm-acct-choices" role="radiogroup" aria-label="Automation">
                {MODES.map((entry) => (
                  <Button key={entry.key} type="button" role="radio" aria-checked={mode === entry.key} variant={mode === entry.key ? 'primary' : 'outline'} disabled={busy} onClick={() => choose(entry.key)} data-sequence-mode={entry.key}>
                    {entry.title} · {entry.fee}
                  </Button>
                ))}
              </div>
              {chosen && (
                <p className="dm-acct-line dm-acct-wrap">
                  {chosen.line} The service fee is {chosen.fee} of earned fees consumed, once, never principal.
                </p>
              )}
            </fieldset>
          )}
          {root && mode && (
            <fieldset disabled={busy} className="dm-acct-fieldset">
              <legend className="dm-acct-subtitle">3 · Quote currency</legend>
              <p className="dm-acct-panel-note">Choose how this sequence measures price: quote units for one base unit. Domino successors follow higher prices in this orientation. The choice is fixed when the sequence is created.</p>
              <div className="dm-acct-stack" role="radiogroup" aria-label="Quote currency">
                <label className="dm-acct-check dm-acct-wrap">
                  <input type="radio" name="sequence-quote-currency" value="currency0" checked={baseIsCurrency0 === false} onChange={() => chooseQuote(false)} />
                  <span>Quote: currency 0 ({root.key.currency0}); base: currency 1 ({root.key.currency1})</span>
                </label>
                <label className="dm-acct-check dm-acct-wrap">
                  <input type="radio" name="sequence-quote-currency" value="currency1" checked={baseIsCurrency0 === true} onChange={() => chooseQuote(true)} />
                  <span>Quote: currency 1 ({root.key.currency1}); base: currency 0 ({root.key.currency0})</span>
                </label>
              </div>
            </fieldset>
          )}
          {root && mode && (
            <fieldset disabled={busy} className="dm-acct-fieldset">
              <legend className="dm-acct-subtitle">4 · Limits</legend>
              {mode === 'domino' && (
                <div className="dm-acct-fields">
                  {DOMINO_FIELDS.map((name) => (
                    <label className="dm-label dm-acct-lf" key={name}>
                      {LIMIT_LABELS[name]}
                      <input className="dm-field" inputMode="decimal" value={form[name]} onChange={(event) => edit(name, event.target.value)} />
                    </label>
                  ))}
                </div>
              )}
              <details className="dm-details dm-acct-disclosure">
                <summary>Safety limits every run is bound by</summary>
                <div className="dm-acct-disclosure-body">
                  <div className="dm-acct-fields">
                    {SAFETY_FIELDS.map((name) => (
                      <label className="dm-label dm-acct-lf" key={name}>
                        {LIMIT_LABELS[name]}
                        <input className="dm-field" inputMode="decimal" value={form[name]} onChange={(event) => edit(name, event.target.value)} />
                      </label>
                    ))}
                  </div>
                </div>
              </details>
              <label className="dm-acct-check">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => {
                    invalidate()
                    setConsent(event.target.checked)
                  }}
                />
                <span>
                  I consent to using this NFT’s already uncollected fees, plus future earned fees, for {chosen?.title} under these limits. The service fee is {chosen?.fee} of earned fees consumed, once, never principal.
                </span>
              </label>
              <div className="dm-acct-choices">
                <Button disabled={busy || !consent || baseIsCurrency0 === null || !gasFor} onClick={() => void action(review)}>
                  Review the wallet steps
                </Button>
              </div>
            </fieldset>
          )}
          {prepared && (
            <section className="dm-inset dm-acct-review" aria-label="Sequence wallet review" data-sequence-create-review={prepared.kind}>
              <h3 className="dm-acct-subtitle">Review {SEQUENCE_STEP_TEXT[prepared.kind]}</h3>
              {prepared.summary.map((line) => (
                <p className="dm-acct-line dm-acct-wrap" key={line}>
                  {line}
                </p>
              ))}
              <p className="dm-acct-line">Maximum network cost: {formatUnits(String(costOf(prepared)), NATIVE_DECIMALS)?.text ?? String(costOf(prepared))} ETH.</p>
              <label className="dm-acct-check">
                <input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} /> I reviewed the NFT, owner, sequence address, currencies, fees and limits for this single step.
              </label>
              <div className="dm-acct-choices">
                <Button variant="accent" disabled={!ack || busy} onClick={() => void send()}>
                  Send this step in wallet
                </Button>
                <Button variant="ghost" disabled={busy} onClick={invalidate}>
                  Back
                </Button>
              </div>
            </section>
          )}
        </>
      )}
      {sent && (
        <p className="dm-acct-hash" data-sequence-create-sent={sent.kind} data-sequence-create-receipt={sent.state}>
          {SEQUENCE_STEP_TEXT[sent.kind]} · {sent.hash} · {sent.state === 'checking' ? 'Waiting for the receipt' : RECEIPT_TEXT[sent.state]}
        </p>
      )}
    </Card>
  )
}
