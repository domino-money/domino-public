import { useEffect, useRef, useState, type ReactNode } from 'react'
import { unreadToken } from '../../../lib/read/project'
import { COPY, failureText } from '../../../lib/read/screens/copy'
import { addressKey } from '../../../lib/read/screens/identity'
import { failureCode, quietTitle, reaskDelayMs, whenVisibleAfter, type QuietFailure } from '../../../lib/read/screens/quietRead'
import { readWithin } from '../../../lib/read/screens/screenRead'
import { candidateFromToken, handoffFor, selectable, type TokenCandidate } from '../../../lib/read/screens/tokens'
import type { ReadSource } from '../../../lib/read/types'
import { TokenMark } from '../../TokenIcon'
import { Card, Pill, Skeleton } from '../../ui'
import { Address } from './Address'
import { CopyButton } from './CopyButton'
import { SymbolText } from './SymbolText'
import { whyText } from './TokenPicker'

const KIND = { native: 'Native ETH', erc20_candidate: 'ERC-20 token', unknown: 'Unknown token' } as const

/** Where and when the token was read: the token row's title, never a caption on the card. */
const readTitle = (block: number | null) => (block === null ? 'On Robinhood Chain.' : `Read at block ${block} on Robinhood Chain.`)

type Lookup = { kind: 'loading' } | { kind: 'ok'; candidate: TokenCandidate } | { kind: 'failed'; failure: QuietFailure }

/**
 * One token read for an address exactly as it was written, and what it said.
 * A new address cancels the read in flight and shows nothing from it. What a
 * token read already said about exactly this address (the search that opened
 * this view) is shown as it is, and not read again. The card is the token as
 * its contract described it: symbol as text, kind and decimals. The block it
 * was read at and the chain are the row's title and the card's data
 * attributes, never a line on it. Nothing here is a price.
 *
 * It shows no status and no Retry. A read that failed only for the moment is
 * asked again on its own, a few times, while the page is visible; a failure
 * that stays is the address with a dash for its name, the reason in the
 * card's title and data attribute, and in the live region for a screen reader.
 */
export function TokenLookup({ source, wire, initial, onFound, actions }: {
  source: ReadSource
  /** The address to read, sent as written. Only a caller that validated it hands one over. */
  wire: string
  /** What a token read already said about exactly this wire (a search's), shown instead of reading it again. */
  initial?: TokenCandidate
  onFound?: (candidate: TokenCandidate) => void
  /** What a person can do with the token once it has been read. */
  actions?: (candidate: TokenCandidate) => ReactNode
}) {
  const seeded = handoffFor(initial, wire)
  const [state, setState] = useState<{ wire: string; lookup: Lookup } | null>(() => (seeded ? { wire, lookup: { kind: 'ok', candidate: seeded } } : null))
  // The hand-off this view started from, used once: any later read of this wire reads.
  const handedOff = useRef(seeded)
  const [attempt, setAttempt] = useState(0)
  // The latest callback, so a caller's inline function never restarts the read.
  const found = useRef(onFound)
  useEffect(() => {
    found.current = onFound
  }, [onFound])

  useEffect(() => {
    const given = handedOff.current
    if (attempt === 0 && given !== null && given.wire === wire) {
      found.current?.(given)
      return
    }
    const controller = new AbortController()
    let cancelQuiet: (() => void) | null = null
    void readWithin(source, 'token', { token: wire }, { signal: controller.signal }).then((outcome) => {
      if (controller.signal.aborted || outcome.state === 'aborted') return
      if (outcome.state === 'ok') {
        const candidate = candidateFromToken(outcome.data, wire)
        setState({ wire, lookup: { kind: 'ok', candidate } })
        found.current?.(candidate)
        return
      }
      setState({ wire, lookup: { kind: 'failed', failure: outcome } })
      // Asked again on its own only while the failure can pass: attempt 0 is the view's first read.
      const wait = reaskDelayMs(outcome, attempt)
      if (wait !== null) cancelQuiet = whenVisibleAfter(wait, () => setAttempt((n) => n + 1))
    })
    return () => {
      controller.abort()
      cancelQuiet?.()
    }
  }, [source, wire, attempt])

  const lookup: Lookup = state?.wire === wire ? state.lookup : { kind: 'loading' }

  if (lookup.kind === 'loading') {
    return (
      <Card className="dm-mkt-lookup dm-lit" data-token-lookup="loading">
        <div className="dm-mkt-lookup-token">
          <Skeleton className="size-10 shrink-0 rounded-full" />
          <div className="grid flex-1 gap-2">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-56 max-w-full" />
          </div>
        </div>
        <p role="status" className="sr-only">{COPY.picker.checking}</p>
      </Card>
    )
  }
  if (lookup.kind === 'failed') {
    const key = addressKey(wire)
    const unread = unreadToken(key)
    return (
      <Card className="dm-mkt-lookup dm-lit" data-token-lookup="failed" data-token-lookup-reason={failureCode(lookup.failure)} data-token-chain={unread.chainId} title={quietTitle(lookup.failure, 'token')}>
        <div className="dm-mkt-lookup-token">
          <TokenMark token={unread} size={40} ring="var(--surface-2)" />
          <div className="min-w-0">
            <div className="dm-mkt-lookup-name">
              <span className="dm-mkt-lookup-symbol" aria-hidden="true">
                —
              </span>
            </div>
            <p className="dm-mkt-lookup-address">
              <span title={key}><Address value={key} short /></span>
              <CopyButton value={key} label="Copy token address" />
            </p>
          </div>
        </div>
        <p role="status" className="sr-only">{failureText(lookup.failure, 'token').title}</p>
      </Card>
    )
  }
  const { candidate } = lookup
  const why = whyText(candidate)
  const usable = selectable(candidate)
  // One short fact beside the kind: the decimals, or that they could not be read.
  const decimals = candidate.token.decimals !== null ? `${candidate.token.decimals} decimals` : usable ? COPY.selection.decimalsUnavailable : null
  return (
    <Card
      className="dm-mkt-lookup dm-lit"
      data-token-lookup="ok"
      data-token-card={candidate.kind}
      data-decimals={candidate.decimalsUnavailable ? 'unavailable' : undefined}
      data-token-block={candidate.block ?? undefined}
      data-token-chain={candidate.token.chainId}
    >
      <div className="dm-mkt-lookup-token" title={readTitle(candidate.block)}>
        <TokenMark token={candidate.token} size={40} ring="var(--surface-2)" />
        <div className="min-w-0">
          <div className="dm-mkt-lookup-name">
            <span className="dm-mkt-lookup-symbol"><SymbolText token={candidate.token} /></span>
            {usable ? <span className="dm-chip">{KIND[candidate.kind]}</span> : <Pill tone="out" dot>{KIND[candidate.kind]}</Pill>}
            {decimals !== null && <span className="dm-mkt-lookup-meta tnum">{decimals}</span>}
          </div>
          <p className="dm-mkt-lookup-address">
            <span title={candidate.key}><Address value={candidate.key} short /></span>
            <CopyButton value={candidate.key} label="Copy token address" />
          </p>
          {why && <p className="dm-mkt-lookup-why">{why}</p>}
        </div>
      </div>
      {actions && usable && <div className="dm-mkt-lookup-actions">{actions(candidate)}</div>}
    </Card>
  )
}
