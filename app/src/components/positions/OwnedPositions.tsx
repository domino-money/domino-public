import { useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import { CHAIN_ID } from '../../lib/read/screens/identity'
import { walletCard, walletState } from '../../lib/walletCards'
import { useWalletAnswer, type WalletDeposit } from '../../lib/walletPositions'
import type { WalletIdentityView } from '../../lib/walletIdentity'
import { newPositionHref } from '../explore/routes'
import { IconSearch, IconWallet } from '../icons'
import { Button, EmptyState, LinkButton, Skeleton, Tabs } from '../ui'
import { PendingRow, PendingRows, PendingSummary, PositionRow } from './PositionRow'
import { FeesCard } from './visual/FeesCard'
import { PortfolioSummary, portfolioOf } from './visual/PortfolioSummary'

/** What Positions hands the held deposits: drawn by the lazily loaded HeldDeposits in wallet builds. */
export type DepositsSlot = (props: { owner: string; deposits: readonly WalletDeposit[]; onChanged: () => void }) => ReactNode

/** Rows shown at a time, before Show more. */
const PAGE_SIZE = 10

type Status = 'open' | 'closed'

/** Opens the header's wallet dialog, where a wallet is connected or switched to Robinhood Chain. */
const openWallet = () => document.querySelector<HTMLButtonElement>('header [aria-haspopup="dialog"]')?.click()

/** Why the list could not be read, for a title only: the endpoint's code is in the data attribute beside it. */
const UNLISTED = 'Your positions could not be read from chain just now. They are asked again on their own.'

/** The card's frame: its title, and the tabs once there is something to put in them. */
function Frame({ children, tabs, data, title }: { children: ReactNode; tabs?: ReactNode; data?: Record<string, string | undefined>; title?: string }) {
  return (
    <section className="dm-card dm-acct-nft-card dm-own-card" aria-labelledby="own-title" title={title} {...data}>
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
 * it created through Domino (DominoSetupV1), read from chain by the site's
 * own endpoint (open and closed, in two tabs), and under them the deposits it
 * has not turned into a position yet. Without a wallet, or on another
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
  const answer = useWalletAnswer(owner, asked)
  const ready = answer.phase === 'ready' ? answer.answer : null
  const reason = answer.phase === 'failed' ? answer.reason : null

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
  const phase = ready ? 'ready' : reason ? 'unlisted' : 'loading'
  // `No positions yet` carries its own New position: the page's title row steps its own back (before paint, no flash).
  const emptyAction = tabs !== null && total === 0
  useLayoutEffect(() => {
    if (!onEmptyAction) return
    onEmptyAction(emptyAction)
    return () => onEmptyAction(false)
  }, [emptyAction, onEmptyAction])
  // The reason a list could not be read is a title and a data attribute only, never a sentence, not even a spoken one.
  const status = !tabs ? (reason ? 'No positions to show.' : 'Listing your positions…') : `${tabs.open.length} open and ${tabs.closed.length} closed positions.`

  let body: ReactNode
  if (!tabs) {
    body = reason ? <EmptyState icon={<IconSearch />} title="No positions to show" data-empty="owned-unlisted" /> : <PendingRows loading />
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
          <span>Principal</span>
          <span>Unclaimed fees</span>
          <span />
        </div>
        {shown.map((row) => (
          <PositionRow key={row.card.tokenId} card={row.card} block={ready?.block ?? 0} state={row.state} tick={row.position.tick} />
        ))}
      </div>
    )
  }

  return (
    <>
      <Frame
        title={reason && !ready ? UNLISTED : undefined}
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
          ) : !tabs && !reason ? (
            <Skeleton className="dm-own-skel-tabs" />
          ) : undefined
        }
      >
        <p role="status" aria-live="polite" className="sr-only" data-owned-status="">
          {status}
        </p>
        {/* The totals are the open positions': shown over their tab only, never over the closed rows. While the list is on
            its way the band keeps its place, so the rows never move when it fills. */}
        {tab === 'open' && (portfolio?.totals ? <PortfolioSummary {...portfolio.totals} /> : !tabs && !reason ? <PendingSummary /> : null)}
        {body}
        {more > 0 && (
          <div className="dm-own-more">
            <Button type="button" variant="ghost" size="sm" onClick={() => setPages((before) => ({ ...before, [tab]: before[tab] + 1 }))}>
              Show {Math.min(more, PAGE_SIZE)} more
            </Button>
          </div>
        )}
      </Frame>
      {portfolio?.aggregate && <FeesCard kind="plain" source={{ tokenIds: portfolio.aggregate }} scope="list" bandPresent />}
      {deposits && held.length > 0 && deposits({ owner, deposits: held, onChanged: () => setAsked((n) => n + 1) })}
    </>
  )
}
