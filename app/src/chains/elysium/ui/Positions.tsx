/**
 * The connected wallet's positions on the second chain (2026-10-01, the chain2 workstream, audit items G7 and G8): in
 * the Domino vaults it owns (found by asking every known vault its owner, which is public) and the position NFTs it
 * holds itself. Each row reads its position once in view: what it holds and the fees it earned and has not collected,
 * in token amounts.
 */
import { Button, EmptyState, LinkButton, PageHeader, Pill, Skeleton, TableShell, Td, Th } from '../../../components/ui'
import { IconWallet } from '../../../components/icons'
import type { PositionSummary } from '../../types'
import { feeTierText, rangeLine, tokenLabel } from '../present'
import { useNow, useSection } from './context'
import { Amount, PairMarks, PairName, ReadAt } from './parts'
import { sectionHref } from './routes'
import { useRead } from './useRead'

const EVERY_MS = 60_000

function Row({ position }: { position: PositionSummary }) {
  const { chain, adapter } = useSection()
  const state = useRead(`position:${position.ref.positionManager}:${position.ref.tokenId}`, (signal) => adapter.position(position.ref, signal), EVERY_MS)
  const live = state.value
  const range = rangeLine(chain, position)
  const href = sectionHref(chain, 'position', position.ref.tokenId)
  const status = !position.active || position.liquidity === 0n ? <Pill tone="neutral">Closed</Pill> : live ? <Pill tone={live.inRange ? 'in' : 'out'} dot>{live.inRange ? 'In range' : 'Out of range'}</Pill> : <Skeleton className="block h-5 w-20" />
  return (
    <tr data-chain2-position={position.ref.tokenId}>
      <Td>
        <a href={href} className="flex min-w-0 items-center gap-3 font-medium text-fg hover:text-fg">
          <PairMarks token0={range.base} token1={range.quote} />
          <span className="min-w-0 truncate">
            <PairName base={range.base} quote={range.quote} />
          </span>
          <span className="dm-chip">{feeTierText(position.fee)}</span>
        </a>
        <p className="mt-1 text-caption text-fg-subtle">{position.holder.kind === 'vault' ? 'Managed by your Domino vault' : 'In your wallet'}</p>
      </Td>
      <Td>
        {range.low !== null && range.high !== null ? (
          <span className="tnum">
            {range.low} – {range.high} <bdi className="text-fg-muted">{tokenLabel(range.quote)}</bdi>
          </span>
        ) : (
          <span className="text-fg-subtle">—</span>
        )}
      </Td>
      <Td>{status}</Td>
      <Td numeric col="wide">
        {live ? (
          <span className="grid text-right">
            <Amount raw={live.amounts[0]} token={live.token0} />
            <Amount raw={live.amounts[1]} token={live.token1} />
          </span>
        ) : (
          <Skeleton className="ml-auto block h-5 w-24" />
        )}
      </Td>
      <Td numeric col="wide">
        {live ? (
          <span className="grid text-right">
            <Amount raw={live.fees[0]} token={live.token0} />
            <Amount raw={live.fees[1]} token={live.token1} />
          </span>
        ) : (
          <Skeleton className="ml-auto block h-5 w-20" />
        )}
      </Td>
    </tr>
  )
}

export function Positions() {
  const { chain, adapter, wallet, connect } = useSection()
  const account = wallet.account
  const list = useRead(`positions:${account ?? ''}`, (signal) => adapter.listPositions(account ?? '', signal), EVERY_MS, account !== null)
  const read = list.value
  return (
    <section data-chain2-screen="positions">
      <PageHeader title="Your positions" description={`Your liquidity on ${chain.name}: what each position holds and the fees it has earned.`} actions={<LinkButton href={sectionHref(chain, 'new')}>New position</LinkButton>} />
      <div className="mt-6">
        {!account ? (
          <EmptyState icon={<IconWallet size={18} />} title="Connect a wallet" body={`Connect the wallet you use on ${chain.name} to see your positions there.`} action={<Button onClick={connect}>Connect wallet</Button>} />
        ) : read !== null && read.length === 0 ? (
          <EmptyState icon={<IconWallet size={18} />} title="No positions yet" body={`This wallet has no positions on ${chain.name}.`} action={<LinkButton href={sectionHref(chain, 'new')}>New position</LinkButton>} />
        ) : (
          <TableShell label={`Your positions on ${chain.name}`} status={list.phase === 'waiting' ? <span role="status" className="text-caption text-fg-subtle">Reading the network again…</span> : undefined}>
            <thead>
              <tr>
                <Th>Position</Th>
                <Th>Price range</Th>
                <Th>Status</Th>
                <Th numeric col="wide">You hold</Th>
                <Th numeric col="wide">Fees earned, not collected</Th>
              </tr>
            </thead>
            <tbody>
              {read === null &&
                [0, 1].map((i) => (
                  <tr key={i} aria-hidden="true">
                    <Td><Skeleton className="block h-5 w-40" /></Td>
                    <Td><Skeleton className="block h-5 w-32" /></Td>
                    <Td><Skeleton className="block h-5 w-20" /></Td>
                    <Td numeric col="wide"><Skeleton className="ml-auto block h-5 w-24" /></Td>
                    <Td numeric col="wide"><Skeleton className="ml-auto block h-5 w-20" /></Td>
                  </tr>
                ))}
              {read?.map((position) => <Row key={position.ref.tokenId} position={position} />)}
            </tbody>
          </TableShell>
        )}
      </div>
      {account && read && read.length > 0 && <PositionsReadAt />}
      {!wallet.onChain && account && <p className="mt-3 text-caption text-fg-subtle">Your wallet is on another network. Positions are read from {chain.name} all the same.</p>}
    </section>
  )
}

/** The list's own read time: the network's head when the list was read. */
function PositionsReadAt() {
  const { chain, reader } = useSection()
  const now = useNow()
  const head = useRead('positions-head', (signal) => reader.head(signal), EVERY_MS)
  return head.value ? <ReadAt className="mt-3" at={{ source: 'chain', block: head.value.number, timestamp: head.value.timestamp }} chain={chain} now={now} /> : null
}
