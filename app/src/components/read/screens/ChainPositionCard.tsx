import type { ReactNode } from 'react'
import { COPY } from '../../../lib/read/screens/copy'
import { utcTime } from '../../../lib/read/screens/figures'
import type { AmountView, Batch, ChainPositionCard as Card } from '../../../lib/read/screens/positions'
import { NATIVE_CURRENCY, shortAddress } from '../../../lib/read/screens/identity'
import { TokenMarkPair } from '../../TokenIcon'
import { Pill } from '../../ui'
import { TokenLabel } from '../TokenLabel'
import { Address } from './Address'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-dashed py-2 last:border-b-0 sm:grid-cols-[minmax(130px,0.8fr)_2fr] sm:gap-4">
      <dt className="text-[12px] text-fg-muted">{label}</dt>
      <dd className="min-w-0 text-[13px]">{children}</dd>
    </div>
  )
}

function Amount({ amount }: { amount: AmountView }) {
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5" data-amount={amount.kind}>
      <span className="tnum break-all font-mono">{amount.text}</span>
      <TokenLabel token={amount.token} />
      {amount.kind === 'raw' && <span className="text-[12px] text-fg-subtle">raw units, decimals unknown</span>}
    </span>
  )
}

export function snapshotText(batch: Batch) {
  const fresh = batch.freshness.status === 'stale' ? `stale, ${batch.freshness.ageSeconds} s old when read` : `fresh, ${batch.freshness.ageSeconds} s old when read`
  return `Block ${batch.block.number} · ${utcTime(batch.block.timestamp)} · ${fresh}`
}

/**
 * One position NFT as public chain data:
 * dashed border, its own pills, no controls, and no sentence that says the
 * viewer owns or controls it. The owner is the NFT owner at the snapshot
 * block, which is public data and proves nothing about who is looking.
 */
export function ChainPositionCard({ card, batch, index }: { card: Card; batch: Batch; index: number }) {
  const titleId = `chain-card-${index}`
  const stale = batch.freshness.status === 'stale'
  return (
    <article aria-labelledby={titleId} className="rounded-[var(--radius-lg)] border border-dashed bg-surface-1 p-4 md:px-5" data-chain-card={card.kind}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={titleId} className="text-[15px] font-medium">
            Position NFT #<span translate="no">{shortAddress(card.tokenId)}</span>
          </h3>
          <p className="mt-0.5 break-all font-mono text-[11px] text-fg-subtle">ID {card.tokenId}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Pill>{COPY.card.chainPill}</Pill>
          <Pill>{COPY.card.publicPill}</Pill>
          {stale && <Pill tone="wait">{COPY.card.stalePill}</Pill>}
        </div>
      </header>

      {card.kind === 'empty' ? (
        <p className="mt-3 text-[13px] text-fg-muted" data-empty-at-snapshot="">
          {COPY.card.empty}
        </p>
      ) : (
        <dl className="mt-3">
          <Row label={COPY.card.pair}>
            <span className="flex flex-wrap items-center gap-2">
              <TokenMarkPair base={card.currencies[0]} quote={card.currencies[1]} size={20} ring="var(--surface-1)" />
              <span className="font-medium">
                <TokenLabel token={card.currencies[0]} /> / <TokenLabel token={card.currencies[1]} />
              </span>
            </span>
            <span className="mt-1 grid gap-0.5 text-[12px] text-fg-muted">
              {card.currencies.map((token, i) => (
                <span key={i} className="min-w-0">
                  {token.origin === 'read' && token.address === NATIVE_CURRENCY ? 'Native currency ' : `Currency ${i} `}
                  <Address value={token.origin === 'read' ? token.address : ''} />
                </span>
              ))}
            </span>
          </Row>
          <Row label={COPY.card.pool}>
            <Address value={card.poolId} />
          </Row>
          <Row label={COPY.card.fee}>
            <span className="font-mono" data-fee="">
              {card.fee}
            </span>
            <span className="text-fg-subtle"> · {COPY.card.tickSpacing} {card.tickSpacing}</span>
          </Row>
          <Row label={COPY.card.hooks}>{card.hooks === NATIVE_CURRENCY ? <span className="font-mono text-[12px]">{COPY.card.noHooks}</span> : <Address value={card.hooks} />}</Row>
          <Row label={COPY.card.range}>
            <span className="tnum font-mono" data-ticks="">
              Ticks {card.range.tickLower} to {card.range.tickUpper}
            </span>
            {card.range.prices ? (
              <span className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-[12px] text-fg-muted" data-prices="">
                <span className="tnum font-mono">
                  {card.range.prices.lower} to {card.range.prices.upper}
                </span>
                <TokenLabel token={card.currencies[1]} /> per <TokenLabel token={card.currencies[0]} />
              </span>
            ) : (
              <span className="mt-0.5 block text-[12px] text-fg-subtle">{COPY.card.pricesUnavailable}</span>
            )}
            <span className="mt-1 block text-[12px]" data-in-range={card.inRange ? 'yes' : 'no'}>
              {card.inRange ? COPY.card.inRange : COPY.card.outOfRange}
              {!card.hasLiquidity && <span className="block text-fg-subtle" data-no-liquidity="">{COPY.card.noLiquidity}</span>}
            </span>
          </Row>
          <Row label={COPY.card.principal}>
            <span className="grid gap-0.5">
              <Amount amount={card.principal[0]} />
              <Amount amount={card.principal[1]} />
            </span>
          </Row>
          <Row label={COPY.card.unsettled}>
            <span className="grid gap-0.5">
              <Amount amount={card.unsettledFees[0]} />
              <Amount amount={card.unsettledFees[1]} />
            </span>
            <span className="mt-1 block text-[12px] text-fg-subtle">{COPY.card.noHistory}</span>
          </Row>
          <Row label={COPY.card.value}>
            <span className="text-fg-subtle" data-valuation="unavailable">
              {COPY.card.valueUnavailable}
            </span>
          </Row>
          <Row label={COPY.card.owner}>
            <Address value={card.owner.address} />
            <span className="mt-1 block text-[12px] text-fg-subtle">{COPY.card.ownerNote}</span>
          </Row>
          <Row label={COPY.card.manager}>
            <Address value={card.positionManager} />
          </Row>
        </dl>
      )}
      <p className="mt-2 font-mono text-[11px] text-fg-subtle" data-snapshot="">
        {COPY.card.snapshot}: {snapshotText(batch)}
      </p>
    </article>
  )
}
