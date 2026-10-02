/**
 * The second chain's Markets (2026-10-01, the chain2 workstream, audit items G2, G6 and G8): its pools, read from the
 * chain itself (rugged97's service has no pool list), each with its price written the registry's way round and what the
 * pool holds in token amounts. No dollar value and no APR: the chain's capabilities have neither, and the page says so
 * once instead of showing empty columns.
 */
import { EmptyState, PageHeader, Skeleton, TableShell, Td, Th } from '../../../components/ui'
import { IconSearch } from '../../../components/icons'
import type { PoolSummary } from '../../types'
import { feeTierText, priceLine, tokenLabel } from '../present'
import { useNow, useSection } from './context'
import { Amount, Missing, PairMarks, PairName, ReadAt } from './parts'
import { sectionHref } from './routes'
import { useRead } from './useRead'

/** How often the list is read again while it is on screen. */
const EVERY_MS = 30_000

function Row({ pool }: { pool: PoolSummary }) {
  const { chain } = useSection()
  const price = priceLine(chain, pool)
  const href = sectionHref(chain, 'pool', pool.ref.id)
  return (
    <tr data-chain2-pool={pool.ref.id}>
      <Td>
        <a href={href} className="flex min-w-0 items-center gap-3 font-medium text-fg hover:text-fg">
          <PairMarks token0={price.base} token1={price.quote} />
          <span className="min-w-0 truncate">
            <PairName base={price.base} quote={price.quote} />
          </span>
          <span className="dm-chip">{feeTierText(pool.fee)}</span>
        </a>
      </Td>
      <Td numeric>
        {price.text === null ? (
          <span className="text-fg-subtle">—</span>
        ) : (
          <span title={`1 ${tokenLabel(price.base)} = ${price.exact} ${tokenLabel(price.quote)}`}>
            1 <bdi>{tokenLabel(price.base)}</bdi> = {price.text} <bdi>{tokenLabel(price.quote)}</bdi>
          </span>
        )}
      </Td>
      <Td numeric col="wide">
        <span className="grid text-right">
          <Amount raw={pool.balances[0]} token={pool.token0} />
          <Amount raw={pool.balances[1]} token={pool.token1} />
        </span>
      </Td>
    </tr>
  )
}

export function Markets() {
  const { chain, adapter, source, caps } = useSection()
  const now = useNow()
  const pools = useRead('pools', (signal) => adapter.listPools(signal), EVERY_MS)
  const list = pools.value
  return (
    <section data-chain2-screen="markets">
      <PageHeader title="Markets" description={`Uniswap pools on ${chain.name}. Prices and amounts are read straight from the network.`} />
      {source.kind === 'rehearsal' && (
        <p className="mt-3 max-w-[70ch] text-body text-fg-muted">These pools come from Domino's test run on {chain.name}. Their tokens are test tokens with no market value.</p>
      )}
      <div className="mt-6">
        <TableShell label={`Pools on ${chain.name}`} title="Pools" status={pools.phase === 'waiting' ? <span role="status" className="text-caption text-fg-subtle">Reading the network again…</span> : undefined}>
          <thead>
            <tr>
              <Th>Pool</Th>
              <Th numeric>Price</Th>
              <Th numeric col="wide">In the pool</Th>
            </tr>
          </thead>
          <tbody>
            {list === null &&
              [0, 1].map((i) => (
                <tr key={i} aria-hidden="true">
                  <Td><Skeleton className="block h-5 w-40" /></Td>
                  <Td numeric><Skeleton className="ml-auto block h-5 w-32" /></Td>
                  <Td numeric col="wide"><Skeleton className="ml-auto block h-5 w-28" /></Td>
                </tr>
              ))}
            {list?.map((pool) => <Row key={pool.ref.id} pool={pool} />)}
          </tbody>
        </TableShell>
        {list !== null && list.length === 0 && <EmptyState icon={<IconSearch size={18} />} title="No pools yet" body={`No pool has been created on ${chain.name} for Domino yet.`} />}
      </div>
      <div className="mt-3 grid gap-1">
        {list?.[0] && <ReadAt at={list[0].at} chain={chain} now={now} />}
        {caps && !caps.usd && <Missing>Dollar values and yearly rates aren't shown here: tokens on {chain.name} have no market price yet.</Missing>}
      </div>
    </section>
  )
}
