import { lazy, Suspense, useEffect, useState, type ComponentType } from 'react'
import { compoundHref, newPositionHref, poolHref, positionsHref } from '../components/explore/routes'
import { IconChevronLeft, IconSearch } from '../components/icons'
import { Amount, PairName, PositionStatus, snapshotTitle } from '../components/positions/PositionFigures'
import { PositionRange, useAutoCardPrice, type CardPrice } from '../components/positions/PositionRange'
import { TokenLabel } from '../components/read/TokenLabel'
import { Address } from '../components/read/screens/Address'
import { TokenMarkPair } from '../components/TokenIcon'
import { Chip, Display, EmptyState, KeyValue, KeyValueList, LinkButton, PageShell, Skeleton, Stat, StatStrip } from '../components/ui'
import type { CurrencyView, LiveCard } from '../lib/ownedPositions'
import { NATIVE_CURRENCY } from '../lib/read/screens/identity'
import { cardPoolUsableForDomino, emptyReaskDelayMs, runLookup, type Batch, type LookupFailure, type RangeEnd } from '../lib/read/screens/positions'
import { failureCode, quietTitle, reaskDelayMs, whenVisibleAfter } from '../lib/read/screens/quietRead'
import { useReadSource } from '../lib/read/screens/readContext'
import type { TokenDisplay } from '../lib/read/types'
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

type Detail = { phase: 'loading' } | { phase: 'ready'; batch: Batch } | { phase: 'failed'; failure: LookupFailure }

/** A token as the actions take it: its address and what the read service said about it. */
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

/** The pool's price, once read, as the stat strip writes it; a dash whose reason is its title otherwise. */
function CurrentPrice({ price, card }: { price: CardPrice; card: LiveCard }) {
  const [base, quote] = card.currencies
  const { state } = price
  if (state.phase === 'ready' && state.price.state === 'usable') {
    return (
      <span data-current-price="usable" title={`Pool price at block ${state.price.block}`}>
        {state.price.text}{' '}
        <span className="dm-pos-unit">
          <TokenLabel token={quote} /> per <TokenLabel token={base} />
        </span>
      </span>
    )
  }
  if (state.phase === 'loading' || state.phase === 'idle') return <Skeleton className="mt-2 h-4 w-28" />
  const reason = state.phase === 'failed' ? state.reason : 'The pool’s price could not be written with this position’s tokens.'
  return (
    <span className="text-fg-subtle" title={reason} data-current-price={state.phase === 'failed' ? state.code : state.price.state}>
      —
    </span>
  )
}

/**
 * One position NFT, read from chain: its pair and state, its principal and
 * unclaimed fees, the pool's price against its range, and every fact behind
 * them. The owner, connected on Robinhood Chain, also gets Collect fees and
 * Close position in the title row; anyone else reads the same page with no
 * action on it. The figures are the read's, at its block (the strip's title).
 */
function LiveDetail({ card, batch, onChanged }: { card: LiveCard; batch: Batch; onChanged: () => void }) {
  const price = useAutoCardPrice(card)
  const [base, quote] = card.currencies
  const token = base.address === NATIVE_CURRENCY ? quote.address : base.address
  const { ends, tickLower, tickUpper } = card.range
  // The owner's actions, chunk and all, only for the NFT's owner at the read's block, connected on Robinhood Chain:
  // any other visitor downloads nothing of them. PositionActions checks the owner again on chain before anything is sent.
  const identity = useWalletIdentity()
  const mine = walletKey(identity) !== null && identity.kind === 'connected' && identity.address.toLowerCase() === card.owner.address
  return (
    <div data-position-detail="" data-position-id={card.tokenId} data-snapshot={batch.block.number} data-stale={batch.freshness.status === 'stale' ? '' : undefined}>
      <div className="dm-pos-title">
        <div className="dm-pos-name">
          <TokenMarkPair base={base} quote={quote} size={40} ring="var(--bg)" />
          <div className="min-w-0">
            <Display as="h1" className="dm-display-title dm-pos-pair">
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
                unsettledFeesRaw={[card.unsettledFees[0].raw, card.unsettledFees[1].raw]}
                currencies={[currency(base), currency(quote)]}
                hooks={card.hooks}
                onChanged={onChanged}
              />
            </Suspense>
          </div>
        )}
      </div>

      <StatStrip className="dm-pos-stats" title={snapshotTitle(batch)} data-position-stats="">
        <Stat label="Principal">
          <span className="dm-pos-amounts" data-stat="principal">
            <Amount amount={card.principal[0]} />
            <Amount amount={card.principal[1]} />
          </span>
        </Stat>
        <Stat label="Unclaimed fees">
          <span className="dm-pos-amounts" data-stat="fees">
            <Amount amount={card.unsettledFees[0]} />
            <Amount amount={card.unsettledFees[1]} />
          </span>
        </Stat>
        <Stat label="Current price">
          <span className="dm-pos-figure" data-stat="price">
            <CurrentPrice price={price} card={card} />
          </span>
        </Stat>
        <Stat label="Range">
          <span className="dm-pos-figure" data-stat="range" data-full-range={card.range.fullRange ? '' : undefined}>
            {endText(ends.lower, tickLower)} – {endText(ends.upper, tickUpper)}
          </span>
        </Stat>
      </StatStrip>

      <div className="dm-pos-grid">
        <section className="dm-card dm-pos-card" aria-labelledby="position-range-title">
          <Display as="h2" id="position-range-title" className="dm-display-card">
            Price range
          </Display>
          <PositionRange card={card} price={price} />
        </section>

        <section className="dm-card dm-pos-card" aria-labelledby="position-facts-title">
          <Display as="h2" id="position-facts-title" className="dm-display-card">
            Details
          </Display>
          <KeyValueList className="dm-pos-facts">
            <KeyValue label="NFT id">
              <Address value={card.tokenId} />
            </KeyValue>
            <KeyValue label="Owner">
              <span data-owner="" title={`The NFT’s owner at block ${batch.block.number}, public data.`}>
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
              <span className="tnum break-all" data-liquidity="">
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
              Pool
            </LinkButton>
            {/* Only into a pool Domino can open a position in: no hooks, a fixed fee (New position refuses any other). */}
            {cardPoolUsableForDomino(card) && (
              <LinkButton href={newPositionHref(card.poolId)} variant="outline" size="sm">
                Add to this pool
              </LinkButton>
            )}
            {card.hasLiquidity && (
              <LinkButton href={compoundHref(card.tokenId)} variant="outline" size="sm">
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
 * `#/positions/<id>`: one position NFT's own page. One nft-positions read for
 * the id, then its tokens, then the pool's price; nothing else. A read that
 * failed only for the moment is asked again on its own while the page is
 * visible, and so is an NFT that reads empty, a few times (EMPTY_REASK_MS),
 * before the page says it was not found; the owner's actions ask the page to
 * read again once they are included on chain.
 */
export default function PositionDetail({ tokenId }: { tokenId: string }) {
  const source = useReadSource()
  const [detail, setDetail] = useState<Detail>({ phase: 'loading' })
  const [asked, setAsked] = useState(0)
  useEffect(() => {
    if (!source) return
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
      void runLookup(source, [tokenId], { signal: controller.signal }).then((result) => {
        if (controller.signal.aborted || result.kind === 'aborted') return
        if (result.kind === 'ok') {
          // Empty: a position created a moment ago can be newer than the read service's block (Create position lands
          // here 3 s after the mint). Asked again a few times, the skeleton kept, before the page says it is not there.
          const wait = result.batch.cards[0]?.kind === 'empty' ? emptyReaskDelayMs(empties) : null
          if (wait !== null) {
            empties += 1
            askAfter(wait)
            return
          }
          setDetail({ phase: 'ready', batch: result.batch })
          return
        }
        // A position already on screen stays there, from its own block, when a later read fails.
        setDetail((before) => (before.phase === 'ready' ? before : { phase: 'failed', failure: result.failure }))
        const wait = reaskDelayMs(result.failure, attempts)
        if (wait === null) return
        attempts += 1
        askAfter(wait)
      })
    }
    ask()
    return () => {
      controller.abort()
      cancel?.()
    }
  }, [source, tokenId, asked])

  const card = detail.phase === 'ready' ? detail.batch.cards[0] : null
  let body
  if (detail.phase === 'loading') {
    body = (
      <div data-position-loading="" aria-busy="true">
        <p role="status" className="sr-only">
          Reading position {tokenId}…
        </p>
        <div className="dm-pos-title" aria-hidden="true">
          <div className="dm-pos-name">
            <Skeleton className="size-10 rounded-full" />
            <div className="grid gap-2">
              <Skeleton className="h-7 w-44" />
              <Skeleton className="h-5 w-56" />
            </div>
          </div>
        </div>
        <Skeleton className="mt-8 h-24 w-full" />
      </div>
    )
  } else if (detail.phase === 'failed') {
    body = (
      <div title={quietTitle(detail.failure, 'positions')} data-position-reason={failureCode(detail.failure)}>
        <EmptyState icon={<IconSearch />} title={`Position #${tokenId}`} body="Its details could not be read just now." data-empty="position-unread" />
      </div>
    )
  } else if (!card || card.kind === 'empty') {
    body = (
      <EmptyState
        icon={<IconSearch />}
        title="This position NFT no longer exists"
        body={`NFT #${tokenId} was not found at block ${detail.batch.block.number}.`}
        action={
          <LinkButton href={positionsHref} variant="outline" size="sm">
            Positions
          </LinkButton>
        }
        data-empty="position-gone"
      />
    )
  } else {
    body = <LiveDetail card={card} batch={detail.batch} onChanged={() => setAsked((n) => n + 1)} />
  }

  return (
    <PageShell>
      <Back />
      {body}
    </PageShell>
  )
}
