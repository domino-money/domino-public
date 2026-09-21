import { useState } from 'react'
import { catalogueTokens } from '../../config/selectedPoolCatalogue'
import { CREATE } from '../../lib/create/copy'
import type { JourneyState } from '../../lib/create/journey'
import { shortAddress } from '../../lib/read/screens/identity'
import type { PoolOption } from '../../lib/read/screens/poolsList'
import type { StatusLine } from '../../lib/read/screens/statusLine'
import { knownTokens } from '../../lib/read/screens/tokenSearch'
import { candidateFromPoolCurrency, mergeCandidates, type TokenCandidate } from '../../lib/read/screens/tokens'
import type { ReadSource } from '../../lib/read/types'
import { Address } from '../read/screens/Address'
import { SymbolText } from '../read/screens/SymbolText'
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
  | { kind: 'failed'; line: StatusLine }

/** What a screen reader hears about the link; nothing of it is a panel on screen. */
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
    case 'failed':
      return `${CREATE.token.preselectHeading}: ${status.line.title}.`
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
 * Step 1, Pool: the token to deposit and the pool it goes into.
 *
 * With a pool chosen (from the link, once verified, or from the list) the
 * step shows that pool and its two currencies as the deposit choice. Without
 * one: one search field that takes a name or a contract address, then the
 * existing pools for the chosen token. Nothing else: the field is the whole
 * way in. Nothing is read until a person asks — the search reads a token only
 * when one is chosen, and the pool list reads once it mounts for a chosen
 * token.
 *
 * How the link's verification went is never a panel: while it runs the step
 * holds its place, and whatever it came to is on the step's data attributes
 * and in its live region. A failure that asking again could fix is asked
 * again by the journey on its own; anything else leaves the search.
 */
export function StageToken({
  source,
  state,
  preselect,
  candidates,
  onCandidates,
  onToken,
  onPool,
}: {
  source: ReadSource | null
  state: JourneyState
  preselect: PreselectStatus
  candidates: TokenCandidate[]
  onCandidates: (next: TokenCandidate[]) => void
  onToken: (candidate: TokenCandidate | null) => void
  onPool: (option: PoolOption | null) => void
}) {
  const [changing, setChanging] = useState(false)
  const known = knownTokens({ catalogue: catalogueTokens(), candidates })

  const fromSearch = (candidate: TokenCandidate) => {
    onCandidates(mergeCandidates(candidates, [candidate]))
    onToken(candidate)
  }
  const pickPool = (option: PoolOption | null) => {
    onPool(option)
    if (option) setChanging(false)
  }

  const chosen = state.pool && !changing ? state.pool : null
  // While the linked pool is being verified its answer decides what this step shows, so nothing else is offered yet.
  const checking = preselect.kind === 'checking' && !preselect.again && !state.pool

  return (
    <div className="dm-flow-stack" data-stage="token" data-preselect={preselect.kind} data-preselect-reason={preselect.kind === 'failed' ? preselect.line.code : undefined}>
      <p role="status" aria-live="polite" className="sr-only">
        {preselectWords(preselect)}
      </p>
      {checking ? (
        // The shape of what a verified link brings: the chosen-pool panel, then the deposit
        // choice, because a link carries a pool and no token. Both are direct children of
        // .dm-flow-stack, so they rest at the gap and the height the answer will occupy.
        <>
          <div className="dm-flow-panel" aria-hidden="true">
            <div className="dm-flow-pool-head">
              <span className="inline-flex shrink-0 items-center">
                <Skeleton className="size-7 rounded-full border-2 border-[var(--surface-2)]" />
                <Skeleton className="-ml-2 size-7 rounded-full border-2 border-[var(--surface-2)]" />
              </span>
              <div className="dm-flow-pool-name">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-5 w-28 rounded-[var(--radius-pill)]" />
              </div>
              <Skeleton className="ml-auto h-8 w-40" />
            </div>
          </div>
          <Skeleton className="h-[196px] w-full" />
        </>
      ) : chosen ? (
        <>
          <ChosenPool option={chosen} onChange={() => setChanging(true)} />
          {/* A pool can arrive already chosen, from a pool page's "New position"
              link. That gives the pool and no deposit token, and the step
              refuses to continue for want of one — so the pool's own two
              currencies are offered here rather than leaving a dead end. */}
          {!state.token && (
            <fieldset className="dm-flow-stack" data-deposit-choice="">
              <legend className="dm-flow-subtitle">{CREATE.token.depositWhich}</legend>
              <p className="text-caption text-fg-muted">{CREATE.token.depositWhichNote}</p>
              <div className="dm-flow-options">
                {chosen.currencies.map((currency) => {
                  const candidate = candidateFromPoolCurrency(currency, chosen.block)
                  return (
                    <label key={candidate.key} className="dm-flow-option" data-deposit-token={candidate.key}>
                      <span className="dm-flow-option-top">
                        <input type="radio" name="create-deposit-token" checked={false} disabled={candidate.why !== null} onChange={() => fromSearch(candidate)} />
                        <span className="dm-flow-option-title"><SymbolText token={currency} /></span>
                      </span>
                      <span className="dm-flow-option-line"><Address value={candidate.key} /></span>
                    </label>
                  )
                })}
              </div>
            </fieldset>
          )}
        </>
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
            />
          ) : (
            <p role="status" className="text-body text-fg-muted">
              {CREATE.page.sourceLoading}
            </p>
          )}
          {source && state.token && <PoolList source={source} state={state} onPool={pickPool} />}
        </>
      )}
    </div>
  )
}
