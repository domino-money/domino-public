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
  return <section aria-label="Private performance" className="mt-8 space-y-4">
    <h2 className="text-xl font-medium">Your strategy history</h2>
    <p className="text-sm text-fg-muted">Canonical receipts for your managed positions. Missing prices and incomplete history remain visible as unavailable values.</p>
    {view.state === 'signed_out' ? <Card className="p-5">Sign in with your wallet to view private history.</Card> : <>
      {view.reason && <p role="status">{explanation(view.reason)}</p>}
      {view.state === 'loading' && <p role="status">Loading your history…</p>}
      {view.state === 'ready' && view.enrollments.length === 0 && <Card className="p-5">No managed positions are being tracked for this wallet yet.</Card>}
      {view.enrollments.filter(item => item.epochId === null).map(item => <Card className="p-5" key={item.enrollmentId}><p className="break-all">Vault {item.vault}</p><p>Tracking {item.status}. {item.reason.replaceAll('_', ' ')}.</p></Card>)}
      {view.cards.map(card => <Card className="p-5" key={card.epochId}>
        <div className="flex flex-wrap justify-between gap-2"><h3 className="font-medium">{card.kind === 'tracked' ? `Position #${card.rootTokenId}` : 'Position unavailable'}</h3><span>{card.performanceStatus}</span></div>
        {card.kind === 'tracked' && <><p className="mt-1 break-all text-xs text-fg-muted">Vault {card.vault}</p><p className="text-xs text-fg-muted">Observed {card.financial.observedSeconds} seconds · block {card.snapshot.blockNumber} · {card.complete24h ? 'Complete 24-hour window' : 'Incomplete 24-hour window'}</p></>}
        <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{fields.map(([name, label, unit]) => <div key={name}><dt className="text-xs text-fg-muted">{label}</dt><dd className="break-all text-base">{metric(card.metrics[name], unit)}</dd></div>)}</dl>
        {card.performanceReasons.length > 0 && <p className="mt-4 text-xs text-fg-muted">{card.performanceReasons.map(reason => reason.replaceAll('_', ' ')).join(' · ')}</p>}
        <p className="mt-2 text-xs text-fg-muted">Historical APR is not a forecast. Operator gas is disclosed separately and is not deducted twice.</p>
      </Card>)}
      <div className="flex gap-2"><Button variant="outline" disabled={view.busy} onClick={() => { void controller.refresh() }}>Refresh</Button>{view.more && <Button variant="outline" disabled={view.busy} onClick={() => controller.nextPage()}>Next positions</Button>}<Button variant="outline" disabled={view.busy} onClick={() => controller.firstPage()}>First positions</Button></div>
      <form className="grid gap-3 rounded-xl border border-line p-5" onSubmit={event => { event.preventDefault(); if (canEnroll) void controller.enroll({ vault, tokenIds }) }}>
        <h3 className="font-medium">Track a managed vault</h3>
        <label className="text-sm">Vault address<input className="mt-1 block w-full rounded border bg-surface-1 p-2" value={vault} onChange={event => setVault(event.target.value.toLowerCase())} spellCheck={false} /></label>
        <label className="text-sm">Position IDs, separated by commas<input className="mt-1 block w-full rounded border bg-surface-1 p-2" value={tokens} onChange={event => setTokens(event.target.value)} /></label>
        <p className="text-xs text-fg-muted">The service verifies ownership and starts forward collection. This does not grant spending or automation permissions.</p>
        <Button variant="outline" disabled={!canEnroll || view.busy} type="submit">Start tracking</Button>
      </form>
    </>}
  </section>
}
