import { useEffect, useState } from 'react'
import { CREATE } from '../../lib/create/copy'
import { validateBudget } from '../../lib/create/journey'
import { identityKey, type Fact } from '../../lib/read/project'
import { failureText, type ScreenText } from '../../lib/read/screens/copy'
import { parseAddressInput } from '../../lib/read/screens/identity'
import type { TokenCandidate } from '../../lib/read/screens/tokens'
import { createWalletSession, type WalletSnapshot } from '../../lib/read/screens/walletSession'
import type { ReadSource } from '../../lib/read/types'
import { useWalletIdentity } from '../../lib/walletIdentity'
import { SymbolText } from '../read/screens/SymbolText'
import { Button } from '../ui'

/**
 * The connected wallet's balance of the token being deposited, on the line
 * under the budget, with a "Use max" that fills the budget with it exactly.
 *
 * The wallet is known only through the published identity
 * (lib/walletIdentity.ts): an address the header's control reports, which
 * proves nothing about who controls it. A balance is public chain data at
 * one block, read through the shared read source by the same wallet session
 * the picker uses; a token that came out of a wallet listing already has
 * its balance and is not read again. Nothing here signs, approves or moves
 * anything, and no amount is ever rounded or guessed.
 */

type Outcome =
  | { kind: 'failed'; line: ScreenText }
  /** The row for this token, or the reason its balance could not be read. */
  | { kind: 'found'; fact: Fact; freshness: string[] }
  /** The page answered and named neither a balance nor a reason for this token. */
  | { kind: 'not_returned'; freshness: string[] }

/** The balance a wallet page holds for this token: its row, else its unavailable entry, else nothing. */
function outcomeOf(snapshot: WalletSnapshot, key: string): Outcome {
  if (snapshot.failure) return { kind: 'failed', line: failureText(snapshot.failure, 'wallet') }
  const wanted = identityKey(key)
  const view = snapshot.view
  const row = view.rows.find((r) => r.key.toLowerCase() === wanted || r.token.address === key)
  if (row) return { kind: 'found', fact: row.amount, freshness: view.freshness }
  const missing = view.unavailable.find((item) => item.key.toLowerCase() === wanted)
  const fact = missing?.facts[0]
  if (fact) return { kind: 'found', fact, freshness: view.freshness }
  return { kind: 'not_returned', freshness: view.freshness }
}

/** The block number of a read, from its freshness lines ("Block 123"), or null. */
function blockOf(freshness: string[]): string | null {
  const line = freshness.find((text) => text.startsWith('Block '))
  return line ? line.slice('Block '.length) : null
}

type Usable = { ok: true; text: string } | { ok: false; why: string }

/**
 * The plain decimal `validateBudget` accepts, from the balance as the wallet
 * page wrote it. A read balance in display units is `formatUnits` text: the
 * exact digits, trailing fraction zeros dropped, thousands grouped with
 * commas (lib/read/decimal.ts). Removing the commas gives back the exact
 * decimal, which `validateBudget` turns into the same raw integer the chain
 * returned. Anything else — raw units with decimals unknown, a zero, an
 * unreadable balance, digits the token's decimals cannot hold — offers no
 * button and says why. Never rounded, never trimmed.
 */
function usable(fact: Fact, decimals: number | null): Usable {
  if (fact.state === 'raw') return { ok: false, why: CREATE.amount.balanceRaw }
  if (fact.state === 'zero') return { ok: false, why: CREATE.amount.balanceZero }
  if (fact.state !== 'value') return { ok: false, why: CREATE.amount.balanceUnreadable }
  if (decimals === null) return { ok: false, why: CREATE.amount.balanceNoDecimals }
  const text = fact.text.replace(/,/g, '')
  const check = validateBudget(text, decimals)
  return check.ok ? { ok: true, text } : { ok: false, why: check.reason }
}

function Row({ fact, token, source, block, onUse }: { fact: Fact; token: TokenCandidate; source: 'listing' | 'read'; block: string | null; onUse: (decimalText: string) => void }) {
  const fill = usable(fact, token.token.decimals)
  const unavailable = fact.state === 'unavailable'
  return (
    <div className="dm-flow-balance" data-wallet-balance={fact.state} data-wallet-balance-source={source}>
      <p className="dm-flow-balance-line" title={CREATE.amount.balanceNote}>
        <span className="text-fg-subtle">{source === 'listing' ? CREATE.amount.balanceFromListing : CREATE.amount.balanceAt(block)}</span>{' '}
        <bdi className={unavailable ? 'text-fg-subtle' : 'tnum text-fg'}>{fact.text}</bdi>
        {!unavailable && (
          <>
            {' '}
            <span className="text-fg-muted">
              <SymbolText token={token.token} />
            </span>
          </>
        )}
      </p>
      {fill.ok ? (
        <Button type="button" variant="outline" size="sm" onClick={() => onUse(fill.text)} data-wallet-balance-use="">
          {CREATE.amount.maxLabel}
        </Button>
      ) : (
        <p className="dm-flow-balance-why">{fill.why}</p>
      )}
    </div>
  )
}

export function WalletBalance({ source, token, onUse }: { source: ReadSource | null; token: TokenCandidate; onUse: (decimalText: string) => void }) {
  const identity = useWalletIdentity()
  const connected = identity.kind === 'connected' ? identity.address : null
  const listed = token.source === 'wallet' && token.balance !== null
  const [attempt, setAttempt] = useState(0)
  // The read's outcome, keyed by what it was about: a result for another address, token or attempt is never shown.
  const [settled, setSettled] = useState<{ key: string; outcome: Outcome } | null>(null)
  const parsed = connected === null ? null : parseAddressInput(connected)
  const wallet = parsed?.ok ? parsed.wire : null
  const requestKey = `${wallet ?? ''}|${token.key}|${attempt}`

  // One read for this address and token, again when either changes or a
  // retry asks; the previous read is cancelled first, and leaving cancels
  // the last. A token from a wallet listing is not read again.
  useEffect(() => {
    if (!source || wallet === null || listed) return
    const controller = new AbortController()
    const key = `${wallet}|${token.key}|${attempt}`
    const session = createWalletSession(source, { wallet, tokens: [token.wire] })
    void session.first(controller.signal).then((snapshot) => {
      if (controller.signal.aborted) return
      setSettled({ key, outcome: outcomeOf(snapshot, token.key) })
    })
    return () => controller.abort()
  }, [source, wallet, token.key, token.wire, attempt, listed])

  if (connected === null) {
    return (
      <p className="dm-flow-balance-line text-fg-subtle" data-wallet-balance="disconnected">
        {CREATE.amount.connectForBalance}
      </p>
    )
  }

  if (wallet === null) {
    return (
      <p className="dm-flow-balance-line text-fg-subtle" data-wallet-balance="invalid_address">
        {CREATE.amount.balanceInvalidAddress}
      </p>
    )
  }

  if (listed && token.balance) {
    return <Row fact={token.balance} token={token} source="listing" block={null} onUse={onUse} />
  }

  if (!source) {
    return (
      <p role="status" className="dm-flow-balance-line text-fg-subtle" data-wallet-balance="waiting">
        {CREATE.amount.balanceWaiting}
      </p>
    )
  }

  const outcome = settled?.key === requestKey ? settled.outcome : null
  const retry = () => setAttempt((count) => count + 1)

  if (outcome === null) {
    return (
      <p role="status" className="dm-flow-balance-line text-fg-subtle" data-wallet-balance="loading">
        {CREATE.amount.balanceReading}
      </p>
    )
  }
  if (outcome.kind === 'failed') {
    return (
      <div role="status" className="dm-flow-balance" data-wallet-balance="failed" data-wallet-balance-code={outcome.line.code}>
        <div className="min-w-0">
          <p className="dm-flow-balance-line font-medium text-fg-muted">{outcome.line.title}</p>
          {outcome.line.detail && <p className="dm-flow-balance-why">{outcome.line.detail}</p>}
        </div>
        {outcome.line.retry && (
          <Button type="button" variant="outline" size="sm" onClick={retry}>
            {CREATE.amount.retry}
          </Button>
        )}
      </div>
    )
  }
  const block = blockOf(outcome.freshness)
  if (outcome.kind === 'not_returned') {
    return (
      <div className="dm-flow-balance" data-wallet-balance="not_returned">
        <p className="dm-flow-balance-line text-fg-subtle">{CREATE.amount.balanceNotReturned(block)}</p>
        <Button type="button" variant="outline" size="sm" onClick={retry}>
          {CREATE.amount.readAgain}
        </Button>
      </div>
    )
  }
  return <Row fact={outcome.fact} token={token} source="read" block={block} onUse={onUse} />
}
