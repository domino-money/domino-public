import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { catalogueTokens } from '../../config/selectedPoolCatalogue'
import type { WalletRow, WalletView } from '../../lib/read/pagers'
import type { ItemView } from '../../lib/read/project'
import { ADDRESS_PROBLEM, COPY, failureText } from '../../lib/read/screens/copy'
import { tokenAmount } from '../../lib/read/screens/figures'
import { NATIVE_CURRENCY, parseAddressInput } from '../../lib/read/screens/identity'
import { quietTitle, reaskDelayMs, whenVisibleAfter } from '../../lib/read/screens/quietRead'
import { useReadSource } from '../../lib/read/screens/readContext'
import { WALLET_PAGE_CAP, createWalletSession, type WalletSession, type WalletSnapshot } from '../../lib/read/screens/walletSession'
import type { TokenDisplay } from '../../lib/read/types'
import { exploreHref } from '../explore/routes'
import { Figure } from '../positions/Figure'
import { TokenLabel } from '../read/TokenLabel'
import { TokenMark } from '../TokenIcon'
import { Button, Skeleton } from '../ui'

type Step = 'first' | 'more' | 'restart'

const addressOf = (token: TokenDisplay) => (token.origin === 'read' ? token.address : '')

/** The selected pools' tokens by address: the list's fallback check, and the tokens asked for when a list shows none held. */
const SELECTED_TOKENS: string[] = catalogueTokens().map((token) => token.address)

/** The pager's own closing sentence; the title says the same thing with the block number in it. */
const PAGER_FOOTNOTE = 'Balances at the snapshot block. Not proof of wallet control.'
/** An empty list after a read that failed: nothing to show, and nothing said about why beyond the title. */
const NOTHING_TO_SHOW = 'No token balances to show.'
/** An empty list that answered: its block is the line's title. */
const NONE_LISTED = 'No tokens listed.'

/** The snapshot block, as the pager's freshness lines name it ("Block 123"), or null before a page arrives. */
const blockOf = (lines: readonly string[]) => lines.find((line) => /^Block \d+$/.test(line))?.slice('Block '.length) ?? null

/**
 * A token's name, linked to its view on Markets by its address, never by its
 * symbol. The native currency has no token view, so it is plain text.
 */
function TokenName({ token }: { token: TokenDisplay }) {
  const address = addressOf(token)
  if (address === '' || address === NATIVE_CURRENCY) {
    return (
      <span className="dm-acct-token-name">
        <TokenLabel token={token} />
      </span>
    )
  }
  return (
    <a href={exploreHref(address)} className="dm-acct-token-name dm-acct-token-link" title="Pools for this token on Markets">
      <TokenLabel token={token} />
    </a>
  )
}

/** Where a row's balance came from, for its title: the page or the by-address check, the block, and whether it is from an earlier list. */
const rowTitle = (row: WalletRow) =>
  [row.via === 'address' ? `Checked by address at block ${row.block}` : `Page ${row.page} of the list, block ${row.block}`, row.old ? COPY.picker.fromEarlier : null].filter((part) => part !== null).join(' · ')

/**
 * A balance as the row shows it: in the token's units to six significant
 * digits with every digit in the title, as the position cards write amounts;
 * a dash when it could not be read, or when the token's decimals were not
 * read (its raw amount is then in the title). Where it came from follows in
 * the title.
 */
function balanceOf(row: WalletRow): { text: string | null; title: string } {
  const amount = row.amount
  const where = rowTitle(row)
  switch (amount.state) {
    case 'unavailable':
      return { text: null, title: `${amount.text} · ${where}` }
    case 'raw':
      return { text: null, title: `Raw amount ${row.raw}: the token’s decimals were not read · ${where}` }
    case 'value': {
      const shown = tokenAmount(row.raw, addressOf(row.token), [row.token])
      return shown.text !== null && shown.exact !== null ? { text: shown.text, title: `${shown.exact} · ${where}` } : { text: amount.text, title: where }
    }
    default:
      return { text: amount.text, title: where }
  }
}

function TokenRow({ row }: { row: WalletRow }) {
  const balance = balanceOf(row)
  return (
    <li className="dm-acct-token" data-wallet-row={addressOf(row.token)} data-wallet-row-via={row.via} data-wallet-row-old={row.old ? '' : undefined}>
      <TokenMark token={row.token} size={24} ring="var(--surface-2)" />
      <span className="dm-acct-token-id">
        <TokenName token={row.token} />
      </span>
      <span className="dm-acct-token-amount tnum" data-balance={row.amount.state} title={balance.title}>
        {balance.text === null ? '—' : <Figure text={balance.text} />}
      </span>
    </li>
  )
}

/** An asset the page names whose balance could not be read: listed with a dash, so the list never looks complete when it is not. Its reason is the title. */
function UnavailableRow({ item }: { item: ItemView }) {
  const token = item.title.tokens?.[0]
  if (!token) return null
  return (
    <li className="dm-acct-token" data-wallet-row={addressOf(token)} data-wallet-unavailable="" data-wallet-row-old={item.old ? '' : undefined}>
      <TokenMark token={token} size={24} ring="var(--surface-2)" />
      <span className="dm-acct-token-id">
        <TokenName token={token} />
      </span>
      <span className="dm-acct-token-amount tnum" data-balance="unavailable" title={[item.facts[0]?.text ?? 'Unavailable', item.old ? COPY.picker.fromEarlier : null].filter((part) => part !== null).join(' · ')}>
        —
      </span>
    </li>
  )
}

/** Up to 10 token addresses to check balances for, when the server lists nothing by itself. */
function TokensForm({ onCheck }: { onCheck: (tokens: string[]) => void }) {
  const [text, setText] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const parts = text.split(/[\s,]+/).filter((part) => part !== '')
    if (parts.length === 0) {
      setProblem('Enter at least one token address.')
      return
    }
    if (parts.length > 10) {
      setProblem('Up to 10 token addresses.')
      return
    }
    for (const part of parts) {
      const parsed = parseAddressInput(part)
      if (!parsed.ok) {
        setProblem(`Token addresses: ${ADDRESS_PROBLEM[parsed.reason]}`)
        return
      }
    }
    setProblem(null)
    onCheck(parts)
  }
  return (
    <details className="dm-details dm-acct-tokens-more">
      <summary>{COPY.picker.walletTokensLabel}</summary>
      <form onSubmit={submit} noValidate className="dm-acct-tokens-form" data-wallet-tokens-form="">
        <label htmlFor="portfolio-tokens" className="sr-only">
          {COPY.picker.walletTokensLabel}
        </label>
        <textarea
          id="portfolio-tokens"
          rows={2}
          value={text}
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
          autoComplete="off"
          aria-describedby={problem ? 'portfolio-tokens-hint portfolio-tokens-error' : 'portfolio-tokens-hint'}
          aria-invalid={problem ? true : undefined}
          className="dm-field dm-acct-mono-field"
        />
        <p id="portfolio-tokens-hint" className="dm-hint">
          {COPY.picker.walletTokensHint}
        </p>
        {problem && (
          <p id="portfolio-tokens-error" role="alert" className="dm-error">
            {problem}
          </p>
        )}
        <Button type="submit" variant="outline" size="sm" className="justify-self-start">
          Check balances
        </Button>
      </form>
    </details>
  )
}

/**
 * What the list says about itself, for the count line's title only: the
 * block, that balances prove nothing about control, where the pages came
 * from, and whatever makes the list less than complete. None of it is
 * printed on the card.
 */
function listTitle(snap: WalletSnapshot, view: WalletView, block: string | null, checkedByAddress: boolean): string {
  const provenance = view.freshness.filter((line) => !/^Block \d+$/.test(line))
  const lines = [
    block ? `Balances at block ${block}. Public data, not proof of wallet control.` : 'Balances at the snapshot block. Public data, not proof of wallet control.',
    ...view.notes.filter((note) => note !== PAGER_FOOTNOTE),
    provenance.length > 0 ? `${provenance.join(' · ')}.` : null,
    view.skipped > 0 ? `${view.skipped} provider candidate${view.skipped === 1 ? ' wasn’t' : 's weren’t'} checked in this read.` : null,
    checkedByAddress ? 'Balances checked for the verified pool tokens by their exact addresses.' : null,
    snap.capped ? (view.localPages > 0 ? COPY.picker.walletMixedCapped : COPY.picker.walletCapped) : null,
    snap.restarted ? COPY.picker.walletRestarted : null,
  ]
  return lines.filter((line): line is string => line !== null).join(' ')
}

/**
 * The ERC-20 assets a public address holds, through the wallet session: one
 * session per address and token list, read as soon as there is an address,
 * paged by hand up to the cap, and cancelled when the address changes or
 * the page is left. A balance is in the token's units to six significant
 * digits, every digit in its title, when the token's decimals were read, and
 * a dash with the raw amount in its title when not: never a guess, and never
 * split inside a number. The continuation handle never leaves the pager.
 *
 * The card shows tokens and a count, and nothing about how the reads went: no
 * status, no Retry, no footnote. A read that failed only for the moment is
 * asked again on its own, a few times, while the page is visible; one that
 * stays failed leaves the rows already read, or an empty line, with its
 * reason in a title and a data attribute. No list is called complete: a
 * provider's pages hold only what it indexes. A finished list that shows no
 * token the address holds (native ETH and zero balances aside) is followed,
 * once per address, by a list of the selected pools' tokens by address, and
 * offers the form to check others. A list whose pages skipped candidates has
 * the selected pools' tokens it lacks checked once by address, silently; the
 * partial coverage is only in data attributes and the count's title.
 */
export function PortfolioTokens({ address }: { address: string }) {
  const source = useReadSource()
  const [tokens, setTokens] = useState<string[]>([])
  const [snap, setSnap] = useState<WalletSnapshot | null>(null)
  // The first page is asked for as soon as the source is there, so the list starts out loading.
  const [loading, setLoading] = useState(true)
  const [lastStep, setLastStep] = useState<Step>('first')
  const session = useRef<WalletSession | null>(null)
  const running = useRef<AbortController | null>(null)
  // The by-address check's own signal, one per list: a newer page leaves the check on the wire; another list, or leaving, cancels it.
  const checks = useRef<AbortController | null>(null)
  const generation = useRef(0)
  // Quiet re-asks spent since the list last answered.
  const quiet = useRef(0)

  /**
   * One step of the session, on its own signal; a result lands only if nothing newer was asked for meanwhile.
   * A list that skipped candidates then gets its one by-address check, on the list's signal rather than the
   * step's: Load more pressed while the check is on the wire waits behind it instead of cancelling it and
   * asking for the same check again after the next page.
   */
  const read = useCallback((current: WalletSession, step: Step, settled?: (after: WalletSnapshot) => void) => {
    const gen = generation.current
    running.current?.abort()
    const mine = new AbortController()
    running.current = mine
    const call = step === 'first' ? current.first(mine.signal) : step === 'more' ? current.more(mine.signal) : current.restart(mine.signal)
    void call.then((after) => {
      if (gen !== generation.current || mine.signal.aborted) return
      if (running.current === mine) running.current = null
      setLoading(false)
      // The session as it is now: a check that answered while this page was on its way is in it.
      setSnap(current.snapshot())
      settled?.(after)
      if (!after.pendingCheck) return
      // A page skipped candidates: the selected pools' tokens are checked once by address; nothing is said on screen.
      void current.check(checks.current?.signal).then(() => {
        if (gen !== generation.current || current !== session.current) return
        setSnap(current.snapshot())
      })
    })
    return mine
  }, [])

  // The address whose empty listing was already followed by the verified-token check, so it happens once per address.
  const autoChecked = useRef<string | null>(null)

  // A new session for each address and token list, read at once; leaving, or asking for another list, cancels what is in flight.
  // When the list shows no token the address holds, the balances of the
  // tokens the selected pools hold are asked for once, by their exact
  // addresses, so a wallet that holds USDG or WETH sees them without pasting
  // an address, even where the provider lists nothing for it.
  useEffect(() => {
    if (!source) return
    generation.current += 1
    quiet.current = 0
    const current = createWalletSession(source, { wallet: address, tokens, fallbackTokens: SELECTED_TOKENS })
    session.current = current
    const listChecks = new AbortController()
    checks.current = listChecks
    const mine = read(current, 'first', (after) => {
      if (!after.emptyHint || tokens.length > 0 || autoChecked.current === address) return
      autoChecked.current = address
      setSnap(null)
      setLoading(true)
      setLastStep('first')
      setTokens(SELECTED_TOKENS)
    })
    return () => {
      mine.abort()
      running.current?.abort()
      running.current = null
      listChecks.abort()
    }
  }, [source, address, tokens, read])

  // A step that failed only for the moment is asked again on its own, after a growing wait, while the page is visible.
  // A handle that may have expired, or a restart that was used up, is left to Load more.
  useEffect(() => {
    const current = session.current
    const failure = snap?.failure ?? null
    if (!current || !snap || loading) return
    if (failure === null) {
      quiet.current = 0
      return
    }
    if (snap.status === 'restart_exhausted' || snap.status === 'handle_expired') return
    const wait = reaskDelayMs(failure, quiet.current)
    if (wait === null) return
    return whenVisibleAfter(wait, () => {
      if (current !== session.current || current.snapshot().status === 'handle_expired') return
      quiet.current += 1
      read(current, lastStep)
    })
  }, [snap, loading, lastStep, read])

  const run = (step: Step) => {
    const current = session.current
    if (!current) return
    quiet.current = 0
    setLoading(true)
    setLastStep(step)
    read(current, step)
  }

  const check = (next: string[]) => {
    setSnap(null)
    setLoading(true)
    setLastStep('first')
    setTokens(next)
  }

  const view = snap?.view
  const rows = view?.rows ?? []
  const unavailable = view?.unavailable ?? []
  const listed = rows.length + unavailable.length
  const exhausted = snap?.status === 'restart_exhausted'
  const canAskMore = Boolean(snap && (snap.canLoadMore || snap.status === 'handle_expired' || exhausted))
  const failure = snap?.failure ?? null
  const block = view ? blockOf(view.freshness) : null
  // The selected pools' tokens asked for because the list showed none held; tokens someone typed are theirs, not this.
  const checkedByAddress = Boolean(snap && tokens === SELECTED_TOKENS)

  const more = () => {
    if (loading || !snap || !canAskMore) return
    // A list that changed again while restarting starts over from its first page, by this press.
    run(exhausted ? 'restart' : 'more')
  }

  return (
    <div
      className="dm-acct-tokens"
      data-portfolio-tokens=""
      data-wallet-pages={view?.pages ?? 0}
      data-wallet-status={snap?.status}
      data-wallet-reason={snap?.reason ?? undefined}
      data-wallet-partial={view && view.skipped > 0 ? view.skipped : undefined}
      data-wallet-skipped-reason={view?.skippedReason ?? undefined}
      data-wallet-capped={snap?.capped ? '' : undefined}
      data-wallet-restarted={snap?.restarted ? '' : undefined}
      data-wallet-verified-checked={checkedByAddress ? '' : undefined}
    >
      <p className="dm-acct-tokens-count" aria-live="polite" title={snap && view && view.pages > 0 ? listTitle(snap, view, block, checkedByAddress) : undefined}>
        {view && view.pages > 0 ? (
          <>
            <span className="tnum">{rows.length}</span> token{rows.length === 1 ? '' : 's'} listed
            {unavailable.length > 0 && (
              <>
                , <span className="tnum">{unavailable.length}</span> unavailable
              </>
            )}
            {' · '}page <span className="tnum">{view.pages}</span>{view.localPages === 0 && <> of up to <span className="tnum">{WALLET_PAGE_CAP}</span></>}
          </>
        ) : (
          ''
        )}
      </p>
      {/* What a screen reader hears about the reads; the eye gets resting rows, the rows themselves, or an empty line. */}
      <p role="status" aria-live="polite" className="sr-only" data-wallet-said="">
        {loading ? 'Reading the token list…' : failure ? failureText(failure, 'wallet').title : ''}
      </p>

      {(listed > 0 || loading) && (
        <ul className="dm-acct-token-list" aria-label="Tokens held by this address" aria-busy={loading || undefined}>
          {rows.map((row) => (
            <TokenRow key={row.key} row={row} />
          ))}
          {unavailable.map((item) => (
            <UnavailableRow key={item.key} item={item} />
          ))}
          {loading &&
            [0, 1, 2].map((n) => (
              <li key={`wait-${n}`} className="dm-acct-token" aria-hidden="true">
                <Skeleton className="size-6 shrink-0 rounded-full" />
                <Skeleton className="h-3 w-16" />
                <Skeleton className="ml-auto h-3 w-12" />
              </li>
            ))}
        </ul>
      )}

      {!loading && snap && listed === 0 && (
        <p className="dm-acct-tokens-empty" data-wallet-empty={failure ? 'failed' : 'listed'} data-wallet-block={block ?? undefined} title={failure ? quietTitle(failure, 'wallet') : block ? `Balances at block ${block}.` : undefined}>
          {failure ? NOTHING_TO_SHOW : NONE_LISTED}
        </p>
      )}

      {view && view.pages > 0 && (canAskMore || loading) && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="justify-self-start"
          aria-disabled={loading || !canAskMore ? true : undefined}
          onClick={more}
          title={exhausted ? COPY.picker.walletExhausted : snap?.status === 'handle_expired' ? COPY.picker.walletExpired : failure ? quietTitle(failure, 'wallet') : undefined}
        >
          {loading ? 'Loading…' : COPY.picker.loadMore}
        </Button>
      )}

      {snap && !loading && (snap.emptyHint || tokens.length > 0) && <TokensForm onCheck={check} />}
    </div>
  )
}
