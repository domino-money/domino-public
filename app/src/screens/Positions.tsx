import { lazy, Suspense, useState, type ComponentType, type CSSProperties, type ReactNode } from 'react'
import PortfolioBody from '../components/portfolio/PortfolioBody'
import { automateHref, marketsHref, newPositionHref } from '../components/explore/routes'
import { IconTile } from '../components/figures'
import { IconAutomate, IconChevronLeft, IconPositions, IconWallet } from '../components/icons'
import type { DepositsSlot, OwnedPositionsProps } from '../components/positions/OwnedPositions'
import { PendingRows, PendingSummary } from '../components/positions/PositionRow'
import { AutomationFrame } from '../components/positions/visual/AutomationFrame'
import { POSITION_KIT } from '../components/positions/visual/kit'
import { PositionSkeleton } from '../components/positions/visual/PositionSkeleton'
import { Chip, Display, EmptyState, LinkButton, PageShell } from '../components/ui'
import { shortAddress } from '../lib/read/screens/identity'
import { positionDetailId } from '../lib/read/screens/positions'
import { useWalletIdentity, type WalletIdentityView } from '../lib/walletIdentity'
import { RoadmapPill } from './Automate'

type Connected = Extract<WalletIdentityView, { kind: 'connected' }>

// The private, signed-in side of managed positions, in builds that carry the
// wallet session: performance history and execution receipts. Each is its own
// chunk, loaded only when this page is open in such a build; elsewhere the
// constant is null and nothing is imported. The stand-in takes any props, so
// it can stand in for a chunk whose component takes some (HeldDeposits, and
// Execution's preview limit).
const couldNotLoad = () => ({ default: (_props: object) => <p role="alert" className="dm-acct-quiet">This section couldn’t load. Reload to try again.</p> })
const Performance = __DOMINO_WALLET_SESSION__ ? lazy(() => import('./Performance').catch(couldNotLoad)) : null
const Execution = __DOMINO_WALLET_SESSION__ ? lazy<ComponentType<{ limit?: number }>>(() => import('./Execution').catch(couldNotLoad)) : null
// The deposits the wallet has not turned into a position, each with its refund: its own chunk, in wallet builds only.
// Typed from the slot's own props, so this screen names nothing of that chunk but its lazy import.
const HeldDeposits = __DOMINO_WALLET_SESSION__ ? lazy<ComponentType<Parameters<DepositsSlot>[0]>>(() => import('../components/positions/HeldDeposits').catch(couldNotLoad)) : null

// Your positions and a position's own page: chunks of their own, loaded only on Positions, so no other page pays for
// them. The list exists only where a wallet can connect; the page is public chain data and opens in every build.
const OwnedPositions = __DOMINO_WALLET_SESSION__ ? lazy<ComponentType<OwnedPositionsProps>>(() => import('../components/positions/OwnedPositions').catch(couldNotLoad)) : null
const PositionDetail = lazy<ComponentType<{ tokenId: string; kit?: unknown }>>(() => import('./PositionDetail').catch(couldNotLoad))

/** The held deposits under Your positions, drawn by HeldDeposits once its chunk is in; nothing while it loads. */
const heldDeposits: DepositsSlot | null = HeldDeposits
  ? (props) => (
      <Suspense fallback={null}>
        <HeldDeposits {...props} />
      </Suspense>
    )
  : null

/** The first four blocks of the page rise in on first load, 40 ms apart (one --stagger); nothing after them does. */
const rise = (step: number) => ({ '--delay': `${step * 40}ms` }) as CSSProperties

/**
 * The header's wallet, named beside the title. A connection is not a sign-in:
 * the chip says only the address, and its title says so.
 */
function ConnectedChip({ identity }: { identity: Connected }) {
  return (
    <Chip variant="plate" className="dm-acct-wallet-chip" title="Connected, not signed in." data-connected-wallet="">
      <span className="sr-only">Connected wallet </span>
      <span className="dm-acct-mono" title={identity.address} translate="no">
        {shortAddress(identity.address)}
      </span>
    </Chip>
  )
}

/**
 * A private card while its chunk loads: its own line over the empty plate, with no loading words (the owner, 2026-09-27,
 * round 6: loading text only on a true first load with nothing kept, which the chunk decides once it is in).
 */
function Quiet({ line }: { line: string }) {
  return (
    <>
      <p className="dm-acct-desc">{line}</p>
      <p className="dm-acct-quiet" />
    </>
  )
}

/** An empty plot with one sentence: what the Managed card shows while there is nothing to draw (the frame makes it its plate). */
function Plot({ children }: { children: ReactNode }) {
  return (
    <div className="dm-acct-plot">
      <span>{children}</span>
    </div>
  )
}

/**
 * Managed positions: performance-v2 answers with rolling 24-hour cards only,
 * so the card carries that window as a fixed chip, never tabs, and never a
 * line. The history itself is rugged97's Performance screen, mounted inside
 * the automation frame (DESIGN-V2 §13.6): signed out, its sentence sits on a
 * dotted plate under the Domino-compound machine. Changed on purpose (owner,
 * 2026-09-27, round 5): the chip says the window in plain words.
 */
function ManagedCard() {
  return (
    <AutomationFrame
      title="Managed positions"
      titleId="managed-title"
      art="domino"
      aside={<Chip>Last 24 hours</Chip>}
      className="dm-acct-card animate-rise"
      style={rise(2)}
      data-managed-positions={Performance ? '' : undefined}
    >
      {Performance ? (
        <Suspense fallback={<Quiet line="How your automated positions did in the last 24 hours." />}>
          <Performance />
        </Suspense>
      ) : (
        <Plot>Managed history needs wallet sign-in, which isn’t available here.</Plot>
      )}
    </AutomationFrame>
  )
}

/** The full list of receipts: its own page under Positions (`#/positions/receipts`), which the Receipts card links. */
const receiptsHref = '#/positions/receipts'
/** How many rows the Receipts card shows before See all: the cancelled ones count as one. */
const RECENT = 4

/**
 * Receipts of what automation did, read with the wallet session: rugged97's
 * Execution screen, mounted inside the automation frame. Changed on purpose
 * (owner, 2026-09-27, round 5: the receipts ran down the page forever): the
 * card is a short Recent list, one row per receipt, and its See all opens the
 * full list on a page of its own.
 */
function ReceiptsCard({ limit, title = 'Receipts' }: { limit?: number; title?: string }) {
  return (
    <AutomationFrame
      title={title}
      titleId="receipts-title"
      art="receipt"
      className="dm-acct-card"
      aside={
        limit !== undefined &&
        Execution && (
          <a href={receiptsHref} className="dm-rcpt-all" aria-label="See all receipts" data-receipts-all="">
            See all
          </a>
        )
      }
    >
      {Execution ? (
        <Suspense fallback={<Quiet line="What automation did for your positions." />}>
          <Execution limit={limit} />
        </Suspense>
      ) : (
        <p className="dm-acct-quiet">Wallet sign-in isn’t available here, so automation receipts can’t be read.</p>
      )}
    </AutomationFrame>
  )
}

/** `#/positions/receipts`: every receipt read so far, newest first, with Show more for the next page. Positions stays lit in the header. */
function ReceiptsPage() {
  return (
    <PageShell>
      <a href="#/positions" className="dm-pos-back">
        <IconChevronLeft size={16} />
        Positions
      </a>
      <Display as="h1" className="dm-display-h1 dm-rcpt-title">
        Receipts
      </Display>
      <ReceiptsCard title="All receipts" />
    </PageShell>
  )
}

/** What automation is, where it stands, and the way to Automate. Static: the status comes from ROADMAP. */
function AutomationCard() {
  return (
    <section className="dm-card dm-acct-rail dm-acct-auto dm-acct-o6" aria-labelledby="automation-title">
      <h2 id="automation-title" className="dm-title">
        Automation
      </h2>
      <ul className="dm-acct-auto-list">
        <li>
          <IconTile icon={<IconAutomate />} />
          <div className="min-w-0">
            <p className="dm-acct-auto-name">
              <span>Auto-compound</span>
              <RoadmapPill name="Compound" />
            </p>
            <p className="dm-acct-auto-text">Fees go back into the same position.</p>
          </div>
        </li>
        <li>
          <IconTile icon={<IconPositions />} />
          <div className="min-w-0">
            <p className="dm-acct-auto-name">
              <span>Domino-compound</span>
              <RoadmapPill name="Domino" />
            </p>
            <p className="dm-acct-auto-text">The next range opens one step higher.</p>
          </div>
        </li>
      </ul>
      <LinkButton href={automateHref} variant="outline" size="sm" className="justify-self-start">
        Open Automate
      </LinkButton>
    </section>
  )
}

/**
 * Your positions in a build that carries no wallet (the fixture and bridge test builds): the card's frame and one
 * sentence. Every deployed build carries the wallet, and lists the connected wallet's positions in its place.
 */
function NoWalletHere() {
  return (
    <section className="dm-card dm-acct-nft-card dm-own-card" aria-labelledby="own-title" data-owned="unavailable">
      <div className="dm-own-head">
        <h2 id="own-title" className="dm-title">
          Your positions
        </h2>
      </div>
      <EmptyState icon={<IconWallet />} title="Connecting a wallet isn’t available here" data-empty="owned-unavailable" />
    </section>
  )
}

/**
 * Positions: what a person holds and what Domino runs for them. With a wallet
 * connected on Robinhood Chain, Your positions lists the positions it created
 * through Domino, open and closed, read from chain (never from the browser's
 * storage, never by a typed NFT id), and each row opens the position's own
 * page; the Wallet card reads the wallet's public token balances; the managed
 * side needs a wallet session. Opening the route with no wallet connected
 * reads nothing.
 */
function PositionsList() {
  const identity = useWalletIdentity()
  // Your positions shows its own filled action (Connect wallet, or New position when there is none yet): the title row's
  // New position steps back to secondary then, so one filled button leads the screen (§0.6).
  const [listEmpty, setListEmpty] = useState(false)
  const quietNew = OwnedPositions !== null && (identity.kind === 'disconnected' || (identity.kind === 'connected' && listEmpty))
  return (
    <PageShell>
      <div className="dm-acct-title animate-rise" style={rise(0)}>
        <div className="dm-acct-title-main">
          <Display as="h1" className="dm-display-h1">
            Positions
          </Display>
          {identity.kind === 'connected' && <ConnectedChip identity={identity} />}
        </div>
        <div className="dm-acct-title-actions">
          <LinkButton href={marketsHref()} variant="ghost">
            Markets
          </LinkButton>
          <LinkButton href={newPositionHref()} variant={quietNew ? 'secondary' : 'primary'}>
            New position
          </LinkButton>
        </div>
      </div>

      {/* Two columns from 1024px. Below that the columns dissolve and the cards take one column in the order the ordering classes give. */}
      <div className="dm-acct-grid">
        <div className="dm-acct-col">
          <div className="dm-acct-slot dm-acct-o1 dm-own-slot animate-rise" style={rise(1)}>
            {OwnedPositions ? (
              <Suspense fallback={<ListWaiting />}>
                <OwnedPositions identity={identity} deposits={heldDeposits} onEmptyAction={setListEmpty} kit={POSITION_KIT} />
              </Suspense>
            ) : (
              <NoWalletHere />
            )}
          </div>

          {/* Side by side from 1024px; stacked, after the rail's cards, below. */}
          <div className="dm-acct-pair">
            <ManagedCard />
            <ReceiptsCard limit={RECENT} />
          </div>
        </div>

        <div className="dm-acct-col">
          <div className="dm-acct-slot dm-acct-o4 animate-rise" style={rise(3)}>
            <PortfolioBody identity={identity} />
          </div>
          <AutomationCard />
        </div>
      </div>
    </PageShell>
  )
}

/**
 * `#/positions`: the list. `#/positions/<id>`, one canonical decimal NFT id,
 * is that position's own page; `#/positions/receipts` is the full list of
 * automation receipts; anything else after `#/positions/` (a list of ids
 * included: there is no lookup any more) is the list.
 */
export function Positions({ param = '' }: { param?: string }) {
  if (param === 'receipts') return <ReceiptsPage />
  const detail = positionDetailId(param)
  if (!detail) return <PositionsList />
  return (
    <Suspense fallback={<DetailWaiting />}>
      <PositionDetail key={detail} tokenId={detail} kit={POSITION_KIT} />
    </Suspense>
  )
}

/** Your positions' own frame while its chunk loads, so the column does not jump when it arrives. */
function ListWaiting() {
  return (
    <div className="dm-card dm-acct-nft-card dm-own-card" aria-hidden="true">
      <div className="dm-own-head">
        <p className="dm-title">Your positions</p>
      </div>
      <PendingSummary />
      <PendingRows />
    </div>
  )
}

/** A position's page while its chunk loads: the way back, and where the title will be. */
function DetailWaiting() {
  return (
    <PageShell>
      <a href="#/positions" className="dm-pos-back">
        <IconChevronLeft size={16} />
        Positions
      </a>
      <PositionSkeleton />
    </PageShell>
  )
}
