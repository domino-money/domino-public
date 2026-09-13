import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { unreadToken } from '../../../lib/read/project'
import { ADDRESS_PROBLEM, failureText } from '../../../lib/read/screens/copy'
import { parseAddressInput, screenPaste, shortAddress, type AddressKey } from '../../../lib/read/screens/identity'
import { readWithin } from '../../../lib/read/screens/screenRead'
import { searchTokens, type KnownToken, type SearchResult } from '../../../lib/read/screens/tokenSearch'
import { candidateFromToken, selectable, type TokenCandidate } from '../../../lib/read/screens/tokens'
import type { ReadSource, TokenDisplay } from '../../../lib/read/types'
import { IconSearch } from '../../icons'
import { TokenMark } from '../../TokenIcon'
import { cx } from '../../ui'
import { Address } from './Address'
import { ScreenStatus, type StatusLine } from './ScreenStatus'

const HINT = 'Names come from the selected pools, a wallet listing and tokens already read. A token is always its contract address, read from chain.'
const NO_MATCH = 'No known token has that name. Paste its contract address to read it from chain.'
const SOURCE_NOTE = { catalogue: 'Selected pool token', wallet: 'In a listed wallet', read: 'Read from chain' } as const
const LISTBOX_LABEL = 'Matching tokens'
const UNNAMED = 'Unnamed token'
const READ_ADDRESS = 'Read this address from chain'
const ALREADY_CHOSEN = 'Already chosen'
const reading = (name: string) => `Reading ${name} from chain…`
const readAt = (block: number) => `Read at block ${block}.`

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

function KnownRow({ token }: { token: KnownToken }) {
  const notes = token.sources.map((source) => (source === 'wallet' && token.balanceText !== null ? `${SOURCE_NOTE.wallet} · ${token.balanceText}` : SOURCE_NOTE[source]))
  return (
    <>
      <TokenMark token={displayOf(token)} size={28} />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="dm-flow-hit-name">
          {token.label === null ? <span className="text-fg-subtle">{UNNAMED}</span> : <bdi className="inline-block max-w-[24ch] truncate align-bottom">{token.label}</bdi>}
        </span>
        <span className="dm-flow-hit-meta">
          <Address value={token.key} short />
          <span aria-hidden="true"> · </span>
          <span className="tnum">{notes.join(' · ')}</span>
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
  const [line, setLine] = useState<StatusLine | null>(null)
  const [busy, setBusy] = useState(false)
  const [choice, setChoice] = useState<{ wire: string; name: string } | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const running = useRef<AbortController | null>(null)
  // The latest callback, so the outcome of a read reaches the caller as it is now.
  const found = useRef(onFound)
  useEffect(() => {
    found.current = onFound
  }, [onFound])
  useEffect(() => () => running.current?.abort(), [])
  useEffect(() => {
    if (autoFocus) input.current?.focus()
  }, [autoFocus])

  const results = searchTokens(value, known)
  const expanded = open && problem === null
  const highlighted = results.length === 0 ? -1 : Math.min(active, results.length - 1)
  const listboxId = `${id}-listbox`
  const optionId = (result: SearchResult) => `${id}-option-${keyOf(result)}`
  const excluded = (result: SearchResult) => exclude !== null && keyOf(result) === exclude

  const read = (wire: string, name: string) => {
    running.current?.abort()
    const mine = new AbortController()
    running.current = mine
    setBusy(true)
    setLine({ code: 'loading', title: reading(name), detail: '' })
    void readWithin(source, 'token', { token: wire }, { signal: mine.signal }).then((outcome) => {
      if (mine.signal.aborted) return
      setBusy(false)
      if (outcome.state === 'ok') {
        found.current(candidateFromToken(outcome.data, wire))
        setLine({ code: 'ok', title: readAt(outcome.data.snapshot.number), detail: '' })
      } else if (outcome.state !== 'aborted') {
        setLine(failureText(outcome, 'token'))
      }
    })
  }

  const choose = (result: SearchResult) => {
    if (excluded(result)) return
    setOpen(false)
    setProblem(null)
    if (result.kind === 'address') {
      const name = shortAddress(result.wire)
      setValue(result.wire)
      setChoice({ wire: result.wire, name })
      read(result.wire, name)
      return
    }
    const name = nameOf(result.token)
    setValue(name)
    const candidate = result.token.candidate
    if (candidate && selectable(candidate)) {
      // Already read, or listed with its balance: nothing to ask the chain again.
      running.current?.abort()
      setBusy(false)
      setChoice(null)
      setLine(null)
      found.current(candidate)
      return
    }
    setChoice({ wire: result.token.wire, name })
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
      <div className="dm-flow-combo">
        <IconSearch size={14} className="dm-flow-combo-icon" />
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
          aria-describedby={problem ? `${id}-hint ${id}-error` : `${id}-hint`}
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
      <p id={`${id}-hint`} className="dm-hint">
        {HINT}
      </p>
      {problem && (
        <p id={`${id}-error`} role="alert" className="dm-error">
          {problem}
        </p>
      )}
      <div data-token-search-status={line?.code ?? 'none'}>
        <ScreenStatus line={line} busy={busy} onRetry={choice ? () => read(choice.wire, choice.name) : undefined} className="mt-2" />
      </div>
    </div>
  )
}
