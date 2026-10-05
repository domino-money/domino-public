import { formatUsdFloor } from '../../lib/format/usd'
import type { ReactNode } from 'react'
import { Figure } from '../../components/positions/Figure'
import { QuietMarkPair } from '../../components/positions/visual/QuietMarks'
import { IconChevronRight } from '../../components/icons'
import { Badge, Pill } from '../../components/ui'
import type { AmountShown, PositionRowView, TokenName } from './model'

/*
 * The pieces the lists draw for read-v6's positions, in V1's own row markup and classes (components/positions/PositionRow.tsx,
 * styles/positions.css), so a row from another chain sits in the same grid as V1's and reads the same: the pair and its fee
 * over its state, then Value and Fees ready to collect as token amounts, the automation badge, and the chevron; the whole
 * row is the link to the position's own page. What differs is said with V1's own pill style: the chain and the DEX, a
 * stale chain or read with its age, and nothing for USD or APR (no qualified source exists: §6.3, decision #22).
 */

/** A token's name as text: its symbol (untrusted, isolated in <bdi> and width-capped, as V1's TokenLabel), else its short address. */
export function TokenText({ token }: { token: TokenName }) {
  if (!token.symbol) return <span className="font-mono tracking-normal">{token.label}</span>
  return <bdi className="inline-block max-w-[14ch] truncate align-bottom">{token.label}</bdi>
}

/** One amount as V1's rows write it (PositionFigures.tsx Amount): six significant digits, every digit in its title; a dash when unread or with unknown decimals. */
export function AmountText({ amount }: { amount: AmountShown }) {
  const symbol = (
    <span className="dm-acct-amount-symbol">
      <TokenText token={amount.token} />
    </span>
  )
  if (amount.kind === 'unread') {
    return (
      <span className="dm-acct-amount" data-amount="unread">
        <span className="text-fg-subtle">—</span> {symbol}
      </span>
    )
  }
  if (amount.kind === 'raw') {
    return (
      <span className="dm-acct-amount" data-amount="raw" title={`Raw amount ${amount.raw}: the token’s decimals were not read`}>
        <span className="text-fg-subtle">—</span> {symbol}
      </span>
    )
  }
  return (
    <span className="dm-acct-amount" data-amount={amount.kind} title={amount.kind === 'units' ? (amount.exact ?? undefined) : undefined}>
      <Figure text={amount.text} /> {symbol}
    </span>
  )
}

/** V1's in-row pill size (styles/positions.css `.dm-own-state > .dm-pill`), for a badge in a row's title line. */
const COMPACT = 'min-h-5 gap-1.5 px-2 py-0.5'

/** The chain a row or a receipt is on, in V1's pill style; `compact` in a row's title line. */
export function ChainBadge({ name, chainId, compact = false }: { name: string; chainId: number; compact?: boolean }) {
  return (
    <Pill data-v2-chain-badge={chainId} className={compact ? `whitespace-nowrap ${COMPACT}` : 'whitespace-nowrap'}>
      {name}
    </Pill>
  )
}

/**
 * Whether the DEX badge says its version ("Uniswap v4") or only "Uniswap". Decided 2026-10-02 (the orchestrator, on the
 * owner's rule of 2026-09-13 that nothing on screen says "v4"): the badge says "Uniswap"; the version is in its title and
 * its data attribute (and in the position's own address and page).
 */
export const DEX_BADGE_SHOWS_VERSION = false

/** The DEX a position is on, in V1's pill style, compact in a row's title line: "Uniswap", its version in its title. */
export function DexBadge({ name, dex }: { name: string; dex: 3 | 4 }) {
  return (
    <Pill data-v2-dex-badge={dex} title={name} className={`whitespace-nowrap ${COMPACT}`}>
      {DEX_BADGE_SHOWS_VERSION ? name : 'Uniswap'}
    </Pill>
  )
}

/** V1's stale badge, with how old what is shown is. */
export function StaleBadge({ age }: { age: string }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5" data-v2-stale={age}>
      <Badge kind="stale" />
      <span className="text-[0.75rem] leading-4 text-fg-subtle">{age}</span>
    </span>
  )
}

/** A row's state, as V1's PositionStatus draws it, plus a position the index could not read. */
function RowStatus({ row }: { row: PositionRowView }) {
  if (row.state === 'unread') {
    return (
      <Pill data-position-status="unread" title={row.unread ?? undefined}>
        {row.status === 'unavailable' ? 'Unavailable' : 'Not read yet'}
      </Pill>
    )
  }
  if (row.state === 'closed') {
    return (
      <Pill dot data-position-status="closed">
        Closed
      </Pill>
    )
  }
  return row.state === 'in-range' ? (
    <Pill dot tone="in" data-position-status="in-range">
      In range
    </Pill>
  ) : (
    <Pill dot tone="out" data-position-status="out-of-range">
      Out of range
    </Pill>
  )
}

/**
 * Value or Fees ready to collect: the two token amounts, or a dash saying why. Changed on purpose 2026-10-06 (read-v6
 * 1.1.0-rc.1's qualified USD): with a USD figure, V1's row (components/positions/PositionRow.tsx Money): the figure, its
 * two amounts under it.
 */
function Amounts({ amounts, which, label, unread, usd }: { amounts: readonly [AmountShown, AmountShown] | null; which: 'principal' | 'fees'; label: string; unread: string | null; usd: string | null }) {
  return (
    <span className="dm-own-cell" data-cell={which}>
      <span className="dm-own-label">{label}</span>
      {amounts && usd !== null ? (
        <>
          <span className="dm-own-fig dm-arrive" data-usd={which}>
            {formatUsdFloor(usd)}
          </span>
          <span className="dm-own-split">
            <AmountText amount={amounts[0]} />
            <AmountText amount={amounts[1]} />
          </span>
        </>
      ) : amounts ? (
        <span className="dm-own-amounts">
          <AmountText amount={amounts[0]} />
          <AmountText amount={amounts[1]} />
        </span>
      ) : (
        <span className="dm-own-dash" title={unread ?? 'Not reported'} aria-label={unread ?? 'Not reported'} data-figure="none">
          —
        </span>
      )}
    </span>
  )
}

/** Two quiet marks for the pair (no request is made for artwork), or two plain discs for a position not read. */
function Marks({ tokens }: { tokens: readonly [TokenName, TokenName] | null }) {
  if (tokens) return <QuietMarkPair addresses={[tokens[0].address, tokens[1].address]} size={32} />
  return (
    <span className="inline-flex shrink-0 items-center" aria-hidden="true">
      <span className="inline-block size-8 rounded-full border-2 border-[var(--card)] bg-surface-3" />
      <span className="-ml-[0.625rem] inline-block size-8 rounded-full border-2 border-[var(--card)] bg-surface-3" />
    </span>
  )
}

/** The vault's automation over the row's Automation column, as V1's badge (AutomateEntry.tsx `.dm-own-badge`). */
function VaultColumn({ row }: { row: PositionRowView }) {
  const vault = row.vault
  if (!vault || !vault.name) return null
  return (
    <div className="dm-own-auto" data-v2-vault-role={vault.role}>
      <span className="dm-own-badge" data-running={vault.running ? '' : undefined}>
        {vault.name}
      </span>
      {vault.word && <span className="dm-own-badge-word">{vault.word}</span>}
    </div>
  )
}

/** One of the person's own positions read from read-v6, as a row of Your positions. */
export function V2PositionRow({ row }: { row: PositionRowView }) {
  const pair: ReactNode = row.tokens ? (
    <>
      <TokenText token={row.tokens[0]} /> / <TokenText token={row.tokens[1]} />
    </>
  ) : (
    <>Position #{row.tokenId}</>
  )
  return (
    <div className="dm-own-item" data-v2-position-item={row.key}>
      <a href={row.href} className="dm-own-row" data-v2-position-row={row.key} data-v2-row-status={row.status}>
        <span className="dm-own-pool">
          <Marks tokens={row.tokens} />
          <span className="dm-own-name">
            <span className="dm-own-title gap-y-1">
              <span className="dm-own-pair">{pair}</span>
              {row.fee && (
                <span className="dm-own-fee">
                  <span data-fee="">{row.fee}</span> fee
                </span>
              )}
              {/* In the title line, which wraps, and which V1's phone layout gives the row's whole width (styles/positions.css). */}
              <ChainBadge name={row.chain} chainId={row.chainId} compact />{' '}
              <DexBadge name={row.dexName} dex={row.dex} />
              <span className="sr-only">
                Position #{row.tokenId} on {row.chain}
              </span>
            </span>
            <span className="dm-own-state flex-wrap gap-1.5">
              <RowStatus row={row} />
              {row.stale && <StaleBadge age={row.stale} />}
            </span>
          </span>
        </span>
        <span className="dm-own-figs">
          <Amounts amounts={row.value} which="principal" label="Value" unread={row.unread} usd={row.valueUsd} />
          <Amounts amounts={row.fees} which="fees" label="Fees ready to collect" unread={row.unread} usd={row.feesUsd} />
        </span>
        <span className="dm-own-chev">
          <IconChevronRight size={16} />
          <span className="sr-only">Details</span>
        </span>
      </a>
      <VaultColumn row={row} />
    </div>
  )
}
