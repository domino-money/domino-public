import { useEffect, useMemo, useReducer, useState, type FormEvent } from 'react'
import { COPY, IDS_PROBLEM, failureText } from '../../../lib/read/screens/copy'
import { createLookupRunner, lookupReducer, parseTokenIdsInput, type LookupState } from '../../../lib/read/screens/positions'
import { useReadSource } from '../../../lib/read/screens/readContext'
import { Button, Pill } from '../../ui'
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

/**
 * Issue #2 on the Dashboard: a public lookup of position NFTs by ID.
 *
 * Collapsed and silent until asked: nothing is read when the page loads, when
 * the section opens, or on a timer. Each lookup is one read of up to 10 IDs
 * and then the token details it needs, all on one abort signal; a new lookup,
 * hiding the section or leaving the page cancels whatever is still running.
 * Results stay in this component's memory only, and a failed refresh keeps
 * the last cards that worked, with their own block and time.
 */
export function ChainPositionsSection() {
  const source = useReadSource()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [inputError, setInputError] = useState<string | null>(null)
  const [state, dispatch] = useReducer(lookupReducer, { phase: 'idle' } as LookupState)
  // One runner per source: it owns the abort controller and joins a lookup of the IDs already being read.
  const runner = useMemo(() => (source ? createLookupRunner(source, dispatch) : null), [source])

  useEffect(() => () => runner?.cancel(), [runner])

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
    start(parsed.ids)
  }

  const toggle = () => {
    if (open && state.phase === 'loading') {
      runner?.cancel()
      dispatch({ type: 'cancel', requestId: state.requestId })
    }
    setOpen(!open)
  }

  const clear = () => {
    runner?.cancel()
    dispatch({ type: 'clear' })
    setText('')
    setInputError(null)
  }

  const batch = shownBatch(state)
  const { line, busy } = statusFor(state)
  const loading = state.phase === 'loading'

  return (
    <section id="chain-lookup" aria-labelledby="chain-lookup-title" className="mt-10 scroll-mt-24 rounded-[var(--radius-lg)] border border-dashed p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 id="chain-lookup-title" className="text-[15px] font-medium">
            {COPY.lookup.heading}
          </h2>
          <Pill>{__DOMINO_READ_MODE__ === 'fixture' ? COPY.lookup.pillFixture : COPY.lookup.pillChain}</Pill>
        </div>
        <Button variant="outline" aria-expanded={open} aria-controls="chain-lookup-body" onClick={toggle}>
          {open ? COPY.lookup.hide : COPY.lookup.show}
        </Button>
      </div>
      <p className="mt-2 max-w-[70ch] text-[13px] leading-relaxed text-fg-muted">{COPY.lookup.intro}</p>

      <div id="chain-lookup-body" hidden={!open} className="mt-4">
        {open && (
          <div className="grid gap-4">
            <form onSubmit={submit} className="grid gap-2" noValidate>
              <label htmlFor="nft-ids" className="text-[13px] text-fg-muted">
                {COPY.lookup.label}
              </label>
              <textarea
                id="nft-ids"
                rows={2}
                value={text}
                onChange={(e) => setText(e.target.value)}
                aria-describedby={inputError ? 'nft-ids-hint nft-ids-error' : 'nft-ids-hint'}
                aria-invalid={inputError ? true : undefined}
                spellCheck={false}
                autoComplete="off"
                className="w-full resize-y rounded-[var(--radius)] border bg-surface-1 px-3 py-2 font-mono text-[13px] outline-none focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
              />
              <p id="nft-ids-hint" className="text-[12px] text-fg-subtle">
                {COPY.lookup.hint}
              </p>
              {inputError && (
                <p id="nft-ids-error" role="alert" className="text-[13px]" style={{ color: 'var(--money-out)' }}>
                  {inputError}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {/* Stays live while a lookup runs: different IDs cancel the one in flight; the same IDs join it. */}
                <Button type="submit" disabled={!source}>
                  {COPY.lookup.submit}
                </Button>
                {batch && (
                  <Button type="button" variant="outline" aria-disabled={loading ? true : undefined} onClick={() => !loading && start(batch.ids)}>
                    Refresh
                  </Button>
                )}
                {state.phase !== 'idle' && (
                  <Button type="button" variant="ghost" onClick={clear}>
                    Clear
                  </Button>
                )}
              </div>
            </form>

            <ScreenStatus line={line} busy={busy} onRetry={() => state.phase !== 'idle' && start(state.ids)} />

            {batch && (
              <>
                {batch.tokenProblems > 0 && <p className="text-[12px] text-fg-subtle">{batch.tokenCapped ? COPY.lookup.tokenCap : COPY.lookup.tokenProblems}</p>}
                <ul className="grid gap-3" data-chain-cards={batch.cards.length}>
                  {batch.cards.map((card, i) => (
                    <li key={card.key}>
                      <ChainPositionCard card={card} batch={batch} index={i} />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
