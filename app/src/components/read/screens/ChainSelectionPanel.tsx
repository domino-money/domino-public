import { pricePair } from '../../../lib/read/orientation'
import { useCallback, useEffect, useState } from 'react'
import { COPY } from '../../../lib/read/screens/copy'
import type { ChainSelectionSlotProps, PickerChrome } from '../../../lib/read/screens/pickerChrome'
import { poolPrice, presetFor, shownPrice, shownRange, type PracticeRange } from '../../../lib/read/screens/poolRange'
import type { PoolOption } from '../../../lib/read/screens/poolsList'
import { useReadSource } from '../../../lib/read/screens/readContext'
import type { TokenCandidate } from '../../../lib/read/screens/tokens'
import { TokenMark } from '../../TokenIcon'
import { Button, Pill } from '../../ui'
import { Address } from './Address'
import { PoolPicker } from './PoolPicker'
import { PoolRangeControls, Units, priceOrWords } from './PoolRangeControls'
import { SymbolText } from './SymbolText'
import { TokenPicker } from './TokenPicker'

type View = 'row' | 'token' | 'pair' | 'pool' | 'range'

const KIND = { native: 'native currency', erc20_candidate: 'ERC-20 candidate', unknown: 'unknown' } as const

function TokenSummary({ label, candidate }: { label: string; candidate: TokenCandidate }) {
  return (
    <div className="flex min-w-0 items-start gap-2.5" data-summary={label}>
      <TokenMark token={candidate.token} size={20} />
      <div className="min-w-0 text-[0.75rem]">
        <p>
          <span className="text-fg-muted">{label}: </span>
          <span className="font-medium">
            <SymbolText token={candidate.token} />
          </span>
          <span className="text-fg-subtle"> · {KIND[candidate.kind]}</span>
          {candidate.decimalsUnavailable && <span className="text-money-wait"> · {COPY.selection.decimalsUnavailable}</span>}
        </p>
        <Address value={candidate.key} />
      </div>
    </div>
  )
}

/** A pool with a usable price starts on the app's "Closer" preset; one without has no range at all. */
function startingRange(pool: PoolOption | null): PracticeRange | null {
  const price = pool ? poolPrice(pool, 0) : null
  return price?.state === 'usable' ? presetFor(price, 'standard') : null
}

/** The chosen practice range, as it reads in the compact row. */
function RangeSummary({ pool, range }: { pool: PoolOption; range: PracticeRange }) {
  // Block, tick and decimals never change with time; only staleness does, and the range view says that.
  const price = poolPrice(pool, 0)
  if (price.state !== 'usable') return null
  // Lowest price first, the app's one way round (2026-09-28): the page's frame, the pool's ticks after it.
  const shown = shownPrice(price)
  const view = shownRange(range, price.inverted)
  return (
    <p className="text-[0.75rem]" data-summary="Range">
      <span className="text-fg-muted">{COPY.selection.rangeSummary}: </span>
      <span className="tnum font-mono">
        {priceOrWords(view.lower, shown)} to {priceOrWords(view.upper, shown)}
      </span>{' '}
      <Units price={price} />
      <span className="text-fg-subtle">
        {' '}
        · ticks {range.lower} to {range.upper} · on the price at block {price.block} · {COPY.selection.rangeSummaryNote}
      </span>
    </p>
  )
}

/**
 * Issue #3 inside the practice create dialog, on the Pair step: choose a real
 * token, an optional second asset and an existing pool from chain data, then
 * draw a practice range on that pool's price as read. The practice pair,
 * amounts and range stay exactly as they are; nothing chosen here is saved,
 * and nothing can be quoted, signed or executed.
 *
 * The compact row lives in the step body. Each picker, and the range view,
 * replaces the body and takes over the dialog's header and footer through
 * `onChrome`; Back, Escape and a backdrop click return to the row, keeping
 * the practice draft.
 */
export function ChainSelectionPanel({ onChrome }: ChainSelectionSlotProps) {
  const source = useReadSource()
  const [view, setView] = useState<View>('row')
  const [first, setFirst] = useState<TokenCandidate | null>(null)
  const [second, setSecond] = useState<TokenCandidate | null>(null)
  const [pool, setPool] = useState<PoolOption | null>(null)
  const [range, setRange] = useState<PracticeRange | null>(null)
  const [pendingToken, setPendingToken] = useState<TokenCandidate | null>(null)
  const [pendingPool, setPendingPool] = useState<PoolOption | null>(null)
  const [pendingRange, setPendingRange] = useState<PracticeRange | null>(null)
  const [candidates, setCandidates] = useState<TokenCandidate[]>([])

  // A different pool, or none, drops the practice range drawn on the old one.
  const choosePool = useCallback((next: PoolOption | null) => {
    setPool(next)
    setRange(null)
  }, [])

  useEffect(() => {
    if (view === 'row') {
      onChrome(null)
      return
    }
    const back = () => setView('row')
    const chrome: PickerChrome =
      view === 'range'
        ? {
            title: COPY.range.title,
            description: COPY.range.description,
            backLabel: COPY.picker.back,
            nextLabel: COPY.range.use,
            nextDisabled: pool === null || pendingRange === null || poolPrice(pool, 0).state !== 'usable',
            focusKey: 'picker-range',
            onBack: back,
            onNext: () => {
              if (!pendingRange) return
              setRange(pendingRange)
              setView('row')
            },
          }
        : view === 'pool'
          ? {
              title: COPY.picker.poolTitle,
              description: COPY.picker.poolDescription,
              backLabel: COPY.picker.back,
              nextLabel: COPY.picker.usePool,
              nextDisabled: pendingPool === null,
              focusKey: 'picker-pool',
              onBack: back,
              onNext: () => {
                if (!pendingPool) return
                if (pendingPool.key !== pool?.key) choosePool(pendingPool)
                setView('row')
              },
            }
          : {
              title: view === 'token' ? COPY.picker.tokenTitle : COPY.picker.pairTitle,
              description: view === 'token' ? COPY.picker.tokenDescription : COPY.picker.pairDescription,
              backLabel: COPY.picker.back,
              nextLabel: view === 'token' ? COPY.picker.useToken : COPY.picker.useAsset,
              nextDisabled: pendingToken === null || (view === 'pair' && pendingToken.key === first?.key),
              focusKey: `picker-${view}`,
              onBack: back,
              onNext: () => {
                if (!pendingToken) return
                if (view === 'token') {
                  if (pendingToken.key !== first?.key) {
                    setSecond(null)
                    choosePool(null)
                  }
                  setFirst(pendingToken)
                } else {
                  if (pendingToken.key !== second?.key) choosePool(null)
                  setSecond(pendingToken)
                }
                setView('row')
              },
            }
    onChrome(chrome)
  }, [view, pendingToken, pendingPool, pendingRange, first, second, pool, onChrome, choosePool])

  useEffect(() => () => onChrome(null), [onChrome])

  const open = (next: View) => {
    setPendingToken(next === 'token' ? first : next === 'pair' ? second : null)
    setPendingPool(next === 'pool' ? pool : null)
    setPendingRange(next === 'range' ? (range ?? startingRange(pool)) : null)
    setView(next)
  }

  if (view !== 'row' && source) {
    if (view === 'range' && first && pool) {
      return (
        <PoolRangeControls
          source={source}
          token={first.key}
          paired={second?.key ?? null}
          option={pool}
          // A new reading of the same pool: its price moves, the practice range stays.
          onOption={setPool}
          range={pendingRange}
          onRange={setPendingRange}
        />
      )
    }
    return view === 'pool' && first ? (
      <PoolPicker source={source} token={first.key} paired={second?.key ?? null} pending={pendingPool} onPending={setPendingPool} />
    ) : (
      <TokenPicker
        source={source}
        variant={view === 'pair' ? 'pair' : 'token'}
        exclude={view === 'pair' ? (first?.key ?? null) : null}
        candidates={candidates}
        onCandidates={setCandidates}
        pending={pendingToken}
        onPending={setPendingToken}
      />
    )
  }

  return (
    <section aria-labelledby="chain-selection-title" className="grid gap-3 rounded-[var(--radius)] border border-dashed p-3" data-chain-selection="">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="chain-selection-title" className="text-[0.8125rem] font-medium">
          {COPY.selection.heading}
        </h3>
        <Pill>{COPY.selection.pill}</Pill>
      </div>
      {first && <TokenSummary label="Token" candidate={first} />}
      {second && <TokenSummary label="Second asset" candidate={second} />}
      {pool && (
        <div className="grid gap-0.5 text-[0.75rem]" data-summary="Pool">
          <p>
            <span className="text-fg-muted">Pool: </span>
            {/* Named as its price is written (audit E21). */}
            <SymbolText token={pricePair(pool.currencies[0], pool.currencies[1]).base} /> / <SymbolText token={pricePair(pool.currencies[0], pool.currencies[1]).quote} />
            <span className="font-mono"> · {pool.fee}</span>
            <span className="text-fg-subtle">
              {' '}
              · {COPY.selection.verifiedAt} {pool.block} · {pool.kind === 'discovery' ? 'provider discovery' : 'catalogue'}
            </span>
          </p>
          <Address value={pool.key} />
        </div>
      )}
      {pool && range && <RangeSummary pool={pool} range={range} />}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={!source} onClick={() => open('token')}>
          {first ? COPY.selection.changeToken : COPY.selection.chooseToken}
        </Button>
        {first && (
          <Button type="button" variant="outline" onClick={() => open('pair')}>
            {second ? COPY.selection.changeSecond : COPY.selection.chooseSecond}
          </Button>
        )}
        {first && (
          <Button type="button" variant="outline" onClick={() => open('pool')}>
            {pool ? COPY.selection.changePool : COPY.selection.choosePool}
          </Button>
        )}
        {first && pool && (
          <Button type="button" variant="outline" onClick={() => open('range')}>
            {range ? COPY.selection.changeRange : COPY.selection.setRange}
          </Button>
        )}
      </div>
    </section>
  )
}
