import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type ClipboardEvent, type KeyboardEvent } from 'react'
import { mainTokenAt } from '../../../config/mainTokens'
import { hitRank, mergeHits, preselectOf, type HitFacts, type NetworkSearch, type NetworkToken } from '../../../lib/create/otherChains'
import { unreadToken } from '../../../lib/read/project'
import { formatUsdCompact } from '../../../lib/read/decimal'
import { dexStore, settleSearchHits, usdText } from '../../../lib/read/dexFigures'
import { tokenWarning, warningText } from '../../../lib/read/screens/lookalike'
import { symbolReading } from '../../../lib/symbolReading'
import { tokenArtwork } from '../../../lib/tokenArtwork'
import { ADDRESS_PROBLEM, failureText } from '../../../lib/read/screens/copy'
import { parseAddressInput, screenPaste, shortAddress, shortPrefixes, type AddressKey } from '../../../lib/read/screens/identity'
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

/**
 * The search's one label and placeholder, wherever it is (QA round 2, N102: Markets said "Token name or address" and
 * "Search token or address", New position "Search a token" and "Name or address, like USDG"; the pair kept is the
 * approved prototype's, new.html). N33 (the owner's option A): where the other networks are searched too, the
 * placeholder says so: Markets, whose label is unseen, says it whole (SEARCH_EVERY_NETWORK); a search whose label shows
 * above it (New position) does not repeat "Search a token" under it (SEARCH_EVERY_NETWORK_UNDER_LABEL).
 */
export const SEARCH_LABEL = 'Search a token'
export const SEARCH_PLACEHOLDER = 'Name or address, like USDG'
export const SEARCH_EVERY_NETWORK = 'Search a token on any network'
export const SEARCH_EVERY_NETWORK_UNDER_LABEL = 'Name or address, on any network'

/**
 * The separator between two facts of a hit's line: a no-break space before the dot, so a line that wraps ends with the
 * dot and never starts with one (QA round 2, N1).
 */
const DOT = '\u00a0· '

const NO_MATCH = 'No token by that name. Paste its contract address.'
/** Added 2026-10-06: a pasted address no network names as a token (with the other networks listed). */
const NO_TOKEN_AT = 'No token at this address.'
/**
 * QA round 2 review: a pasted address no network named, where one of them could not tell (read-v6 has no proof of
 * absence): what the search found, never "no token" and never that a network is unavailable.
 */
const NOTHING_AT = 'Nothing found at this address.'
/** Added 2026-10-06: the list's line while a search is still out and nothing is listed yet, in place of a "no token". */
const SEARCHING = 'Searching…'
const LISTBOX_LABEL = 'Matching tokens'
const UNNAMED = 'Unnamed token'
const READ_ADDRESS = 'Look up this address'
const ALREADY_CHOSEN = 'Already chosen'
const NOT_READ = 'This token couldn’t be read.'
const reading = (name: string) => `Reading ${name}…`
const readAt = (block: number) => `Read at block ${block}.`
const WHOLE_ADDRESS = /^0x[0-9a-fA-F]{40}$/

/** What the polite live region says about the chosen token's read. */
type Said = { code: string; words: string }

/**
 * A pasted address on Robinhood Chain, read as soon as it is pasted when the other networks are listed beside it
 * (2026-10-06, the owner's point 3): a token there (named), not one there, or not read.
 */
type HomePaste = { key: AddressKey; state: 'token'; token: KnownToken } | { key: AddressKey; state: 'none' | 'failed' }

/** A token read for a pasted address, as a known token: its read symbol and artwork, choosable with what the read said. */
const knownOfCandidate = (candidate: TokenCandidate): KnownToken => ({
  key: candidate.key,
  wire: candidate.wire,
  label: candidate.token.symbol,
  sources: ['read'],
  artwork: candidate.token.artwork,
  candidate,
  balanceText: null,
})

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

/** A token DEX Screener reports no liquidity for, in any pool (the hit's "No liquidity found"). Not one not known yet. */
const emptyOf = (facts: TokenFacts) => facts.liquidityUsd !== null && facts.liquidityUsd <= 0

/**
 * What the page knows of another network's hit (2026-10-06), as `factsOf` says it of today's: DEX Screener's liquidity
 * across its pools on that network (read with its artwork), whether a logo was found for it, and whether it passes for
 * one of that network's own currencies.
 */
function networkFacts(row: NetworkToken): TokenFacts {
  const known = dexStore.chainToken(row.chainId, row.token.address)
  const peeked = tokenArtwork.peek(row.chainId, row.token.address)
  return {
    liquidityUsd: known ? known.liquidityUsd : null,
    artwork: row.token.artwork ? true : peeked === undefined ? null : peeked !== null,
    warned: row.warning !== undefined,
  }
}

/**
 * Today's hit as the list of every network's hits reads it for Enter (2026-10-06): its name as read, and its facts.
 * Changed on purpose 2026-10-06 (the review of the next update): and whether it is Robinhood Chain's own ETH, WETH or USDG
 * (config/mainTokens.ts), which another network's own currency does not rival (preselectOf).
 */
function homeFacts(result: SearchResult): HitFacts {
  if (result.kind !== 'known') return { name: null, liquidityUsd: null, artwork: null, warned: false, home: true }
  return { ...factsOf(result.token, result.token.key), name: result.token.label === null ? null : symbolReading(result.token.label), home: true, own: mainTokenAt(result.token.key) !== null }
}

/** Another network's hit, the same way (2026-10-06); `own` (the same review): one of that network's own currencies. */
const networkHitFacts = (row: NetworkToken): HitFacts => ({ ...networkFacts(row), name: row.unread || row.token.symbol === null ? null : symbolReading(row.token.symbol), own: row.own === true })

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
function KnownRow({ token, twin, prefix }: { token: KnownToken; twin: boolean; prefix?: number }) {
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
          <Address value={token.key} short prefix={prefix} />
          {token.balanceText !== null && (
            <>
              <span aria-hidden="true">{DOT}</span>
              <span className="tnum">Balance {token.balanceText}</span>
            </>
          )}
          {liquidity !== null && (
            <>
              <span aria-hidden="true">{DOT}</span>
              <span className="tnum" data-token-liquidity={facts.liquidityUsd ?? undefined} title="Liquidity across this token’s pools, as DEX Screener reports it.">{liquidity}</span>
            </>
          )}
          {twin && !warning && (
            <>
              <span aria-hidden="true">{DOT}</span>
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

function AddressRow({ wire, prefix }: { wire: string; prefix?: number }) {
  return (
    <>
      <span aria-hidden="true" className="dm-flow-hit-blank" />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="dm-flow-hit-name">{READ_ADDRESS}</span>
        <span className="dm-flow-hit-meta">
          <Address value={wire} short prefix={prefix} />
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
 * network's tag. No liquidity and no lookalike check here (the network's own warning comes with the row); a pasted
 * address not read on that network is offered as one to look up there. Changed on purpose 2026-10-06 (the owner's point
 * 3: no icon on the other networks): its mark asks DEX Screener for the token's artwork on its network, as a Robinhood
 * Chain token's does (lib/tokenArtwork.ts).
 */
function NetworkRow({ row, prefix }: { row: NetworkToken; prefix?: number }) {
  const symbol = row.token.symbol
  return (
    <>
      {row.unread ? <span aria-hidden="true" className="dm-flow-hit-blank" /> : <TokenMark token={row.token} size={28} />}
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="dm-flow-hit-name">
          {row.unread ? READ_ADDRESS : symbol === null ? <span className="text-fg-subtle">{UNNAMED}</span> : <bdi className="inline-block max-w-[24ch] truncate align-bottom">{symbol}</bdi>}
        </span>
        <span className="dm-flow-hit-meta">
          <Address value={row.token.address} short prefix={prefix} />
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

type SearchEntry = { home: SearchResult } | { network: NetworkToken }
type SearchGroup = { key: string; label: string; entries: SearchEntry[] }

/** What the list's order reads of a hit (QA round 2, N1): its match, whether it is the real one, its known liquidity. */
type Standing = { rank: number; own: boolean; liquidity: number | null; dead: boolean }

/** -1 when only `a` has it, 1 when only `b` does, 0 otherwise: the one that has it first. */
const first = (a: boolean, b: boolean) => (a === b ? 0 : a ? -1 : 1)

/**
 * Presentation only: hits grouped by network, blocked hits last. Changed on purpose 2026-10-30 (QA round 2, N1: "USDC"
 * listed sixteen Robinhood Chain copies above the real USDC on Base and Arbitrum One, in the list and to a screen
 * reader): the group of the hit Enter takes comes first; then the group with the closer match; then one holding a token
 * Domino uses or its network's own currency; then the one with the most known liquidity; then the order they were found
 * in. Inside a group, by match, the real token first and a token with no liquidity last. Enter's choice is decided on
 * the ranked list before this (preselectOf), so this order never changes which hit it is.
 */
function groupedHits(ranked: readonly SearchEntry[], home: string | undefined, excluded: (result: SearchResult) => boolean, standing: (entry: SearchEntry) => Standing, chosen: SearchEntry | undefined) {
  const byGroup = new Map<string, SearchGroup>()
  for (const entry of ranked) {
    const blocked = 'home' in entry ? excluded(entry.home) : entry.network.warning !== undefined
    const key = blocked ? 'unavailable' : String('home' in entry ? 4663 : entry.network.chainId)
    const label = blocked ? 'Unavailable to select' : 'home' in entry ? (home ?? 'Robinhood Chain') : entry.network.network
    const group = byGroup.get(key) ?? { key, label, entries: [] }
    group.entries.push(entry)
    byGroup.set(key, group)
  }
  const found = [...byGroup.values()].filter(group => group.key !== 'unavailable')
  const facts = new Map(ranked.map((entry) => [entry, standing(entry)]))
  const of = (entry: SearchEntry) => facts.get(entry) ?? standing(entry)
  for (const group of found) {
    const at = new Map(group.entries.map((entry, index) => [entry, index]))
    group.entries = [...group.entries].sort((a, b) => of(a).rank - of(b).rank || first(of(a).own, of(b).own) || first(!of(a).dead, !of(b).dead) || (at.get(a) ?? 0) - (at.get(b) ?? 0))
  }
  const place = new Map(found.map((group, index) => [group, index]))
  const best = (group: SearchGroup) => Math.min(...group.entries.map((entry) => of(entry).rank))
  const real = (group: SearchGroup) => group.entries.some((entry) => of(entry).own)
  const liquid = (group: SearchGroup) => Math.max(-1, ...group.entries.map((entry) => of(entry).liquidity ?? -1))
  const holds = (group: SearchGroup) => chosen !== undefined && group.entries.includes(chosen)
  const groups = [...found].sort((a, b) =>
    first(holds(a), holds(b)) || best(a) - best(b) || first(real(a), real(b)) || liquid(b) - liquid(a) || (place.get(a) ?? 0) - (place.get(b) ?? 0))
  const unavailable = byGroup.get('unavailable')
  if (unavailable) groups.push(unavailable)
  return { groups, entries: groups.flatMap(group => group.entries) }
}

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
 *
 * Changed on purpose 2026-10-06 (the owner's points 3 and 4: the search
 * sometimes brought Robinhood Chain alone, with no sign of anything going
 * on): while a name is still being searched (the stored search, the other
 * networks' search, a pasted address read on Robinhood Chain), the search
 * icon pulses, and an empty list says "Searching…" instead of "no token".
 * With the other networks listed, their hits and today's are one list ranked
 * by match quality, and a pasted address is named on every network where it
 * is a token and left out where it is not (the plain "Look up this address"
 * row stays only where nothing could be read and nothing is named).
 */
export function TokenSearch({
  source,
  known,
  onFound,
  exclude = null,
  id,
  label = SEARCH_LABEL,
  placeholder,
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
  /** Changed on purpose 2026-10-30 (QA round 2, N102): SEARCH_LABEL and the shared placeholder unless a caller says otherwise. */
  label?: string
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
  // The hit moved to by the keyboard or the pointer, by its option's id; null until then, when the preselected one (if
  // any) is highlighted.
  const [active, setActive] = useState<string | null>(null)
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
  // The last text the stored search came to nothing for (off, or failed): no longer being searched (2026-10-06).
  const [settled, setSettled] = useState<string | null>(null)
  // A pasted address read on Robinhood Chain beside the other networks' (2026-10-06).
  const [homePaste, setHomePaste] = useState<HomePaste | null>(null)
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
          if (controller.signal.aborted) return
          // Nothing to wait for any more: the search icon stops pulsing for this text (2026-10-06).
          if (check?.state !== 'enabled') {
            setSettled(query)
            return
          }
          const outcome = await readWithin(source, 'search', { query, limit: SEARCH_LIMIT }, { signal: controller.signal })
          if (controller.signal.aborted || outcome.state === 'aborted') return
          if (outcome.state !== 'ok') {
            setSettled(query)
            return
          }
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
  // The other networks' search (2026-10-06): asked after the same short pause, while the list is open. Changed on purpose
  // the same day: what it returns stops it once the list closes or the text changes, so a failed read is asked again
  // only while it is wanted.
  useEffect(() => {
    if (!open || !othersSearch) return
    let stop = () => {}
    const timer = setTimeout(() => {
      stop = othersSearch.ask(value)
    }, 350)
    return () => {
      clearTimeout(timer)
      stop()
    }
  }, [othersSearch, value, open])
  const query = value.trim()
  const present = new Set(known.map((token) => token.key))
  // A pasted address Robinhood Chain does not know yet, read there at once when the other networks are listed (2026-10-06,
  // the owner's point 3: a pasted contract came as one unnamed row per network). The read is the one choosing it makes,
  // so a choice hands over its answer. Everywhere else the address is read once chosen, as before.
  const paste = home !== undefined && WHOLE_ADDRESS.test(query) ? parseAddressInput(query) : null
  const pasteKey = paste?.ok && !present.has(paste.key) ? paste.key : null
  const pasteWire = paste?.ok ? paste.wire : null
  // Until its answer is in, the address is being read (`homePaste` names another address, or none).
  // Changed on purpose 2026-10-06 (review of the same day): only an address with no contract there is "not a token"
  // (read-v1 says `no_contract` for no code alone). An unknown token the read could not get through for the moment (an
  // RPC error, a deadline, a spent budget: `unavailable`) is unread, never "no token": its plain row stays, and choosing
  // it reads it again, as before.
  useEffect(() => {
    if (pasteKey === null || pasteWire === null) return
    const controller = new AbortController()
    void readWithin(source, 'token', { token: pasteWire }, { signal: controller.signal }).then((outcome) => {
      if (controller.signal.aborted) return
      if (outcome.state !== 'ok') {
        setHomePaste({ key: pasteKey, state: 'failed' })
        return
      }
      const candidate = candidateFromToken(outcome.data, pasteWire)
      if (candidate.why === null) setHomePaste({ key: pasteKey, state: 'token', token: knownOfCandidate(candidate) })
      else setHomePaste({ key: pasteKey, state: candidate.why === 'no_contract' ? 'none' : 'failed' })
    })
    return () => controller.abort()
  }, [source, pasteKey, pasteWire])
  const answered = searchable(query) ? (keptSearch(source, query) ?? (stored?.query === query ? stored.candidates : null)) : null
  const persisted = answered ? knownTokens({ catalogue: [], candidates: answered }) : []
  // QA round 2, N6: the stored search's hits, all on Robinhood Chain, settled in one or two GETs of our edge's tokens batch
  // (dexFigures.ts settleSearchHits): a look-alike with no pair reads "No liquidity found" with no artwork, as its own
  // token-pairs answer would say, so its mark asks nothing. Other networks' rows are never sent. What a hit shows, and
  // the hits' order, are unchanged.
  const hitKeys = persisted.map((token) => token.key).join(',')
  useEffect(() => {
    if (!open || hitKeys === '') return
    const controller = new AbortController()
    // A batch that fails settles nothing: each mark then reads its own answer, as before.
    settleSearchHits(hitKeys.split(','), controller.signal).catch(() => undefined)
    return () => controller.abort()
  }, [hitKeys, open])
  // Every hit the stored search answered, 20 at the most, where the list used to stop at 8 without a word (audit B7);
  // hits with one name told apart, and the clearly real one alone preselected (audit V3).
  const searched = searchTokens(value, [...known, ...persisted.filter((token) => !present.has(token.key))], SEARCH_LIMIT)
  // That pasted address's row (2026-10-06): named when it is a token on Robinhood Chain, left out when it is not or while
  // it is read, and the plain row only when the read failed.
  const found = pasteKey === null ? searched : searched.flatMap((result): SearchResult[] => {
    if (result.kind !== 'address' || result.key !== pasteKey) return [result]
    if (homePaste?.key !== pasteKey) return []
    if (homePaste.state === 'token') return [{ kind: 'known', token: homePaste.token, rank: 0 }]
    return homePaste.state === 'failed' ? [result] : []
  })
  const { results: ranked, twins, preselect } = disambiguate(found, (key) => factsOf(found.flatMap((result) => (result.kind === 'known' && result.token.key === key ? [result.token] : []))[0] ?? null, key), symbolReading)
  // Visible marks share their bounded metadata reads with dexStore. Do not separately fetch every offscreen
  // namesake: a crowded search used to bypass the artwork queue and spend requests for rows never viewed.
  // A known token with no read of its own that the stored search verified (the catalogue's USDG, WETH...): choosing it
  // hands over the search's answer instead of reading it again (study item 28, 2026-09-28).
  const verifiedBySearch = new Map(persisted.flatMap((token) => (token.candidate ? [[token.key, token.candidate] as const] : [])))
  const expanded = open && problem === null
  // The other networks' hits (2026-10-05).
  const offered = expanded && others ? others(query) : []
  // A pasted address named on some network leaves out every plain row of a network it could not be read on (2026-10-06):
  // those stay only while nothing is named, as the one way on.
  const named = home !== undefined && WHOLE_ADDRESS.test(query) && (ranked.some((result) => result.kind === 'known') || offered.some((row) => !row.unread))
  const results = named ? ranked.filter((result) => result.kind !== 'address') : ranked
  const extra = named ? offered.filter((row) => !row.unread) : offered
  // Preserve match quality and liquidity ranking for qualification and initial Enter selection. V3 groups the
  // rendered list only after this decision; a group starts where its best ranked selectable hit appeared.
  const rankedMerged = mergeHits(
    results,
    (result) => (result.kind === 'known' ? result.rank : 0),
    extra,
    query,
    home === undefined ? {} : { home: (result) => result.kind === 'known' && emptyOf(factsOf(result.token, result.token.key)), network: (row) => emptyOf(networkFacts(row)) },
  )
  const listboxId = `${id}-listbox`
  const optionId = (result: SearchResult) => `${id}-option-${keyOf(result)}`
  const networkOptionId = (row: NetworkToken) => `${id}-option-${row.chainId}-${row.token.address}`
  const entryId = (entry: (typeof rankedMerged)[number]) => ('home' in entry ? optionId(entry.home) : networkOptionId(entry.network))
  // The hit Enter takes. Today's rule (audit V3) over today's hits alone; with other networks listed, the same rule over
  // every network's hits (review of 2026-10-06): a copy on Robinhood Chain is never highlighted beside the real token on
  // Base, nor a weaker match below exact ones.
  const preselected = preselect >= 0 ? ranked[preselect] : undefined
  const rankedPreselectAt =
    home === undefined
      ? preselected === undefined
        ? -1
        : rankedMerged.findIndex((entry) => 'home' in entry && entry.home === preselected)
      : preselectOf(rankedMerged, (entry) => ('home' in entry ? homeFacts(entry.home) : networkHitFacts(entry.network)))
  // V3: group the presentation by network, then unavailable choices. Qualification and Enter's initial choice
  // still use the original ranked list. Keyboard navigation and drawing share this same flattened group order.
  const warned = (result: SearchResult) => result.kind === 'known' && tokenWarning({ symbol: result.token.label, address: result.token.key }) !== null
  const excluded = (result: SearchResult) => (exclude !== null && keyOf(result) === exclude) || warned(result)
  // QA round 2, N1: the list's order (presentation only), from what the search already knows of each hit.
  const standing = (entry: SearchEntry): Standing => {
    if ('home' in entry) {
      const result = entry.home
      if (result.kind !== 'known') return { rank: 0, own: false, liquidity: null, dead: false }
      const facts = factsOf(result.token, result.token.key)
      return { rank: result.rank, own: mainTokenAt(result.token.key) !== null, liquidity: facts.liquidityUsd, dead: emptyOf(facts) }
    }
    const facts = networkFacts(entry.network)
    return { rank: hitRank(entry.network.token.symbol, query), own: entry.network.own === true, liquidity: facts.liquidityUsd, dead: emptyOf(facts) }
  }
  const { groups, entries: merged } = groupedHits(rankedMerged, home, excluded, standing, rankedPreselectAt < 0 ? undefined : rankedMerged[rankedPreselectAt])
  // QA round 2, N30: where two listed addresses would read alike in short ("0x5fc5…d168"), both keep more characters.
  const prefixes = shortPrefixes(merged.map((entry) => ('home' in entry ? (entry.home.kind === 'known' ? entry.home.token.key : entry.home.wire) : entry.network.token.address)))
  const prefixOf = (address: string) => prefixes.get(address.toLowerCase())
  const total = merged.length
  const preselectAt = rankedPreselectAt < 0 ? -1 : merged.indexOf(rankedMerged[rankedPreselectAt])
  // Changed on purpose 2026-10-06 (review of the same day): the hit moved to is kept by its option, not its place, so a
  // network's answer arriving above it never moves the highlight, nor Enter's choice, to another token.
  const highlighted = total === 0 ? -1 : active === null ? preselectAt : merged.findIndex((entry) => entryId(entry) === active)
  const highlightedEntry = highlighted < 0 ? undefined : merged[highlighted]
  const highlightedId = highlightedEntry === undefined ? undefined : entryId(highlightedEntry)
  useEffect(() => {
    if (expanded && active !== null && highlightedId) document.getElementById(highlightedId)?.scrollIntoView({ block: 'nearest' })
  }, [expanded, active, highlightedId])
  // The row pointed at while the list is open: New position asks its pool hints now (speed wave, 2026-09-28).
  const pointed = expanded && highlightedEntry !== undefined && 'home' in highlightedEntry ? keyOf(highlightedEntry.home) : null
  useEffect(() => {
    if (pointed) point.current?.(pointed)
  }, [pointed])
  // Still being searched (2026-10-06): the stored search for this text, a pasted address on Robinhood Chain, or another
  // network. The icon pulses meanwhile, and an empty list says so instead of "no token".
  const storedWanted = searchable(query) && !!source.supportsStoredReads && !!source.routeEnabled
  const lookingUp =
    expanded &&
    ((storedWanted && answered === null && settled !== query) ||
      (pasteKey !== null && homePaste?.key !== pasteKey) ||
      (othersSearch?.pending(query) ?? false))
  const unavailableNetworks = othersSearch?.unavailable?.(query) ?? []

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
          setActive(entryId(merged[Math.min(highlighted + 1, total - 1)]))
        }
        return
      case 'ArrowUp':
        event.preventDefault()
        if (expanded && total > 0) setActive(entryId(merged[Math.max(highlighted - 1, 0)]))
        return
      case 'Enter': {
        event.preventDefault()
        if (expanded && highlightedEntry !== undefined) {
          if ('home' in highlightedEntry) choose(highlightedEntry.home)
          else chooseOther(highlightedEntry.network)
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
      <div className="dm-flow-combo" aria-busy={busy || undefined} data-searching={lookingUp ? '' : undefined}>
        <IconSearch size={16} className={cx('dm-flow-combo-icon', (busy || lookingUp) && 'animate-pulse-soft')} />
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
          placeholder={placeholder ?? (others ? SEARCH_EVERY_NETWORK : SEARCH_PLACEHOLDER)}
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
            {expanded && merged.map((entry, index) => {
              const current = index === highlighted
              const group = groups.find(group => group.entries[0] === entry)
              const heading = group && (groups.length > 1 || group.key === 'unavailable') ? <div className="dm-v3-token-group" data-token-group={group.key} aria-hidden="true">{group.label}</div> : null
              if ('home' in entry) {
                const result = entry.home
                const key = keyOf(result)
                const disabled = excluded(result)
                return (
                  <Fragment key={key}>
                    {heading}
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
                      onMouseEnter={() => setActive(optionId(result))}
                      onClick={() => choose(result)}
                      className={cx('dm-flow-hit', disabled && 'dm-flow-hit--off')}
                    >
                      {/* QA round 2, N1: the token Domino uses (its ETH, WETH, USDG) is never "Same name as another token". */}
                      {result.kind === 'known' ? <KnownRow token={result.token} twin={twins.has(result.token.key) && mainTokenAt(result.token.key) === null} prefix={prefixOf(result.token.key)} /> : <AddressRow wire={result.wire} prefix={prefixOf(result.wire)} />}
                      {disabled && !warned(result) && <span className="dm-flow-hit-meta shrink-0">{ALREADY_CHOSEN}</span>}
                      {home !== undefined && <NetworkTag chainId={4663} name={home} />}
                    </button>
                  </Fragment>
                )
              }
              const row = entry.network
              return (
                <Fragment key={`${row.chainId}:${row.token.address}`}>
                  {heading}
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
                    onMouseEnter={() => setActive(networkOptionId(row))}
                    onClick={() => chooseOther(row)}
                    className={cx('dm-flow-hit', row.warning !== undefined && 'dm-flow-hit--off')}
                  >
                    <NetworkRow row={row} prefix={prefixOf(row.token.address)} />
                  </button>
                </Fragment>
              )
            })}
          </div>
          {/* Changed on purpose 2026-10-06: never "no token" while a search is still out; an address no network names says so. */}
          {expanded && total === 0 && (lookingUp || unavailableNetworks.length === 0) && (
            <p className="dm-flow-listbox-empty" data-searching={lookingUp ? '' : undefined}>
              {lookingUp ? SEARCHING : home !== undefined && WHOLE_ADDRESS.test(query) ? NO_TOKEN_AT : NO_MATCH}
            </p>
          )}
          {/* Changed on purpose 2026-10-30 (QA round 2 review, the owner's rule: no "unavailable" line on a read surface): a
              network whose search did not answer, after its own quiet re-asks (v2in/journey/model/networkSearch.ts), no
              longer says "Base search is unavailable right now." / "Token data on Base is unavailable right now."; the
              list says what it found (a name: the usual line; an address: never "no token"), the networks kept as data. */}
          {expanded && total === 0 && !lookingUp && unavailableNetworks.length > 0 && (
            <p className="dm-flow-listbox-empty" data-search-unavailable={unavailableNetworks.join(',')}>
              {WHOLE_ADDRESS.test(query) ? NOTHING_AT : NO_MATCH}
            </p>
          )}
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
