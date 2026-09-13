import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent } from 'react'
import { reasonText } from '../../../lib/read/describe'
import { ADDRESS_PROBLEM, COPY, failureText } from '../../../lib/read/screens/copy'
import { parseAddressInput, screenPaste, searchByAddress, type AddressKey } from '../../../lib/read/screens/identity'
import { readWithin } from '../../../lib/read/screens/screenRead'
import { candidateFromToken, excluding, mergeCandidates, selectable, type TokenCandidate } from '../../../lib/read/screens/tokens'
import type { ReadSource } from '../../../lib/read/types'
import { IconCheck } from '../../icons'
import { TokenMark } from '../../TokenIcon'
import { Button, Chip, cx } from '../../ui'
import { Address } from './Address'
import { ScreenStatus, type StatusLine } from './ScreenStatus'
import { SymbolText } from './SymbolText'
import { WalletCandidates } from './WalletCandidates'

const KIND = { native: 'Native ETH', erc20_candidate: 'Token', unknown: 'Unknown token' } as const

export function whyText(candidate: TokenCandidate): string | null {
  switch (candidate.why) {
    case null:
      return null
    case 'no_contract':
      return COPY.picker.noContract
    case 'unreadable':
      return `${COPY.picker.notReadable} (${reasonText(candidate.reasonCode)}).`
    case 'wallet_unavailable':
      return `${COPY.picker.walletUnavailable} ${candidate.balance?.text ?? ''}`.trim()
    case 'excluded':
      return COPY.picker.sameAsFirst
    default:
      return candidate.why satisfies never
  }
}

/** A pasted address, checked exactly as typed, read once per "Check address". */
function PasteForm({ source, onFound, id }: { source: ReadSource; onFound: (candidate: TokenCandidate) => void; id: string }) {
  const [value, setValue] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [line, setLine] = useState<StatusLine | null>(null)
  const [busy, setBusy] = useState(false)
  const running = useRef<AbortController | null>(null)
  useEffect(() => () => running.current?.abort(), [])

  const paste = (event: ClipboardEvent<HTMLInputElement>) => {
    const screened = screenPaste(event.clipboardData.getData('text'))
    if (!screened.ok) {
      event.preventDefault()
      setProblem(ADDRESS_PROBLEM.line_break)
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    const parsed = parseAddressInput(value)
    if (!parsed.ok) {
      setProblem(ADDRESS_PROBLEM[parsed.reason])
      return
    }
    setProblem(null)
    running.current?.abort()
    const mine = new AbortController()
    running.current = mine
    setBusy(true)
    setLine({ code: 'loading', title: COPY.picker.checking, detail: '' })
    void readWithin(source, 'token', { token: parsed.wire }, { signal: mine.signal }).then((outcome) => {
      if (mine.signal.aborted) return
      setBusy(false)
      if (outcome.state === 'ok') {
        const candidate = candidateFromToken(outcome.data, parsed.wire)
        onFound(candidate)
        setLine({ code: 'ok', title: `Read at block ${outcome.data.snapshot.number}.`, detail: '' })
      } else if (outcome.state !== 'aborted') {
        setLine(failureText(outcome, 'token'))
      }
    })
  }

  return (
    <form onSubmit={submit} className="dm-flow-paste" noValidate>
      <label htmlFor={id} className="dm-label">
        {COPY.picker.pasteLabel}
      </label>
      <div className="dm-flow-paste-row">
        <input
          id={id}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onPaste={paste}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          placeholder="0x…"
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${id}-hint ${id}-error` : `${id}-hint`}
          className="dm-field dm-flow-mono min-w-0 flex-1"
        />
        <Button type="submit" variant="outline" className="dm-flow-paste-submit" aria-disabled={busy ? true : undefined}>
          {busy ? COPY.picker.checking : COPY.picker.check}
        </Button>
      </div>
      <p id={`${id}-hint`} className="dm-hint">
        Find a token on Robinhood Chain by its contract address.
      </p>
      {problem && (
        <p id={`${id}-error`} role="alert" className="dm-error">
          {problem}
        </p>
      )}
      <ScreenStatus line={line} className="mt-2" />
    </form>
  )
}

function CandidateRow({ candidate, name, checked, onPick, index }: { candidate: TokenCandidate; name: string; checked: boolean; onPick: () => void; index: number }) {
  const why = whyText(candidate)
  const whyId = `${name}-why-${index}`
  const choosable = selectable(candidate)
  return (
    <li className="dm-flow-candidate" data-checked={checked ? '' : undefined} data-candidate={candidate.kind} {...(candidate.why ? { 'data-not-selectable': candidate.why } : {})}>
      <label className={cx('dm-flow-candidate-main', choosable ? 'cursor-pointer' : 'cursor-not-allowed')}>
        <input type="radio" name={name} checked={checked} disabled={!choosable} onChange={onPick} aria-describedby={why ? whyId : undefined} className="shrink-0" />
        <TokenMark token={candidate.token} size={28} />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className="text-body font-medium text-fg">
              <SymbolText token={candidate.token} />
            </span>
            <span className="text-caption text-fg-subtle">{KIND[candidate.kind]}</span>
            {candidate.decimalsUnavailable && candidate.why === null && <span className="text-caption text-money-wait">{COPY.selection.decimalsUnavailable}</span>}
            {candidate.old && <span className="text-caption text-fg-subtle">{COPY.picker.fromEarlier}</span>}
          </span>
          <span className="text-caption text-fg-subtle">
            <Address value={candidate.key} short />
          </span>
          {candidate.balance && candidate.why === null && (
            <span className="text-caption text-fg-muted">
              Balance at snapshot: <span className="tnum text-fg">{candidate.balance.text}</span>
              {candidate.page !== null && <span className="text-fg-subtle"> · page {candidate.page}</span>}
            </span>
          )}
        </span>
        {checked && (
          <span aria-hidden="true" className="dm-flow-candidate-check">
            <IconCheck size={14} />
          </span>
        )}
      </label>
      <details className="dm-flow-candidate-details">
        <summary>Token details</summary>
        <div className="dm-flow-candidate-facts">
          <Address value={candidate.key} />
          <p>
            Robinhood Chain · {candidate.kind === 'native' ? 'Native currency' : candidate.kind === 'erc20_candidate' ? 'ERC-20 candidate' : 'Token type unavailable'}
            {candidate.token.decimals === null ? ' · decimals unavailable' : ` · ${candidate.token.decimals} decimals`}
          </p>
        </div>
      </details>
      {why && (
        <p id={whyId} className="dm-flow-candidate-why">
          {why}
        </p>
      )}
    </li>
  )
}

/**
 * The token picker's body: paste an address, or list a public address's
 * tokens; then choose one row. Rows are keyed and filtered by address only.
 * When the filter hides the chosen row, a "Selected" line keeps it visible.
 */
export function TokenPicker({
  source,
  variant,
  exclude,
  candidates,
  onCandidates,
  pending,
  onPending,
  initialWallet,
}: {
  source: ReadSource
  variant: 'token' | 'pair'
  exclude: AddressKey | null
  candidates: TokenCandidate[]
  onCandidates: (next: TokenCandidate[]) => void
  pending: TokenCandidate | null
  onPending: (candidate: TokenCandidate | null) => void
  /** An address to start the wallet list from, such as the header's connected wallet. */
  initialWallet?: string
}) {
  const [filter, setFilter] = useState('')
  const rows = candidates.map((candidate) => excluding(candidate, exclude))
  const visible = searchByAddress(rows, filter)
  const hiddenPending = pending && !visible.some((candidate) => candidate.key === pending.key) ? pending : null
  const name = `${variant}-candidate`

  const add = (incoming: TokenCandidate[]) => {
    const next = mergeCandidates(candidates, incoming)
    onCandidates(next)
    // A pending choice that a newer reading made unselectable is no choice at all.
    if (pending) {
      const fresh = next.find((candidate) => candidate.key === pending.key)
      if (fresh && !selectable(excluding(fresh, exclude))) onPending(null)
    }
  }

  return (
    <div className="dm-flow-picker" data-picker={variant}>
      {/* A pair picker can be open in a dialog while the token picker stays mounted beside it: its fields take their own ids. */}
      <PasteForm source={source} id={variant === 'pair' ? 'pair-address' : 'token-address'} onFound={(candidate) => add([candidate])} />
      <WalletCandidates source={source} fieldPrefix={variant === 'pair' ? 'pair-wallet' : 'wallet'} initialWallet={initialWallet} onRows={(incoming) => add(incoming.map((row) => ({ ...row })))} />
      {rows.length > 0 && (
        <fieldset className="dm-flow-candidates">
          <legend className="dm-flow-legend">
            {COPY.picker.candidates} <Chip className="ml-1">{rows.length}</Chip>
          </legend>
          <div>
            <label htmlFor={`${variant}-filter`} className="dm-label">
              {COPY.picker.filterLabel}
            </label>
            <input
              id={`${variant}-filter`}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              placeholder="Filter these tokens by address…"
              aria-describedby={`${variant}-filter-hint`}
              className="dm-field dm-flow-mono"
            />
            <p id={`${variant}-filter-hint`} className="dm-hint">
              {COPY.picker.filterHint}
            </p>
          </div>
          {visible.length === 0 && <p className="text-caption text-fg-subtle">{COPY.picker.noMatch}</p>}
          <ul className="dm-flow-candidate-list">
            {visible.map((candidate, i) => (
              <CandidateRow key={candidate.key} candidate={candidate} name={name} index={i} checked={pending?.key === candidate.key} onPick={() => onPending(candidate)} />
            ))}
          </ul>
          {hiddenPending && (
            <p className="text-caption text-fg-muted" data-selected-hidden="">
              {COPY.picker.selectedHidden} <SymbolText token={hiddenPending.token} /> <Address value={hiddenPending.key} />
            </p>
          )}
        </fieldset>
      )}
      <details className="dm-details dm-flow-note">
        <summary>About native ETH & wrapped tokens</summary>
        <p>{COPY.picker.nativeNote}</p>
      </details>
    </div>
  )
}
