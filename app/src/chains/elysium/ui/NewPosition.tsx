/**
 * New position on the second chain (2026-10-01, the chain2 workstream, audit items G2 and G7): choose a pool, a price
 * range and an amount, then let rugged97's actions service prepare each transaction and your wallet sign it, one at a
 * time (chains/elysium/flow.ts). Beginner-first: a range is two prices, an amount is one field (the other token follows
 * from the range and the price, lib/create/pairAmount.ts), and the slippage and the transaction's raw data are in the
 * closed Details.
 *
 * Capability-driven: while the chain's deployment is unqualified, or his service is not reachable here, or no wallet
 * signer is wired into this build, the plan is shown and the Review button says why it cannot go on; nothing is asked
 * of the service or the wallet. In his model a vault belongs to one owner and one pool, and positions open inside it:
 * a wallet with no vault for the pool is told so.
 */
import { useEffect, useMemo, useState } from 'react'
import { Button, LinkButton, PageHeader, Pill, Segmented, Skeleton, StepMarker } from '../../../components/ui'
import { pairedAmount } from '../../../lib/create/pairAmount'
import { pauseFor } from '../../../lib/chain/client'
import { browserStore } from '../../../lib/chainStorage'
import { RANGES, type RangeKey } from '../../../lib/ranges'
import { presetFor } from '../../../lib/read/screens/poolRange'
import { priceInvertedOn } from '../../../config/chainKit'
import type { PoolSummary } from '../../types'
import { poolRef } from '../../types'
import { createOpenFlow, type FlowState, type OpenFlow } from '../flow'
import { keepOutcome, keepSent } from '../receipts'
import { actionsReasonText, amountText, feeTierText, maxNetworkFee, parseAmount, priceLine, rangeLine, stepText, stopText, tokenLabel } from '../present'
import { useNow, useSection } from './context'
import { Amount, ExplorerLink, Missing, PairMarks, PairName } from './parts'
import { sectionHref } from './routes'
import { useRead } from './useRead'

/** The clock the flow keeps its drafts' expiry with: milliseconds now. */
const nowMs = (): number => Date.now()

/** Both deposit amounts, in the pool's order: the typed one and the one the range and price pair with it. */
function depositAmounts(raw: bigint | null, paired: ReturnType<typeof pairedAmount> | null, index: 0 | 1): readonly [bigint, bigint] | null {
  if (raw === null || !paired || paired.kind !== 'amount') return null
  const other = BigInt(paired.raw)
  return index === 0 ? [raw, other] : [other, raw]
}

const SLIPPAGE_CHOICES = ['10', '50', '100'] as const
type Slippage = (typeof SLIPPAGE_CHOICES)[number]

function PoolChoice({ onPick }: { onPick: (pool: string) => void }) {
  const { chain, adapter } = useSection()
  const pools = useRead('pools', (signal) => adapter.listPools(signal), 60_000)
  if (!pools.value) return <Skeleton className="block h-10 w-full" />
  if (pools.value.length === 0) return <p className="text-body text-fg-muted">No pool on {chain.name} yet.</p>
  return (
    <ul className="grid gap-2">
      {pools.value.map((pool) => {
        const price = priceLine(chain, pool)
        return (
          <li key={pool.ref.id}>
            <Button variant="secondary" className="w-full gap-3" onClick={() => onPick(pool.ref.id)}>
              <PairMarks token0={price.base} token1={price.quote} size={24} />
              <PairName base={price.base} quote={price.quote} />
              <span className="dm-chip">{feeTierText(pool.fee)}</span>
            </Button>
          </li>
        )
      })}
    </ul>
  )
}

/** The flow's current step, in words, with the one control it needs. */
function FlowPanel({ flow, state, pool }: { flow: OpenFlow; state: FlowState; pool: PoolSummary }) {
  const { chain } = useSection()
  const now = useNow(1_000)
  if (state.step === 'idle') return null
  if (state.step === 'preparing' || state.step === 'checking') {
    return <p role="status" className="text-body text-fg-muted">{state.step === 'preparing' ? `Preparing step ${state.transaction}…` : 'Checking your vault has not changed…'}</p>
  }
  if (state.step === 'review' || state.step === 'wallet') {
    const { draft } = state
    const left = Math.max(0, draft.expiresAt - Math.floor(now / 1000))
    const fee = maxNetworkFee(chain, draft.transaction)
    return (
      <div className="grid gap-3" data-chain2-review={draft.step}>
        <div className="flex items-center gap-3">
          <StepMarker index={state.transaction} state="current" label={`Step ${state.transaction}`} />
          <h3 className="dm-subtitle">{stepText(draft.step, pool.token0, pool.token1)}</h3>
        </div>
        <p className="text-body text-fg-muted">
          {draft.readyForAction
            ? 'Your wallet will ask you to create the position in your vault, with the amounts and range above.'
            : 'Your wallet will ask you to allow your vault to use exactly the amount above. This is its own transaction; the position is created in the next one.'}
        </p>
        <p className="text-caption text-fg-subtle">Network fee: at most {fee ?? '—'}. This step is valid for {left} s more.</p>
        {state.step === 'review' && state.refused && <p role="status" className="text-caption text-fg-muted">You declined in your wallet. Nothing was sent.</p>}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void flow.confirm()} disabled={state.step === 'wallet' || left <= 10}>
            {state.step === 'wallet' ? 'Check your wallet…' : 'Confirm in wallet'}
          </Button>
          <Button variant="ghost" onClick={() => flow.cancel()}>Cancel</Button>
        </div>
        <details className="dm-details">
          <summary>Transaction details</summary>
          <dl className="dm-kv">
            <div><dt>Sends to</dt><dd><ExplorerLink chain={chain} address={draft.transaction.to} /></dd></div>
            <div><dt>From</dt><dd><ExplorerLink chain={chain} address={draft.transaction.from} /></dd></div>
            <div><dt>Nonce</dt><dd className="dm-kv-mono">{draft.transaction.nonce}</dd></div>
            <div><dt>Gas limit</dt><dd className="dm-kv-mono">{draft.transaction.gasLimitRaw}</dd></div>
            <div><dt>Data</dt><dd className="dm-kv-mono break-all">{draft.transaction.data.length > 74 ? `${draft.transaction.data.slice(0, 74)}…` : draft.transaction.data}</dd></div>
            <div><dt>Prepared draft</dt><dd className="dm-kv-mono break-all">{draft.id}</dd></div>
          </dl>
        </details>
      </div>
    )
  }
  if (state.step === 'confirming') {
    return (
      <div role="status" className="grid gap-2" data-chain2-confirming="">
        <p className="text-body text-fg">Sent. Waiting for {chain.name} to confirm it…</p>
        {state.slow && <p className="text-caption text-fg-muted">This is taking longer than usual. The page keeps checking; you can leave it and find it in Receipts.</p>}
        <p className="text-caption text-fg-subtle"><ExplorerLink chain={chain} hash={state.hash}>See it on the explorer</ExplorerLink></p>
      </div>
    )
  }
  if (state.step === 'done') {
    return (
      <div role="status" className="grid gap-3" data-chain2-done="">
        <Pill tone="in" dot>Your position is open</Pill>
        <LinkButton href={sectionHref(chain, 'positions')}>Your positions</LinkButton>
      </div>
    )
  }
  return (
    <div role="alert" className="grid gap-3" data-chain2-stopped={state.reason}>
      <p className="text-body text-fg">{stopText(state.reason)}</p>
      {state.hash && <p className="text-caption text-fg-subtle"><ExplorerLink chain={chain} hash={state.hash}>See it on the explorer</ExplorerLink></p>}
      <Button variant="secondary" onClick={() => flow.cancel()}>Start again</Button>
    </div>
  )
}

function Plan({ pool }: { pool: PoolSummary }) {
  const { chain, adapter, caps, wallet, connect, api, signerFor } = useSection()
  const [rangeKey, setRangeKey] = useState<RangeKey>('standard')
  const inverted = priceInvertedOn(chain, pool.token0.address, pool.token1.address)
  const ticks = presetFor({ tick: pool.tick, tickSpacing: pool.tickSpacing, inverted }, rangeKey)
  const range = rangeLine(chain, { token0: pool.token0, token1: pool.token1, tickLower: ticks.lower, tickUpper: ticks.upper, tickSpacing: pool.tickSpacing })
  const price = priceLine(chain, pool)
  // The amount is typed in one token, chosen by the person; the other follows.
  const [side, setSide] = useState<'0' | '1'>(inverted ? '1' : '0')
  const [typed, setTyped] = useState('')
  const [slippage, setSlippage] = useState<Slippage>('50')
  const index = side === '0' ? 0 : 1
  const typedToken = index === 0 ? pool.token0 : pool.token1
  const otherToken = index === 0 ? pool.token1 : pool.token0
  const raw = parseAmount(typed, typedToken.decimals)
  const paired = raw === null ? null : pairedAmount({ sqrtPriceX96: pool.sqrtPriceX96.toString(), tickLower: ticks.lower, tickUpper: ticks.upper, independent: index, amountRaw: raw.toString() })
  const amounts = depositAmounts(raw, paired, index)

  const account = wallet.account
  const vault = useRead(`vault-for:${account ?? ''}:${pool.ref.id}`, (signal) => adapter.vaultFor(account ?? '', pool.ref, signal), 0, account !== null)
  const [flowState, setFlowState] = useState<FlowState>({ step: 'idle' })
  const identity = adapter.identity()
  const flow = useMemo<OpenFlow | null>(() => {
    if (!api || !identity || !signerFor || !wallet.wallet) return null
    const store = browserStore()
    return createOpenFlow({
      chain,
      api,
      identity,
      signer: signerFor(wallet.wallet),
      now: nowMs,
      pause: pauseFor,
      onChange: setFlowState,
      sent: (sent) => keepSent(store, chain, sent),
      settled: (hash, outcome, block) => account && keepOutcome(store, chain, account, hash, outcome, block),
    })
  }, [api, identity, signerFor, wallet.wallet, chain, account])
  // Leaving the page stops waiting (a sent transaction stays the receipts list's to follow).
  useEffect(() => () => flow?.cancel(), [flow])

  const blocked = !caps ? null : !caps.actions.available && caps.actions.reason ? actionsReasonText(caps.actions.reason, chain) : null
  const ready = amounts !== null && (amounts[0] > 0n || amounts[1] > 0n) && vault.value !== null && vault.value !== undefined && flow !== null && blocked === null
  const start = () => {
    if (!ready || !account || !vault.value || !amounts) return
    void flow.start({ owner: account, vault: vault.value.address, tickLower: ticks.lower, tickUpper: ticks.upper, amount0Raw: amounts[0].toString(), amount1Raw: amounts[1].toString(), slippageBps: Number(slippage) })
  }
  const busy = flowState.step !== 'idle'

  return (
    <div className="grid gap-6" data-chain2-plan={pool.ref.id}>
      <div className="dm-card dm-card-pad grid gap-3">
        <h2 className="dm-title">Price range</h2>
        <Segmented label="Price range" value={rangeKey} onChange={(key) => setRangeKey(key)} items={(Object.keys(RANGES) as RangeKey[]).map((key) => ({ key, label: RANGES[key].label }))} />
        <p className="text-body text-fg">
          {range.low ?? '—'} – {range.high ?? '—'} <bdi className="text-fg-muted">{tokenLabel(range.quote)}</bdi> per <bdi className="text-fg-muted">{tokenLabel(range.base)}</bdi>
        </p>
        <p className="text-caption text-fg-subtle">Today: 1 <bdi>{tokenLabel(price.base)}</bdi> = {price.text ?? '—'} <bdi>{tokenLabel(price.quote)}</bdi>. Your position earns fees while the price stays in this range.</p>
      </div>

      <div className="dm-card dm-card-pad grid gap-3">
        <h2 className="dm-title">Amount</h2>
        <Segmented label="Amount in" value={side} onChange={(value) => setSide(value)} items={[{ key: '0' as const, label: <bdi>{tokenLabel(pool.token0)}</bdi> }, { key: '1' as const, label: <bdi>{tokenLabel(pool.token1)}</bdi> }]} />
        <label className="grid gap-1 text-caption text-fg-muted">
          <span>How much <bdi>{tokenLabel(typedToken)}</bdi></span>
          <input
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(event) => setTyped(event.currentTarget.value)}
            placeholder="0.0"
            className="dm-search-input rounded-[var(--radius)] border border-line bg-surface-1 px-3 py-2 text-body text-fg"
            aria-invalid={typed !== '' && raw === null}
          />
        </label>
        {typed !== '' && raw === null && <p className="text-caption text-fg-muted">Enter a plain amount, like 1.5, with at most {typedToken.decimals ?? '?'} decimals.</p>}
        {paired?.kind === 'unused' && <p className="text-caption text-fg-muted">At today's price this range takes only <bdi>{tokenLabel(paired.only === 0 ? pool.token0 : pool.token1)}</bdi>.</p>}
        {amounts && (
          <p className="text-body text-fg">
            You deposit <Amount raw={amounts[0]} token={pool.token0} /> and <Amount raw={amounts[1]} token={pool.token1} />.
          </p>
        )}
        {amounts && otherToken.decimals === null && <Missing><bdi>{tokenLabel(otherToken)}</bdi> doesn't say how many decimals it has.</Missing>}
        <details className="dm-details">
          <summary>Advanced</summary>
          <div className="grid gap-2">
            <Segmented label="Price change allowed" value={slippage} onChange={(value) => setSlippage(value)} items={SLIPPAGE_CHOICES.map((key) => ({ key, label: `${Number(key) / 100}%` }))} />
            <p className="text-caption text-fg-subtle">If the price moves more than this before your transaction is confirmed, it is refused and nothing is spent but its network fee.</p>
          </div>
        </details>
      </div>

      <div className="dm-card dm-card-pad grid gap-3">
        <h2 className="dm-title">Review</h2>
        {!caps ? (
          <Skeleton className="block h-5 w-48" />
        ) : blocked && !busy ? (
          // What is not open yet is said first: no wallet is asked for a step that cannot be taken.
          <>
            <p className="text-body text-fg-muted" data-chain2-blocked={caps.actions.reason ?? ''}>{blocked}</p>
            <Button disabled>Review in your wallet</Button>
          </>
        ) : !account ? (
          <>
            <p className="text-body text-fg-muted">Connect the wallet you use on {chain.name}.</p>
            <Button onClick={connect}>Connect wallet</Button>
          </>
        ) : vault.phase === 'loading' ? (
          <Skeleton className="block h-5 w-48" />
        ) : vault.phase === 'waiting' ? (
          <p role="status" className="text-body text-fg-muted">Looking for your vault on {chain.name}…</p>
        ) : vault.value === null ? (
          <p className="text-body text-fg-muted">You don't have a Domino vault for this pool yet. On {chain.name}, positions open inside your own vault, and vaults are set up with Domino during the test.</p>
        ) : busy ? (
          flow && <FlowPanel flow={flow} state={flowState} pool={pool} />
        ) : (
          <>
            {!flow && <p className="text-body text-fg-muted">{actionsReasonText('no-signer', chain)}</p>}
            <Button onClick={start} disabled={!ready}>Review in your wallet</Button>
            {amounts && <p className="text-caption text-fg-subtle">You deposit {amountText(amounts[0], pool.token0.decimals) ?? '—'} <bdi>{tokenLabel(pool.token0)}</bdi> and {amountText(amounts[1], pool.token1.decimals) ?? '—'} <bdi>{tokenLabel(pool.token1)}</bdi>; the service prepares each step and your wallet asks before anything is sent.</p>}
          </>
        )}
      </div>
    </div>
  )
}

export function NewPosition({ param }: { param: string }) {
  const { chain, adapter } = useSection()
  const [chosen, setChosen] = useState<string | null>(null)
  const reference = poolRef(chain, chosen ?? param)
  const read = useRead(`new-pool:${reference?.id ?? 'none'}`, (signal) => (reference ? adapter.poolState(reference, signal) : Promise.reject(new Error('no_pool'))), 30_000, reference !== null)
  const pool = read.value
  const price = pool ? priceLine(chain, pool) : null
  // A link to a pool this deployment does not have: the picker, with a line that says so (fix round 1).
  const gone = reference !== null && read.phase === 'gone'
  // Another pool: back to the picker, whether the pool was picked here or named by the link (fix round 1: from a pool's
  // own New position link the route's pool came straight back, and the button did nothing).
  const another = () => {
    setChosen(null)
    if (param) window.location.hash = sectionHref(chain, 'new')
  }
  return (
    <section data-chain2-screen="new">
      <PageHeader
        title="New position"
        description={price ? <>In <PairName base={price.base} quote={price.quote} /> · {pool ? feeTierText(pool.fee) : ''}</> : `Choose a pool on ${chain.name}.`}
        actions={reference && !gone ? <Button variant="ghost" onClick={another}>Another pool</Button> : undefined}
      />
      <div className="mt-6">
        {!reference || gone ? (
          <div className="dm-card dm-card-pad grid gap-3">
            <h2 className="dm-title">Pool</h2>
            {gone && <p className="text-body text-fg-muted" data-chain2-gone="">{`That link doesn't name a pool on ${chain.name}. Choose one below.`}</p>}
            <PoolChoice onPick={(id) => setChosen(id)} />
          </div>
        ) : !pool ? (
          <Skeleton className="block h-10 w-full" />
        ) : (
          <Plan key={pool.ref.id} pool={pool} />
        )}
      </div>
      {reference && !gone && <p className="mt-4 text-caption text-fg-subtle"><a className="underline" href={sectionHref(chain, 'pool', reference.id)}>About this pool</a></p>}
    </section>
  )
}
