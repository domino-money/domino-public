import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { RowsHead } from '../../components/positions/PositionRow'
import { Button, EmptyState, LinkButton, Tabs } from '../../components/ui'
import { positionRows, partialSentence, type PositionRowView } from './model'
import { V2PositionRow } from './parts'
import { anyIn, chainsIn, useCreatedPositions, useKeyed, useKeyedLatest, useListsGate, useUsdAged } from './hooks'
import { routeQuiet } from './read'
import { OWN_PORTFOLIO } from './source'
import { hasPositionApr, historicalPositionRows, mergePositionRows, positionCounts, withCreatedPositions } from './positionCollection'
import { positionObservation, subscribePositionChanges, type PositionIdentity, type PositionObservation } from './positionSync'
import { feesStore } from '../../lib/fees/spawn'
import type { FeeHistoryView } from '../../lib/fees/types'
import { rowAprs } from '../../components/positions/listApr'
import { PendingRows } from '../../components/positions/PositionRow'
import { useWalletAnswer, walletAnswerAt, walletChanged, type WalletAnswer } from '../../lib/walletPositions'
import { POSITION_VALUATIONS, type PositionValuations } from './valuation'
import type { DepositsSlot } from '../../components/positions/OwnedPositions'
import { shortAddress } from '../../lib/read/screens/identity'
import { newPositionHref } from '../../components/explore/routes'
import '../../styles/position-collection.css'
import { BulkClosePositions } from './BulkClosePositions'
import { automationState, subscribeAutomation } from '../automate/store'

const noViews: ReadonlyMap<string, FeeHistoryView> = new Map()
const quiet = () => undefined
const PAGE_SIZE = 10
export interface OwnedCollectionProps { owner: string; readOnly?: boolean; deposits: DepositsSlot | null; onEmptyAction?: (shown: boolean) => void }

function useCollectionAprs(ids: string, active: boolean) {
  const watch = useCallback((listener: () => void) => ids ? feesStore.watch(ids.split(','), listener) : quiet, [ids])
  const snapshot = useCallback(() => ids ? feesStore.views(ids.split(',')) : noViews, [ids])
  const views = useSyncExternalStore(watch, snapshot, () => noViews)
  useEffect(() => ids && active ? feesStore.subscribeHistory(ids.split(','), 'list', quiet) : undefined, [ids, active])
  return useMemo(() => rowAprs(ids ? ids.split(',') : [], views), [ids, views])
}

/** One collection and one count for each NFT, independent of which inventory discovered it first. */
export function OwnedCollection({ owner, readOnly = false, deposits, onEmptyAction }: OwnedCollectionProps) {
  // Changed on purpose 2026-10-14 (the incident of 2026-10-13, package V1): read-v6's rows are not valued on their own
  // here; each NFT's row is joined with the site's inventory first, and the row that is shown is valued once (below).
  // (2026-10-15, pack 8): moved up from below, so a created position's row is drawn from the newest state reading too.
  const [observation, setObservation] = useState(() => positionObservation)
  const own = useOwnRows(owner, [], null, observation)
  const latest = useKeyedLatest(OWN_PORTFOLIO, own.live ? owner : null)
  // Historical inventory discovers older valid NFTs. It does not poll or drive the newer inventory's loading state.
  const [version, setVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  useEffect(() => { busyRef.current = busy }, [busy])
  const historical = useWalletAnswer(owner, version, null, busyRef, !readOnly)
  const [kept, setKept] = useState<WalletAnswer | null>(null)
  const current = historical.phase === 'ready' ? historical.answer : null
  if (current !== null && current !== kept) setKept(current)
  const retained = current ?? kept
  // Changed on purpose 2026-10-14 (package V1, review): a state reading (and the end of a wallet-wide hold, which is
  // told the same way) works the rows out again, with no read. The rows were worked out again only when the portfolio
  // reader drew something (./source.ts reprojects a good answer; a failed one is a new reply), so with no good answer
  // held and none coming (an answer read-v6's contract refuses is asked again after five minutes) a row of the site's
  // own inventory stayed on an older state reading than the browser held, and did not leave "Updating" when its hold
  // ended. Dated by that older reading, it would say "as of" on a page whose state route answers.
  // `observation`: where the rows look a state reading up, a new function with each such word (it is what changes).
  useEffect(() => subscribePositionChanges((change) => {
    if (change.kind === 'state') setObservation(() => (identity: PositionIdentity) => positionObservation(identity))
    else if (!change.wallet || change.wallet === owner) setVersion((value) => value + 1)
  }), [owner])
  const rows = useMemo(() => mergePositionRows(historicalPositionRows(retained, current !== null, retained ? walletAnswerAt(retained) : null, observation), own.rows), [retained, current, own.rows, observation])
  const counts = useMemo(() => positionCounts(rows), [rows])
  const [chosen, setChosen] = useState<'open' | 'closed' | null>(null)
  const tab = chosen ?? (counts.open === 0 && counts.pending === 0 && counts.closed > 0 ? 'closed' : 'open')
  const [pages, setPages] = useState({ open: 1, closed: 1 })
  const matches = rows.filter((row) => row.tab === tab || (tab === 'open' && row.tab === 'pending'))
  const shown = matches.slice(0, pages[tab] * PAGE_SIZE)
  // Added 2026-10-14 (package V1, decision D4): nothing newer has arrived for a row for as long as a figure is current
  // (about two minutes; one failed read changes nothing), so what it shows is an old reading's or an old answer's: its
  // figures say their time ("as of HH:MM UTC"), never "USD unavailable". Changed on purpose 2026-10-14 (review): each
  // row by when this page took its own amounts and prices (./hooks.ts useUsdAged). It was one flag for the whole list,
  // of the portfolio answer alone, and counted from the mount of this list.
  const late = useUsdAged(shown.map((row) => row.usdSeenAt))
  const ids = shown.filter(hasPositionApr).map((row) => row.tokenId).join(',')
  // One batched subscription for visible NFTs. No scan is launched from a row component.
  const aprs = useCollectionAprs(ids, tab === 'open')
  const note = ownNote(latest ?? own.reply)
  const partial = own.reply?.kind === 'ok' && own.reply.body.truncated.positions
  const settled = historical.phase === 'ready' && own.reply?.kind === 'ok'
  const empty = settled && rows.length === 0 && !note && !partial
  const failed = historical.phase === 'failed'
  useLayoutEffect(() => {
    onEmptyAction?.(empty && !readOnly)
    return () => onEmptyAction?.(false)
  }, [empty, readOnly, onEmptyAction])
  const more = matches.length - shown.length
  const held = historical.phase === 'ready' ? historical.answer.deposits : []
  return <>
    <section className="dm-card dm-acct-nft-card dm-own-card dm-own-collection" aria-labelledby="own-title" data-owned={own.reply?.kind === 'ok' || retained ? 'ready' : failed ? 'unlisted' : 'loading'} data-owned-viewed={readOnly ? owner : undefined}>
      <div className="dm-own-head">
        <h2 id="own-title" className="dm-title">{readOnly ? <>Positions of <span title={owner}>{shortAddress(owner)}</span></> : 'Your positions'}</h2>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {!readOnly && <BulkClosePositions key={owner} owner={owner} rows={rows} />}
          <Tabs label="Positions by state" value={tab} onChange={setChosen} items={[{ key: 'open', label: 'Open', count: counts.open }, { key: 'closed', label: 'Closed', count: counts.closed }]} />
        </div>
      </div>
      {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): the count no longer adds "N positions still
          being checked" (their number is data-owned-pending), and no line says "Some positions are still being checked.
          Available positions are shown below." The rows read go on being shown, and the others join them as they are read. */}
      <p role="status" aria-live="polite" className="sr-only" data-owned-status="" data-owned-pending={counts.pending || undefined}>{counts.open} open and {counts.closed} closed positions.</p>
      {note && <Note note={note} inGrid={false} />}
      {shown.length ? <div className="dm-own-list" role="tabpanel" aria-labelledby="own-title" data-owned-rows={tab}>
        <div className="dm-collection-head" data-collection-tab={tab} aria-hidden="true"><span>Pool</span>{tab === 'closed' ? <span>Position history</span> : <><span>Value</span><span>Fees to collect</span><span>Your APR</span></>}</div>
        {shown.map((row, index) => <V2PositionRow key={row.key} row={row} late={late[index]} apr={hasPositionApr(row) ? aprs.get(row.tokenId) ?? null : null} />)}
      </div> : empty ? <EmptyState title={readOnly ? 'No positions at this address' : 'No positions yet'} action={!readOnly ? <LinkButton href={newPositionHref()}>New position</LinkButton> : undefined} className="dm-own-none" data-empty="owned-none" />
        : rows.length ? <EmptyState title={tab === 'open' ? 'No open positions' : 'No closed positions'} data-empty={`owned-${tab}`} />
          // Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): a list not read yet keeps its loading rows,
          // also while its read is asked again after a failure; it said "Your positions couldn’t be read right now. We’ll keep
          // checking." (the section's data-owned says "unlisted").
          : <PendingRows loading />}
      {more > 0 && <div className="dm-own-more"><Button variant="ghost" size="sm" onClick={() => setPages((before) => ({ ...before, [tab]: before[tab] + 1 }))}>Show {Math.min(more, PAGE_SIZE)} more</Button></div>}
    </section>
    {deposits && held.length > 0 && deposits({ owner, deposits: held, onBusy: setBusy, onChanged: (block) => { walletChanged(block); setVersion((value) => value + 1) } })}
  </>
}

/*
 * Your positions with the person's own positions from read-v6 in it (Domino V2 integration, 2026-10-02; spec F7 rev4
 * §6.2, §6.3; the brief's data rule), on the chains whose gate is `live` only. Opened from
 * components/positions/OwnedPositions.tsx, lazily and only behind `__DOMINO_V2__`, at three points, each drawing V1's own
 * element until it has something of its own, so V1's list is exactly V1's while the route is not on yet (before the
 * deploy; a route simply off says nothing: ./read.ts routeQuiet) and everywhere V2 is off:
 *
 *   - OwnedRows, appended INSIDE V1's list grid (V1's rows stay V1's elements and are never mounted again): the person's
 *     live rows of the tab, each with its chain and DEX, and one full-width line when a read failed or a chain is out;
 *   - OwnedBody, for V1's other states (its loading rows, its empty states): V1's own until the person has live rows, which
 *     then are the list ("No positions yet" would be wrong);
 *   - OwnedTabs: V1's own tabs until the person has live rows, which then are counted in.
 * A Robinhood Chain v4 NFT V1 already lists is shown once, as V1's row. Nothing is drawn as zeros for a read that failed.
 */

/**
 * The person's own rows from the site's read-v6 route on the `live` chains, and the reply they come from. `valuations`
 * (2026-10-14, package V1): where each row's dollars are asked; null for the collection, which values the joined rows.
 */
function useOwnRows(owner: string, v1Ids: readonly string[], valuations: PositionValuations | null = POSITION_VALUATIONS, observation: (identity: PositionIdentity) => PositionObservation | null = positionObservation) {
  const gate = useListsGate()
  const live = anyIn(gate, 'live')
  const reply = useKeyed(OWN_PORTFOLIO, live ? owner : null)
  const created = useCreatedPositions(live ? owner : null)
  const automation = useSyncExternalStore(subscribeAutomation, automationState, automationState)
  const ids = v1Ids.join(',')
  const rows = useMemo(() => withCreatedPositions(reply?.kind === 'ok' ? positionRows(reply.body, chainsIn(gate, 'live'), ids === '' ? [] : ids.split(','), automation, valuations) : [], created.filter(item => chainsIn(gate, 'live')(item.chainId)), observation), [reply, gate, ids, automation, created, valuations, observation])
  return { live, reply, rows }
}

/** Why the person's live positions are not all listed: a read that failed, or §6.3's partial sentence; null otherwise. */
function ownNote(reply: ReturnType<typeof useOwnRows>['reply']): { kind: 'failed' | 'partial'; text: string; code: string | null } | null {
  if (reply === null || routeQuiet(reply)) return null
  if (reply.kind !== 'ok') return { kind: 'failed', text: 'Some of your positions can’t be read right now.', code: reply.kind === 'unavailable' ? reply.reason : reply.detail }
  const partial = partialSentence(reply.body.chains)
  return partial ? { kind: 'partial', text: partial, code: null } : null
}

/**
 * Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): why some positions are not listed is a hidden
 * marker's data only. It was a line ("Some of your positions can’t be read right now.", or "Showing Robinhood Chain and
 * Base. Arbitrum One is unavailable right now."); `inGrid` is kept for its callers.
 */
function Note({ note }: { note: NonNullable<ReturnType<typeof ownNote>>; inGrid: boolean }) {
  return <span hidden data-v2-own-note={note.kind} data-v2-partial={note.kind === 'partial' ? '' : undefined} data-error-code={note.code ?? undefined} />
}

export interface OwnedRowsProps {
  /** The address the list is for (the connected wallet, or another address viewed), lowercase. */
  owner: string
  tab: 'open' | 'closed'
  /** The NFT ids V1's list shows (both tabs): the same NFT listed by read-v6 is shown once, as V1's. */
  v1Ids: readonly string[]
}

/** Inside V1's list grid, after its rows: the person's live rows of this tab, and the line about what is not listed. */
export function OwnedRows({ owner, tab, v1Ids }: OwnedRowsProps) {
  const own = useOwnRows(owner, v1Ids)
  if (!own.live) return null
  const note = ownNote(own.reply)
  return (
    <>
      {own.rows
        .filter((row) => row.tab === tab)
        .map((row: PositionRowView) => (
          <V2PositionRow key={row.key} row={row} />
        ))}
      {note && <Note note={note} inGrid />}
    </>
  )
}

/** What V1's list is showing when it shows no grid: its loading rows, a read it could not make, or an empty state. */
export type V1State = 'loading' | 'unread' | 'none' | 'tab-none'

export interface OwnedBodyProps extends OwnedRowsProps {
  /** V1's own body for this state. */
  v1: ReactNode
  v1State: V1State
}

/** V1's body when it has no grid: its own, until the person has live rows, which then are the list (or say the other tab has them). */
export function OwnedBody({ owner, tab, v1, v1State, v1Ids }: OwnedBodyProps) {
  const own = useOwnRows(owner, v1Ids)
  const note = own.live ? ownNote(own.reply) : null
  const mine = own.rows.filter((row) => row.tab === tab)
  let body: ReactNode = v1
  if (mine.length > 0) {
    const grid = (
      <div className="dm-own-list" role="tabpanel" aria-labelledby="own-title" data-owned-rows={tab} data-v2-grid="">
        <RowsHead closed={tab === 'closed'} />
        {mine.map((row) => (
          <V2PositionRow key={row.key} row={row} />
        ))}
      </div>
    )
    // V1's own loading rows stay while its list is read; any other state of V1's says nothing is here, and these are.
    body = v1State === 'loading' ? (
      <>
        {v1}
        {grid}
      </>
    ) : (
      grid
    )
  } else if (v1State === 'none' && own.rows.length > 0) {
    // "No positions yet" would be wrong: the person's live positions are in the other tab.
    body = <EmptyState title={tab === 'open' ? 'No open positions' : 'No closed positions'} data-empty={`owned-${tab}`} />
  }
  return (
    <>
      {note && <Note note={note} inGrid={false} />}
      {body}
    </>
  )
}

export interface OwnedTabsProps extends OwnedRowsProps {
  /** V1's own tabs (or its skeleton, or nothing) for this state. */
  v1: ReactNode
  /** Whether the person chose the tab (V1's own default otherwise). */
  chosen: boolean
  onTab: (tab: 'open' | 'closed') => void
  /** V1's own counts, or null while its list is read (or could not be). */
  v1Counts: { open: number; closed: number } | null
  unread: boolean
}

/**
 * V1's own tabs, until the person has live rows: then those are counted in (never anything else). V1 opens on Open unless
 * nothing is open and something is closed; with live rows, the same rule over all of the person's positions, once V1's
 * list is read and while the person has not chosen a tab.
 */
export function OwnedTabs({ owner, tab, v1, chosen, onTab, v1Counts, unread, v1Ids }: OwnedTabsProps) {
  const own = useOwnRows(owner, v1Ids)
  const open = (v1Counts?.open ?? 0) + own.rows.filter((row) => row.tab === 'open').length
  const closed = (v1Counts?.closed ?? 0) + own.rows.filter((row) => row.tab === 'closed').length
  const settled = v1Counts !== null || unread
  const wanted = open === 0 && closed > 0 ? 'closed' : 'open'
  const switchTo = !chosen && settled && own.rows.length > 0 && wanted !== tab ? wanted : null
  useEffect(() => {
    if (switchTo) onTab(switchTo)
  }, [switchTo, onTab])
  if (own.rows.length === 0) return <>{v1}</>
  return (
    <Tabs
      label="Positions by state"
      value={tab}
      onChange={onTab}
      items={[
        { key: 'open', label: 'Open', count: open },
        { key: 'closed', label: 'Closed', count: closed },
      ]}
    />
  )
}
