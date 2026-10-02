import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { WALLET_FALLBACK_TOKENS } from '../../config/selectedPoolCatalogue'
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
import { SHOWN_HOLDINGS, WHOLE_LIST, addressesToPrice, held, listGap, totalWithheld, walletHoldings, type Holding, type ListWholeness } from '../../lib/walletHoldings'
import { NO_PRICES, bookQuotes, recallWallet, rememberWallet, withAnswer, type PriceBook, type RememberedList } from '../../lib/walletMemory'
import { walletPrices } from '../../lib/walletPrices'
import { LiveFigure } from '../figures'
import { exploreHref } from '../explore/routes'
import { Figure } from '../positions/Figure'
import { TokenLabel } from '../read/TokenLabel'
import { TokenMark } from '../TokenIcon'
import { Button, Skeleton } from '../ui'

type Step = 'first' | 'more' | 'restart'

const addressOf = (token: TokenDisplay) => (token.origin === 'read' ? token.address : '')

/**
 * The main tokens and the embedded list's, by address (config/selectedPoolCatalogue.ts WALLET_FALLBACK_TOKENS, never a
 * daily featured list's): the list's fallback check, and the tokens asked for when a list shows none held.
 */
const SELECTED_TOKENS: string[] = [...WALLET_FALLBACK_TOKENS]

/** How often the card reads the list again while the page is shown (round 6): the rows stay on screen meanwhile. */
const REFRESH_MS = 300_000
/**
 * On a first visit (nothing remembered), how long the card waits for the whole list and its prices before it draws
 * what it has: a list read in time appears once, in its final order, and a slow one still appears within this.
 * Changed 2026-10-01 (audit V7): 1.5 s, from 5 s. An address's list comes in pages of about 1.5 s each, one after
 * another (the read service's own pace); its first page is on screen after one of them, and the rest follow in place.
 */
const FIRST_PAINT_MS = 1500

/** The pager's own closing sentence; the title says the same thing with the block number in it. */
const PAGER_FOOTNOTE = 'Balances read from the chain at one block. Anyone can see them; they don’t prove who controls the wallet.'
/** An empty card after a read that failed. */
const NOTHING_TO_SHOW = 'Your tokens couldn’t be loaded right now.'
/** An empty card whose list answered: its block is the line's title. */
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
      // A crumb under a millionth of a token is written as such (every digit stays in the title).
      const text = shown.text !== null && /^0\.0{6}/.test(shown.text) ? '<0.000001' : shown.text
      return text !== null && shown.exact !== null ? { text, title: `${shown.exact} · ${where}` } : { text: amount.text, title: where }
    }
    default:
      return { text: amount.text, title: where }
  }
}

/** A cent, in 10^-18 dollars. */
const CENT = 10n ** 16n
/** A USD value in 10^-18 dollars as the card writes it: `$1,234.56`, `$0.26`, and `<$0.01` under a cent. */
const usdText = (units: bigint) => (units < CENT ? '<$0.01' : formatUsd(scaledText((units + CENT / 2n) / CENT, 2)))

/** Where a holding's value comes from, for its title: USDG's fixed dollar, the provider's price and the pair it is from, or none. */
function valueTitle(holding: Holding): string {
  const quote = holding.quote
  if (!quote) return holding.due ? 'No price at the moment.' : 'No market price found for this token.'
  if (quote.liquidityUsd === null) return 'USDG counted at $1.'
  return `At $${quote.usd} per token, reported by DEX Screener for a pair holding ${formatUsd(String(Math.floor(quote.liquidityUsd)))}. Indicative, not a quote.`
}

/**
 * One holding: its mark (artwork, or a monogram disc), its symbol linked to
 * Markets with the amount small and muted under it, and its USD value
 * right-aligned, or a quiet dash when the token has no price (a resting bar
 * while its price is `due` on the wire). A symbol another listed holding
 * shares is followed by its short address.
 */
function HoldingRow({ holding, due }: { holding: Holding; due: boolean }) {
  const { row, value, twin } = holding
  const balance = balanceOf(row)
  return (
    <li className="dm-acct-token" data-wallet-row={addressOf(row.token)} data-wallet-row-via={row.via} data-wallet-row-old={row.old ? '' : undefined} data-wallet-priced={value === null ? undefined : ''}>
      <TokenMark token={row.token} size={32} ring="var(--card)" monogram />
      <span className="dm-acct-token-id">
        <TokenName token={row.token} />
        <span className="dm-acct-token-sub">
          <span className="dm-acct-token-units tnum" data-balance={row.amount.state} title={balance.title}>
            {balance.text === null ? '—' : <Figure text={balance.text} />}
          </span>
          {twin && (
            <span className="dm-acct-token-twin" translate="no" title={row.token.address}>
              {shortAddress(row.token.address)}
            </span>
          )}
        </span>
      </span>
      {value === null && due ? (
        <span className="dm-acct-token-usd" data-price-due="">
          <Skeleton className="ml-auto h-3.5 w-16" />
        </span>
      ) : value === null ? (
        <span className="dm-acct-token-usd dm-acct-token-none" data-no-price="" title={valueTitle(holding)}>
          <span aria-hidden="true">—</span>
          <span className="sr-only">No price</span>
        </span>
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
    block ? `Balances read from the chain at block ${block}. Anyone can see them; they don’t prove who controls the wallet.` : 'Balances read from the chain. Anyone can see them; they don’t prove who controls the wallet.',
    ...view.notes.filter((note) => note !== PAGER_FOOTNOTE),
    provenance.length > 0 ? `${provenance.join(' · ')}.` : null,
    view.skipped > 0 ? `${view.skipped} provider candidate${view.skipped === 1 ? ' wasn’t' : 's weren’t'} checked in this read.` : null,
    checkedByAddress ? 'Balances checked for the verified pool tokens by their exact addresses.' : null,
    snap.capped ? COPY.picker.walletCapped : null,
    snap.restarted ? COPY.picker.walletRestarted : null,
  ]
  return lines.filter((line): line is string => line !== null).join(' ')
}

/** What a settled list says about how whole it is (listGap), with the balances its pages could not read. */
const wholenessOf = (snap: WalletSnapshot, unread: number, reading: boolean): ListWholeness => ({
  reading,
  morePages: snap.view.hasMore && !snap.capped,
  capped: snap.capped,
  failed: snap.failure !== null,
  unread,
  earlier: snap.view.rows.some((row) => row.old),
  skipped: snap.view.skipped,
})

/** The remembered rows with this read's rows over them, by token: nothing the card showed goes away while the list is read again. */
function mergeRows(kept: readonly WalletRow[], fresh: readonly WalletRow[]): WalletRow[] {
  const byKey = new Map(kept.map((row) => [row.key, row]))
  for (const row of fresh) byKey.set(row.key, row)
  return [...byKey.values()]
}

/**
 * The Wallet card's tokens (owner, round 6, 2026-09-27): every token the
 * address holds on Robinhood Chain, converted to USD, the top 3 by value
 * always shown and the rest behind a quiet "Show all", the ones without a
 * price last (lib/walletHoldings.ts). The total on top when the list is whole.
 *
 * Fast, and never empty once it has shown something:
 * - The last list read for this address is kept in this browser
 *   (lib/walletMemory.ts) and drawn at once, with its prices and its total,
 *   while the list is read again. A read that fails leaves it on screen.
 * - The list's pages are read on their own, one after another (the provider
 *   lists 20 tokens a page), and each page is drawn as it lands, over the
 *   last list read to its end, never in its place. A list read to its end
 *   replaces it, and is remembered in turn. On a first visit the rows wait
 *   for the whole list and its prices, FIRST_PAINT_MS at most, so a quick
 *   list appears once, in its final order.
 * - Prices are asked for every held token at once (lib/walletPrices.ts: 30
 *   per GET, the GETs side by side), as soon as a page names new tokens; a
 *   token already asked for is never asked again while its answer is due.
 * - The list is read again every five minutes while the page is shown, with
 *   the rows, the total (when the last list was whole), "Show all" and the
 *   form for other tokens kept as they were until the new read has landed.
 * - Review of round 6 (2026-09-28): each price is kept with the time it was
 *   answered, and counts for an hour (lib/walletMemory.ts); an older one only
 *   keeps its row where it stood. A total on screen stays while the prices of
 *   tokens a read has just named are on the wire, and the rule below applies
 *   once they are answered.
 *
 * Nothing about how the reads went is printed: no status, no Retry, no
 * footnote. A read that failed only for the moment is asked again on its own,
 * a few times, while the page is visible; one that stays failed leaves the
 * rows already shown, or an empty line, with its reason in a title and a data
 * attribute. No list is called complete: a provider's pages hold only what it
 * indexes. A finished list that shows no token the address holds (native ETH
 * and zero balances aside) is followed, once per address, by a list of the
 * selected pools' tokens by address, and offers the form to check others. A
 * list whose pages skipped candidates has the selected pools' tokens it lacks
 * checked once by address, silently. The total is shown only when the list is
 * whole (totalWithheld): pages left unread, balances that could not be read,
 * skipped candidates or unanswered prices leave the rows with no total, the
 * reason in a data attribute only.
 */
export function PortfolioTokens({ address }: { address: string }) {
  const source = useReadSource()
  const [tokens, setTokens] = useState<string[]>([])
  // The last whole read of this address's list: remembered in this browser, then each read of it to its end.
  const [recalled] = useState(() => recallWallet(address))
  const [memory, setMemory] = useState<RememberedList | null>(recalled)
  // What the card stands on while a list is read: the held rows of the last list read to its end (the remembered one
  // at first), and whether that list was whole. A read that fails changes neither, so nothing on screen goes away.
  const [kept, setKept] = useState<readonly WalletRow[]>(() => recalled?.rows ?? [])
  const [steady, setSteady] = useState(() => recalled?.whole === true)
  // A read of the list has ended once (read to its end or to a failure): the total's placeholder is the first read's only.
  const [settledOnce, setSettledOnce] = useState(false)
  // Every price answered for the list's tokens, by price source, with its time: the remembered ones, then each answer over them.
  const [book, setBook] = useState<PriceBook>(() => recalled?.book ?? NO_PRICES)
  // The set of addresses last answered (joined with commas), whether that answer left any of them unanswered, and "Show all".
  const [pricedKey, setPricedKey] = useState<string | null>(null)
  const [pricesFailed, setPricesFailed] = useState(false)
  // The total on screen in the last render, kept while the prices of tokens a read has just named are on the wire.
  const [shownTotal, setShownTotal] = useState<bigint | null>(null)
  const [expanded, setExpanded] = useState(false)
  // This read of the list as its last page left it, and how many balances its pages could not read.
  const [list, setList] = useState<{ snap: WalletSnapshot; unread: number } | null>(null)
  // The first page is asked for as soon as the source is there, so the list starts out loading.
  const [loading, setLoading] = useState(true)
  const [lastStep, setLastStep] = useState<Step>('first')
  // Each quiet re-read of the list, every REFRESH_MS while the page is shown.
  const [round, setRound] = useState(0)
  // The card has drawn its rows once (the whole list priced, or FIRST_PAINT_MS passed): it never goes back to skeletons.
  const [painted, setPainted] = useState(false)
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
   * none (or the cap, or a failure), each drawn as it lands. A list whose pages skipped candidates then gets its
   * one by-address check, on the list's signal rather than the step's, so leaving the step never cancels it. A
   * list read to its end with no failure becomes the remembered one when `keep` says it is the wallet's own list
   * (not tokens someone typed). Nothing lands if something newer was asked for meanwhile.
   */
  const read = useCallback((current: WalletSession, step: Step, keep: boolean, settled?: (after: WalletSnapshot) => void) => {
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
    const unreadOf = (after: WalletSnapshot) => {
      const answered = new Set(after.view.rows.map((row) => row.key))
      return [...unreadKeys.current].filter((key) => !answered.has(key)).length
    }
    void (async () => {
      let asked: Step = step
      let after = await (step === 'first' ? current.first(mine.signal) : step === 'more' ? current.more(mine.signal) : current.restart(mine.signal))
      note(after)
      while (!stale() && after.failure === null && after.canLoadMore) {
        // This page is drawn while the next one is read.
        setList({ snap: after, unread: unreadOf(after) })
        asked = 'more'
        after = await current.more(mine.signal)
        note(after)
      }
      if (stale()) return
      // Pages skipped candidates: the selected pools' tokens the list lacks are checked once by address; nothing is said on screen.
      if (after.pendingCheck) {
        setList({ snap: after, unread: unreadOf(after) })
        after = await current.check(checks.current?.signal)
        if (stale()) return
      }
      if (running.current === mine) running.current = null
      const unread = unreadOf(after)
      setLoading(false)
      // A failed step is asked again as the step it was: a page after the first is never read again from the top.
      setLastStep(asked)
      setList({ snap: after, unread })
      setSettledOnce(true)
      // Read to its end: what the card stands on until the next read ends, and, for the wallet's own list, the list to
      // draw first next time. An empty list about to be checked by address is neither.
      if (after.failure === null && !after.canLoadMore && !after.emptyHint) {
        const whole = listGap(wholenessOf(after, unread, false)) === null
        const rows = after.view.rows.filter(held)
        setKept(rows)
        setSteady(whole)
        if (keep) setMemory({ at: Date.now(), whole, rows })
      }
      settled?.(after)
    })()
    return mine
  }, [])

  // The address whose empty listing was already followed by the verified-token check, so it happens once per address.
  const autoChecked = useRef<string | null>(null)

  // A new session for each address, token list and quiet re-read, read at once; leaving, or asking for another list, cancels what is in flight.
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
    const mine = read(current, 'first', tokens.length === 0 || tokens === SELECTED_TOKENS, (after) => {
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
  }, [source, address, tokens, round, read])

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
      read(current, lastStep, tokens.length === 0 || tokens === SELECTED_TOKENS)
    })
  }, [snap, loading, lastStep, read, tokens])

  useEffect(() => {
    const timer = setTimeout(() => setPainted(true), FIRST_PAINT_MS)
    return () => clearTimeout(timer)
  }, [])

  // The list is read again every REFRESH_MS while the page is shown; what is on screen stays until the new read lands.
  useEffect(() => {
    if (loading || !snap) return
    return whenVisibleAfter(REFRESH_MS, () => {
      setLoading(true)
      setRound((n) => n + 1)
    })
  }, [loading, snap])

  const view = snap?.view
  const freshRows = view?.rows ?? []
  // The last list read to its end with this read's rows over it: a page read again never takes away a row shown before it.
  const rows = mergeRows(kept, freshRows)
  const unavailable = view?.unavailable ?? []
  const exhausted = snap?.status === 'restart_exhausted'
  const canAskMore = Boolean(snap && (snap.canLoadMore || snap.status === 'handle_expired' || exhausted))
  const failure = snap?.failure ?? null
  const block = view ? blockOf(view.freshness) : null
  // The selected pools' tokens asked for because the list showed none held; tokens someone typed are theirs, not this.
  const checkedByAddress = Boolean(snap && tokens === SELECTED_TOKENS)

  // Every held token's price, asked as soon as the list names it; USDG alone asks nothing ($1 without asking). Once the
  // list is read to its end (or to a failure) and its tokens are answered, the card is drawn. An address already
  // answered is taken from walletPrices' memory, so asking again when the read settles sends nothing.
  const ask = addressesToPrice(rows).join(',')
  const settled = !loading && snap !== null
  useEffect(() => {
    if (ask === '') return
    const controller = new AbortController()
    const asked = ask.split(',')
    void walletPrices.price(asked, {
      signal: controller.signal,
      onProgress: (answer) => {
        if (answer.quotes.size > 0) setBook((before) => withAnswer(before, answer, Date.now()))
      },
    }).then((answer) => {
      if (controller.signal.aborted) return
      // A new answer goes over the ones before it, each at its own time; a GET that failed takes nothing away, but a
      // price answered more than an hour ago stops counting.
      setBook((before) => withAnswer(before, answer, Date.now()))
      setPricesFailed(answer.quotes.size < asked.length)
      setPricedKey(ask)
      if (settled) setPainted(true)
    })
    return () => {
      controller.abort()
    }
  }, [ask, settled])

  // The list as the card keeps it in this browser: rewritten when a read reaches its end or prices land.
  useEffect(() => {
    if (memory) rememberWallet(address, memory, book.prices)
  }, [address, memory, book])

  const { quotes, hints } = bookQuotes(book)
  const holdings = walletHoldings(rows, quotes, hints)
  // Skeletons only while nothing was drawn from memory: a first read with no holding yet, or a first visit's holdings
  // until the whole list and its prices land (FIRST_PAINT_MS at most). After that, rows stay.
  const waiting = !recalled?.rows.length && (holdings.all.length === 0 ? loading && (snap === null || !settledOnce) : !painted && !(settled && ask === ''))
  const fresh: ListWholeness = snap ? wholenessOf(snap, list?.unread ?? 0, loading) : { ...WHOLE_LIST, reading: true }
  // The last whole list (remembered, or read in this visit) stands for the wallet while it is read again, and when the
  // new read fails: the total stays through every quiet re-read.
  const wholeness = steady && listGap(fresh) !== null ? WHOLE_LIST : fresh
  const withheld = totalWithheld(wholeness, holdings)
  // The prices of tokens the list has just named are on the wire (and the last answer left none unanswered).
  const pending = ask !== '' && pricedKey !== ask
  const due = pending && !pricesFailed
  // A total already on screen stays until those prices are answered; only then may unanswered prices take it away.
  const total = waiting ? null : withheld === null ? holdings.total : pending && withheld === 'unanswered_prices' ? shownTotal : null
  if (total !== shownTotal) setShownTotal(total)
  // The total's place is held while the list is first read (a first visit), and while a whole list's prices are due.
  const holdPlace = total === null && (waiting || (!recalled && !settledOnce && withheld === 'reading' && holdings.valued > 0) || (due && withheld === 'unanswered_prices'))
  const shown = waiting ? [] : holdings.all.slice(0, SHOWN_HOLDINGS)
  const rest = waiting ? [] : holdings.all.slice(SHOWN_HOLDINGS)
  const visible = expanded ? [...shown, ...rest] : shown
  const firstUnpriced = visible.findIndex((holding) => holding.rank === null)
  const pricesState = ask === '' ? 'none' : pending ? 'pending' : holdings.unanswered > 0 ? 'failed' : 'ok'
  const showLoadMore = Boolean(view && view.pages > 0 && (canAskMore || loading) && failure !== null)

  const run = (step: Step) => {
    const current = session.current
    if (!current) return
    quiet.current = 0
    setLoading(true)
    setLastStep(step)
    read(current, step, tokens.length === 0 || tokens === SELECTED_TOKENS)
  }

  const check = (next: string[]) => {
    setList(null)
    setLoading(true)
    setLastStep('first')
    setTokens(next)
  }

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
      data-wallet-source={kept.length > 0 && loading ? 'memory' : 'read'}
      data-wallet-held={waiting ? undefined : holdings.all.length}
      data-wallet-shown={waiting ? undefined : visible.length}
      data-wallet-total-withheld={waiting || total !== null ? undefined : (withheld ?? undefined)}
    >
      <p className="dm-acct-tokens-count" title={snap && view && view.pages > 0 ? listTitle(snap, view, block, checkedByAddress) : undefined}>
        {view && view.pages > 0 ? (
          <>
            <span className="tnum">{freshRows.length}</span> token{freshRows.length === 1 ? '' : 's'} listed
            {unavailable.length > 0 && (
              <>
                , <span className="tnum">{unavailable.length}</span> unavailable
              </>
            )}
            {' · '}page <span className="tnum">{view.pages}</span> of up to <span className="tnum">{WALLET_PAGE_CAP}</span>
            {/* Whether the list is whole, in words (audit V7): more pages on their way, or a list longer than is read. */}
            {loading && snap?.canLoadMore ? <span data-wallet-more="reading"> · reading more</span> : snap?.capped ? <span data-wallet-more="capped"> · more tokens not listed</span> : null}
          </>
        ) : (
          ''
        )}
      </p>
      {/* What a screen reader hears about the reads; the eye gets resting rows, the rows themselves, or an empty line. */}
      <p role="status" aria-live="polite" className="sr-only" data-wallet-said="">
        {waiting ? 'Reading the token list…' : failure && holdings.all.length === 0 ? failureText(failure, 'wallet').title : ''}
      </p>

      {/* The total of every holding on the card, the ones behind "Show all" included, when the list is whole; its skeleton holds the place while the list is first read. */}
      {total !== null ? (
        <p className="dm-acct-total" data-wallet-total="" title="The sum of the tokens on this card, at provider-reported prices with USDG at $1. Indicative, not a quote.">
          <span className="sr-only">Total value </span>
          <LiveFigure value={usdText(total)} mode="digits" dimCents className="dm-fig-xl" />
        </p>
      ) : (
        holdPlace && (
          <p className="dm-acct-total" aria-hidden="true">
            <Skeleton className="dm-acct-total-skel" />
          </p>
        )
      )}

      {(visible.length > 0 || waiting) && (
        <ul className="dm-acct-token-list" aria-label="Tokens held by this address" aria-busy={waiting || undefined} data-expanded={expanded && rest.length > 0 ? '' : undefined}>
          {visible.map((holding, index) => (
            <Fragment key={holding.row.key}>
              {/* In the whole list, one quiet line before the tokens no market prices (and no earlier price places). */}
              {expanded && index > 0 && index === firstUnpriced && (
                <li className="dm-acct-token-group" data-wallet-unpriced-note="">
                  No price found
                </li>
              )}
              <HoldingRow holding={holding} due={due && holding.due} />
            </Fragment>
          ))}
          {waiting &&
            Array.from({ length: SHOWN_HOLDINGS }, (_, n) => (
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

      {/* An empty list stays said while it is read again; a list asked for anew (tokens someone typed) waits for its answer. */}
      {!waiting && holdings.all.length === 0 && snap !== null && settledOnce && (
        <p className="dm-acct-tokens-empty" data-wallet-empty={failure ? 'failed' : 'listed'} data-wallet-block={block ?? undefined} title={failure ? quietTitle(failure, 'wallet') : block ? `Balances at block ${block}.` : undefined}>
          {failure ? NOTHING_TO_SHOW : NONE_LISTED}
        </p>
      )}

      {/* The card's quiet controls share one line: every token (and back), and the provider's next page after a page failed. */}
      {(rest.length > 0 || showLoadMore) && (
        <div className="dm-acct-tokens-actions">
          {rest.length > 0 && (
            <Button type="button" variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} data-wallet-show-all="">
              {expanded ? 'Show less' : `Show all ${holdings.all.length}`}
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

      {/* Kept through quiet re-reads, with what was typed in it; Check balances asks for a new list. */}
      {snap && settledOnce && (snap.emptyHint || tokens.length > 0) && <TokensForm onCheck={check} />}
    </div>
  )
}
