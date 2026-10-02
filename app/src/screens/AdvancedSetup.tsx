import { useEffect, useRef, useState, type ReactNode } from 'react'
import { watchConnection } from 'wagmi/actions'
import { zeroAddress, type Address, type Hex } from 'viem'
import { walletConfig } from '../wallet/config'
import { confirmDelegate, setupWallet } from '../finance/wallet'
import { createReleaseWatch, readRelease, type ReleaseRead } from '../finance/release'
import { createSetupClient, deploymentFrom, raw, type PreparedSetup, type SetupOperation, type SetupDeployment } from '../finance/setup'
import { saveSetupProfile, savedSetupProfile } from '../finance/recoveryProfile'
import { RECEIPT_TEXT, SETUP_STEP_TEXT, errorCode, financeErrorText } from '../finance/words'
import { financialFetch } from '../finance/http'
import { personRefused } from '../finance/nonce'
import { realClock } from '../lib/clock'
import { livePort } from '../session/livePort'
import { SwapQuote } from '../components/preview/SwapQuote'
import { SlippageChoice } from '../components/create/SlippageChoice'
import { SLIPPAGE_DEFAULT_BPS, slippageBpsFrom } from '../lib/create/slippage'
import { Button, Card } from '../components/ui'
import { walletChanged } from '../lib/walletPositions'

const defaults = { currency0: '', currency1: '', fee: '3000', tickSpacing: '60', amount0: '', amount1: '', grossSwap: '', maxImpact: '100', sqrtLimit: '',
  tickLower: '', tickUpper: '', liquidity: '', maxAmount0: '', maxAmount1: '', minPrice: '', maxPrice: '', initialPrice: '0',
  maxGas: '', maxFee: '', priorityFee: '', reserve: '', operationId: '', transactionHash: '' }
const labels: Record<keyof typeof defaults, string> = { currency0: 'Token 0 address (lower address; zero address for native)', currency1: 'Token 1 address', fee: 'Pool fee (pips)', tickSpacing: 'Tick spacing',
  amount0: 'Fund token 0 (smallest units)', amount1: 'Fund token 1 (smallest units)', grossSwap: 'Swap gross input (smallest units, includes Domino fee)', maxImpact: 'Maximum price impact for the quote (basis points)', sqrtLimit: 'Swap sqrtPriceX96 limit',
  tickLower: 'Lower tick', tickUpper: 'Upper tick', liquidity: 'Liquidity (raw)', maxAmount0: 'Mint token 0 cap (smallest units)', maxAmount1: 'Mint token 1 cap (smallest units)',
  minPrice: 'Minimum sqrtPriceX96', maxPrice: 'Maximum sqrtPriceX96', initialPrice: 'Initial sqrtPriceX96 (0 for an existing pool)', maxGas: 'Maximum gas units', maxFee: 'Maximum fee per gas (wei)', priorityFee: 'Maximum priority fee (wei)', reserve: 'Keep native gas reserve (wei)', operationId: 'Operation ID', transactionHash: 'Wallet transaction hash' }
type Client = ReturnType<typeof createSetupClient>
type Release = { kind: 'loading' } | ReleaseRead<SetupDeployment>
type Notice = { text: string; code: string | null }
const readSetupRelease = (signal?: AbortSignal) => readRelease('/api/setup/v1/release', value => deploymentFrom(value), undefined, undefined, signal)
const watchSetupRelease = createReleaseWatch(readSetupRelease)
/** For a loaded client: the published profile now, or null when it is no longer published. */
const currentSetupDeployment = async () => { const release = await readSetupRelease(); return release.kind === 'available' ? release.deployment : null }

/**
 * The assisted swap's fields, folded until the owner opens them. Whether they
 * are open lives with the disclosure itself: mounted again (after the release
 * went away and came back, or another wallet), it starts folded, so its quote
 * is never asked for fields nobody opened.
 */
function AssistedSwap({ children }: { children: (open: boolean) => ReactNode }) {
  const [open, setOpen] = useState(false)
  return <details className="dm-details dm-acct-disclosure" data-assisted-swap="" onToggle={e => setOpen(e.currentTarget.open)}><summary>Optional assisted swap</summary><div className="dm-acct-disclosure-body">{children(open)}</div></details>
}

/** Advanced owner actions remain usable without a private session. The release
 * holds public identities only; it grants no spending or automation authority.
 * It is read once on mount with a public GET; the wallet is asked only when the
 * owner presses a button. Without a published release only recovery remains,
 * and only for a profile this browser saved: with neither, there is no card.
 * `slippageBps` is the deposit draft's limit on the same page, when there is
 * one: the balancing swap's minimum output is drawn with it until the owner
 * sets the swap's own limit here. */
export default function AdvancedSetup({ slippageBps }: { slippageBps?: string } = {}) {
  const [release, setRelease] = useState<Release>({ kind: 'loading' }), [saved] = useState(savedSetupProfile)
  const [form, setForm] = useState(defaults), [client, setClient] = useState<Client | null>(null), [recovery, setRecovery] = useState(false)
  // The swap's own limit once the owner sets one; until then the draft's choice, or the default, over the one bound (lib/create/slippage.ts).
  const [ownSwapSlippage, setOwnSwapSlippage] = useState<string | null>(null)
  const swapSlippage = ownSwapSlippage ?? (slippageBps !== undefined && slippageBpsFrom(slippageBps) !== null ? slippageBps : String(SLIPPAGE_DEFAULT_BPS))
  const [operation, setOperation] = useState<SetupOperation | null>(null), [recent, setRecent] = useState<{ id: Hex; operation: SetupOperation }[]>([])
  const [prepared, setPrepared] = useState<PreparedSetup | null>(null), [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState<Notice | null>(null), [direction, setDirection] = useState(true)
  // The EIP-7702 delegate the funding's own check stopped at (finance/delegates.ts), until the owner confirms it or acts again.
  const [unrecognized, setUnrecognized] = useState<{ owner: Address; delegate: Address } | null>(null)
  const generation = useRef(0), running = useRef(false)
  const say = (text: string, code: string | null = null) => setNotice({ text, code })
  useEffect(() => watchSetupRelease(setRelease), [])
  useEffect(() => watchConnection(walletConfig, { onChange: () => { generation.current++; running.current = false; setClient(null); setRecovery(false); setOperation(null); setRecent([]); setPrepared(null); setAck(false); setBusy(false); setForm(defaults); setOwnSwapSlippage(null); setNotice(null); setUnrecognized(null) } }), [])
  useEffect(() => () => { generation.current++ }, [])
  // A swap reviewed at one limit is not the swap at another: a limit that moves under a prepared step drops that review, as any edit does.
  const reviewedSlippage = useRef(swapSlippage)
  useEffect(() => {
    if (reviewedSlippage.current === swapSlippage) return
    reviewedSlippage.current = swapSlippage
    generation.current++; setPrepared(null); setAck(false)
  }, [swapSlippage])
  const available = release.kind === 'available'
  const profile = available ? release.deployment : release.kind === 'unavailable' ? saved : null
  // A typed Operation ID names another operation: the one read from chain before, and the swap pair it gave the quote, no longer apply.
  const edit = (name: keyof typeof defaults, value: string) => { generation.current++; setForm(old => ({ ...old, [name]: value })); setPrepared(null); setAck(false); if (name === 'operationId') setOperation(null) }
  async function action(work: () => Promise<void>) {
    if (running.current) return
    running.current = true; setBusy(true); setNotice(null); setPrepared(null); setAck(false); setUnrecognized(null)
    const gen = generation.current
    try { await work() } catch (error) { if (generation.current === gen) say(financeErrorText(errorCode(error), 'The wallet read or simulation could not be completed. No transaction was sent.', 'Read my operations'), errorCode(error)) }
    finally { if (generation.current === gen) { running.current = false; setBusy(false) } }
  }
  async function connect() {
    const gen = generation.current
    // Asked again at the owner's press, so a release switched off since the page opened is never used to fund.
    const live = await readSetupRelease()
    if (generation.current !== gen) return
    setRelease(live)
    const stored = live.kind === 'available' ? null : savedSetupProfile()
    const deployment = live.kind === 'available' ? live.deployment : stored, isRecovery = live.kind !== 'available'
    if (!deployment) { say('The deployment could not be read. Nothing was prepared.', live.kind === 'unavailable' ? live.reason : null); return }
    const wallet = await setupWallet(), next = createSetupClient(wallet, deployment, () => Date.now() / 1000, currentSetupDeployment)
    const rows = await next.recent()
    if (generation.current !== gen || !wallet.current()) return
    if (!isRecovery) saveSetupProfile(deployment)
    setClient(next); setRecovery(isRecovery); setRecent(rows)
    say(isRecovery ? 'The saved deployment was verified on chain. Read or refund your existing operations below.' : 'Deployment verified through your wallet. Choose an existing operation or review new funding.')
  }
  const gas = () => ({ maxGas: raw(form.maxGas, 64), maxFeePerGas: raw(form.maxFee), maxPriorityFeePerGas: raw(form.priorityFee), reserveWei: raw(form.reserve, 256) })
  const id = () => form.operationId.toLowerCase() as Hex
  const integer = (value: string) => { if (!/^-?(0|[1-9][0-9]{0,6})$/.test(value)) throw new Error('invalid_integer'); return Number(value) }
  const swapSlippageBps = () => { const bps = slippageBpsFrom(swapSlippage); if (bps === null) throw new Error('invalid_slippage'); return bps }
  /** The funding, or, when its check stops at a delegate this app does not recognize, that delegate for the confirmation. */
  async function fund(current: Client) {
    const gen = generation.current
    try {
      return await current.fund({ currency0: form.currency0.toLowerCase() as Address, currency1: form.currency1.toLowerCase() as Address, hooks: zeroAddress, fee: integer(form.fee), tickSpacing: integer(form.tickSpacing) }, raw(form.amount0), raw(form.amount1), gas())
    } catch (error) {
      if (errorCode(error) === 'delegate_unrecognized') {
        const account = await current.account()
        if (generation.current === gen && account.kind === 'delegated' && account.known === null) setUnrecognized({ owner: current.owner, delegate: account.delegate })
      }
      throw error
    }
  }
  async function prepare(kind: 'fund' | 'swap' | 'mint' | 'cancel') {
    if (!client) return
    const gen = generation.current
    const result = kind === 'fund' ? await fund(client)
      : kind === 'swap' ? await client.swap(id(), direction, raw(form.grossSwap), swapSlippageBps(), raw(form.sqrtLimit, 160), gas())
      : kind === 'mint' ? await client.mint(id(), { tickLower: integer(form.tickLower), tickUpper: integer(form.tickUpper), liquidity: raw(form.liquidity, 127), maxAmount0: raw(form.maxAmount0), maxAmount1: raw(form.maxAmount1), minSqrtPriceX96: raw(form.minPrice, 160), maxSqrtPriceX96: raw(form.maxPrice, 160), initialSqrtPriceX96: raw(form.initialPrice, 160) }, gas())
      : await client.cancel(id(), gas())
    if (generation.current === gen) setPrepared(result)
  }
  async function prepareRecovery(currency: Address, amount: bigint) {
    if (!client) return
    const gen = generation.current
    const result = await client.recover(id(), currency.toLowerCase() as Address, amount, gas())
    if (generation.current === gen) setPrepared(result)
  }
  async function send() {
    if (!client || !prepared || !ack || running.current) return
    const step = prepared, gen = generation.current
    running.current = true; setBusy(true); setPrepared(null); setAck(false)
    try {
      const hash = await client.send(step, true)
      // RPC fix round 2: a setup step changes the wallet's list (a held deposit, a new position): its next reads ask fresh.
      walletChanged()
      if (generation.current === gen) { setForm(old => ({ ...old, transactionHash: hash, operationId: step.operationId ?? old.operationId })); say('Transaction offered once. Check its receipt and the operation before the next stage.') }
    } catch (error) { if (generation.current === gen) say(error instanceof Error && ['setup_admission_unavailable','setup_release_unavailable','invalid_setup_release','setup_release_expired','deployment_code_changed','deployment_identity_changed'].includes(error.message)
      ? 'The deployment changed or could not be confirmed. No wallet transaction was requested. Read your operations again, then prepare and review again. Existing operations can still be read and refunded.'
      : personRefused(error)
        ? 'Wallet request rejected. Prepare and review again if you want to continue.'
        : 'The wallet outcome may be unknown. Check wallet activity and reload the operation before proceeding. This nonce remains protected against another offer, including after reload.', errorCode(error)) }
    finally { if (generation.current === gen) { running.current = false; setBusy(false) } }
  }
  // The swap the quote is for: the operation read from chain when there is one, else the funding fields; typed amounts only.
  const swapKey = operation ? { currency0: operation.key.currency0.toLowerCase(), currency1: operation.key.currency1.toLowerCase() } : { currency0: form.currency0.trim().toLowerCase(), currency1: form.currency1.trim().toLowerCase() }
  const swapFields = client ? { tokenIn: direction ? swapKey.currency0 : swapKey.currency1, tokenOut: direction ? swapKey.currency1 : swapKey.currency0, grossRaw: form.grossSwap.trim(), feeBps: client.deployment.feeBps, slippageBps: swapSlippage, maxImpactBps: form.maxImpact } : null
  const inputs = (names: (keyof typeof defaults)[]) => <div className="dm-acct-fields">{names.map(name => <label className="dm-label dm-acct-lf" key={name}>{labels[name]}<input disabled={busy} className="dm-field dm-acct-mono-field" value={form[name]} onChange={event => edit(name, event.target.value)} /></label>)}</div>
  // No published release, no saved profile, and nothing read, running or said on this visit: a card would promise a recovery with
  // no way into it, so there is none, and nothing in its place. Where the release stands stays in the marker's data and title.
  if (!available && !saved && !client && !notice && !busy) {
    const reason = release.kind === 'unavailable' ? release.reason : undefined
    return <div hidden data-setup-release={release.kind} data-setup-release-reason={reason} data-recovery-profile="none" title={reason && `Setup deployment unavailable: ${reason.replaceAll('_', ' ')}.`} />
  }
  return <Card className="dm-acct-block dm-acct-panel" data-setup-release={release.kind} data-setup-release-reason={release.kind === 'unavailable' ? release.reason : undefined} data-recovery-profile={saved ? 'saved' : 'none'}>
    <h2 className="dm-acct-panel-title">{available ? 'Advanced setup and owner recovery' : 'Owner recovery'}</h2>
    <p className="dm-acct-panel-note">{available
      ? 'Fund a setup operation, optionally swap once, then mint. New pools require an explicit initial price and liquidity range. Each stage is reviewed separately in your wallet. Refunds need no Domino sign-in.'
      : 'Read and refund your setup operations directly through your wallet. Refunds carry no Domino fee and need no Domino sign-in.'}</p>
    {profile && <Button className="justify-self-start" disabled={busy} variant="outline" onClick={() => { void action(connect) }}>Read my operations</Button>}
    {notice && <p role="status" className="dm-acct-line dm-acct-wrap" data-notice-code={notice.code ?? undefined}>{notice.text}</p>}
    {unrecognized && <Button className="justify-self-start" variant="outline" size="sm" disabled={busy} data-confirm-delegate={unrecognized.delegate}
      onClick={() => { confirmDelegate(unrecognized.owner, unrecognized.delegate); setUnrecognized(null); say('Confirmed for this account on this page. Prepare the funding again.') }}>
      I set up this smart account ({unrecognized.delegate}): continue</Button>}
    {client && <>
      <p className="dm-acct-hash">Setup {client.deployment.setup} · assisted swap fee {client.deployment.feeBps} bps · tariff {client.deployment.tariffVersion}. Mint and refunds carry no Domino fee. Network gas applies; pool fees apply only to the optional swap.</p>
      <fieldset disabled={busy} className="dm-acct-fieldset"><legend className="dm-acct-subtitle">Network budget for each wallet step</legend>{inputs(['maxGas','maxFee','priorityFee','reserve'])}</fieldset>
      {available && !recovery && <details className="dm-details dm-acct-disclosure"><summary>Fund a new operation</summary><div className="dm-acct-disclosure-body">{inputs(['currency0','currency1','fee','tickSpacing','amount0','amount1'])}<Button className="justify-self-start" disabled={busy} onClick={() => { void action(() => prepare('fund')) }}>Prepare exact allowance or funding</Button></div></details>}
      <h3 className="dm-acct-subtitle">{available && !recovery ? 'Recover or continue an operation' : 'Your operations'}</h3>
      <div className="dm-acct-choices">{recent.map(row => <Button variant="outline" size="sm" key={row.id} disabled={busy} onClick={() => { edit('operationId', row.id); setOperation(row.operation) }}>{row.operation.closed ? 'Closed' : row.operation.recoveryStarted ? 'Recovering' : row.operation.swapped ? 'Swapped' : 'Funded'} · {row.id.slice(0, 12)}</Button>)}</div>
      {inputs(['operationId'])}<Button className="justify-self-start" disabled={busy} variant="outline" onClick={() => { void action(async () => { const gen = generation.current, op = await client.inspect(id()); if (generation.current === gen) setOperation(op) }) }}>Read operation from chain</Button>
      {operation && <p className="dm-acct-line dm-acct-wrap">Token 0 {operation.key.currency0}: {operation.balance0.toString()} · token 1 {operation.key.currency1}: {operation.balance1.toString()} · {operation.closed ? `closed, NFT ${operation.tokenId}` : operation.recoveryStarted ? 'recovery started; remaining funds can be refunded' : operation.swapped ? 'swap completed; ready to mint or refund' : 'funded'}</p>}
      {available && !recovery && !operation?.recoveryStarted && <>
        <AssistedSwap>{open => <><label className="dm-acct-check"><input type="checkbox" disabled={busy} checked={direction} onChange={e => { generation.current++; setDirection(e.target.checked); setPrepared(null); setAck(false) }} /> Token 0 to token 1 (uncheck for token 1 to token 0)</label>{inputs(['grossSwap'])}<SlippageChoice id="setup-swap-slippage" label="Maximum swap slippage" bps={swapSlippage} disabled={busy} onChange={text => setOwnSwapSlippage(text)} />{inputs(['maxImpact','sqrtLimit'])}{swapFields && <SwapQuote fields={swapFields} open={open} port={livePort} fetch={financialFetch} clock={realClock} />}<Button className="justify-self-start" disabled={busy} onClick={() => { void action(() => prepare('swap')) }}>Simulate and review swap</Button></>}</AssistedSwap>
        <details className="dm-details dm-acct-disclosure"><summary>Mint or create a new pool</summary><div className="dm-acct-disclosure-body">{inputs(['tickLower','tickUpper','liquidity','maxAmount0','maxAmount1','minPrice','maxPrice','initialPrice'])}<Button className="justify-self-start" disabled={busy} onClick={() => { void action(() => prepare('mint')) }}>Simulate and review mint</Button></div></details>
      </>}
      <Button className="justify-self-start" variant="outline" disabled={busy} onClick={() => { void action(() => prepare('cancel')) }}>Review refund of remaining funds</Button>
      {operation && !operation.closed && <section className="dm-inset" aria-label="Refund tokens separately"><h3 className="dm-acct-subtitle">Refund one token at a time</h3><p className="dm-acct-line">If one token cannot be transferred, refund the other independently. Starting recovery ends swap and mint for this operation.</p><div className="dm-acct-choices">{([[operation.key.currency0, operation.balance0, 'token 0'], [operation.key.currency1, operation.balance1, 'token 1']] as const).map(([currency, amount, label]) => <Button key={currency} variant="outline" disabled={busy || amount === 0n} onClick={() => { void action(() => prepareRecovery(currency, amount)) }}>Review {label} refund</Button>)}</div></section>}
      {prepared && <section className="dm-inset dm-acct-review" aria-label="Wallet transaction review"><h3 className="dm-acct-subtitle">Review {SETUP_STEP_TEXT[prepared.kind]}</h3>{prepared.summary.map(line => <p className="dm-acct-line dm-acct-wrap" key={line}>{line}</p>)}<label className="dm-acct-check"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} /> I reviewed the tokens, destination, amounts, fee and limits.</label><Button className="justify-self-start" variant="accent" disabled={!ack || busy} onClick={() => { void send() }}>Send this step in wallet</Button></section>}
      {inputs(['transactionHash'])}<Button className="justify-self-start" variant="outline" disabled={busy} onClick={() => { void action(async () => { const gen = generation.current, receipt = await client.receipt(form.transactionHash.toLowerCase() as Hex, form.operationId ? id() : undefined); if (receipt.state === 'included' || receipt.state === 'finalized') walletChanged(receipt.blockNumber); if (generation.current === gen) say(`Receipt: ${RECEIPT_TEXT[receipt.state]}. ${receipt.state === 'finalized' ? 'Read the operation before continuing.' : 'Wait for canonical finality before considering the step complete.'}`) }) }}>Check canonical receipt</Button>
    </>}
  </Card>
}
