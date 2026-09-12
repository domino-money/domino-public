import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ADDRESS_PROBLEM, COPY, failureText } from '../../../lib/read/screens/copy'
import { parseAddressInput } from '../../../lib/read/screens/identity'
import { candidatesFromWalletView, type TokenCandidate } from '../../../lib/read/screens/tokens'
import { createWalletSession, type WalletSession, type WalletSnapshot } from '../../../lib/read/screens/walletSession'
import type { ReadSource } from '../../../lib/read/types'
import { Button, Pill } from '../../ui'
import { ScreenStatus } from './ScreenStatus'

/**
 * Tokens held by a typed public address, as candidates. It is a public
 * lookup, not a wallet connection: nothing proves who controls the address,
 * and the pill says so. The continuation handle stays inside the pager; a new
 * address or token list starts a new session and drops any late page from
 * the old one.
 */
export function WalletCandidates({ source, onRows }: { source: ReadSource; onRows: (rows: TokenCandidate[]) => void }) {
  const [expanded, setExpanded] = useState(false)
  const [wallet, setWallet] = useState('')
  const [tokensText, setTokensText] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [snap, setSnap] = useState<WalletSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [said, setSaid] = useState('')
  const session = useRef<WalletSession | null>(null)
  const generation = useRef(0)
  const running = useRef<AbortController | null>(null)

  useEffect(() => () => running.current?.abort(), [])

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
    <div className="rounded-[var(--radius)] border bg-surface-1 p-3" data-wallet-candidates="">
      <Button type="button" variant="ghost" className="px-0" aria-expanded={expanded} aria-controls="wallet-candidates-body" onClick={() => setExpanded(!expanded)}>
        {COPY.picker.walletToggle}
      </Button>
      <div id="wallet-candidates-body" hidden={!expanded} className="mt-2 grid gap-3">
        <Pill tone="wait" className="justify-self-start">
          {COPY.picker.walletPill}
        </Pill>
        <p className="text-[12px] leading-relaxed text-fg-muted" data-wallet-public-note="">
          {COPY.picker.walletPublicNote}
        </p>
        <form onSubmit={submit} className="grid gap-2" noValidate>
          <label htmlFor="wallet-address" className="text-[12px] text-fg-muted">
            {COPY.picker.walletLabel}
          </label>
          <input
            id="wallet-address"
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? 'wallet-address-error' : undefined}
            className="w-full rounded-[var(--radius)] border bg-surface-2 px-3 py-2 font-mono text-[12px] outline-none focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
          />
          <label htmlFor="wallet-tokens" className="text-[12px] text-fg-muted">
            {COPY.picker.walletTokensLabel}
          </label>
          <textarea
            id="wallet-tokens"
            rows={2}
            value={tokensText}
            onChange={(e) => setTokensText(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            aria-describedby="wallet-tokens-hint"
            className="w-full resize-y rounded-[var(--radius)] border bg-surface-2 px-3 py-2 font-mono text-[12px] outline-none focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
          />
          <p id="wallet-tokens-hint" className="text-[11px] text-fg-subtle">
            {COPY.picker.walletTokensHint}
          </p>
          {problem && (
            <p id="wallet-address-error" role="alert" className="text-[12px]" style={{ color: 'var(--money-out)' }}>
              {problem}
            </p>
          )}
          <Button type="submit" variant="outline" className="justify-self-start">
            {COPY.picker.walletSubmit}
          </Button>
        </form>

        {snap?.failure && snap.status !== 'restart_exhausted' && <ScreenStatus line={failureText(snap.failure, 'wallet')} />}
        {view && (
          <div className="grid gap-1.5 text-[12px] text-fg-muted" data-wallet-pages={view.pages}>
            {snap.restarted && <p className="text-money-wait">{COPY.picker.walletRestarted}</p>}
            {snap.status === 'restart_exhausted' && (
              <div className="grid gap-2">
                <p className="text-money-wait">{COPY.picker.walletExhausted}</p>
                <Button type="button" variant="outline" className="justify-self-start" onClick={restart}>
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
            {view.freshness.length > 0 && <p className="font-mono text-[11px] text-fg-subtle">{view.freshness.join(' · ')}</p>}
            {view.pages > 0 && (
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" variant="outline" aria-disabled={moreDisabled ? true : undefined} onClick={more}>
                  {moreLabel}
                </Button>
              </div>
            )}
          </div>
        )}
        <p role="status" aria-live="polite" className="text-[12px] text-fg-muted">
          {said}
        </p>
      </div>
    </div>
  )
}
