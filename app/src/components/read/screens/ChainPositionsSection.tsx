import { useEffect, useMemo, useReducer, useRef, useState, type FormEvent } from 'react'
import { COPY, IDS_PROBLEM, failureText } from '../../../lib/read/screens/copy'
import {
  createLookupRunner,
  lookupReducer,
  parseTokenIdsInput,
  positionsHash,
  positionsRoute,
  type IdsProblem,
  type LookupState,
} from '../../../lib/read/screens/positions'
import { useReadSource } from '../../../lib/read/screens/readContext'
import { IconSearch } from '../../icons'
import { Button, Display, EmptyState, SearchField } from '../../ui'
import { ChainPositionCard } from './ChainPositionCard'
import { ScreenStatus, type StatusLine } from './ScreenStatus'

const shownBatch = (state: LookupState) => (state.phase === 'ready' ? state.batch : state.phase === 'idle' ? null : state.retained)

function statusFor(state: LookupState): { line: StatusLine | null; busy: boolean } {
  switch (state.phase) {
    case 'idle':
      return { line: null, busy: false }
    case 'loading': {
      // A retry of a failed read keeps the failure and its Retry on screen, busy, so focus stays put.
      const before = state.before
      if (before.phase === 'failed' && before.ids.join(',') === state.ids.join(',')) return { line: { ...failureText(before.failure, 'positions'), retry: true }, busy: true }
      return { line: { code: 'loading', title: COPY.lookup.loading, detail: '' }, busy: false }
    }
    case 'ready': {
      const n = state.batch.cards.length
      return { line: { code: 'ok', title: `Loaded ${n} card${n === 1 ? '' : 's'} at block ${state.batch.block.number}.`, detail: '' }, busy: false }
    }
    case 'failed': {
      const text = failureText(state.failure, 'positions')
      return { line: { ...text, detail: state.retained ? `${text.detail} ${COPY.lookup.retained}` : text.detail }, busy: false }
    }
    default:
      return state satisfies never
  }
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
 * leaving the page cancels whatever is still running. Results stay in this
 * component's memory only, and a failed refresh keeps the last cards that
 * worked, with their own block and time.
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

  const start = (ids: string[]) => {
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
  const { line, busy } = statusFor(state)
  const loading = state.phase === 'loading'

  return (
    <section id="chain-lookup" aria-labelledby="chain-lookup-title" className="dm-card dm-acct-nft-card">
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
              placeholder="Position NFT ids, up to 10"
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
            {/* Stays live while a lookup runs: different ids cancel the one in flight; the same ids join it. */}
            <Button type="submit" size="sm" disabled={!source}>
              {COPY.lookup.submit}
            </Button>
            {loading ? (
              <Button type="button" variant="ghost" size="sm" onClick={cancel}>
                Cancel
              </Button>
            ) : (
              batch && (
                <Button type="button" variant="ghost" size="sm" onClick={() => start(batch.ids)}>
                  Refresh
                </Button>
              )
            )}
            {state.phase !== 'idle' && (
              <Button type="button" variant="ghost" size="sm" onClick={clear}>
                Clear
              </Button>
            )}
          </div>
        </form>
      </div>

      <ScreenStatus className="dm-acct-nft-status" line={line} busy={busy} onRetry={() => state.phase !== 'idle' && start(state.ids)} />

      {batch ? (
        <>
          {batch.tokenProblems > 0 && <p className="dm-acct-nft-problems">{batch.tokenCapped ? COPY.lookup.tokenCap : COPY.lookup.tokenProblems}</p>}
          <div className="dm-rows dm-acct-nft-rows" data-chain-cards={batch.cards.length}>
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
        </>
      ) : (
        // A read screen links nowhere (tests/screens.test.mjs pins it), so the ways to Markets and New position sit in the page's title row.
        state.phase === 'idle' && (
          <EmptyState
            icon={<IconSearch />}
            title="Look up a position NFT"
            body="Enter its id above. The read service can't list positions by wallet; the id is in the wallet that holds it."
            data-empty="positions"
          />
        )
      )}
    </section>
  )
}
