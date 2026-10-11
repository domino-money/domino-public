import type { ActivityResponse } from 'api-contracts/read-v6/types'
import type { ReactNode } from 'react'
import { CopyButton } from '../../components/read/screens/CopyButton'
import { v2TxUrl } from '../../v2/explorers'
import { IconCheck, IconChevronDown } from '../../components/icons'
import { Pill } from '../../components/ui'
import { shortDate, shortTime } from '../../lib/format/time'
import { chainNotes, partialSentence, type ReceiptView } from './model'

export const RECEIPT_LIST =
  'm-0 grid min-w-0 list-none overflow-hidden rounded-[var(--radius-lg)] bg-[var(--surface-1)] p-0 shadow-[inset_0_0_0_1px_var(--border)] @container/dm-rcpt [&>li]:min-w-0 [&>li+li]:border-t [&>li+li]:border-[var(--border)]'
const timeWords = (seconds: number) => `${shortDate(seconds)} ${shortTime(seconds)}`

function Hash({ value, href }: { value: string; href: string | null }) {
  const short = `${value.slice(0, 6)}…${value.slice(-4)}`
  return <div data-receipt-field="transaction-hash"><dt>Transaction</dt><dd>
    {href ? <a href={href} target="_blank" rel="noreferrer noopener" className="dm-mono underline" title={value} translate="no" data-v2-explorer="">{short}</a>
      : <span className="dm-mono" title={value} translate="no">{short}</span>}
    <CopyButton value={value} label="Copy transaction" />
  </dd></div>
}

/** Every effect remains inspectable. Amounts and tariffs are never summed across event kinds. */
function Effect({ view, many }: { view: ReceiptView; many: boolean }) {
  return <div data-receipt-effect={view.id}>
    {(many || view.what.includes('raw units')) && <p className="dm-receipt-effect-title">{view.what}</p>}
    {(view.lines.some((line) => !line.tech) || view.fees.length > 0) && <dl className="dm-rcpt-facts">
      {view.lines.filter((line) => !line.tech).map((line, i) => <div key={`line-${i}`} data-receipt-line={line.data}><dt>{line.label}</dt><dd className="tnum">{line.value}</dd></div>)}
      {view.fees.map((fee, i) => <div key={`fee-${i}`} data-receipt-fee={fee.kind} data-receipt-fee-rate={fee.rate ?? undefined}><dt>{fee.label}</dt><dd className="tnum">{fee.value}</dd></div>)}
    </dl>}
    {view.fees.flatMap((fee, i) => fee.deferred ? [<p key={i} className="dm-rcpt-note" data-receipt-fee-deferred={fee.kind}>Of this fee, {fee.deferred} is still on its way to Domino. It isn’t an extra charge, and it isn’t yours.</p>] : [])}
    {view.lines.some((line) => line.tech) && <dl className="dm-rcpt-tech">{view.lines.filter((line) => line.tech).map((line, i) => <div key={i} data-receipt-line={line.data}><dt>{line.label}</dt><dd className="tnum">{line.value}</dd></div>)}</dl>}
  </div>
}

/** One human operation, potentially several proven effects, with one transaction-cost section. */
export function ReceiptRow({ view, effects = [view], showGas = true, children, positionItem }: { view: ReceiptView; effects?: readonly ReceiptView[]; showGas?: boolean; children?: ReactNode; positionItem?: ActivityResponse['items'][number] }) {
  const href = v2TxUrl(view.chainId, view.hash)
  const finalized = effects.every((effect) => effect.finalized)
  const claim = effects.some((effect) => effect.lines.some((line) => line.data === 'deferred'))
  const gas = effects.find((effect) => effect.gas !== null)?.gas ?? null
  const what = positionItem?.kind === 'vault_execution'
    ? positionItem.successor ? `Position #${positionItem.successor.tokenId} opened automatically` : `Fees added back · #${positionItem.compounded.tokenId}`
    : view.what.includes('raw units') ? view.what.split(':')[0] : view.what
  const raw = view.amount?.includes('raw units') === true
  return <li data-v2-receipt={view.id} data-v2-receipt-kind={view.kind} data-v2-receipt-chain={view.chainId} data-v2-finality={finalized ? 'finalized' : 'included'}
    data-position-activity-item={positionItem?.id} data-position-activity-action={positionItem?.kind === 's1_action' ? positionItem.action : undefined} data-receipt-effects={effects.length}>
    <details className="dm-rcpt-row dm-rcpt-operation">
      <summary>
        <span className="dm-rcpt-what">
          <span className="dm-receipt-title">{finalized && !claim && <span className="dm-receipt-check" role="img" aria-label="Confirmed"><IconCheck size={14} /></span>}<span>{what}</span></span>
          {(!finalized || claim) && <Pill tone={claim ? 'wait' : 'neutral'} dot className="dm-receipt-exception">{claim ? 'Delivery deferred' : 'Confirming'}</Pill>}
          <span className="dm-activity-time"><time dateTime={new Date(view.at * 1000).toISOString()}>{timeWords(view.at)}</time>{view.chainId !== 4663 && <> · {view.chain}</>}</span>
        </span>
        <span className="dm-rcpt-amount tnum" data-v2-receipt-amount="" title={raw ? 'Token details are unavailable. Exact raw amounts are in the receipt.' : undefined}>{raw ? '—' : view.amount ?? ''}</span>
        <IconChevronDown size={16} className="dm-rcpt-chevron" />
      </summary>
      <div className="dm-rcpt-detail" data-position-activity-fee={positionItem?.kind === 's1_action' ? positionItem.tariffs.filter((fee) => fee.kind === 'assisted_swap').map((fee) => fee.amount).join(',') || 'none' : undefined}>
        {effects.map((effect) => <Effect key={effect.id} view={effect} many={effects.length > 1} />)}
        {children}
        <dl className="dm-rcpt-tech">
          <div data-receipt-field="time"><dt>Time</dt><dd>{timeWords(view.at)}</dd></div>
          <div data-receipt-field="network"><dt>Network</dt><dd>{view.chain}</dd></div>
          <div data-receipt-field="state"><dt>Status</dt><dd>{finalized ? 'Finalized' : 'Included, not final yet'}</dd></div>
          {!showGas ? <div data-receipt-field="gas-shared"><dt>Transaction cost</dt><dd>Shared with the other actions in this transaction.</dd></div> : gas ? <>
            <div data-receipt-field="gas-used"><dt>Transaction gas used</dt><dd>{gas.gasUsed}</dd></div>
            <div data-receipt-field="gas-price"><dt>Gas price</dt><dd>{gas.gasPrice}</dd></div>
            {gas.l1Fee !== null && <div data-receipt-field="l1-fee"><dt>L1 data fee</dt><dd>{gas.l1Fee}</dd></div>}
          </> : <div data-receipt-field="gas"><dt>Gas</dt><dd><span aria-label="Not reported">—</span></dd></div>}
          <Hash value={view.hash} href={href} />
          {effects.length > 1 && <div><dt>Events</dt><dd className="dm-mono">{effects.map((effect) => effect.id).join(' · ')}</dd></div>}
        </dl>
      </div>
    </details>
  </li>
}

/** One coverage sentence. Per-network diagnostics do not compete with the actual activity rows. */
export function ChainLines({ answer }: { answer: Pick<ActivityResponse, 'chains' | 'servedAt'> }) {
  const partial = partialSentence(answer.chains)
  const stale = chainNotes(answer).filter((chain) => chain.state === 'stale' && chain.age)
  const text = partial ?? (stale.length ? 'Recent activity is still updating.' : null)
  return text ? <p className="dm-rcpt-note" data-v2-partial={partial ? '' : undefined} title={stale.map((chain) => `${chain.name}: ${chain.age}`).join(' · ') || undefined}>{text}</p> : null
}
