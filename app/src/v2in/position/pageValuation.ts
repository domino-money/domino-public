import type { PortfolioResponse } from 'api-contracts/read-v6/types'
import { POSITION_MANAGER } from '../../lib/fees/constants'
import type { WalletPosition } from '../../lib/walletPositions'
import { ZERO_ADDRESS } from '../../v2/types'
import { tokenNamer } from '../lists/model'
import { minimumPositionBlock, positionKey, positionObservation } from '../lists/positionSync'
import { POSITION_VALUATIONS, type PositionUsd, type PositionValuations } from '../lists/valuation'
import { chainDollar, rawAmounts } from '../usd'
import { asOfWords, poolEstimateWords, usdMissingShort, usdTitleWords } from './usdAvailability'

/**
 * Added 2026-10-14 (the incident of 2026-10-13, package V1; the owner's decision D3: the pool-price dollar estimate on
 * Robinhood Chain's own position page, as the list already shows it, basis disclosed). That page (screens/
 * PositionDetail.tsx) valued a pair with USDG only, so ETH / IMD showed dollars in its list row and token amounts on its
 * own page. Here its figures are worked out by the same valuation as its row (../lists/valuation.ts, ../usd.ts
 * currentUsd), from the same things: the page's own state reading (the newest the browser holds of the NFT) and read-v6's
 * prices from the connected wallet's portfolio answer, which the page's automation already reads (no request is added).
 * Where read-v6 says nothing of a token (no wallet connected, or a token its answer does not list) the chain's own
 * dollar stands in (../usd.ts chainDollar), which is the page's rule for a USDG pair since 2026-09.
 *
 * Changed on purpose 2026-10-14 (package V1, the review of the first pass):
 *   - the time no longer takes the place of the basis: an estimate at the pool's price that is not current says both,
 *     on each figure's title and in Details ("Last complete valuation, from …. Estimated from the pool price …");
 *   - each of the two figures says its own time: one may be of what is read now beside a kept one (`now`);
 *   - "as of" names the day when the moment is not today, so the page's clock is handed in (`clock`);
 *   - a visitor's page may take its prices from the position owner's answer (pagePrices below).
 *
 * Pure but for the valuation memory it reads and keeps (the last complete valuation, the list's own).
 */

/** What the page's two money tiles draw (components/positions/KeyFigures.tsx KeyUsd, written there too: a V1 file imports no V2 module). */
export interface PageUsd {
  /** Decimal strings at 18 places; null: no figure from here. */
  principal: string | null
  fees: string | null
  principalBasis?: 'qualified-prices' | 'pool-price'
  feesBasis?: 'qualified-prices' | 'pool-price'
  /** What each figure is worked out from, for its title. */
  principalTitle: string | null
  feesTitle: string | null
  /** The time and the basis in words for Details, when a figure is an estimate at the pool's price or is not current; else null. */
  detail: string | null
  /** "as of 13:05 UTC" when the figures are not current, else null. */
  asOf: string | null
  /** The figures are the last complete valuation, kept. */
  saved: boolean
  /**
   * This one of the two figures is of what is read now all the same, beside a kept one (a measured zero needs no
   * price): it says its own time, null while it is current, and never the kept one's.
   */
  now?: { figure: 'principal' | 'fees'; asOf: string | null }
  /** One short reason when a figure is missing and read-v6 said why, else null. */
  why: string | null
  /**
   * read-v6 said something of one of the two tokens. False: the prices are the chain's own dollar alone, which is the
   * page's own rule figure for figure, so the page draws that itself, as it always has, unless there is a time to say.
   */
  quoted: boolean
  reason?: string
}

export interface PageReading {
  tokenId: string
  /** The page's own read of the NFT, and its block. */
  position: WalletPosition
  block: number
  /** Not the page's own chain read: a copy this browser kept, or the read gateway's row. */
  saved: boolean
}

type Answer = Pick<PortfolioResponse, 'chains' | 'tokens' | 'servedAt'>

const pairOf = (values: readonly [string, string] | null): readonly [bigint, bigint] | null => {
  const raws = values ? rawAmounts(values) : null
  return raws ? [raws[0], raws[1]] : null
}

/** The state route's own reading of the page's NFT at the page's block, when the browser holds it (lib/fees/client.ts notes every answer). */
const observedOf = (reading: Pick<PageReading, 'tokenId' | 'block' | 'saved'>) => {
  const observed = reading.saved ? null : positionObservation({ chainId: 4663, positionManager: POSITION_MANAGER, tokenId: reading.tokenId })
  return observed && observed.block === reading.block ? observed : null
}

/** When this page took its reading of the NFT, by its own clock (ms): what "nothing newer for two minutes" is counted from; null when not known. */
export const pageReadingSeen = (reading: Pick<PageReading, 'tokenId' | 'block' | 'saved'>): number | null => observedOf(reading)?.seen ?? null

/**
 * Added 2026-10-14 (package V1, review): whose portfolio answer the page's prices come from. The connected wallet's
 * (`mine`) when it says anything of the position's two tokens: its own word comes first. Else the position owner's
 * (`owners`), when it does: the answer the owner's own row is valued with, which this page's Activity already reads
 * (./PageUsd.tsx). Until then the page had the connected wallet's alone, so a visitor (no wallet, or one that holds
 * neither token) saw the page's own USDG rule where the owner's row showed read-v6's qualified prices, and token
 * amounts for ETH / token. With neither, the page does exactly what it did before.
 */
export function pagePrices<T extends Pick<PortfolioResponse, 'tokens'>>(position: Pick<WalletPosition, 'currencies'>, mine: T | null, owners: T | null): T | null {
  const says = (answer: T | null) => answer !== null && position.currencies.some((currency) => answer.tokens.some((token) => token.chainId === 4663 && token.address.toLowerCase() === currency.address))
  return says(mine) || !says(owners) ? mine : owners
}

/**
 * The page's dollars. `answer`: the portfolio answer its prices come from (pagePrices), or null. `aged`: nothing newer
 * has arrived for as long as a figure is current (../lists/hooks.ts useUsdAged), by the page's own clock: `late`, no
 * newer portfolio answer (a figure worked out from its prices then says its time); `still`, no newer reading of the NFT
 * (any figure does). `clock`: the page's clock (Unix ms), for the day of a moment that is not today.
 */
export function robinhoodPageUsd(reading: PageReading, answer: Answer | null, aged: { late?: boolean; still?: boolean } = {}, valuations: PositionValuations = POSITION_VALUATIONS, clock: number = Date.now()): PageUsd {
  const { position, block } = reading
  const identity = { chainId: 4663, positionManager: POSITION_MANAGER, tokenId: reading.tokenId }
  // The time of the page's reading: the state route's own, of the same block.
  const readAt = observedOf(reading)?.timestamp ?? null
  const name = tokenNamer(answer?.tokens ?? [])
  const tokens = position.currencies.map((currency) => {
    const listed = answer?.tokens.find((token) => token.chainId === 4663 && token.address.toLowerCase() === currency.address) ?? null
    const named = name(4663, currency.address)
    // As the list's row: read-v6's word on a token it lists (a price it withholds stays withheld); the chain's own dollar otherwise.
    return { label: named.label, listed: listed !== null, decimals: listed ? named.decimals : currency.decimals, usd: listed ? named.usd : chainDollar(4663, currency.address), missing: listed && !listed.price ? listed.priceReason : null }
  })
  const quoted = tokens.some((token) => token.listed)
  const chain = answer?.chains.find((one) => one.chainId === 4663)
  const usd: PositionUsd = valuations.value({
    key: positionKey(identity),
    liquidity: position.liquidity,
    held: block < minimumPositionBlock(identity),
    principal: pairOf(position.principal),
    fees: pairOf(position.unclaimedFees),
    decimals: [tokens[0].decimals, tokens[1].decimals],
    prices: [tokens[0].usd, tokens[1].usd],
    sqrtPriceX96: position.sqrtPriceX96,
    allowPoolMark: position.hooks.toLowerCase() === ZERO_ADDRESS,
    readAt,
    quotedAt: quoted && answer ? (chain?.status === 'current' ? answer.servedAt : null) : readAt,
    missing: tokens.map((token) => token.missing),
    block,
    dollar: !quoted,
  })
  // A figure of what is read now says its time once nothing newer has arrived; the kept one always says the kept time.
  const old = (aged.late === true && quoted) || aged.still === true
  const asOfOf = (figure: 'value' | 'fees'): number | undefined => {
    if (usd.now?.figure === figure) return old ? usd.now.at : undefined
    return usd.at !== null && (usd.saved || old) ? usd.at : undefined
  }
  const estimate = usd.anchor === undefined ? undefined : poolEstimateWords(tokens[usd.anchor].label, usd.dollar === true, usd.block ?? null)
  const titleOf = (figure: 'value' | 'fees', basis: PositionUsd['valueBasis']) => (!basis ? null : usdTitleWords({ asOf: asOfOf(figure), estimate: basis === 'pool-price' ? estimate : undefined, block }) ?? null)
  const valueAsOf = usd.value === null ? undefined : asOfOf('value'), feesAsOf = usd.fees === null ? undefined : asOfOf('fees')
  // The time under the figures that are not of now: the kept valuation's, or a current one's grown old.
  const dated = usd.now ? (usd.now.figure === 'value' ? feesAsOf : valueAsOf) : valueAsOf ?? feesAsOf
  // Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): Details names an estimate's basis, never the time of a
  // figure that is not current ("Last complete valuation, from …"); `asOf` and `why` stay for the model's tests, unshown.
  const said = estimate ?? ''
  return {
    principal: usd.value,
    fees: usd.fees,
    ...(usd.valueBasis ? { principalBasis: usd.valueBasis } : {}),
    ...(usd.feesBasis ? { feesBasis: usd.feesBasis } : {}),
    principalTitle: titleOf('value', usd.valueBasis),
    feesTitle: titleOf('fees', usd.feesBasis),
    detail: usd.value === null && usd.fees === null ? null : said || null,
    asOf: dated !== undefined ? asOfWords(dated, clock) : null,
    saved: usd.saved,
    ...(usd.now ? { now: { figure: usd.now.figure === 'value' ? 'principal' as const : 'fees' as const, asOf: old ? asOfWords(usd.now.at, clock) : null } } : {}),
    // Without read-v6's word there is nothing to say but the amounts themselves, as the page always showed them.
    why: usd.reason && quoted && (usd.value === null || usd.fees === null) ? usdMissingShort(usd.reason) : null,
    quoted,
    ...(usd.reason ? { reason: usd.reason } : {}),
  }
}
