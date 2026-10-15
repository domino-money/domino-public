import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import { newPositionHref, poolHref, positionsHref } from '../components/explore/routes'
import { IconChevronDown, IconChevronLeft, IconMarkets, IconPlus, IconSearch } from '../components/icons'
import { PairName, PositionStatus } from '../components/positions/PositionFigures'
import { AutomateEntry, AutomationChip, useListedPosition } from '../components/positions/AutomateEntry'
import { KeyFigures, type KeyUsd } from '../components/positions/KeyFigures'
import { PositionInsights } from '../components/positions/PositionInsights'
import { PositionActivity, useAutomaticAdds } from '../components/positions/PositionActivity'
import { PositionRange, chainCardPrice, preloadPriceChart } from '../components/positions/PositionRange'
import { FeesCard } from '../components/positions/visual/FeesCard'
import { PositionSkeleton } from '../components/positions/visual/PositionSkeleton'
import { usdgSide } from '../components/positions/visual/value'
import { Address } from '../components/read/screens/Address'
import { TokenMarkPair } from '../components/TokenIcon'
import { Button, Chip, Display, EmptyState, KeyValue, KeyValueList, LinkButton, PageShell } from '../components/ui'
import { chainState, freshState, takeWarmState } from '../lib/fees/client'
import { feesStore } from '../lib/fees/spawn'
import { refreshFeeStates, useFeeHistory, useLedgerTraces } from '../lib/fees/useFeeHistory'
import { ledgerClosedAt, ledgerOpenedAt, ledgerOpenedBefore, ledgerPriceObservations, type ActivityMint } from '../lib/chart/positionOpened'
import { readKept } from '../finance/privateCards'
import { KEPT_MAX_AGE_MS } from '../lib/browserCopies'
import { createdHere } from '../lib/create/createProgress'
import { shortDate, shortTime } from '../lib/format/time'
import { CHAIN_ID } from '../lib/read/screens/identity'
import type { RelayAnswer, StatePositionOk, StateResponse } from '../lib/fees/types'
import { warmVault } from '../lib/automationImpact'
import { useAutomation } from '../lib/automationState'
import { useMediaQuery } from '../lib/useMediaQuery'
import { recovering } from '../lib/staleRelease'
import { NATIVE_CURRENCY } from '../lib/read/screens/identity'
import { whenVisibleAfter } from '../lib/read/screens/quietRead'
import { cardPoolUsableForDomino } from '../lib/read/screens/positions'
import type { TokenDisplay } from '../lib/read/types'
import { positionOfState, walletCard, walletState, type CurrencyView } from '../lib/walletCards'
import { useWalletIdentity, walletKey } from '../lib/walletIdentity'
import { keptPosition, parseWalletAnswer, walletChanged, type WalletPosition } from '../lib/walletPositions'
import { notePositionConfirmation } from '../lib/positionEvidence'
import { readGatewayRow } from '../lib/positions/gatewayRow'
import { loadReadSource } from '../lib/read/buildMode'

// V2's own portfolio admits setup. Do not subscribe to the inactive catalogue even with a null owner.
const useLegacyListing: typeof useListedPosition = __DOMINO_V2__ ? () => null : useListedPosition

/**
 * What the owner's actions take (components/positions/PositionActions.tsx, the
 * shared contract), written here so that this screen names nothing of that
 * chunk but its lazy import; the compiler checks the two agree.
 */
interface ActionsProps {
  tokenId: string
  owner: string
  liquidityRaw: string
  unsettledFeesRaw: readonly [string, string] | null
  currencies: readonly [CurrencyView, CurrencyView]
  hooks: string
  onChanged: (block?: bigint) => void
  /** The `/state` pool price, for the dialogs' USD lines (pairs with USDG only). */
  usd?: { usdgIndex: 0 | 1; sqrtPriceX96: bigint; block: number } | null
  /** The page's token marks, beside the dialogs' amounts. */
  tokens?: readonly [TokenDisplay, TokenDisplay] | null
  /** The page's way on (Automate, or the docs on switching a sequence on), shown first unless Turn on or Pause takes its place (2026-09-25). */
  automate?: ReactNode
  /** The position's automation control, beside the liquidity actions. */
  automationSlot?: ReactNode
  /** Collect fees is the primary button (2026-09-27: not for one of Domino's sequences). */
  primary?: boolean
}

// The owner's Collect fees and Close position, in builds that carry the wallet
// session: its own chunk, opened only here, behind the flag. Elsewhere the
// constant is null, nothing is imported, and the page offers no action.
const couldNotLoad = () => ({
  default: (_props: object) => (
    <span role="alert" className="text-caption text-fg-muted">
      Actions couldn’t load. Reload to try again.
    </span>
  ),
})
const PositionActions = __DOMINO_WALLET_SESSION__ ? lazy<ComponentType<ActionsProps>>(recovering(() => import('../components/positions/PositionActions'), couldNotLoad)) : null
/**
 * Changed on purpose (data) 2026-10-02 (Domino V2 integration): Add liquidity, Change range and Withdraw beside Collect
 * fees and Close position, and Domino's approval in Details, from their own chunk (src/v2in/position) in a build with V2
 * only; the chunk asks the gate itself and draws nothing where V2 is off. Its props, written here as ActionsProps is.
 */
interface V2ActionsProps {
  position: WalletPosition
  owner: string
  onChanged: (block?: bigint) => void
}
const V2Actions = __DOMINO_V2__ ? lazy<ComponentType<V2ActionsProps>>(recovering(() => import('../v2in/position/PositionV2Actions'), couldNotLoad)) : null
/**
* 2026-10-02 (the V1 incident of rugged97's spec rev3 §2.13): the fees waiting in this position's vault, with Withdraw to
 * wallet, for the vault's owner: on the page of a position its read names a vault for (on, paused, stopped or closed), and
 * on the page of an NFT that no longer exists, the vault whose root it was. Its own chunk, in wallet builds only; nothing
 * while there is nothing to withdraw, and nothing in place of a chunk that cannot load.
 */
interface ReservesProps {
  owner: string
  placement: 'positions' | 'position'
  vault?: string
  root?: string
}
const FeeReserves = __DOMINO_WALLET_SESSION__ ? lazy<ComponentType<ReservesProps>>(recovering(() => import('../components/positions/FeeReserves'), () => ({ default: () => null }))) : null

// Domino V2 (integration, 2026-10-02): the position's automation (its vault's reserves, Leave automation, the rearm) and
// its Auto-exit (the owner's point 5, 2026-10-06), under the page's cards in every phase, only in a build that carries V2
// (production and development do since 2026-10-05; a build without it has this null, and nothing of it is bundled).
const V2Position = __DOMINO_V2__ ? lazy(recovering(() => import('../v2in/automate/PositionAutomation'), () => ({ default: () => null, PageUsd: () => null }))) : null
/**
 * Added 2026-10-14 (the incident of 2026-10-13, package V1; the owner's decision D3): the page's dollars from the one
 * valuation its list row uses (src/v2in/position/PageUsd.tsx): read-v6's qualified prices, or the pool's own price where
 * one token has one, so ETH / IMD shows the same dollars here as in Your positions (it showed token amounts here: this
 * page valued a pair with USDG only). It draws nothing and hands the figures up; until it does, and where it has none,
 * the page's own rule stands. It travels in the automation's chunk above (which this page always opens, and whose
 * portfolio read it shares), so no chunk and no request is added. Its props, written here as the other chunks' are.
 * `owner` (2026-10-14, review): the NFT's owner, whose portfolio answer the part values a visitor's page with. It is
 * the read this page's Activity already makes (PositionActivity below: the same reader and key), so none is added.
 */
interface V2UsdProps {
  tokenId: string
  position: WalletPosition
  block: number
  owner: string
  brief: boolean
  saved: boolean
  onUsd: (usd: KeyUsd | null) => void
}
const V2Usd = __DOMINO_V2__ ? lazy<ComponentType<V2UsdProps>>(recovering(() => import('../v2in/automate/PositionAutomation').then((m) => ({ default: m.PageUsd })), () => ({ default: () => null }))) : null

/**
 * The page's own chain read: the fees relay's /state read of this NFT, from the chain, at one block. 2026-09-28 (speed
 * wave B, item 18): until it answers, the NFT's row of the wallet's list read a moment ago in this visit, if there is
 * one (lib/walletPositions.ts keptPosition): the same figures, a list's block older.
 */
type Detail =
  | { phase: 'loading' }
  /**
   * `copy` (2026-10-01, item A15): from this browser's copy of the wallet's list, kept at that time (ms). `gateway`
   * (RPC-SPEC P2): from the read gateway while the site's chain routes cannot answer (lib/positions/gatewayRow.ts).
   */
  | { phase: 'ready'; position: WalletPosition; owner: string; block: number; row?: true; copy?: number; gateway?: true }
  | { phase: 'failed'; reason: string }
  /** ownerOf reverts and the id is below PositionManager.nextTokenId: it was minted, and burned. */
  | { phase: 'gone'; block: number }
  /** 2026-10-01 (item D5): no NFT was ever minted with this id (at or above nextTokenId), and this visit made none. */
  | { phase: 'missing'; block: number }

/** The waits before a read that failed only for the moment is asked again, while the page is visible. */
const REASK_MS = [3_000, 12_000, 30_000] as const
/**
 * RPC-SPEC P2: while the page's own read answers `unavailable` (the site's chain routes without their node: no secret
 * yet, or the node away) and nothing is drawn, the read gateway's row of the NFT is asked, at most once this often per
 * NFT; the page's own read goes on at its schedule, and its answer replaces the row.
 */
const GATEWAY_EVERY_MS = 60_000
const gatewayAsked = new Map<string, number>()
/**
 * An NFT the chain says does not exist is asked again after these waits, the skeleton kept, before the page says so:
 * Create position opens a new position's page 3 s after its mint, and the page reads two blocks behind the head (from a
 * public RPC whose nodes could lag one another until 2026-10-01; from the site's state route, whose answer is kept 10 s,
 * since then).
 */
const NOT_FOUND_REASK_MS = [3_000, 8_000, 12_000] as const
/**
 * 2026-10-01 (item D5): an id at most this far past PositionManager.nextTokenId may be a mint the page's read does not show
 * yet (it reads two blocks behind the head, and a node may lag): asked again as above, the skeleton kept. One further past
 * it was never minted, and says so at once.
 */
const FRESH_IDS = 100n
/**
 * After an action, the page is read again at once and once more a moment later: its read is at head − 2, which right after
 * the receipt may not hold the action yet (the relay's 10 s answer cache, which this wait first reached past, is gone
 * since the page reads the chain itself).
 */
const AFTER_ACTION_MS = 11_000
/**
 * The page reads itself again every minute while it is visible (the owner's OK, 2026-09-27): the header's principal,
 * unclaimed fees, price against the range and USD change in place. 2026-09-28 (speed wave B, item 16: the page and its
 * fees card each kept a minute's clock, two reads a minute, and the card read the page's state again on open): the page
 * hands its read to the fees store (feesStore.offer), whose cards start from it, and follows the store's own minute read
 * (feesStore.position); a read that fails keeps the header, and the next minute's is asked as the store asks it. Test
 * builds only when a test asks for it before the page loads (window.__dominoRefresh), so every other suite counts its
 * reads as before.
 */
const REFRESH = !__DOMINO_TEST_HOOKS__ || !!(window as { __dominoRefresh?: boolean }).__dominoRefresh

// 2026-10-03 (the owner's point 10): the Price range chart is a chunk of its own (PositionRange.tsx); asked for as this
// page's code arrives, so it is there before the page's own read and draws at once in its card.
preloadPriceChart()

/** What screens/PositionLab.tsx's `range` spec carries: a position as this page reads one, and whether its pool's history is asked. */
export interface RangeLabSpec {
  position: WalletPosition
  owner: string
  block: number
  /** As this page always does; false: as V2's page for a pool the read service keeps no history for. */
  history?: boolean
  openedAt?: number | null
  /** (2026-10-15, pack 7) A bound on an undated mint (PositionRange's `openedBefore`). */
  openedBefore?: number | null
  closedAt?: number | null
}

/**
 * Test builds only (__DOMINO_TEST_HOOKS__; null in every deployable build, so none carries it): this page's Price range
 * card alone, from a position as the page reads one, for screens/PositionLab.tsx's `range` spec and
 * tests/price-range.browser.test.mjs (2026-10-03, the owner's point 10). It lives in this screen's chunk, which holds
 * every module it draws, so the lab adds nothing else to the bundles (tests/session.bundle.test.mjs).
 */
export const RangeLab = __DOMINO_TEST_HOOKS__
  ? function RangeLab({ spec }: { spec: RangeLabSpec }) {
      const card = useMemo(() => walletCard(spec.position, spec.owner), [spec])
      const price = chainCardPrice(card, { sqrtPriceX96: spec.position.sqrtPriceX96, tick: spec.position.tick, block: spec.block })
      return (
        <div className="dm-pos-grid" data-range-lab="">
          <section className="dm-card dm-pos-card" aria-labelledby="position-range-title">
            <h2 id="position-range-title" className="dm-title">
              Price range
            </h2>
            <PositionRange card={card} price={price} variant="page" history={spec.history !== false} openedAt={spec.openedAt ?? null} openedBefore={spec.openedBefore ?? null} closedAt={spec.closedAt ?? null} />
          </section>
        </div>
      )
    }
  : null

type Ready = Extract<Detail, { phase: 'ready' }>
/** A read position as the page shows it. */
const ready = (position: StatePositionOk, block: number): Ready => ({ phase: 'ready', position: positionOfState(position), owner: position.owner, block })
/** The NFT's row in the wallet's list read a moment ago in this visit, as the page shows it until its own read answers. */
function fromList(tokenId: string): Detail {
  const row = keptPosition(tokenId)
  return row ? { phase: 'ready', position: row.position, owner: row.owner, block: row.block, row: true } : { phase: 'loading' }
}
/**
 * 2026-10-01 (item A15: a reload or a link drew the skeleton, for 12 s or more while the RPC refused, for figures this
 * browser already had): the NFT's row in this browser's copy of the connected wallet's list (Your positions keeps it a
 * day, OwnedPositions.tsx), drawn as a dated copy with no action until the page's own read answers. Read at the copy's
 * own age (lib/browserCopies.ts, I6: a week until 2026-10-01), so the page never shows a copy the list would not.
 */
function fromCopy(tokenId: string, owner: string): Detail | null {
  const kept = readKept(`owned.${CHAIN_ID}.${owner}`, KEPT_MAX_AGE_MS.owned, (data, at) => {
    const answer = parseWalletAnswer(data, owner)
    return answer?.positions.length ? { answer, at } : null
  })
  const position = kept?.answer.positions.find((one) => one.tokenId === tokenId)
  return kept && position ? { phase: 'ready', position, owner, block: kept.answer.block, row: true, copy: kept.at } : null
}
/** The store's newest read of `tokenId` (feesStore.position), followed while the refresh is on. */
function useStoredPosition(tokenId: string): Readonly<{ position: StatePositionOk; block: number }> | null {
  const watch = useCallback((listener: () => void) => feesStore.watch([tokenId], listener), [tokenId])
  return useSyncExternalStore(watch, () => (REFRESH ? feesStore.position(tokenId) : null), () => null)
}
/**
 * 2026-09-28 (speed wave B, item 26): the vault record of a position a sequence holds is read as soon as the page's read
 * names its vault (item 17), beside its chart rather than after it.
 */
function vaultOf(answer: RelayAnswer<StateResponse>, found: StatePositionOk, signal: AbortSignal): void {
  const feature = answer.ok ? answer.value.automation?.find((one) => one.tokenId === found.tokenId) : undefined
  if (answer.ok && feature && 'vault' in feature) warmVault(feature.vault, found.tokenId, [found.poolKey.currency0, found.poolKey.currency1], answer.value.block, signal)
}

/** A token as the actions take it: its address and what the chain said about it. */
const currency = (token: TokenDisplay): CurrencyView => ({ address: token.address, symbol: token.symbol, decimals: token.decimals })

/** The way back to the list. */
function Back() {
  return (
    <a href={positionsHref} className="dm-pos-back">
      <IconChevronLeft size={16} />
      Positions
    </a>
  )
}

/**
 * One position NFT, read from chain, for someone who may know nothing of pools (the owner, 2026-09-27): its pair and
 * state, then its key figures (what it is worth now, the fees ready to collect, Your APR and the price against its
 * range), Fees earned, Price range, Activity and, closed until opened, the technical Details. The connected owner,
 * on any network, also gets Collect fees and Close position in the title row; anyone else reads the same page with
 * no action on it. Every figure but the fees history's is from one chain read, at its block (the figures' title).
 */
/** Why a ledger cannot measure Fees earned, in Details' own words (lib/fees/types.ts LedgerWhy). */
const WHY_WORDS: Readonly<Record<string, string>> = {
  before_floor: 'the position was opened before Domino’s release',
  manual: 'an add or a withdrawal settled fees together with the tokens it moved',
  shared: 'a collect’s transaction did more than collect this position',
  native: 'a collect paid out ETH, which leaves no log',
  liquidity: 'a change of this position was not found',
  unseen: 'something settled this position that Domino’s reads cannot see',
  too_many: 'it has more settlements or owners than one ledger keeps',
  reading: 'it is still being read',
}

/**
 * Where the fees history on this page comes from, for the technical Details (item A13 moved blocks and exact times here,
 * off the main screen). Changed on purpose 2026-10-02 (RPC-SPEC §11.4): the position's own ledger of settlements, and how
 * its chart's points were measured.
 */
function HistorySource({ tokenId }: { tokenId: string }) {
  const fees = useFeeHistory(tokenId)
  // 2026-10-02 (review of the chart's tabs, finding 1): the ledger requests this visit made and how the last ended, as data
  // attributes only (for a tester's devtools and the browser suites; the line's words stay).
  const trace = useLedgerTraces([tokenId]).get(tokenId)
  let text: string
  if (fees.phase === 'verified') {
    text = `Every settlement of this position from its own events, through block ${fees.history.through}, and the fees ready to collect at block ${fees.state.block}. Measured at each compound or collect and when this browser read it; the line between points is a guide, not a measurement.`
  } else if (fees.phase === 'cached') text = `A copy saved in this browser, through block ${fees.state.block} (${shortDate(fees.state.timestamp)} ${shortTime(fees.state.timestamp)})`
  else if (fees.phase === 'unclaimed-only' && fees.reason === 'not_exact') text = `Fees earned is not measured: ${WHY_WORDS[fees.why ?? 'unseen'] ?? WHY_WORDS.unseen}. Fees ready to collect is exact.`
  else if (fees.phase === 'unclaimed-only' || fees.phase === 'unavailable') text = `Not read (${fees.reason.replace(/_/g, ' ')})`
  else text = 'Reading…'
  return (
    <KeyValue label="Fees history">
      <span data-history-source={fees.phase === 'verified' ? 'ledger' : fees.phase} data-history-why={fees.phase === 'unclaimed-only' ? fees.why : undefined} data-ledger-asks={trace?.asks ?? 0} data-ledger-last={trace?.last ?? undefined}>
        {text}
      </span>
    </KeyValue>
  )
}

function LiveDetail({ wallet, owner, block, cached, copy, gateway = false, changes, onChanged }: { wallet: WalletPosition; owner: string; block: number; cached: boolean; copy?: number; gateway?: boolean; changes: number; onChanged: (block?: bigint) => void }) {
  const [automationToolbar, setAutomationToolbar] = useState<HTMLSpanElement | null>(null)
  const card = useMemo(() => walletCard(wallet, owner), [wallet, owner])
  // The same read values the amounts for a pair with USDG (§6.2): one price, one block.
  const state = useMemo(() => walletState(wallet, block, owner), [wallet, block, owner])
  const price = chainCardPrice(card, { sqrtPriceX96: wallet.sqrtPriceX96, tick: wallet.tick, block })
  const [base, quote] = card.currencies
  const token = base.address === NATIVE_CURRENCY ? quote.address : base.address
  const { tickLower, tickUpper } = card.range
  // Ownership is independent of the wallet's selected network. An intentional action switches to this position's
  // network before preparing its review, and checks the owner again before anything is sent.
  const identity = useWalletIdentity()
  const mine = identity.kind === 'connected' && identity.address.toLowerCase() === card.owner.address
  // Read again after each of the owner's actions (`changes`), and never offered for a position this read shows closed:
  // after a Close, Automate and the Plain position pill go at once (2026-09-25, audit of 754014c: the wallet's list, read
  // before the Close, still offered them until the page was opened again).
  const listed = useLegacyListing(card.tokenId, mine ? card.owner.address : null, changes)
  const automatable = listed === true && card.hasLiquidity
  const usdgIndex = state ? usdgSide(state.currencies) : null
  // The one valuation's figures for the two money tiles (V2Usd above), in a build with V2; null: the page's own rule.
  const [pageUsd, setPageUsd] = useState<KeyUsd | null>(null)
  const phone = useMediaQuery('(max-width: 767px)')
  const automation = useAutomation(card.tokenId)
  // What the automation put back, from its vault's own record: the only rows of Activity that name it (2026-09-27).
  const automatic = useAutomaticAdds(card.tokenId, automation)
  const [indexedMint, setIndexedMint] = useState<ActivityMint | null>(null)
  const onMint = useCallback((mint: ActivityMint) => {
    if (mint.tokenId !== card.tokenId) return
    setIndexedMint((previous) => previous?.tokenId === mint.tokenId && previous.block === mint.block && previous.tx === mint.tx && previous.timestamp === mint.timestamp ? previous : mint)
    feesStore.offerMint(mint)
  }, [card.tokenId])
  const feeHistory = useFeeHistory(card.tokenId)
  const openedAt = ledgerOpenedAt(feeHistory) ?? (indexedMint?.tokenId === card.tokenId && indexedMint.block <= block ? indexedMint.timestamp : null)
  // (2026-10-15, pack 7): minted before Domino's release, the ledger has no mint, only a bound on it (never an opening time).
  const openedBefore = openedAt === null ? ledgerOpenedBefore(feeHistory) : null
  // The way on: Automate, or the docs on switching a sequence on. The owner's actions show it first, unless a
  // sequence's Turn on or Pause takes its place (2026-09-25), and it stands alone while their chunk loads.
  const entry = __DOMINO_V2__ ? null : <AutomateEntry tokenId={card.tokenId} open={automatable} variant="action" />
  return (
    <div data-position-detail="" data-position-workspace-page="" data-position-id={card.tokenId} data-snapshot={block} data-position-read={copy !== undefined ? 'saved' : gateway ? 'gateway' : 'chain'}>
      <div className="dm-pos-title">
        <div className="dm-pos-name">
          <TokenMarkPair base={base} quote={quote} size={phone ? 36 : 44} ring="var(--bg)" />
          <div className="min-w-0">
            <Display as="h1" className="dm-display-h1 dm-pos-pair">
              <PairName card={card} />
            </Display>
            {/* A copy kept by this browser (item A15): dated, and no action is offered on it. */}
            {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): the marker alone; a screen reader heard "Saved copy from …". */}
            {copy !== undefined && <span hidden data-position-copy="" />}
            <div className="dm-pos-chips">
              {/* "fee" after the pool's fee tier (2026-09-27): beside Your APR, a bare percentage would read as a yield.
                  Changed on purpose 2026-10-01 (audit E5): the NFT's number left the chip for Details, the tab's title
                  and a screen reader, as on the Positions list. */}
              <Chip>
                <span>
                  Uniswap · <span data-fee="">{card.fee}</span> fee
                </span>
              </Chip>
              <span className="sr-only">
                Position #<span translate="no">{card.tokenId}</span>
              </span>
              <PositionStatus card={card} />
              {!__DOMINO_V2__ && <AutomationChip tokenId={card.tokenId} listed={card.hasLiquidity ? listed : false} />}
            </div>
          </div>
        </div>
        {/* (2026-10-15, pack 7 review): every action is hidden here, so the line saying why stays (a gate the person
            meets); only its "We’ll keep trying automatically." half left with the status notices. */}
        {mine && (copy !== undefined || gateway) && (
          <p className="max-w-md text-body text-fg-muted" role="status" data-position-actions-waiting="">
            Actions are temporarily unavailable while we refresh this position’s data.
          </p>
        )}
        {/* No action on a row from the read gateway (RPC-SPEC P2): the page's own read offers them once it answers. */}
        {PositionActions && mine && copy === undefined && !gateway && (
          <div className="dm-pos-actions" data-position-actions="">
            {/* While the actions' chunk loads, the row already holds their place (2026-10-01, E1): the way on, and the two
                buttons' room, unseen, so the figures below never move when they arrive (they slid down under the finger,
                about 0.3 s after the figures). */}
            <Suspense
              fallback={
                <>
                  {entry}
                  <div className="flex flex-wrap items-center gap-2" aria-hidden="true" style={{ visibility: 'hidden' }} data-position-actions-pending="">
                    <Button type="button" variant="outline" tabIndex={-1}>
                      Collect fees
                    </Button>
                    {card.hasLiquidity && (
                      <Button type="button" variant="danger" tabIndex={-1}>
                        Close position
                      </Button>
                    )}
                  </div>
                </>
              }
            >
              <PositionActions
                tokenId={card.tokenId}
                owner={card.owner.address}
                liquidityRaw={card.liquidityRaw}
                unsettledFeesRaw={wallet.unclaimedFees}
                currencies={[currency(base), currency(quote)]}
                hooks={card.hooks}
                onChanged={onChanged}
                usd={state && usdgIndex !== null ? { usdgIndex, sqrtPriceX96: state.sqrtPriceX96, block: state.block } : null}
                tokens={[base, quote]}
                automate={entry}
                automationSlot={__DOMINO_V2__ ? <span ref={setAutomationToolbar} className="dm-position-automation-slot" data-position-automation-slot="" /> : null}
                primary={!(automation.phase === 'ready' && 'paused' in automation.state)}
              />
            </Suspense>
          </div>
        )}
        {/* V2 actions join the same visible action bar while retaining their own gates and lazy loading. */}
        {__DOMINO_V2__ && V2Actions && PositionActions && mine && copy === undefined && !gateway && (
          <Suspense fallback={null}>
            <V2Actions position={wallet} owner={card.owner.address} onChanged={onChanged} />
          </Suspense>
        )}
      </div>

      {V2Position && <Suspense fallback={null}><V2Position tokenId={card.tokenId} position={wallet} holder={owner} priceContext={{ block, saved: cached || copy !== undefined || gateway }} toolbar={automationToolbar} onChanged={() => onChanged()} /></Suspense>}
      {V2Usd && <Suspense fallback={null}><V2Usd tokenId={card.tokenId} position={wallet} block={block} owner={owner} brief={cached && copy === undefined && !gateway} saved={cached || copy !== undefined || gateway} onUsd={setPageUsd} /></Suspense>}
      {/* Changed on purpose 2026-10-14 (package V1, decision D3): any pair may be valued now (by the one valuation), so
          the state goes down whenever there is a figure to split, not for a pair with USDG only. */}
      <KeyFigures card={card} state={state && (usdgIndex !== null || pageUsd !== null) ? state : null} price={price} block={block} cached={cached || copy !== undefined || gateway} workspace usd={pageUsd} />

      {/* The fees its vault collected and has not reinvested, while any is above zero (2026-10-02): the owner's, from its own
          read through the wallet, so never on a copy or the gateway's row. */}
      {FeeReserves && mine && copy === undefined && !gateway && automation.phase === 'ready' && 'vault' in automation.state && (
        <Suspense fallback={null}>
          <FeeReserves owner={card.owner.address} vault={automation.state.vault} placement="position" />
        </Suspense>
      )}

      {/* The fees card's own settlements move to Activity, after Price range (2026-09-27). */}
      {/* The quote of a pair without USDG is the app's one way round's (visual/value.ts basisOf, 2026-09-28). */}
      <PositionInsights
        fees={<FeesCard source={{ tokenId: card.tokenId }} bandPresent tokens={[base, quote]} activity={false} workspace />}
        range={<section className="dm-pos-card dm-position-range-panel" aria-label="Price range history">
          {/* The range, its ends and the price now (the page's own read). Changed on purpose 2026-10-02 (RPC-SPEC §11.4):
              no line of the pool's past prices, which came from the fees replay's reads of the pool's history. Changed on
              purpose 2026-10-03 (the owner's point 10: "it doesn't show the history"): the line is back, from the read
              service's stored price history of the pool (read-v3 `history`, the last 7 days), never from a node. */}
          <PositionRange card={card} price={price} variant="page" history openedAt={openedAt} openedBefore={openedBefore} closedAt={ledgerClosedAt(feeHistory)} observations={ledgerPriceObservations(feeHistory)} />
        </section>}
      />
      <div className="dm-pos-grid">
        <PositionActivity tokenId={card.tokenId} automatic={automatic} owner={card.owner.address} onMint={onMint} />

        {/* Everything technical, at the end and closed until asked for (the owner, 2026-09-27): the main page stays practical. */}
        <details className="dm-card dm-pos-details" data-position-details="">
          <summary className="dm-pos-details-head">
            <h2 className="dm-title">Details</h2>
            <span className="dm-pos-details-hint">Contract data for this position</span>
            <IconChevronDown size={16} />
          </summary>
          <KeyValueList className="dm-pos-facts">
            <KeyValue label="NFT id">
              <Address value={card.tokenId} />
            </KeyValue>
            <KeyValue label="Owner">
              <span data-owner="" title={`The NFT’s owner at block ${block}, public data.`}>
                <Address value={card.owner.address} />
              </span>
            </KeyValue>
            <KeyValue label="Pool id">
              <Address value={card.poolId} />
            </KeyValue>
            <KeyValue label="Fee tier">{card.fee}</KeyValue>
            <KeyValue label="Tick spacing">
              <span className="tnum">{card.tickSpacing}</span>
            </KeyValue>
            <KeyValue label="Ticks">
              <span className="tnum" data-ticks="">
                {tickLower} to {tickUpper}
              </span>
            </KeyValue>
            <KeyValue label="Liquidity">
              <span className="dm-hex" data-liquidity="" title={card.liquidityRaw}>
                {card.liquidityRaw}
              </span>
            </KeyValue>
            <KeyValue label="Hooks">{card.hooks === NATIVE_CURRENCY ? 'None' : <Address value={card.hooks} />}</KeyValue>
            <KeyValue label="Position manager">
              <Address value={card.positionManager} />
            </KeyValue>
            {/* The basis of a dollar figure that is an estimate or is not current (2026-10-14, decision D3: disclosed). */}
            {pageUsd?.detail && (
              <KeyValue label="USD valuation">
                <span data-usd-detail="">{pageUsd.detail}</span>
              </KeyValue>
            )}
            <HistorySource tokenId={card.tokenId} />
          </KeyValueList>
          <div className="dm-pos-links">
            <LinkButton href={poolHref(card.poolId, token)} variant="outline" size="sm">
              <IconMarkets />
              Pool
            </LinkButton>
            {/* Only into a pool Domino can open a position in: no hooks, a fixed fee (New position refuses any other). */}
            {cardPoolUsableForDomino(card) && (
              <LinkButton href={newPositionHref(card.poolId, token)} variant="outline" size="sm">
                <IconPlus />
                Add to this pool
              </LinkButton>
            )}
          </div>
        </details>
      </div>
    </div>
  )
}

/**
 * `#/positions/<id>`: one position NFT's own page, read from chain by the fees
 * relay's /state read (the NFT's pool, range, liquidity, owner, the pool's
 * price and its unclaimed fees at one block). From 2026-09-25 the page ran it
 * itself against the public RPC; since 2026-10-01 (RPC-SPEC D2, the owner's
 * rule: nothing is read from a public RPC) it asks the site's own state route
 * (lib/fees/client.ts chainState), and while that cannot answer, the read
 * gateway's row of the NFT stands in (lib/positions/gatewayRow.ts). A read that failed only for
 * the moment is asked again on its own while the page is visible; the owner's
 * actions ask the page to read again once they are included on chain; and
 * every minute the fees store's read of it moves its header on (REFRESH).
 * 2026-09-28 (speed wave B, item 24): its first read may be on its way before
 * this chunk is in (Positions starts it, lib/fees/client.ts warmState).
 */
export default function PositionDetail({ tokenId }: { tokenId: string }) {
  const [detail, setDetail] = useState<Detail>(() => fromList(tokenId))
  const [asked, setAsked] = useState(0)
  const stored = useStoredPosition(tokenId)
  // 2026-10-01 (item A15): while nothing is drawn, the row of this browser's copy of the connected wallet's list. Taken as
  // the page renders, as the store's answer is below (integration pass 2a: set from an effect, it drew the skeleton for
  // one paint first, and the lint's React compiler rule refuses a synchronous setState in an effect).
  const identity = useWalletIdentity()
  const connected = identity.kind === 'connected' ? identity.address.toLowerCase() : null
  const kept = useMemo(() => (detail.phase === 'loading' && connected ? fromCopy(tokenId, connected) : null), [detail.phase, connected, tokenId])
  if (kept && detail.phase === 'loading') setDetail(kept)
  // A successful store read can also recover the first read's failure. It must
  // name this NFT, never replace a confirmed absence, and never move a ready
  // header back to an older block. The store keeps reading after our bounded
  // initial retries end, so it is the same source of recovery as of refreshes.
  const current = useMemo(() => {
    if (!stored || stored.position.tokenId !== tokenId || detail.phase === 'gone') return detail
    // A row from the read gateway (RPC-SPEC P2) gives way to the chain routes' answer whatever its block.
    if (detail.phase === 'ready' && !detail.gateway && stored.block <= detail.block) return detail
    return ready(stored.position, stored.block)
  }, [detail, stored, tokenId])
  // Keep the last successful store answer in the header too. If a later
  // read cannot find the NFT, the store may clear its copy; that must not
  // roll the visible figures back to the page's first, older answer.
  if (current !== detail && current.phase === 'ready') setDetail(current)
  // What is on screen, for the read gateway's row (RPC-SPEC P2), which is never asked over a row or an answer.
  const drawn = useRef<Detail>(current)
  useEffect(() => {
    drawn.current = current
  }, [current])
  useEffect(() => {
    const controller = new AbortController()
    let attempts = 0
    let empties = 0
    // Whether the page shows a position: it does once a read succeeded, and it did before an action asked again, since
    // only a position on screen offers the actions (`asked`), and the page never leaves 'ready' once there.
    let shown = asked > 0
    let cancel: (() => void) | null = null
    const askAfter = (wait: number) => {
      // One wait at a time: a refresh set after the read an action asked for replaces the one set before it.
      cancel?.()
      cancel = whenVisibleAfter(wait, () => {
        cancel = null
        ask()
      })
    }
    let first = asked === 0
    // RPC-SPEC P2: the read gateway's row, while the page's own read answers `unavailable` and nothing is drawn.
    const fromGateway = () => {
      const last = gatewayAsked.get(tokenId)
      if (drawn.current.phase === 'ready' || (last !== undefined && Date.now() - last < GATEWAY_EVERY_MS)) return
      gatewayAsked.set(tokenId, Date.now())
      void loadReadSource()
        ?.then((source) => (controller.signal.aborted ? null : readGatewayRow(source, tokenId, controller.signal)))
        .then((got) => {
          if (!got || controller.signal.aborted) return
          setDetail((before) => (before.phase === 'ready' || before.phase === 'gone' || before.phase === 'missing' ? before : { phase: 'ready', position: got.row, owner: got.owner, block: got.block, row: true, gateway: true }))
        })
        .catch(() => undefined)
    }
    const ask = () => {
      const read = (first && takeWarmState(tokenId)) || chainState([tokenId], controller.signal)
      first = false
      void read.then((answer) => {
        if (controller.signal.aborted) return
        // The fees card starts from this read, and the store's minute read goes on from it (item 16).
        feesStore.offer(answer)
        const found = answer.ok ? answer.value.positions.find((p) => p.tokenId === tokenId) : undefined
        if (answer.ok && found?.ok) {
          const block = answer.value.block
          // An answer from an older block than the one on screen (the relay's cache, right after an action) changes nothing;
          // the list's row gives way to the page's own read whatever its block (its read is at head − 2, the list's at the head).
          setDetail((before) => (before.phase === 'ready' && !before.row && before.block > block ? before : ready(found, block)))
          vaultOf(answer, found, controller.signal)
          attempts = empties = 0
          shown = true
          return
        }
        // A position on screen stays there through a read that fails: the store's next minute read is the next ask.
        if (REFRESH && shown) return
        if (answer.ok && found && !found.ok && found.reason === 'not_found') {
          const block = answer.value.block
          // 2026-10-01 (item D5): an id below nextTokenId was minted: not found now, it was burned, said at once. One at or
          // above it was not minted at that block: one this visit's New position made, or one just past it (FRESH_IDS: a
          // mint a read from a node still behind it does not show) is asked again a few times, the skeleton kept; any
          // other was never minted, and says so at once.
          const next = answer.value.nextTokenId === undefined ? null : BigInt(answer.value.nextTokenId)
          if (next !== null && BigInt(tokenId) < next) {
            setDetail((before) => (before.phase === 'ready' ? before : { phase: 'gone', block }))
            return
          }
          const made = createdHere(tokenId)
          if ((next === null || made || BigInt(tokenId) - next < FRESH_IDS) && empties < NOT_FOUND_REASK_MS.length) {
            // 2026-10-01 (the RPC switch's integration): asked fresh, so the route takes no answer it kept from before the
            // mint (it keeps a state 10 s; the page read the chain itself, uncached, until the switch).
            freshState([tokenId])
            askAfter(NOT_FOUND_REASK_MS[empties])
            empties += 1
            return
          }
          setDetail((before) => (before.phase === 'ready' ? before : next !== null && !made ? { phase: 'missing', block } : { phase: 'gone', block }))
          return
        }
        const reason = !answer.ok ? answer.failure : found && !found.ok ? found.reason : 'invalid_reply'
        // A position already on screen stays there, from its own block, when a later read fails.
        setDetail((before) => (before.phase === 'ready' ? before : { phase: 'failed', reason }))
        if (!answer.ok && answer.failure === 'unavailable') fromGateway()
        const passing = reason === 'unavailable' || reason === 'rate_limited' || reason === 'rpc_unavailable'
        if (!passing || attempts >= REASK_MS.length) return
        const wait = Math.max(REASK_MS[attempts], answer.ok ? 0 : answer.retryAfterMs)
        attempts += 1
        askAfter(wait)
      })
    }
    ask()
    // After an action a read at head − 2 may still be from before it: once more a moment later.
    const again = asked > 0 ? whenVisibleAfter(AFTER_ACTION_MS, ask) : null
    return () => {
      controller.abort()
      cancel?.()
      again?.()
    }
  }, [tokenId, asked])

  let body
  if (current.phase === 'loading') {
    body = (
      <div data-position-loading="" aria-busy="true">
        <p role="status" className="sr-only">
          Reading position {tokenId}…
        </p>
        <PositionSkeleton fees={<FeesCard source={{ tokenId }} bandPresent={false} standalone />} />
      </div>
    )
  } else if (current.phase === 'failed') {
    body = (
      <>
        {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): its title alone; it said "Its details could not be read just now.", and in its title "… They are asked again on their own." */}
        <div className="dm-pos-empty" data-position-reason={current.reason}>
          <EmptyState icon={<IconSearch />} title={`Position #${tokenId}`} plate data-empty="position-unread" />
        </div>
        {/* The fees card reads this NFT from public chain data on its own (§12.4). */}
        <FeesCard source={{ tokenId }} bandPresent={false} standalone />
      </>
    )
  } else if (current.phase === 'gone') {
    body = (
      <>
        <EmptyState
          icon={<IconSearch />}
          title="This position NFT no longer exists"
          body={`NFT #${tokenId} was not found at block ${current.block}.`}
          plate
          className="dm-pos-empty"
          action={
            <LinkButton href={positionsHref} variant="outline" size="sm">
              Positions
            </LinkButton>
          }
          data-empty="position-gone"
        />
        {/* A vault's root that was burned keeps the fees its automation collected (2026-10-02): its owner withdraws them here too. */}
        {FeeReserves && connected && walletKey(identity) !== null && (
          <Suspense fallback={null}>
            <FeeReserves owner={connected} root={tokenId} placement="position" />
          </Suspense>
        )}
      </>
    )
  } else if (current.phase === 'missing') {
    body = (
      <EmptyState
        icon={<IconSearch />}
        title={`No position #${tokenId} was found`}
        body="Robinhood Chain has no position with this number. Check the link."
        plate
        className="dm-pos-empty"
        action={
          <LinkButton href={positionsHref} variant="outline" size="sm">
            Positions
          </LinkButton>
        }
        data-empty="position-missing"
      />
    )
  } else if (current.phase === 'ready') {
    body = (
      <LiveDetail
        wallet={current.position}
        owner={current.owner}
        block={current.block}
        cached={current.row === true}
        copy={current.copy}
        gateway={current.gateway === true}
        changes={asked}
        onChanged={(included) => {
          setAsked((n) => n + 1)
          // The list kept for this visit is from before the action (item 18); the fees card reads its own state at once too.
          // 2026-10-02 (review findings 8 and 15): and the wallet's next read asks the route fresh, wherever it is asked
          // (Positions after this page), so no answer the edge kept from before the action is drawn. RPC fix round 2: until
          // an answer is at or past the block the action was included in (a node behind its receipt answers from before it).
          walletChanged(included)
          notePositionConfirmation({ chainId: 4663, wallet: current.owner, tokenIds: [tokenId], block: included })
          refreshFeeStates([tokenId], included === undefined ? undefined : Number(included))
        }}
      />
    )
  }

  return (
    <PageShell>
      <Back />
      {V2Position ? (
        <>
          {current.phase !== 'ready' && <Suspense fallback={null}><V2Position tokenId={tokenId} position={null} holder={null} /></Suspense>}
          {body}
        </>
      ) : (
        body
      )}
    </PageShell>
  )
}
