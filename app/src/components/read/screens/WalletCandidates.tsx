import { useEffect, useRef, useState, type FormEvent } from 'react'
import { catalogueTokens } from '../../../config/selectedPoolCatalogue'
import type { WalletView } from '../../../lib/read/pagers'
import { ADDRESS_PROBLEM, COPY, failureText } from '../../../lib/read/screens/copy'
import { parseAddressInput } from '../../../lib/read/screens/identity'
import { failureCode, quietTitle, reaskDelayMs, whenVisibleAfter } from '../../../lib/read/screens/quietRead'
import { candidatesFromWalletView, type TokenCandidate } from '../../../lib/read/screens/tokens'
import { WALLET_PAGE_CAP, createWalletSession, type WalletSession, type WalletSnapshot } from '../../../lib/read/screens/walletSession'
import type { ReadSource } from '../../../lib/read/types'
import { IconChevronDown, IconWallet } from '../../icons'
import { Button } from '../../ui'

type Step = (s: WalletSession, signal: AbortSignal) => Promise<WalletSnapshot>
type Describe = (before: WalletSnapshot | null, after: WalletSnapshot) => string

/** What a list says about itself, as one title: its notes (balances at one block, not proof of control, what the inventory covers), then its block and provider. */
function listNotes(view: WalletView): string | undefined {
  const lines = [...view.notes, view.freshness.length > 0 ? `${view.freshness.join(' · ')}.` : null].filter((line): line is string => line !== null)
  return lines.length > 0 ? lines.join(' ') : undefined
}

/**
 * Tokens held by a typed public address, as candidates. It is a public
 * lookup, not a wallet connection: nothing proves who controls the address,
 * and the list's title says so. The continuation handle stays inside the
 * pager; a new address or token list starts a new session and drops any late
 * page from the old one. Nothing is read until "List tokens" is pressed.
 *
 * No status panel, no Retry and no footnote: the block, the provider and the
 * list's coverage are the list's title and data attributes. A page that
 * failed only for the moment is asked again on its own, a few times, while
 * the page is visible. A first page that stays failed leaves one plain line; a
 * later one leaves the rows and Load more; either way the reason is a title
 * and a data attribute, and the live region says it in words. No list is
 * called complete: Load more is there while pages remain and gone after. The
 * selected pools' tokens a partial list lacks are checked once by address,
 * silently, on the list's own signal, so a newer page never cancels it.
 */
export function WalletCandidates({
  source,
  onRows,
  initialWallet,
  fieldPrefix = 'wallet',
}: {
  source: ReadSource
  onRows: (rows: TokenCandidate[]) => void
  /** An address to start from, such as the header's connected wallet. It fills the field; nothing is read until asked. */
  initialWallet?: string
  /** The start of this listing's field ids (`wallet-address` by default), so two listings on one page never share an id. */
  fieldPrefix?: string
}) {
  const [expanded, setExpanded] = useState(initialWallet !== undefined && initialWallet !== '')
  const [wallet, setWallet] = useState(initialWallet ?? '')
  const [tokensText, setTokensText] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [snap, setSnap] = useState<WalletSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  // A quiet re-ask of the last step is due: its failure is not said on screen yet.
  const [waiting, setWaiting] = useState(false)
  const [said, setSaid] = useState('')
  const session = useRef<WalletSession | null>(null)
  const generation = useRef(0)
  const running = useRef<AbortController | null>(null)
  // The by-address check's own signal, one per list: a newer page leaves the check on the wire; another list, or leaving, cancels it.
  const checks = useRef<AbortController | null>(null)
  const quiet = useRef<(() => void) | null>(null)
  // The latest callback: a page or a check can land well after the press that asked for it, and must merge into the rows as they are then.
  const rowsTo = useRef(onRows)
  useEffect(() => {
    rowsTo.current = onRows
  }, [onRows])

  useEffect(
    () => () => {
      running.current?.abort()
      checks.current?.abort()
      quiet.current?.()
    },
    [],
  )

  // A wallet connected after this mounted fills the field too, unless the
  // person has already typed an address of their own, which stays theirs.
  const seeded = useRef(initialWallet ?? '')
  useEffect(() => {
    const next = initialWallet ?? ''
    if (next === seeded.current) return
    const previous = seeded.current
    seeded.current = next
    setWallet((current) => (current === previous ? next : current))
    if (next) setExpanded(true)
  }, [initialWallet])

  /** One step of the session; `attempt` counts the quiet re-asks of that same step. */
  const run = (step: Step, describe: Describe, attempt = 0) => {
    const current = session.current
    if (!current) return
    const gen = generation.current
    running.current?.abort()
    quiet.current?.()
    quiet.current = null
    const mine = new AbortController()
    running.current = mine
    const before = snap
    setWaiting(false)
    setLoading(true)
    void step(current, mine.signal).then((after) => {
      if (gen !== generation.current || mine.signal.aborted) return
      setLoading(false)
      // The session as it is now: a check that answered while this page was on its way is in it.
      const latest = current.snapshot()
      setSnap(latest)
      rowsTo.current(candidatesFromWalletView(latest.view))
      const passing = after.failure !== null && after.status !== 'restart_exhausted' && after.status !== 'handle_expired'
      const wait = passing && after.failure ? reaskDelayMs(after.failure, attempt) : null
      if (wait !== null) {
        setWaiting(true)
        quiet.current = whenVisibleAfter(wait, () => run(step, describe, attempt + 1))
        return
      }
      setSaid(describe(before, after))
      if (!after.pendingCheck) return
      // A page skipped candidates: the selected pools' tokens are checked once by address, on the list's signal; nothing is said.
      void current.check(checks.current?.signal).then(() => {
        if (gen !== generation.current || current !== session.current) return
        const checked = current.snapshot()
        setSnap(checked)
        rowsTo.current(candidatesFromWalletView(checked.view))
      })
    })
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const parsed = parseAddressInput(wallet)
    if (!parsed.ok) {
      setProblem(ADDRESS_PROBLEM[parsed.reason])
      return
    }
    const parts = tokensText.split(/[\s,]+/).filter((part) => part !== '')
    if (parts.length > 10) {
      setProblem('Up to 10 token addresses.')
      return
    }
    for (const part of parts) {
      const token = parseAddressInput(part)
      if (!token.ok) {
        setProblem(`Token addresses: ${ADDRESS_PROBLEM[token.reason]}`)
        return
      }
    }
    setProblem(null)
    generation.current += 1
    checks.current?.abort()
    checks.current = new AbortController()
    session.current = createWalletSession(source, { wallet: parsed.wire, tokens: parts, fallbackTokens: catalogueTokens().map((token) => token.address) })
    setSnap(null)
    run(
      (s, signal) => s.first(signal),
      (_, after) => (after.failure ? failureText(after.failure, 'wallet').title : `${after.view.rows.length} token${after.view.rows.length === 1 ? '' : 's'} listed.`),
    )
  }

  const more = () => {
    if (loading || !snap) return
    if (!snap.canLoadMore && snap.status !== 'handle_expired') return
    run(
      (s, signal) => s.more(signal),
      (before, after) => {
        if (after.failure) return failureText(after.failure, 'wallet').title
        if (after.restarted && !before?.restarted) return 'The list restarted from the first page.'
        return `Page ${after.view.pages} loaded.`
      },
    )
  }

  const restart = () => {
    run(
      (s, signal) => s.restart(signal),
      () => 'The list started again from the first page.',
    )
  }

  const view = snap?.view
  const canAskMore = Boolean(snap && (snap.canLoadMore || snap.status === 'handle_expired'))
  const failure = snap?.failure && snap.status !== 'restart_exhausted' && !loading && !waiting ? snap.failure : null
  const partial = view !== undefined && view.skipped > 0

  return (
    <div className="dm-flow-wallet" data-wallet-candidates="">
      <button type="button" className="dm-flow-toggle" aria-expanded={expanded} aria-controls={`${fieldPrefix}-candidates-body`} onClick={() => setExpanded(!expanded)}>
        <IconWallet className="shrink-0 text-fg-subtle" />
        <span className="min-w-0 flex-1 text-left">{COPY.picker.walletToggle}</span>
        <IconChevronDown size={14} className="dm-flow-toggle-chevron" />
      </button>
      <div id={`${fieldPrefix}-candidates-body`} hidden={!expanded} className="dm-flow-wallet-body">
        <p className="text-caption text-fg-muted" data-wallet-public-note="">
          Find tokens held by a wallet address.
        </p>
        <form onSubmit={submit} className="grid gap-3" noValidate>
          <div>
            <label htmlFor={`${fieldPrefix}-address`} className="dm-label">
              {COPY.picker.walletLabel}
            </label>
            <input
              id={`${fieldPrefix}-address`}
              value={wallet}
              onChange={(e) => setWallet(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? `${fieldPrefix}-address-error` : undefined}
              placeholder="0x…"
              className="dm-field dm-flow-mono"
            />
          </div>
          <div>
            <label htmlFor={`${fieldPrefix}-tokens`} className="dm-label">
              {COPY.picker.walletTokensLabel}
            </label>
            <textarea
              id={`${fieldPrefix}-tokens`}
              rows={2}
              value={tokensText}
              onChange={(e) => setTokensText(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              aria-describedby={`${fieldPrefix}-tokens-hint`}
              className="dm-field dm-flow-mono resize-y"
            />
            <p id={`${fieldPrefix}-tokens-hint`} className="dm-hint">
              {COPY.picker.walletTokensHint}
            </p>
          </div>
          {problem && (
            <p id={`${fieldPrefix}-address-error`} role="alert" className="dm-error">
              {problem}
            </p>
          )}
          <Button type="submit" variant="outline" className="justify-self-start">
            {COPY.picker.walletSubmit}
          </Button>
        </form>

        {failure && view && view.pages === 0 && (
          <p className="text-caption text-fg-muted" data-wallet-failed={failureCode(failure)} title={quietTitle(failure, 'wallet')}>
            {COPY.picker.walletNothing}
          </p>
        )}
        {view && (
          <div
            className="grid gap-1.5 text-caption text-fg-muted"
            data-wallet-pages={view.pages}
            data-wallet-partial={partial ? view.skipped : undefined}
            data-wallet-skipped-reason={view.skippedReason ?? undefined}
            data-wallet-reason={failure ? failureCode(failure) : undefined}
          >
            {/* A count, as on the Wallet card; what the list says about itself (its block, the provider, what it covers) is the count's title, never a footnote. */}
            {view.pages > 0 && (
              <p className="tnum" data-wallet-count="" title={listNotes(view)}>
                {view.rows.length} token{view.rows.length === 1 ? '' : 's'} listed
                {view.unavailable.length > 0 && `, ${view.unavailable.length} unavailable`}
                {' · '}page {view.pages} of up to {WALLET_PAGE_CAP}
              </p>
            )}
            {snap.restarted && <p>{COPY.picker.walletRestarted}</p>}
            {snap.status === 'restart_exhausted' && (
              <div className="grid gap-2">
                <p>{COPY.picker.walletExhausted}</p>
                <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={restart}>
                  {COPY.picker.restartList}
                </Button>
              </div>
            )}
            {snap.status === 'handle_expired' && <p>{COPY.picker.walletExpired}</p>}
            {snap.emptyHint && <p data-wallet-hint="">{COPY.picker.walletEmpty}</p>}
            {snap.capped && <p>{COPY.picker.walletCapped}</p>}
            {/* No list is called complete: Load more is there while pages remain, and gone after. */}
            {view.pages > 0 && (canAskMore || loading) && (
              <div className="mt-1 flex flex-wrap items-center gap-3">
                <Button type="button" variant="outline" size="sm" aria-disabled={loading || !canAskMore ? true : undefined} onClick={more} title={failure ? quietTitle(failure, 'wallet') : undefined}>
                  {loading ? 'Loading…' : COPY.picker.loadMore}
                </Button>
              </div>
            )}
          </div>
        )}
        <p role="status" aria-live="polite" className="sr-only">
          {said}
        </p>
      </div>
    </div>
  )
}
