import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ActivityResponse, PortfolioResponse } from 'api-contracts/read-v6/types'
import { positionsHref } from '../../components/explore/routes'
import { IconChevronDown, IconChevronLeft, IconCoins, IconSearch } from '../../components/icons'
import { PositionRange, chainCardPrice, preloadPriceChart } from '../../components/positions/PositionRange'
import { activityOpenedAt } from '../../lib/chart/positionOpened'
import { readablePrice } from '../../lib/chart/priceFacts'
import { priceInverted } from '../../lib/read/orientation'
import { Amount as CardAmount, PairName, PositionStatus } from '../../components/positions/PositionFigures'
import { PositionSkeleton } from '../../components/positions/visual/PositionSkeleton'
import { Address } from '../../components/read/screens/Address'
import { TokenMarkPair } from '../../components/TokenIcon'
import { Button, Chip, Display, EmptyState, FigureDash, KeyValue, KeyValueList, PageShell, Stat, StatStrip } from '../../components/ui'
import { LiveFigure, UsdText } from '../../components/figures'
import { formatUsdFloor } from '../../lib/format/usd'
import { useRouteTitle } from '../../lib/routeTitle'
import { useMediaQuery } from '../../lib/useMediaQuery'
import { useWalletIdentity } from '../../lib/walletIdentity'
import { newPositionExpected } from '../../lib/automate/autoExitAsk'
import { v2Chain } from '../../v2/chains'
import { v2Gate, type V2Gate } from '../../v2/gate'
import { v2PageProbe } from '../transports'
import { feeTierText } from '../../v2/plan/present'
import { coverageNote } from '../../v2/read/v6'
import { ZERO_ADDRESS } from '../../v2/types'
import { parseV2PositionParam, type V2PositionRef } from '../route'
import { ApprovalFact, useZapApproval } from './Approval'
import { cardOf, poolIdentity, walletPositionOf } from './card'
import PositionAutomation from '../automate/PositionAutomation'
import { exitOrderKey } from '../autoexit/entry'
import { HOOKED_COPY, NEW_POSITION_REREAD_MS, SUCCESSOR_BLOCKED_COPY } from './constants'
import { COPY } from './copy'
import { chainStatusOf, findPosition, fromV6, hookedPool, isLive, tokensOf, vaultReservesOf, type LiveV6Position } from './model'
import { MoreActions, positionMenuItems } from './MoreActions'
import { PositionDialog, type PositionMode } from './PositionDialog'
import { portfolioFor, type PortfolioRead, type V6Read } from './source'
import { labelOf, tokenBook, usdOfAmounts } from './tokens'
import { useActivityHistory } from '../lists/activity'
import PositionHistory from '../lists/PositionHistory'
import type { OpenGate } from './wallet'

// 2026-10-03 (the owner's point 10): the Price range chart's own chunk, asked for as this page's code arrives (V1's page does the same).
preloadPriceChart()

/** The way back to the list (V1's page's own). */
function Back() {
  return (
    <a href={positionsHref} className="dm-pos-back">
      <IconChevronLeft size={16} />
      {COPY.page.back}
    </a>
  )
}

/** The page while its gate, its read or its chunk is on the way: the page frame, as V1's page waits. */
function Waiting({ id }: { id: string }) {
  return (
    <PageShell>
      <Back />
      <div data-position-loading="" aria-busy="true">
        <p role="status" className="sr-only">{COPY.page.reading(id)}</p>
        <PositionSkeleton />
      </div>
    </PageShell>
  )
}

/** A page that has nothing to draw, in V1's empty-state frame. */
function Empty({ title, body, reason }: { title: string; body?: string; reason: string }) {
  return (
    <PageShell>
      <Back />
      <EmptyState icon={<IconSearch />} title={title} body={body} plate className="dm-pos-empty" data-empty="position-v2" data-position-reason={reason} />
    </PageShell>
  )
}

/**
 * `#/positions/<chain>-v<dex>-<tokenId>` (src/v2in/route.ts): V1's position page for a position V1's own reads do not
 * cover (Domino V2 integration, 2026-10-02: a Uniswap v3 position, one on Base or Arbitrum One, any position read-v6
 * lists). The same page: its pair and state, its figures (what it holds and the fees ready to collect, as token
 * amounts: no USD and no APR without a qualified source, decision #22), its price against its range, its activity
 * (read-v6's S1 receipts), and closed until opened, the technical Details with "Domino can manage this position for you
 * when you ask." and "Revoke"; the owner's actions beside the title as V1's page has them (the owner, 2026-10-03: one
 * row, few buttons): Collect fees, and a "···" menu with Add liquidity, Change range and Withdraw, each in the page's
 * action dialog.
 *
 * Data: read-v6's portfolio of the connected wallet, over the site's route, under `live` and `preview` alike (real data
 * only, the owner, 2026-10-02: none is read without a wallet); the money clients read the chain through the wallet again
 * before any send. The chain's status comes before any of its figures (§6.2); an unread position is said so, never
 * drawn as zeros. Where the gate is `off` the route is V1's: the list (`list`).
 */
export default function PositionPage({ param, list }: { param: string; list: ReactNode }) {
  const ref = useMemo(() => parseV2PositionParam(param), [param])
  const identity = useWalletIdentity()
  const wallet = identity.kind === 'connected' ? identity.address.toLowerCase() : null
  const walletChain = identity.kind === 'connected' ? identity.chainId : null
  const [gate, setGate] = useState<V2Gate | null>(null)
  useEffect(() => {
    if (!ref) return
    let alive = true
    void v2Gate('s1', ref.chainId, undefined, v2PageProbe).then((answer) => { if (alive) setGate(answer) }, () => { if (alive) setGate({ mode: 'off' }) })
    return () => {
      alive = false
    }
  }, [ref])
  if (!ref) return <>{list}</>
  if (gate === null) return <Waiting id={ref.tokenId.toString()} />
  if (gate.mode === 'off') return <>{list}</>
  // Keyed by the wallet too: another wallet's answer is never drawn for this one, not even for a moment.
  return <Opened key={`${param}|${wallet ?? ''}`} target={ref} gate={gate} wallet={wallet} walletOnChain={walletChain === ref.chainId} />
}

function Opened({ target, gate, wallet, walletOnChain }: { target: V2PositionRef; gate: OpenGate; wallet: string | null; walletOnChain: boolean }) {
  // The portfolio is the connected wallet's: none is read without one (never an empty owner to read-v6).
  const needsWallet = wallet === null
  const [read, setRead] = useState<PortfolioRead | null>(null)
  const history = useActivityHistory(wallet)
  const activity = useMemo<V6Read<ActivityResponse> | null>(() => history.answer ? { kind: 'ok', body: history.answer } : history.error, [history.answer, history.error])
  const [round, setRound] = useState(0)
  const chain = v2Chain(target.chainId)
  const id = target.tokenId.toString()
  useRouteTitle(`Position #${id}`)

  useEffect(() => {
    if (needsWallet) return
    let alive = true
    void portfolioFor(gate, wallet ?? '').then((answer) => { if (alive) setRead(answer) })
    return () => {
      alive = false
    }
  }, [needsWallet, gate, wallet, round])

  // Added 2026-10-06 (the review of point 5, a second look): a position New position just made, opened from its success
  // (its own link or Auto-exit's), reaches read-v6's list some seconds later (the index runs behind the chain; at first
  // it may be listed as not read yet). While it is expected (two minutes, lib/automate/autoExitAsk.ts) the page reads the
  // list again every few seconds and waits on its loading frame, then says it isn't listed only once that time is over.
  // Auto-exit's dialog, asked for on the way here, opens as soon as the position is drawn.
  const found = read?.reply.kind === 'ok' ? findPosition(read.reply.body, target.chainId, target.dex, target.tokenId) : null
  const awaited = read !== null && !(found && isLive(found)) && newPositionExpected(exitOrderKey(id, target.chainId, target.dex))
  useEffect(() => {
    if (!awaited) return
    const timer = setTimeout(() => setRound((n) => n + 1), NEW_POSITION_REREAD_MS)
    return () => clearTimeout(timer)
  }, [awaited, read])

  if (needsWallet) return <Empty title={`Position #${id}`} body={COPY.page.connect} reason="connect_wallet" />
  if (read === null) return <Waiting id={id} />
  const reply = read.reply
  if (reply.kind === 'unavailable') return <Empty title={`Position #${id}`} body={COPY.page.listUnavailable} reason={reply.reason} />
  if (reply.kind === 'invalid') return <Empty title={`Position #${id}`} body={COPY.page.listInvalid} reason={reply.detail} />
  const answer = reply.body
  // §6.2: the chain's status before any of its values; an unavailable chain never shows zeros.
  const status = chainStatusOf(answer, target.chainId)
  if (!status || status.status === 'unavailable') return <Empty title={`Position #${id}`} body={COPY.page.chainUnavailable(chain.name)} reason={status?.reason ?? 'chain_unavailable'} />
  if (!found || !isLive(found)) {
    if (awaited) return <Waiting id={id} />
    if (!found) return <Empty title={`Position #${id}`} body={COPY.page.notListed} reason="position_not_listed" />
    return <Empty title={`Position #${id}`} body={found.status === 'unavailable' ? COPY.page.unreadable : COPY.page.notRead} reason={found.status} />
  }
  return (
    <PageShell>
      <Back />
      <LivePosition
        gate={gate}
        answer={answer}
        position={found}
        stale={status.status === 'stale' || found.freshness?.status === 'stale'}
        coverage={coverageNote(answer.chains)}
        wallet={wallet}
        walletOnChain={walletOnChain}
        activity={activity}
        onChanged={() => setRound((n) => n + 1)}
      />
    </PageShell>
  )
}

function LivePosition({ gate, answer, position, stale, coverage, wallet, walletOnChain, activity, onChanged }: {
  gate: OpenGate
  answer: PortfolioResponse
  position: LiveV6Position
  stale: boolean
  coverage: string | null
  wallet: string | null
  walletOnChain: boolean
  activity: V6Read<ActivityResponse> | null
  onChanged: () => void
}) {
  const chainId = position.chainId
  const chain = v2Chain(chainId)
  const book = useMemo(() => tokenBook(chainId, tokensOf(answer, chainId)), [answer, chainId])
  const card = useMemo(() => cardOf(position, book), [position, book])
  const action = useMemo(() => fromV6(position, answer), [position, answer])
  const automationPosition = useMemo(() => walletPositionOf(position, book), [position, book])
  const reserves = position.vault ? vaultReservesOf(answer, chainId, position.vault.address) : null
  const price = chainCardPrice(card, { sqrtPriceX96: position.sqrtPriceX96.toString(10), tick: position.tick, block: position.snapshotBlock ?? 0 })
  const priced = priceInverted(position.pool.currency0, position.pool.currency1) ? { base: position.pool.currency1, quote: position.pool.currency0 } : { base: position.pool.currency0, quote: position.pool.currency1 }
  const phone = useMediaQuery('(max-width: 767px)')
  const [mode, setMode] = useState<PositionMode | null>(null)
  const [automationToolbar, setAutomationToolbar] = useState<HTMLSpanElement | null>(null)
  const approval = useZapApproval(gate, action, walletOnChain)
  const [base, quote] = card.currencies
  const owner = position.owner
  const successor = position.vault?.role === 'successor'
  // The owner's actions: the connected wallet that holds it. A successor is held by the wallet's vault (read-v6 lists it
  // in the wallet's portfolio): its sentence, no action.
  const heldByVault = successor && position.vault !== null && owner === position.vault.address
  const mine = wallet !== null && (owner === wallet || heldByVault)
  const hooked = hookedPool(position.pool)
  const items = action ? positionMenuItems(action, false) : []
  const identity = poolIdentity(chainId, position.pool)
  const custody = successor ? COPY.custody.successor : position.vault?.role === 'root' ? COPY.custody.root : COPY.custody.walletHolds
  // Added 2026-10-06 (read-v6 1.1.0-rc.1's qualified USD): what it holds and its fees in USD, as V1's page shows them
  // (components/positions/KeyFigures.tsx), the token amounts under the figure; only from a fresh read, every token held
  // above zero priced. Otherwise the token amounts alone, as before.
  const fresh = position.freshness?.status === 'fresh' && !stale
  const pair = [position.pool.currency0, position.pool.currency1] as const
  const holdsUsd = fresh ? usdOfAmounts(book, pair, position.principal) : null
  const feesUsd = fresh ? usdOfAmounts(book, pair, position.feesOwed) : null

  return (
    <div data-position-detail="" data-position-id={position.tokenId.toString()} data-position-v2={`${chain.slug}-v${position.dex}`} data-snapshot={position.snapshotBlock ?? undefined}>
      <div className="dm-pos-title">
        <div className="dm-pos-name">
          <TokenMarkPair base={base} quote={quote} size={phone ? 36 : 44} ring="var(--bg)" />
          <div className="min-w-0">
            <Display as="h1" className="dm-display-h1 dm-pos-pair">
              <PairName card={card} />
            </Display>
            <div className="dm-pos-chips">
              {/* As V1's page: the venue and the fee; the Uniswap version only as the title and under Details (the lists' rule). */}
              <Chip title={COPY.page.version(position.dex)}>
                <span>
                  {COPY.page.uniswap} · <span data-fee="">{feeTierText(position.pool.fee)}</span> fee
                </span>
              </Chip>
              <Chip>
                <span data-position-network={chain.slug}>{chain.name}</span>
              </Chip>
              <span className="sr-only">
                Position #<span translate="no">{position.tokenId.toString()}</span>
              </span>
              <PositionStatus card={card} />
            </div>
            {coverage && <p className="dm-pos-copy" data-position-coverage="">{coverage}</p>}
          </div>
        </div>
        {/* V1's row: one primary button and the "···" menu (./MoreActions.tsx), which says why an entry is disabled. A
            successor of a vault has its sentence instead. */}
        {mine && action && (
          <div className="dm-pos-actions" data-position-actions="">
            {items.length === 0 ? (
              <span className="text-caption text-fg-muted" data-position-v2-blocked="successor">{SUCCESSOR_BLOCKED_COPY}</span>
            ) : (
              <>
                <Button type="button" variant="primary" disabled={hooked} title={hooked ? HOOKED_COPY : undefined} data-position-v2-action="collect" onClick={() => setMode('collect')}>
                  <IconCoins size={18} /><span>{COPY.button.collect}</span>
                </Button>
                <MoreActions id={`position-v2-more-${position.tokenId}`} items={items} onPick={(key) => { if (key !== 'protect') setMode(key) }} data-position-v2-actions={gate.mode} />
              </>
            )}
            <span ref={setAutomationToolbar} className="dm-position-automation-slot" data-position-automation-slot="" />
          </div>
        )}
      </div>

      <PositionAutomation tokenId={position.tokenId.toString()} position={automationPosition} holder={position.owner}
        chainId={chainId} dex={position.dex} priceContext={{ block: position.snapshotBlock, saved: stale }}
        indexed={{ portfolio: answer, subscriber: position.custody.subscriber }} toolbar={automationToolbar} onChanged={onChanged} />
      <StatStrip layout="tiles" className="dm-pos-stats" title={position.snapshotBlock !== null ? `Read at block ${position.snapshotBlock}` : undefined} data-position-stats="">
        <Stat
          label={COPY.page.holds}
          info={COPY.page.holdsInfo}
          className="dm-pos-stat"
          data-cell="principal"
          sub={
            holdsUsd !== null && (
              <span className="dm-pos-amounts" data-stat="principal">
                <CardAmount amount={card.principal[0]} />
                <CardAmount amount={card.principal[1]} />
              </span>
            )
          }
        >
          {holdsUsd !== null ? (
            <span className="dm-arrive" title={position.snapshotBlock !== null ? `Pool price at block ${position.snapshotBlock}` : undefined} data-usd="principal">
              <LiveFigure value={formatUsdFloor(holdsUsd)} mode="digits" dimCents className="dm-fig-lg" />
            </span>
          ) : (
            <span className="dm-pos-amounts" data-stat="principal">
              <CardAmount amount={card.principal[0]} />
              <CardAmount amount={card.principal[1]} />
            </span>
          )}
        </Stat>
        <Stat
          label={COPY.page.fees}
          info={COPY.page.feesInfo}
          className="dm-pos-stat"
          data-cell="fees"
          sub={
            feesUsd !== null && (
              <span className="dm-pos-amounts" data-stat="fees">
                <CardAmount amount={card.unsettledFees[0]} />
                <CardAmount amount={card.unsettledFees[1]} />
              </span>
            )
          }
        >
          {feesUsd !== null ? (
            <span data-usd="fees">
              <UsdText value={feesUsd} block={position.snapshotBlock ?? undefined} floor className="dm-fig-lg dm-arrive" />
            </span>
          ) : (
            <span className="dm-pos-amounts" data-stat="fees">
              <CardAmount amount={card.unsettledFees[0]} />
              <CardAmount amount={card.unsettledFees[1]} />
            </span>
          )}
        </Stat>
        <Stat label={COPY.page.apr} info={COPY.page.aprInfo} className="dm-pos-stat" data-cell="apr" data-apr="no_qualified_source" sub={COPY.page.aprMissing}>
          <span className="dm-fig-lg"><FigureDash reason={COPY.page.aprMissing} /></span>
        </Stat>
        <Stat label={COPY.page.price} info={COPY.page.priceInfo} className="dm-pos-stat" data-cell="price" sub={<span className="dm-pos-span-state" data-in={String(card.inRange)}>{card.hasLiquidity ? (card.inRange ? COPY.page.inRangeEarning : COPY.page.outOfRangeIdle) : COPY.page.closed}</span>}>
          <span data-stat="price">
            {/* V1's price now (components/positions/KeyFigures.tsx PriceNow): the figure large, the two sides quiet beside it. */}
            {price.state.phase === 'ready' && price.state.price.state === 'usable' ? (
              <span className="dm-pos-price" data-current-price="usable" title={`Pool price at block ${price.state.price.block}: ${price.state.price.text}`}>
                {/* Changed on purpose 2026-10-03: the price is the app's one way round (lib/read/orientation.ts), so its two
                    sides are too; the pool's own order wrote "1 ETH = 0.0₆7101 MANY" for MANY's price in ETH. */}
                <span className="dm-pos-price-side">1 {labelOf(book, priced.base)} =</span>{' '}
                <span className="dm-fig-lg">{readablePrice(price.state.price.text)}</span>{' '}
                <span className="dm-pos-price-side">{labelOf(book, priced.quote)}</span>
              </span>
            ) : (
              <span className="dm-fig-lg text-fg-subtle" data-current-price="unusable">—</span>
            )}
          </span>
        </Stat>
      </StatStrip>

      <div className="dm-pos-grid">
        <section className="dm-card dm-pos-card" aria-labelledby="position-range-title">
          <h2 id="position-range-title" className="dm-title">
            {COPY.page.rangeTitle}
          </h2>
          {/* The pool's stored price history (2026-10-03, the owner's point 10): kept by the read service for Robinhood
              Chain's Uniswap v4 pools only. */}
          <PositionRange card={card} price={price} variant="page" history={chainId === 4663 && position.dex === 4} openedAt={activityOpenedAt(activity?.kind === 'ok' ? activity.body : null, position)} />
        </section>

        <PositionHistory wallet={wallet} position={{ chainId, dex: position.dex, tokenId: position.tokenId.toString() }} />

        <details className="dm-card dm-pos-details" data-position-details="">
          <summary className="dm-pos-details-head">
            <h2 className="dm-title">{COPY.page.details}</h2>
            <span className="dm-pos-details-hint">{COPY.page.detailsHint}</span>
            <IconChevronDown size={16} />
          </summary>
          <KeyValueList className="dm-pos-facts">
            <KeyValue label={COPY.page.nftId}>
              <Address value={position.tokenId.toString()} />
            </KeyValue>
            <KeyValue label={COPY.page.network}>{chain.name}</KeyValue>
            <KeyValue label={COPY.page.owner}>
              <span data-owner="">
                <Address value={owner} />
              </span>
            </KeyValue>
            <KeyValue label={COPY.page.custody}>
              <span data-position-custody={successor ? 'successor' : position.vault?.role === 'root' ? 'root' : 'wallet'}>{custody}</span>
            </KeyValue>
            {position.vault && (
              <KeyValue label={COPY.page.vault}>
                <Address value={position.vault.address} />
              </KeyValue>
            )}
            <KeyValue label={COPY.page.pool}>{identity.kind === 'v4' ? <Address value={identity.id} /> : <Address value={identity.address} />}</KeyValue>
            <KeyValue label={COPY.page.uniswapVersion}>
              <span data-position-dex={position.dex}>v{position.dex}</span>
            </KeyValue>
            <KeyValue label={COPY.page.feeTier}>{feeTierText(position.pool.fee)}</KeyValue>
            <KeyValue label={COPY.page.tickSpacing}>
              <span className="tnum">{position.pool.tickSpacing}</span>
            </KeyValue>
            <KeyValue label={COPY.page.ticks}>
              <span className="tnum" data-ticks="">
                {position.tickLower} to {position.tickUpper}
              </span>
            </KeyValue>
            <KeyValue label={COPY.page.liquidity}>
              <span className="dm-hex" data-liquidity="" title={position.liquidity.toString()}>
                {position.liquidity.toString()}
              </span>
            </KeyValue>
            <KeyValue label={COPY.page.hooks}>{position.pool.hooks === ZERO_ADDRESS ? COPY.page.none : <Address value={position.pool.hooks} />}</KeyValue>
            <KeyValue label={COPY.page.manager}>
              <Address value={position.manager} />
            </KeyValue>
            {position.snapshotBlock !== null && (
              <KeyValue label={COPY.page.readAt}>
                <span className="tnum">{position.snapshotBlock}</span>
              </KeyValue>
            )}
            <ApprovalFact approval={approval} />
          </KeyValueList>
        </details>
      </div>

      {mode && action && (
        <PositionDialog gate={gate} position={action} mode={mode} book={book} reserves={reserves} onClose={() => setMode(null)} onDone={onChanged} />
      )}
    </div>
  )
}
