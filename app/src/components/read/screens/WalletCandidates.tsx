import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ADDRESS_PROBLEM, COPY, failureText } from '../../../lib/read/screens/copy'
import { parseAddressInput } from '../../../lib/read/screens/identity'
import { candidatesFromWalletView, type TokenCandidate } from '../../../lib/read/screens/tokens'
import { createWalletSession, type WalletSession, type WalletSnapshot } from '../../../lib/read/screens/walletSession'
import type { ReadSource } from '../../../lib/read/types'
import { IconChevronDown, IconWallet } from '../../icons'
import { Button } from '../../ui'
import { ScreenStatus } from './ScreenStatus'

/**
 * Tokens held by a typed public address, as candidates. It is a public
 * lookup, not a wallet connection: nothing proves who controls the address,
 * and the page says so. The continuation handle stays inside the pager; a new
 * address or token list starts a new session and drops any late page from
 * the old one. Nothing is read until "List tokens" is pressed.
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
  const [said, setSaid] = useState('')
  const session = useRef<WalletSession | null>(null)
  const generation = useRef(0)
  const running = useRef<AbortController | null>(null)

  useEffect(() => () => running.current?.abort(), [])

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

  const run = (step: (s: WalletSession, signal: AbortSignal) => Promise<WalletSnapshot>, describe: (before: WalletSnapshot | null, after: WalletSnapshot) => string) => {
    const current = session.current
    if (!current) return
    const gen = generation.current
    running.current?.abort()
    const mine = new AbortController()
    running.current = mine
    const before = snap
    setLoading(true)
    void step(current, mine.signal).then((after) => {
      if (gen !== generation.current || mine.signal.aborted) return
      setLoading(false)
      setSnap(after)
      onRows(candidatesFromWalletView(after.view))
      setSaid(describe(before, after))
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
    session.current = createWalletSession(source, { wallet: parsed.wire, tokens: parts })
    setSnap(null)
    run(
      (s, signal) => s.first(signal),
      (_, after) => (after.failure ? '' : `${after.view.rows.length} token${after.view.rows.length === 1 ? '' : 's'} listed.`),
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
  const moreLabel = loading ? 'Loading…' : snap?.canLoadMore || snap?.status === 'handle_expired' ? COPY.picker.loadMore : COPY.picker.allLoaded
  const moreDisabled = loading || !snap || !(snap.canLoadMore || snap.status === 'handle_expired')

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

        {snap?.failure && snap.status !== 'restart_exhausted' && <ScreenStatus line={failureText(snap.failure, 'wallet')} />}
        {view && (
          <div className="grid gap-1.5 text-caption text-fg-muted" data-wallet-pages={view.pages}>
            {snap.restarted && <p className="text-money-wait">{COPY.picker.walletRestarted}</p>}
            {snap.status === 'restart_exhausted' && (
              <div className="grid gap-2">
                <p className="text-money-wait">{COPY.picker.walletExhausted}</p>
                <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={restart}>
                  {COPY.picker.restartList}
                </Button>
              </div>
            )}
            {snap.status === 'handle_expired' && <p>{COPY.picker.walletExpired}</p>}
            {snap.emptyHint && <p data-wallet-hint="">{COPY.picker.walletEmpty}</p>}
            {snap.capped && <p>{COPY.picker.walletCapped}</p>}
            {view.notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
            {view.freshness.length > 0 && <p className="tnum text-fg-subtle">{view.freshness.join(' · ')}</p>}
            {view.pages > 0 && (
              <div className="mt-1 flex flex-wrap items-center gap-3">
                <Button type="button" variant="outline" size="sm" aria-disabled={moreDisabled ? true : undefined} onClick={more}>
                  {moreLabel}
                </Button>
              </div>
            )}
          </div>
        )}
        <p role="status" aria-live="polite" className="text-caption text-fg-muted">
          {said}
        </p>
      </div>
    </div>
  )
}
