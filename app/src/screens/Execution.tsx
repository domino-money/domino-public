import { useEffect, useMemo, useSyncExternalStore } from 'react'
import * as runtime from 'api-contracts/execution-v1/runtime.mjs'
import { createExecutionController } from '../finance/execution'
import { financialFetch } from '../finance/http'
import { livePort } from '../session/livePort'
import { realClock } from '../lib/clock'
import { Button, Card } from '../components/ui'

export default function Execution() {
  const controller = useMemo(() => createExecutionController({ session: livePort, fetch: financialFetch, runtime, clock: realClock, visible: () => !document.hidden }), [])
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  useEffect(() => { const stop = controller.start(), changed = () => controller.visibilityChanged(); document.addEventListener('visibilitychange', changed); return () => { document.removeEventListener('visibilitychange', changed); stop() } }, [controller])
  return <section className="dm-acct-exec" aria-label="Execution receipts">
    <h2 className="sr-only">Execution receipts</h2>
    <p className="dm-acct-desc">See submitted transactions and finalized effects for your sequences. An uncertain or reorganized transaction is never shown as completed.</p>
    {!view.scope ? <p className="dm-acct-quiet">Sign in with your wallet to view private execution receipts.</p> : <>
      <Button className="justify-self-start" variant="ghost" size="sm" disabled={view.busy} onClick={() => { void controller.refresh() }}>{view.busy ? 'Reading receipts…' : 'Read execution receipts'}</Button>
      {view.reason && <p className="dm-inset dm-acct-notice" role="status">{['route_not_available','feature_unavailable'].includes(view.reason) ? 'Execution history is not connected yet.' : 'Execution history is temporarily unavailable. You can retry after 60 seconds.'}</p>}
      {view.receivedAt !== null && <p className="dm-acct-note">Last read: {new Date(view.receivedAt).toLocaleString()}. Refresh to check for later chain changes.</p>}
      {view.receivedAt !== null && view.items.length === 0 && <p className="dm-acct-quiet">No executions returned for this wallet.</p>}
      {view.items.map(item => <Card level={2} className="dm-acct-exec-item" key={item.intentId}>
        <h3 className="dm-acct-subtitle">{item.state.replaceAll('_', ' ')}</h3><p className="dm-acct-hash">Sequence {item.sequenceHash}<br />Intent {item.intentId}</p>
        {item.reason && <p className="dm-acct-line">{item.reason.replaceAll('_', ' ')}</p>}
        {item.attempts.map(attempt => <p className="dm-acct-hash" key={attempt.transactionHash}>Attempt {attempt.ordinal + 1}: {attempt.transactionHash}</p>)}
        {item.receipt ? <><p className="dm-acct-line">Canonical and finalized at block {item.receipt.blockNumberRaw}. Liquidity increase: {item.receipt.liquidityIncreaseRaw} raw units.</p>
          <p className="dm-acct-line">Service fee: {item.receipt.serviceFeeBps} bps on consumed uncharged earnings. Operator gas is included in that fee.</p>
          {item.receipt.sources.map(source => <p className="dm-acct-hash" key={`${source.sourceId}:${source.currency}`}>Source {source.sourceId} · {source.currency}<br />Original earned fees consumed {source.grossOriginalConsumedRaw}; previously charged funds consumed {source.chargedConsumedRaw}; service fee {source.serviceFeeRaw}; added to liquidity {source.liquidityAddedRaw}; remaining original {source.originalAfterRaw}; remaining charged {source.chargedAfterRaw}.</p>)}
        </> : <p className="dm-acct-line text-fg-muted">No finalized financial receipt for this intent. Check the existing transaction before taking another action.</p>}
      </Card>)}
      {view.more && <Button className="justify-self-start" variant="ghost" size="sm" disabled={view.busy} onClick={() => controller.nextPage()}>Next executions</Button>}
      <p className="dm-acct-note">Reads are limited to one page per 30 seconds. Owner refunds are available from setup; NFT and fee exits are available from sequences.</p>
    </>}
  </section>
}
