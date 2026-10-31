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
 * amounts are token rows with their marks. Changed on purpose 2026-10-06 (the owner's point 4: no 18-digit amounts):
 * each amount at most 6 decimals, every digit in its row's title (FeeCharged's exact amount included, spec L1024); the
 * fee rounded up, never shown lower than it is, and what was paid in rounded up as the review's "You put in" (the review
 * of point 4, money #3: one figure for one amount in the same dialog). Changed on purpose 2026-10-14 (incident C1; the
 * owner's decision D0): the state that leads is "Confirmed" once the transaction is in a block with success, and it stays
 * that word when the block is final (./copy.ts wallet.included and wallet.finalized); it was "Included", then "Finalized"
 * some 16 minutes later. Finality is a line in Receipts' Details (../lists/words.ts); data-position-receipt-state keeps
 * saying the state itself.
 */
export function ZapReceiptView({ chainId, view, book, signed = 1 }: { chainId: V2ChainId; view: ReceiptView; book: TokenBook; signed?: number }) {
  const read = view.read
  const amount = (token: Address, raw: bigint) => <Rows chainId={chainId} book={book} items={[{ token, amount: raw }]} size="sm" />
  const landed = view.state === 'finalized' || view.state === 'included'
  return (
    <div className="dm-pa-field" data-position-receipt={view.state}>
      <SheetStatus state={landed ? 'done' : 'busy'} data-position-receipt-state={view.state}>
        {landed && <Laid count={signed} />}
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
      // Rounded up, as the review's "You put in" and the wallet's "Allow" are: one figure for one amount (2026-10-06).
      return (
        <SheetFact label={COPY.receipt.paidIn} data-position-receipt-line="paid-in">
          <Rows chainId={chainId} book={book} items={[{ token: line.token, amount: line.amount }]} size="sm" round="up" />
        </SheetFact>
      )
    case 'swapped':
      return (
        <SheetFact label={COPY.receipt.swapped} data-position-receipt-line="swapped">
          <span>
            <Amount chainId={chainId} book={book} token={line.tokenIn} raw={line.amountIn} /> → <Amount chainId={chainId} book={book} token={line.tokenOut} raw={line.amountOut} />
          </span>
        </SheetFact>
      )
    case 'fee':
      // Rounded up where it is drawn, as the review's fee line is: a fee is never shown lower than it is (2026-10-06).
      return (
        <SheetFact label={COPY.receipt.fee} data-position-receipt-line="fee" data-position-receipt-fee={line.amount.toString()}>
          <Rows chainId={chainId} book={book} items={[{ token: line.token, amount: line.amount }]} size="sm" round="up" />
        </SheetFact>
      )
    case 'position': {
      const label = line.step === 'added' ? COPY.receipt.added : line.step === 'removed' ? COPY.receipt.removed : COPY.receipt.collected
      return (
        <SheetFact label={label} data-position-receipt-line={`position-${line.step}`}>
          <Rows chainId={chainId} book={book} items={line.amounts} size="sm" />
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

/**
 * A direct (Uniswap) exit's receipt: what Uniswap paid, from the receipt's own logs (native ETH on v4 leaves none). It
 * leads with "Confirmed" as the zap's receipt does (2026-10-14, incident C1).
 */
export function DirectReceiptView({ chainId, receipt, book, signed = 1 }: { chainId: V2ChainId; receipt: DirectReceipt; book: TokenBook; signed?: number }) {
  return (
    <div className="dm-pa-field" data-position-receipt={receipt.state}>
      <SheetStatus state="done" data-position-receipt-state={receipt.state}>
        <Laid count={signed} />
        {receipt.state === 'finalized' ? COPY.wallet.finalized : COPY.wallet.included}
      </SheetStatus>
      <SheetFacts>
        <SheetFact label={COPY.receipt.paidByUniswap} data-position-receipt-line="paid-by-uniswap">
          {receipt.paid.map((paid) => (
            <span key={paid.token}>
              {paid.amount === null ? <>{labelOf(book, paid.token)}: {COPY.receipt.notInLogs}</> : <Rows chainId={chainId} book={book} items={[{ token: paid.token, amount: paid.amount }]} size="sm" />}
            </span>
          ))}
        </SheetFact>
        <SheetFact label="Domino fee">{COPY.review.noFee}</SheetFact>
        <Gas gas={receipt.gas} />
      </SheetFacts>
    </div>
  )
}

/**
 * (QA round 2, review of np2 request 1) A direct action in a block with success whose logs can't be read exactly
 * (./directRun.ts): "Confirmed" leads, as on every receipt, and the Receipt line says where the details are, as the zap's
 * receipt does in the same case. Until then the sentence stood alone in a red alert under the figures sent for, with
 * nothing saying the transaction went through. `code`: why it can't be read, for data-error-code only.
 */
export function DirectReceiptUnread({ code }: { code: string }) {
  return (
    <div className="dm-pa-field" data-position-receipt="included">
      <SheetStatus state="done" data-position-receipt-state="included">
        <Laid count={1} />
        {COPY.wallet.included}
      </SheetStatus>
      <SheetFacts>
        <SheetFact label={COPY.receipt.title} data-error-code={code}>{COPY.receipt.unreadable}</SheetFact>
      </SheetFacts>
    </div>
  )
}

/** One small domino laid flat per signed step, before "Confirmed" (V4's .as-rcpt): decoration only, no text. */
function Laid({ count }: { count: number }) {
  return (
    <span className="dm-pa-laid" aria-hidden="true">
      {Array.from({ length: Math.max(1, Math.min(3, count)) }, (_, index) => <i key={index} />)}
    </span>
  )
}
