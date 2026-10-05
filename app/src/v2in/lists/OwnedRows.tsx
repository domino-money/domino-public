import { useEffect, useMemo, type ReactNode } from 'react'
import { RowsHead } from '../../components/positions/PositionRow'
import { EmptyState, Tabs } from '../../components/ui'
import { positionRows, partialSentence, type PositionRowView } from './model'
import { V2PositionRow } from './parts'
import { anyIn, chainsIn, useKeyed, useListsGate } from './hooks'
import { routeQuiet } from './read'
import { OWN_PORTFOLIO } from './source'

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

/** The person's own rows from the site's read-v6 route on the `live` chains, and the reply they come from. */
function useOwnRows(owner: string, v1Ids: readonly string[]) {
  const gate = useListsGate()
  const live = anyIn(gate, 'live')
  const reply = useKeyed(OWN_PORTFOLIO, live ? owner : null)
  const ids = v1Ids.join(',')
  const rows = useMemo(() => (reply?.kind === 'ok' ? positionRows(reply.body, chainsIn(gate, 'live'), ids === '' ? [] : ids.split(',')) : []), [reply, gate, ids])
  return { live, reply, rows }
}

/** Why the person's live positions are not all listed: a read that failed, or §6.3's partial sentence; null otherwise. */
function ownNote(reply: ReturnType<typeof useOwnRows>['reply']): { kind: 'failed' | 'partial'; text: string; code: string | null } | null {
  if (reply === null || routeQuiet(reply)) return null
  if (reply.kind !== 'ok') return { kind: 'failed', text: 'Some of your positions can’t be read right now.', code: reply.kind === 'unavailable' ? reply.reason : reply.detail }
  const partial = partialSentence(reply.body.chains)
  return partial ? { kind: 'partial', text: partial, code: null } : null
}

function Note({ note, inGrid }: { note: NonNullable<ReturnType<typeof ownNote>>; inGrid: boolean }) {
  return (
    <p className={inGrid ? 'dm-own-note col-span-full' : 'dm-own-note'} data-v2-own-note={note.kind} data-v2-partial={note.kind === 'partial' ? '' : undefined} data-error-code={note.code ?? undefined}>
      {note.text}
    </p>
  )
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
