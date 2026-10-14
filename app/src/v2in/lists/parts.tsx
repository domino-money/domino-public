import { formatUsdFloor } from '../../lib/format/usd'
import type { ReactNode } from 'react'
import { Figure } from '../../components/positions/Figure'
import { TokenMarkPair } from '../../components/TokenIcon'
import { IconChevronRight } from '../../components/icons'
import { Badge, Pill, Skeleton } from '../../components/ui'
import type { RowApr } from '../../components/positions/listApr'
import { usdAsOf, type AmountShown, type PositionRowView, type TokenName } from './model'
import { markOf } from '../position/marks'
import { positionBurn } from './positionSync'
import { asOfWords, usdMissingShort, usdTitleWords, usdUnavailableReason } from '../position/usdAvailability'

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
        {row.stale === 'Updating' ? 'Updating' : row.status === 'unavailable' ? 'Unavailable' : 'Not read yet'}
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
 * Value and fees keep one slot. With a dollar figure: the figure, its two token amounts in the title and for screen
 * readers, and its time under it when it is not current.
 *
 * Changed on purpose 2026-10-14 (the incident of 2026-10-13, package V1; the owner: "USD unavailable" must not appear on
 * a position; decision D4). The slot never says "USD unavailable" any more:
 *   - a figure that is not current (the last complete valuation, or one worked out from prices whose newest read
 *     failed) says "as of HH:MM UTC" under it (`asOf`, Unix ms);
 *   - with no figure, the position's two token amounts are the figure, in view (as V1's rows always wrote a pair with
 *     no USD, components/positions/PositionRow.tsx), with one short reason under them (`why`, said once per row);
 *   - with no amounts either (a position not read yet), a dash whose reason is the cell's title and the row's status.
 *
 * Changed on purpose 2026-10-14 (package V1, review; decision D3: "basis disclosed"): the time no longer takes the place
 * of the basis. An estimate at the pool's price that is not current says both, in its title and to a screen reader:
 * "Last complete valuation, from …. Estimated from the pool price …. This is not a sale quote." It said only the first,
 * exactly while the figure was also old.
 */
function Amounts({ amounts, which, label, unread, usd, asOf, why, reason, basis, poolTitle }: { amounts: readonly [AmountShown, AmountShown] | null; which: 'principal' | 'fees'; label: string; unread: string | null; usd: string | null; asOf?: number; why?: string | null; reason?: string; basis?: 'qualified-prices' | 'pool-price'; poolTitle?: string }) {
  const detail = amounts?.map(amount => `${amount.exact ?? amount.text} ${amount.token.label}`).join(' + ')
  const estimate = basis === 'pool-price' ? poolTitle : undefined
  // A current figure at qualified prices needs no line of its own here (no block is named in a row).
  const said = usd === null ? (amounts ? usdUnavailableReason(reason) : undefined) : usdTitleWords({ asOf, estimate, block: null })
  return <span className="dm-own-cell dm-own-usd-cell" data-cell={which} title={`${said ? `${said} ` : ''}${detail ?? unread ?? 'Not reported'}`}>
    <span className="dm-own-label">{label}</span>
    {usd !== null ? <>
      <span className="dm-own-fig" data-usd={which} data-usd-basis={basis} data-usd-snapshot={asOf !== undefined ? '' : undefined}>{formatUsdFloor(usd)}</span>
      {asOf !== undefined && <span className="dm-own-est" data-usd-as-of={which}>{asOfWords(asOf)}</span>}
      {estimate && <span className="sr-only" data-usd-estimate={which}>{estimate}</span>}
      {amounts && <span className="sr-only" data-token-amounts=""><AmountText amount={amounts[0]} /> + <AmountText amount={amounts[1]} /></span>}
    </> : amounts ? <>
      <span className="dm-own-amounts" data-token-amounts="" data-figure="amounts"><AmountText amount={amounts[0]} /><AmountText amount={amounts[1]} /></span>
      {why && <span className="dm-own-est" data-usd-why={which}>{why}</span>}
    </> : <span className="dm-own-dash" data-figure="none">—</span>}
  </span>
}

/** Same bounded chain/address artwork as the position detail, including its shared cache. */
function Marks({ tokens }: { tokens: readonly [TokenName, TokenName] | null }) {
  const mark = (token: TokenName) => markOf(token.chainId, { address: token.address, symbol: token.symbol ? token.label : null, decimals: token.decimals })
  if (tokens) return <TokenMarkPair base={mark(tokens[0])} quote={mark(tokens[1])} size={28} />
  return (
    <span className="inline-flex shrink-0 items-center" aria-hidden="true">
      <span className="inline-block size-7 rounded-full border-2 border-[var(--card)] bg-surface-3" />
      <span className="-ml-[0.525rem] inline-block size-7 rounded-full border-2 border-[var(--card)] bg-surface-3" />
    </span>
  )
}

/** The vault's automation over the row's Automation column, as V1's badge (AutomateEntry.tsx `.dm-own-badge`). */
function VaultColumn({ row }: { row: PositionRowView }) {
  const vault = row.vault
  if (!vault) return null
  return (
    <span className="dm-collection-auto" data-v2-vault-role={vault.role}>
      <span className="dm-collection-mode" data-running={vault.running ? '' : undefined}>
        {vault.name ?? 'Automation'}
      </span>
      {vault.word && <span className="dm-own-badge-word">{vault.word}</span>}
    </span>
  )
}

/**
 * One of the person's own positions read from read-v6, as a row of Your positions. `late` (2026-10-14, package V1):
 * nothing newer has arrived for this row for as long as a figure is current, so a figure of what is read now says the
 * time it is as of.
 *
 * Changed on purpose 2026-10-14 (package V1, review): `late` is the row's own (./hooks.ts useUsdAged of its
 * `usdSeenAt`: the older of its amounts and its prices, by when this page took them), where it was the portfolio's
 * alone and exempted every row whose dollar is the chain's own. Such a row (a USDG pair only the site's inventory
 * lists) could never say its time: half-hour-old dollars were drawn as current while the state route was refused.
 * Each of the two figures says its own time (model.ts usdAsOf): one may be of now beside a kept one.
 */
export function V2PositionRow({ row, apr = null, late = false }: { row: PositionRowView; apr?: RowApr | null; late?: boolean }) {
  const closed = row.state === 'closed'
  const valueAsOf = usdAsOf(row, 'value', late), feesAsOf = usdAsOf(row, 'fees', late)
  // One short reason per row, under the first of its two figures that has none.
  const why = row.usdReason ? usdMissingShort(row.usdReason) : null
  const emptyValue = closed && row.value?.every(amount => amount.kind === 'zero')
  const emptyFees = closed && row.fees?.every(amount => amount.kind === 'zero')
  const terminal = positionBurn(row)
  const burned = closed && terminal !== null && terminal.block >= (row.block ?? 0)
  const pair: ReactNode = row.tokens ? (
    <>
      <TokenText token={row.tokens[0]} /> / <TokenText token={row.tokens[1]} />
    </>
  ) : (
    <>Position #{row.tokenId}</>
  )
  return (
    <div className="dm-own-item" data-v2-position-item={row.key}>
      <a href={row.href} className="dm-own-row" data-v2-position-row={row.key} data-v2-row-status={row.status} data-position-block={row.block ?? undefined} data-row-state={closed ? 'closed' : 'open'} data-usd-reason={row.usdReason}>
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
              <span className="sr-only">{row.dexName}. </span>
              <span className="sr-only">
                Position #{row.tokenId} on {row.chain}
              </span>
            </span>
            <span className="dm-own-state flex-wrap gap-1.5">
              <span className="dm-collection-network" data-v2-chain={row.chainId} title={`${row.chain} · ${row.dexName}`}>{row.chain}</span>
              <RowStatus row={row} />
              <VaultColumn row={row} />
              {closed && <span className="dm-collection-id" aria-hidden="true">#{row.tokenId}</span>}
              {row.stale && <span className="sr-only" data-v2-stale={row.stale}>{row.stale}</span>}
            </span>
            {row.family && (row.family.successors > 0 || row.family.reserves !== null) && <span className="dm-collection-family">{[
              row.family.successors > 0 ? `${row.family.successors} linked position${row.family.successors === 1 ? '' : 's'}` : '',
              row.family.reserves === 'available' ? 'Funds available in automation' : row.family.reserves === 'unknown' ? 'Checking automation funds' : '',
            ].filter(Boolean).join(' · ')}</span>}
          </span>
        </span>
        <span className={closed && ((emptyValue && emptyFees) || burned) ? 'dm-own-figs dm-own-empty-figure' : 'dm-own-figs'}>
          <span className={emptyValue || burned ? 'dm-own-empty-figure' : 'dm-own-figure-slot'}><Amounts amounts={row.value} which="principal" label="Value" unread={row.unread} usd={row.valueUsd} asOf={valueAsOf} why={row.valueUsd === null ? why : null} reason={row.usdReason} basis={row.valueUsdBasis} poolTitle={row.usdPoolTitle} /></span>
          <span className={emptyFees || burned ? 'dm-own-empty-figure' : 'dm-own-figure-slot'}><Amounts amounts={row.fees} which="fees" label="Fees to collect" unread={row.unread} usd={row.feesUsd} asOf={feesAsOf} why={row.valueUsd !== null && row.feesUsd === null ? why : null} reason={row.usdReason} basis={row.feesUsdBasis} poolTitle={row.usdPoolTitle} /></span>
          {!closed && <span className="dm-own-cell" data-cell="apr" data-apr={apr?.kind === 'rate' ? 'ready' : apr?.kind ?? 'none'}>
            <span className="dm-own-label">Your APR</span>
            {apr?.kind === 'loading' ? <Skeleton className="dm-collection-apr-loading" /> : apr?.kind === 'rate' ? <span className="dm-own-fig" title={apr.saved ? 'Last verified position history. Updating automatically.' : 'Annualized fees earned by this position since it opened.'}>{apr.text}</span> : <span className="dm-own-dash" title={apr?.kind === 'missing' ? apr.words : 'The position’s verified fee history is not available yet.'}>—</span>}
          </span>}
        </span>
        {closed && <span className="dm-own-closed-caption">View history</span>}
        <span className="dm-own-chev">
          <IconChevronRight size={16} />
          <span className="sr-only">Details</span>
        </span>
      </a>
    </div>
  )
}
