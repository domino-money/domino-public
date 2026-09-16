import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { unreadToken } from '../../../lib/read/project'
import { ADDRESS_PROBLEM, failureText } from '../../../lib/read/screens/copy'
import { parseAddressInput, screenPaste, shortAddress, type AddressKey } from '../../../lib/read/screens/identity'
import { failureCode, quietTitle, reaskDelayMs, whenVisibleAfter } from '../../../lib/read/screens/quietRead'
import { readWithin } from '../../../lib/read/screens/screenRead'
import { searchTokens, type KnownToken, type SearchResult } from '../../../lib/read/screens/tokenSearch'
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

/** What is wrong with typed text that is an address attempt, once it is long enough to judge. */
function typedProblem(value: string): string | null {
  const trimmed = value.trim()
  if (!/^0[xX]/.test(trimmed)) return null
  const parsed = parseAddressInput(trimmed)
  if (parsed.ok) return null
  if (parsed.reason === 'length' && trimmed.length < 42) return null
  return ADDRESS_PROBLEM[parsed.reason]
}

/** A known token as a hit: its name and address, and a listed wallet's balance when there is one. Where the app knows it from is a data attribute only. */
function KnownRow({ token }: { token: KnownToken }) {
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
        </span>
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
}) {
  const [value, setValue] = useState(initialValue ?? '')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [problem, setProblem] = useState<string | null>(() => typedProblem(initialValue ?? ''))
  const [said, setSaid] = useState<Said | null>(null)
  const [failed, setFailed] = useState<{ code: string; reason: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const running = useRef<AbortController | null>(null)
  // A quiet re-ask waiting for its time, cancelled by any newer choice.
  const quiet = useRef<(() => void) | null>(null)
  // The latest callback, so the outcome of a read reaches the caller as it is now.
  const found = useRef(onFound)
  useEffect(() => {
    found.current = onFound
  }, [onFound])
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

  const results = searchTokens(value, known)
  const expanded = open && problem === null
  const highlighted = results.length === 0 ? -1 : Math.min(active, results.length - 1)
  const listboxId = `${id}-listbox`
  const optionId = (result: SearchResult) => `${id}-option-${keyOf(result)}`
  const excluded = (result: SearchResult) => exclude !== null && keyOf(result) === exclude

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
        found.current(candidateFromToken(outcome.data, wire))
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
      setBusy(false)
      setFailed({ code: failureCode(outcome), reason: quietTitle(outcome, 'token') })
      setSaid({ code: text.code, words: text.title })
    })
  }

  const choose = (result: SearchResult) => {
    if (excluded(result)) return
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
    const candidate = result.token.candidate
    if (candidate && selectable(candidate)) {
      // Already read, or listed with its balance: nothing to ask the chain again.
      stop()
      setBusy(false)
      setFailed(null)
      setSaid(null)
      found.current(candidate)
      return
    }
    read(result.token.wire, name)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        if (!open) {
          setOpen(true)
          setActive(0)
        } else if (results.length > 0) {
          setActive(Math.min(highlighted + 1, results.length - 1))
        }
        return
      case 'ArrowUp':
        event.preventDefault()
        if (expanded && results.length > 0) setActive(Math.max(highlighted - 1, 0))
        return
      case 'Enter': {
        event.preventDefault()
        if (expanded && highlighted >= 0) {
          choose(results[highlighted])
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
        <IconSearch size={14} className={cx('dm-flow-combo-icon', busy && 'animate-pulse-soft')} />
        <input
          ref={input}
          id={id}
          type="text"
          role="combobox"
          aria-expanded={expanded}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={expanded && highlighted >= 0 ? optionId(results[highlighted]) : undefined}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${id}-error` : undefined}
          value={value}
          onChange={(event) => {
            setValue(event.target.value)
            setOpen(true)
            setActive(0)
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
          <div id={listboxId} role="listbox" aria-label={LISTBOX_LABEL} className="dm-flow-listbox-scroll">
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
                    {result.kind === 'known' ? <KnownRow token={result.token} /> : <AddressRow wire={result.wire} />}
                    {disabled && <span className="dm-flow-hit-meta shrink-0">{ALREADY_CHOSEN}</span>}
                  </button>
                )
              })}
          </div>
          {expanded && results.length === 0 && <p className="dm-flow-listbox-empty">{NO_MATCH}</p>}
        </div>
      </div>
      {problem && (
        <p id={`${id}-error`} role="alert" className="dm-error">
          {problem}
        </p>
      )}
      {failed && !busy && (
        <p className="dm-hint" data-token-search-failed={failed.code} title={failed.reason}>
          {NOT_READ}
        </p>
      )}
      <p role="status" aria-live="polite" className="sr-only" data-token-search-status={said?.code ?? 'none'}>
        {said?.words}
      </p>
    </div>
  )
}
