import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ActivityResponse, PortfolioResponse } from 'api-contracts/read-v6/types'
import { IconChevronDown, IconChevronLeft, IconClose, IconMarkets, IconPlus, IconSearch, IconWalletLine } from '../../components/icons'
import { newNetworkHref, newPositionHref, poolHref, positionsHref } from '../../components/explore/routes'
import { poolNetworkHref } from '../../components/explore/poolNetwork'
import { positionsListHref, viewedPositionsAddress } from '../../components/positions/listHref'
import { openWalletDialog } from '../../finance/signedOut'
import { IconCollect } from '../../components/positions/actionIcons'
import { PositionRange, chainCardPrice, preloadPriceChart } from '../../components/positions/PositionRange'
import { Amounts, FigureDetail, KEY_FIGURES_COPY as KEY, PriceNow, RangeLine, ValueSplit } from '../../components/positions/keyFigureParts'
import { AUTOMATION_NAME } from '../../components/positions/visual/AutomationImpact'
import { basisOf, rawPair, valueShares } from '../../components/positions/visual/value'
import { activityOpenedAt } from '../../lib/chart/positionOpened'
import { cardPoolUsableForDomino } from '../../lib/read/screens/positions'
import { walletState } from '../../lib/walletCards'
import { chainMarkProps } from '../../lib/chainMarks'
import { Amount as CardAmount, PairName, PositionStatus } from '../../components/positions/PositionFigures'
import { PositionSkeleton } from '../../components/positions/visual/PositionSkeleton'
import { Address } from '../../components/read/screens/Address'
import { TokenMarkPair } from '../../components/TokenIcon'
import { Button, Chip, Display, EmptyState, FigureDash, KeyValue, KeyValueList, LinkButton, PageShell, Stat, StatStrip, cx } from '../../components/ui'
import { LiveFigure, UsdText } from '../../components/figures'
import { formatUsdFloor } from '../../lib/format/usd'
import { useRouteTitle } from '../../lib/routeTitle'
import { useMediaQuery } from '../../lib/useMediaQuery'
import { useWalletIdentity } from '../../lib/walletIdentity'
import { newPositionExpected } from '../../lib/automate/autoExitAsk'
import { chainHasDex, v2Chain } from '../../v2/chains'
import type { V2Gate } from '../../v2/gate'
import { useHealingGate } from '../automate/gate'
import { feeTierText } from '../../v2/plan/present'
import { coverageNote } from '../../v2/read/v6'
import { ZERO_ADDRESS, type Address as TokenAddress, type V2ChainId } from '../../v2/types'
import { networkPoolToken } from '../journey/model/networks'
import { networkPoolListed } from './networkPool'
import { parseV2PositionParam, type V2PositionRef } from '../route'
import { ApprovalFact, useZapApproval } from './Approval'
import { cardOf, poolIdentity, walletPositionOf } from './card'
import PositionAutomation from '../automate/PositionAutomation'
import { ownVaultsOfPosition } from '../automate/portfolio'
import { exitOrderKey } from '../autoexit/entry'
import { HOOKED_COPY, NEW_POSITION_REREAD_MS } from './constants'
import { COPY } from './copy'
import { chainStatusOf, findPosition, fromV6, hookedPool, isLive, tokensOf, vaultReservesOf, type LiveV6Position } from './model'
import { MoreActions, positionMenuItems } from './MoreActions'
import { PositionDialog, type PositionMode } from './PositionDialog'
import type { V6Read } from './source'
import { tokenBook } from './tokens'
import { useActivityHistory } from '../lists/activity'
import PositionHistory from '../lists/PositionHistory'
import { useCreatedPositions, useKeyed, useKeyedLatest, useUsdAged } from '../lists/hooks'
import { useNewPositionWait, useQuickPortfolio } from '../lists/newPositionWait'
import { ADDING_POSITION, RELOAD_WORDS, useWaitOver } from '../../lib/readWait'
import { OWN_PORTFOLIO } from '../lists/source'
import { positionRows, usdAsOf } from '../lists/model'
import type { OpenGate } from './wallet'
import RecordedInsights from './RecordedInsights'
import { YourAprStat } from '../../components/positions/YourAprStat'
import { burnedAt, compoundingKind, storedAutomaticAdds, storedFeesEvents, storedHistoryWords, usePositionFees, useStoredPosition } from './positionFees'
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

/**
 * The page while its gate, its read or its chunk is on the way: the page frame, as V1's page waits. `reason` (2026-11-09,
 * core flows): why it waits, as data, while a read that failed is asked again; `line`: the one line it says meanwhile (a
 * position just created being listed), in place of the screen reader's own.
 */
function Waiting({ id, reason, line }: { id: string; reason?: string; line?: string }) {
  return (
    <PageShell>
      <Back />
      <div data-position-loading="" aria-busy="true" data-position-reason={reason}>
        {line ? <p role="status" className="dm-pos-adding" data-position-adding="">{line}</p> : <p role="status" className="sr-only">{COPY.page.reading(id)}</p>}
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
 *
 * Changed on purpose 2026-11-06 (the owner: Base and Arbitrum One an exact copy of Robinhood Chain's page, only the
 * network changes): Robinhood Chain's four tiles (dollars with their Token amounts and split bar, the price with its range
 * bar), its charts before the grid, its Details (Pool id, New position in this pool, Fees history; no "Read at block"),
 * Collect fees off with why when there is nothing to collect, the page of another address's position read by anyone from
 * that address's list, and, from read-v6's `position-fees` once its route is open, Fees earned, Your APR, the
 * automation's lines, Activity's settlements and an NFT that no longer exists, each as Robinhood Chain's page says it.
 */
export default function PositionPage({ param, list }: { param: string; list: ReactNode }) {
  // A position of a version its network lacks (v3 on a chain with v4 alone) is no position there: the list, as for any
  // other address the route does not name, and nothing of it is read.
  const ref = useMemo(() => {
    const named = parseV2PositionParam(param)
    return named && chainHasDex(named.chainId, named.dex) ? named : null
  }, [param])
  const identity = useWalletIdentity()
  const wallet = identity.kind === 'connected' ? identity.address.toLowerCase() : null
  const walletChain = identity.kind === 'connected' ? identity.chainId : null
  // Changed on purpose 2026-11-09 (the core-flows fix, item a): asked again by itself while it is not live
  // (../automate/gate.tsx useHealingGate); asked once per page, a passing failure of its probe stayed until a reload.
  const gate: V2Gate | null = useHealingGate('s1', ref?.chainId ?? 0)
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

/**
 * (2026-11-06, O-14) An NFT the stored history (read-v6 `position-fees`) says is burned: Robinhood Chain's own page for
 * one (screens/PositionDetail.tsx, phase `gone`), its title, body and way back. `automation`: the wallet's vault of it.
 */
function Gone({ id, block, automation }: { id: string; block: number; automation?: ReactNode }) {
  return (
    <PageShell>
      <Back />
      {automation}
      <EmptyState icon={<IconSearch />} title={COPY.page.gone} body={COPY.page.goneAt(id, block)} plate className="dm-pos-empty"
        action={<LinkButton href={positionsHref} variant="outline" size="sm">{COPY.page.back}</LinkButton>} data-empty="position-gone" data-position-reason="burned" />
    </PageShell>
  )
}

function Opened({ target, gate, wallet, walletOnChain }: { target: V2PositionRef; gate: OpenGate; wallet: string | null; walletOnChain: boolean }) {
  // The portfolio is the connected wallet's (never an empty owner to read-v6). Added 2026-11-06 (O-05, the owner: every
  // chain the same as Robinhood Chain, whose page anyone reads): a page opened from another address's list (View address)
  // also reads that address's portfolio, which read-v6 serves with no sign-in, the same read its list made; the page is
  // then that address's, with no action. A bare link with no list behind it still needs the holder's wallet.
  const viewed = viewedPositionsAddress()
  const other = viewed !== null && viewed !== wallet ? viewed : null
  const needsWallet = wallet === null && other === null
  const reply = useKeyed(OWN_PORTFOLIO, wallet)
  const latest = useKeyedLatest(OWN_PORTFOLIO, wallet)
  const otherReply = useKeyed(OWN_PORTFOLIO, other)
  const otherLatest = useKeyedLatest(OWN_PORTFOLIO, other)
  const created = useCreatedPositions(wallet)
  const id = target.tokenId.toString()
  useRouteTitle(`Position #${id}`)
  // The stored history's word on the NFT (read-v6 `position-fees`, asked only while the route's capabilities name it):
  // the same read the page's Fees earned card makes.
  const storedRef = useMemo(() => ({ chainId: target.chainId, dex: target.dex, tokenId: id }), [target.chainId, target.dex, id])
  const burned = burnedAt(useStoredPosition(storedRef).position)

  // The figures, Activity and automation share one wallet-keyed snapshot. A known creation remains discoverable
  // while the index catches up; it never supplies fabricated balances or permits actions before the live read.
  const found = reply?.kind === 'ok' ? findPosition(reply.body, target.chainId, target.dex, target.tokenId) : null
  const elsewhere = otherReply?.kind === 'ok' ? findPosition(otherReply.body, target.chainId, target.dex, target.tokenId) : null
  const viewing = !(found && isLive(found)) && elsewhere !== null && isLive(elsewhere) && otherReply?.kind === 'ok' && chainStatusOf(otherReply.body, target.chainId)?.status !== 'unavailable'
  const holder = viewing ? other : wallet
  const history = useActivityHistory(holder)
  const activity = useMemo<V6Read<ActivityResponse> | null>(() => history.answer ? { kind: 'ok', body: history.answer } : history.error, [history.answer, history.error])
  const creation = created.find(item => item.chainId === target.chainId && item.dex === target.dex && item.tokenId === id)
  const awaited = reply !== null && !(found && isLive(found)) && newPositionExpected(exitOrderKey(id, target.chainId, target.dex))
  useEffect(() => {
    // Preserve Robinhood's existing arrival cadence. Other chains use the shared bounded catch-up policy.
    if (!awaited || target.chainId !== 4663 || !wallet) return
    const timer = setTimeout(() => OWN_PORTFOLIO.again(wallet), NEW_POSITION_REREAD_MS)
    return () => clearTimeout(timer)
  }, [awaited, reply, target.chainId, wallet])
  // Added 2026-11-09 (core flows, the owner: nothing may load forever, nothing slow when it can be fast). A position this
  // browser just created waits for read-v6 with its one line, the list asked again every few seconds
  // (../lists/newPositionWait.ts), for five minutes at most and no longer than STUCK_MS of failed answers. Any other page
  // with nothing to draw (the list failed, the network or the position not read) keeps its loading frame while the list is
  // asked again by itself, and says what to do after STUCK_MS. Both drew the title alone, for good.
  const adding = creation !== undefined && !(found && isLive(found))
  const addingWait = useNewPositionWait(creation)
  const failing = useWaitOver(reply !== null && reply.kind !== 'ok')
  const awaitingNew = adding && addingWait && !failing
  useQuickPortfolio(viewing ? null : wallet, awaitingNew)
  const okStatus = reply?.kind === 'ok' ? chainStatusOf(reply.body, target.chainId) : null
  const unread = !viewing && wallet !== null && !adding && reply !== null
    && (reply.kind !== 'ok' || !okStatus || okStatus.status === 'unavailable' || (found !== null && !isLive(found) && !awaited))
  const unreadLong = useWaitOver(unread)

  if (viewing && otherReply?.kind === 'ok' && elsewhere && isLive(elsewhere)) {
    const status = chainStatusOf(otherReply.body, target.chainId)
    return (
      <PageShell>
        <Back />
        <LivePosition gate={gate} answer={otherReply.body} position={elsewhere} holder={other}
          stale={status?.status === 'stale' || elsewhere.freshness?.status === 'stale' || (otherLatest !== null && otherLatest.kind !== 'ok')}
          coverage={otherLatest !== null && otherLatest.kind !== 'ok' ? 'kept' : coverageNote(otherReply.body.chains) ? 'partial' : null}
          wallet={wallet} walletOnChain={walletOnChain} activity={activity} onChanged={() => { if (other) OWN_PORTFOLIO.again(other) }} />
      </PageShell>
    )
  }
  // Another address's list is still being read: the page waits in its frame, as for its own.
  if (other !== null && otherReply === null && !(found && isLive(found))) return <Waiting id={id} />
  if (needsWallet || wallet === null) {
    if (burned !== null) return <Gone id={id} block={burned} />
    return (
      <Empty title={`Position #${id}`} body={<Known line={knownLine(target, wallet)} sentence={COPY.page.connect} />} reason="connect_wallet"
        action={<Button type="button" onClick={openWalletDialog} data-position-connect=""><IconWalletLine size={16} />Connect wallet</Button>} />
    )
  }
  // Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): a page with nothing read yet, or whose read
  // failed (it is asked again), shows its title alone, its reason as data. It said "Updating position details…", "Your
  // positions can’t be listed right now.", "{chain} can’t be read right now.", "This position can’t be read right now."
  // or "Not read yet".
  // Changed on purpose 2026-11-09 (core flows): see `adding` and `unread` above; the reasons stay as data.
  if (creation && !(found && isLive(found))) return awaitingNew ? <Waiting id={id} reason="awaiting_index" line={ADDING_POSITION} />
    : <Empty title={`Position #${id}`} body={RELOAD_WORDS.position} reason="awaiting_index" />
  if (reply === null) return <Waiting id={id} />
  const unreadPage = (reason: string) => unreadLong ? <Empty title={`Position #${id}`} body={RELOAD_WORDS.position} reason={reason} /> : <Waiting id={id} reason={reason} />
  if (reply.kind === 'unavailable') return unreadPage(reply.reason)
  // (QA round 2, SWEEP) Its title alone, as for a read that failed: it said "The list of positions came back in a form this app does not accept."
  if (reply.kind === 'invalid') return unreadPage(reply.detail)
  const answer = reply.body
  // §6.2: the chain's status before any of its values; an unavailable chain never shows zeros.
  const status = chainStatusOf(answer, target.chainId)
  if (!status || status.status === 'unavailable') return unreadPage(status?.reason ?? 'chain_unavailable')
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
      if (burned !== null) return <Gone id={id} block={burned} automation={automation} />
      return (
        <Empty title={`Position #${id}`} body={<Known line={knownLine(target, wallet)} sentence={COPY.page.notListed} />} reason="position_not_listed"
          action={<Button type="button" variant="outline" onClick={openWalletDialog} data-position-connect="">Open wallet</Button>} automation={automation} />
      )
    }
    // Changed on purpose 2026-11-09 (core flows): with the wallet's automation of it, that card at once, as before; the plate
    // under it says what to do after STUCK_MS. With none, the loading frame until then (it was the title alone).
    if (!automation) return unreadPage(found.status)
    return <Empty title={`Position #${id}`} body={unreadLong ? RELOAD_WORDS.position : undefined} reason={found.status} automation={automation} />
  }
  return (
    <PageShell>
      <Back />
      <LivePosition
        gate={gate}
        answer={answer}
        position={found}
        holder={wallet}
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

/**
 * (Review F1, UI-2, 2026-11-06) Whether the network's pools read for `token` lists the pool `poolId` (./networkPool.ts):
 * asked once per pool and token, false until it does, and on Robinhood Chain or with no token. The page's gate at mount is
 * enough: the read is public chain data, whichever way the gate opens later.
 */
function useNetworkPoolListed(gate: OpenGate, chainId: V2ChainId, token: TokenAddress | null, poolId: string): boolean {
  const ask = chainId !== 4663 && token !== null ? `${chainId}|${token}|${poolId.toLowerCase()}` : null
  const gateAtMount = useRef(gate)
  const [listed, setListed] = useState<string | null>(null)
  useEffect(() => {
    if (ask === null || token === null || chainId === 4663) return
    const controller = new AbortController()
    void networkPoolListed(gateAtMount.current, chainId, token, poolId, controller.signal).then((yes) => {
      if (yes && !controller.signal.aborted) setListed(ask)
    }, () => undefined)
    return () => controller.abort()
  }, [ask, chainId, token, poolId])
  return ask !== null && listed === ask
}

/** A dollar figure as the key figures write it (components/positions/KeyFigures.tsx): whole groups once it is long. */
function ValueFigure({ text }: { text: string }) {
  const long = text.length > 13
  return (
    <LiveFigure value={text} mode={long ? 'whole' : 'digits'} dimCents className={cx('dm-fig-lg', long && 'dm-position-long-figure')}>
      {long && text.split(/(?<=,)/).map((part, index) => <span className="dm-position-amount-group" key={index}>{part}</span>)}
    </LiveFigure>
  )
}

function LivePosition({ gate, answer, position, holder, stale, coverage, wallet, walletOnChain, activity, onChanged }: {
  gate: OpenGate
  answer: PortfolioResponse
  position: LiveV6Position
  /** Whose portfolio `answer` is: the connected wallet's, or (O-05) the address whose list the page was opened from. */
  holder: string | null
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
  const storedFees = usePositionFees(useMemo(() => ({ chainId, dex: position.dex, tokenId: position.tokenId.toString() }), [chainId, position.dex, position.tokenId]), book)
  const action = useMemo(() => fromV6(position, answer), [position, answer])
  const automationPosition = useMemo(() => walletPositionOf(position, book), [position, book])
  const reserves = position.vault ? vaultReservesOf(answer, chainId, position.vault.address) : null
  const price = chainCardPrice(card, { sqrtPriceX96: position.sqrtPriceX96.toString(10), tick: position.tick, block: position.snapshotBlock ?? 0 })
  const phone = useMediaQuery('(max-width: 767px)')
  // The page's moment (v4-position.css, html:not(.dm-booted)) plays when this page's figures arrive, as a page load does
  // in the approved V4 site; once it is over, later reads never run it again (the owner's silent updates, 2026-10-15).
  useEffect(() => {
    const timer = window.setTimeout(() => document.documentElement.classList.add('dm-booted'), 1200)
    return () => window.clearTimeout(timer)
  }, [])
  const [mode, setMode] = useState<PositionMode | null>(null)
  const [automationToolbar, setAutomationToolbar] = useState<HTMLSpanElement | null>(null)
  const [base, quote] = card.currencies
  const owner = position.owner
  const successor = position.vault?.role === 'successor'
  // The owner's actions: the connected wallet that holds it. A successor is held by the wallet's vault (read-v6 lists it
  // in the wallet's portfolio): its sentence, no action. (2026-11-06, O-05) Only in the connected wallet's own portfolio:
  // another address's vault is never this wallet's.
  const heldByVault = successor && position.vault !== null && owner === position.vault.address
  // (2026-11-06, O-05 review) Whether `answer` is the connected wallet's own portfolio. Another address's (View address) is
  // read with none of its owner's automation and no "Your automation" line: Robinhood Chain's page shows anyone but the
  // owner none (its automation reads the connected wallet's own portfolio, which never holds this position).
  const ownRead = wallet !== null && answer.wallet.toLowerCase() === wallet
  const mine = wallet !== null && (owner === wallet || (heldByVault && ownRead))
  const approval = useZapApproval(gate, mine ? action : null, walletOnChain)
  const hooked = hookedPool(position.pool)
  const items = action ? positionMenuItems(action, false) : []
  const identity = poolIdentity(chainId, position.pool)
  // (QA round 2, N43, as Robinhood Chain's page) Opened from the holder's own list: whose the actions are.
  const fromHolderList = viewedPositionsAddress() === owner
  // Added 2026-10-06 (read-v6 1.1.0-rc.1's qualified USD): what it holds and its fees in USD, as V1's page shows them
  // (components/positions/KeyFigures.tsx), with token amounts under each tile. As in creation, one qualified currency also
  // values the pair at this position's own pool price. This is a pool mark, not an independently qualified token quote.
  // Changed on purpose 2026-10-14 (the incident of 2026-10-13, package V1; decision D4): the dollars are its list row's
  // own (../lists/model.ts withUsd), worked out by the one valuation from this same answer, so the page and the row can
  // never differ; and a tile never says "USD unavailable": with no figure the two token amounts are the tile's figure.
  // `late` is the row's own, counted from when this page took the answer (../lists/hooks.ts useUsdAged). An estimate at
  // the pool's price says so in its title and in Details (decision D3: "basis disclosed").
  const fresh = position.freshness?.status === 'fresh' && !stale
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
  // Changed on purpose 2026-11-06 (O-07, the owner: every chain the same as Robinhood Chain): Robinhood Chain's split of the
  // value between its two tokens, under the tile's Token amounts; the share is the same in any unit, so the quote token's.
  const state = useMemo(() => walletState(automationPosition, position.snapshotBlock ?? 0, owner), [automationPosition, position.snapshotBlock, owner])
  const shares = useMemo(() => {
    const basis = state ? basisOf(state) : null
    const raw = rawPair([card.principal[0].raw, card.principal[1].raw])
    return basis && raw ? valueShares(basis, raw) : null
  }, [state, card])
  // Changed on purpose 2026-11-06 (O-09): Robinhood Chain's own rule, nothing to collect (both fees zero, or not read) is a
  // button that is off, with why (components/positions/PositionActions.tsx collectReason). A closed v3 position may still
  // owe tokens, so a closed position with fees owed can still collect them.
  // (Review, 2026-11-06) A closed position with nothing to collect says so in Robinhood Chain's own words, never "yet".
  const fees = position.feesOwed
  const noFees = fees === null || (fees[0] === 0n && fees[1] === 0n)
  // Changed on purpose 2026-11-09 (the core-flows fix, item d): fees that were not read (null) no longer turn Collect fees
  // off with a reason only a mouse could see: it opens, and its dialog reads the fees on chain itself (and says when there
  // is nothing to collect). Nothing to collect, a closed position and a hooked pool stay off, as before.
  const collectOff = hooked ? 'hooked' : !noFees ? undefined : position.liquidity === 0n ? 'closed' : fees === null ? undefined : 'no_fees'
  const collectReason = collectOff === 'hooked' ? HOOKED_COPY : collectOff === 'closed' ? COPY.page.closedNoLiquidity : collectOff === 'no_fees' ? COPY.page.noFees : undefined
  // Added 2026-11-06 (O-06, O-11): the stored history's settlements in Activity, outside changes included, and the
  // automation's re-adds named, as Robinhood Chain's Activity lists its ledger's.
  const kind = compoundingKind(answer, position)
  const storedEvents = useMemo(() => storedFeesEvents(position.tokenId.toString(), storedFees, book), [position.tokenId, storedFees, book])
  const automatic = useMemo(() => storedAutomaticAdds(storedFees, kind, book, AUTOMATION_NAME), [storedFees, kind, book])
  // (O-12) Robinhood Chain's links under Details: New position in this pool, into a pool Domino can open a position in
  // (no hooks, a fixed fee); on Base and Arbitrum One by New position's own network link, which reads the pool again.
  // Changed on purpose 2026-11-06 (INT-1, rep/mkt merged): the Pool button too, Robinhood Chain's v4 pools' page there,
  // and on Base and Arbitrum One the network's pool page (components/explore/poolNetwork.ts), which shows a pool its
  // network's pools read lists for that token: one Domino can open a position in, as New position's link.
  // Changed on purpose 2026-11-06 (review F1, UI-2): on Base and Arbitrum One both links name the token whose pools read
  // has this pool's key (networkPoolToken: a WETH/ARB pool is ARB's, never WETH's), and appear only once that read lists
  // the pool (it leaves out a pool with no active liquidity); otherwise neither, never a link to "We couldn't find this pool".
  const token = base.address === ZERO_ADDRESS ? quote.address : base.address
  const usable = cardPoolUsableForDomino(card)
  const networkToken = useMemo(() => (chainId === 4663 || !usable ? null : networkPoolToken(chainId, position.pool)), [chainId, usable, position.pool])
  const listed = useNetworkPoolListed(gate, chainId, networkToken, card.poolId)
  const opensOnNetwork = chainId !== 4663 && networkToken !== null && listed ? networkToken : null
  const newHref = !usable ? null : chainId === 4663 ? (position.dex === 4 ? newPositionHref(card.poolId, token) : null) : opensOnNetwork ? newNetworkHref(chainId, opensOnNetwork, card.poolId) : null
  const poolPage = chainId === 4663 ? (position.dex === 4 ? poolHref(card.poolId, token) : null) : opensOnNetwork ? poolNetworkHref(chainId, card.poolId, opensOnNetwork) : null

  return (
    <div data-position-detail="" data-position-workspace-page="" data-position-id={position.tokenId.toString()} data-position-v2={`${chain.slug}-v${position.dex}`} data-snapshot={position.snapshotBlock ?? undefined} data-position-read={holder === wallet ? undefined : 'viewed'}>
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
                {/* Changed on purpose 2026-11-07 (Elysium's screens): a network drawn from its own file shows its mark (lib/chainMarks.ts). */}
                <span data-position-network={chain.slug} {...chainMarkProps(chain.chainId)}>{chain.name}</span>
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
            {/* Changed on purpose 2026-11-09 (the core-flows fix): a position Domino-compound holds has Close position, last in
                the row (below): it said "Your automation holds this position. Withdraw it from your automation on your main
                position's page first." and offered nothing. */}
            {items.length === 0 ? null : (
              <>
                <Button type="button" variant="primary" disabled={collectOff !== undefined} title={collectReason} data-position-v2-action="collect" data-position-collect-off={collectOff} onClick={() => setMode('collect')}>
                  <IconCollect size={18} /><span>{COPY.button.collect}</span>
                </Button>
                <MoreActions id={`position-v2-more-${position.tokenId}`} items={items} onPick={(key) => { if (key !== 'protect') setMode(key) }} data-position-v2-actions={gate.mode} />
              </>
            )}
            <span ref={setAutomationToolbar} className="dm-position-automation-slot" data-position-automation-slot="" />
            {/* Added 2026-10-15 (the owner: always a Close position, as Robinhood's): V1's button (components/positions/
                PositionActions.tsx), same place and look, last in the row; Withdraw of everything in both tokens. */}
            {/* Changed on purpose 2026-11-09: also for a position Domino-compound holds (its dialog withdraws it first). */}
            {(items.length > 0 || heldByVault) && action.liquidity > 0n && (
              <Button type="button" variant="danger" disabled={hooked} title={hooked ? HOOKED_COPY : undefined} aria-haspopup="dialog" aria-expanded={mode === 'close'} data-position-action="close" onClick={() => setMode('close')}>
                <IconClose size={18} /><span>{COPY.title.close}</span>
              </Button>
            )}
          </div>
        )}
        {/* (2026-11-06, O-05) Robinhood Chain's line (screens/PositionDetail.tsx, QA round 2 N43): anyone but the owner wallet
            reads this page with no action on it; opened from the holder's own list, it says whose they are. */}
        {!mine && fromHolderList && card.hasLiquidity && (
          <p className="max-w-md text-body text-fg-muted" data-position-owner-only={wallet !== null ? 'other-wallet' : 'no-wallet'}>
            {wallet !== null
              ? <>{COPY.page.ownerOnly.connected[0]} <Address value={owner} short /> {COPY.page.ownerOnly.connected[1]}</>
              : <>{COPY.page.ownerOnly.disconnected[0]} <Address value={owner} short /> {COPY.page.ownerOnly.disconnected[1]}</>}
          </p>
        )}
      </div>

      {ownRead && (
        <PositionAutomation tokenId={position.tokenId.toString()} position={automationPosition} holder={position.owner}
          chainId={chainId} dex={position.dex} priceContext={{ block: position.snapshotBlock, saved: stale }}
          indexed={{ portfolio: answer, subscriber: position.custody.subscriber }} toolbar={automationToolbar} onChanged={onChanged} />
      )}
      {/* Changed on purpose 2026-11-06 (O-07, O-08, O-13; the owner: every chain the same as Robinhood Chain): Robinhood
          Chain's four tiles (components/positions/KeyFigures.tsx), drawn with its own parts: each dollar figure with its
          Token amounts under it (the value's split bar too), and the price with the range bar, its two ends and whether it
          earns. No title on the strip (QA round 2, R23: it said "Read at block N"). */}
      <StatStrip layout="tiles" className="dm-pos-stats" data-position-stats="" data-position-overview="" data-valued={holdsUsd !== null ? '' : undefined}>
        <Stat
          label={KEY.value}
          info={KEY.valueInfo}
          className="dm-pos-stat"
          data-cell="principal"
          data-long-value={holdsText && holdsText.length > 13 ? '' : undefined}
          data-value-width={holdsText && holdsText.length > 11 ? 'wide' : holdsText && holdsText.length > 8 ? 'medium' : undefined}
          data-usd-reason={holdsUsd === null ? row?.usdReason : undefined}
          sub={holdsUsd !== null ? (
            <FigureDetail active label={KEY.tokenAmounts}>
              <ValueSplit shares={shares} />
              <Amounts card={card} which="principal" />
            </FigureDetail>
          ) : null}
        >
          {holdsUsd !== null ? (
            <span className="dm-arrive" title={holdsTitle} data-usd="principal" data-usd-basis={row?.valueUsdBasis} data-usd-snapshot={row?.usdSavedAt !== undefined && row.usdNow?.figure !== 'value' ? '' : undefined} data-usd-dated={holdsAsOf !== undefined ? '' : undefined}>
              <ValueFigure text={holdsText!} />
            </span>
          ) : (
            <span className="dm-pos-amounts" data-usd-amounts="principal"><CardAmount amount={card.principal[0]} /><CardAmount amount={card.principal[1]} /></span>
          )}
        </Stat>
        <Stat
          label={KEY.fees}
          info={position.dex === 3 ? COPY.page.collectableInfo : KEY.feesInfo}
          className="dm-pos-stat"
          data-cell="fees"
          data-usd-reason={feesUsd === null ? row?.usdReason : undefined}
          sub={feesUsd !== null ? <FigureDetail active label={KEY.tokenAmounts}><Amounts card={card} which="unsettledFees" /></FigureDetail> : null}
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
        {storedFees ? <YourAprStat fees={storedFees} compact closed={!card.hasLiquidity} /> : <Stat label={COPY.page.apr} info={COPY.page.aprInfo} className="dm-pos-stat" data-cell="apr" data-apr="no_qualified_source">
          <span className="dm-fig-lg"><FigureDash /></span>
        </Stat>}
        <Stat label={KEY.price} info={KEY.priceInfo} className="dm-pos-stat dm-lit" data-cell="price" sub={<RangeLine price={price} card={card} />}>
          <span data-stat="price">
            <PriceNow price={price} card={card} />
          </span>
        </Stat>
      </StatStrip>

      {/* As Robinhood Chain's page: the charts (Fees earned, Price range) before the grid of Activity and Details. */}
      {chainId !== 4663 && <RecordedInsights key={`${chainId}:${position.manager}:${position.tokenId}:${card.poolId}`} answer={answer} position={position} card={card} price={price} book={book} fresh={fresh} fees={storedFees} />}

      <div className="dm-pos-grid">
        {chainId === 4663 && <section className="dm-card dm-pos-card" aria-labelledby="position-range-title">
          <h2 id="position-range-title" className="dm-title">
            {COPY.page.rangeTitle}
          </h2>
          {/* The pool's stored price history (2026-10-03, the owner's point 10): kept by the read service for Robinhood
              Chain's Uniswap v4 pools only. */}
          <PositionRange card={card} price={price} variant="page" history={position.dex === 4} openedAt={activityOpenedAt(activity?.kind === 'ok' ? activity.body : null, position)} />
        </section>}

        <PositionHistory wallet={holder} position={{ chainId, dex: position.dex, tokenId: position.tokenId.toString() }} events={storedEvents} automatic={automatic} />

        <details className="dm-card dm-pos-details" data-position-details="">
          <summary className="dm-pos-details-head">
            <h2 className="dm-title">{COPY.page.details}</h2>
            <span className="dm-pos-details-hint">{COPY.page.detailsHint}</span>
            <IconChevronDown size={16} />
          </summary>
          {/* Changed on purpose 2026-11-06 (O-07, O-12, O-13): Robinhood Chain's Details. The token amounts are under the
              tiles now; the pool's id under its own name; no "Read at block" (QA round 2, R23). Its Held line and Domino's
              permission come only where Robinhood Chain's page draws them too: a position a vault holds, an approval given. */}
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
            <KeyValue label={COPY.page.poolId}>{identity.kind === 'v4' ? <Address value={identity.id} /> : <Address value={identity.address} />}</KeyValue>
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
            {usdDetail && <KeyValue label="USD valuation"><span data-usd-detail="">{usdDetail}</span></KeyValue>}
            {/* Robinhood Chain's Fees history line, while the stored history is read (read-v6 `position-fees`). */}
            {storedFees && (
              <KeyValue label={COPY.page.feesHistory}>
                <span data-history-source={storedFees.phase === 'verified' ? 'stored' : storedFees.phase}>{storedHistoryWords(storedFees)}</span>
              </KeyValue>
            )}
            {position.vault && ownRead && (
              <KeyValue label={COPY.page.custody}>
                <span data-position-custody={successor ? 'successor' : 'root'}>{successor ? COPY.custody.successor : COPY.custody.root}</span>
              </KeyValue>
            )}
            {position.vault && (
              <KeyValue label={COPY.page.vault}>
                <Address value={position.vault.address} />
              </KeyValue>
            )}
            <ApprovalFact approval={approval} />
          </KeyValueList>
          {(poolPage || newHref) && (
            <div className="dm-pos-links">
              {poolPage && (
                <LinkButton href={poolPage} variant="outline" size="sm" data-position-pool-link="">
                  <IconMarkets />
                  {COPY.page.poolPage}
                </LinkButton>
              )}
              {newHref && (
                <LinkButton href={newHref} variant="outline" size="sm" data-position-new-in-pool="">
                  <IconPlus />
                  {COPY.page.newInPool}
                </LinkButton>
              )}
            </div>
          )}
        </details>
      </div>

      {mode && action && (
        <PositionDialog gate={gate} position={action} mode={mode} book={book} reserves={reserves} available={position.principal} onClose={() => setMode(null)} onDone={onChanged} />
      )}
    </div>
  )
}
