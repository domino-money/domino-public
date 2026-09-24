import { lazy, Suspense, useEffect, useState, type ComponentType, type CSSProperties, type ReactNode } from 'react'
import PortfolioBody from '../components/portfolio/PortfolioBody'
import { automateHref, marketsHref, newPositionHref } from '../components/explore/routes'
import { IconAutomate, IconChevronLeft, IconPositions } from '../components/icons'
import type { DepositsSlot, OwnedPositionsProps } from '../components/positions/OwnedPositions'
import { Chip, Display, LinkButton, PageShell, Skeleton } from '../components/ui'
import { shortAddress } from '../lib/read/screens/identity'
import { positionDetailId, positionsRoute } from '../lib/read/screens/positions'
import { ChainPositionsSlot, SlotBoundary, SlotFailed } from '../lib/read/screens/slots'
import { useWalletIdentity, type WalletIdentityView } from '../lib/walletIdentity'
import { createdPositions } from '../lib/positionMemory'
import { RoadmapPill } from './Automate'

type Connected = Extract<WalletIdentityView, { kind: 'connected' }>

// The private, signed-in side of managed positions, in builds that carry the
// wallet session: performance history and execution receipts. Each is its own
// chunk, loaded only when this page is open in such a build; elsewhere the
// constant is null and nothing is imported. The stand-in takes any props, so
// it can stand in for a chunk whose component takes some (HeldDeposits).
const couldNotLoad = () => ({ default: (_props: object) => <p role="alert" className="dm-acct-quiet">This section couldn’t load. Reload to try again.</p> })
const Performance = __DOMINO_WALLET_SESSION__ ? lazy(() => import('./Performance').catch(couldNotLoad)) : null
const Execution = __DOMINO_WALLET_SESSION__ ? lazy(() => import('./Execution').catch(couldNotLoad)) : null
// The deposits the wallet has not turned into a position, each with its refund: its own chunk, in wallet builds only.
// Typed from the slot's own props, so this screen names nothing of that chunk but its lazy import.
const HeldDeposits = __DOMINO_WALLET_SESSION__ ? lazy<ComponentType<Parameters<DepositsSlot>[0]>>(() => import('../components/positions/HeldDeposits').catch(couldNotLoad)) : null

// Your positions and a position's own page: chunks of their own, loaded only on Positions, so no other page pays for
// them. The list exists only where a wallet can connect; the page is public chain data and opens in every build.
const OwnedPositions = __DOMINO_WALLET_SESSION__ ? lazy<ComponentType<OwnedPositionsProps>>(() => import('../components/positions/OwnedPositions').catch(couldNotLoad)) : null
const PositionDetail = lazy<ComponentType<{ tokenId: string }>>(() => import('./PositionDetail').catch(couldNotLoad))

/** The held deposits under Your positions, drawn by HeldDeposits once its chunk is in; nothing while it loads. */
const heldDeposits: DepositsSlot | null = HeldDeposits
  ? (props) => (
      <Suspense fallback={null}>
        <HeldDeposits {...props} />
      </Suspense>
    )
  : null

/** The first four blocks of the page rise in on mount, 60 ms apart; nothing after them does. */
const rise = (step: number) => ({ '--delay': `${step * 60}ms` }) as CSSProperties

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

/** An empty plot with one sentence: what the Managed card shows while there is nothing to draw. */
function Plot({ children, status = false }: { children: ReactNode; status?: boolean }) {
  return (
    <div className="dm-acct-plot dm-dots-chart" role={status ? 'status' : undefined}>
      <span>{children}</span>
    </div>
  )
}

/**
 * Managed positions: performance-v2 answers with rolling 24-hour cards only,
 * so the card carries that window as a fixed chip, never tabs, and never a
 * line. The history itself is rugged97's Performance screen, mounted inside.
 */
function ManagedCard() {
  return (
    <section
      className="dm-card dm-acct-card dm-acct-o2 animate-rise"
      style={rise(2)}
      aria-labelledby="managed-title"
      data-managed-positions={Performance ? '' : undefined}
    >
      <div className="dm-acct-card-head">
        <Display as="h2" id="managed-title" className="dm-display-card">
          Managed positions
        </Display>
        <Chip>Rolling 24-hour window</Chip>
      </div>
      <div className="dm-acct-card-body">
        {Performance ? (
          <Suspense fallback={<Plot status>Loading managed positions…</Plot>}>
            <Performance />
          </Suspense>
        ) : (
          <Plot>Managed history needs wallet sign-in, which isn’t available here.</Plot>
        )}
      </div>
    </section>
  )
}

/** Receipts of what automation did, read with the wallet session: rugged97's Execution screen, mounted inside. */
function ReceiptsCard() {
  return (
    <section className="dm-card dm-acct-card dm-acct-o3" aria-labelledby="receipts-title">
      <div className="dm-acct-card-head">
        <Display as="h2" id="receipts-title" className="dm-display-card">
          Receipts
        </Display>
      </div>
      <div className="dm-acct-card-body">
        {Execution ? (
          <Suspense
            fallback={
              <p role="status" className="dm-acct-quiet">
                Loading receipts…
              </p>
            }
          >
            <Execution />
          </Suspense>
        ) : (
          <p className="dm-acct-quiet">Wallet sign-in isn’t available here, so automation receipts can’t be read.</p>
        )}
      </div>
    </section>
  )
}

/** What automation is, where it stands, and the way to Automate. Static: the status comes from ROADMAP. */
function AutomationCard() {
  return (
    <section className="dm-card dm-acct-rail dm-acct-o6" aria-labelledby="automation-title">
      <Display as="h2" id="automation-title" className="dm-display-rail">
        Automation
      </Display>
      <ul className="dm-acct-auto-list">
        <li>
          <IconAutomate className="dm-acct-auto-icon" />
          <div className="min-w-0">
            <p className="dm-acct-auto-name">
              <span>Auto-compound</span>
              <RoadmapPill name="Compound" />
            </p>
            <p className="dm-acct-auto-text">Fees go back into the same position.</p>
          </div>
        </li>
        <li>
          <IconPositions className="dm-acct-auto-icon" />
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
 * The typed-id lookup (the read screens' ChainPositionsSection): a public read
 * of any position NFT by its id, in its own chunk, loaded when it is shown.
 */
function LookupSlot() {
  if (!ChainPositionsSlot || !SlotBoundary || !SlotFailed) return null
  return (
    <SlotBoundary
      fallback={
        <div className="dm-card p-4">
          <SlotFailed />
        </div>
      }
    >
      <Suspense
        fallback={
          // The card's own title while its chunk loads, so the column does not jump when it arrives.
          <div className="dm-card dm-acct-nft-card dm-acct-slot-wait" aria-hidden="true">
            <div className="dm-acct-nft-head">
              <p className="dm-display-card">Position NFTs</p>
            </div>
          </div>
        }
      >
        <ChainPositionsSlot />
      </Suspense>
    </SlotBoundary>
  )
}

/**
 * Looking a position up by its NFT id, under Your positions: closed until
 * someone opens it, open by itself when the link carries ids to look up or
 * when the wallet's own list could not be read in full. The lookup mounts
 * only while open, so a closed one reads and loads nothing.
 */
function LookupDisclosure({ open, onToggle }: { open: boolean; onToggle: (open: boolean) => void }) {
  return (
    <details className="dm-details dm-own-lookup" open={open} onToggle={(event) => onToggle(event.currentTarget.open)} data-lookup-disclosure="">
      <summary>Look up by NFT id</summary>
      {open && (
        <div className="dm-own-lookup-body">
          <LookupSlot />
        </div>
      )}
    </details>
  )
}

/**
 * Positions: what a person holds and what Domino runs for them. With a wallet
 * connected on Robinhood Chain, Your positions lists every position NFT it
 * holds, open and closed, and each row opens the position's own page; the
 * Wallet card reads the wallet's public token balances; the managed side needs
 * a wallet session. Opening the route with no wallet connected and no ids in
 * the link reads nothing. A build without the wallet has no list to make, and
 * shows the lookup by NFT id in its place.
 */
/** A `#/positions/<ids>` link that carries ids to look up; on the list, never a single one (that is a position's page). */
function linkCarriesIds(hash: string) {
  const route = positionsRoute(hash)
  return route.onRoute && route.ids !== ''
}

function PositionsList() {
  const identity = useWalletIdentity()
  // Open on arrival when the link carries ids to look up (`#/positions/<id>,<id>`), which a single id never is here.
  const [lookupOpen, setLookupOpen] = useState(() => linkCarriesIds(window.location.hash))
  // And when such a link arrives while the list is open.
  useEffect(() => {
    const onChange = () => {
      if (linkCarriesIds(window.location.hash)) setLookupOpen(true)
    }
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
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
          <LinkButton href={newPositionHref()}>New position</LinkButton>
        </div>
      </div>

      {/* Two columns from 1024px. Below that the columns dissolve and the cards take one column in the order the ordering classes give. */}
      <div className="dm-acct-grid">
        <div className="dm-acct-col">
          <div className="dm-acct-slot dm-acct-o1 dm-own-slot animate-rise" style={rise(1)}>
            {OwnedPositions ? (
              <>
                <Suspense fallback={<ListWaiting />}>
                  <OwnedPositions identity={identity} deposits={heldDeposits} remembered={createdPositions} onUnlisted={setLookupOpen} />
                </Suspense>
                <LookupDisclosure open={lookupOpen} onToggle={setLookupOpen} />
              </>
            ) : (
              // No wallet in this build, so no list: the lookup by NFT id is the way in, on the page itself.
              <LookupSlot />
            )}
          </div>

          <ManagedCard />

          <ReceiptsCard />
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
 * is that position's own page; a list of ids (`#/positions/1,2`) is the list
 * with the lookup open on them.
 */
export function Positions({ param = '' }: { param?: string }) {
  const detail = positionDetailId(param)
  if (!detail) return <PositionsList />
  return (
    <Suspense fallback={<DetailWaiting />}>
      <PositionDetail key={detail} tokenId={detail} />
    </Suspense>
  )
}

/** Your positions' own frame while its chunk loads, so the column does not jump when it arrives. */
function ListWaiting() {
  return (
    <div className="dm-card dm-acct-nft-card dm-acct-slot-wait" aria-hidden="true">
      <div className="dm-own-head">
        <p className="dm-display-card">Your positions</p>
      </div>
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
      <div className="dm-pos-title" aria-hidden="true">
        <div className="dm-pos-name">
          <Skeleton className="size-10 rounded-full" />
          <Skeleton className="h-7 w-44" />
        </div>
      </div>
    </PageShell>
  )
}
