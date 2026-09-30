import { lazy, Suspense, useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import { newPositionHref, poolHref, positionsHref } from '../components/explore/routes'
import { IconChevronDown, IconChevronLeft, IconMarkets, IconPlus, IconSearch } from '../components/icons'
import { PairName, PositionStatus } from '../components/positions/PositionFigures'
import { AutomateEntry, AutomationChip, useListedPosition } from '../components/positions/AutomateEntry'
import { KeyFigures } from '../components/positions/KeyFigures'
import { PositionActivity, useAutomaticAdds } from '../components/positions/PositionActivity'
import { PositionRange, chainCardPrice } from '../components/positions/PositionRange'
import { FeesCard } from '../components/positions/visual/FeesCard'
import { PositionSkeleton } from '../components/positions/visual/PositionSkeleton'
import { PriceVsRange, usePriceSeries } from '../components/positions/visual/PriceVsRange'
import { usdgSide } from '../components/positions/visual/value'
import { TokenLabel } from '../components/read/TokenLabel'
import { Address } from '../components/read/screens/Address'
import { TokenMarkPair } from '../components/TokenIcon'
import { Chip, Display, EmptyState, KeyValue, KeyValueList, LinkButton, PageShell } from '../components/ui'
import { chainState, takeWarmState } from '../lib/fees/client'
import { feesStore } from '../lib/fees/spawn'
import { refreshFeeStates } from '../lib/fees/useFeeHistory'
import type { RelayAnswer, StatePositionOk, StateResponse } from '../lib/fees/types'
import { warmVault } from '../lib/automationImpact'
import { useAutomation } from '../lib/automationState'
import { useMediaQuery } from '../lib/useMediaQuery'
import { NATIVE_CURRENCY } from '../lib/read/screens/identity'
import { whenVisibleAfter } from '../lib/read/screens/quietRead'
import { cardPoolUsableForDomino } from '../lib/read/screens/positions'
import type { TokenDisplay } from '../lib/read/types'
import { positionOfState, walletCard, walletState, type CurrencyView } from '../lib/walletCards'
import { useWalletIdentity, walletKey } from '../lib/walletIdentity'
import { forgetWallet, keptPosition, type WalletPosition } from '../lib/walletPositions'

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
  onChanged: () => void
  /** The `/state` pool price, for the dialogs' USD lines (pairs with USDG only). */
  usd?: { usdgIndex: 0 | 1; sqrtPriceX96: bigint; block: number } | null
  /** The page's token marks, beside the dialogs' amounts. */
  tokens?: readonly [TokenDisplay, TokenDisplay] | null
  /** The page's way on (Automate, or the docs on switching a sequence on), shown first unless Turn on or Pause takes its place (2026-09-25). */
  automate?: ReactNode
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
const PositionActions = __DOMINO_WALLET_SESSION__ ? lazy<ComponentType<ActionsProps>>(() => import('../components/positions/PositionActions').catch(couldNotLoad)) : null

/**
 * The page's own chain read: the fees relay's /state read of this NFT, from the chain, at one block. 2026-09-28 (speed
 * wave B, item 18): until it answers, the NFT's row of the wallet's list read a moment ago in this visit, if there is
 * one (lib/walletPositions.ts keptPosition): the same figures, a list's block older.
 */
type Detail =
  | { phase: 'loading' }
  | { phase: 'ready'; position: WalletPosition; owner: string; block: number; row?: true }
  | { phase: 'failed'; reason: string }
  /** ownerOf reverts: never minted, or burned. */
  | { phase: 'gone'; block: number }

/** The waits before a read that failed only for the moment is asked again, while the page is visible. */
const REASK_MS = [3_000, 12_000, 30_000] as const
/**
 * An NFT the chain says does not exist is asked again after these waits, the skeleton kept, before the page says so:
 * Create position opens a new position's page 3 s after its mint, and the page reads two blocks behind the head, from a
 * public RPC whose nodes may lag one another (the relay's 10 s answer cache these waits once reached past is gone).
 */
const NOT_FOUND_REASK_MS = [3_000, 8_000, 12_000] as const
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

type Ready = Extract<Detail, { phase: 'ready' }>
/** A read position as the page shows it. */
const ready = (position: StatePositionOk, block: number): Ready => ({ phase: 'ready', position: positionOfState(position), owner: position.owner, block })
/** The NFT's row in the wallet's list read a moment ago in this visit, as the page shows it until its own read answers. */
function fromList(tokenId: string): Detail {
  const row = keptPosition(tokenId)
  return row ? { phase: 'ready', position: row.position, owner: row.owner, block: row.block, row: true } : { phase: 'loading' }
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
function vaultOf(answer: RelayAnswer<StateResponse>, found: StatePositionOk): void {
  const feature = answer.ok ? answer.value.automation?.find((one) => one.tokenId === found.tokenId) : undefined
  if (answer.ok && feature && 'vault' in feature) warmVault(feature.vault, found.tokenId, [found.poolKey.currency0, found.poolKey.currency1], answer.value.block)
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
 * range), Fees earned, Price range, Activity and, closed until opened, the technical Details. The owner, connected on
 * Robinhood Chain, also gets Collect fees and Close position in the title row; anyone else reads the same page with
 * no action on it. Every figure but the fees history's is from one chain read, at its block (the figures' title).
 */
function LiveDetail({ wallet, owner, block, cached, changes, onChanged }: { wallet: WalletPosition; owner: string; block: number; cached: boolean; changes: number; onChanged: () => void }) {
  const card = useMemo(() => walletCard(wallet, owner), [wallet, owner])
  // The same read values the amounts for a pair with USDG (§6.2): one price, one block.
  const state = useMemo(() => walletState(wallet, block, owner), [wallet, block, owner])
  const price = chainCardPrice(card, { sqrtPriceX96: wallet.sqrtPriceX96, tick: wallet.tick, block })
  const [base, quote] = card.currencies
  const token = base.address === NATIVE_CURRENCY ? quote.address : base.address
  const { tickLower, tickUpper } = card.range
  // The owner's actions, chunk and all, only for the NFT's owner at the read's block, connected on Robinhood Chain:
  // any other visitor downloads nothing of them. PositionActions checks the owner again on chain before anything is sent.
  const identity = useWalletIdentity()
  const mine = walletKey(identity) !== null && identity.kind === 'connected' && identity.address.toLowerCase() === card.owner.address
  // Read again after each of the owner's actions (`changes`), and never offered for a position this read shows closed:
  // after a Close, Automate and the Plain position pill go at once (2026-09-25, audit of 754014c: the wallet's list, read
  // before the Close, still offered them until the page was opened again).
  const listed = useListedPosition(card.tokenId, mine ? card.owner.address : null, changes)
  const automatable = listed === true && card.hasLiquidity
  const usdgIndex = state ? usdgSide(state.currencies) : null
  const series = usePriceSeries(card.tokenId)
  const phone = useMediaQuery('(max-width: 767px)')
  const automation = useAutomation(card.tokenId)
  // What the automation put back, from its vault's own record: the only rows of Activity that name it (2026-09-27).
  const automatic = useAutomaticAdds(card.tokenId, automation)
  // The way on: Automate, or the docs on switching a sequence on. The owner's actions show it first, unless a
  // sequence's Turn on or Pause takes its place (2026-09-25), and it stands alone while their chunk loads.
  const entry = <AutomateEntry tokenId={card.tokenId} open={automatable} variant="action" />
  return (
    <div data-position-detail="" data-position-id={card.tokenId} data-snapshot={block}>
      <div className="dm-pos-title">
        <div className="dm-pos-name">
          <TokenMarkPair base={base} quote={quote} size={phone ? 36 : 44} ring="var(--bg)" />
          <div className="min-w-0">
            <Display as="h1" className="dm-display-h1 dm-pos-pair">
              <PairName card={card} />
            </Display>
            <div className="dm-pos-chips">
              {/* "fee" after the pool's fee tier (2026-09-27): beside Your APR, a bare percentage would read as a yield. */}
              <Chip>
                <span>
                  Uniswap · <span data-fee="">{card.fee}</span> fee · #<span translate="no">{card.tokenId}</span>
                </span>
              </Chip>
              <PositionStatus card={card} />
              <AutomationChip tokenId={card.tokenId} listed={card.hasLiquidity ? listed : false} />
            </div>
          </div>
        </div>
        {PositionActions && mine && (
          <div className="dm-pos-actions" data-position-actions="">
            <Suspense fallback={entry}>
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
                primary={!(automation.phase === 'ready' && 'paused' in automation.state)}
              />
            </Suspense>
          </div>
        )}
      </div>

      <KeyFigures card={card} state={state && usdgIndex !== null ? state : null} price={price} block={block} cached={cached} />

      {/* The fees card's own settlements move to Activity, after Price range (2026-09-27). */}
      {/* The quote of a pair without USDG is the app's one way round's (visual/value.ts basisOf, 2026-09-28). */}
      <FeesCard kind="plain" source={{ tokenId: card.tokenId }} bandPresent tokens={[base, quote]} activity={false} />

      <div className="dm-pos-grid" data-has-price-chart={series ? '' : undefined}>
        <section className="dm-card dm-pos-card" aria-labelledby="position-range-title">
          <h2 id="position-range-title" className="dm-title">
            Price range
          </h2>
          <PositionRange
            card={card}
            price={price}
            variant="page"
            chart={
              series && (
                <div className="dm-pos-chart">
                  <PriceVsRange
                    series={series}
                    unit={
                      <>
                        <TokenLabel token={quote} /> per <TokenLabel token={base} />
                      </>
                    }
                  />
                </div>
              )
            }
          />
        </section>

        <PositionActivity tokenId={card.tokenId} automatic={automatic} />

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
 * price and its unclaimed fees at one block), which the page runs itself
 * against the public RPC since 2026-09-25, so it opens whether or not the read
 * service or the site's routes are up. A read that failed only for
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
  // A successful store read can also recover the first read's failure. It must
  // name this NFT, never replace a confirmed absence, and never move a ready
  // header back to an older block. The store keeps reading after our bounded
  // initial retries end, so it is the same source of recovery as of refreshes.
  const current = useMemo(() => {
    if (!stored || stored.position.tokenId !== tokenId || detail.phase === 'gone') return detail
    if (detail.phase === 'ready' && stored.block <= detail.block) return detail
    return ready(stored.position, stored.block)
  }, [detail, stored, tokenId])
  // Keep the last successful store answer in the header too. If a later
  // read cannot find the NFT, the store may clear its copy; that must not
  // roll the visible figures back to the page's first, older answer.
  if (current !== detail && current.phase === 'ready') setDetail(current)
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
          vaultOf(answer, found)
          attempts = empties = 0
          shown = true
          return
        }
        // A position on screen stays there through a read that fails: the store's next minute read is the next ask.
        if (REFRESH && shown) return
        if (answer.ok && found && !found.ok && found.reason === 'not_found') {
          // Not there yet, perhaps: asked again a few times, the skeleton (or the position already shown) kept.
          if (empties < NOT_FOUND_REASK_MS.length) {
            askAfter(NOT_FOUND_REASK_MS[empties])
            empties += 1
            return
          }
          const block = answer.value.block
          setDetail((before) => (before.phase === 'ready' ? before : { phase: 'gone', block }))
          return
        }
        const reason = !answer.ok ? answer.failure : found && !found.ok ? found.reason : 'invalid_reply'
        // A position already on screen stays there, from its own block, when a later read fails.
        setDetail((before) => (before.phase === 'ready' ? before : { phase: 'failed', reason }))
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
        <PositionSkeleton fees={<FeesCard kind="plain" source={{ tokenId }} bandPresent={false} standalone />} />
      </div>
    )
  } else if (current.phase === 'failed') {
    body = (
      <>
        <div className="dm-pos-empty" title="Its details could not be read from chain just now. They are asked again on their own." data-position-reason={current.reason}>
          <EmptyState icon={<IconSearch />} title={`Position #${tokenId}`} body="Its details could not be read just now." plate data-empty="position-unread" />
        </div>
        {/* The fees card reads this NFT from public chain data on its own (§12.4). */}
        <FeesCard kind="plain" source={{ tokenId }} bandPresent={false} standalone />
      </>
    )
  } else if (current.phase === 'gone') {
    body = (
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
    )
  } else if (current.phase === 'ready') {
    body = (
      <LiveDetail
        wallet={current.position}
        owner={current.owner}
        block={current.block}
        cached={current.row === true}
        changes={asked}
        onChanged={() => {
          setAsked((n) => n + 1)
          // The list kept for this visit is from before the action (item 18); the fees card reads its own state at once too.
          forgetWallet()
          refreshFeeStates([tokenId])
        }}
      />
    )
  }

  return (
    <PageShell>
      <Back />
      {body}
    </PageShell>
  )
}
