import { useCallback, useSyncExternalStore, type ReactNode } from 'react'
import type { IndexedToken } from 'api-contracts/read-v6/types'
import { IconCheck, IconChevronDown } from '../../components/icons'
import { Pill } from '../../components/ui'
import { shortDate, shortTime } from '../../lib/format/time'
import { v2TxUrl } from '../../v2/explorers'
import { v2PositionHref } from '../route'
import { amountWords, chainName, gweiWords, tokenNamer, weiWords } from './model'
import { LOCAL_RECEIPTS, type LocalCloseReceipt } from './localReceipts'

const EMPTY: readonly LocalCloseReceipt[] = Object.freeze([])
export function useLocalReceipts(wallet: string | null) {
  const subscribe = useCallback((listener: () => void) => wallet ? LOCAL_RECEIPTS.subscribe(wallet, listener) : () => undefined, [wallet])
  const snapshot = useCallback(() => wallet ? LOCAL_RECEIPTS.get(wallet) : EMPTY, [wallet])
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY)
}

export function LocalReceiptRow({ receipt, at, tokens, children }: { receipt: LocalCloseReceipt; at: number | null; tokens: readonly IndexedToken[]; children?: ReactNode }) {
  const name = tokenNamer(tokens), count = receipt.tokenIds.length
  const href = v2TxUrl(receipt.chainId, receipt.hash)
  return <li data-local-close-receipt={receipt.hash} data-local-close-count={count}>
    <details className="dm-rcpt-row dm-rcpt-operation">
      <summary>
        <span className="dm-rcpt-what"><span className="dm-receipt-title">{receipt.state === 'finalized' && <span className="dm-receipt-check" role="img" aria-label="Confirmed"><IconCheck size={14} /></span>}<span>{count === 1 ? 'Position closed' : `${count} positions closed`}</span></span>
          {receipt.state === 'included' && <Pill tone="neutral" className="dm-receipt-exception">Confirming</Pill>}
          <span className="dm-activity-time">{at === null ? 'Date unavailable' : <time dateTime={new Date(at * 1000).toISOString()}>{shortDate(at)} {shortTime(at)}</time>}</span>
        </span><span className="dm-rcpt-amount" /><IconChevronDown size={16} className="dm-rcpt-chevron" />
      </summary>
      <div className="dm-rcpt-detail">
        <dl className="dm-rcpt-facts">
          <div><dt>Positions</dt><dd>{receipt.tokenIds.map((id, index) => <span key={id}>{index > 0 && ' · '}<a href={v2PositionHref({ chainId: receipt.chainId, dex: receipt.dex, tokenId: BigInt(id) })}>#{id}</a></span>)}</dd></div>
          {receipt.amounts.map((entry) => <div key={entry.token} data-local-close-token={entry.token}><dt>Returned to your wallet</dt><dd>{entry.amount === null ? `${name(receipt.chainId, entry.token).label}: amount not reported` : amountWords(entry.amount, name(receipt.chainId, entry.token))}</dd></div>)}
          <div><dt>Domino fee</dt><dd>No Domino fee</dd></div>
        </dl>
        {children}
        <p className="dm-rcpt-note">Transaction checked in this browser. This receipt is saved on this device. Token amounts cover the whole transaction.</p>
        <dl className="dm-rcpt-tech">
          <div><dt>Network</dt><dd>{chainName(receipt.chainId)}</dd></div>
          <div><dt>Status</dt><dd>{receipt.state === 'finalized' ? 'Finalized' : 'Included, not final yet'}</dd></div>
          {receipt.gas && <>
            <div data-receipt-field="gas-used"><dt>Transaction gas used</dt><dd>{receipt.gas.gasUsed}</dd></div>
            <div><dt>Gas price</dt><dd>{gweiWords(receipt.gas.effectiveGasPrice)}</dd></div>
            {receipt.gas.l1Fee !== null && <div><dt>L1 data fee</dt><dd>{weiWords(receipt.gas.l1Fee)}</dd></div>}
          </>}
          <div><dt>Transaction</dt><dd>{href ? <a href={href} title={receipt.hash} target="_blank" rel="noreferrer noopener">{receipt.hash.slice(0, 8)}…{receipt.hash.slice(-4)}</a> : receipt.hash}</dd></div>
        </dl>
      </div>
    </details>
  </li>
}
