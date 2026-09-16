import type { ReactNode } from 'react'
import { reasonText } from '../../../lib/read/describe'
import { failureText } from '../../../lib/read/screens/copy'
import { poolPositionsView, type PoolPositionRow } from '../../../lib/read/screens/figures'
import { shortAddress } from '../../../lib/read/screens/identity'
import type { PoolOption } from '../../../lib/read/screens/poolsList'
import type { ScreenOutcome } from '../../../lib/read/screens/screenRead'
import { Skeleton } from '../../ui'
import { CurrencyHead, PairCells } from './PoolActivityCard'

/** Rows shown before the rest fold away. */
export const POSITION_ROWS = 12

const Dash = ({ title }: { title?: string }) => (
  <span className="text-fg-subtle" title={title}>
    —
  </span>
)

const sentence = (text: { title: string; detail: string }) => [text.title, text.detail].filter(Boolean).join('. ').replace(/\.\./g, '.')

function Row({ row, block }: { row: PoolPositionRow; block: number }) {
  return (
    <tr data-pool-position={row.key} data-position-liquidity={row.hasLiquidity ? 'some' : 'none'}>
      <td className="tnum">
        {row.tickLower} to {row.tickUpper}
      </td>
      <td className="tnum">
        {row.nft ? (
          <span title={row.nft.tokenId} translate="no">
            #{row.nft.tokenId.length > 12 ? `${row.nft.tokenId.slice(0, 6)}…${row.nft.tokenId.slice(-4)}` : row.nft.tokenId}
          </span>
        ) : (
          <Dash title="No position NFT was resolved for this position" />
        )}
      </td>
      <td>
        {row.nft?.owner ? (
          <span className="font-mono tracking-normal" translate="no" title={`${row.nft.owner}: the NFT’s owner at block ${block}, public data. It proves nothing about who controls a wallet.`}>
            <span aria-hidden="true">{shortAddress(row.nft.owner)}</span>
            <span className="sr-only">{row.nft.owner}</span>
          </span>
        ) : (
          <Dash title={row.nft ? `The position was empty at block ${block}` : 'Owner not resolved'} />
        )}
      </td>
    </tr>
  )
}

function Rows({ rows, block }: { rows: PoolPositionRow[]; block: number }) {
  return (
    <>
      {rows.map((row) => (
        <Row key={row.key} row={row} block={block} />
      ))}
    </>
  )
}

/**
 * Positions in this pool, from pool-positions: how many there are, how many
 * hold liquidity, the pool's LP assets in token units, and each position's
 * range with its NFT and that NFT's owner at the snapshot block where the
 * read service resolved them. An owner is public data at that block, never a
 * sign of who controls a wallet. The section is on the page only where
 * pool-positions is listed; without an answer its figures are dashes, with
 * the reason in the section's title.
 */
export function PoolPositionsCard({ read, option }: { read: ScreenOutcome<'pool-positions'> | null; option: PoolOption }) {
  const view = read?.state === 'ok' ? poolPositionsView(read.data, option.currencies) : null
  const failure = read && read.state !== 'ok' && read.state !== 'aborted' ? read : null
  const reason = failure
    ? sentence(failureText(failure, 'pools'))
    : view?.state === 'unavailable'
      ? `Unavailable: ${reasonText(view.reason)}`
      : view?.stale
        ? `Stale at block ${view.block}.`
        : undefined
  const state = view ? (view.state === 'unavailable' ? 'unavailable' : view.stale ? 'stale' : 'ok') : failure ? 'unavailable' : 'loading'
  const counted = view?.state === 'reconciled' ? view : null
  const cell = (node: ReactNode) => (counted ? node : state === 'loading' ? <Skeleton className="ml-auto h-4 w-12" /> : <Dash title={reason} />)
  const shown = counted ? counted.rows.slice(0, POSITION_ROWS) : []
  const folded = counted ? counted.rows.slice(POSITION_ROWS) : []
  const table = (rows: PoolPositionRow[]) => (
    <div className="dm-pool-table-wrap">
      <table className="dm-pool-table dm-pool-table--positions">
        <thead>
          <tr>
            <th scope="col">Range, in ticks</th>
            <th scope="col">NFT</th>
            <th scope="col" title="Whoever held the position’s NFT at the snapshot block: public data, not proof of control">Owner at block {counted?.block}</th>
          </tr>
        </thead>
        <tbody>
          <Rows rows={rows} block={counted?.block ?? 0} />
        </tbody>
      </table>
    </div>
  )
  return (
    <section className="dm-card mt-6 animate-rise p-5 [--delay:180ms]" aria-labelledby="pool-positions-title" data-pool-positions={state} data-positions-reason={view?.state === 'unavailable' ? view.reason : failure?.state} title={reason}>
      <h2 id="pool-positions-title" className="dm-display dm-display-card" title="Every position on this pool at one block. Owners are public data at that block.">
        Positions in this pool
      </h2>
      <p role="status" className="sr-only">{state === 'loading' ? 'Reading positions…' : state === 'unavailable' ? reason : ''}</p>
      <dl className="dm-kv dm-pool-kv dm-pool-kv--2 -mx-5 mt-3">
        <div><dt>Positions</dt><dd>{cell(counted?.count.toLocaleString('en-US'))}</dd></div>
        <div><dt>With liquidity</dt><dd>{cell(counted?.withLiquidity.toLocaleString('en-US'))}</dd></div>
        <div><dt>Block</dt><dd>{view ? view.block : cell(null)}</dd></div>
      </dl>
      <div className="dm-pool-table-wrap mt-2">
        <table className="dm-pool-table" data-positions-assets="">
          <CurrencyHead option={option} first={<span className="sr-only">Figure</span>} />
          <tbody>
            <tr>
              <th scope="row">LP assets</th>
              {counted ? (
                <PairCells pair={counted.lpAssets} />
              ) : (
                <>
                  <td>{cell(null)}</td>
                  <td>{cell(null)}</td>
                </>
              )}
            </tr>
          </tbody>
        </table>
      </div>
      {shown.length > 0 && <div className="mt-4">{table(shown)}</div>}
      {folded.length > 0 && (
        <details className="dm-details -mx-3 mt-2">
          <summary>
            {folded.length} more position{folded.length === 1 ? '' : 's'}
          </summary>
          {table(folded)}
        </details>
      )}
    </section>
  )
}
