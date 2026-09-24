import { useEffect, useMemo, useReducer, useState, type ReactNode } from 'react'
import {
  PAGE_SIZE,
  createRowReader,
  depositCurrencies,
  heldDepositViews,
  mergeOwned,
  ownedTabs,
  passingOwnedFailure,
  readOwnedPositions,
  rowResults,
  type HeldDepositView,
  type OwnedList,
  type OwnedStatus,
  type RowResult,
  type Rows,
} from '../../lib/ownedPositions'
import { tokenDisplay } from '../../lib/read/project'
import { CHAIN_ID } from '../../lib/read/screens/identity'
import { runLookup, type LookupResult } from '../../lib/read/screens/positions'
import { reaskDelayMs, whenVisibleAfter } from '../../lib/read/screens/quietRead'
import { useReadSource } from '../../lib/read/screens/readContext'
import { readWithin } from '../../lib/read/screens/screenRead'
import type { TokenDisplay } from '../../lib/read/types'
import type { WalletIdentityView } from '../../lib/walletIdentity'
import { newPositionHref } from '../explore/routes'
import { IconSearch, IconWallet } from '../icons'
import { Button, Display, EmptyState, LinkButton, Skeleton, Tabs } from '../ui'
import { PendingRow, PositionRow, UnreadRow } from './PositionRow'

/** What Positions hands the held deposits: drawn by the lazily loaded HeldDeposits in wallet builds. */
export type DepositsSlot = (props: { owner: string; deposits: readonly HeldDepositView[]; onChanged: () => void }) => ReactNode

/** Opens the header's wallet dialog, where a wallet is connected or switched to Robinhood Chain. */
const openWallet = () => document.querySelector<HTMLButtonElement>('header [aria-haspopup="dialog"]')?.click()

/** Why the list could not be read, for a title: the endpoint's code is in the data attribute beside it. */
const UNLISTED = 'Your positions could not be listed just now. Look one up by its NFT id below.'
const INCOMPLETE = 'Some of the NFTs this wallet holds could not be listed. Look one up by its NFT id below.'

/** The card's frame: its title, and the tabs once there is something to put in them. */
function Frame({ children, tabs, data, title }: { children: ReactNode; tabs?: ReactNode; data?: Record<string, string | undefined>; title?: string }) {
  return (
    <section className="dm-card dm-acct-nft-card dm-own-card" aria-labelledby="own-title" title={title} {...data}>
      <div className="dm-own-head">
        <Display as="h2" id="own-title" className="dm-display-card">
          Your positions
        </Display>
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
   * The ids this browser created for a wallet (lib/positionMemory.ts createdPositions), handed in by the page so that
   * module stays where Create position and the page already load it.
   */
  remembered: (owner: string) => string[]
  /** Opens the lookup by NFT id under the table: the list could not be read in full. */
  onUnlisted: (open: true) => void
}

/**
 * Your positions, for the wallet the header is connected to: every position
 * NFT it holds, found for it (open and closed, in two tabs), and below the
 * table the deposits it has not turned into a position yet. Without a wallet,
 * or on another network, one empty state says what to do. Nothing is read
 * until a wallet is connected on Robinhood Chain.
 */
export default function OwnedPositions({ identity, deposits, remembered, onUnlisted }: OwnedPositionsProps) {
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
  return <YourPositions key={owner} owner={owner} deposits={deposits} remembered={remembered} onUnlisted={onUnlisted} />
}

type Owned = { phase: 'loading' } | { phase: 'ready'; list: OwnedList } | { phase: 'failed'; reason: string }

const rowsReducer = (state: Rows, event: { owner: string; ids: string[]; result: Exclude<LookupResult, { kind: 'aborted' }>; again: string[] }): Rows => ({
  ...state,
  ...rowResults(event.owner, event.ids, event.result, state, event.again),
})

/** One row by what its read said: the figures, a dash row, or its skeleton while it is read (an empty NFT asked once more included). */
function Row({ id, row }: { id: string; row: RowResult | undefined }) {
  if (row?.kind === 'card') return <PositionRow card={row.card} batch={row.batch} />
  if (row?.kind === 'failed') return <UnreadRow tokenId={id} failure={row.failure} />
  return <PendingRow tokenId={id} />
}

function YourPositions({ owner, deposits, remembered: rememberedFor, onUnlisted }: Omit<OwnedPositionsProps, 'identity'> & { owner: string }) {
  const source = useReadSource()
  // The endpoint's answer, and how many times the page has asked again after an action changed it.
  const [owned, setOwned] = useState<Owned>({ phase: 'loading' })
  const [asked, setAsked] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let attempts = 0
    let cancel: (() => void) | null = null
    const ask = () => {
      void readOwnedPositions(owner, controller.signal, asked > 0).then((result) => {
        if (controller.signal.aborted) return
        if (result.ok) {
          setOwned({ phase: 'ready', list: result.list })
          if (!result.list.complete) onUnlisted(true)
          return
        }
        setOwned((before) => (before.phase === 'ready' ? before : { phase: 'failed', reason: result.reason }))
        onUnlisted(true)
        // A chain or connection that was busy for the moment is asked again, twice at most, while the page is visible.
        if (!passingOwnedFailure(result.reason) || attempts >= 2) return
        cancel = whenVisibleAfter(attempts === 0 ? 3_000 : 12_000, () => {
          cancel = null
          attempts += 1
          ask()
        })
      })
    }
    ask()
    return () => {
      controller.abort()
      cancel?.()
    }
  }, [owner, asked, onUnlisted])

  const list = owned.phase === 'ready' ? owned.list : null
  const reason = owned.phase === 'failed' ? owned.reason : null
  // Ids this browser created for the wallet: listed while the endpoint's cached answer does not name them yet, or when it could not answer.
  const remembered = useMemo(() => rememberedFor(owner), [rememberedFor, owner])
  const ids = useMemo(() => (owned.phase === 'loading' ? null : mergeOwned(list, remembered)), [owned.phase, list, remembered])

  // The rows' figures: nft-positions reads, ten ids at a time, one after another, each id once.
  const [rows, dispatchRows] = useReducer(rowsReducer, {})
  const reader = useMemo(
    () =>
      source
        ? createRowReader(
            (batch, signal) => runLookup(source, batch, { signal }),
            (batch, result, again) => dispatchRows({ owner, ids: batch, result, again }),
            { retryIn: (failure, attempt) => reaskDelayMs(failure, attempt), later: whenVisibleAfter },
          )
        : null,
    [source, owner],
  )
  // Leaving cancels the reads; a cancelled reader starts over on its next want(), so StrictMode's setup, cleanup, setup still reads the rows.
  useEffect(() => () => reader?.cancel(), [reader])

  const tabs = useMemo(() => (ids ? ownedTabs(ids, rows) : null), [ids, rows])
  const [chosen, setChosen] = useState<OwnedStatus | null>(null)
  // Open unless there is nothing open and something closed.
  const tab: OwnedStatus = chosen ?? (tabs && tabs.open.length === 0 && tabs.closed.length > 0 ? 'closed' : 'open')
  const [closedSeen, setClosedSeen] = useState(false)
  const [pages, setPages] = useState<Record<OwnedStatus, number>>({ open: 1, closed: 1 })
  // Open positions are read first; closed ones only once their tab has been open.
  const wanted = useMemo(
    () => (tabs ? [...tabs.open.slice(0, pages.open * PAGE_SIZE), ...(closedSeen || tab === 'closed' ? tabs.closed.slice(0, pages.closed * PAGE_SIZE) : [])] : []),
    [tabs, pages, closedSeen, tab],
  )
  useEffect(() => {
    if (reader && wanted.length > 0) reader.want(wanted)
  }, [reader, wanted])

  // The held deposits' tokens, read for their symbols and decimals, only when there are deposits to draw.
  const held = useMemo(() => list?.deposits ?? [], [list])
  const [heldTokens, setHeldTokens] = useState<ReadonlyMap<string, TokenDisplay> | null>(null)
  useEffect(() => {
    if (!source || !deposits || held.length === 0) return
    const controller = new AbortController()
    void (async () => {
      const tokens = new Map<string, TokenDisplay>()
      for (const address of depositCurrencies(held)) {
        const read = await readWithin(source, 'token', { token: address }, { signal: controller.signal })
        if (read.state === 'aborted') return
        if (read.state === 'ok') tokens.set(address, tokenDisplay(read.data.asset))
      }
      if (!controller.signal.aborted) setHeldTokens(tokens)
    })()
    return () => controller.abort()
  }, [source, deposits, held])

  const choose = (next: OwnedStatus) => {
    setChosen(next)
    if (next === 'closed') setClosedSeen(true)
  }
  const shownIds = tabs ? tabs[tab].slice(0, pages[tab] * PAGE_SIZE) : []
  const more = tabs ? tabs[tab].length - shownIds.length : 0
  const total = tabs ? tabs.open.length + tabs.closed.length : 0
  const phase = owned.phase === 'loading' ? 'loading' : reason ? 'unlisted' : 'ready'
  const status = !tabs ? 'Listing your positions…' : `${tabs.open.length} open and ${tabs.closed.length} closed positions.`

  let body: ReactNode
  if (!tabs) {
    body = (
      <div className="dm-rows dm-acct-nft-rows" aria-hidden="true" data-owned-loading="">
        <PendingRow tokenId="" />
        <PendingRow tokenId="" />
      </div>
    )
  } else if (total === 0) {
    body = reason ? (
      <EmptyState icon={<IconSearch />} title="No positions to show" data-empty="owned-unlisted" />
    ) : (
      <EmptyState
        icon={<IconSearch />}
        title="No positions yet"
        action={
          <LinkButton href={newPositionHref()} size="sm">
            New position
          </LinkButton>
        }
        data-empty="owned-none"
      />
    )
  } else if (shownIds.length === 0) {
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
        {shownIds.map((id) => (
          <Row key={id} id={id} row={rows[id]} />
        ))}
      </div>
    )
  }

  return (
    <>
      <Frame
        title={reason ? UNLISTED : list && !list.complete ? INCOMPLETE : undefined}
        data={{
          'data-owned': phase,
          'data-owned-reason': reason ?? undefined,
          'data-owned-block': list ? String(list.block) : undefined,
          'data-owned-complete': list ? String(list.complete) : undefined,
        }}
        tabs={
          tabs && total > 0 ? (
            <Tabs
              label="Positions by state"
              value={tab}
              onChange={choose}
              items={[
                { key: 'open', label: 'Open', count: tabs.open.length },
                { key: 'closed', label: 'Closed', count: tabs.closed.length },
              ]}
            />
          ) : !tabs ? (
            <Skeleton className="h-8 w-40" />
          ) : undefined
        }
      >
        <p role="status" aria-live="polite" className="sr-only" data-owned-status="">
          {status}
        </p>
        {body}
        {more > 0 && (
          <div className="dm-own-more">
            <Button type="button" variant="ghost" size="sm" onClick={() => setPages((before) => ({ ...before, [tab]: before[tab] + 1 }))}>
              Show {Math.min(more, PAGE_SIZE)} more
            </Button>
          </div>
        )}
      </Frame>
      {deposits && held.length > 0 && heldTokens && deposits({ owner, deposits: heldDepositViews(held, heldTokens), onChanged: () => setAsked((n) => n + 1) })}
    </>
  )
}
