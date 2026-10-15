// The screens' own styles (styles/screens.css, F8): loaded with the first screen that needs them, never on Home's first paint.
import '../styles/screens.css'
import { lazy, Suspense, useCallback, useEffect, useState, type ComponentType, type CSSProperties, type ReactNode } from 'react'
import { deferred } from '../components/Deferred'
import { recovering } from '../lib/staleRelease'
import PortfolioBody from '../components/portfolio/PortfolioBody'
import { automateHref, marketsHref, newPositionHref } from '../components/explore/routes'
import { IconTile } from '../components/figures'
import { IconAutomate, IconChevronLeft, IconPositions, IconRange, IconWallet } from '../components/icons'
import type { DepositsSlot, OwnedPositionsProps } from '../components/positions/OwnedPositions'
import { PendingRows, PendingSummary } from '../components/positions/PositionRow'
import { AutomationFrame } from '../components/positions/visual/AutomationFrame'
import { PositionSkeleton } from '../components/positions/visual/PositionSkeleton'
import { Button, Chip, Display, EmptyState, LinkButton, PageShell } from '../components/ui'
import { MANAGED_LINE, NO_SIGN_IN_BOTH, automationLayout, sameShows, type CardShows } from '../lib/automationCards'
import { chainRead } from '../lib/fees/answers'
import { warmState } from '../lib/fees/client'
import { parseAddressInput, shortAddress } from '../lib/read/screens/identity'
import { portfolioRoute, positionDetailId } from '../lib/read/screens/positions'
import { useWalletIdentity, walletKey, type WalletIdentityView } from '../lib/walletIdentity'
import { AUTO_EXIT_FEATURE } from '../lib/automate/features'
import { useRouteTitle } from '../lib/routeTitle'

type Connected = Extract<WalletIdentityView, { kind: 'connected' }>

// The private, signed-in side of managed positions, in builds that carry the
// wallet session: performance history and execution receipts. Each is its own
// chunk, loaded only when this page is open in such a build; elsewhere the
// constant is null and nothing is imported. The stand-in takes any props, so
// it can stand in for a chunk whose component takes some (HeldDeposits, and
// Execution's preview limit).
const couldNotLoad = () => ({ default: CouldNotLoad })
/** What a card tells the page it shows (lib/automationCards.ts): Managed positions and Receipts. */
type TellShows = (shows: CardShows | null) => void
const Performance = __DOMINO_WALLET_SESSION__ ? lazy<ComponentType<{ onShows?: TellShows }>>(recovering(() => import('./Performance'), couldNotLoad)) : null
const Execution = __DOMINO_WALLET_SESSION__ ? lazy<ComponentType<{ limit?: number; onShows?: TellShows }>>(recovering(() => import('./Execution').then(({ default: View }) => ({ default: View })), couldNotLoad)) : null
// V2 uses one chronological public/private history. A failed chunk cannot silently substitute a partial old history.
const V2Receipts = __DOMINO_WALLET_SESSION__ && __DOMINO_V2__ ? lazy<ComponentType<{ limit?: number; onShows?: TellShows }>>(recovering(() => import('../v2in/lists/Receipts'), couldNotLoad)) : null
// The deposits the wallet has not turned into a position, each with its refund: its own chunk, in wallet builds only.
// Typed from the slot's own props, so this screen names nothing of that chunk but its lazy import.
const HeldDeposits = __DOMINO_WALLET_SESSION__ ? lazy<ComponentType<Parameters<DepositsSlot>[0]>>(recovering(() => import('../components/positions/HeldDeposits'), couldNotLoad)) : null
// 2026-10-02 (the V1 incident of rugged97's spec rev3 §2.13): the fees waiting in the connected wallet's vaults, each with
// Withdraw to wallet, whatever became of the vault's root position. Its own chunk, in wallet builds only; it shows nothing
// while there is nothing to withdraw, and nothing in place of a chunk that cannot load.
const FeeReserves = __DOMINO_WALLET_SESSION__ ? lazy<ComponentType<{ owner: string; placement: 'positions' | 'position' }>>(recovering(() => import('../components/positions/FeeReserves'), () => ({ default: () => null }))) : null
// Domino V2 (integration, 2026-10-02): Managed positions with Domino's vaults (each vault's state, the fees waiting in it,
// Withdraw to wallet, Leave automation), only in a build that carries V2.
// Changed on purpose 2026-10-06 (rugged's answer of 6 Oct, §3: performance-v2 is off on purpose, it is V1's "Start
// tracking", and V1 is off since 2026-10-05): in that build the card is the vaults' alone, from read-v6's portfolio, and
// V1's Performance is never mounted (it asked performance-v2/epochs once signed in); a chunk that cannot load says so in
// its own line, as the other private cards do, where V1's Performance stood in for it (2026-10-03, review #7). `receipts`:
// what the Receipts card says, which the vaults' card says too while it lists nothing of its own.
type ManagedProps = { onShows?: TellShows; receipts?: CardShows | null }
const V2Managed = __DOMINO_V2__ ? lazy<ComponentType<ManagedProps>>(recovering(() => import('../v2in/automate/ManagedVaults'), () => ({ default: () => <CouldNotLoad /> }))) : null

// Your positions and a position's own page: chunks of their own, loaded only on Positions, so no other page pays for
// them. The list exists only where a wallet can connect; the page is public chain data and opens in every build.
// 2026-09-28 (speed wave B, item 24): drawn as soon as their chunk is in (components/Deferred.tsx), not 300 ms after
// their fallback as a Suspense boundary reveals them.
const OwnedPositions = __DOMINO_WALLET_SESSION__ ? deferred<OwnedPositionsProps>(recovering(() => import('../components/positions/OwnedPositions'), couldNotLoad)) : null
// Its default only (2026-10-03): the module also carries the test builds' Price range lab (PositionDetail.tsx RangeLab).
const PositionDetail = deferred<{ tokenId: string }>(recovering(() => import('./PositionDetail').then((module) => ({ default: module.default })), couldNotLoad))
// Changed on purpose (data) 2026-10-02 (Domino V2 integration): a position V1's reads do not cover (`#/positions/<chain>-
// v<dex>-<id>`, src/v2in/route.ts: v3, Base, Arbitrum One) opens the same page from its own chunk, in a build with V2
// only; where V2 is off there it draws this list, as any other segment does.
const V2Position = __DOMINO_V2__ ? deferred<{ param: string; list: ReactNode }>(recovering(() => import('../v2in/position/PositionPage'), couldNotLoad)) : null

/**
 * 2026-09-28 (speed wave B, item 24): what Positions reads, asked as soon as the route is known, outside the chunk that
 * draws it: a position's state (its page takes it, lib/fees/client.ts warmState). The wallet's list is read as its card's
 * chunk is in, which nothing holds back any more (components/Deferred.tsx). RPC-SPEC (2026-10-01): the list and a
 * position's feature are the site's routes' now (lib/edge/chainRoutes.ts). Changed on purpose 2026-10-02 (RPC-SPEC §11.4):
 * there is no fees worker to fetch ahead any more.
 */
function useWarmPositions(detail: string | null): void {
  useEffect(() => {
    if (!detail || !chainRead()) return
    warmState(detail)
  }, [detail])
}

/** The held deposits under Your positions, drawn by HeldDeposits once its chunk is in; nothing while it loads. */
const heldDeposits: DepositsSlot | null = HeldDeposits
  ? (props) => (
      <Suspense fallback={null}>
        <HeldDeposits {...props} />
      </Suspense>
    )
  : null

/**
 * A chunk that could not load, in its place: its one line. 2026-10-01 (audit D2): a card that cannot load says it has
 * a line of its own (lib/automationCards.ts), so Managed positions and Receipts show it rather than one line for both.
 */
function CouldNotLoad(props: object) {
  const onShows = (props as { onShows?: TellShows }).onShows
  useEffect(() => onShows?.({ kind: 'other' }), [onShows])
  // (2026-10-15, pack 7 review): a section whose chunk failed never comes back on its own, so its line asking for a reload stays.
  return <p role="alert" className="dm-acct-quiet">This section couldn’t load. Reload to try again.</p>
}

/** The first four blocks of the page rise in on first load, 40 ms apart (one --stagger); nothing after them does. */
const rise = (step: number) => ({ '--delay': `${step * 40}ms` }) as CSSProperties

/**
 * The header's wallet, named beside the title. A connection is not a sign-in:
 * the chip says only the address, and its title says so.
 */
function ConnectedChip({ identity }: { identity: Connected }) {
  return (
    <Chip variant="plate" className="dm-acct-wallet-chip" title="Connected wallet" data-connected-wallet="">
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
 * 2026-09-27, round 5): the chip says the window in plain words. Changed on
 * purpose 2026-10-06 (rugged's answer of 6 Oct, §3): in a build that carries
 * Domino V2 the card is the vaults' (src/v2in/automate/ManagedVaults.tsx),
 * with no Performance in it.
 */
function ManagedCard({ hidden, onShows, receipts = null }: { hidden?: boolean; onShows?: TellShows; receipts?: CardShows | null }) {
  return (
    <AutomationFrame
      title={__DOMINO_V2__ ? 'Automated positions' : 'Managed positions'}
      titleId="managed-title"
      art="domino"
      aside={__DOMINO_V2__ ? undefined : <Chip>Last 24 hours</Chip>}
      className="dm-acct-card animate-rise"
      style={rise(2)}
      hidden={hidden}
      data-managed-positions={Performance ? '' : undefined}
    >
      {Performance ? (
        <Suspense fallback={<Quiet line={__DOMINO_V2__ ? 'Current automation and any funds waiting to be recovered.' : MANAGED_LINE} />}>
          {V2Managed ? <V2Managed onShows={onShows} receipts={receipts} /> : <Performance onShows={onShows} />}
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
function ReceiptsCard({ limit, title = 'Receipts', hidden, onShows }: { limit?: number; title?: string; hidden?: boolean; onShows?: TellShows }) {
  return (
    <AutomationFrame
      title={title}
      titleId="receipts-title"
      art="receipt"
      className="dm-acct-card"
      hidden={hidden}
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
          {__DOMINO_V2__ && V2Receipts ? <V2Receipts limit={limit} onShows={onShows} /> : <Execution limit={limit} onShows={onShows} />}
        </Suspense>
      ) : (
        <p className="dm-acct-quiet">Wallet sign-in isn’t available here, so automation receipts can’t be read.</p>
      )}
    </AutomationFrame>
  )
}

/** Opens the header's wallet dialog, where a wallet is connected, signed in or signed out. */
const openWallet = () => document.querySelector<HTMLButtonElement>('header [aria-haspopup="dialog"]')?.click()

/**
 * Managed positions and Receipts with nothing to show, for the same reason (2026-10-01, audit D2): one calm line for
 * both, as their own lines said it, with its one button (Sign in, or Open wallet for another account's session). While
 * either card has not said yet (its chunk loading, the session checked), nothing under the title.
 */
function OneLine({ line }: { line: Extract<CardShows, { kind: 'none' }> | null }) {
  return (
    <section className="dm-card dm-acct-card dm-acct-merged animate-rise" style={rise(2)} aria-labelledby="automation-merged-title" data-automation-empty={line?.reason ?? ''}>
      <div className="dm-acct-card-head">
        <h2 id="automation-merged-title" className="dm-title">
          {__DOMINO_V2__ ? 'Automated positions and activity' : 'Managed positions and receipts'}
        </h2>
      </div>
      <div className="dm-acct-merged-body">
        <p className="dm-acct-merged-line">{line?.text}</p>
        {line?.action && (
          <Button type="button" variant="outline" size="sm" onClick={openWallet}>
            {line.action}
          </Button>
        )}
      </div>
    </section>
  )
}

/**
 * Managed positions and Receipts, side by side from 1024px (2026-10-01, audit D2: with nothing to show, they were two
 * large empty plates saying the same thing twice). Each card tells this pair what it shows (lib/automationCards.ts);
 * while neither has anything for the same reason, one line stands in their place, and both cards stay mounted, hidden,
 * so they go on reading and come back the moment either has something. In a build that cannot sign in, always the line.
 */
function AutomationPair() {
  const [managed, setManaged] = useState<CardShows | null>(null)
  const [receipts, setReceipts] = useState<CardShows | null>(null)
  // The cards tell after every render: what says the same as before changes nothing (the same object is kept).
  const tellManaged = useCallback<TellShows>((next) => setManaged((old) => (sameShows(old, next) ? old : next)), [])
  const tellReceipts = useCallback<TellShows>((next) => setReceipts((old) => (sameShows(old, next) ? old : next)), [])
  const layout = Performance && Execution ? automationLayout(managed, receipts) : ({ kind: 'merged', line: { kind: 'none', reason: 'unavailable', text: NO_SIGN_IN_BOTH, action: null } } as const)
  const merged = layout.kind === 'merged'
  if (__DOMINO_V2__) return <div className="dm-acct-v2-history" data-automation-cards="integrated">
    {V2Managed && <Suspense fallback={null}><V2Managed /></Suspense>}
    <ReceiptsCard limit={RECENT} />
  </div>
  return (
    <div className="dm-acct-pair" data-automation-cards={layout.kind}>
      {merged && <OneLine line={layout.line} />}
      <ManagedCard hidden={merged} onShows={tellManaged} receipts={receipts} />
      <ReceiptsCard limit={RECENT} hidden={merged} onShows={tellReceipts} />
    </div>
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

/**
 * A short introduction to both modes. Actual automation status belongs to each position. Changed on purpose 2026-10-06
 * (the integration review, ux #9): in a build that carries V2, Auto-exit too, by its own name and line, so Automate's
 * "Choose a position" lands where Auto-exit is named (each position's own page turns it on).
 */
function AutomationCard() {
  return (
    <section className="dm-card dm-acct-rail dm-acct-auto dm-acct-o6" aria-labelledby="automation-title">
      <div className="dm-acct-auto-head">
        <h2 id="automation-title" className="dm-title">Automation</h2>
        <LinkButton href={automateHref} variant="ghost" size="sm" aria-label="Open Automate">Explore <span aria-hidden="true">↗</span></LinkButton>
      </div>
      <ul className="dm-acct-auto-list">
        <li>
          <IconTile icon={<IconAutomate />} />
          <div className="min-w-0">
            <p className="dm-acct-auto-name">
              <span>Auto-compound</span>
            </p>
            <p className="dm-acct-auto-text">Reinvest earned fees</p>
          </div>
        </li>
        <li>
          <IconTile icon={<IconPositions />} />
          <div className="min-w-0">
            <p className="dm-acct-auto-name">
              <span>Domino-compound</span>
            </p>
            <p className="dm-acct-auto-text">Fund the next range</p>
          </div>
        </li>
        {__DOMINO_V2__ && (
          <li data-automation-feature="auto-exit">
            <IconTile icon={<IconRange />} />
            <div className="min-w-0">
              <p className="dm-acct-auto-name">
                <span>{AUTO_EXIT_FEATURE.name}</span>
              </p>
              <p className="dm-acct-auto-text">Close at the range limit</p>
            </div>
          </li>
        )}
      </ul>
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

/** The address a `#/portfolio/<address>` link names, lowercase, when it is one (audit V7); null otherwise. */
function linkedAddress(): string | null {
  const route = portfolioRoute(window.location.hash)
  if (!route.onRoute || !route.address) return null
  const parsed = parseAddressInput(route.address)
  return parsed.ok ? parsed.key : null
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
  // 2026-10-01 (audit V7): the address a `#/portfolio/<address>` link views (the Wallet card's View address), whose
  // positions the list shows read-only in place of the wallet's own; null on `#/positions`. Read from the link at once,
  // then told by the Wallet card, which follows View address, Use the connected wallet and the browser's Back.
  const [linked, setLinked] = useState<string | null>(linkedAddress)
  const viewing = linked !== null && !(identity.kind === 'connected' && identity.address.toLowerCase() === linked)
  // Your positions shows its own filled action (Connect wallet, or New position when there is none yet): the title row's
  // New position steps back to secondary then, so one filled button leads the screen (§0.6).
  const [listEmpty, setListEmpty] = useState(false)
  const quietNew = OwnedPositions !== null && !viewing && (identity.kind === 'disconnected' || (identity.kind === 'connected' && listEmpty))
  return (
    <PageShell className="dm-positions-page">
      <div className="dm-acct-title animate-rise" style={rise(0)}>
        <div className="dm-acct-title-copy">
        <div className="dm-acct-title-main">
          <Display as="h1" className="dm-display-h1">
            Positions
          </Display>
          {identity.kind === 'connected' && <ConnectedChip identity={identity} />}
        </div>
        </div>
        <div className="dm-acct-title-actions">
          {identity.kind === 'connected' && !viewing ? (
            <LinkButton href={receiptsHref} variant="outline" data-positions-receipts="">
              Receipts
            </LinkButton>
          ) : (
            <LinkButton href={marketsHref()} variant="ghost">
              Markets
            </LinkButton>
          )}
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
                <OwnedPositions fallback={<ListWaiting />} identity={identity} deposits={heldDeposits} onEmptyAction={setListEmpty} viewed={viewing ? linked : null} />
              </Suspense>
            ) : (
              <NoWalletHere />
            )}
          </div>

          {/* The fees waiting in the wallet's vaults, right under its positions (2026-10-02): only while there is something to
              withdraw, and never while another address is viewed. Connected is enough: withdrawing needs no sign-in. */}
          {FeeReserves && !viewing && walletKey(identity) !== null && identity.kind === 'connected' && (
            <Suspense fallback={null}>
              <FeeReserves owner={identity.address.toLowerCase()} placement="positions" />
            </Suspense>
          )}

          {/* Side by side from 1024px; stacked, after the rail's cards, below; one line for both while neither has anything.
              Not while another address is viewed (fix round 1): they are the signed-in wallet's, never that address's. */}
          {!viewing && <AutomationPair />}
        </div>

        <div className="dm-acct-col">
          <div className="dm-acct-slot dm-acct-o4 animate-rise" style={rise(3)}>
            <PortfolioBody identity={identity} onLinked={setLinked} />
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
  // Robinhood V4 aliases use the same public read page as numeric ids, even when S1 writes are unavailable.
  const detail = positionDetailId(__DOMINO_V2__ ? param.replace(/^robinhood-v4-/, '') : param)
  useWarmPositions(detail)
  // The tab's name (lib/routeTitle.ts, audit E11): the list, its receipts, or one position by its number.
  useRouteTitle(param === 'receipts' ? 'Receipts' : detail ? `Position #${detail}` : 'Positions')
  if (param === 'receipts') return <ReceiptsPage />
  if (!detail && __DOMINO_V2__ && V2Position && /^(robinhood|base|arbitrum)-v[34]-[1-9][0-9]{0,77}$/.test(param)) return <V2Position param={param} list={<PositionsList />} fallback={<DetailWaiting />} />
  if (!detail) return <PositionsList />
  return (
    <Suspense fallback={<DetailWaiting />}>
      <PositionDetail key={detail} fallback={<DetailWaiting />} tokenId={detail} />
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
