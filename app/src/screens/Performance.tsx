import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import * as runtime from 'api-contracts/performance-v2/runtime.mjs'
import type { Metrics } from 'api-contracts/performance-v2/types'
import { sessionKey } from '../session/port'
import { livePort } from '../session/livePort'
import { realClock } from '../lib/clock'
import { createPerformanceController } from '../finance/performance'
import { financialFetch } from '../finance/http'
import { Button, Card } from '../components/ui'

const fields: ReadonlyArray<[keyof Metrics, string, string]> = [
  ['newTradingFeesUsd', 'Trading fees earned', '$'], ['reinvestedUsd', 'Reinvested', '$'],
  ['actualServiceFeesUsd', 'Service fees paid', '$'], ['netFeeIncomeUsd', 'Net fee income', '$'],
  ['externalDepositsUsd', 'Deposits', '$'], ['externalWithdrawalsUsd', 'Withdrawals', '$'],
  ['timeWeightedCapitalUsd', 'Time-weighted capital', '$'], ['grossFeeAprPercent', 'Gross fee APR (24h)', '%'],
  ['netFeeAprPercent', 'Net fee APR (24h)', '%'], ['operatorCostsUsd', 'Operator gas (included in service fee)', '$'],
]
const exactDecimal = (value: string) => value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value
const metric = (value: string | null, unit: string) => value === null ? 'Unavailable' : unit === '%' ? `${exactDecimal(value)}%` : `$${exactDecimal(value)}`
const explanation = (reason: string | null) => {
  if (reason === 'enrollment_queued') return 'Tracking requested. The first canonical observation will appear after collection.'
  if (reason === 'gate_required') return 'Enter the beta password to continue.'
  if (reason === 'feature_unavailable' || reason === 'route_not_available') return 'Private tracking is not connected yet.'
  if (reason === 'performance_subject_not_admitted') return 'This vault is not available for tracking in this release.'
  return 'Private tracking is temporarily unavailable. It will retry within 60 seconds while this tab is visible.'
}
export default function Performance() {
  const controller = useMemo(() => createPerformanceController({ session: livePort, fetch: financialFetch, runtime,
    clock: realClock, visible: () => !document.hidden }), [])
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [vault, setVault] = useState(''), [tokens, setTokens] = useState('')
  useEffect(() => { const stop = controller.start(); const changed = () => controller.visibilityChanged(); document.addEventListener('visibilitychange', changed)
    return () => { stop(); document.removeEventListener('visibilitychange', changed) } }, [controller])
  useEffect(() => { let key = sessionKey(livePort.getSnapshot()); return livePort.subscribe(() => { const next = sessionKey(livePort.getSnapshot()); if (next !== key) { key = next; setVault(''); setTokens('') } }) }, [])
  const tokenIds = tokens.split(/[,\s]+/).filter(Boolean)
  const canEnroll = /^0x[0-9a-f]{40}$/.test(vault) && tokenIds.length > 0 && tokenIds.length <= 64
    && new Set(tokenIds).size === tokenIds.length && tokenIds.every(id => /^(0|[1-9]\d{0,77})$/.test(id) && BigInt(id) < 2n ** 256n)
  return <section aria-label="Private performance" className="dm-acct-perf">
    <h2 className="sr-only">Your strategy history</h2>
    <p className="dm-acct-desc">Canonical receipts for your managed positions. Missing prices and incomplete history remain visible as unavailable values.</p>
    {view.state === 'signed_out' ? <Card level={2} className="dm-acct-plot dm-dots-chart">Sign in with your wallet to view private history.</Card> : <>
      {view.reason && <p role="status" className="dm-acct-plot dm-dots-chart">{explanation(view.reason)}</p>}
      {view.state === 'loading' && <p role="status" className="dm-acct-plot dm-dots-chart">Loading your history…</p>}
      {view.state === 'ready' && view.enrollments.length === 0 && <Card level={2} className="dm-acct-plot dm-dots-chart">No managed positions are being tracked for this wallet yet.</Card>}
      {view.enrollments.filter(item => item.epochId === null).map(item => <Card level={2} className="dm-acct-perf-item" key={item.enrollmentId}><p className="dm-acct-hash">Vault {item.vault}</p><p className="dm-acct-line">Tracking {item.status}. {item.reason.replaceAll('_', ' ')}.</p></Card>)}
      {view.cards.map(card => <Card level={2} className="dm-acct-perf-item" key={card.epochId}>
        <div className="dm-acct-perf-head"><h3 className="dm-acct-subtitle">{card.kind === 'tracked' ? `Position #${card.rootTokenId}` : 'Position unavailable'}</h3><span className="dm-pill dm-pill--neutral dm-acct-status">{card.performanceStatus}</span></div>
        {card.kind === 'tracked' && <><p className="dm-acct-hash">Vault {card.vault}</p><p className="dm-acct-note">Observed {card.financial.observedSeconds} seconds · block {card.snapshot.blockNumber} · {card.complete24h ? 'Complete 24-hour window' : 'Incomplete 24-hour window'}</p></>}
        <dl className="dm-acct-metrics">{fields.map(([name, label, unit]) => <div key={name}><dt>{label}</dt><dd className="tnum">{metric(card.metrics[name], unit)}</dd></div>)}</dl>
        {card.performanceReasons.length > 0 && <p className="dm-acct-note">{card.performanceReasons.map(reason => reason.replaceAll('_', ' ')).join(' · ')}</p>}
        <p className="dm-acct-note">Historical APR is not a forecast. Operator gas is disclosed separately and is not deducted twice.</p>
      </Card>)}
      <div className="dm-acct-actions"><Button variant="ghost" size="sm" disabled={view.busy} onClick={() => { void controller.refresh() }}>Refresh</Button>{view.more && <Button variant="ghost" size="sm" disabled={view.busy} onClick={() => controller.nextPage()}>Next positions</Button>}<Button variant="ghost" size="sm" disabled={view.busy} onClick={() => controller.firstPage()}>First positions</Button></div>
      <form className="dm-inset dm-acct-perf-form" onSubmit={event => { event.preventDefault(); if (canEnroll) void controller.enroll({ vault, tokenIds }) }}>
        <h3 className="dm-acct-subtitle">Track a managed vault</h3>
        <label className="dm-label dm-acct-lf">Vault address<input className="dm-field dm-acct-mono-field" value={vault} onChange={event => setVault(event.target.value.toLowerCase())} spellCheck={false} /></label>
        <label className="dm-label dm-acct-lf">Position IDs, separated by commas<input className="dm-field" value={tokens} onChange={event => setTokens(event.target.value)} /></label>
        <p className="dm-hint">The service verifies ownership and starts forward collection. This does not grant spending or automation permissions.</p>
        <Button variant="outline" size="sm" className="justify-self-start" disabled={!canEnroll || view.busy} type="submit">Start tracking</Button>
      </form>
    </>}
  </section>
}
