import { CREATE } from '../../lib/create/copy'
import type { JourneyState } from '../../lib/create/journey'
import type { PoolOption } from '../../lib/read/screens/poolsList'
import type { ReadSource } from '../../lib/read/types'
import { IconCheck } from '../icons'
import { PoolPicker } from '../read/screens/PoolPicker'
import { SymbolText } from '../read/screens/SymbolText'
import { TokenMarkPair } from '../TokenIcon'
import { Button, Chip } from '../ui'

/**
 * The chosen pool: its pair and fee, with where it was verified in the chip's
 * title rather than a line under the name.
 *
 * There is no choice of what to deposit here. A position holds both of the
 * pool's currencies, so the amount step shows a row for each and the token an
 * amount is typed in is the independent one (PairedAmounts.tsx). A currency
 * the read could not identify is said there, on its own row.
 */
export function ChosenPool({ option, onChange }: { option: PoolOption; onChange: () => void }) {
  return (
    <div className="dm-flow-panel" data-chosen-pool={option.key}>
      <div className="dm-flow-pool-head">
        {/* The chosen row keeps its place and gains a check where its radio was. */}
        <span aria-hidden="true" className="dm-flow-chosen-check">
          <IconCheck size={12} />
        </span>
        <TokenMarkPair base={option.currencies[0]} quote={option.currencies[1]} size={32} />
        <div className="dm-flow-pool-name">
          <p className="dm-flow-pool-pair">
            <SymbolText token={option.currencies[0]} /> / <SymbolText token={option.currencies[1]} />
          </p>
          <p className="flex flex-wrap items-center gap-1.5">
            <Chip title={CREATE.pool.verifiedAt(option.block)}>Uniswap · {option.fee}</Chip>
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
}: {
  source: ReadSource
  state: JourneyState
  onPool: (option: PoolOption | null) => void
  onPreview?: (option: PoolOption | null) => void
}) {
  const token = state.token
  if (!token) return null
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
    />
  )
}
