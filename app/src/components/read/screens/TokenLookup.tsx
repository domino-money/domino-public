import { useEffect, useRef, useState, type ReactNode } from 'react'
import { COPY, failureText } from '../../../lib/read/screens/copy'
import { readWithin } from '../../../lib/read/screens/screenRead'
import { candidateFromToken, selectable, type TokenCandidate } from '../../../lib/read/screens/tokens'
import type { ReadSource } from '../../../lib/read/types'
import { TokenMark } from '../../TokenIcon'
import { Button, Card, Pill, Skeleton } from '../../ui'
import { Address } from './Address'
import { CopyButton } from './CopyButton'
import { ScreenStatus, type StatusLine } from './ScreenStatus'
import { SymbolText } from './SymbolText'
import { whyText } from './TokenPicker'

const KIND = { native: 'Native ETH', erc20_candidate: 'ERC-20 token', unknown: 'Unknown token' } as const

type Lookup = { kind: 'loading' } | { kind: 'ok'; candidate: TokenCandidate } | { kind: 'failed'; line: StatusLine }

/**
 * One token read for an address exactly as it was written, and what it said.
 * A new address cancels the read in flight and shows nothing from it; a
 * failed read offers Retry, which is one more read of the same address.
 * The card is the token as its contract described it: symbol as text, kind,
 * decimals and the block it was read at. Nothing here is a price.
 */
export function TokenLookup({ source, wire, onFound, actions }: {
  source: ReadSource
  /** The address to read, sent as written. Only a caller that validated it hands one over. */
  wire: string
  onFound?: (candidate: TokenCandidate) => void
  /** What a person can do with the token once it has been read. */
  actions?: (candidate: TokenCandidate) => ReactNode
}) {
  const [state, setState] = useState<{ wire: string; lookup: Lookup } | null>(null)
  const [attempt, setAttempt] = useState(0)
  // The latest callback, so a caller's inline function never restarts the read.
  const found = useRef(onFound)
  useEffect(() => {
    found.current = onFound
  }, [onFound])

  useEffect(() => {
    const controller = new AbortController()
    void readWithin(source, 'token', { token: wire }, { signal: controller.signal }).then((outcome) => {
      if (controller.signal.aborted || outcome.state === 'aborted') return
      if (outcome.state === 'ok') {
        const candidate = candidateFromToken(outcome.data, wire)
        setState({ wire, lookup: { kind: 'ok', candidate } })
        found.current?.(candidate)
      } else {
        setState({ wire, lookup: { kind: 'failed', line: failureText(outcome, 'token') } })
      }
    })
    return () => controller.abort()
  }, [source, wire, attempt])

  const lookup: Lookup = state?.wire === wire ? state.lookup : { kind: 'loading' }

  if (lookup.kind === 'loading') {
    return (
      <Card className="dm-mkt-lookup" data-token-lookup="loading">
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
    return (
      <div data-token-lookup="failed">
        <ScreenStatus line={lookup.line} onRetry={() => setAttempt((n) => n + 1)} />
      </div>
    )
  }
  const { candidate } = lookup
  const why = whyText(candidate)
  const usable = selectable(candidate)
  return (
    <Card className="dm-mkt-lookup" data-token-lookup="ok" data-token-card={candidate.kind}>
      <div className="dm-mkt-lookup-token">
        <TokenMark token={candidate.token} size={40} ring="var(--surface-2)" />
        <div className="min-w-0">
          <div className="dm-mkt-lookup-name">
            <span className="dm-mkt-lookup-symbol"><SymbolText token={candidate.token} /></span>
            {usable ? <span className="dm-chip">{KIND[candidate.kind]}</span> : <Pill tone="out" dot>{KIND[candidate.kind]}</Pill>}
            {candidate.decimalsUnavailable && usable && <Pill tone="wait">{COPY.selection.decimalsUnavailable}</Pill>}
            <span className="dm-mkt-lookup-meta">
              {candidate.token.decimals !== null && <span className="tnum">{candidate.token.decimals} decimals · </span>}
              {candidate.block !== null && <span className="tnum">Read at block {candidate.block}</span>}
            </span>
          </div>
          <p className="dm-mkt-lookup-address">
            <span title={candidate.key}><Address value={candidate.key} short /></span>
            <CopyButton value={candidate.key} label="Copy token address" />
            <span>· Robinhood Chain</span>
          </p>
          {why && <p className="dm-mkt-lookup-why">{why}</p>}
        </div>
      </div>
      {actions && usable && <div className="dm-mkt-lookup-actions">{actions(candidate)}</div>}
      {!usable && (
        <Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
          Read again
        </Button>
      )}
    </Card>
  )
}
