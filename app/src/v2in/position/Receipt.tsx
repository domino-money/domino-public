import type { ReactNode } from 'react'
import { SheetFact, SheetFacts, SheetStatus } from '../../components/positions/ActionSheet'
import { FigureDash } from '../../components/ui'
import type { DirectReceipt } from '../../finance/v2/direct'
import type { GasCost, ReceiptLine } from '../../finance/v2/receipt'
import { ethText } from '../../v2/plan/present'
import type { Address, V2ChainId } from '../../v2/types'
import { COPY } from './copy'
import type { ReceiptView } from './run'
import { Amount, Rows } from './ui'
import { labelOf, type TokenBook } from './tokens'

/**
 * The receipt of a zap action (spec F7 §2.11), in the dialog, from the zap's own events and matched to the plan by its
 * intentHash: "Paid in", "Swapped" leg by leg as measured, "Domino fee (0.65% of the amount swapped)" with FeeCharged's
 * exact amount, each position step, "Returned to your wallet", the new and the previous position, the network fee from
 * the receipt (Base adds its L1 data fee), and the state, "Included" then "Finalized" (a delay is never a failure). No
 * USD. Copied from the S1 reference's ReceiptDialog, drawn inside the action's own dialog as V1's are. Changed on purpose
 * 2026-10-03 (the owner, point 9): the state leads, in green with a check once the network has it, and every line's
 * amounts are token rows with their marks.
 */
export function ZapReceiptView({ chainId, view, book }: { chainId: V2ChainId; view: ReceiptView; book: TokenBook }) {
  const read = view.read
  const amount = (token: Address, raw: bigint) => <Rows chainId={chainId} book={book} items={[{ token, amount: raw }]} size="sm" maxFraction={18} />
  const landed = view.state === 'finalized' || view.state === 'included'
  return (
    <div className="dm-pa-field" data-position-receipt={view.state}>
      <SheetStatus state={landed ? 'done' : 'busy'} data-position-receipt-state={view.state}>
        {view.state === 'finalized' ? COPY.wallet.finalized : view.state === 'included' ? COPY.wallet.included : COPY.receipt.waiting}
      </SheetStatus>
      <SheetFacts>
        {read === null ? (
          <SheetFact label={COPY.receipt.title} data-error-code={view.unreadable ?? 'receipt_pending'}>{view.unreadable ? COPY.receipt.unreadable : COPY.receipt.waiting}</SheetFact>
        ) : (
          <>
            {read.lines.map((line) => <Line key={line.logIndex} line={line} amount={amount} chainId={chainId} book={book} />)}
            <SheetFact label={COPY.receipt.position} data-position-receipt-token={read.summary.tokenId.toString()}>#{read.summary.tokenId.toString()}</SheetFact>
            {read.summary.previousTokenId !== 0n && read.summary.previousTokenId !== read.summary.tokenId && (
              <SheetFact label={COPY.receipt.previous}>#{read.summary.previousTokenId.toString()}</SheetFact>
            )}
            <Gas gas={read.gas} />
          </>
        )}
      </SheetFacts>
    </div>
  )
}

function Line({ line, amount, chainId, book }: { line: ReceiptLine; amount: (token: Address, raw: bigint) => ReactNode; chainId: V2ChainId; book: TokenBook }) {
  switch (line.kind) {
    case 'paid-in':
      return <SheetFact label={COPY.receipt.paidIn} data-position-receipt-line="paid-in">{amount(line.token, line.amount)}</SheetFact>
    case 'swapped':
      return (
        <SheetFact label={COPY.receipt.swapped} data-position-receipt-line="swapped">
          <span>
            <Amount chainId={chainId} book={book} token={line.tokenIn} raw={line.amountIn} maxFraction={18} /> → <Amount chainId={chainId} book={book} token={line.tokenOut} raw={line.amountOut} maxFraction={18} />
          </span>
        </SheetFact>
      )
    case 'fee':
      return <SheetFact label={COPY.receipt.fee} data-position-receipt-line="fee" data-position-receipt-fee={line.amount.toString()}>{amount(line.token, line.amount)}</SheetFact>
    case 'position': {
      const label = line.step === 'added' ? COPY.receipt.added : line.step === 'removed' ? COPY.receipt.removed : COPY.receipt.collected
      return (
        <SheetFact label={label} data-position-receipt-line={`position-${line.step}`}>
          <Rows chainId={chainId} book={book} items={line.amounts} size="sm" maxFraction={18} />
          <span className="dm-pa-sub">#{line.tokenId.toString()} · {labelOf(book, line.pool.currency0)} / {labelOf(book, line.pool.currency1)}</span>
        </SheetFact>
      )
    }
    case 'returned':
      return <SheetFact label={COPY.receipt.returned} data-position-receipt-line="returned">{amount(line.token, line.amount)}</SheetFact>
  }
}

function Gas({ gas }: { gas: GasCost }) {
  return (
    <SheetFact label={COPY.receipt.gas} data-position-receipt-gas={gas.status}>
      {gas.status === 'available' ? <span className="tnum">{ethText(gas.totalWei)}</span> : <FigureDash reason={COPY.receipt.gasUnavailable} />}
    </SheetFact>
  )
}

/** A direct (Uniswap) exit's receipt: what Uniswap paid, from the receipt's own logs (native ETH on v4 leaves none). */
export function DirectReceiptView({ chainId, receipt, book }: { chainId: V2ChainId; receipt: DirectReceipt; book: TokenBook }) {
  return (
    <div className="dm-pa-field" data-position-receipt={receipt.state}>
      <SheetStatus state="done" data-position-receipt-state={receipt.state}>
        {receipt.state === 'finalized' ? COPY.wallet.finalized : COPY.wallet.included}
      </SheetStatus>
      <SheetFacts>
        <SheetFact label={COPY.receipt.paidByUniswap} data-position-receipt-line="paid-by-uniswap">
          {receipt.paid.map((paid) => (
            <span key={paid.token}>
              {paid.amount === null ? <>{labelOf(book, paid.token)}: {COPY.receipt.notInLogs}</> : <Rows chainId={chainId} book={book} items={[{ token: paid.token, amount: paid.amount }]} size="sm" maxFraction={18} />}
            </span>
          ))}
        </SheetFact>
        <SheetFact label="Domino fee">{COPY.review.noFee}</SheetFact>
        <Gas gas={receipt.gas} />
      </SheetFacts>
    </div>
  )
}
