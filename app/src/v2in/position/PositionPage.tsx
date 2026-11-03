import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ActivityResponse, PortfolioResponse } from 'api-contracts/read-v6/types'
import { IconChevronDown, IconChevronLeft, IconClose, IconSearch, IconWalletLine } from '../../components/icons'
import { positionsListHref, viewedPositionsAddress } from '../../components/positions/listHref'
import { openWalletDialog } from '../../finance/signedOut'
import { IconCollect } from '../../components/positions/actionIcons'
import { PositionRange, chainCardPrice, preloadPriceChart } from '../../components/positions/PositionRange'
import { activityOpenedAt } from '../../lib/chart/positionOpened'
import { readablePrice } from '../../lib/chart/priceFacts'
import { priceInverted } from '../../lib/read/orientation'
import { Amount as CardAmount, PairName, PositionStatus } from '../../components/positions/PositionFigures'
import { PositionSkeleton } from '../../components/positions/visual/PositionSkeleton'
import { Address } from '../../components/read/screens/Address'
import { TokenMarkPair } from '../../components/TokenIcon'
import { Button, Chip, Display, EmptyState, FigureDash, KeyValue, KeyValueList, PageShell, Stat, StatStrip, cx } from '../../components/ui'
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
import { ownVaultsOfPosition } from '../automate/portfolio'
import { exitOrderKey } from '../autoexit/entry'
import { HOOKED_COPY, NEW_POSITION_REREAD_MS, SUCCESSOR_BLOCKED_COPY } from './constants'
import { COPY } from './copy'
import { chainStatusOf, findPosition, fromV6, hookedPool, isLive, tokensOf, vaultReservesOf, type LiveV6Position } from './model'
import { MoreActions, positionMenuItems } from './MoreActions'
import { PositionDialog, type PositionMode } from './PositionDialog'
import type { V6Read } from './source'
import { labelOf, tokenBook } from './tokens'
import { useActivityHistory } from '../lists/activity'
import PositionHistory from '../lists/PositionHistory'
import { useCreatedPositions, useKeyed, useKeyedLatest, useUsdAged } from '../lists/hooks'
import { OWN_PORTFOLIO } from '../lists/source'
import { positionRows, usdAsOf } from '../lists/model'
import type { OpenGate } from './wallet'
import RecordedInsights from './RecordedInsights'
import { usdTitleWords } from './usdAvailability'

// 2026-10-03 (the owner's point 10): the Price range chart's own chunk, asked for as this page's code arrives (V1's page does the same).
preloadPriceChart()

/** The way back to the list it was opened from (V1's page's own; N62: the viewed address's, when it was another address's). */
function Back() {
  return (
    <a href={positionsListHref()} className="dm-pos-back">
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

/**
 * A page that has nothing to draw, in V1's empty-state frame. `automation` (Added 2026-11-02, the money review, M2): the
 * position's automation, drawn above it when the wallet still has a vault of it, as Robinhood Chain's own page draws it
 * without a position (screens/PositionDetail.tsx).
 */
function Empty({ title, body, reason, action, automation }: { title: string; body?: ReactNode; reason: string; action?: ReactNode; automation?: ReactNode }) {
  return (
    <PageShell>
      <Back />
      {automation}
      <EmptyState icon={<IconSearch />} title={title} body={body} action={action} plate className="dm-pos-empty" data-empty="position-v2" data-position-reason={reason} />
    </PageShell>
  )
}

/** The words of a row's status pill (../lists/parts.tsx RowStatus), for the line below. */
const STATE_WORDS: Readonly<Record<string, string>> = { 'in-range': 'In range', 'out-of-range': 'Out of range', closed: 'Closed' }

/**
 * (QA round 2, N61) A page the connected wallet cannot open (none connected, or another wallet's position, opened from
 * View address): what the list already knows of it, over the sentence and a way on. Always its network, from the link;
 * its pair and status too when the list of the address it was opened from holds it, from that list's answer as it is
 * already kept in this tab (OWN_PORTFOLIO.get: no read is asked for it, and nothing is drawn from one address's answer
 * for another's link). No figure and no action: those stay the owner's, on the page itself.
 */
function knownLine(target: V2PositionRef, wallet: string | null): string {
  const viewed = viewedPositionsAddress()
  const reply = viewed !== null && viewed !== wallet ? OWN_PORTFOLIO.get(viewed) : null
  const listed = reply?.kind === 'ok' ? reply.body.positions.find((one) => one.chainId === target.chainId && one.dex === target.dex && one.tokenId === target.tokenId.toString(10)) : undefined
  const row = reply?.kind === 'ok' && listed ? positionRows({ ...reply.body, positions: [listed] }, () => true)[0] ?? null : null
  const pair = row?.tokens ? `${row.tokens[0].label} / ${row.tokens[1].label}` : null
  return [pair, v2Chain(target.chainId).name, row ? STATE_WORDS[row.state] ?? null : null].filter(Boolean).join(' · ')
}

/** The empty page's body: the known line, a value in the page's value ink (Geist 500, --fg), then its sentence in caption ink. */
function Known({ line, sentence }: { line: string; sentence: string }) {
  return (
    <>
      <span className="block font-medium text-fg" data-position-known="">{line}</span>
      {sentence}
    </>
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
  // Changed on purpose 2026-10-30 (QA round 2, final review pos-connect-flash-1): while the wallet island has not said
  // what it found (identity `unknown`, the 0.7 to 2 s audit C5 is about), the page waits in its frame, as the Positions
  // list does: a returning owner whose wallet reconnects saw "Connect wallet" for that moment, then the page. A build
  // without a wallet control starts `disconnected` and a failed island publishes `disconnected` (lib/walletIdentity.ts,
  // components/wallet/WalletBoundary.tsx), so this never waits for good.
  if (identity.kind === 'unknown') return <Waiting id={ref.tokenId.toString()} />
  // Keyed by the wallet too: another wallet's answer is never drawn for this one, not even for a moment.
  return <Opened key={`${param}|${wallet ?? ''}`} target={ref} gate={gate} wallet={wallet} walletOnChain={walletChain === ref.chainId} />
}

function Opened({ target, gate, wallet, walletOnChain }: { target: V2PositionRef; gate: OpenGate; wallet: string | null; walletOnChain: boolean }) {
  // The portfolio is the connected wallet's: none is read without one (never an empty owner to read-v6).
  const needsWallet = wallet === null
  const reply = useKeyed(OWN_PORTFOLIO, wallet)
  const latest = useKeyedLatest(OWN_PORTFOLIO, wallet)
  const created = useCreatedPositions(wallet)
  const history = useActivityHistory(wallet)
  const activity = useMemo<V6Read<ActivityResponse> | null>(() => history.answer ? { kind: 'ok', body: history.answer } : history.error, [history.answer, history.error])
  const id = target.tokenId.toString()
  useRouteTitle(`Position #${id}`)

  // The figures, Activity and automation share one wallet-keyed snapshot. A known creation remains discoverable
  // while the index catches up; it never supplies fabricated balances or permits actions before the live read.
  const found = reply?.kind === 'ok' ? findPosition(reply.body, target.chainId, target.dex, target.tokenId) : null
  const creation = created.find(item => item.chainId === target.chainId && item.dex === target.dex && item.tokenId === id)
  const awaited = reply !== null && !(found && isLive(found)) && newPositionExpected(exitOrderKey(id, target.chainId, target.dex))
  useEffect(() => {
    // Preserve Robinhood's existing arrival cadence. Other chains use the shared bounded catch-up policy.
    if (!awaited || target.chainId !== 4663 || !wallet) return
    const timer = setTimeout(() => OWN_PORTFOLIO.again(wallet), NEW_POSITION_REREAD_MS)
    return () => clearTimeout(timer)
  }, [awaited, reply, target.chainId, wallet])

  if (needsWallet) {
    return (
      <Empty title={`Position #${id}`} body={<Known line={knownLine(target, wallet)} sentence={COPY.page.connect} />} reason="connect_wallet"
        action={<Button type="button" onClick={openWalletDialog} data-position-connect=""><IconWalletLine size={16} />Connect wallet</Button>} />
    )
  }
  // Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): a page with nothing read yet, or whose read
  // failed (it is asked again), shows its title alone, its reason as data. It said "Updating position details…", "Your
  // positions can’t be listed right now.", "{chain} can’t be read right now.", "This position can’t be read right now."
  // or "Not read yet".
  if (creation && !(found && isLive(found))) return <Empty title={`Position #${id}`} reason="awaiting_index" />
  if (reply === null) return <Waiting id={id} />
  if (reply.kind === 'unavailable') return <Empty title={`Position #${id}`} reason={reply.reason} />
  // (QA round 2, SWEEP) Its title alone, as for a read that failed: it said "The list of positions came back in a form this app does not accept."
  if (reply.kind === 'invalid') return <Empty title={`Position #${id}`} reason={reply.detail} />
  const answer = reply.body
  // §6.2: the chain's status before any of its values; an unavailable chain never shows zeros.
  const status = chainStatusOf(answer, target.chainId)
  if (!status || status.status === 'unavailable') return <Empty title={`Position #${id}`} reason={status?.reason ?? 'chain_unavailable'} />
  if (!found || !isLive(found)) {
    if (awaited) return <Waiting id={id} />
    // Added 2026-11-02 (the money review, M2): a position with no live read here (a root NFT burned by Change range or a
    // close, which read-v6 no longer lists, or one listed with no live read) whose vault this wallet still owns keeps that
    // vault's screen: Withdraw to wallet, Send to another address, the recoveries and Leave automation, as on Robinhood
    // Chain's own page. On Base, Arbitrum One and Robinhood Chain's v3 the page drew only this sentence, and Positions'
    // "Review in position" led nowhere else.
    const automation = ownVaultsOfPosition(answer, wallet, target.chainId, id, target.dex).length > 0
      ? <PositionAutomation tokenId={id} position={null} holder={null} chainId={target.chainId} dex={target.dex}
          indexed={{ portfolio: answer, subscriber: null }} onChanged={() => OWN_PORTFOLIO.again(wallet)} />
      : null
    if (!found) {
      return (
        <Empty title={`Position #${id}`} body={<Known line={knownLine(target, wallet)} sentence={COPY.page.notListed} />} reason="position_not_listed"
          action={<Button type="button" variant="outline" onClick={openWalletDialog} data-position-connect="">Open wallet</Button>} automation={automation} />
      )
    }
    return <Empty title={`Position #${id}`} reason={found.status} automation={automation} />
  }
  return (
    <PageShell>
      <Back />
      <LivePosition
        gate={gate}
        answer={answer}
        position={found}
        stale={status.status === 'stale' || found.freshness?.status === 'stale' || (latest !== null && latest.kind !== 'ok')}
        // Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): the marker's data only; it was a line under
        // the title ("Details couldn’t update. Showing the last available reading.", or a chain "unavailable right now").
        coverage={latest !== null && latest.kind !== 'ok' ? 'kept' : coverageNote(answer.chains) ? 'partial' : null}
        wallet={wallet}
        walletOnChain={walletOnChain}
        activity={activity}
        onChanged={() => OWN_PORTFOLIO.again(wallet)}
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
  // The page's moment (v4-position.css, html:not(.dm-booted)) plays when this page's figures arrive, as a page load does
  // in the approved V4 site; once it is over, later reads never run it again (the owner's silent updates, 2026-10-15).
  useEffect(() => {
    const timer = window.setTimeout(() => document.documentElement.classList.add('dm-booted'), 1200)
    return () => window.clearTimeout(timer)
  }, [])
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
  // (components/positions/KeyFigures.tsx), with token amounts in Details. As in creation, one qualified currency also
  // values the pair at this position's own pool price. This is a pool mark, not an independently qualified token quote.
  // Changed on purpose 2026-10-14 (the incident of 2026-10-13, package V1; decision D4): the dollars are its list row's
  // own (../lists/model.ts withUsd), worked out by the one valuation from this same answer, so the page and the row can
  // never differ; and a tile never says "USD unavailable": a figure that is not current says "as of HH:MM UTC" (the last
  // complete valuation, or any figure once no newer answer has arrived for two minutes: `late`), and with no figure the
  // two token amounts are the tile's figure, with one short reason under them.
  // Changed on purpose 2026-10-14 (package V1, review). `late` is the row's own, counted from when this page took the
  // answer (../lists/hooks.ts useUsdAged), not from this page's mount: opened from a list that already said "as of
  // 13:05 UTC", the tiles showed the same 13:05 figures with no time for two more minutes. Each tile says its own time
  // (one figure may be of now beside a kept one). And the time no longer takes the place of the basis: an estimate at
  // the pool's price that is not current says both, in its title and in Details (decision D3: "basis disclosed").
  const fresh = position.freshness?.status === 'fresh' && !stale
  const pair = [position.pool.currency0, position.pool.currency1] as const
  const row = useMemo(() => {
    const listed = answer.positions.find((one) => one.chainId === chainId && one.dex === position.dex && one.positionManager.toLowerCase() === position.manager && one.tokenId === position.tokenId.toString())
    return listed ? positionRows({ ...answer, positions: [listed] }, () => true)[0] ?? null : null
  }, [answer, chainId, position.dex, position.manager, position.tokenId])
  const [late] = useUsdAged([row?.usdSeenAt])
  const holdsUsd = row?.valueUsd ?? null
  const holdsText = holdsUsd !== null ? formatUsdFloor(holdsUsd) : null
  const feesUsd = row?.feesUsd ?? null
  const holdsAsOf = row ? usdAsOf(row, 'value', late) : undefined
  const feesAsOf = row ? usdAsOf(row, 'fees', late) : undefined
  const poolTitle = row?.usdPoolTitle
  const holdsTitle = usdTitleWords({ asOf: holdsAsOf, estimate: row?.valueUsdBasis === 'pool-price' ? poolTitle : undefined, block: position.snapshotBlock })
  const feesTitle = usdTitleWords({ asOf: feesAsOf, estimate: row?.feesUsdBasis === 'pool-price' ? poolTitle : undefined, block: position.snapshotBlock })
  // Details: the time of a figure that is not current (the kept one's first), then what an estimate is an estimate of.
  const datedAt = (holdsUsd !== null ? holdsAsOf : undefined) ?? (feesUsd !== null ? feesAsOf : undefined)
  const usdDetail = datedAt !== undefined || poolTitle ? usdTitleWords({ asOf: datedAt, estimate: poolTitle, block: null }) : undefined
  // Changed on purpose 2026-10-15 (pack 7, the owner: no status notices, "as of 02:25 UTC" named among them): a figure that
  // is not current is shown as it is: no time under it ("as of 13:05 UTC"), in its title or in Details ("Last complete
  // valuation, from …": ./usdAvailability.ts usdTitleWords); with no dollar figure, the two amounts carry no reason under
  // them or in their title, and Details no "USD valuation" line saying why. The basis of an estimate is still said
  // (decision D3); data-usd-snapshot marks a kept figure, data-usd-reason why one is missing.

  return (
    <div data-position-detail="" data-position-workspace-page="" data-position-id={position.tokenId.toString()} data-position-v2={`${chain.slug}-v${position.dex}`} data-snapshot={position.snapshotBlock ?? undefined}>
      <div className="dm-pos-title">
        <div className="dm-pos-name">
          <TokenMarkPair base={base} quote={quote} size={phone ? 36 : 46} ring="var(--bg)" />
          <div className="min-w-0">
            <Display as="h1" className="dm-display-h1 dm-pos-pair">
              <PairName card={card} />
            </Display>
            <div className="dm-pos-chips">
              {/* As V1's page: the venue and the fee; the Uniswap version only as the title and under Details (the lists' rule). */}
              <Chip title={COPY.page.version(position.dex)} className="dm-pos-tag">
                <span>
                  <span className="dm-pos-tag-seg">{COPY.page.uniswap}</span><span className="dm-pos-tag-sep"> · </span><span className="dm-pos-tag-seg"><span data-fee="">{feeTierText(position.pool.fee)}</span> fee</span>
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
            {coverage && <span hidden data-position-coverage={coverage} />}
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
                  <IconCollect size={18} /><span>{COPY.button.collect}</span>
                </Button>
                <MoreActions id={`position-v2-more-${position.tokenId}`} items={items} onPick={(key) => { if (key !== 'protect') setMode(key) }} data-position-v2-actions={gate.mode} />
              </>
            )}
            <span ref={setAutomationToolbar} className="dm-position-automation-slot" data-position-automation-slot="" />
            {/* Added 2026-10-15 (the owner: always a Close position, as Robinhood's): V1's button (components/positions/
                PositionActions.tsx), same place and look, last in the row; Withdraw of everything in both tokens. */}
            {items.length > 0 && action.liquidity > 0n && (
              <Button type="button" variant="danger" disabled={hooked} title={hooked ? HOOKED_COPY : undefined} aria-haspopup="dialog" aria-expanded={mode === 'close'} data-position-action="close" onClick={() => setMode('close')}>
                <IconClose size={18} /><span>{COPY.title.close}</span>
              </Button>
            )}
          </div>
        )}
      </div>

      <PositionAutomation tokenId={position.tokenId.toString()} position={automationPosition} holder={position.owner}
        chainId={chainId} dex={position.dex} priceContext={{ block: position.snapshotBlock, saved: stale }}
        indexed={{ portfolio: answer, subscriber: position.custody.subscriber }} toolbar={automationToolbar} onChanged={onChanged} />
      <StatStrip layout="tiles" className="dm-pos-stats" title={position.snapshotBlock !== null ? `Read at block ${position.snapshotBlock}` : undefined} data-position-stats="" data-position-overview="">
        <Stat
          label="Position value"
          info={COPY.page.holdsInfo}
          className="dm-pos-stat"
          data-cell="principal"
          data-value-width={holdsText && holdsText.length > 11 ? 'wide' : holdsText && holdsText.length > 8 ? 'medium' : undefined}
          data-usd-reason={holdsUsd === null ? row?.usdReason : undefined}
        >
          {holdsUsd !== null ? (
            <span className="dm-arrive" title={holdsTitle} data-usd="principal" data-usd-basis={row?.valueUsdBasis} data-usd-snapshot={row?.usdSavedAt !== undefined && row.usdNow?.figure !== 'value' ? '' : undefined} data-usd-dated={holdsAsOf !== undefined ? '' : undefined}>
              <LiveFigure value={holdsText!} mode="digits" dimCents className="dm-fig-lg" />
            </span>
          ) : (
            <span className="dm-pos-amounts" data-usd-amounts="principal"><CardAmount amount={card.principal[0]} /><CardAmount amount={card.principal[1]} /></span>
          )}
        </Stat>
        <Stat
          label={COPY.page.fees}
          info={position.dex === 3 ? COPY.page.collectableInfo : COPY.page.feesInfo}
          className="dm-pos-stat"
          data-cell="fees"
          data-usd-reason={feesUsd === null ? row?.usdReason : undefined}
        >
          {feesUsd !== null ? (
            <span data-usd="fees" title={feesTitle} data-usd-basis={row?.feesUsdBasis} data-usd-snapshot={row?.usdSavedAt !== undefined && row.usdNow?.figure !== 'fees' ? '' : undefined} data-usd-dated={feesAsOf !== undefined ? '' : undefined}>
              <UsdText value={feesUsd} block={feesAsOf !== undefined ? undefined : position.snapshotBlock ?? undefined} floor className={cx('dm-fig-lg dm-arrive', /[1-9]/.test(feesUsd) && 'dm-fees-in')} />
            </span>
          ) : (
            <span className="dm-pos-amounts" data-usd-amounts="fees"><CardAmount amount={card.unsettledFees[0]} /><CardAmount amount={card.unsettledFees[1]} /></span>
          )}
        </Stat>
        {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): a dash, with no "Fee history unavailable" under it or as its title. */}
        <Stat label={COPY.page.apr} info={COPY.page.aprInfo} className="dm-pos-stat" data-cell="apr" data-apr="no_qualified_source">
          <span className="dm-fig-lg"><FigureDash /></span>
        </Stat>
        <Stat label={COPY.page.price} info={COPY.page.priceInfo} className="dm-pos-stat dm-lit" data-cell="price" sub={<span className="dm-pos-span-state" data-in={String(card.inRange)} data-ember-rest="">{card.hasLiquidity ? (card.inRange ? COPY.page.inRangeEarning : COPY.page.outOfRangeIdle) : COPY.page.closed}</span>}>
          <span data-stat="price">
            {/* The same price presentation as KeyFigures: one figure, then its unambiguous quote unit. */}
            {price.state.phase === 'ready' && price.state.price.state === 'usable' ? (
              <span className="dm-pos-price" data-current-price="usable" title={`Pool price at block ${price.state.price.block}: ${price.state.price.text}`}>
                {/* Changed on purpose 2026-10-03: the price is the app's one way round (lib/read/orientation.ts), so its two
                    sides are too; the pool's own order wrote "1 ETH = 0.0₆7101 MANY" for MANY's price in ETH. */}
                <span className="dm-fig-lg">{readablePrice(price.state.price.text)}</span>{' '}
                <span className="dm-pos-price-side dm-pos-price-unit">{labelOf(book, priced.quote)} per {labelOf(book, priced.base)}</span>
              </span>
            ) : (
              <span className="dm-fig-lg text-fg-subtle" data-current-price="unusable">—</span>
            )}
          </span>
        </Stat>
      </StatStrip>

      <div className="dm-pos-grid">
        {chainId !== 4663 ? <RecordedInsights key={`${chainId}:${position.manager}:${position.tokenId}:${card.poolId}`} answer={answer} position={position} card={card} price={price} book={book} fresh={fresh} /> : <section className="dm-card dm-pos-card" aria-labelledby="position-range-title">
          <h2 id="position-range-title" className="dm-title">
            {COPY.page.rangeTitle}
          </h2>
          {/* The pool's stored price history (2026-10-03, the owner's point 10): kept by the read service for Robinhood
              Chain's Uniswap v4 pools only. */}
          <PositionRange card={card} price={price} variant="page" history={chainId === 4663 && position.dex === 4} openedAt={activityOpenedAt(activity?.kind === 'ok' ? activity.body : null, position)} />
        </section>}

        <PositionHistory wallet={wallet} position={{ chainId, dex: position.dex, tokenId: position.tokenId.toString() }} />

        <details className="dm-card dm-pos-details" data-position-details="">
          <summary className="dm-pos-details-head">
            <h2 className="dm-title">{COPY.page.details}</h2>
            <span className="dm-pos-details-hint">{COPY.page.detailsHint}</span>
            <IconChevronDown size={16} />
          </summary>
          <KeyValueList className="dm-pos-facts">
            <KeyValue label="Tokens in this position"><span className="dm-pos-amounts" data-stat="principal"><CardAmount amount={card.principal[0]} /><CardAmount amount={card.principal[1]} /></span></KeyValue>
            <KeyValue label="Fees ready to collect"><span className="dm-pos-amounts" data-stat="fees"><CardAmount amount={card.unsettledFees[0]} /><CardAmount amount={card.unsettledFees[1]} /></span></KeyValue>
            {usdDetail && <KeyValue label="USD valuation"><span data-usd-detail="">{usdDetail}</span></KeyValue>}
            {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): Details no longer says what isn't available
                ("APR data: Lifetime fee history isn’t available from this network’s current data source…", "USD valuation: …",
                a token's price "temporarily unavailable"); a pool-price estimate's basis is still named (decision D3). */}
            {chainId !== 4663 && poolTitle && pair.filter((_, index) => (position.principal?.[index] ?? 0n) > 0n || (position.feesOwed?.[index] ?? 0n) > 0n).map(address => {
              const token = answer.tokens.find(item => item.chainId === chainId && item.address.toLowerCase() === address)
              if (token?.price || !token?.priceReason) return null
              return <KeyValue key={address} label={`${labelOf(book, address)} independent price`}><span data-usd-price-reason={token.priceReason}>No independently qualified quote. The USD estimate above uses this position’s pool price.</span></KeyValue>
            })}
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
        <PositionDialog gate={gate} position={action} mode={mode} book={book} reserves={reserves} available={position.principal} onClose={() => setMode(null)} onDone={onChanged} />
      )}
    </div>
  )
}
