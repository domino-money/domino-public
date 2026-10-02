import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { drop, keep, readKept } from '../../finance/privateCards'
import { feesStore } from '../../lib/fees/spawn'
import { historyLoadQuality } from '../../lib/fees/freshness'
import type { FeeHistoryView } from '../../lib/fees/types'
import { useLedgerTraces } from '../../lib/fees/useFeeHistory'
import { CHAIN_ID, shortAddress } from '../../lib/read/screens/identity'
import { walletCard, walletState } from '../../lib/walletCards'
import { REFRESH_MS, parseWalletAnswer, useWalletAnswer, walletChanged, type WalletDeposit } from '../../lib/walletPositions'
import { useLoadMilestone } from '../../lib/useLoadMilestone'
import type { WalletIdentityView } from '../../lib/walletIdentity'
import { newPositionHref } from '../explore/routes'
import { IconSearch, IconWallet } from '../icons'
import { Button, EmptyState, LinkButton, Skeleton, Tabs } from '../ui'
import { AutomateEntry } from './AutomateEntry'
import { automatable } from '../../lib/automate/picker'
import { rowAprs, type RowApr } from './listApr'
import { visibleAmountQuality } from './valueReadiness'
import { PendingRow, PendingRows, PendingSummary, PositionRow, RowsHead } from './PositionRow'
import { PortfolioSummary, portfolioOf } from './visual/PortfolioSummary'
import { KEPT_MAX_AGE_MS } from '../../lib/browserCopies'

/**
 * What Positions hands the held deposits: drawn by the lazily loaded HeldDeposits in wallet builds. `onBusy` says when a
 * refund is on its way and when it is over: the list's refresh waits meanwhile, so a new list never unmounts it mid-refund.
 */
export type DepositsSlot = (props: { owner: string; deposits: readonly WalletDeposit[]; onChanged: (block?: bigint) => void; onBusy?: (busy: boolean) => void }) => ReactNode

/** Rows shown at a time, before Show more. */
const PAGE_SIZE = 10

/**
 * The list reads itself again every 30 s while the tab is visible (the owner's OK, 2026-09-27; lib/walletPositions.ts
 * askWallet). Test builds only when a test asks for it before the page loads (window.__dominoRefresh), so every other
 * suite counts its reads as before.
 */
const REFRESH = __DOMINO_TEST_HOOKS__ && !(window as { __dominoRefresh?: boolean }).__dominoRefresh ? null : REFRESH_MS

type Status = 'open' | 'closed'

function quiet() {}
const noViews: ReadonlyMap<string, FeeHistoryView> = new Map()

/**
 * Each row's Your APR. Changed on purpose 2026-10-02 (RPC-SPEC §11.4): while `ask` (the wallet's own open rows, read
 * fresh), the rows' ledgers are asked, eight ids a request (the store's 'list' scope: the ledger alone, its own state), so
 * every row whose ledger is exact shows its rate since opened; it was a bounded warm-up of at most a few visible rows, one
 * replay at a time. Otherwise (another address's list, audit V7) the rows only watch the store: an APR shows once the
 * position's own page drew it.
 */
function useRowAprs(ids: readonly string[], ask: boolean): ReadonlyMap<string, RowApr> {
  const key = ids.join(',')
  const watch = useCallback((listener: () => void) => (key === '' ? quiet : feesStore.watch(key.split(','), listener)), [key])
  const snapshot = useCallback(() => (key === '' ? noViews : feesStore.views(key.split(','))), [key])
  const views = useSyncExternalStore(watch, snapshot, () => noViews)
  useEffect(() => (ask && key !== '' ? feesStore.subscribeHistory(key.split(','), 'list', quiet) : undefined), [key, ask])
  return useMemo(() => rowAprs(key === '' ? [] : key.split(','), views), [key, views])
}

/** Opens the header's wallet dialog, where a wallet is connected or switched to Robinhood Chain. */
const openWallet = () => document.querySelector<HTMLButtonElement>('header [aria-haspopup="dialog"]')?.click()

/**
 * The one quiet line while a read that failed is asked again (2, 5 and 10 s), and the one calm line once those failed
 * too (it is still asked now and then). Never the empty state: a read that failed says nothing about the wallet
 * (the owner's rule, 2026-09-25). The failure's code is in the card's data attribute only. 2026-09-28 (review): over
 * this browser's copy too, so the copy never reads as the chain's answer of now.
 */
const REREADING = 'Reading your positions from the chain…'
const UNREAD = 'Your positions couldn’t be read right now.'
/** The same two lines for another address the page views (2026-10-01, audit V7). */
const VIEWED_REREADING = 'Reading this address’s positions from the chain…'
const VIEWED_UNREAD = 'This address’s positions couldn’t be read right now.'

/**
 * 2026-09-28 (the owner's phone: the card stayed on its loading rows while the RPC refused his address): this browser's
 * copy of the wallet's last list, per wallet and chain, drawn at once (`data-owned="kept"`) while the chain is read, then
 * replaced by the chain's answer. Display only: checked field by field as a chain answer is, at most a day old (a week
 * until 2026-10-01, I6: lib/browserCopies.ts), its
 * positions only (never a held deposit and its refund), and no APR or automation is asked for it. A wallet with no
 * position keeps none: only the chain says a wallet has none. Its USD figures are from its own pool prices: past
 * PRICED_MS its rows show their token amounts only, and no total (review, 2026-09-28).
 */
const copyName = (owner: string) => `owned.${CHAIN_ID}.${owner}`
const recall = (owner: string) =>
  readKept(copyName(owner), KEPT_MAX_AGE_MS.owned, (data, at) => {
    const answer = parseWalletAnswer(data, owner)
    return answer?.positions.length ? { answer, at } : null
  })
/** How long a copy's prices count: the Wallet card's rule (lib/walletMemory.ts WALLET_PRICE_MAX_AGE_MS, an hour; not imported, it is that card's chunk). */
const PRICED_MS = 3_600_000

/**
 * The card's frame: its title, and the tabs once there is something to put in them. `viewed` (2026-10-01, audit V7):
 * another address's list, named by that address (its full address one hover away).
 */
function Frame({ children, tabs, data, viewed }: { children: ReactNode; tabs?: ReactNode; data?: Record<string, string | undefined>; viewed?: string }) {
  return (
    <section className="dm-card dm-acct-nft-card dm-own-card" aria-labelledby="own-title" {...data}>
      <div className="dm-own-head">
        <h2 id="own-title" className="dm-title">
          {viewed ? (
            <>
              Positions of{' '}
              <span title={viewed} translate="no">
                {shortAddress(viewed)}
              </span>
            </>
          ) : (
            'Your positions'
          )}
        </h2>
        {tabs}
      </div>
      {children}
    </section>
  )
}

export interface OwnedPositionsProps {
  identity: WalletIdentityView
  deposits: DepositsSlot | null
  /**
   * Whether the card shows an empty state with its own filled action (`No positions yet` with New position): the page's
   * title row then steps its New position back, so one filled button leads the screen. Optional, for older callers.
   */
  onEmptyAction?: (shown: boolean) => void
  /**
   * 2026-10-01 (audit V7): another public address the page views (`#/portfolio/<address>`, lowercase): the card lists its
   * positions, read-only, with no wallet needed. Unset, or the connected wallet's own: the wallet's list.
   */
  viewed?: string | null
  /** The positions screens' entry anchor (components/positions/visual/kit.ts): passed, never read. */
  kit?: unknown
}

/**
 * Your positions, for the wallet the header is connected to: the positions
 * it created through Domino (DominoSetupV1), read from chain by the page
 * itself (open and closed, in two tabs; a closed one keeps its NFT), and under
 * them the deposits it has not turned into a position yet. Without a wallet, or on another
 * network, one empty state says what to do. Nothing is read until a wallet is
 * connected on Robinhood Chain, no NFT id is ever asked for, and nothing is
 * kept in the browser (the owner's rule, 2026-09-24) but, since 2026-09-28,
 * the list's display copy (copyName below).
 */
export default function OwnedPositions({ identity, deposits, onEmptyAction, viewed }: OwnedPositionsProps) {
  // 2026-10-01 (audit V7): another address the page views: its positions, read-only, whatever the wallet is doing.
  if (viewed && /^0x[0-9a-f]{40}$/.test(viewed) && !(identity.kind === 'connected' && identity.address.toLowerCase() === viewed)) {
    return <YourPositions key={`viewed:${viewed}`} owner={viewed} deposits={null} readOnly />
  }
  if (identity.kind === 'unknown') {
    return (
      <Frame data={{ 'data-owned': 'waiting' }}>
        <div className="dm-own-list" aria-hidden="true">
          <PendingRow tokenId="" />
        </div>
      </Frame>
    )
  }
  if (identity.kind === 'disconnected') {
    return (
      <Frame data={{ 'data-owned': 'no-wallet' }}>
        <EmptyState
          icon={<IconWallet />}
          title="Connect a wallet to see your positions"
          action={
            <Button type="button" onClick={openWallet}>
              Connect wallet
            </Button>
          }
          className="dm-own-connect"
          data-empty="owned-connect"
        />
      </Frame>
    )
  }
  if (identity.chainId !== CHAIN_ID) {
    return (
      <Frame data={{ 'data-owned': 'other-network' }}>
        <EmptyState
          icon={<IconWallet />}
          title="Switch to Robinhood Chain"
          body="Your wallet is on another network."
          action={
            <Button type="button" variant="outline" onClick={openWallet}>
              Open wallet
            </Button>
          }
          data-empty="owned-network"
        />
      </Frame>
    )
  }
  const owner = identity.address.toLowerCase()
  return <YourPositions key={owner} owner={owner} deposits={deposits} onEmptyAction={onEmptyAction} />
}

/**
 * The list of `owner`'s positions. `readOnly` (2026-10-01, audit V7): another address the page views, as public data: the
 * same rows and tabs, read once (no refresh, no browser copy, the fees lanes not held, no APR read ahead) and with nothing
 * to act on (no Automate, no held deposits, no New position).
 */
function YourPositions({ owner, deposits, onEmptyAction, readOnly = false }: Omit<OwnedPositionsProps, 'identity' | 'kit' | 'viewed'> & { owner: string; readOnly?: boolean }) {
  // How many times the page has asked again after an action (a refund) changed the answer: each asks fresh.
  const [asked, setAsked] = useState(0)
  // A held deposit's refund on its way: the refresh waits until it is over (its timer reads the ref, set after each render).
  const [refunding, setRefunding] = useState(false)
  const refundingRef = useRef(false)
  useEffect(() => {
    refundingRef.current = refunding
  }, [refunding])
  // 2026-10-02 (review of the RPC switch, finding 8): a position this visit's Create position made that the list lacks
  // (a node still behind its mint) is asked for again, fresh, on a short ladder, as the automation page and a position's
  // own page do; the first read after the mint is fresh already (walletPositions.ts wantsFresh). RPC fix round 2: the
  // read itself runs that ladder (askWallet), for this wallet's own positions only.
  const answer = useWalletAnswer(owner, asked, readOnly ? null : REFRESH, refundingRef, !readOnly)
  const ready = answer.phase === 'ready' ? answer.answer : null
  const reason = answer.phase === 'failed' || answer.phase === 'retrying' ? answer.reason : null
  // Given up on for now (the quick re-asks failed too): one calm line. Still reading, or asked again: the loading rows.
  const unread = answer.phase === 'failed'
  // This browser's copy until the chain answers; each answer of the chain is kept for the next visit. (RPC-SPEC: the
  // route keeps the wallet's SetupMinted walk itself, so the copy no longer seeds the read.)
  const [copy] = useState(() => (readOnly ? null : recall(owner)))
  const list = ready ?? copy?.answer
  // Whether the copy's prices still count: from PRICED_MS after it was kept, its rows show their amounts only.
  const [valued, setValued] = useState(() => !!copy && Date.now() - copy.at <= PRICED_MS)
  useEffect(() => {
    if (!valued || ready || !copy) return
    const timer = setTimeout(() => setValued(false), copy.at + PRICED_MS - Date.now())
    return () => clearTimeout(timer)
  }, [valued, ready, copy])
  const priced = !!ready || valued
  useEffect(() => {
    if (readOnly) return
    if (ready?.positions.length) keep(copyName(owner), { ...ready, deposits: [] })
    else if (ready) drop(copyName(owner))
  }, [ready, owner, readOnly])

  // Every row straight from the chain read: its card, and the state its USD is valued at (the same read, the same block).
  const rows = useMemo(
    () => (list ? list.positions.map((position) => ({ position, card: walletCard(position, owner), state: priced ? walletState(position, list.block, owner) : null })) : null),
    [list, owner, priced],
  )
  const tabs = useMemo(() => (rows ? { open: rows.filter((row) => row.position.status === 'open'), closed: rows.filter((row) => row.position.status === 'closed') } : null), [rows])
  const portfolio = useMemo(() => (tabs ? portfolioOf(tabs.open) : null), [tabs])
  const [chosen, setChosen] = useState<Status | null>(null)
  // Open unless there is nothing open and something closed.
  const tab: Status = chosen ?? (tabs && tabs.open.length === 0 && tabs.closed.length > 0 ? 'closed' : 'open')
  const [pages, setPages] = useState<Record<Status, number>>({ open: 1, closed: 1 })
  const held = ready?.deposits ?? []

  const shown = tabs ? tabs[tab].slice(0, pages[tab] * PAGE_SIZE) : []
  const more = tabs ? tabs[tab].length - shown.length : 0
  // The open positions on the list's open page, whose APR the rows show when their page drew it this visit.
  const measured = useMemo(() => (tabs ? tabs.open.slice(0, pages.open * PAGE_SIZE).filter((row) => row.card.hasLiquidity).map((row) => row.card.tokenId) : []), [tabs, pages.open])
  const fresh = ready !== null
  // Another address's list reads no history ahead (audit V7): its rows show an APR only once their own page drew it.
  const aprs = useRowAprs(measured, !readOnly && fresh && tab === 'open' && !refunding)
  // 2026-10-02 (review of the chart's tabs, finding 1): each row's ledger requests this visit and how the last ended, as
  // its APR cell's data attributes only.
  const traces = useLedgerTraces(measured)
  const shownValues = shown.map((row) => visibleAmountQuality(row.card.principal))
  const valueQuality = shownValues.includes('current') ? 'current' : shownValues.includes('partial') ? 'partial' : null
  useLoadMilestone('positions', 'value', readOnly ? null : valueQuality && !fresh ? 'cached' : valueQuality)
  const total = tabs ? tabs.open.length + tabs.closed.length : 0
  const phase = ready ? 'ready' : copy ? 'kept' : unread ? 'unlisted' : answer.phase === 'retrying' ? 'retrying' : 'loading'
  // `No positions yet` carries its own New position: the page's title row steps its own back (before paint, no flash).
  const emptyAction = tabs !== null && total === 0
  useLayoutEffect(() => {
    if (!onEmptyAction) return
    onEmptyAction(emptyAction)
    return () => onEmptyAction(false)
  }, [emptyAction, onEmptyAction])
  // A read that failed is never "no positions": its code is a data attribute, and the one line says it is read again or could not be.
  const status = !tabs ? (unread ? (readOnly ? VIEWED_UNREAD : UNREAD) : readOnly ? 'Listing this address’s positions…' : 'Listing your positions…') : `${tabs.open.length} open and ${tabs.closed.length} closed positions.`

  // The one line while a failed read is asked again, or once it could not be: over the loading rows, or over this
  // browser's copy (2026-09-28, review), never over the chain's own list. Changed on purpose 2026-10-01 (fees items A8 and
  // A9): "reading" only while a read is on its way (from the RPC's first refusal), not while the page waits to ask again.
  const note = unread ? 'unread' : answer.phase === 'retrying' && answer.reading ? 'rereading' : null

  let body: ReactNode
  if (!tabs) {
    body = !unread && <PendingRows loading />
  } else if (total === 0 && readOnly) {
    // Another address with none: said plainly, with nothing to press (audit V7). Changed on purpose 2026-10-01 (integration
    // pass 3, the copy review): one line says what the list counts, as the docs do (positions made elsewhere are not listed).
    body = <EmptyState icon={<IconSearch />} title="No positions at this address" body="Only positions opened with Domino are listed." plate className="dm-own-none" data-empty="viewed-none" />
  } else if (total === 0) {
    body = (
      <EmptyState
        icon={<IconSearch />}
        title="No positions yet"
        // With a deposit waiting for its refund, Refund to wallet is the screen's one filled button: this steps back to soft.
        action={
          <LinkButton href={newPositionHref()} variant={deposits && held.length > 0 ? 'soft' : 'primary'}>
            New position
          </LinkButton>
        }
        plate
        className="dm-own-none"
        data-empty="owned-none"
      />
    )
  } else if (shown.length === 0) {
    body = <EmptyState title={tab === 'open' ? 'No open positions' : 'No closed positions'} data-empty={`owned-${tab}`} />
  } else {
    body = (
      <div className="dm-own-list" role="tabpanel" aria-labelledby="own-title" data-owned-rows={tab}>
        {/* The column names for the eye; each row's own cells carry their names for a screen reader. */}
        <RowsHead closed={tab === 'closed'} />
        {shown.map((row) => (
          <PositionRow
            key={row.card.tokenId}
            card={row.card}
            block={list?.block ?? 0}
            state={row.state}
            apr={aprs.get(row.card.tokenId) ?? null}
            aprQuality={historyLoadQuality(feesStore.view(row.card.tokenId))}
            ledger={traces.get(row.card.tokenId) ?? null}
            automation={fresh && !readOnly && <AutomateEntry tokenId={row.card.tokenId} open={automatable(row.position)} />}
          />
        ))}
      </div>
    )
  }

  return (
    <>
      <Frame
        viewed={readOnly ? owner : undefined}
        data={{
          'data-owned': phase,
          'data-owned-reason': reason ?? undefined,
          'data-owned-block': list ? String(list.block) : undefined,
          'data-owned-viewed': readOnly ? owner : undefined,
        }}
        tabs={
          tabs && total > 0 ? (
            <Tabs
              label="Positions by state"
              value={tab}
              onChange={setChosen}
              items={[
                { key: 'open', label: 'Open', count: tabs.open.length },
                { key: 'closed', label: 'Closed', count: tabs.closed.length },
              ]}
            />
          ) : !tabs && !unread ? (
            <Skeleton className="dm-own-skel-tabs" />
          ) : undefined
        }
      >
        <p role="status" aria-live="polite" className="sr-only" data-owned-status="">
          {status}
        </p>
        {/* The totals are the open positions': shown over their tab only, never over the closed rows. While the list is on
            its way, or this browser's copy is too old to value, the band keeps its place, so the rows never move when it fills. */}
        {tab === 'open' && (portfolio?.totals ? <PortfolioSummary {...portfolio.totals} /> : (!tabs || !priced) && !unread ? <PendingSummary /> : null)}
        {note && (
          <p className="dm-own-note" data-owned-note={note}>
            {note === 'unread' ? (readOnly ? VIEWED_UNREAD : UNREAD) : readOnly ? VIEWED_REREADING : REREADING}
          </p>
        )}
        {body}
        {more > 0 && (
          <div className="dm-own-more">
            <Button type="button" variant="ghost" size="sm" onClick={() => setPages((before) => ({ ...before, [tab]: before[tab] + 1 }))}>
              Show {Math.min(more, PAGE_SIZE)} more
            </Button>
          </div>
        )}
      </Frame>
      {/* No aggregate history replay: at most two visible APR candidates are warmed, independently of these cards.
          Busy histories stay for the detail's larger budget; the list never walks the entire wallet in the background. */}
      {deposits &&
        held.length > 0 &&
        deposits({
          owner,
          deposits: held,
          // RPC fix round 2: the refund's block, so every read of the wallet waits for an answer past it (walletChanged).
          onChanged: (included) => {
            walletChanged(included)
            setAsked((n) => n + 1)
          },
          onBusy: setRefunding,
        })}
    </>
  )
}
