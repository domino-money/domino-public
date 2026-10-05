import { useState } from 'react'
import { catalogueTokens } from '../../config/selectedPoolCatalogue'
import { CREATE } from '../../lib/create/copy'
import { dropCreatePools, startCreatePools, warmPoolHints } from '../../lib/create/poolsAhead'
import { stilled } from '../../lib/motion/stilled'
import { rootScale } from '../../lib/rootScale'
import type { JourneyState } from '../../lib/create/journey'
import { shortAddress, type AddressKey } from '../../lib/read/screens/identity'
import type { PoolOption } from '../../lib/read/screens/poolsList'
import type { StatusLine } from '../../lib/read/screens/statusLine'
import { knownTokens } from '../../lib/read/screens/tokenSearch'
import { mergeCandidates, type TokenCandidate } from '../../lib/read/screens/tokens'
import type { ReadSource } from '../../lib/read/types'
import { TokenSearch } from '../read/screens/TokenSearch'
import { Button, Skeleton } from '../ui'
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
      return `${CREATE.token.preselectHeading}: ${CREATE.token.preselectVerified(status.block)}`
    case 'not_found':
      return `${CREATE.token.preselectHeading}: ${CREATE.token.preselectNotFound}`
    case 'unsupported':
      return `${CREATE.token.preselectHeading}: ${status.reason === 'dynamic' ? CREATE.pool.unsupportedDynamic : CREATE.pool.unsupportedHooks}`
    case 'failed':
      return `${CREATE.token.preselectHeading}: ${status.line.title}.`
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

/**
 * Step 1, Pool: the pool the position goes into.
 *
 * With a pool chosen (from the link, once verified, or from the list) the step
 * shows that pool, and Continue. Without one: one search field that takes a
 * name or a contract address, then the existing pools for the chosen token.
 * Nothing else: the field is the whole way in. Nothing is read until a person
 * asks — the search reads a token only when one is chosen, and the pool list
 * reads once it mounts for a chosen token.
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
}) {
  const [changing, setChanging] = useState(false)
  const known = knownTokens({ catalogue: catalogueTokens(), candidates })

  const fromSearch = (candidate: TokenCandidate) => {
    onCandidates(mergeCandidates(candidates, [candidate]))
    onToken(candidate)
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
    // The list folds into the one chosen pool. Picked low in a long list, the fold can leave it above the screen,
    // under the header: bring it back into view once it is drawn, as a step change does (StepList.tsx).
    requestAnimationFrame(() => {
      const panel = document.querySelector('[data-chosen-pool]')
      if (!panel) return
      const header = document.querySelector('header')?.getBoundingClientRect().height ?? 0
      const top = panel.getBoundingClientRect().top
      const air = rootScale()
      if (top < header + 8 * air) window.scrollTo({ top: Math.max(0, window.scrollY + top - header - 24 * air), behavior: stilled() ? 'auto' : 'smooth' })
    })
  }

  const chosen = state.pool && !changing ? state.pool : null
  // While the linked pool is being verified its answer decides what this step shows, so nothing else is offered yet.
  const checking = preselect.kind === 'checking' && !preselect.again && !state.pool

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
        <ChosenPool option={chosen} onChange={() => setChanging(true)} />
      ) : (
        <>
          {state.pool && (
            <div className="flex justify-end">
              <Button type="button" variant="ghost" size="sm" onClick={() => setChanging(false)}>
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
              label={CREATE.token.searchLabel}
              placeholder={CREATE.token.searchPlaceholder}
              initialValue={state.token ? searchName(state.token) : undefined}
              onChoose={choosing}
              onPoint={warmPoolHints}
            />
          ) : (
            <p role="status" className="text-body text-fg-muted">
              {CREATE.page.sourceLoading}
            </p>
          )}
          {source && state.token && <PoolList source={source} state={state} onPool={pickPool} onPreview={onPreview} />}
        </>
      )}
    </div>
  )
}
