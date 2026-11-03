import type { MouseEvent } from 'react'
import { CREATE } from '../../lib/create/copy'
import type { JourneyState } from '../../lib/create/journey'
import { onOtherChain, type OtherChains } from '../../lib/create/otherChains'
import { pricePair } from '../../lib/read/orientation'
import type { PoolOption } from '../../lib/read/screens/poolsList'
import type { ReadSource } from '../../lib/read/types'
import { FEE_MEANING } from '../explore/feeMeaning'
import { IconCheck } from '../icons'
import { NetworkPoolPicker, PoolPicker } from '../read/screens/PoolPicker'
import { SymbolText } from '../read/screens/SymbolText'
import { TokenMarkPair } from '../TokenIcon'
import { Button, Chip } from '../ui'

/**
 * The chosen pool: its pair and fee. The same panel whichever way the pool
 * came: from the list, or from a pool page's link. Changed on purpose
 * 2026-10-06 (the owner's point 4: nothing technical in the way): the fee
 * chip no longer carries the block the pool was verified at as its title.
 *
 * There is no choice of what to deposit here. A position holds both of the
 * pool's currencies, so the amount step shows a row for each and the token an
 * amount is typed in is the independent one (PairedAmounts.tsx). A currency
 * the read could not identify is said there, on its own row.
 */
export function ChosenPool({ option, onChange, network = null }: { option: PoolOption; onChange: (event: MouseEvent<HTMLButtonElement>) => void; network?: string | null }) {
  // QA round 2, Q24: named as Markets and the pool page name it (the order its price is written), icons matched to the names.
  const pair = pricePair(option.currencies[0], option.currencies[1])
  return (
    <div className="dm-flow-panel" data-chosen-pool={option.key}>
      <div className="dm-flow-pool-head">
        {/* The chosen row keeps its place and gains a check where its radio was. */}
        <span aria-hidden="true" className="dm-flow-chosen-check">
          <IconCheck size={12} />
        </span>
        <TokenMarkPair base={pair.base} quote={pair.quote} size={32} />
        <div className="dm-flow-pool-name">
          <p className="dm-flow-pool-pair">
            <SymbolText token={pair.base} /> / <SymbolText token={pair.quote} />
          </p>
          <p className="flex flex-wrap items-center gap-1.5">
            {/* 2026-10-05 (New position on Base and Arbitrum One): the pool's network, once other networks are offered. */}
            {network !== null && <Chip data-chain-chip={option.currencies[0].chainId}>{network}</Chip>}
            {/* Changed on purpose (round 6, 2026-09-27): the fee in plain words, "0.30% fee"; Uniswap is every pool's. QA round 2,
                Q28: what the fee is, on hover, as every fee chip says it. */}
            <Chip title={FEE_MEANING}>{CREATE.pool.fee(option.fee)}</Chip>
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onChange}>
          {CREATE.pool.change}
        </Button>
      </div>
    </div>
  )
}

/**
 * The existing pools for the chosen token (and second asset), read when this
 * list mounts. The rows are the whole step: no footnote under them. No row is
 * suggested, and the flow's prices already name both tokens ("USDG per WETH").
 *
 * Only pools Domino can open a position in are listed (no hooks, a fixed fee),
 * largest reported TVL first, each with its TVL, 24h volume and APR: the
 * picker's `create` variant. A pool with hooks is never a row here, so the
 * chosen pool needs no note about one.
 */
export function PoolList({
  source,
  state,
  onPool,
  onPreview,
  others = null,
  hint = null,
}: {
  source: ReadSource
  state: JourneyState
  onPool: (option: PoolOption | null) => void
  onPreview?: (option: PoolOption | null) => void
  /** The other networks New position offers (2026-10-05): another network's token lists that network's pools. */
  others?: OtherChains | null
  /** QA round 2, N5: another network's link's proposed pool, chosen once by that network's list when its read lists it. */
  hint?: string | null
}) {
  const token = state.token
  if (!token) return null
  // Another network's token (2026-10-05): its pools are read through the wallet on that network, drawn as today's rows.
  if (others && onOtherChain(token.token)) {
    const chosen = token.token
    return (
      <NetworkPoolPicker
        key={`${chosen.chainId}:${token.key}`}
        read={(signal) => others.pools(chosen, signal)}
        network={others.name(chosen.chainId)}
        pending={state.pool}
        onPending={onPool}
        onPreview={onPreview}
        hint={hint}
        hintRefused={CREATE.token.preselectWithdrawn}
      />
    )
  }
  return (
    <PoolPicker
      key={`${token.key}:${state.paired?.key ?? ''}`}
      source={source}
      token={token.key}
      paired={state.paired?.key ?? null}
      pending={state.pool}
      onPending={onPool}
      onPreview={onPreview}
      compact
      variant="create"
      catalogue={false}
      network={others?.home ?? null}
    />
  )
}
