import { chainMarkProps } from '../../lib/chainMarks'
import { formatUsdFloor } from '../../lib/format/usd'
import type { ReactNode } from 'react'
import { Figure } from '../../components/positions/Figure'
import { TokenMark, TokenMarkPair } from '../../components/TokenIcon'
import { IconChevronRight } from '../../components/icons'
import { Pill, Skeleton } from '../../components/ui'
import type { RowApr } from '../../components/positions/listApr'
import { usdAsOf, type AmountShown, type PositionRowView, type TokenName } from './model'
import { markOf } from '../position/marks'
import { positionBurn } from './positionSync'
import { usdTitleWords } from '../position/usdAvailability'
import { offerVault } from '../automate/handoff'
import type { Address, V2ChainId } from '../../v2/types'

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

// Removed on purpose 2026-10-30 (QA round 2, SWEEP; rule 3): `StaleBadge`, V1's stale badge (the visible word "stale" and
// how old what is shown is). Nothing drew it any more; a row says it only as its data (`data-v2-stale`, below).

/** A row's state, as V1's PositionStatus draws it, plus a position the index could not read. */
function RowStatus({ row }: { row: PositionRowView }) {
  // Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): a row not read (yet) has no pill; it said
  // "Updating", "Unavailable" or "Not read yet", with why in its title. Where it stands is the marker's data.
  if (row.state === 'unread') return <span hidden data-position-status="unread" data-position-unread={row.stale === 'Updating' ? 'updating' : row.status} />
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
 *
 * Changed on purpose 2026-10-15 (pack 7, the owner: no status notices, "as of 02:25 UTC" named among them): a figure
 * that is not current is shown as it is, with no time under it or in its title (data-usd-snapshot still marks it); with
 * no dollar figure, the two amounts carry no reason under them (data-usd-reason keeps it); a dash has no title.
 */
function Amounts({ amounts, which, label, usd, asOf, reason, basis, poolTitle }: { amounts: readonly [AmountShown, AmountShown] | null; which: 'principal' | 'fees'; label: string; usd: string | null; asOf?: number; reason?: string; basis?: 'qualified-prices' | 'pool-price'; poolTitle?: string }) {
  const detail = amounts?.map(amount => `${amount.exact ?? amount.text} ${amount.token.label}`).join(' + ')
  const estimate = basis === 'pool-price' ? poolTitle : undefined
  // A current figure at qualified prices needs no line of its own here (no block is named in a row). Changed on purpose
  // 2026-10-15 (pack 7, the owner: no status notices): no time ("as of 13:05 UTC", "Last complete valuation, from …") and
  // no reason a dollar is missing is said, in view or in the title; the basis of an estimate still is (decision D3).
  const said = usd === null ? undefined : usdTitleWords({ asOf: undefined, estimate, block: null })
  return <span className="dm-own-cell dm-own-usd-cell" data-cell={which} data-usd-reason={usd === null && amounts ? reason : undefined} title={said || detail ? `${said ? `${said} ` : ''}${detail ?? ''}`.trim() : undefined}>
    <span className="dm-own-label">{label}</span>
    {usd !== null ? <>
      <span className="dm-own-fig" data-usd={which} data-usd-basis={basis} data-usd-snapshot={asOf !== undefined ? '' : undefined} data-usd-dated={asOf !== undefined ? '' : undefined}>{formatUsdFloor(usd)}</span>
      {estimate && <span className="sr-only" data-usd-estimate={which}>{estimate}</span>}
      {amounts && <span className="sr-only" data-token-amounts=""><AmountText amount={amounts[0]} /> + <AmountText amount={amounts[1]} /></span>}
    </> : amounts ? <>
      <span className="dm-own-amounts" data-token-amounts="" data-figure="amounts"><AmountText amount={amounts[0]} /><AmountText amount={amounts[1]} /></span>
    </> : <span className="dm-own-dash" data-figure="none">—</span>}
  </span>
}

const markFor = (token: TokenName) => markOf(token.chainId, { address: token.address, symbol: token.symbol ? token.label : null, decimals: token.decimals })

/** Same bounded chain/address artwork as the position detail, including its shared cache. Its size (V4): 32 in the list, 28 in Close positions. */
export function Marks({ tokens, size = 32 }: { tokens: readonly [TokenName, TokenName] | null; size?: number }) {
  if (tokens) return <TokenMarkPair base={markFor(tokens[0])} quote={markFor(tokens[1])} size={size} />
  return (
    <span className="inline-flex shrink-0 items-center" aria-hidden="true">
      <span className="inline-block size-8 rounded-full border-2 border-[var(--card)] bg-surface-3" />
      <span className="-ml-[0.6rem] inline-block size-8 rounded-full border-2 border-[var(--card)] bg-surface-3" />
    </span>
  )
}

/** One token's mark alone (V4: a half of a Close positions progress tile). Decoration only. */
export function TokenHalf({ token, size }: { token: TokenName; size: number }) {
  return <TokenMark token={markFor(token)} size={size} />
}

/** The vault's automation over the row's Automation column, as V1's badge (AutomateEntry.tsx `.dm-own-badge`). */
function VaultColumn({ row }: { row: PositionRowView }) {
  const vault = row.vault
  if (!vault) return null
  // V4: the function's own glyph before its name (decoration only; the name and its marker are unchanged).
  const glyph = vault.name === 'Auto-exit' ? 'exit' : vault.name === 'Domino-compound' ? 'dom' : vault.name === 'Auto-compound' ? 'cmp' : null
  return (
    <span className="dm-collection-auto" data-v2-vault-role={vault.role}>
      {glyph && <span aria-hidden="true" className={`dm-own-ag dm-own-ag--${glyph}`} />}
      <span className="dm-collection-mode" data-running={vault.running ? '' : undefined}>
        {vault.name ?? 'Automation'}
      </span>
      {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): "Updating" (a vault not read yet) is never shown. */}
      {vault.word && vault.word !== 'Updating' && <span className="dm-own-badge-word">{vault.word}</span>}
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
  // Added 2026-11-09 (the core-flows fix; the owner: getting your money back must be totally easy): a closed position whose
  // automation still holds its fees says Withdraw to wallet where it said View history, and opening it lands on that
  // dialog (../automate/handoff.ts, taken by the position's automation panel), one press from the wallet.
  const fundsLeft = closed && row.family?.reserves === 'available' && typeof row.family.vault === 'string'
  const withdrawOnOpen = fundsLeft ? () => offerVault({ chainId: row.chainId as V2ChainId, vault: row.family!.vault as Address, focus: 'withdraw' }) : undefined
  return (
    <div className="dm-own-item" data-v2-position-item={row.key}>
      <a href={row.href} className="dm-own-row" onClick={withdrawOnOpen} data-v2-position-row={row.key} data-v2-row-status={row.status} data-position-block={row.block ?? undefined} data-row-state={closed ? 'closed' : 'open'} data-usd-reason={row.usdReason}>
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
              <span className="dm-collection-network" data-v2-chain={row.chainId} {...chainMarkProps(row.chainId)} title={`${row.chain} · ${row.dexName}`}>{row.chain}</span>
              <RowStatus row={row} />
              <VaultColumn row={row} />
              {closed && <span className="dm-collection-id" aria-hidden="true">#{row.tokenId}</span>}
              {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): how old the row is ("Updating", "updated 6 min
                  ago") is the marker's data only; a screen reader heard it. */}
              {row.stale && <span hidden data-v2-stale={row.stale} />}
            </span>
            {row.family && (row.family.successors > 0 || row.family.reserves === 'available') && <span className="dm-collection-family">{[
              row.family.successors > 0 ? `${row.family.successors} linked position${row.family.successors === 1 ? '' : 's'}` : '',
              // Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): never "Checking automation funds".
              row.family.reserves === 'available' ? 'Funds available in automation' : '',
            ].filter(Boolean).join(' · ')}</span>}
          </span>
        </span>
        {/* (QA round 2, N45) A closed row draws no zero Value or Fees to collect at all: hidden for the eye only, every closed
            row still read "Value $0.00 · Fees to collect $0.00" to a screen reader. A closed row that holds dust shows it. */}
        {!((emptyValue && emptyFees) || burned) && <span className="dm-own-figs">
          {!emptyValue && <span className="dm-own-figure-slot"><Amounts amounts={row.value} which="principal" label="Value" usd={row.valueUsd} asOf={valueAsOf} reason={row.usdReason} basis={row.valueUsdBasis} poolTitle={row.usdPoolTitle} /></span>}
          {!emptyFees && <span className="dm-own-figure-slot"><Amounts amounts={row.fees} which="fees" label="Fees to collect" usd={row.feesUsd} asOf={feesAsOf} reason={row.usdReason} basis={row.feesUsdBasis} poolTitle={row.usdPoolTitle} /></span>}
          {!closed && <span className="dm-own-cell" data-cell="apr" data-apr={apr?.kind === 'rate' ? 'ready' : apr?.kind ?? 'none'}>
            <span className="dm-own-label">Your APR</span>
            {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): a kept rate's title said "Last verified position
                history. Updating automatically.", and the dash's why it is a dash ("… is not available yet"); a dash is a dash now. */}
            {apr?.kind === 'loading' ? <Skeleton className="dm-collection-apr-loading" /> : apr?.kind === 'rate' ? <span className="dm-own-fig" title="Annualized fees earned by this position since it opened.">{apr.text}</span> : <span className="dm-own-dash">—</span>}
          </span>}
        </span>}
        {closed && <span className="dm-own-closed-caption" data-row-withdraw={fundsLeft ? '' : undefined}>{fundsLeft ? 'Withdraw to wallet' : 'View history'}</span>}
        <span className="dm-own-chev">
          <IconChevronRight size={16} />
          <span className="sr-only">Details</span>
        </span>
      </a>
    </div>
  )
}
