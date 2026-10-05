import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ActivityResponse } from 'api-contracts/read-v6/types'
import { Button, LinkButton } from '../../components/ui'
import { sameShows, type CardShows } from '../../lib/automationCards'
import { useWalletIdentity } from '../../lib/walletIdentity'
import Execution from '../../screens/Execution'
import { receiptViews, type ReceiptView } from './model'
import { routeQuiet } from './read'
import { ChainLines, RECEIPT_LIST, ReceiptRow } from './receiptParts'
import { anyIn, chainsIn, useKeyed, useListsGate } from './hooks'
import { ACTIVITY_PAGE, LISTS_SOURCE, OWN_ACTIVITY, OWN_PORTFOLIO } from './source'

/*
 * Receipts with the connected wallet's own read-v6 receipts in it (Domino V2 integration, 2026-10-02; spec F7 rev4 §6.2,
 * §2.11, §2.13; the brief's data rule), on the chains whose gate is `live` only. In a build that carries V2,
 * screens/Positions.tsx opens this in Execution's place, behind `__DOMINO_V2__` only: V1's own receipts
 * (screens/Execution.tsx) first, exactly as they are, then the person's own receipts in V1's row style (./receiptParts.tsx):
 * public chain data, so no sign-in is needed. A reserves return the automation sent is "Returned to your wallet", never the
 * person's withdrawal. On the preview (no chain live) and wherever V2 is off, this is exactly Execution: what it tells
 * Positions is Execution's own word, and nothing else is drawn (no example receipts exist: real data only, the owner,
 * 2026-10-02).
 */

type Item = ActivityResponse['items'][number]

/** Rows the full receipts page shows at first, and adds on each Show more (V1's own page size). */
const PAGE_ROWS = 10

/** The card's two words of its own for Positions, each one value (lib/automationCards.ts sameShows compares by kind). */
const CONTENT: CardShows = Object.freeze({ kind: 'content' })
const OTHER: CardShows = Object.freeze({ kind: 'other' })

/** The person's own receipts on the live chains: the first page (asked again by itself), then older pages on Show more. */
function useOwnActivity(wallet: string | null) {
  const first = useKeyed(OWN_ACTIVITY, wallet)
  const [older, setOlder] = useState<{ wallet: string; items: Item[]; cursor: string | null; loading: boolean } | null>(null)
  const mine = older !== null && older.wallet === wallet ? older : null
  const items = useMemo(() => {
    const head = first?.kind === 'ok' ? first.body.items : []
    const seen = new Set(head.map((item) => item.id))
    return [...head, ...(mine?.items ?? []).filter((item) => !seen.has(item.id))]
  }, [first, mine])
  const cursor = mine ? mine.cursor : first?.kind === 'ok' ? first.body.nextCursor : null
  const loading = mine?.loading ?? false
  const more =
    wallet !== null && cursor !== null && !loading
      ? () => {
          setOlder({ wallet, items: mine?.items ?? [], cursor, loading: true })
          void LISTS_SOURCE.ownActivity(wallet, { limit: ACTIVITY_PAGE, cursor }).then((reply) =>
            setOlder((before) => {
              const kept = before && before.wallet === wallet ? before.items : []
              // A page that could not be read ends Show more for now; the first page is still asked again by itself.
              return reply.kind === 'ok' ? { wallet, items: [...kept, ...reply.body.items], cursor: reply.body.nextCursor, loading: false } : { wallet, items: kept, cursor: null, loading: false }
            }),
          )
        }
      : null
  return { first, items, more, loading }
}

/** A list of receipts with its own Show more: the card shows `limit` rows; the full page ten, and ten more each time. */
function ReceiptList({ views, limit, more, loading }: { views: readonly ReceiptView[]; limit: number | undefined; more: (() => void) | null; loading: boolean }) {
  const [shown, setShown] = useState(PAGE_ROWS)
  const rows = views.slice(0, limit ?? shown)
  const hidden = views.length > rows.length
  if (rows.length === 0) return null
  return (
    <>
      <ol className={RECEIPT_LIST} data-v2-receipts="own" data-v2-receipts-rows={rows.length}>
        {rows.map((view) => (
          <ReceiptRow key={view.id} view={view} />
        ))}
      </ol>
      {limit === undefined && (hidden || more) && (
        <Button
          className="justify-self-center"
          variant="ghost"
          size="sm"
          disabled={loading && !hidden}
          onClick={() => {
            setShown(shown + PAGE_ROWS)
            if (views.length <= shown + PAGE_ROWS) more?.()
          }}
        >
          {loading && !hidden ? 'Loading more…' : 'Show more'}
        </Button>
      )}
    </>
  )
}

/** Execution's place in a V2 build: V1's receipts, then the person's own live receipts. Props as Execution's own. */
export default function Receipts({ limit, onShows }: { limit?: number; onShows?: (shows: CardShows | null) => void }) {
  const [v1, setV1] = useState<CardShows | null>(null)
  const tellV1 = useCallback((next: CardShows | null) => setV1((old) => (sameShows(old, next) ? old : next)), [])
  const identity = useWalletIdentity()
  const wallet = identity.kind === 'connected' ? identity.address.toLowerCase() : null
  const gate = useListsGate()
  const live = anyIn(gate, 'live') && wallet !== null

  const own = useOwnActivity(live ? wallet : null)
  const ownPortfolio = useKeyed(OWN_PORTFOLIO, live ? wallet : null)
  const ownViews = useMemo(
    () => (own.first?.kind === 'ok' ? receiptViews({ ...own.first.body, items: own.items }, chainsIn(gate, 'live'), ownPortfolio?.kind === 'ok' ? ownPortfolio.body : null) : []),
    [own.first, own.items, gate, ownPortfolio],
  )

  // What the card shows, for Positions (lib/automationCards.ts): Execution's own word wherever nothing is live; the
  // person's live receipts are content; those that could not be read, a line of their own; while they are read, not known
  // yet unless Execution already has content.
  // A route simply not on yet (before the deploy) is nothing to say: Execution's own word stands (./read.ts routeQuiet).
  // One value per answer (memoized on what it is made of), so Positions hears of a change only when there is one.
  const quiet = routeQuiet(own.first)
  const first = own.first
  const ownCount = ownViews.length
  const shows = useMemo<CardShows | null>(() => {
    if (!live || quiet) return v1
    if (v1?.kind === 'content' || ownCount > 0) return CONTENT
    if (first === null) return null
    return first.kind !== 'ok' ? OTHER : v1
  }, [live, quiet, v1, ownCount, first])
  useEffect(() => onShows?.(shows), [onShows, shows])
  // The card's own See all is V1's, hidden while signed out (styles/positions.css); the live receipts need no sign-in.
  const seeAll = limit !== undefined && v1?.kind === 'none' && v1.reason !== 'empty' && ownViews.length > limit

  return (
    <>
      <Execution limit={limit} onShows={tellV1} publicReceipts={ownViews.length > 0} />
      {live && own.first !== null && !quiet && (
        <section className="grid min-w-0 gap-3" aria-label="Your receipts" data-v2-own-receipts={own.first.kind}>
          {own.first.kind === 'ok' ? (
            <>
              <ChainLines answer={own.first.body} />
              <ReceiptList views={ownViews} limit={limit} more={own.more} loading={own.loading} />
            </>
          ) : (
            <p className="dm-rcpt-note" data-error-code={own.first.kind === 'unavailable' ? own.first.reason : own.first.detail}>
              Some of your receipts can’t be read right now.
            </p>
          )}
        </section>
      )}
      {seeAll && (
        <LinkButton href="#/positions/receipts" variant="ghost" size="sm" className="justify-self-start" data-v2-receipts-all="">
          See all receipts
        </LinkButton>
      )}
    </>
  )
}
