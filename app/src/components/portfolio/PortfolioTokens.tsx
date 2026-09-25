import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { catalogueTokens } from '../../config/selectedPoolCatalogue'
import { formatUsd } from '../../lib/format/usd'
import { scaledText } from '../../lib/format/decimal'
import type { WalletRow, WalletView } from '../../lib/read/pagers'
import { ADDRESS_PROBLEM, COPY, failureText } from '../../lib/read/screens/copy'
import { tokenAmount } from '../../lib/read/screens/figures'
import { NATIVE_CURRENCY, parseAddressInput, shortAddress } from '../../lib/read/screens/identity'
import { quietTitle, reaskDelayMs, whenVisibleAfter } from '../../lib/read/screens/quietRead'
import { useReadSource } from '../../lib/read/screens/readContext'
import { WALLET_PAGE_CAP, createWalletSession, type WalletSession, type WalletSnapshot } from '../../lib/read/screens/walletSession'
import type { TokenDisplay } from '../../lib/read/types'
import { USD_SCALE, addressesToPrice, totalWithheld, walletHoldings, type Holding } from '../../lib/walletHoldings'
import { walletPrices, type PriceAnswer, type TokenQuote } from '../../lib/walletPrices'
import { LiveFigure } from '../figures'
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

/** No provider quote: what a list holding nothing but USDG is valued with (USDG is $1 without one). */
const NO_QUOTES: ReadonlyMap<string, TokenQuote | null> = new Map()

/** A USD value in 10^-18 dollars as the card writes it: `$1,234.56`. */
const usdText = (units: bigint) => formatUsd(scaledText(units, USD_SCALE))

/** Where a holding's value comes from, for its title: USDG's fixed dollar, or the provider's price and the pair it is from. */
function valueTitle(holding: Holding): string {
  const quote = holding.quote
  if (!quote) return ''
  if (quote.liquidityUsd === null) return 'USDG counted at $1.'
  return `At $${quote.usd} per token, reported by DEX Screener for a pair holding ${formatUsd(String(Math.floor(quote.liquidityUsd)))}. Indicative, not a quote.`
}

/**
 * One holding: its mark (artwork, or a monogram disc), its symbol linked to
 * Markets, and either its USD value right-aligned with the amount small and
 * muted under the symbol, or, when the card has no prices, the amount alone.
 * A symbol another listed holding shares is followed by its short address.
 */
function HoldingRow({ holding }: { holding: Holding }) {
  const { row, value, twin } = holding
  const balance = balanceOf(row)
  const amount = (
    <span className={value === null ? 'dm-acct-token-amount tnum' : 'dm-acct-token-units tnum'} data-balance={row.amount.state} title={balance.title}>
      {balance.text === null ? '—' : <Figure text={balance.text} />}
    </span>
  )
  return (
    <li className="dm-acct-token" data-wallet-row={addressOf(row.token)} data-wallet-row-via={row.via} data-wallet-row-old={row.old ? '' : undefined}>
      <TokenMark token={row.token} size={32} ring="var(--card)" monogram />
      <span className="dm-acct-token-id">
        <TokenName token={row.token} />
        {value !== null && (
          <span className="dm-acct-token-sub">
            {amount}
            {twin && (
              <span className="dm-acct-token-twin" translate="no" title={row.token.address}>
                {shortAddress(row.token.address)}
              </span>
            )}
          </span>
        )}
      </span>
      {value === null ? (
        amount
      ) : (
        <span className="dm-acct-token-usd tnum" data-usd="" title={valueTitle(holding)}>
          {usdText(value)}
        </span>
      )}
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
    snap.capped ? COPY.picker.walletCapped : null,
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
 *
 * What the card shows of that list (owner, 2026-09-25: "only the main tokens,
 * a few at most", by USD value): the total value on top, then the five
 * largest holdings worth at least $1 at a qualified price, largest first, and
 * any others behind "Show N more" (lib/walletHoldings.ts). Zero balances,
 * dust, unpriced tokens, balances that could not be read and look-alikes of
 * the main tokens are left out; the count line still counts what was listed.
 *
 * The largest holdings and their total are the whole list's, never a page's
 * (review of 2026-09-25): every step follows the list's pages on its own, up
 * to WALLET_PAGE_CAP, and a list that skipped candidates gets its by-address
 * check, before the card shows anything of it. That is one wallet-assets
 * read per 20 tokens the wallet holds (two for the owner's 31), then ONE
 * provider GET for the held tokens' prices, kept in memory for the visit
 * (lib/walletPrices.ts). While the first list and its first prices are on the
 * wire the card keeps its skeleton; a later step (Load more after a failure,
 * a restart) keeps the rows on screen. When the prices fail the card lists
 * native ETH, WETH and USDG with their amounts instead. The total is shown
 * only when the list is whole (totalWithheld): pages left unread, balances
 * that could not be read, skipped candidates or unanswered prices leave the
 * rows with no total, the reason in a data attribute only.
 */
export function PortfolioTokens({ address }: { address: string }) {
  const source = useReadSource()
  const [tokens, setTokens] = useState<string[]>([])
  // The provider's answer for one set of addresses, and "Show N more".
  const [priced, setPriced] = useState<{ key: string; answer: PriceAnswer } | null>(null)
  const [expanded, setExpanded] = useState(false)
  // The list as its last step left it (read to its end, or to a failure), and how many balances its pages could not read.
  const [list, setList] = useState<{ snap: WalletSnapshot; unread: number } | null>(null)
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
  // The assets this list's pages could not read, by key: the pager keeps only the last page's.
  const unreadKeys = useRef(new Set<string>())

  /**
   * One step of the session, on its own signal, then the list's next pages on the same signal until there are
   * none (or the cap, or a failure): the card values the whole list, never a page of it. A list whose pages
   * skipped candidates then gets its one by-address check, on the list's signal rather than the step's, so
   * leaving the step never cancels it, and it is asked once, for what the whole list lacks. Only then does
   * the result land, and only if nothing newer was asked for meanwhile.
   */
  const read = useCallback((current: WalletSession, step: Step, settled?: (after: WalletSnapshot) => void) => {
    const gen = generation.current
    running.current?.abort()
    const mine = new AbortController()
    running.current = mine
    const stale = () => gen !== generation.current || mine.signal.aborted
    // Every page's unreadable assets are kept until a later row answers them; a list read again from its first page starts over.
    const note = (after: WalletSnapshot) => {
      if (after.failure === null && after.view.pages === 1) unreadKeys.current.clear()
      for (const item of after.view.unavailable) unreadKeys.current.add(item.key)
    }
    void (async () => {
      let asked: Step = step
      let after = await (step === 'first' ? current.first(mine.signal) : step === 'more' ? current.more(mine.signal) : current.restart(mine.signal))
      note(after)
      while (!stale() && after.failure === null && after.canLoadMore) {
        asked = 'more'
        after = await current.more(mine.signal)
        note(after)
      }
      if (stale()) return
      // Pages skipped candidates: the selected pools' tokens the list lacks are checked once by address; nothing is said on screen.
      if (after.pendingCheck) {
        after = await current.check(checks.current?.signal)
        if (stale()) return
      }
      if (running.current === mine) running.current = null
      const answered = new Set(after.view.rows.map((row) => row.key))
      setLoading(false)
      // A failed step is asked again as the step it was: a page after the first is never read again from the top.
      setLastStep(asked)
      setList({ snap: after, unread: [...unreadKeys.current].filter((key) => !answered.has(key)).length })
      settled?.(after)
    })()
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
    unreadKeys.current.clear()
    // The automatic second read after an empty list is a by-address check of
    // the selected pools' tokens — discovery already reported this address
    // holds nothing listed, so asking it to look again is work with a known
    // answer. Tokens someone typed keep discovery: walletSession's own note
    // says supplying addresses suppresses emptyHint on the assumption the
    // provider page still ran.
    const current = createWalletSession(source, { wallet: address, tokens, fallbackTokens: SELECTED_TOKENS, discover: tokens !== SELECTED_TOKENS })
    session.current = current
    const listChecks = new AbortController()
    checks.current = listChecks
    const mine = read(current, 'first', (after) => {
      if (!after.emptyHint || tokens.length > 0 || autoChecked.current === address) return
      autoChecked.current = address
      setList(null)
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

  const snap = list?.snap ?? null

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
    setList(null)
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

  // The addresses to price for these rows: none when the list holds nothing but USDG, which is $1 without asking.
  const ask = addressesToPrice(rows).join(',')
  useEffect(() => {
    if (ask === '') return
    let alive = true
    void walletPrices.price(ask.split(',')).then((answer) => {
      if (alive) setPriced({ key: ask, answer })
    })
    return () => {
      alive = false
    }
  }, [ask])

  // An earlier answer stands while a later list's tokens are priced (its rows stay, its total waits); a GET that failed leaves amounts.
  const answer = ask === '' ? null : priced
  const pricing = ask !== '' && priced?.key !== ask
  const quotes = ask === '' ? NO_QUOTES : answer && !(answer.answer.failed && answer.answer.quotes.size === 0) ? answer.answer.quotes : null
  const holdings = walletHoldings(rows, quotes)
  // Skeletons only until the first list and its first prices land; a later step keeps what is on screen.
  const waiting = snap === null || (pricing && answer === null)
  const shown = waiting ? [] : holdings.shown
  const rest = !waiting && holdings.mode === 'values' ? holdings.rest : []
  const withheld = totalWithheld(
    {
      reading: loading,
      morePages: Boolean(view?.hasMore && !snap?.capped),
      capped: Boolean(snap?.capped),
      failed: failure !== null,
      unread: list?.unread ?? 0,
      earlier: rows.some((row) => row.old),
      skipped: view?.skipped ?? 0,
      pricing,
    },
    holdings,
  )
  const total = !waiting && withheld === null && holdings.mode === 'values' ? holdings.total : null
  const pricesState = ask === '' ? 'none' : pricing ? 'pending' : quotes === null ? 'failed' : 'ok'
  const showLoadMore = Boolean(view && view.pages > 0 && (canAskMore || loading))

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
      data-wallet-unavailable={unavailable.length > 0 ? unavailable.length : undefined}
      data-wallet-prices={pricesState}
      data-wallet-shown={waiting ? undefined : shown.length + (expanded ? rest.length : 0)}
      data-wallet-total-withheld={waiting || withheld === null ? undefined : withheld}
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
            {' · '}page <span className="tnum">{view.pages}</span> of up to <span className="tnum">{WALLET_PAGE_CAP}</span>
          </>
        ) : (
          ''
        )}
      </p>
      {/* What a screen reader hears about the reads; the eye gets resting rows, the rows themselves, or an empty line. */}
      <p role="status" aria-live="polite" className="sr-only" data-wallet-said="">
        {loading ? 'Reading the token list…' : failure ? failureText(failure, 'wallet').title : ''}
      </p>

      {/* The total of every holding on the card, the ones behind "Show N more" included, when the list is whole; its skeleton holds the place while the first list and its prices are read. */}
      {total !== null ? (
        <p className="dm-acct-total" data-wallet-total="" title="The sum of the holdings on this card, at provider-reported prices with USDG at $1. Indicative, not a quote.">
          <span className="sr-only">Total value </span>
          <LiveFigure value={usdText(total)} mode="digits" dimCents className="dm-fig-xl" />
        </p>
      ) : (
        waiting && (
          <p className="dm-acct-total" aria-hidden="true">
            <Skeleton className="dm-acct-total-skel" />
          </p>
        )
      )}

      {(shown.length > 0 || waiting) && (
        <ul className="dm-acct-token-list" aria-label="Tokens held by this address" aria-busy={waiting || loading || undefined}>
          {shown.map((holding) => (
            <HoldingRow key={holding.row.key} holding={holding} />
          ))}
          {expanded && rest.map((holding) => <HoldingRow key={holding.row.key} holding={holding} />)}
          {waiting &&
            [0, 1, 2].map((n) => (
              <li key={`wait-${n}`} className="dm-acct-token" aria-hidden="true">
                <Skeleton className="size-8 shrink-0 rounded-full" />
                <span className="dm-acct-token-id dm-acct-token-skel">
                  <Skeleton className="h-3.5 w-14" />
                  <Skeleton className="h-3 w-20" />
                </span>
                <Skeleton className="ml-auto h-3.5 w-16" />
              </li>
            ))}
        </ul>
      )}

      {!waiting && snap && listed === 0 && (
        <p className="dm-acct-tokens-empty" data-wallet-empty={failure ? 'failed' : 'listed'} data-wallet-block={block ?? undefined} title={failure ? quietTitle(failure, 'wallet') : block ? `Balances at block ${block}.` : undefined}>
          {failure ? NOTHING_TO_SHOW : NONE_LISTED}
        </p>
      )}
      {/* Listed, but nothing worth a dollar at a qualified price (or, without prices, no ETH, WETH or USDG). */}
      {!waiting && snap && listed > 0 && shown.length === 0 && (
        <p className="dm-acct-tokens-empty" data-wallet-empty={quotes === null ? 'unpriced' : 'unvalued'} data-wallet-block={block ?? undefined} title={block ? `Balances at block ${block}.` : undefined}>
          {NOTHING_TO_SHOW}
        </p>
      )}

      {/* The card's two quiet controls share one line: the holdings behind "Show N more" (and back), and the provider's next page. */}
      {(rest.length > 0 || showLoadMore) && (
        <div className="dm-acct-tokens-actions">
          {rest.length > 0 && (
            <Button type="button" variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
              {expanded ? 'Show less' : `Show ${rest.length} more`}
            </Button>
          )}
          {showLoadMore && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-disabled={loading || !canAskMore ? true : undefined}
              onClick={more}
              title={exhausted ? COPY.picker.walletExhausted : snap?.status === 'handle_expired' ? COPY.picker.walletExpired : failure ? quietTitle(failure, 'wallet') : undefined}
            >
              {loading ? 'Loading…' : COPY.picker.loadMore}
            </Button>
          )}
        </div>
      )}

      {snap && !loading && (snap.emptyHint || tokens.length > 0) && <TokensForm onCheck={check} />}
    </div>
  )
}
