import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent } from 'react'
import { reasonText } from '../../../lib/read/describe'
import { ADDRESS_PROBLEM, COPY, failureText } from '../../../lib/read/screens/copy'
import { parseAddressInput, screenPaste, searchByAddress, type AddressKey } from '../../../lib/read/screens/identity'
import { readWithin } from '../../../lib/read/screens/screenRead'
import { candidateFromToken, excluding, mergeCandidates, selectable, type TokenCandidate } from '../../../lib/read/screens/tokens'
import type { ReadSource } from '../../../lib/read/types'
import { TokenMark } from '../../TokenIcon'
import { Button } from '../../ui'
import { Address } from './Address'
import { ScreenStatus, type StatusLine } from './ScreenStatus'
import { SymbolText } from './SymbolText'
import { WalletCandidates } from './WalletCandidates'

const KIND = { native: 'Native currency', erc20_candidate: 'ERC-20 candidate', unknown: 'Unknown' } as const

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
function PasteForm({ source, onFound }: { source: ReadSource; onFound: (candidate: TokenCandidate) => void }) {
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
    <form onSubmit={submit} className="grid gap-2" noValidate>
      <label htmlFor="token-address" className="text-[13px] text-fg-muted">
        {COPY.picker.pasteLabel}
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id="token-address"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onPaste={paste}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? 'token-address-hint token-address-error' : 'token-address-hint'}
          className="min-w-0 flex-1 rounded-[var(--radius)] border bg-surface-1 px-3 py-2 font-mono text-[13px] outline-none focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
        />
        <Button type="submit" variant="outline" aria-disabled={busy ? true : undefined}>
          {busy ? COPY.picker.checking : COPY.picker.check}
        </Button>
      </div>
      <p id="token-address-hint" className="text-[11px] text-fg-subtle">
        {COPY.picker.pasteHint}
      </p>
      {problem && (
        <p id="token-address-error" role="alert" className="text-[12px]" style={{ color: 'var(--money-out)' }}>
          {problem}
        </p>
      )}
      <ScreenStatus line={line} />
    </form>
  )
}

function CandidateRow({ candidate, name, checked, onPick, index }: { candidate: TokenCandidate; name: string; checked: boolean; onPick: () => void; index: number }) {
  const why = whyText(candidate)
  const whyId = `${name}-why-${index}`
  return (
    <li className="rounded-[var(--radius)] border bg-surface-1 px-3 py-2.5" data-candidate={candidate.kind} {...(candidate.why ? { 'data-not-selectable': candidate.why } : {})}>
      <label className="flex cursor-pointer items-start gap-3">
        <input type="radio" name={name} checked={checked} disabled={!selectable(candidate)} onChange={onPick} aria-describedby={why ? whyId : undefined} className="mt-1 h-4 w-4 shrink-0 accent-[var(--primary)]" />
        <TokenMark token={candidate.token} size={22} />
        <span className="grid min-w-0 gap-0.5">
          <span className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
            <span className="font-medium">
              <SymbolText token={candidate.token} />
            </span>
            <span className="text-[11px] text-fg-subtle">{KIND[candidate.kind]}</span>
            {candidate.decimalsUnavailable && candidate.why === null && <span className="text-[11px] text-money-wait">{COPY.selection.decimalsUnavailable}</span>}
            {candidate.old && <span className="text-[11px] text-fg-subtle">{COPY.picker.fromEarlier}</span>}
          </span>
          <Address value={candidate.key} />
          {candidate.balance && candidate.why === null && (
            <span className="text-[12px] text-fg-muted">
              Balance at the snapshot block: <span className="tnum font-mono">{candidate.balance.text}</span>
              {candidate.page !== null && <span className="text-fg-subtle"> · page {candidate.page}</span>}
            </span>
          )}
        </span>
      </label>
      {why && (
        <p id={whyId} className="ml-7 mt-1 text-[12px] text-fg-subtle">
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
}: {
  source: ReadSource
  variant: 'token' | 'pair'
  exclude: AddressKey | null
  candidates: TokenCandidate[]
  onCandidates: (next: TokenCandidate[]) => void
  pending: TokenCandidate | null
  onPending: (candidate: TokenCandidate | null) => void
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
    <div className="grid gap-4" data-picker={variant}>
      <div className="grid gap-1.5 text-[12px] leading-relaxed text-fg-muted">
        {variant === 'pair' && <p>{COPY.picker.secondNote}</p>}
        <p>{COPY.picker.nativeNote}</p>
      </div>
      <PasteForm source={source} onFound={(candidate) => add([candidate])} />
      <WalletCandidates source={source} onRows={(incoming) => add(incoming.map((row) => ({ ...row })))} />
      {rows.length > 0 && (
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-[13px] font-medium">{COPY.picker.candidates}</legend>
          <label htmlFor={`${variant}-filter`} className="text-[12px] text-fg-muted">
            {COPY.picker.filterLabel}
          </label>
          <input
            id={`${variant}-filter`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            aria-describedby={`${variant}-filter-hint`}
            className="rounded-[var(--radius)] border bg-surface-1 px-3 py-1.5 font-mono text-[12px] outline-none focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
          />
          <p id={`${variant}-filter-hint`} className="text-[11px] text-fg-subtle">
            {COPY.picker.filterHint}
          </p>
          {visible.length === 0 && <p className="text-[12px] text-fg-subtle">{COPY.picker.noMatch}</p>}
          <ul className="grid gap-2">
            {visible.map((candidate, i) => (
              <CandidateRow key={candidate.key} candidate={candidate} name={name} index={i} checked={pending?.key === candidate.key} onPick={() => onPending(candidate)} />
            ))}
          </ul>
          {hiddenPending && (
            <p className="text-[12px] text-fg-muted" data-selected-hidden="">
              {COPY.picker.selectedHidden} <SymbolText token={hiddenPending.token} /> <Address value={hiddenPending.key} />
            </p>
          )}
        </fieldset>
      )}
    </div>
  )
}
