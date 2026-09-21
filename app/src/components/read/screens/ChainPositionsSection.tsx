import { useEffect, useMemo, useReducer, useRef, useState, type FormEvent } from 'react'
import { COPY, IDS_PROBLEM, failureText } from '../../../lib/read/screens/copy'
import {
  createLookupRunner,
  lookupReaskDelay,
  lookupReducer,
  parseTokenIdsInput,
  positionsHash,
  positionsRoute,
  type Batch,
  type IdsProblem,
  type LookupFailure,
  type LookupState,
} from '../../../lib/read/screens/positions'
import { failureCode, quietTitle, whenVisibleAfter } from '../../../lib/read/screens/quietRead'
import { useReadSource } from '../../../lib/read/screens/readContext'
import { IconSearch } from '../../icons'
import { Button, Display, EmptyState, SearchField, Skeleton } from '../../ui'
import { ChainPositionCard } from './ChainPositionCard'

const shownBatch = (state: LookupState) => (state.phase === 'ready' ? state.batch : state.phase === 'idle' ? null : state.retained)

/** The failure the section is showing: the last lookup's, and still while a quiet re-ask of the same ids runs. */
function shownFailure(state: LookupState): LookupFailure | null {
  if (state.phase === 'failed') return state.failure
  if (state.phase === 'loading' && state.before.phase === 'failed' && state.before.ids.join(',') === state.ids.join(',')) return state.before.failure
  return null
}

/**
 * What the polite live region says, for a screen reader: the lookup's state
 * in words. Nothing of it is drawn; the cards, an empty state or skeleton rows
 * are what the eye gets.
 */
function statusFor(state: LookupState): { code: string; words: string } {
  switch (state.phase) {
    case 'idle':
      return { code: 'none', words: '' }
    case 'loading': {
      // A quiet re-ask of a failed read keeps saying what failed, so nothing new is announced.
      const failure = shownFailure(state)
      if (failure) {
        const text = failureText(failure, 'positions')
        return { code: text.code, words: text.title }
      }
      return { code: 'loading', words: COPY.lookup.loading }
    }
    case 'ready': {
      const n = state.batch.cards.length
      return { code: 'ok', words: `Loaded ${n} card${n === 1 ? '' : 's'} at block ${state.batch.block.number}.` }
    }
    case 'failed': {
      const text = failureText(state.failure, 'positions')
      return { code: text.code, words: text.title }
    }
    default:
      return state satisfies never
  }
}

/** The title over cards kept from an earlier read, and over token details that could not all be read. */
function rowsTitle(batch: Batch, failure: LookupFailure | null): string | undefined {
  const lines = [
    failure ? `${quietTitle(failure, 'positions')} ${COPY.lookup.retained}` : null,
    batch.tokenProblems > 0 ? (batch.tokenCapped ? COPY.lookup.tokenCap : COPY.lookup.tokenProblems) : null,
  ].filter((line): line is string => line !== null)
  return lines.length > 0 ? lines.join(' ') : undefined
}

interface LinkIds {
  /** As typed in the link, for the field. */
  text: string
  /** Validated, or null when the link carries none or carries something unusable. */
  ids: string[] | null
  problem: IdsProblem | null
}

const NO_IDS: LinkIds = { text: '', ids: null, problem: null }

/** The ids a `#/positions/<ids>` link carries. Nothing else in the hash is read. */
function linkIds(hash: string): LinkIds {
  const route = positionsRoute(hash)
  if (!route.onRoute || route.ids === '') return NO_IDS
  const parsed = parseTokenIdsInput(route.ids)
  return parsed.ok ? { text: parsed.ids.join(', '), ids: parsed.ids, problem: null } : { text: route.ids, ids: null, problem: parsed.reason }
}

/**
 * Puts the ids into the hash so the card set is a link someone can share:
 * replaced in place, so there is no history entry to walk back through and
 * no hashchange to scroll the page. Only on the positions route: the read
 * lab mounts this section under its own hash, and on `#/portfolio/<address>`
 * the Wallet card owns the link, so both stay as they are.
 */
function writeLink(ids: readonly string[]) {
  if (!positionsRoute(window.location.hash).onRoute) return
  const next = positionsHash(ids)
  if (window.location.hash !== next) window.history.replaceState(null, '', next)
}

/**
 * Position NFTs: a public lookup by id, the way into a position, since no read
 * lists the positions a wallet holds.
 *
 * Silent until asked: nothing is read when the page loads or on a timer. A
 * link that carries ids is a question already asked, so those are looked up
 * on arrival, once. Each lookup is one read of up to 10 ids and then the
 * token details it needs, all on one abort signal; a new lookup, Cancel or
 * leaving the page cancels whatever is still running. Looking up the same
 * ids again reads them again and keeps the cards on screen meanwhile.
 *
 * The section shows no status and no Retry. A lookup that failed only for the
 * moment (busy, a transient answer) is asked again on its own, a few times,
 * while the page is visible. A failure that stays shows the cards of the last
 * lookup that worked, or an empty state; the reason is in a title and a data
 * attribute, and in the polite live region for a screen reader. Results stay
 * in this component's memory only.
 */
export function ChainPositionsSection() {
  const source = useReadSource()
  const [link, setLink] = useState(() => linkIds(window.location.hash))
  const [text, setText] = useState(link.text)
  const [inputError, setInputError] = useState<string | null>(link.problem ? IDS_PROBLEM[link.problem] : null)
  const [state, dispatch] = useReducer(lookupReducer, { phase: 'idle' } as LookupState)
  // One runner per source: it owns the abort controller and joins a lookup of the ids already being read.
  const runner = useMemo(() => (source ? createLookupRunner(source, dispatch) : null), [source])
  // The link-borne ids already looked up, so a re-render never asks twice.
  const startedFromLink = useRef<string | null>(null)
  // Quiet re-asks spent on the ids being looked up: a few per set of ids, counted again once a lookup lands.
  const quiet = useRef({ ids: '', attempts: 0 })

  useEffect(() => () => runner?.cancel(), [runner])

  // A link that arrives while the page is open fills the field with what it carries; one without ids leaves the field alone.
  useEffect(() => {
    const onChange = () => {
      const next = linkIds(window.location.hash)
      setLink(next)
      if (next.ids || next.problem) {
        setText(next.text)
        setInputError(next.problem ? IDS_PROBLEM[next.problem] : null)
      }
    }
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  // A link that carries ids is a question already asked: looked up on arrival, once per set of ids.
  useEffect(() => {
    if (!runner || !link.ids) return
    const key = link.ids.join(',')
    if (startedFromLink.current === key) return
    startedFromLink.current = key
    runner.start(state, link.ids)
  }, [runner, link, state])

  // A lookup that failed only for the moment is asked again on its own, after a growing wait, while the page is visible.
  // Cancel ends that too: the failure it restores is marked cancelled, and is left for the next Look up.
  useEffect(() => {
    if (!runner) return
    if (state.phase === 'ready') {
      quiet.current = { ids: state.ids.join(','), attempts: 0 }
      return
    }
    if (state.phase !== 'failed') return
    const ids = state.ids.join(',')
    if (quiet.current.ids !== ids) quiet.current = { ids, attempts: 0 }
    const wait = lookupReaskDelay(state, quiet.current.attempts)
    if (wait === null) return
    const failed = state
    return whenVisibleAfter(wait, () => {
      quiet.current.attempts += 1
      runner.start(failed, failed.ids)
    })
  }, [runner, state])

  const start = (ids: string[]) => {
    quiet.current = { ids: ids.join(','), attempts: 0 }
    runner?.start(state, ids)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const parsed = parseTokenIdsInput(text)
    if (!parsed.ok) {
      setInputError(IDS_PROBLEM[parsed.reason])
      return
    }
    setInputError(null)
    startedFromLink.current = parsed.ids.join(',')
    setLink({ text: parsed.ids.join(', '), ids: parsed.ids, problem: null })
    writeLink(parsed.ids)
    start(parsed.ids)
  }

  const cancel = () => {
    if (state.phase !== 'loading') return
    runner?.cancel()
    dispatch({ type: 'cancel', requestId: state.requestId })
  }

  const clear = () => {
    runner?.cancel()
    dispatch({ type: 'clear' })
    setText('')
    setInputError(null)
    startedFromLink.current = null
    setLink(NO_IDS)
    writeLink([])
  }

  const batch = shownBatch(state)
  const failure = shownFailure(state)
  const status = statusFor(state)
  const loading = state.phase === 'loading'
  const reason = failure ? failureCode(failure) : undefined

  return (
    <section id="chain-lookup" aria-labelledby="chain-lookup-title" className="dm-card dm-acct-nft-card" data-lookup-reason={reason}>
      <div className="dm-acct-nft-head">
        <Display as="h2" id="chain-lookup-title" className="dm-display-card">
          Position NFTs
        </Display>

        <form onSubmit={submit} noValidate className="dm-acct-nft-form">
          <div className="dm-acct-nft-field">
            <label htmlFor="nft-ids" className="sr-only">
              {COPY.lookup.label}
            </label>
            <SearchField
              id="nft-ids"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Position NFT IDs"
              aria-describedby={inputError ? 'nft-ids-hint nft-ids-error' : 'nft-ids-hint'}
              aria-invalid={inputError ? true : undefined}
            />
            <p id="nft-ids-hint" className="dm-hint">
              {COPY.lookup.hint}
            </p>
            {inputError && (
              <p id="nft-ids-error" role="alert" className="dm-error">
                {inputError}
              </p>
            )}
          </div>
          <div className="dm-acct-nft-actions">
            {/* Stays live while a lookup runs: different ids cancel the one in flight; the same ids join it, and once it has answered, read them again. */}
            <Button type="submit" size="sm" disabled={!source}>
              {COPY.lookup.submit}
            </Button>
            {loading && (
              <Button type="button" variant="ghost" size="sm" onClick={cancel}>
                Cancel
              </Button>
            )}
            {state.phase !== 'idle' && (
              <Button type="button" variant="ghost" size="sm" onClick={clear}>
                Clear
              </Button>
            )}
          </div>
        </form>
      </div>

      <p role="status" aria-live="polite" className="sr-only" data-lookup-status={status.code}>
        {status.words}
      </p>

      {batch ? (
        <div className="dm-rows dm-acct-nft-rows" data-chain-cards={batch.cards.length} data-token-problems={batch.tokenProblems || undefined} aria-busy={loading || undefined} title={rowsTitle(batch, failure)}>
          {/* The column names for the eye; each row's own cells carry their names for a screen reader. */}
          <div className="dm-rows-head dm-acct-nft-band" aria-hidden="true">
            <span>Pool</span>
            <span>Range</span>
            <span>Principal</span>
            <span>Unsettled fees</span>
            <span />
          </div>
          {batch.cards.map((card, i) => (
            <ChainPositionCard key={card.key} card={card} batch={batch} index={i} />
          ))}
        </div>
      ) : failure ? (
        // Nothing read to show: an empty state, its reason on hover and in the data attribute above.
        <div title={quietTitle(failure, 'positions')} aria-busy={loading || undefined}>
          <EmptyState icon={<IconSearch />} title="No positions to show" data-empty="positions-failed" />
        </div>
      ) : loading ? (
        <div className="dm-rows dm-acct-nft-rows" aria-hidden="true" data-lookup-loading="">
          {[0, 1].map((n) => (
            <div key={n} className="flex items-center gap-3 px-3 py-4">
              <Skeleton className="size-7 shrink-0 rounded-full" />
              <Skeleton className="h-3 w-40" />
              <Skeleton className="ml-auto h-3 w-24" />
            </div>
          ))}
        </div>
      ) : (
        // A read screen links nowhere (tests/screens.test.mjs pins it), so the ways to Markets and New position sit in the page's title row.
        state.phase === 'idle' && (
          <EmptyState icon={<IconSearch />} title="Look up a position NFT" body="Enter its ID above." data-empty="positions" />
        )
      )}
    </section>
  )
}
