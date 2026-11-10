import { useEffect, useRef, useState } from 'react'
import { ROBINHOOD_NAME } from '../../config/chainIdentity'
import { catalogueTokens, type PoolCatalogueEntry } from '../../config/selectedPoolCatalogue'
import { CREATE } from '../../lib/create/copy'
import { networkCandidate, type NetworkToken, type OtherChains } from '../../lib/create/otherChains'
import { dropCreatePools, startCreatePools, warmPoolHints } from '../../lib/create/poolsAhead'
import { stilled } from '../../lib/motion/stilled'
import { rootScale } from '../../lib/rootScale'
import type { JourneyState } from '../../lib/create/journey'
import { priceInverted } from '../../lib/read/orientation'
import { shortAddress, type AddressKey } from '../../lib/read/screens/identity'
import type { PoolOption } from '../../lib/read/screens/poolsList'
import type { StatusLine } from '../../lib/read/screens/statusLine'
import { knownTokens } from '../../lib/read/screens/tokenSearch'
import { mergeCandidates, type TokenCandidate } from '../../lib/read/screens/tokens'
import type { ReadSource } from '../../lib/read/types'
import { SEARCH_LABEL, TokenSearch, type NetworkChoice } from '../read/screens/TokenSearch'
import { FEE_MEANING } from '../explore/feeMeaning'
import { newPositionHref } from '../explore/routes'
import { CatalogueLabel } from '../PoolCatalogueIdentity'
import { TokenIcon, TokenMark } from '../TokenIcon'
import { Button, Skeleton } from '../ui'
import { feeWords } from '../../lib/format/fee'
import { unreadToken } from '../../lib/read/project'
import { rem } from '../../lib/rootScale'
import { ChosenPool, PoolList } from './StagePool'

/** What the pool id in the link came to, while the person picks a token. */
export type PreselectStatus =
  | { kind: 'none' }
  | { kind: 'malformed' }
  /** `again` while a failed verification is read again on its own: the step stays usable meanwhile. */
  | { kind: 'checking'; again: boolean }
  | { kind: 'verified'; block: number }
  | { kind: 'not_found' }
  /** The linked pool is verified, but Domino cannot open a position in it (hooks, or a dynamic fee): nothing is preselected. */
  | { kind: 'unsupported'; reason: 'hooks' | 'dynamic' }
  | { kind: 'failed'; line: StatusLine }
  /** The featured list withdrew the linked pool by a safety rule (featured pools v1 §11.5): refused, never verified or preselected. */
  | { kind: 'withdrawn' }

/** What a screen reader hears about the link; nothing of it is a panel on screen but the withdrawn pool's line. */
function preselectWords(status: PreselectStatus): string {
  switch (status.kind) {
    case 'none':
      return ''
    case 'malformed':
      return `${CREATE.token.preselectHeading}: ${CREATE.token.preselectMalformed}`
    case 'checking':
      return `${CREATE.token.preselectHeading}: ${CREATE.token.preselectChecking}`
    case 'verified':
      return CREATE.token.preselectVerified
    case 'not_found':
      return `${CREATE.token.preselectHeading}: ${CREATE.token.preselectNotFound}`
    case 'unsupported':
      return `${CREATE.token.preselectHeading}: ${status.reason === 'dynamic' ? CREATE.pool.unsupportedDynamic : CREATE.pool.unsupportedHooks}`
    // Changed on purpose 2026-10-30 (QA round 2, N42 and the sweep): a read that asking again may fix is asked again quietly,
    // so it is said as the check it still is; nothing says the pool's data is unavailable.
    case 'failed':
      return `${CREATE.token.preselectHeading}: ${status.line.retry ? CREATE.token.preselectChecking : CREATE.token.preselectNotFound}`
    case 'withdrawn':
      return `${CREATE.token.preselectHeading}: ${CREATE.token.preselectWithdrawn}`
    default:
      return status satisfies never
  }
}

/** How the search names a token it did not find itself: the read symbol, cut as the search cuts it, else the short address. */
const searchName = (candidate: TokenCandidate) => {
  const symbol = candidate.token.symbol
  if (symbol === null) return shortAddress(candidate.key)
  return symbol.length > 24 ? `${symbol.slice(0, 24)}…` : symbol
}

/** How many of the list's pools step 1 offers under the search: as many as Home's Top pools leads with (the owner, N19). */
const TOP_POOLS = 4

/**
 * A list entry turned the way its price is written (lib/read/orientation.ts, "PONS / USDG"), labels and marks together;
 * an entry without addresses keeps the order its labels were written in. Display only.
 */
function oriented(entry: PoolCatalogueEntry): PoolCatalogueEntry {
  const addresses = entry.addresses
  if (!addresses || !priceInverted(addresses[0], addresses[1])) return entry
  return { ...entry, labels: [entry.labels[1], entry.labels[0]], artwork: [entry.artwork[1], entry.artwork[0]], addresses: [addresses[1], addresses[0]] }
}

/**
 * Added 2026-10-30 (QA round 2, N19, the owner's yes, no badge): while nothing is chosen, the list's first pools under the
 * search, as Home's Top pools names them, each a link that opens New position on that pool exactly as a pool page's link
 * does (it is verified there before it is chosen). Nothing is read for it: the list is the one the page already holds
 * (lib/read/featuredSource.ts, handed in by the journey), and it is drawn only once that list has settled, so it never
 * swaps under the person. No order but the list's own and no row marked above another. Robinhood Chain's for now. Since
 * 2026-11-07 (launch sweep F3) a mark without bundled artwork reads its own, as Home's rows' marks do (TopPoolLink).
 */
/** One of them, drawn as New position's plain pool row draws a pool (read/screens/PoolPicker.tsx PoolRow): the marks, the pair, its fee chip and network. */
function TopPoolLink({ entry, network }: { entry: PoolCatalogueEntry; network: string | null }) {
  const size = 32
  // QA round 2, Q28: what the fee is, as every fee chip says it on hover.
  const fee = <span className="dm-chip shrink-0" data-fee="" title={FEE_MEANING}>{feeWords(entry.fee)}</span>
  return (
    <a className="dm-mkt-option-head" href={newPositionHref(entry.poolId)}>
      <span className="inline-flex shrink-0 items-center" aria-hidden="true">
        {entry.artwork.map((artwork, index) => {
          const style = { marginLeft: index ? rem(-size * 0.3) : 0 }
          const token = !artwork && entry.addresses ? unreadToken(entry.addresses[index]) : null
          // Changed on purpose 2026-11-07 (launch sweep F3): a token without bundled artwork gets its mark as Home's and
          // Markets' rows draw it (TokenMark): the artwork this page already holds on the first frame, else the plain disc,
          // which asks for its artwork once it is on screen (our edge's token-pairs read, two at a time) and is drawn again
          // when it arrives. It used to ask nothing here (QA round 2 review, N19), so New position opened by its own link
          // showed plain discs for PONS, TORCH and CASHCAT until Home or Markets had read them.
          return artwork ? (
            <TokenIcon key={index} symbol={artwork} size={size} ring="var(--card)" style={style} />
          ) : token ? (
            <TokenMark key={index} token={token} size={size} ring="var(--card)" style={style} />
          ) : (
            <span key={index} className="inline-block rounded-full bg-surface-3" style={{ width: rem(size), height: rem(size), boxShadow: '0 0 0 2px var(--card)', ...style }} />
          )
        })}
      </span>
      <span className="dm-flow-pool-id">
        <span className="dm-flow-pool-pair">
          <CatalogueLabel text={entry.labels[0]} /> / <CatalogueLabel text={entry.labels[1]} />
        </span>
        {network !== null && (
          <span className="dm-flow-pool-chips">
            <span className="dm-chip dm-flow-pool-net">{network}</span>
            {fee}
          </span>
        )}
      </span>
      {network === null && fee}
    </a>
  )
}

function TopPools({ entries, network, server }: { entries: readonly PoolCatalogueEntry[]; network: string | null; server: boolean }) {
  if (entries.length === 0) return null
  return (
    <section className="dm-flow-top" aria-labelledby="create-top-pools" data-picker-variant="create" data-top-pools="">
      <h3 id="create-top-pools" className="dm-label">
        {CREATE.token.topPools(server)}
      </h3>
      <ul className="dm-flow-pool-rows">
        {entries.map((entry) => (
          <li key={entry.poolId} className="dm-mkt-option" data-top-pool={entry.poolId}>
            <TopPoolLink entry={oriented(entry)} network={network} />
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * Step 1, Pool: the pool the position goes into.
 *
 * With a pool chosen (from the link, once verified, or from the list) the step
 * shows that pool, and Continue. Without one: one search field that takes a
 * name or a contract address, then the existing pools for the chosen token.
 * Nothing else: the field is the whole way in. Nothing is read until a person
 * asks — the search reads a token only when one is chosen, and the pool list
 * reads once it mounts for a chosen token. Changed on purpose 2026-10-30 (QA
 * round 2, N19, the owner's yes): under the field, while nothing is chosen,
 * the featured list's first pools (TopPools above), from the list the page
 * already holds, with nothing read for them but a mark's own artwork (since
 * 2026-11-07, launch sweep F3).
 *
 * Changed on purpose 2026-09-28 (speed wave, study items 27 and 30): the pool
 * list's read is asked the moment the token is chosen, beside the token read,
 * and the token-pairs list its hints come from as soon as a row is pointed at;
 * the list still mounts only once the token read has answered, and finds its
 * read on the way (lib/create/poolsAhead.ts). Change pool shows the list the
 * flow already read, for a minute, with no read.
 *
 * Changed on purpose (round 6, 2026-09-27, the owner: New position from a pool
 * page looked different from New position from Positions): a pool from a link
 * arrives exactly as a pool chosen from the list does, the chosen pool and
 * Continue. It no longer asks which of the pool's tokens is deposited, with
 * their contract addresses: the amount step takes an amount in either, and the
 * Journey starts from the token the link was verified against.
 *
 * How the link's verification went is never a panel: while it runs the step
 * holds the chosen pool's place, and whatever it came to is on the step's data
 * attributes and in its live region. A failure that asking again could fix is
 * asked again by the journey on its own; anything else leaves the search.
 */
export function StageToken({
  source,
  state,
  preselect,
  candidates,
  onCandidates,
  onToken,
  onPool,
  onPreview,
  others = null,
  top = [],
  topServer = false,
  initialPool = null,
}: {
  source: ReadSource | null
  state: JourneyState
  preselect: PreselectStatus
  candidates: TokenCandidate[]
  onCandidates: (next: TokenCandidate[]) => void
  onToken: (candidate: TokenCandidate | null) => void
  onPool: (option: PoolOption | null) => void
  /** A pool row pointed at or focused, or null once the list is left: the preview beside the steps shows it. */
  onPreview?: (option: PoolOption | null) => void
  /**
   * The other networks New position offers (2026-10-05, lib/create/otherChains.ts), from the journey's wrapper in a build
   * that carries V2; null everywhere else, where this step is exactly today's.
   */
  others?: OtherChains | null
  /** The featured list's pools, once settled (QA round 2, N19): offered under the search while nothing is chosen. */
  top?: readonly PoolCatalogueEntry[]
  /** Whether that list is the server's (named Top pools) or the bundled one (Selected pools), as Home names it. */
  topServer?: boolean
  /**
   * QA round 2, N5: the pool another network's link proposes (#/new/network/<chain>/<token>/<pool>), untrusted: that
   * network's list chooses it once, only when its own read lists exactly that pool, never over a choice already made.
   */
  initialPool?: string | null
}) {
  const [changing, setChanging] = useState(false)
  // QA round 2, N57 (2026-10-30): Change pool and Keep this pool swap the panel the focus was on for another, so the focus
  // moves with them: to the search, or back to the chosen pool's button, never to the page's start.
  // Changed on purpose 2026-10-31 (QA round 2 follow-ups, N57): a click or a tap on Change pool (`keep`) puts the focus on
  // Keep this pool, the button in its place, as a search not yet drawn does; it fell to the page's start when the button
  // clicked went away.
  const focusNext = useRef<'search' | 'chosen' | 'keep' | null>(null)
  useEffect(() => {
    const next = focusNext.current
    focusNext.current = null
    if (next === null) return
    const keep = document.querySelector<HTMLElement>('[data-keep-pool]')
    if (next === 'search') (document.getElementById('create-token-search') ?? keep)?.focus()
    else if (next === 'keep') keep?.focus()
    else document.querySelector<HTMLElement>('[data-chosen-pool] button')?.focus()
  }, [changing])
  const known = knownTokens({ catalogue: catalogueTokens(), candidates })
  // Another network's pasted address, read through the wallet once chosen; a newer choice, or leaving, stops it.
  const resolving = useRef<AbortController | null>(null)
  useEffect(() => () => resolving.current?.abort(), [])

  const fromSearch = (candidate: TokenCandidate) => {
    resolving.current?.abort()
    onCandidates(mergeCandidates(candidates, [candidate]))
    onToken(candidate)
  }
  // Another network's token (2026-10-05): chosen as it is, or once its symbol and decimals are read on its network. Never
  // merged into today's candidates, which are keyed by address alone (Base's ETH is not Robinhood Chain's).
  const fromNetwork = async (row: NetworkToken): Promise<NetworkChoice> => {
    resolving.current?.abort()
    if (!others) return { ok: false, code: 'unavailable', reason: CREATE.token.notSelectable }
    const controller = new AbortController()
    resolving.current = controller
    const resolved = row.unread ? await others.resolve(row, controller.signal) : ({ ok: true, token: row.token } as const)
    if (controller.signal.aborted) return { ok: true }
    if (!resolved.ok) return resolved
    onToken(networkCandidate(resolved.token))
    return { ok: true }
  }
  // Speed wave, 2026-09-28 (study item 27): the chosen token's pools are asked beside its token read, not after it; the
  // list below takes that read when it mounts (lib/create/poolsAhead.ts). Nothing is drawn sooner than before.
  const choosing = (key: AddressKey | null) => {
    if (!source) return
    if (key) startCreatePools(source, key, state.paired?.key ?? null)
    else dropCreatePools()
  }
  const pickPool = (option: PoolOption | null) => {
    onPool(option)
    if (!option) return
    setChanging(false)
    // Changed on purpose 2026-10-31 (QA round 2 follow-ups, R18): a row picked from the keyboard (or focused by a click) goes
    // away with the list, so the focus it leaves on nothing moves to the chosen pool's Change pool, never to the page's
    // start. A pool the list chose on its own (a link's, N5) moves no focus.
    const fromList = document.activeElement?.closest('[data-picker="pool"]') != null
    // The list folds into the one chosen pool. Picked low in a long list, the fold can leave it above the screen,
    // under the header: bring it back into view once it is drawn, as a step change does (StepList.tsx).
    requestAnimationFrame(() => {
      const panel = document.querySelector('[data-chosen-pool]')
      if (!panel) return
      const focused = document.activeElement
      // Without a scroll of its own: the lines below bring the panel into view as they always have.
      if (fromList && (!focused || focused === document.body || !focused.isConnected)) panel.querySelector<HTMLElement>('button')?.focus({ preventScroll: true })
      const header = Math.max(0, document.querySelector('header')?.getBoundingClientRect().bottom ?? 0)
      const top = panel.getBoundingClientRect().top
      const air = rootScale()
      if (top < header + 8 * air) window.scrollTo({ top: Math.max(0, window.scrollY + top - header - 24 * air), behavior: stilled() ? 'auto' : 'smooth' })
    })
  }

  const chosen = state.pool && !changing ? state.pool : null
  // While the linked pool is being verified its answer decides what this step shows, so nothing else is offered yet.
  const checking = preselect.kind === 'checking' && !preselect.again && !state.pool
  const selectedNetwork = state.token?.token.chainId
  const browsingOnly = selectedNetwork !== undefined && selectedNetwork !== 4663 && others?.creationAvailable?.(selectedNetwork) === false

  return (
    <div className="dm-flow-stack" data-stage="token" data-preselect={preselect.kind} data-preselect-reason={preselect.kind === 'failed' ? preselect.line.code : preselect.kind === 'unsupported' ? preselect.reason : undefined}>
      <p role="status" aria-live="polite" className="sr-only">
        {preselectWords(preselect)}
      </p>
      {/* The one link outcome said on screen: a short plain line, and the step stays open for another pool. */}
      {preselect.kind === 'withdrawn' && !state.pool && (
        <p className="text-caption text-fg-muted" data-preselect-withdrawn="" aria-hidden="true">
          {CREATE.token.preselectWithdrawn}
        </p>
      )}
      {checking ? (
        // The shape of what a verified link brings: the chosen pool's panel, at the height the answer will occupy.
        <div className="dm-flow-panel" aria-hidden="true">
          <div className="dm-flow-pool-head">
            <span className="inline-flex shrink-0 items-center">
              <Skeleton className="size-7 rounded-full border-2 border-[var(--surface-2)]" />
              <Skeleton className="-ml-2 size-7 rounded-full border-2 border-[var(--surface-2)]" />
            </span>
            <div className="dm-flow-pool-name">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-5 w-20 rounded-[var(--radius-pill)]" />
            </div>
          </div>
        </div>
      ) : chosen ? (
        <ChosenPool
          option={chosen}
          onChange={(event) => {
            // The search only from the keyboard (a key's detail is 0): it opens its list on focus, which a mouse click on
            // Change pool should not do over the pools it means to show (QA round 2 review, N57). A click or a tap: Keep this pool.
            focusNext.current = event.detail === 0 ? 'search' : 'keep'
            setChanging(true)
          }}
          network={others?.name(chosen.currencies[0].chainId) ?? null}
        />
      ) : (
        <>
          {state.pool && (
            <div className="flex justify-end">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  focusNext.current = 'chosen'
                  setChanging(false)
                }}
                data-keep-pool=""
              >
                {CREATE.pool.keep}
              </Button>
            </div>
          )}
          {source ? (
            <TokenSearch
              source={source}
              known={known}
              onFound={fromSearch}
              id="create-token-search"
              // QA round 2, N33/N102: the one label and placeholder of every search. Changed on purpose 2026-10-31 (QA round 2
              // follow-ups, N102): the placeholder is the search's own, word for word as Markets says it ("Search a token on
              // any network" where other networks are searched too), no longer a New position wording of its own.
              label={SEARCH_LABEL}
              initialValue={state.token ? searchName(state.token) : undefined}
              onChoose={choosing}
              onPoint={warmPoolHints}
              home={others?.home}
              others={others?.tokens}
              othersSearch={others?.search}
              onOther={others ? fromNetwork : undefined}
            />
          ) : (
            <p role="status" className="text-body text-fg-muted">
              {CREATE.page.sourceLoading}
            </p>
          )}
          {source && state.token && <PoolList source={source} state={state} onPool={pickPool} onPreview={onPreview} others={others} hint={initialPool} />}
          {/* Changed on purpose 2026-10-31 (QA round 2 follow-ups, R10): the list is Robinhood Chain's, so each pool names it
              from the first paint; waiting for the other networks' answer drew the chip late and pushed the fee down a line. */}
          {source && !state.token && !state.pool && <TopPools entries={top.slice(0, TOP_POOLS)} network={others?.home ?? ROBINHOOD_NAME} server={topServer} />}
        </>
      )}
      {/* Changed on purpose 2026-10-30 (QA round 2 sweep): in the gate's own words, as the V2 journey says a closed network. */}
      {browsingOnly && <p className="dm-hint" role="status" data-network-creation="unavailable">
        {CREATE.token.networkClosed(others?.name(selectedNetwork) ?? 'this network')} {CREATE.token.exploreStill}
      </p>}
    </div>
  )
}
