import { lazy, Suspense, useEffect, useMemo, useState, type ComponentType } from 'react'
import { compoundHref, newPositionHref, poolHref, positionsHref } from '../components/explore/routes'
import { IconAutomate, IconChevronLeft, IconMarkets, IconPlus, IconSearch } from '../components/icons'
import { Amount, PairName, PositionStatus, blockTitle } from '../components/positions/PositionFigures'
import { Approx, PositionRange, chainCardPrice, type CardPrice } from '../components/positions/PositionRange'
import { FeesCard } from '../components/positions/visual/FeesCard'
import { PositionSkeleton } from '../components/positions/visual/PositionSkeleton'
import { PrincipalUsd, UnclaimedUsd } from '../components/positions/visual/PositionValue'
import { PriceVsRange, usePriceSeries } from '../components/positions/visual/PriceVsRange'
import { usdgSide } from '../components/positions/visual/value'
import { TokenLabel } from '../components/read/TokenLabel'
import { Address } from '../components/read/screens/Address'
import { TokenMarkPair } from '../components/TokenIcon'
import { Chip, Display, EmptyState, KeyValue, KeyValueList, LinkButton, PageShell, Stat, StatStrip } from '../components/ui'
import { postState } from '../lib/fees/client'
import type { StatePositionOk } from '../lib/fees/types'
import { useMediaQuery } from '../lib/useMediaQuery'
import { NATIVE_CURRENCY } from '../lib/read/screens/identity'
import { cardPoolUsableForDomino, type RangeEnd } from '../lib/read/screens/positions'
import type { TokenDisplay } from '../lib/read/types'
import { positionOfState, walletCard, walletState, type CurrencyView, type LiveCard } from '../lib/walletCards'
import { useWalletIdentity, walletKey } from '../lib/walletIdentity'

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

/** The page's own chain read: one /api/fees/v1/state answer for this NFT, at one block. */
type Detail =
  | { phase: 'loading' }
  | { phase: 'ready'; position: StatePositionOk; block: number }
  | { phase: 'failed'; reason: string }
  /** ownerOf reverts: never minted, or burned. */
  | { phase: 'gone'; block: number }

/** The waits before a read that failed only for the moment is asked again, while the page is visible. */
const REASK_MS = [3_000, 12_000, 30_000] as const
/**
 * An NFT the relay says does not exist is asked again after these waits, the skeleton kept, before the page says so:
 * Create position opens a new position's page 3 s after its mint, and the relay reads two blocks behind the head and
 * keeps an answer 10 s (the last wait reaches past that).
 */
const NOT_FOUND_REASK_MS = [3_000, 8_000, 12_000] as const
/** After an action, the page is read again at once and once more past the relay's 10 s answer cache. */
const AFTER_ACTION_MS = 11_000

/** `run` after `ms`, or once the page is shown again when it is hidden by then. Returns a cancel. */
function whenVisibleAfter(ms: number, run: () => void): () => void {
  let cancelled = false
  const whenVisible = () => {
    if (document.hidden) return
    document.removeEventListener('visibilitychange', whenVisible)
    if (!cancelled) run()
  }
  const timer = setTimeout(() => {
    if (cancelled) return
    if (document.hidden) document.addEventListener('visibilitychange', whenVisible)
    else run()
  }, ms)
  return () => {
    cancelled = true
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', whenVisible)
  }
}

/** A token as the actions take it: its address and what the chain said about it. */
const currency = (token: TokenDisplay): CurrencyView => ({ address: token.address, symbol: token.symbol, decimals: token.decimals })

/** A range end in the stat strip: its price, 0 or ∞ at the pool's limits, or its tick when no price can be written. */
const endText = (end: RangeEnd, tick: number) => (end.kind === 'tick' ? `Tick ${tick}` : end.text)

/** The way back to the list. */
function Back() {
  return (
    <a href={positionsHref} className="dm-pos-back">
      <IconChevronLeft size={16} />
      Positions
    </a>
  )
}

/** The pool's price, as the stat strip writes it; a dash whose reason is its title otherwise. */
function CurrentPrice({ price, card }: { price: CardPrice; card: LiveCard }) {
  const [base, quote] = card.currencies
  const { state } = price
  if (state.phase === 'ready' && state.price.state === 'usable') {
    return (
      <span data-current-price="usable" title={`Pool price at block ${state.price.block}`}>
        <Approx text={state.price.text} />{' '}
        <span className="dm-pos-unit">
          <TokenLabel token={quote} /> per <TokenLabel token={base} />
        </span>
      </span>
    )
  }
  const code = state.phase === 'ready' ? state.price.state : state.phase === 'failed' ? state.code : state.phase
  return (
    <span className="text-fg-subtle" title="The pool’s price could not be written with this position’s tokens." data-current-price={code}>
      —
    </span>
  )
}

/**
 * One position NFT, read from chain: its pair and state, its principal and
 * unclaimed fees, the pool's price against its range, and every fact behind
 * them. The owner, connected on Robinhood Chain, also gets Collect fees and
 * Close position in the title row; anyone else reads the same page with no
 * action on it. Every figure is from one chain read, at its block (the strip's title).
 */
function LiveDetail({ position, block, onChanged }: { position: StatePositionOk; block: number; onChanged: () => void }) {
  const wallet = useMemo(() => positionOfState(position), [position])
  const card = useMemo(() => walletCard(wallet, position.owner), [wallet, position.owner])
  // The same read values the amounts for a pair with USDG (§6.2): one price, one block.
  const state = useMemo(() => walletState(wallet, block, position.owner), [wallet, block, position.owner])
  const price = chainCardPrice(card, { sqrtPriceX96: wallet.sqrtPriceX96, tick: wallet.tick, block })
  const [base, quote] = card.currencies
  const token = base.address === NATIVE_CURRENCY ? quote.address : base.address
  const { ends, tickLower, tickUpper } = card.range
  // The owner's actions, chunk and all, only for the NFT's owner at the read's block, connected on Robinhood Chain:
  // any other visitor downloads nothing of them. PositionActions checks the owner again on chain before anything is sent.
  const identity = useWalletIdentity()
  const mine = walletKey(identity) !== null && identity.kind === 'connected' && identity.address.toLowerCase() === card.owner.address
  const usdgIndex = state ? usdgSide(state.currencies) : null
  const series = usePriceSeries(card.tokenId)
  const phone = useMediaQuery('(max-width: 767px)')
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
              <Chip>
                <span>
                  Uniswap · <span data-fee="">{card.fee}</span> · #<span translate="no">{card.tokenId}</span>
                </span>
              </Chip>
              <PositionStatus card={card} />
            </div>
          </div>
        </div>
        {PositionActions && mine && (
          <div className="dm-pos-actions" data-position-actions="">
            <Suspense fallback={null}>
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
              />
            </Suspense>
          </div>
        )}
      </div>

      <StatStrip layout="tiles" className="dm-pos-stats" title={blockTitle(block)} data-position-stats="" data-valued={state && usdgIndex !== null ? '' : undefined}>
        <Stat label="Principal" className="dm-pos-stat" data-cell="principal" sub={<PrincipalUsd card={card} state={state} />}>
          <span className="dm-pos-amounts" data-stat="principal">
            <Amount amount={card.principal[0]} />
            <Amount amount={card.principal[1]} />
          </span>
        </Stat>
        <Stat label="Unclaimed fees" className="dm-pos-stat" data-cell="fees" sub={<UnclaimedUsd card={card} state={state} />}>
          <span className="dm-pos-amounts" data-stat="fees">
            <Amount amount={card.unsettledFees[0]} />
            <Amount amount={card.unsettledFees[1]} />
          </span>
        </Stat>
        <Stat label="Current price" className="dm-pos-stat" data-cell="price">
          <span className="dm-pos-figure" data-stat="price">
            <CurrentPrice price={price} card={card} />
          </span>
        </Stat>
        <Stat label="Range" className="dm-pos-stat" data-cell="range">
          {/* Each end keeps its line, and the dash travels with the upper end: a narrow cell breaks before the dash, never
              after it. The text is unchanged (`≈350.06 – ≈2,249.83`): the space before the dash stays outside the runs. */}
          <span className="dm-pos-figure" data-stat="range" data-full-range={card.range.fullRange ? '' : undefined}>
            <span className="dm-pos-run">
              <Approx text={endText(ends.lower, tickLower)} />
            </span>{' '}
            <span className="dm-pos-run">
              <span className="dm-pos-dash">– </span>
              <Approx text={endText(ends.upper, tickUpper)} />
            </span>
          </span>
        </Stat>
      </StatStrip>

      <FeesCard kind="plain" source={{ tokenId: card.tokenId }} bandPresent quoteIndex={1} tokens={[base, quote]} />

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

        <section className="dm-card dm-pos-card dm-pos-details" aria-labelledby="position-facts-title">
          <h2 id="position-facts-title" className="dm-title">
            Details
          </h2>
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
              <LinkButton href={newPositionHref(card.poolId)} variant="outline" size="sm">
                <IconPlus />
                Add to this pool
              </LinkButton>
            )}
            {card.hasLiquidity && (
              <LinkButton href={compoundHref(card.tokenId)} variant="outline" size="sm">
                <IconAutomate />
                Automate
              </LinkButton>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

/**
 * `#/positions/<id>`: one position NFT's own page, read from chain through the
 * site's own fees relay (POST /api/fees/v1/state: the NFT's pool, range,
 * liquidity, owner, the pool's price and its unclaimed fees at one block), so
 * it opens whether or not the read service is up. A read that failed only for
 * the moment is asked again on its own while the page is visible; the owner's
 * actions ask the page to read again once they are included on chain.
 */
export default function PositionDetail({ tokenId }: { tokenId: string }) {
  const [detail, setDetail] = useState<Detail>({ phase: 'loading' })
  const [asked, setAsked] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let attempts = 0
    let empties = 0
    let cancel: (() => void) | null = null
    const askAfter = (wait: number) => {
      cancel = whenVisibleAfter(wait, () => {
        cancel = null
        ask()
      })
    }
    const ask = () => {
      void postState([tokenId], controller.signal).then((answer) => {
        if (controller.signal.aborted) return
        const found = answer.ok ? answer.value.positions.find((p) => p.tokenId === tokenId) : undefined
        if (answer.ok && found?.ok) {
          const block = answer.value.block
          // An answer from an older block than the one on screen (the relay's cache, right after an action) changes nothing.
          setDetail((before) => (before.phase === 'ready' && before.block > block ? before : { phase: 'ready', position: found, block }))
          return
        }
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
    // After an action the relay may still answer from before it for a few seconds: once more past its cache.
    const again = asked > 0 ? whenVisibleAfter(AFTER_ACTION_MS, ask) : null
    return () => {
      controller.abort()
      cancel?.()
      again?.()
    }
  }, [tokenId, asked])

  let body
  if (detail.phase === 'loading') {
    body = (
      <div data-position-loading="" aria-busy="true">
        <p role="status" className="sr-only">
          Reading position {tokenId}…
        </p>
        <PositionSkeleton />
      </div>
    )
  } else if (detail.phase === 'failed') {
    body = (
      <>
        <div className="dm-pos-empty" title="Its details could not be read from chain just now. They are asked again on their own." data-position-reason={detail.reason}>
          <EmptyState icon={<IconSearch />} title={`Position #${tokenId}`} body="Its details could not be read just now." plate data-empty="position-unread" />
        </div>
        {/* The fees card reads this NFT from public chain data on its own (§12.4). */}
        <FeesCard kind="plain" source={{ tokenId }} bandPresent={false} standalone />
      </>
    )
  } else if (detail.phase === 'gone') {
    body = (
      <EmptyState
        icon={<IconSearch />}
        title="This position NFT no longer exists"
        body={`NFT #${tokenId} was not found at block ${detail.block}.`}
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
  } else {
    body = <LiveDetail position={detail.position} block={detail.block} onChanged={() => setAsked((n) => n + 1)} />
  }

  return (
    <PageShell>
      <Back />
      {body}
    </PageShell>
  )
}
