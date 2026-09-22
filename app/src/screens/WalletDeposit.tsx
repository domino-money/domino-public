import { useEffect, useRef, useState } from 'react'
import { getConnection, watchConnection } from 'wagmi/actions'
import { zeroAddress, type Address, type Hex } from 'viem'
import { walletConfig } from '../wallet/config'
import { setupWallet } from '../finance/wallet'
import { suggestGasBudget } from '../finance/gas'
import { readRelease, type ReleaseRead } from '../finance/release'
import { createSetupClient, deploymentFrom, type GasBudget, type PoolKey, type PreparedSetup, type SetupDeployment, type SetupOperation } from '../finance/setup'
import { RECEIPT_TEXT, SETUP_STEP_TEXT, errorCode, financeErrorText } from '../finance/words'
import type { SetupDraft } from '../lib/create/journey'
import { rawAmount, tickPrice, tickRange } from '../lib/create/depositForm'
import { mintPlanFor } from '../lib/create/mintPlan'
import { pairedAmount } from '../lib/create/pairAmount'
import { SLIPPAGE_DEFAULT_BPS, slippageBpsFrom, slippageWritten } from '../lib/create/slippage'
import { formatUnits } from '../lib/read/decimal'
import { presetRange } from '../lib/read/screens/poolRange'
import type { PoolOption } from '../lib/read/screens/poolsList'
import { useReadSource } from '../lib/read/screens/readContext'
import { readWithin } from '../lib/read/screens/screenRead'
import { shortAddress } from '../lib/read/screens/identity'
import type { ReadSource, TokenDisplay } from '../lib/read/types'
import { SlippageChoice } from '../components/create/SlippageChoice'
import { SymbolText } from '../components/read/screens/SymbolText'
import { Button, Card, LinkButton } from '../components/ui'

/**
 * The deposit a connected wallet makes on its own: fund a setup operation
 * with the two amounts the range takes at the pool's price, then mint the
 * position, each step reviewed here and signed in the wallet. It needs the
 * published release profile (the same public GET the advanced card makes)
 * and a wallet on Robinhood Chain, and nothing else: no private session, no
 * deposit service. Refunds need neither.
 *
 * The choices arrive from New position (lib/create/setupDraft.ts) or are
 * made here against the pool chosen above: the deposit token and its amount
 * in the token's own units, the range as ticks, the slippage limit. The other
 * token's amount is what the range and the price make of it
 * (create/pairAmount.ts); the mint's liquidity and price band come from the
 * funded balances and the latest price (create/mintPlan.ts). Gas is the
 * network's own price now (finance/gas.ts); every step still shows its exact
 * maximum cost before the wallet opens.
 *
 * The same client as the advanced card (finance/setup.ts): the deployment is
 * verified through the wallet before anything is prepared, a prepared step is
 * offered to the wallet once, and a receipt is read back by hash. An open
 * operation of this wallet's, whatever screen funded it, is found again from
 * chain; the one in the pool chosen above continues from its mint, and any
 * other is named so it can be minted from its own pool or refunded.
 */

type Client = ReturnType<typeof createSetupClient>
type Release = { kind: 'loading' } | ReleaseRead<SetupDeployment>
type Notice = { text: string; code: string | null }
type Open = { id: Hex; operation: SetupOperation }
type ReceiptState = keyof typeof RECEIPT_TEXT
type Sent = { hash: Hex; kind: PreparedSetup['kind']; operationId: Hex | null; state: ReceiptState | 'checking' }
type Form = { independent: 0 | 1; amount: string; lower: string; upper: string; slippageBps: string }

const readSetupRelease = () => readRelease('/api/setup/v1/release', (value) => deploymentFrom(value))
const currentSetupDeployment = async () => {
  const release = await readSetupRelease()
  return release.kind === 'available' ? release.deployment : null
}
const decimalsOf = (token: TokenDisplay) => (token.origin === 'read' ? token.decimals : null)
const NATIVE_DECIMALS = 18
/** How long a sent step is watched for its receipt before the owner is asked to check it themselves. */
const RECEIPT_WAIT_MS = 240_000
const RECEIPT_EVERY_MS = 3_000
/** Receipt states after which the step is over, one way or the other. */
const SETTLED: readonly (ReceiptState | 'checking')[] = ['included', 'finalized', 'reverted', 'reorged', 'over_budget', 'over_budget_finalized']
const DEPLOYMENT_GONE = ['setup_admission_unavailable', 'setup_release_unavailable', 'invalid_setup_release', 'setup_release_expired', 'deployment_code_changed', 'deployment_identity_changed']

/** A raw amount as text the amount box can hold: exact units, no grouping. */
function unitsInput(raw: string, decimals: number | null): string {
  if (decimals === null || !/^\d+$/.test(raw)) return raw
  const padded = raw.padStart(decimals + 1, '0')
  const whole = padded.slice(0, padded.length - decimals)
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}

/** The most a prepared step can cost in gas: its limit at its ceiling, in wei. */
const costOf = (prepared: PreparedSetup): bigint => BigInt(prepared.transaction.gas) * BigInt(prepared.transaction.maxFeePerGas)

/** "12.5 WETH", or the raw integer marked as such when the token's decimals were not read. */
function Amount({ raw, token }: { raw: bigint | string; token: TokenDisplay }) {
  const units = formatUnits(String(raw), decimalsOf(token))
  if (!units) return <>{String(raw)}</>
  return (
    <>
      {units.text}
      {units.kind === 'raw' ? ' raw units of ' : ' '}
      <SymbolText token={token} />
    </>
  )
}

const poolKeyOf = (pool: PoolOption): PoolKey => ({
  currency0: pool.currencies[0].address as Address,
  currency1: pool.currencies[1].address as Address,
  fee: pool.feePips,
  tickSpacing: pool.tickSpacing,
  hooks: zeroAddress,
})
const sameKey = (key: PoolKey, pool: PoolOption) =>
  key.currency0.toLowerCase() === pool.currencies[0].address && key.currency1.toLowerCase() === pool.currencies[1].address && key.fee === pool.feePips && key.tickSpacing === pool.tickSpacing

function formFor(pool: PoolOption | null, draft: SetupDraft | null): Form {
  if (draft && pool && draft.pool.key === pool.key) {
    return { independent: draft.independent, amount: unitsInput(draft.amountRaw, decimalsOf(pool.currencies[draft.independent])), lower: String(draft.tickLower), upper: String(draft.tickUpper), slippageBps: String(draft.slippageBps) }
  }
  const range = pool ? presetRange(pool.tick, pool.tickSpacing, 'wide') : null
  return { independent: 0, amount: '', lower: range ? String(range.lower) : '', upper: range ? String(range.upper) : '', slippageBps: String(SLIPPAGE_DEFAULT_BPS) }
}
/** What the form was filled in from: the pool, and the draft's own figures when it is that pool's. */
const formSource = (pool: PoolOption | null, draft: SetupDraft | null) =>
  `${pool?.key ?? ''}|${draft && pool && draft.pool.key === pool.key ? [draft.independent, draft.amountRaw, draft.tickLower, draft.tickUpper, draft.slippageBps].join(',') : ''}`

/** The two amounts these choices fund, or why there are none: the typed one, and the one the range and the price make of it. */
function fundingFor(pool: PoolOption, form: Form): { ok: true; amount0: bigint; amount1: bigint; slippageBps: number } | { ok: false; reason: string } {
  if (pool.integration !== 'hookless_fixed_fee') return { ok: false, reason: 'Deposits here take pools with no hooks and a fixed fee. This pool needs a separate integration.' }
  const range = tickRange(form.lower, form.upper, pool.tickSpacing)
  if (!range.ok) return { ok: false, reason: range.reason }
  const budget = rawAmount(form.amount.trim(), decimalsOf(pool.currencies[form.independent]))
  if (!budget.ok) return { ok: false, reason: budget.reason }
  const slippageBps = slippageBpsFrom(form.slippageBps)
  if (slippageBps === null) return { ok: false, reason: 'Choose a slippage limit.' }
  const other = pairedAmount({ sqrtPriceX96: pool.sqrtPriceX96, tickLower: range.lower, tickUpper: range.upper, independent: form.independent, amountRaw: budget.raw })
  if (other.kind === 'unused') {
    const only = pool.currencies[other.only]
    return { ok: false, reason: `At the pool’s price this range holds only ${only.symbol ?? (other.only === 0 ? 'token 0' : 'token 1')}. Enter the amount in that token.` }
  }
  if (other.kind === 'unknown') return { ok: false, reason: 'The pool’s price or the range could not be used. Read the pool again and check the range.' }
  const mine = BigInt(budget.raw), theirs = BigInt(other.raw)
  return form.independent === 0 ? { ok: true, amount0: mine, amount1: theirs, slippageBps } : { ok: true, amount0: theirs, amount1: mine, slippageBps }
}

/** The pool's price now, from the paced read source when there is one; else as the pool was read for the list above. */
async function priceNow(source: ReadSource | null, pool: PoolOption): Promise<string> {
  if (!source) return pool.sqrtPriceX96
  const controller = new AbortController()
  const outcome = await readWithin(source, 'pool-market', { poolId: pool.key }, { signal: controller.signal, budgetMs: 20_000 })
  return outcome.state === 'ok' ? outcome.data.pool.sqrtPriceX96 : pool.sqrtPriceX96
}

export default function WalletDeposit({ pool, draft }: { pool: PoolOption | null; draft: SetupDraft | null }) {
  const source = useReadSource()
  const [release, setRelease] = useState<Release>({ kind: 'loading' })
  const [client, setClient] = useState<Client | null>(null)
  const [gas, setGas] = useState<GasBudget | null>(null)
  const [open, setOpen] = useState<Open[]>([])
  const [form, setForm] = useState<Form>(() => formFor(pool, draft))
  const [filledFrom, setFilledFrom] = useState(() => formSource(pool, draft))
  const [prepared, setPrepared] = useState<PreparedSetup | null>(null)
  const [ack, setAck] = useState(false)
  const [sent, setSent] = useState<Sent | null>(null)
  const [minted, setMinted] = useState<bigint | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const generation = useRef(0)
  const running = useRef(false)
  const say = (text: string, code: string | null = null) => setNotice({ text, code })

  // New choices from New position, or another pool chosen above: the form follows them, and a step reviewed for the old ones goes.
  const sourceNow = formSource(pool, draft)
  if (filledFrom !== sourceNow) {
    setFilledFrom(sourceNow)
    setForm(formFor(pool, draft))
    setPrepared(null)
    setAck(false)
  }

  async function action(work: () => Promise<void>) {
    if (running.current) return
    running.current = true
    setBusy(true)
    setNotice(null)
    const gen = generation.current
    try {
      await work()
    } catch (error) {
      if (generation.current === gen) say(financeErrorText(errorCode(error), 'The wallet read or simulation could not be completed. No transaction was sent.', 'Read my operations'), errorCode(error))
    } finally {
      if (generation.current === gen) {
        running.current = false
        setBusy(false)
      }
    }
  }

  /** Verifies the deployment through the wallet and finds this wallet's open operations. Reads only; nothing is offered to sign. */
  async function connect() {
    const gen = generation.current
    const live = await readSetupRelease()
    if (generation.current !== gen) return
    setRelease(live)
    if (live.kind !== 'available') return
    const wallet = await setupWallet()
    const next = createSetupClient(wallet, live.deployment, () => Date.now() / 1000, currentSetupDeployment)
    const rows = await next.recent()
    const budget = await suggestGasBudget(wallet)
    if (generation.current !== gen || !wallet.current()) return
    setClient(next)
    setGas(budget)
    setOpen(rows.filter((row) => !row.operation.closed && !row.operation.recoveryStarted))
  }
  const verify = () => {
    if (getConnection(walletConfig).status === 'connected') void action(connect)
  }

  // The release once, on mount; with one, the deployment is verified without a press.
  useEffect(() => {
    let live = true
    void readSetupRelease().then((result) => {
      if (!live) return
      setRelease(result)
      if (result.kind === 'available') verify()
    })
    return () => {
      live = false
    }
  }, [])
  // Another wallet, account or network: nothing prepared or read for the previous one applies, and the new one is verified.
  useEffect(
    () =>
      watchConnection(walletConfig, {
        onChange: () => {
          generation.current++
          running.current = false
          setClient(null)
          setGas(null)
          setOpen([])
          setPrepared(null)
          setAck(false)
          setSent(null)
          setMinted(null)
          setBusy(false)
          setNotice(null)
          verify()
        },
      }),
    [],
  )
  useEffect(() => () => void generation.current++, [])

  const available = release.kind === 'available'
  const key = pool ? poolKeyOf(pool) : null
  // The open operation in the pool chosen above continues from its mint; the others are named below.
  const chosen = pool ? (open.find((row) => sameKey(row.operation.key, pool)) ?? null) : null
  const others = open.filter((row) => row !== chosen)

  const edit = (name: keyof Form, value: string | 0 | 1) => {
    generation.current++
    setForm((old) => ({ ...old, [name]: value }))
    setPrepared(null)
    setAck(false)
  }
  const remember = (row: Open) => setOpen((old) => (old.some((item) => item.id === row.id) ? old.map((item) => (item.id === row.id ? row : item)) : [...old, row]))
  const forget = (id: Hex) => setOpen((old) => old.filter((row) => row.id !== id))

  async function reviewFunding() {
    if (!client || !gas || !key || !pool) return
    const gen = generation.current
    const funding = fundingFor(pool, form)
    if (!funding.ok) {
      say(funding.reason)
      return
    }
    const step = await client.fund(key, funding.amount0, funding.amount1, gas)
    if (generation.current === gen) setPrepared(step)
  }

  async function reviewMint(row: Open) {
    if (!client || !gas || !pool || !sameKey(row.operation.key, pool)) return
    const gen = generation.current
    const range = tickRange(form.lower, form.upper, pool.tickSpacing)
    if (!range.ok) {
      say(range.reason)
      return
    }
    const { lower, upper } = range
    const slippageBps = slippageBpsFrom(form.slippageBps)
    if (slippageBps === null) {
      say('Choose a slippage limit.')
      return
    }
    const sqrtPriceX96 = await priceNow(source, pool)
    const operation = await client.inspect(row.id)
    if (generation.current !== gen) return
    remember({ id: row.id, operation })
    const plan = mintPlanFor({ sqrtPriceX96, tickLower: lower, tickUpper: upper, balance0: operation.balance0, balance1: operation.balance1, slippageBps })
    if (!plan) {
      say('These balances make no position in this range at the pool’s price. Widen the range, or refund the operation.')
      return
    }
    const step = await client.mint(row.id, { tickLower: lower, tickUpper: upper, ...plan }, gas)
    if (generation.current === gen) setPrepared(step)
  }

  async function reviewRefund(row: Open) {
    if (!client || !gas) return
    const gen = generation.current
    const step = await client.cancel(row.id, gas)
    if (generation.current === gen) setPrepared(step)
  }

  /** After a step's receipt: what is read again, and which step is prepared next. Nothing is sent without its own review. */
  async function follow(done: Sent) {
    if (!client) return
    if (done.state === 'reverted' || done.state === 'reorged') {
      say(
        done.state === 'reverted'
          ? 'The transaction reverted: nothing was deposited, only network gas was spent. Read the operation and review the step again.'
          : 'The block that held the transaction left the canonical chain. Check your wallet activity before reviewing the step again.',
      )
      return
    }
    if (done.kind === 'approve') {
      await reviewFunding()
      return
    }
    if (!done.operationId) return
    const operation = await client.inspect(done.operationId)
    const row = { id: done.operationId, operation }
    if (done.kind === 'mint' && operation.closed) {
      setMinted(operation.tokenId)
      forget(row.id)
      return
    }
    if (done.kind === 'cancel') {
      forget(row.id)
      say('The remaining funds were returned to your wallet.')
      return
    }
    remember(row)
    if (done.kind === 'fund') await reviewMint(row)
  }

  async function send() {
    if (!client || !prepared || !ack || running.current) return
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
      let state: Sent = { hash, kind: step.kind, operationId: step.operationId, state: 'checking' }
      setSent(state)
      const until = Date.now() + RECEIPT_WAIT_MS
      while (Date.now() < until && !SETTLED.includes(state.state)) {
        await new Promise((resolve) => setTimeout(resolve, RECEIPT_EVERY_MS))
        if (generation.current !== gen) return
        const receipt = await client.receipt(hash, step.operationId ?? undefined)
        state = { ...state, state: receipt.state }
        setSent(state)
      }
      if (generation.current !== gen) return
      if (!SETTLED.includes(state.state)) {
        say('The transaction is still waiting to be included. Check your wallet activity, then read the operation again.')
        return
      }
      await follow(state)
    } catch (error) {
      if (generation.current !== gen) return
      say(
        error instanceof Error && DEPLOYMENT_GONE.includes(error.message)
          ? 'The deployment changed or could not be confirmed. No wallet transaction was requested. Read your operations again, then review the step again.'
          : error && typeof error === 'object' && (error as { code?: unknown }).code === 4001
            ? 'Wallet request rejected. Review the step again if you want to continue.'
            : 'The wallet outcome may be unknown. Check wallet activity and read the operation before continuing. This nonce stays protected against another offer, including after reload.',
        errorCode(error),
      )
    } finally {
      if (generation.current === gen) {
        running.current = false
        setBusy(false)
      }
    }
  }

  const phase = !available ? (release.kind === 'loading' ? 'checking' : 'unavailable') : client ? (minted !== null ? 'done' : chosen ? 'mint' : 'funding') : 'checking'
  const prefilled = draft && pool && draft.pool.key === pool.key ? 'new-position' : 'typed'
  const bound = (text: string) => {
    const tick = Number(text)
    const d0 = pool ? decimalsOf(pool.currencies[0]) : null, d1 = pool ? decimalsOf(pool.currencies[1]) : null
    if (d0 === null || d1 === null || !Number.isInteger(tick)) return null
    return tickPrice(tick, d0, d1)
  }
  const funding = pool && client && !chosen ? fundingFor(pool, form) : null
  const slippage = slippageBpsFrom(form.slippageBps) ?? SLIPPAGE_DEFAULT_BPS

  return (
    <Card className="dm-acct-block dm-acct-panel" data-wallet-deposit={phase} data-wallet-deposit-prefill={prefilled} data-wallet-deposit-reason={release.kind === 'unavailable' ? release.reason : undefined}>
      <h2 className="dm-acct-panel-title">Deposit through your wallet</h2>
      <p className="dm-acct-panel-note">
        Your wallet funds a setup operation with both tokens, then mints the position. Each step is reviewed here and signed in your wallet; nothing is sent before that. No Domino percentage fee on a direct deposit; network gas applies.
      </p>
      {notice && (
        <p role="status" className="dm-acct-line dm-acct-wrap" data-notice-code={notice.code ?? undefined}>
          {notice.text}
        </p>
      )}
      {phase === 'checking' && !notice && <p className="dm-acct-panel-note">Checking the deployment through your wallet…</p>}
      {available && !client && notice && (
        <Button variant="outline" className="justify-self-start" disabled={busy} onClick={verify}>
          Check the deployment again
        </Button>
      )}
      {phase === 'unavailable' && !notice && <p className="dm-acct-panel-note">The deployment is not published, so nothing can be funded from here. Existing operations can be refunded from the advanced card below.</p>}
      {client && minted !== null && (
        <section className="dm-inset dm-acct-stack" aria-label="Position minted" data-wallet-deposit-minted={String(minted)}>
          <h3 className="dm-acct-subtitle">Position NFT {String(minted)} is in your wallet</h3>
          <p className="dm-acct-line">Unused funds returned with it. Its range, amounts and earned fees are on Positions.</p>
          <div className="dm-acct-choices">
            <LinkButton href={`#/positions/${String(minted)}`}>See the position</LinkButton>
            <LinkButton href={`#/sequence/${String(minted)}`} variant="outline">
              Put its fees to work
            </LinkButton>
          </div>
        </section>
      )}
      {client && others.length > 0 && (
        <section className="dm-acct-stack" aria-label="Funded operations in other pools">
          <h3 className="dm-acct-subtitle">Funded operations of this wallet in other pools</h3>
          {others.map((row) => (
            <p key={row.id} className="dm-acct-line dm-acct-wrap" data-open-operation={row.id}>
              {shortAddress(row.operation.key.currency0)} / {shortAddress(row.operation.key.currency1)} · fee {row.operation.key.fee} pips · {row.operation.balance0.toString()} / {row.operation.balance1.toString()} raw units held. Choose that pool above to mint it, or refund it from the advanced card below.
            </p>
          ))}
        </section>
      )}
      {client && !pool && minted === null && <p className="dm-acct-panel-note">Choose a pool above to deposit into it.</p>}
      {client && pool && chosen && (
        <section className="dm-acct-stack" aria-label="Funded operation" data-wallet-deposit-operation={chosen.id}>
          <h3 className="dm-acct-subtitle">
            Funded: <Amount raw={chosen.operation.balance0} token={pool.currencies[0]} /> and <Amount raw={chosen.operation.balance1} token={pool.currencies[1]} />
          </h3>
          <p className="dm-acct-line">Held by your setup operation until the mint or a refund. The mint takes the range below at the pool’s price now; what it does not use returns with the NFT.</p>
        </section>
      )}
      {client && pool && minted === null && (
        <fieldset disabled={busy} className="dm-acct-fieldset">
          <legend className="dm-acct-subtitle">
            <SymbolText token={pool.currencies[0]} /> / <SymbolText token={pool.currencies[1]} /> · {pool.fee}
          </legend>
          <div className="dm-acct-fields">
            {!chosen && (
              <>
                <label className="dm-label dm-acct-lf">
                  Deposit token
                  <select className="dm-field" value={form.independent} onChange={(event) => edit('independent', event.target.value === '1' ? 1 : 0)}>
                    <option value={0}>{pool.currencies[0].symbol ?? 'Token 0'}</option>
                    <option value={1}>{pool.currencies[1].symbol ?? 'Token 1'}</option>
                  </select>
                </label>
                <label className="dm-label dm-acct-lf">
                  Amount
                  <input className="dm-field" inputMode="decimal" value={form.amount} onChange={(event) => edit('amount', event.target.value)} />
                </label>
              </>
            )}
            <label className="dm-label dm-acct-lf">
              Lower tick{bound(form.lower) ? ` (${bound(form.lower)})` : ''}
              <input className="dm-field dm-acct-mono-field" inputMode="numeric" value={form.lower} onChange={(event) => edit('lower', event.target.value)} />
            </label>
            <label className="dm-label dm-acct-lf">
              Upper tick{bound(form.upper) ? ` (${bound(form.upper)})` : ''}
              <input className="dm-field dm-acct-mono-field" inputMode="numeric" value={form.upper} onChange={(event) => edit('upper', event.target.value)} />
            </label>
          </div>
          <SlippageChoice id="wallet-deposit-slippage" label="Slippage limit" bps={form.slippageBps} disabled={busy} onChange={(text) => edit('slippageBps', text)} />
          {funding?.ok && (
            <p className="dm-acct-line" data-wallet-deposit-paired={form.independent === 0 ? String(funding.amount1) : String(funding.amount0)}>
              With it, ≈ <Amount raw={form.independent === 0 ? funding.amount1 : funding.amount0} token={pool.currencies[form.independent === 0 ? 1 : 0]} /> at the pool’s price as read. The exact amounts are fixed when you fund.
            </p>
          )}
          <div className="dm-acct-choices">
            {!chosen && (
              <Button disabled={busy} onClick={() => void action(reviewFunding)}>
                Review funding
              </Button>
            )}
            {chosen && (
              <>
                <Button disabled={busy} onClick={() => void action(() => reviewMint(chosen))}>
                  Review mint
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => void action(() => reviewRefund(chosen))}>
                  Review refund
                </Button>
              </>
            )}
          </div>
        </fieldset>
      )}
      {prepared && (
        <section className="dm-inset dm-acct-review" aria-label="Wallet transaction review" data-wallet-deposit-review={prepared.kind}>
          <h3 className="dm-acct-subtitle">Review {SETUP_STEP_TEXT[prepared.kind]}</h3>
          {prepared.summary.map((line) => (
            <p className="dm-acct-line dm-acct-wrap" key={line}>
              {line}
            </p>
          ))}
          <p className="dm-acct-line">
            Maximum network cost: {formatUnits(String(costOf(prepared)), NATIVE_DECIMALS)?.text ?? String(costOf(prepared))} ETH. Your slippage limit is {slippageWritten(slippage)}.
          </p>
          <label className="dm-acct-check">
            <input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} /> I reviewed the tokens, destination, amounts and limits.
          </label>
          <div className="dm-acct-choices">
            <Button variant="accent" disabled={!ack || busy} onClick={() => void send()}>
              Send this step in wallet
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                generation.current++
                setPrepared(null)
                setAck(false)
              }}
            >
              Back
            </Button>
          </div>
        </section>
      )}
      {sent && (
        <p className="dm-acct-hash" data-wallet-deposit-sent={sent.kind} data-wallet-deposit-receipt={sent.state}>
          {SETUP_STEP_TEXT[sent.kind]} · {sent.hash} · {sent.state === 'checking' ? 'Waiting for the receipt' : RECEIPT_TEXT[sent.state]}
        </p>
      )}
    </Card>
  )
}
