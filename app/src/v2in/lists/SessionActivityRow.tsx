import { IconCheck, IconChevronDown } from '../../components/icons'
import { v2TxUrl } from '../../v2/explorers'
import type { SessionActivity } from './sessionActivity'
import { RECEIPT_WORDS, receiptStatus } from './words'

/**
 * Changed on purpose 2026-10-14 (incident C1; the owner's decision D0): a session row exists only for a setup whose
 * receipt was already checked in a block with success (./sessionActivity.ts), so it carries the check from the start. It
 * said "Confirming" until the chain's finalized block passed it (about 16 minutes on Robinhood Chain, 15 to 20 on Base
 * and Arbitrum One). Finality is the Status line below; data-v2-finality keeps saying the fact itself.
 */
export function SessionActivityRow({ item }: { item: SessionActivity }) {
  const { proof, tokenId, chain } = item
  const finalized = proof.phase === 'finalized'
  const href = v2TxUrl(proof.chainId, proof.hash)
  return <li data-session-activity={proof.hash} data-v2-finality={proof.phase}>
    <details className="dm-rcpt-row dm-rcpt-operation">
      <summary>
        <span className="dm-rcpt-what">
          <span className="dm-receipt-title"><span className="dm-receipt-check" role="img" aria-label={RECEIPT_WORDS.confirmed}><IconCheck size={14} /></span><span>Automation set up for position #{tokenId}</span></span>
          {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): the network alone; it added "· Updating history". */}
          <span className="dm-activity-time">{chain}</span>
        </span>
        <IconChevronDown size={16} className="dm-rcpt-chevron" />
      </summary>
      <div className="dm-rcpt-detail">
        {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): the confirmation alone; it added "The activity details will update automatically." */}
        <p className="dm-rcpt-note">Your setup transaction is confirmed.</p>
        <dl className="dm-rcpt-tech">
          <div><dt>Status</dt><dd>{receiptStatus({ confirmed: true, finalized })}</dd></div>
          <div><dt>Network</dt><dd>{chain}</dd></div>
          <div><dt>Block</dt><dd className="tnum">{proof.block}</dd></div>
          <div><dt>Transaction</dt><dd>{href && <a href={href} target="_blank" rel="noreferrer noopener" className="dm-mono underline" title={proof.hash}>{proof.hash.slice(0, 6)}…{proof.hash.slice(-4)}</a>}</dd></div>
        </dl>
      </div>
    </details>
  </li>
}
