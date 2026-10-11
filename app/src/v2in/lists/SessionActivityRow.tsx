import { IconCheck, IconChevronDown } from '../../components/icons'
import { Pill } from '../../components/ui'
import { v2TxUrl } from '../../v2/explorers'
import type { SessionActivity } from './sessionActivity'

export function SessionActivityRow({ item }: { item: SessionActivity }) {
  const { proof, tokenId, chain } = item
  const finalized = proof.phase === 'finalized'
  const href = v2TxUrl(proof.chainId, proof.hash)
  return <li data-session-activity={proof.hash} data-v2-finality={proof.phase}>
    <details className="dm-rcpt-row dm-rcpt-operation">
      <summary>
        <span className="dm-rcpt-what">
          <span className="dm-receipt-title">{finalized && <span className="dm-receipt-check" role="img" aria-label="Confirmed"><IconCheck size={14} /></span>}<span>Automation set up for position #{tokenId}</span></span>
          {!finalized && <Pill tone="neutral" dot className="dm-receipt-exception">Confirming</Pill>}
          <span className="dm-activity-time">{chain} · Updating history</span>
        </span>
        <IconChevronDown size={16} className="dm-rcpt-chevron" />
      </summary>
      <div className="dm-rcpt-detail">
        <p className="dm-rcpt-note">Your setup transaction is included. The activity details will update automatically.</p>
        <dl className="dm-rcpt-tech">
          <div><dt>Status</dt><dd>{finalized ? 'Finalized' : 'Included, not final yet'}</dd></div>
          <div><dt>Network</dt><dd>{chain}</dd></div>
          <div><dt>Block</dt><dd className="tnum">{proof.block}</dd></div>
          <div><dt>Transaction</dt><dd>{href && <a href={href} target="_blank" rel="noreferrer noopener" className="dm-mono underline" title={proof.hash}>{proof.hash.slice(0, 6)}…{proof.hash.slice(-4)}</a>}</dd></div>
        </dl>
      </div>
    </details>
  </li>
}
