/**
 * One pool of the second chain (2026-10-01, the chain2 workstream, audit items G2, G5, G6 and G8): its price, what it
 * holds, and its last day of swaps, all in token amounts and all read from the chain, each with its block and time. The
 * technical facts (address, tick, square-root price, raw liquidity) are in the closed Details.
 */
import { LinkButton, PageHeader, Skeleton, Stat, StatStrip } from '../../../components/ui'
import type { PoolRef, PoolSummary } from '../../types'
import { poolRef } from '../../types'
import { actionsReasonText, feeTierText, priceLine, tokenLabel } from '../present'
import { useNow, useSection } from './context'
import { Amount, ExplorerLink, Missing, PairMarks, PairName, ReadAt } from './parts'
import { sectionHref } from './routes'
import { useRead } from './useRead'

const EVERY_MS = 30_000
const ACTIVITY_HOURS = 24

function Facts({ pool }: { pool: PoolSummary }) {
  const { chain } = useSection()
  return (
    <details className="dm-details mt-6" data-chain2-pool-details="">
      <summary>Details</summary>
      <dl className="dm-kv">
        <div><dt>Pool address</dt><dd><ExplorerLink chain={chain} address={pool.ref.id}>{pool.ref.id}</ExplorerLink></dd></div>
        <div><dt><bdi>{tokenLabel(pool.token0)}</bdi> (token 0)</dt><dd><ExplorerLink chain={chain} address={pool.token0.address} /> · {pool.token0.decimals ?? '?'} decimals</dd></div>
        <div><dt><bdi>{tokenLabel(pool.token1)}</bdi> (token 1)</dt><dd><ExplorerLink chain={chain} address={pool.token1.address} /> · {pool.token1.decimals ?? '?'} decimals</dd></div>
        <div><dt>Fee tier</dt><dd>{pool.fee} millionths · tick spacing {pool.tickSpacing}</dd></div>
        <div><dt>Current tick</dt><dd className="dm-kv-mono">{pool.tick}</dd></div>
        <div><dt>Square-root price (Q64.96)</dt><dd className="dm-kv-mono">{pool.sqrtPriceX96.toString()}</dd></div>
        <div><dt>Active liquidity</dt><dd className="dm-kv-mono">{pool.liquidity.toString()}</dd></div>
        <div><dt>Protocol fee</dt><dd>{pool.feeProtocol === 0 ? 'Off' : `On (${pool.feeProtocol})`}</dd></div>
        <div><dt>Read at block</dt><dd className="dm-kv-mono">{pool.at.block}</dd></div>
      </dl>
    </details>
  )
}

function Activity({ reference, pool }: { reference: PoolRef; pool: PoolSummary }) {
  const { adapter } = useSection()
  const activity = useRead(`activity:${reference.id}`, (signal) => adapter.poolActivity(reference, ACTIVITY_HOURS, signal), 120_000)
  const value = activity.value
  return (
    <>
      <Stat label="Swaps, last 24 h" sub={value ? <span className="text-caption text-fg-subtle">Blocks {value.fromBlock.toLocaleString('en-US')} to {value.toBlock.toLocaleString('en-US')}</span> : undefined}>
        {value ? value.swaps.toLocaleString('en-US') : <Skeleton className="block h-5 w-12" />}
      </Stat>
      <Stat label="Fees to providers, 24 h" info="The pool's fee on what swappers paid in, less any protocol share: an estimate from the swaps on the network.">
        {value ? (
          <span className="grid whitespace-normal break-words">
            <Amount raw={value.providerFees[0]} token={pool.token0} approx />
            <Amount raw={value.providerFees[1]} token={pool.token1} approx />
          </span>
        ) : (
          <Skeleton className="block h-5 w-24" />
        )}
      </Stat>
    </>
  )
}

export function PoolPage({ param }: { param: string }) {
  const { chain, adapter, caps } = useSection()
  const now = useNow()
  const reference = poolRef(chain, param)
  const read = useRead(`pool:${reference?.id ?? 'none'}`, (signal) => (reference ? adapter.poolState(reference, signal) : Promise.reject(new Error('not_a_pool'))), EVERY_MS, reference !== null)
  if (!reference || read.phase === 'gone') {
    return (
      <section data-chain2-screen="pool" data-chain2-gone={reference ? '' : undefined}>
        <PageHeader title="Pool not found" description={`That link doesn't name a pool on ${chain.name}.`} actions={<LinkButton variant="secondary" href={sectionHref(chain)}>All pools</LinkButton>} />
      </section>
    )
  }
  const pool = read.value
  const price = pool ? priceLine(chain, pool) : null
  const blocked = caps && !caps.actions.available && caps.actions.reason ? actionsReasonText(caps.actions.reason, chain) : null
  return (
    <section data-chain2-screen="pool" data-chain2-pool={reference.id}>
      <PageHeader
        eyebrow={pool ? `Uniswap · ${feeTierText(pool.fee)}` : 'Uniswap'}
        title={
          price ? (
            <span className="inline-flex items-center gap-3">
              <PairMarks token0={price.base} token1={price.quote} size={36} />
              <span><PairName base={price.base} quote={price.quote} /></span>
            </span>
          ) : (
            'Pool'
          )
        }
        description={read.phase === 'waiting' && !pool ? `Reading this pool on ${chain.name}…` : undefined}
        actions={<LinkButton href={sectionHref(chain, 'new', reference.id)}>New position</LinkButton>}
      />
      {blocked && <Missing>{blocked}</Missing>}
      <div className="mt-6">
        <StatStrip cols={4} layout="tiles">
          <Stat label="Price">
            {price?.text ? (
              <span className="whitespace-normal break-words" title={`1 ${tokenLabel(price.base)} = ${price.exact} ${tokenLabel(price.quote)}`}>
                {price.text} <bdi className="text-body text-fg-muted">{tokenLabel(price.quote)}</bdi>
              </span>
            ) : pool ? (
              <span className="text-fg-subtle">—</span>
            ) : (
              <Skeleton className="block h-5 w-24" />
            )}
          </Stat>
          <Stat label="In the pool">
            {pool ? (
              <span className="grid whitespace-normal break-words">
                <Amount raw={pool.balances[0]} token={pool.token0} />
                <Amount raw={pool.balances[1]} token={pool.token1} />
              </span>
            ) : (
              <Skeleton className="block h-5 w-28" />
            )}
          </Stat>
          {pool ? <Activity reference={reference} pool={pool} /> : (
            <>
              <Stat label="Swaps, last 24 h"><Skeleton className="block h-5 w-12" /></Stat>
              <Stat label="Fees to providers, 24 h"><Skeleton className="block h-5 w-24" /></Stat>
            </>
          )}
        </StatStrip>
      </div>
      <div className="mt-3 grid gap-1">
        {price && <p className="text-caption text-fg-muted">Price: 1 <bdi>{tokenLabel(price.base)}</bdi> = {price.text ?? '—'} <bdi>{tokenLabel(price.quote)}</bdi></p>}
        {pool && <ReadAt at={pool.at} chain={chain} now={now} />}
        {caps && !caps.usd && <Missing>Dollar values and yearly rates aren't shown here: tokens on {chain.name} have no market price yet.</Missing>}
      </div>
      {pool && <Facts pool={pool} />}
    </section>
  )
}
