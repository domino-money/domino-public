import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { SymbolText } from '../../components/read/screens/SymbolText'
import { TokenMark } from '../../components/TokenIcon'
import type { TokenDisplay } from '../../lib/read/types'
import type { PayOption } from '../../lib/create/poolPrices'
import { originName } from './model'

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
        {text}{' '}
        {extra && <span className="dm-funds-line-usd">{extra}</span>}
      </span>
      <span className="dm-funds-line-action">{action}</span>
    </button>
  )
}

/** One discoverable payment action, naming actual wallet funds; quote availability is confirmed in Review. */
export function PayLine({ facts, pair, onPay }: { facts: PayOption; pair: readonly [TokenDisplay, TokenDisplay]; onPay: () => void }) {
  const { token } = facts
  const remote = (facts.raw === null || facts.raw === 0n) && !!facts.origins?.length
  return (
    <FundsLine
      className="dm-funds-line dm-funds-payment"
      onClick={onPay}
      data-pay-with={token.address}
      mark={<TokenMark token={token} size={20} />}
      text={<strong>{remote ? <>You have funds on {facts.origins!.map(originName).join(' and ')}</> : <>Use your <SymbolText token={token} /> on {originName(token.chainId)}</>}</strong>}
      extra={
        <>
          We’ll check {remote ? 'a transfer and conversion' : 'a conversion'} into <SymbolText token={pair[0]} /> and <SymbolText token={pair[1]} />.
        </>
      }
      action={remote ? 'Check options' : <>Use <SymbolText token={token} /></>}
    />
  )
}
