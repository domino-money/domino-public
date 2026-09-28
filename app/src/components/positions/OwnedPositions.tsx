import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { drop, keep, readKept } from '../../finance/privateCards'
import { feesStore } from '../../lib/fees/spawn'
import type { FeeHistoryView } from '../../lib/fees/types'
import { CHAIN_ID } from '../../lib/read/screens/identity'
import { walletCard, walletState } from '../../lib/walletCards'
import { REFRESH_MS, parseWalletAnswer, useWalletAnswer, type WalletDeposit } from '../../lib/walletPositions'
import type { WalletIdentityView } from '../../lib/walletIdentity'
import { newPositionHref } from '../explore/routes'
import { IconSearch, IconWallet } from '../icons'
import { Button, EmptyState, LinkButton, Skeleton, Tabs } from '../ui'
import { AutomateEntry } from './AutomateEntry'
import { automatable } from '../../lib/automate/picker'
import { rowAprs, type RowApr } from './listApr'
import { PendingRow, PendingRows, PendingSummary, PositionRow, RowsHead } from './PositionRow'
import { PortfolioSummary, portfolioOf } from './visual/PortfolioSummary'

/**
 * What Positions hands the held deposits: drawn by the lazily loaded HeldDeposits in wallet builds. `onBusy` says when a
 * refund is on its way and when it is over: the list's refresh waits meanwhile, so a new list never unmounts it mid-refund.
 */
export type DepositsSlot = (props: { owner: string; deposits: readonly WalletDeposit[]; onChanged: () => void; onBusy?: (busy: boolean) => void }) => ReactNode

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
 * Your APR on the rows (round 6, listApr.ts): the history a position's page drew this visit, from the fees store, which
 * the list only watches. 2026-09-28 (the owner: from that morning, a position's Fees earned chart and Your APR often did
 * not show, and it took many reloads): the list no longer measures anything itself. Its queue replayed each open
 * position's history from the list, in every tab, as the position's page would (the load the 2026-09-25 review had taken
 * off the list): live, it drew the RPC's refusals of the list's own read, and a history it could not finish stayed the
 * fees store's answer for the visit, so the position's page opened from the list showed its unclaimed figure only and
 * read nothing more until a reload. A row whose page was not opened this visit shows the calm dash (its title: shown on
 * the position's page).
 */
function useRowAprs(ids: readonly string[]): ReadonlyMap<string, RowApr> {
  const key = ids.join(',')
  const watch = useCallback((listener: () => void) => (key === '' ? quiet : feesStore.watch(key.split(','), listener)), [key])
  const snapshot = useCallback(() => (key === '' ? noViews : feesStore.views(key.split(','))), [key])
  const views = useSyncExternalStore(watch, snapshot, () => noViews)
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

/**
 * 2026-09-28 (the owner's phone: the card stayed on its loading rows while the RPC refused his address): this browser's
 * copy of the wallet's last list, per wallet and chain, drawn at once (`data-owned="kept"`) while the chain is read, then
 * replaced by the chain's answer. Display only: checked field by field as a chain answer is, at most a week old, its
 * positions only (never a held deposit and its refund), and no APR or automation is asked for it. A wallet with no
 * position keeps none: only the chain says a wallet has none. Its USD figures are from its own pool prices: past
 * PRICED_MS its rows show their token amounts only, and no total (review, 2026-09-28).
 */
const copyName = (owner: string) => `owned.${CHAIN_ID}.${owner}`
const recall = (owner: string) =>
  readKept(copyName(owner), 7 * 86_400_000, (data, at) => {
    const answer = parseWalletAnswer(data, owner)
    return answer?.positions.length ? { answer, at } : null
  })
/** How long a copy's prices count: the Wallet card's rule (lib/walletMemory.ts WALLET_PRICE_MAX_AGE_MS, an hour; not imported, it is that card's chunk). */
const PRICED_MS = 3_600_000

/** The card's frame: its title, and the tabs once there is something to put in them. */
function Frame({ children, tabs, data }: { children: ReactNode; tabs?: ReactNode; data?: Record<string, string | undefined> }) {
  return (
    <section className="dm-card dm-acct-nft-card dm-own-card" aria-labelledby="own-title" {...data}>
      <div className="dm-own-head">
        <h2 id="own-title" className="dm-title">
          Your positions
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
export default function OwnedPositions({ identity, deposits, onEmptyAction }: OwnedPositionsProps) {
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

function YourPositions({ owner, deposits, onEmptyAction }: Omit<OwnedPositionsProps, 'identity' | 'kit'> & { owner: string }) {
  // How many times the page has asked again after an action (a refund) changed the answer: each asks fresh.
  const [asked, setAsked] = useState(0)
  // A held deposit's refund on its way: the refresh waits until it is over (its timer reads the ref, set after each render).
  const [refunding, setRefunding] = useState(false)
  const refundingRef = useRef(false)
  useEffect(() => {
    refundingRef.current = refunding
  }, [refunding])
  const answer = useWalletAnswer(owner, asked, REFRESH, refundingRef)
  const ready = answer.phase === 'ready' ? answer.answer : null
  const reason = answer.phase === 'failed' || answer.phase === 'retrying' ? answer.reason : null
  // Given up on for now (the quick re-asks failed too): one calm line. Still reading, or asked again: the loading rows.
  const unread = answer.phase === 'failed'
  // This browser's copy until the chain answers; each answer of the chain is kept for the next visit.
  const [copy] = useState(() => recall(owner))
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
    if (ready?.positions.length) keep(copyName(owner), { ...ready, deposits: [] })
    else if (ready) drop(copyName(owner))
  }, [ready, owner])

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
  const aprs = useRowAprs(measured)
  const fresh = ready !== null
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
  const status = !tabs ? (unread ? UNREAD : 'Listing your positions…') : `${tabs.open.length} open and ${tabs.closed.length} closed positions.`

  // The one line while a failed read is asked again, or once it could not be: over the loading rows, or over this
  // browser's copy (2026-09-28, review), never over the chain's own list.
  const note = unread ? 'unread' : answer.phase === 'retrying' ? 'rereading' : null

  let body: ReactNode
  if (!tabs) {
    body = !unread && <PendingRows loading />
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
            automation={fresh && <AutomateEntry tokenId={row.card.tokenId} open={automatable(row.position)} />}
          />
        ))}
      </div>
    )
  }

  return (
    <>
      <Frame
        data={{
          'data-owned': phase,
          'data-owned-reason': reason ?? undefined,
          'data-owned-block': list ? String(list.block) : undefined,
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
            {note === 'unread' ? UNREAD : REREADING}
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
      {/* No fees history is replayed for the list (2026-09-25, review of r3/chain, option a): each row shows its unclaimed
          fees from the list's own read, and only a position's page replays its history, bounded. The list's aggregate card
          replayed every open position's history from the visitor's browser, which the public RPC's per-address limit could
          not bear (PONS/USDG's is over 60 MB), and its refusals then held back the list's own reads. */}
      {deposits &&
        held.length > 0 &&
        deposits({
          owner,
          deposits: held,
          onChanged: () => setAsked((n) => n + 1),
          onBusy: setRefunding,
        })}
    </>
  )
}
