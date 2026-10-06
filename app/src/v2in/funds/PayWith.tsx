import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { SymbolText } from '../../components/read/screens/SymbolText'
import { TokenMark } from '../../components/TokenIcon'
import type { TokenDisplay } from '../../lib/read/types'
import { FUNDS_TEXT } from './copy'

/**
 * One discreet line where the offer would be (Added 2026-10-06): a token's mark, a few words with a quieter part after them,
 * and the action at the end. The look of the offer's own line (./BringFunds.tsx DiscreetLine, "You have … on Base · about
 * $… · Bring it here"), moved here unchanged so "Pay with … instead" (`PayLine`) is that very line.
 */
export function FundsLine({ mark, text, extra, action, ...button }: { mark: ReactNode; text: ReactNode; extra: ReactNode; action?: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className="dm-funds-line" {...button}>
      <span className="dm-funds-line-mark" aria-hidden="true">
        {mark}
      </span>
      <span className="dm-funds-line-text">
        {text}
        {extra && <span className="dm-funds-line-usd">{extra}</span>}
      </span>
      <span className="dm-funds-line-action">{action}</span>
    </button>
  )
}

/**
 * Added 2026-10-06 (the owner, on production's New position: AI/PONS and CASHCAT/AI short on Robinhood Chain, and no offer
 * at all, since neither token is one a deposit from another network delivers): paying with ONE other token, the network's
 * ETH or its stable, which Domino V2's zap swaps for the pool's two (position-plan-v1: "exactly one other token"; the zap
 * path's "Pay with: Another token"), offered in the owner's amount step where the offer to bring a token would be: one
 * discreet line ("Pay with ETH instead · Domino swaps it for AI and PONS"), one action (./FundsAmounts.tsx draws it first,
 * outside the offer's own card, so it never depends on it). Chosen, the step draws that token's one panel itself, with
 * the way back (components/create/PairedAmounts.tsx; Changed on purpose 2026-10-06, the review: the panel and its way
 * back no longer depend on this chunk).
 * Changed on purpose 2026-10-06 (the review: a 50-character symbol pushed the line out of a phone's width): the pool's
 * symbols are drawn as every read symbol is (SymbolText: isolated, cut at 24 characters with "…").
 */
export function PayLine({ token, pair, onPay }: { token: TokenDisplay; pair: readonly [TokenDisplay, TokenDisplay]; onPay: () => void }) {
  return (
    <FundsLine
      onClick={onPay}
      data-pay-with={token.address}
      mark={<TokenMark token={token} size={20} />}
      text={FUNDS_TEXT.payInstead(token.symbol ?? '')}
      extra={
        <>
          {' · '}
          {FUNDS_TEXT.paySwaps} <SymbolText token={pair[0]} /> {FUNDS_TEXT.and} <SymbolText token={pair[1]} />
        </>
      }
    />
  )
}
