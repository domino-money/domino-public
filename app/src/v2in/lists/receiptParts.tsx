import type { ActivityResponse } from 'api-contracts/read-v6/types'
import { CopyButton } from '../../components/read/screens/CopyButton'
import { v2TxUrl } from '../../v2/explorers'
import { IconChevronDown } from '../../components/icons'
import { Pill } from '../../components/ui'
import { shortDate, shortTime } from '../../lib/format/time'
import { chainNotes, partialSentence, type ReceiptView } from './model'
import { ChainBadge, StaleBadge } from './parts'

/*
 * One read-v6 receipt as V1's receipts draw one (screens/Execution.tsx ReceiptRow; styles/positions.css `.dm-rcpt-row`):
 * the state chip, what happened with its chain, its one figure, and the detail one click away: what moved, the Domino fee
 * with its kind, rate, token and amount (a part still owed to Domino's fee recipient said as part of the fee, never as the
 * person's, never as an extra charge), the time, the network, Included or Finalized, the gas fields as the receipt states
 * them (the L1 data fee where it states one; no total is claimed, spec F7 rev4 §6.2), and the transaction: a link to its
 * chain's explorer (Changed on purpose 2026-10-04, rugged97's delta of 4 Oct §1: Base and Arbitrum One too, src/v2/explorers.ts;
 * it was Robinhood Chain's alone), its hash copyable everywhere.
 */

/**
 * V1's receipts list look (styles/positions.css `.dm-rcpt-list`), with its container for the narrow layout, written as
 * utilities: these lists never carry V1's own class, so nothing V1's suites find by it changes on a V2 build.
 */
export const RECEIPT_LIST =
  'm-0 grid min-w-0 list-none overflow-hidden rounded-[var(--radius-lg)] bg-[var(--surface-1)] p-0 shadow-[inset_0_0_0_1px_var(--border)] @container/dm-rcpt [&>li]:min-w-0 [&>li+li]:border-t [&>li+li]:border-[var(--border)]'

/** The block's time as V1's captions write it: "09-27 13:20 UTC". */
const timeWords = (seconds: number) => `${shortDate(seconds)} ${shortTime(seconds)}`

/** A technical value: short, whole in its title and its copy; a link to the explorer where the app has one. */
function Hash({ value, href }: { value: string; href: string | null }) {
  const short = `${value.slice(0, 6)}…${value.slice(-4)}`
  return (
    <div data-receipt-field="transaction-hash">
      <dt>Transaction</dt>
      <dd>
        {href ? (
          <a href={href} target="_blank" rel="noreferrer noopener" className="dm-mono underline" title={value} translate="no" data-v2-explorer="">
            {short}
          </a>
        ) : (
          <span className="dm-mono" title={value} translate="no">
            {short}
          </span>
        )}
        <CopyButton value={value} label="Copy transaction" />
      </dd>
    </div>
  )
}

/** One of the person's own receipts as a row of a receipts list. */
export function ReceiptRow({ view }: { view: ReceiptView }) {
  const href = v2TxUrl(view.chainId, view.hash)
  return (
    <li data-v2-receipt={view.id} data-v2-receipt-kind={view.kind} data-v2-receipt-chain={view.chainId} data-v2-finality={view.finalized ? 'finalized' : 'included'}>
      <details className="dm-rcpt-row">
        <summary>
          <Pill tone={view.finalized ? 'in' : 'neutral'} dot className="dm-rcpt-chip" title={view.finalized ? 'Final on the network.' : 'In a block, not final yet. A delay is never a failure.'}>
            {view.finalized ? 'Finalized' : 'Included'}
          </Pill>
          <span className="dm-rcpt-what">
            {view.what}{' '}
            <ChainBadge name={view.chain} chainId={view.chainId} />
          </span>
          <span className="dm-rcpt-amount tnum" data-v2-receipt-amount="">
            {view.amount ?? ''}
          </span>
          <IconChevronDown size={16} className="dm-rcpt-chevron" />
        </summary>
        <div className="dm-rcpt-detail">
          {(view.lines.some((line) => !line.tech) || view.fees.length > 0) && (
            <dl className="dm-rcpt-facts">
              {view.lines
                .filter((line) => !line.tech)
                .map((line, i) => (
                  <div key={`line-${i}`} data-receipt-line={line.data}>
                    <dt>{line.label}</dt>
                    <dd className="tnum">{line.value}</dd>
                  </div>
                ))}
              {view.fees.map((fee, i) => (
                <div key={`fee-${i}`} data-receipt-fee={fee.kind} data-receipt-fee-rate={fee.rate ?? undefined}>
                  <dt>{fee.label}</dt>
                  <dd className="tnum">{fee.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {view.fees.flatMap((fee, i) =>
            fee.deferred
              ? [
                  <p key={`deferred-${i}`} className="dm-rcpt-note" data-receipt-fee-deferred={fee.kind}>
                    Of this fee, {fee.deferred} is still on its way to Domino. It isn’t an extra charge, and it isn’t yours.
                  </p>,
                ]
              : [],
          )}
          <dl className="dm-rcpt-tech">
            {view.lines
              .filter((line) => line.tech)
              .map((line, i) => (
                <div key={`tech-${i}`} data-receipt-line={line.data}>
                  <dt>{line.label}</dt>
                  <dd className="tnum">{line.value}</dd>
                </div>
              ))}
            <div data-receipt-field="time">
              <dt>Time</dt>
              <dd>{timeWords(view.at)}</dd>
            </div>
            <div data-receipt-field="network">
              <dt>Network</dt>
              <dd>{view.chain}</dd>
            </div>
            <div data-receipt-field="state">
              <dt>Status</dt>
              <dd>{view.finalized ? 'Finalized' : 'Included, not final yet'}</dd>
            </div>
            {view.gas ? (
              <>
                <div data-receipt-field="gas-used">
                  <dt>Gas used</dt>
                  <dd>{view.gas.gasUsed}</dd>
                </div>
                <div data-receipt-field="gas-price">
                  <dt>Gas price</dt>
                  <dd>{view.gas.gasPrice}</dd>
                </div>
                {view.gas.l1Fee !== null && (
                  <div data-receipt-field="l1-fee">
                    <dt>L1 data fee</dt>
                    <dd>{view.gas.l1Fee}</dd>
                  </div>
                )}
              </>
            ) : (
              <div data-receipt-field="gas">
                <dt>Gas</dt>
                <dd>
                  <span title="This receipt states no gas." aria-label="Not reported">
                    —
                  </span>
                </dd>
              </div>
            )}
            <Hash value={view.hash} href={href} />
          </dl>
        </div>
      </details>
    </li>
  )
}

/** The chains' state for a list of receipts: §6.3's partial sentence, and each stale chain with the age of what it shows. */
export function ChainLines({ answer }: { answer: Pick<ActivityResponse, 'chains' | 'servedAt'> }) {
  const partial = partialSentence(answer.chains)
  const stale = chainNotes(answer).filter((chain) => chain.state === 'stale' && chain.age)
  return (
    <>
      {partial && (
        <p className="dm-rcpt-note" data-v2-partial="">
          {partial}
        </p>
      )}
      {stale.map((chain) => (
        <p key={chain.chainId} className="dm-rcpt-note flex flex-wrap items-center gap-2" data-v2-stale-chain={chain.chainId}>
          <span>{chain.name}:</span>
          <StaleBadge age={chain.age as string} />
        </p>
      ))}
    </>
  )
}
