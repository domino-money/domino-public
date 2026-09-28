import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CHAIN_ID } from '../../lib/read/screens/identity'
import { walletCard, walletState } from '../../lib/walletCards'
import { REFRESH_MS, useWalletAnswer, type WalletDeposit } from '../../lib/walletPositions'
import type { WalletIdentityView } from '../../lib/walletIdentity'
import { newPositionHref } from '../explore/routes'
import { IconSearch, IconWallet } from '../icons'
import { Button, EmptyState, LinkButton, Skeleton, Tabs } from '../ui'
import { AutomateEntry } from './AutomateEntry'
import { automatable } from '../../lib/automate/picker'
import { PendingRow, PendingRows, PendingSummary, PositionRow } from './PositionRow'
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

/** Opens the header's wallet dialog, where a wallet is connected or switched to Robinhood Chain. */
const openWallet = () => document.querySelector<HTMLButtonElement>('header [aria-haspopup="dialog"]')?.click()

/**
 * The one quiet line while a read that failed is asked again (2, 5 and 10 s), and the one calm line once those failed
 * too (it is still asked now and then). Never the empty state: a read that failed says nothing about the wallet
 * (the owner's rule, 2026-09-25). The failure's code is in the card's data attribute only.
 */
const REREADING = 'Reading your positions from the chain…'
const UNREAD = 'Your positions couldn’t be read right now.'

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
 * kept in the browser (the owner's rule, 2026-09-24).
 */
export default function OwnedPositions({ identity, deposits, onEmptyAction }: OwnedPositionsProps) {
  if (identity.kind === 'unknown') {
    return (
      <Frame data={{ 'data-owned': 'waiting' }}>
        <div className="dm-rows dm-acct-nft-rows" aria-hidden="true">
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

  // Every row straight from the chain read: its card, and the state its USD is valued at (the same read, the same block).
  const rows = useMemo(
    () => (ready ? ready.positions.map((position) => ({ position, card: walletCard(position, owner), state: walletState(position, ready.block, owner) })) : null),
    [ready, owner],
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
  const total = tabs ? tabs.open.length + tabs.closed.length : 0
  const phase = ready ? 'ready' : unread ? 'unlisted' : answer.phase === 'retrying' ? 'retrying' : 'loading'
  // `No positions yet` carries its own New position: the page's title row steps its own back (before paint, no flash).
  const emptyAction = tabs !== null && total === 0
  useLayoutEffect(() => {
    if (!onEmptyAction) return
    onEmptyAction(emptyAction)
    return () => onEmptyAction(false)
  }, [emptyAction, onEmptyAction])
  // A read that failed is never "no positions": its code is a data attribute, and the one line says it is read again or could not be.
  const status = !tabs ? (unread ? UNREAD : 'Listing your positions…') : `${tabs.open.length} open and ${tabs.closed.length} closed positions.`

  let body: ReactNode
  if (!tabs) {
    body = unread ? (
      <p className="dm-own-note" data-owned-note="unread">
        {UNREAD}
      </p>
    ) : (
      <>
        {answer.phase === 'retrying' && (
          <p className="dm-own-note" data-owned-note="rereading">
            {REREADING}
          </p>
        )}
        <PendingRows loading />
      </>
    )
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
      <div className="dm-rows dm-acct-nft-rows" role="tabpanel" aria-labelledby="own-title" data-owned-rows={tab}>
        {/* The column names for the eye; each row's own cells carry their names for a screen reader. */}
        <div className="dm-rows-head dm-acct-nft-band" aria-hidden="true">
          <span>Pool</span>
          <span>Range</span>
          <span>Value</span>
          <span>Fees ready to collect</span>
          <span />
        </div>
        {shown.map((row) => (
          <Fragment key={row.card.tokenId}>
            <PositionRow card={row.card} block={ready?.block ?? 0} state={row.state} tick={row.position.tick} />
            <AutomateEntry tokenId={row.card.tokenId} open={automatable(row.position)} />
          </Fragment>
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
          'data-owned-block': ready ? String(ready.block) : undefined,
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
            its way the band keeps its place, so the rows never move when it fills. */}
        {tab === 'open' && (portfolio?.totals ? <PortfolioSummary {...portfolio.totals} /> : !tabs && !unread ? <PendingSummary /> : null)}
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
