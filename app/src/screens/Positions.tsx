import { lazy, Suspense, type CSSProperties, type ReactNode } from 'react'
import PortfolioBody from '../components/portfolio/PortfolioBody'
import { automateHref, marketsHref, newPositionHref } from '../components/explore/routes'
import { IconAutomate, IconPositions, IconReceipt } from '../components/icons'
import { Chip, Display, EmptyState, LinkButton, PageShell } from '../components/ui'
import { shortAddress } from '../lib/read/screens/identity'
import { ChainPositionsSlot, SlotBoundary, SlotFailed } from '../lib/read/screens/slots'
import { useWalletIdentity, type WalletIdentityView } from '../lib/walletIdentity'
import { RoadmapPill } from './Automate'

type Connected = Extract<WalletIdentityView, { kind: 'connected' }>

// The private, signed-in side of managed positions, in builds that carry the
// wallet session: performance history and execution receipts. Each is its own
// chunk, loaded only when this page is open in such a build; elsewhere the
// constant is null and nothing is imported.
const couldNotLoad = () => ({ default: () => <p role="alert" className="dm-acct-quiet">This section couldn’t load. Reload to try again.</p> })
const Performance = __DOMINO_WALLET_SESSION__ ? lazy(() => import('./Performance').catch(couldNotLoad)) : null
const Execution = __DOMINO_WALLET_SESSION__ ? lazy(() => import('./Execution').catch(couldNotLoad)) : null

/** The first four blocks of the page rise in on mount, 60 ms apart; nothing after them does. */
const rise = (step: number) => ({ '--delay': `${step * 60}ms` }) as CSSProperties

/**
 * The header's wallet, named beside the title. A connection is not a sign-in
 * and proves nothing about who owns a looked-up NFT, and no read lists the
 * positions a wallet holds, so the chip says only the address, and its title
 * says what the connection does and does not give this page.
 */
function ConnectedChip({ identity }: { identity: Connected }) {
  return (
    <Chip
      variant="plate"
      className="dm-acct-wallet-chip"
      title="Connected, not signed in. The read service can't list positions by wallet, so look them up by NFT id."
      data-connected-wallet=""
    >
      <span aria-hidden="true" className="dm-acct-dot" />
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
      className="dm-card dm-acct-card dm-acct-o1 animate-rise"
      style={rise(1)}
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
          <Plot>Managed history needs wallet sign-in, which isn't available here.</Plot>
        )}
      </div>
    </section>
  )
}

/** Receipts of what automation did, read with the wallet session: rugged97's Execution screen, mounted inside. */
function ReceiptsCard() {
  return (
    <section className="dm-card dm-acct-card dm-acct-o4" aria-labelledby="receipts-title">
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
          <EmptyState
            icon={<IconReceipt />}
            title="Receipts need wallet sign-in"
            body="Wallet sign-in isn't available here, so automation receipts can't be read."
          />
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
 * Positions: what a person holds and what Domino runs for them. Position NFTs
 * are looked up by id from chain, since no read lists them by wallet; the
 * Wallet card reads the connected wallet's public token balances; the managed
 * side needs a wallet session. Opening the route with no wallet connected and
 * no address in the link reads nothing.
 */
export function Positions() {
  const identity = useWalletIdentity()
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
          <ManagedCard />

          {/* Public position NFTs, looked up by id: nothing is read until asked, or until a link that carries ids arrives. */}
          <div className="dm-acct-slot dm-acct-o2 animate-rise" style={rise(2)}>
            {ChainPositionsSlot && SlotBoundary && SlotFailed && (
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
            )}
          </div>

          <ReceiptsCard />
        </div>

        <div className="dm-acct-col">
          <div className="dm-acct-slot dm-acct-o3 animate-rise" style={rise(3)}>
            <PortfolioBody identity={identity} />
          </div>
          <AutomationCard />
        </div>
      </div>
    </PageShell>
  )
}
