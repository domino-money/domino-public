import { useEffect, useRef, useState, useSyncExternalStore, type ClipboardEvent, type KeyboardEvent } from 'react'
import type { NetworkSearch, NetworkToken } from '../../../lib/create/otherChains'
import { unreadToken } from '../../../lib/read/project'
import { formatUsdCompact } from '../../../lib/read/decimal'
import { dexStore, usdText } from '../../../lib/read/dexFigures'
import { tokenWarning, warningText } from '../../../lib/read/screens/lookalike'
import { symbolReading } from '../../../lib/symbolReading'
import { tokenArtwork } from '../../../lib/tokenArtwork'
import { ADDRESS_PROBLEM, failureText } from '../../../lib/read/screens/copy'
import { parseAddressInput, screenPaste, shortAddress, type AddressKey } from '../../../lib/read/screens/identity'
import { failureCode, quietTitle, reaskDelayMs, whenVisibleAfter } from '../../../lib/read/screens/quietRead'
import { readWithin } from '../../../lib/read/screens/screenRead'
import { SEARCH_LIMIT, extendsQuery, keepSearch, keptSearch, searchCandidates } from '../../../lib/read/screens/searchAnswers'
import { disambiguate, knownTokens, searchTokens, type KnownToken, type SearchResult, type TokenFacts } from '../../../lib/read/screens/tokenSearch'
import { candidateFromToken, selectable, type TokenCandidate } from '../../../lib/read/screens/tokens'
import type { ReadSource, TokenDisplay } from '../../../lib/read/types'
import { IconSearch } from '../../icons'
import { TokenMark } from '../../TokenIcon'
import { cx } from '../../ui'
import { Address } from './Address'

const NO_MATCH = 'No token by that name. Paste its contract address.'
const LISTBOX_LABEL = 'Matching tokens'
const UNNAMED = 'Unnamed token'
const READ_ADDRESS = 'Look up this address'
const ALREADY_CHOSEN = 'Already chosen'
const NOT_READ = 'This token couldn’t be read.'
const reading = (name: string) => `Reading ${name}…`
const readAt = (block: number) => `Read at block ${block}.`

/** What the polite live region says about the chosen token's read. */
type Said = { code: string; words: string }

/** A label as one short line of text: cut where SymbolText cuts, so a long symbol never fills a status line. */
const shortLabel = (label: string) => (label.length > 24 ? `${label.slice(0, 24)}…` : label)
const nameOf = (token: KnownToken) => (token.label === null ? shortAddress(token.key) : shortLabel(token.label))
const keyOf = (result: SearchResult): AddressKey => (result.kind === 'known' ? result.token.key : result.key)

/** The mark for a known token: its read display when there is one, else the address alone with the catalogue's artwork. */
function displayOf(token: KnownToken): TokenDisplay {
  if (token.candidate) return token.candidate.token
  const unread = unreadToken(token.key)
  return token.artwork ? { ...unread, artwork: token.artwork } : unread
}

/** Whether typed text is a name the stored search is asked about: 2 to 96 characters, not an address. */
const searchable = (query: string) => query.length >= 2 && query.length <= 96 && !/^0x/i.test(query)

/** What is wrong with typed text that is an address attempt, once it is long enough to judge. */
function typedProblem(value: string): string | null {
  const trimmed = value.trim()
  if (!/^0[xX]/.test(trimmed)) return null
  const parsed = parseAddressInput(trimmed)
  if (parsed.ok) return null
  if (parsed.reason === 'length' && trimmed.length < 42) return null
  return ADDRESS_PROBLEM[parsed.reason]
}

/**
 * What the page knows of a token beside its name (audit V3, 2026-10-01): DEX Screener's liquidity across its pools,
 * whether a logo was found for it, and whether it passes for one of the site's main tokens.
 */
function factsOf(token: KnownToken | null, key: AddressKey): TokenFacts {
  const peeked = tokenArtwork.peek(4663, key)
  const known = dexStore.token(key)
  return {
    liquidityUsd: known ? known.liquidityUsd : null,
    artwork: token?.artwork ? true : peeked === undefined ? null : peeked !== null,
    warned: token !== null && tokenWarning({ symbol: token.label, address: key }) !== null,
  }
}

/** Liquidity as a hit's line says it: "$144.6K liquidity", or that no pool trades it. Null while not known. */
function liquidityText(facts: TokenFacts): string | null {
  if (facts.liquidityUsd === null) return null
  if (facts.liquidityUsd <= 0) return 'No liquidity found'
  const usd = usdText(facts.liquidityUsd)
  const shown = usd === null ? null : formatUsdCompact(usd)
  return shown === null ? null : `${shown} liquidity`
}

/**
 * A known token as a hit: its name and address, a listed wallet's balance when there is one, and, since 2026-10-01
 * (audit V3, I1), its liquidity where DEX Screener reports it, a word when another hit has the same name, and a warning
 * when it passes for one of the site's main tokens. Where the app knows it from is a data attribute only.
 */
function KnownRow({ token, twin }: { token: KnownToken; twin: boolean }) {
  const facts = factsOf(token, token.key)
  const warning = tokenWarning({ symbol: token.label, address: token.key })
  const liquidity = liquidityText(facts)
  return (
    <>
      <TokenMark token={displayOf(token)} size={28} />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="dm-flow-hit-name">
          {token.label === null ? <span className="text-fg-subtle">{UNNAMED}</span> : <bdi className="inline-block max-w-[24ch] truncate align-bottom">{token.label}</bdi>}
        </span>
        <span className="dm-flow-hit-meta">
          <Address value={token.key} short />
          {token.balanceText !== null && (
            <>
              <span aria-hidden="true"> · </span>
              <span className="tnum">Balance {token.balanceText}</span>
            </>
          )}
          {liquidity !== null && (
            <>
              <span aria-hidden="true"> · </span>
              <span className="tnum" data-token-liquidity={facts.liquidityUsd ?? undefined} title="Liquidity across this token’s pools, as DEX Screener reports it.">{liquidity}</span>
            </>
          )}
          {twin && !warning && (
            <>
              <span aria-hidden="true"> · </span>
              <span data-token-twin="" title="Another token has this name. Check the address before choosing.">Same name as another token</span>
            </>
          )}
        </span>
        {warning && (
          <span className="dm-flow-hit-meta text-money-out" data-token-warning={warning.kind}>
            {warning.kind === 'lookalike' ? `Not the ${warning.main} Domino uses` : 'Misleading name'}
          </span>
        )}
      </span>
    </>
  )
}

function AddressRow({ wire }: { wire: string }) {
  return (
    <>
      <span aria-hidden="true" className="dm-flow-hit-blank" />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="dm-flow-hit-name">{READ_ADDRESS}</span>
        <span className="dm-flow-hit-meta">
          <Address value={wire} short />
        </span>
      </span>
    </>
  )
}

/** No other networks' search: nothing to subscribe to, never a new answer. */
const noSubscribe = () => () => undefined
const noVersion = () => 0

/** A hit's network, in the journey's chip style (2026-10-05, the owner: "the results get the network's tag"). */
function NetworkTag({ chainId, name }: { chainId: number; name: string }) {
  return (
    <span className="dm-chip shrink-0" data-chain-chip={chainId}>
      {name}
    </span>
  )
}

/**
 * Another network's token as a hit (2026-10-05, New position on Base and Arbitrum One): its name and address, and its
 * network's tag. Nothing is looked up for it here, no artwork lookup, no liquidity, no lookalike check (those are
 * Robinhood Chain's); a pasted address is offered as one to look up on that network.
 */
function NetworkRow({ row }: { row: NetworkToken }) {
  const symbol = row.token.symbol
  return (
    <>
      {row.unread ? <span aria-hidden="true" className="dm-flow-hit-blank" /> : <TokenMark token={row.token} size={28} />}
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="dm-flow-hit-name">
          {row.unread ? READ_ADDRESS : symbol === null ? <span className="text-fg-subtle">{UNNAMED}</span> : <bdi className="inline-block max-w-[24ch] truncate align-bottom">{symbol}</bdi>}
        </span>
        <span className="dm-flow-hit-meta">
          <Address value={row.token.address} short />
        </span>
        {/* Added 2026-10-06: a hit that passes for ETH, WETH or USDC there without being it (never chosen). */}
        {row.warning !== undefined && (
          <span className="dm-flow-hit-meta text-money-out" data-token-warning="lookalike">
            {row.warning}
          </span>
        )}
      </span>
      <NetworkTag chainId={row.chainId} name={row.network} />
    </>
  )
}

/** What choosing another network's token came to: chosen, or why not, in words for the line under the field. */
export type NetworkChoice = { ok: true } | { ok: false; code: string; reason: string }

/**
 * A token found by name, the way an exchange finds one: type a few letters
 * and the tokens this app knows appear; paste an address and it is offered
 * as it is. Names are only a way to an address. Choosing a hit hands over the
 * candidate a read already produced, or makes exactly one token read for that
 * address and hands over what it said. Nothing here is ever a symbol lookup.
 * The list is drawn only while it is open, so a closed search asks nothing
 * of anyone, artwork included.
 *
 * No status panel and no Retry: while the read runs the field is marked busy;
 * a read that failed only for the moment is asked again on its own, a few
 * times, while the page is visible; one that stays failed leaves a single
 * plain line, its reason in the line's title and data attribute. The live
 * region says each step in words for a screen reader.
 */
export function TokenSearch({
  source,
  known,
  onFound,
  exclude = null,
  id,
  label,
  placeholder = 'Search by name, e.g. USDG, or paste an address',
  autoFocus,
  initialValue,
  onChoose,
  onPoint,
  home,
  others,
  othersSearch,
  onOther,
}: {
  source: ReadSource
  known: readonly KnownToken[]
  onFound: (candidate: TokenCandidate) => void
  /** The token the pair already holds: listed, but not choosable. */
  exclude?: AddressKey | null
  id: string
  label: string
  placeholder?: string
  autoFocus?: boolean
  /** Text the field starts with, once, when it mounts (a name or an address someone already typed elsewhere). Nothing is read for it. */
  initialValue?: string
  /**
   * New position (speed wave, 2026-09-28): the address a choice is about, the moment it is made, so the pools can be
   * asked beside the token read; null once that choice's token read ended without a token. Nothing on screen changes.
   */
  onChoose?: (key: AddressKey | null) => void
  /** New position: the address of the row pointed at while the list is open, so its pool hints can be asked early. */
  onPoint?: (key: AddressKey) => void
  /**
   * New position on the other networks (2026-10-05, lib/create/otherChains.ts): Robinhood Chain's tag on today's hits,
   * the other networks' hits for the text typed, listed after today's with their tag, and what choosing one does. All
   * three absent everywhere else, where the list is exactly today's.
   */
  home?: string
  others?: (query: string) => readonly NetworkToken[]
  /**
   * Added 2026-10-06: the other networks' search by name (lib/create/otherChains.ts NetworkSearch), asked after the same
   * short pause as today's; its answers re-draw the list. Absent where only the profile's tokens are offered.
   */
  othersSearch?: NetworkSearch
  onOther?: (row: NetworkToken) => Promise<NetworkChoice>
}) {
  const [value, setValue] = useState(initialValue ?? '')
  const [open, setOpen] = useState(false)
  // The hit moved to by the keyboard or the pointer; null until then, when the preselected one (if any) is highlighted.
  const [active, setActive] = useState<number | null>(null)
  // DEX Screener's figures arriving for the hits re-order and re-word them (audit V3).
  useSyncExternalStore(dexStore.subscribe, dexStore.version, dexStore.version)
  // The other networks' search answers arriving add their hits (2026-10-06).
  useSyncExternalStore(othersSearch?.subscribe ?? noSubscribe, othersSearch?.version ?? noVersion, othersSearch?.version ?? noVersion)
  const [problem, setProblem] = useState<string | null>(() => typedProblem(initialValue ?? ''))
  const [said, setSaid] = useState<Said | null>(null)
  // `text`: the line itself, for another network's token, whose reasons are the wallet's (2026-10-05).
  const [failed, setFailed] = useState<{ code: string; reason: string; text?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [stored, setStored] = useState<{ query: string; candidates: TokenCandidate[] } | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const running = useRef<AbortController | null>(null)
  // A quiet re-ask waiting for its time, cancelled by any newer choice.
  const quiet = useRef<(() => void) | null>(null)
  // The latest callback, so the outcome of a read reaches the caller as it is now.
  const foundRef = useRef(onFound)
  const chose = useRef(onChoose)
  const point = useRef(onPoint)
  const other = useRef(onOther)
  // Each choice of another network's token, counted: an answer for an earlier one is dropped.
  const otherTurn = useRef(0)
  useEffect(() => {
    foundRef.current = onFound
    chose.current = onChoose
    point.current = onPoint
    other.current = onOther
  }, [onFound, onChoose, onPoint, onOther])
  useEffect(
    () => () => {
      running.current?.abort()
      quiet.current?.()
    },
    [],
  )
  useEffect(() => {
    if (autoFocus) input.current?.focus()
  }, [autoFocus])

  // Names search persisted verified metadata after a short debounce. Results
  // belong only to the exact current query; wallet balances never enter it.
  // Changed on purpose 2026-09-28 (speed wave, study item 29): each read spends one of the gateway's reads for this
  // visitor, and typing slowly spent them all: every pause sent a read, and the next key threw it away unanswered. A
  // query that an answer kept for this page already answers is not asked (searchAnswers.ts): the same query again, or
  // a longer one after a complete answer ("usd" after "us"). And a read already out for a shorter query is let finish
  // while the typing goes on, since its answer may answer the longer one; a read no longer of use is stopped, as before.
  const searching = useRef<{ query: string; controller: AbortController; done: Promise<void> } | null>(null)
  useEffect(() => () => searching.current?.controller.abort(), [])
  useEffect(() => {
    const query = value.trim()
    const wanted = open && searchable(query) && !!source.supportsStoredReads && !!source.routeEnabled
    const flying = searching.current
    const adopted = wanted && flying !== null && extendsQuery(query, flying.query) ? flying : null
    if (flying && !adopted) {
      flying.controller.abort()
      searching.current = null
    }
    if (!wanted || keptSearch(source, query)) return
    const startedAt = Date.now()
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const ask = () => {
      const controller = new AbortController()
      const done = (source.routeEnabled?.('search', { signal: controller.signal }) ?? Promise.resolve(undefined))
        .then(async (check) => {
          if (check?.state !== 'enabled' || controller.signal.aborted) return
          const outcome = await readWithin(source, 'search', { query, limit: SEARCH_LIMIT }, { signal: controller.signal })
          if (controller.signal.aborted || outcome.state !== 'ok') return
          keepSearch(source, query, outcome.data.tokens)
          setStored({ query, candidates: searchCandidates(outcome.data.tokens) })
        })
        .finally(() => {
          if (searching.current?.controller === controller) searching.current = null
        })
      searching.current = { query, controller, done }
    }
    // After the same short pause as before; a read for a shorter query still out is waited for first.
    const later = () => {
      if (!cancelled && !keptSearch(source, query)) timer = setTimeout(ask, Math.max(0, startedAt + 350 - Date.now()))
    }
    if (adopted) void adopted.done.then(later)
    else later()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [source, value, open])
  // The other networks' search (2026-10-06): asked after the same short pause, while the list is open.
  useEffect(() => {
    if (!open || !othersSearch) return
    const timer = setTimeout(() => othersSearch.ask(value), 350)
    return () => clearTimeout(timer)
  }, [othersSearch, value, open])
  const query = value.trim()
  const answered = searchable(query) ? (keptSearch(source, query) ?? (stored?.query === query ? stored.candidates : null)) : null
  const persisted = answered ? knownTokens({ catalogue: [], candidates: answered }) : []
  const present = new Set(known.map((token) => token.key))
  // Every hit the stored search answered, 20 at the most, where the list used to stop at 8 without a word (audit B7);
  // hits with one name told apart, and the clearly real one alone preselected (audit V3).
  const found = searchTokens(value, [...known, ...persisted.filter((token) => !present.has(token.key))], SEARCH_LIMIT)
  const { results, twins, preselect } = disambiguate(found, (key) => factsOf(found.flatMap((result) => (result.kind === 'known' && result.token.key === key ? [result.token] : []))[0] ?? null, key), symbolReading)
  const asked = [...twins].filter((key) => dexStore.token(key) === null).sort().join()
  useEffect(() => {
    for (const key of asked ? asked.split(',') : []) dexStore.ask(key)
  }, [asked])
  // A known token with no read of its own that the stored search verified (the catalogue's USDG, WETH...): choosing it
  // hands over the search's answer instead of reading it again (study item 28, 2026-09-28).
  const verifiedBySearch = new Map(persisted.flatMap((token) => (token.candidate ? [[token.key, token.candidate] as const] : [])))
  const expanded = open && problem === null
  // The other networks' hits (2026-10-05), after today's: one list for the keyboard, today's preselection unchanged.
  const extra = expanded && others ? others(query) : []
  const total = results.length + extra.length
  const highlighted = total === 0 ? -1 : active === null ? preselect : Math.min(active, total - 1)
  const listboxId = `${id}-listbox`
  const optionId = (result: SearchResult) => `${id}-option-${keyOf(result)}`
  const networkOptionId = (row: NetworkToken) => `${id}-option-${row.chainId}-${row.token.address}`
  const highlightedId = highlighted < 0 ? undefined : highlighted < results.length ? optionId(results[highlighted]) : networkOptionId(extra[highlighted - results.length])
  // A hit that passes for one of the site's main tokens, or carries a misleading name, is listed and never chosen (I1).
  const warned = (result: SearchResult) => result.kind === 'known' && tokenWarning({ symbol: result.token.label, address: result.token.key }) !== null
  const excluded = (result: SearchResult) => (exclude !== null && keyOf(result) === exclude) || warned(result)
  // The row pointed at while the list is open: New position asks its pool hints now (speed wave, 2026-09-28).
  const pointed = expanded && highlighted >= 0 && highlighted < results.length ? keyOf(results[highlighted]) : null
  useEffect(() => {
    if (pointed) point.current?.(pointed)
  }, [pointed])

  /** Stops whatever the last choice still has running or waiting. */
  const stop = () => {
    running.current?.abort()
    running.current = null
    quiet.current?.()
    quiet.current = null
  }

  /** One token read for the chosen address; `attempt` counts the quiet re-asks of that same choice. */
  const read = (wire: string, name: string, attempt = 0) => {
    stop()
    const mine = new AbortController()
    running.current = mine
    setBusy(true)
    if (attempt === 0) {
      setFailed(null)
      setSaid({ code: 'loading', words: reading(name) })
    }
    void readWithin(source, 'token', { token: wire }, { signal: mine.signal }).then((outcome) => {
      if (mine.signal.aborted) return
      if (running.current === mine) running.current = null
      if (outcome.state === 'aborted') {
        setBusy(false)
        return
      }
      if (outcome.state === 'ok') {
        setBusy(false)
        const candidate = candidateFromToken(outcome.data, wire)
        // An address read to a token that passes for one of the site's main tokens is refused here (audit I1).
        const warning = tokenWarning({ symbol: candidate.token.symbol, address: candidate.key })
        if (warning) {
          chose.current?.(null)
          setProblem(warningText(warning, 'token'))
          setSaid({ code: 'warned', words: warningText(warning, 'token') })
          return
        }
        foundRef.current(candidate)
        setSaid({ code: 'ok', words: readAt(outcome.data.snapshot.number) })
        return
      }
      const wait = reaskDelayMs(outcome, attempt)
      if (wait !== null) {
        // Still being asked: the field stays busy and nothing new is said.
        quiet.current = whenVisibleAfter(wait, () => read(wire, name, attempt + 1))
        return
      }
      const text = failureText(outcome, 'token')
      chose.current?.(null)
      setBusy(false)
      setFailed({ code: failureCode(outcome), reason: quietTitle(outcome, 'token') })
      setSaid({ code: text.code, words: text.title })
    })
  }

  const choose = (result: SearchResult) => {
    if (excluded(result)) return
    chose.current?.(keyOf(result))
    setOpen(false)
    setProblem(null)
    if (result.kind === 'address') {
      const name = shortAddress(result.wire)
      setValue(result.wire)
      read(result.wire, name)
      return
    }
    const name = nameOf(result.token)
    setValue(name)
    const candidate = result.token.candidate ?? verifiedBySearch.get(result.token.key) ?? null
    if (candidate && selectable(candidate)) {
      // Already read, or listed with its balance: nothing to ask the chain again.
      stop()
      setBusy(false)
      setFailed(null)
      setSaid(null)
      foundRef.current(candidate)
      return
    }
    read(result.token.wire, name)
  }

  /** Another network's token: handed to New position, which reads what it needs of it through the wallet. */
  const chooseOther = (row: NetworkToken) => {
    if (row.warning !== undefined) return
    stop()
    // Anything today's choice started (its pools read) stops: this token is another network's.
    chose.current?.(null)
    setOpen(false)
    setProblem(null)
    setFailed(null)
    const name = row.unread ? shortAddress(row.token.address) : (row.token.symbol ?? shortAddress(row.token.address))
    setValue(row.unread ? row.token.address : name)
    const turn = ++otherTurn.current
    const outcome = other.current?.(row)
    if (!outcome) return
    setBusy(true)
    setSaid({ code: 'loading', words: reading(name) })
    void outcome.then(
      (done) => {
        if (otherTurn.current !== turn) return
        setBusy(false)
        if (done.ok) {
          setSaid(null)
          return
        }
        setFailed({ code: done.code, reason: done.reason, text: done.reason })
        setSaid({ code: done.code, words: done.reason })
      },
      () => {
        if (otherTurn.current !== turn) return
        setBusy(false)
        setFailed({ code: 'unavailable', reason: NOT_READ })
      },
    )
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        if (!open) {
          setOpen(true)
          setActive(null)
        } else if (total > 0) {
          setActive(Math.min(highlighted + 1, total - 1))
        }
        return
      case 'ArrowUp':
        event.preventDefault()
        if (expanded && total > 0) setActive(Math.max(highlighted - 1, 0))
        return
      case 'Enter': {
        event.preventDefault()
        if (expanded && highlighted >= 0) {
          if (highlighted < results.length) choose(results[highlighted])
          else chooseOther(extra[highlighted - results.length])
          return
        }
        const trimmed = value.trim()
        if (/^0[xX]/.test(trimmed)) {
          const parsed = parseAddressInput(trimmed)
          if (!parsed.ok) setProblem(ADDRESS_PROBLEM[parsed.reason])
        }
        return
      }
      case 'Escape':
        if (open) {
          event.preventDefault()
          setOpen(false)
        }
        return
      default:
    }
  }

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    if (screenPaste(event.clipboardData.getData('text')).ok) return
    event.preventDefault()
    setProblem(ADDRESS_PROBLEM.line_break)
  }

  return (
    <div className="dm-flow-search" data-token-search="">
      <label htmlFor={id} className="dm-label">
        {label}
      </label>
      <div className="dm-flow-combo" aria-busy={busy || undefined}>
        <IconSearch size={16} className={cx('dm-flow-combo-icon', busy && 'animate-pulse-soft')} />
        <input
          ref={input}
          id={id}
          type="text"
          role="combobox"
          aria-expanded={expanded}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={expanded ? highlightedId : undefined}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${id}-error` : undefined}
          value={value}
          onChange={(event) => {
            setValue(event.target.value)
            setOpen(true)
            setActive(null)
            setProblem(typedProblem(event.target.value))
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          className="dm-flow-combo-input"
        />
        <div className="dm-flow-listbox" hidden={!expanded}>
          {/* Never a Tab stop (2026-10-01, D7): a browser makes a scrolling box focusable, and Tab from the input landed
              on this list, which closes as the input blurs, so focus fell to the page's end. The options are reached
              through aria-activedescendant, and Tab moves on from the input to the next control. */}
          <div id={listboxId} role="listbox" aria-label={LISTBOX_LABEL} className="dm-flow-listbox-scroll" tabIndex={-1}>
            {expanded &&
              results.map((result, index) => {
                const key = keyOf(result)
                const disabled = excluded(result)
                const current = index === highlighted
                return (
                  // Options are reached through aria-activedescendant, never by Tab: the input keeps focus.
                  <button
                    key={key}
                    type="button"
                    id={optionId(result)}
                    role="option"
                    tabIndex={-1}
                    aria-selected={current}
                    aria-disabled={disabled || undefined}
                    data-token-option={key}
                    data-token-sources={result.kind === 'known' ? result.token.sources.join(' ') : undefined}
                    data-active={current ? '' : undefined}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => choose(result)}
                    className={cx('dm-flow-hit', disabled && 'dm-flow-hit--off')}
                  >
                    {result.kind === 'known' ? <KnownRow token={result.token} twin={twins.has(result.token.key)} /> : <AddressRow wire={result.wire} />}
                    {disabled && !warned(result) && <span className="dm-flow-hit-meta shrink-0">{ALREADY_CHOSEN}</span>}
                    {home !== undefined && <NetworkTag chainId={4663} name={home} />}
                  </button>
                )
              })}
            {extra.map((row, index) => {
              const current = results.length + index === highlighted
              return (
                <button
                  key={`${row.chainId}:${row.token.address}`}
                  type="button"
                  id={networkOptionId(row)}
                  role="option"
                  tabIndex={-1}
                  aria-selected={current}
                  data-token-network-option={`${row.chainId}:${row.token.address}`}
                  data-active={current ? '' : undefined}
                  aria-disabled={row.warning !== undefined ? true : undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(results.length + index)}
                  onClick={() => chooseOther(row)}
                  className={cx('dm-flow-hit', row.warning !== undefined && 'dm-flow-hit--off')}
                >
                  <NetworkRow row={row} />
                </button>
              )
            })}
          </div>
          {expanded && total === 0 && <p className="dm-flow-listbox-empty">{NO_MATCH}</p>}
        </div>
      </div>
      {problem && (
        <p id={`${id}-error`} role="alert" className="dm-error">
          {problem}
        </p>
      )}
      {failed && !busy && (
        <p className="dm-hint" data-token-search-failed={failed.code} title={failed.reason}>
          {failed.text ?? NOT_READ}
        </p>
      )}
      <p role="status" aria-live="polite" className="sr-only" data-token-search-status={said?.code ?? 'none'}>
        {said?.words}
      </p>
    </div>
  )
}
