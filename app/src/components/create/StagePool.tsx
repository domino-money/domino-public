import { useState } from 'react'
import { CREATE } from '../../lib/create/copy'
import { candidatesFromPool, type JourneyState } from '../../lib/create/journey'
import { COPY } from '../../lib/read/screens/copy'
import type { PoolOption } from '../../lib/read/screens/poolsList'
import { selectable, type TokenCandidate } from '../../lib/read/screens/tokens'
import type { ReadSource } from '../../lib/read/types'
import { Address } from '../read/screens/Address'
import { PoolPicker } from '../read/screens/PoolPicker'
import { PoolSelectionDialog } from '../read/screens/PoolSelectionDialog'
import { SymbolText } from '../read/screens/SymbolText'
import { TokenPicker, whyText } from '../read/screens/TokenPicker'
import { TokenMark, TokenMarkPair } from '../TokenIcon'
import { Button, Chip } from '../ui'

/**
 * The chosen pool: its pair and fee, with where it was verified in the chip's
 * title rather than a line under the name, and the two currencies as the
 * choice of what to deposit. A currency the read could not identify stays
 * visible, not choosable, and says why.
 */
export function ChosenPool({
  option,
  state,
  candidates,
  onToken,
  onChange,
}: {
  option: PoolOption
  state: JourneyState
  /** Candidates already known for this flow; a richer one (a read, a wallet row) wins over the pool read's own. */
  candidates: readonly TokenCandidate[]
  onToken: (candidate: TokenCandidate) => void
  onChange: () => void
}) {
  const choices = candidatesFromPool(option).map((fromPool) => candidates.find((known) => known.key === fromPool.key && selectable(known)) ?? fromPool)
  const reasons = choices.map((choice, index) => ({ id: `create-deposit-why-${index}`, text: whyText(choice) }))
  return (
    <div className="dm-flow-panel" data-chosen-pool={option.key}>
      <div className="dm-flow-pool-head">
        <TokenMarkPair base={option.currencies[0]} quote={option.currencies[1]} size={28} />
        <div className="dm-flow-pool-name">
          <p className="truncate text-body font-medium text-fg">
            <SymbolText token={option.currencies[0]} /> / <SymbolText token={option.currencies[1]} />
          </p>
          <p className="flex flex-wrap items-center gap-1.5">
            <Chip title={CREATE.pool.verifiedAt(option.block)}>Uniswap · {option.fee}</Chip>
            {option.integration !== 'hookless_fixed_fee' && <span className="text-caption text-money-wait">{COPY.picker.needsAdapter}</span>}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onChange}>
          {CREATE.pool.change}
        </Button>
      </div>
      <fieldset className="dm-flow-deposit">
        <legend className="dm-flow-deposit-legend">{CREATE.token.depositWith}</legend>
        <div className="dm-flow-choices">
          {choices.map((choice, index) => (
            <label key={choice.key} className="dm-flow-choice" data-disabled={selectable(choice) ? undefined : ''}>
              <input
                type="radio"
                name="create-deposit-token"
                value={choice.key}
                checked={state.token?.key === choice.key}
                disabled={!selectable(choice)}
                onChange={() => onToken(choice)}
                aria-describedby={reasons[index].text ? reasons[index].id : undefined}
                className="dm-flow-choice-input"
              />
              <TokenMark token={choice.token} size={20} />
              <SymbolText token={choice.token} />
            </label>
          ))}
        </div>
        {reasons.map(
          (reason) =>
            reason.text && (
              <p key={reason.id} id={reason.id} className="dm-hint">
                {reason.text}
              </p>
            ),
        )}
      </fieldset>
    </div>
  )
}

/** The existing pools for the chosen token (and second asset), read when this list mounts. */
export function PoolList({ source, state, onPool }: { source: ReadSource; state: JourneyState; onPool: (option: PoolOption | null) => void }) {
  const token = state.token
  if (!token) return null
  return (
    <div className="grid gap-3">
      <PoolPicker key={`${token.key}:${state.paired?.key ?? ''}`} source={source} token={token.key} paired={state.paired?.key ?? null} pending={state.pool} onPending={onPool} compact />
      <p className="dm-hint" data-no-suggestion="">
        {CREATE.pool.noSuggestion} {CREATE.pool.orientation}
      </p>
    </div>
  )
}

/**
 * An optional second asset that narrows the pool list; never a requirement.
 * It is chosen in a dialog with the same token picker, and excludes the token
 * being deposited.
 */
export function PairedAsset({
  source,
  state,
  onPaired,
}: {
  source: ReadSource | null
  state: JourneyState
  onPaired: (candidate: TokenCandidate | null) => void
}) {
  const [choosing, setChoosing] = useState(false)
  const [pendingPaired, setPendingPaired] = useState<TokenCandidate | null>(null)
  const [pairedCandidates, setPairedCandidates] = useState<TokenCandidate[]>([])
  const token = state.token
  if (!token) return null
  const pairedOk = pendingPaired !== null && selectable(pendingPaired) && pendingPaired.key !== token.key
  return (
    <details className="dm-details dm-flow-disclosure">
      <summary>
        {CREATE.pool.pairedHeading}
        {state.paired && (
          <span className="dm-flow-disclosure-value">
            <SymbolText token={state.paired.token} />
          </span>
        )}
      </summary>
      <div className="grid gap-3">
        <p className="text-caption text-fg-muted">{CREATE.pool.pairedNote}</p>
        {state.paired && (
          <p className="flex min-w-0 items-center gap-2 text-body" data-paired={state.paired.key}>
            <TokenMark token={state.paired.token} size={20} />
            <SymbolText token={state.paired.token} />
            <span className="text-caption text-fg-subtle">
              <Address value={state.paired.key} short />
            </span>
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!source}
            onClick={() => {
              setPendingPaired(state.paired)
              setChoosing(true)
            }}
          >
            {state.paired ? CREATE.pool.changePaired : CREATE.pool.choosePaired}
          </Button>
          {state.paired && (
            <Button type="button" variant="ghost" size="sm" onClick={() => onPaired(null)}>
              {CREATE.pool.clearPaired}
            </Button>
          )}
        </div>
      </div>
      {choosing && source && (
        <PoolSelectionDialog
          title={CREATE.pool.pairedDialogTitle}
          description={CREATE.pool.pairedDialogDescription}
          onClose={() => setChoosing(false)}
          footer={
            <Button
              type="button"
              disabled={!pairedOk}
              onClick={() => {
                if (!pairedOk) return
                onPaired(pendingPaired)
                setChoosing(false)
              }}
            >
              {CREATE.pool.selectPaired}
            </Button>
          }
        >
          <TokenPicker source={source} variant="pair" exclude={token.key} candidates={pairedCandidates} onCandidates={setPairedCandidates} pending={pendingPaired} onPending={setPendingPaired} />
        </PoolSelectionDialog>
      )}
    </details>
  )
}
