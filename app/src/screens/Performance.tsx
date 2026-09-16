import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import * as runtime from 'api-contracts/performance-v2/runtime.mjs'
import type { CardsResponse, Metrics } from 'api-contracts/performance-v2/types'
import type { Address } from 'viem'
import { sessionKey } from '../session/port'
import { livePort } from '../session/livePort'
import { realClock } from '../lib/clock'
import {
  COLLECTION_TEXT, ENROLLMENT_REASON_TEXT, ENROLLMENT_STATUS_TEXT, PERFORMANCE_STATUS_TEXT,
  createPerformanceController, enrollmentFailureText, exactDecimal, formatMetricPercent, formatMetricUsd, performanceReasonText, trackableSequence, utcSeconds,
  type PerformanceView, type SequenceReads, type TrackableSequence,
} from '../finance/performance'
import { financialFetch } from '../finance/http'
import { readRelease } from '../finance/release'
import { setupWallet } from '../finance/wallet'
import { createSequenceClient, sequenceDeploymentFrom, type SequenceDeployment } from '../finance/sequence'
import { Button, Card } from '../components/ui'

type PerfCard = CardsResponse['cards'][number]
type Tracked = Extract<PerfCard, { kind: 'tracked' }>
type Field = { name: Exclude<keyof Metrics, 'projectedApyPercent'>; label: string; unit: 'usd' | 'percent' }

const FIELDS: readonly Field[] = [
  { name: 'newTradingFeesUsd', label: 'Trading fees earned', unit: 'usd' },
  { name: 'reinvestedUsd', label: 'Reinvested', unit: 'usd' },
  { name: 'actualServiceFeesUsd', label: 'Service fees paid', unit: 'usd' },
  { name: 'otherStrategyCostsUsd', label: 'Other strategy costs', unit: 'usd' },
  { name: 'netFeeIncomeUsd', label: 'Net fee income', unit: 'usd' },
  { name: 'externalDepositsUsd', label: 'Deposits', unit: 'usd' },
  { name: 'externalWithdrawalsUsd', label: 'Withdrawals', unit: 'usd' },
  { name: 'timeWeightedCapitalUsd', label: 'Time-weighted capital', unit: 'usd' },
  { name: 'grossFeeAprPercent', label: 'Gross fee APR (24h)', unit: 'percent' },
  { name: 'netFeeAprPercent', label: 'Net fee APR (24h)', unit: 'percent' },
  { name: 'operatorCostsUsd', label: 'Operator gas (included in service fee)', unit: 'usd' },
]

const reasonsText = (card: PerfCard) => card.performanceReasons.map(performanceReasonText).join(' ')

/** What a metric cell's title adds: where the figure stops being the whole story. Never a caption on screen. */
function fieldNote(field: Field, card: PerfCard): string[] {
  const notes: string[] = []
  if (field.unit === 'percent') notes.push('Historical, not a forecast.')
  if (field.name === 'netFeeIncomeUsd') notes.push('Trading fees earned, less service fees and other strategy costs.')
  if (card.kind === 'tracked' && (field.name === 'externalDepositsUsd' || field.name === 'externalWithdrawalsUsd') && !card.financial.externalFlowsComplete) notes.push('Deposits and withdrawals may be incomplete for this window.')
  if (card.kind === 'tracked' && field.name === 'operatorCostsUsd') notes.push('Paid by the operator from the service fee, never deducted twice.', performanceReasonText(card.financial.operatorCostsReason))
  return notes
}

function MetricCell({ field, card }: { field: Field; card: PerfCard }) {
  const value = card.metrics[field.name]
  const shown = value === null ? null : field.unit === 'usd' ? formatMetricUsd(value) : formatMetricPercent(value)
  const notes = fieldNote(field, card)
  const title = shown === null
    ? ['Unavailable for this window.', ...notes, reasonsText(card)].filter(Boolean).join(' ')
    : [`${exactDecimal(value as string)}${field.unit === 'usd' ? ' USD' : '%'}.`, ...notes].join(' ')
  return <div data-metric-name={field.name} data-metric-state={shown === null ? 'unavailable' : 'value'}>
    <dt>{field.label}</dt>
    <dd className="tnum" title={title}>{shown ?? '—'}</dd>
  </div>
}

/** The card's own provenance, for its title: window, snapshot age, collection and flows. */
function cardTitle(card: Tracked): string {
  return [
    `Window ${utcSeconds(card.financial.windowStart)} to ${utcSeconds(card.financial.windowEnd)}.`,
    `Snapshot at block ${card.snapshot.blockNumber}, ${card.snapshotAgeSeconds} s old.`,
    `${COLLECTION_TEXT[card.collectionReason]}.`,
    card.complete24h ? 'Complete 24-hour window.' : 'Incomplete 24-hour window.',
    card.financial.externalFlowsComplete ? '' : 'Deposits and withdrawals may be incomplete.',
  ].filter(Boolean).join(' ')
}

function PerformanceCard({ card }: { card: PerfCard }) {
  const status = PERFORMANCE_STATUS_TEXT[card.performanceStatus]
  if (card.kind !== 'tracked') {
    return <Card level={2} className="dm-acct-perf-item" data-performance-status={card.performanceStatus} data-collection-status={card.collectionStatus} data-collection-reason={card.collectionReason}>
      <div className="dm-acct-perf-head"><h3 className="dm-acct-subtitle">Position unavailable</h3><span className="dm-pill dm-pill--neutral dm-acct-status" title={reasonsText(card) || undefined}>{status}</span></div>
    </Card>
  }
  return <Card level={2} className="dm-acct-perf-item" title={cardTitle(card)}
    data-performance-status={card.performanceStatus} data-collection-status={card.collectionStatus} data-collection-reason={card.collectionReason}
    data-snapshot-age={card.snapshotAgeSeconds} data-snapshot-block={card.snapshot.blockNumber} data-window-start={card.financial.windowStart} data-window-end={card.financial.windowEnd}
    data-external-flows={card.financial.externalFlowsComplete ? 'complete' : 'incomplete'} data-operator-costs-reason={card.financial.operatorCostsReason} data-complete-24h={card.complete24h ? 'true' : 'false'}>
    <div className="dm-acct-perf-head"><h3 className="dm-acct-subtitle">Position #{card.rootTokenId}</h3><span className="dm-pill dm-pill--neutral dm-acct-status" title={reasonsText(card) || undefined}>{status}</span></div>
    <p className="dm-acct-hash">Vault {card.vault}</p>
    <dl className="dm-acct-metrics">{FIELDS.map(field => <MetricCell key={field.name} field={field} card={card} />)}</dl>
  </Card>
}

const RECOVERY_PROFILE_KEY = 'domino.sequence.public-recovery.v1'

/**
 * The deployment the owner's sequences are read with: the published sequence
 * release, or the profile this browser saved when Your sequences verified one.
 * Null when there is neither. Nothing is written here.
 */
async function sequenceDeployment(): Promise<SequenceDeployment | null> {
  const release = await readRelease('/api/setup/v1/sequence-release', value => sequenceDeploymentFrom(value))
  if (release.kind === 'available') return release.deployment
  try {
    const raw = localStorage.getItem(RECOVERY_PROFILE_KEY)
    const saved = raw && raw.length <= 8192 ? sequenceDeploymentFrom(JSON.parse(raw), 0) : null
    return saved ? { ...saved, expiresAt: 0 } : null
  } catch {
    return null
  }
}

/**
 * Start tracking's chain reads: the sequence client over the connected wallet
 * of the signed-in owner, reused while that wallet stays connected. It lists
 * and reads; it never prepares, approves or sends anything.
 */
function walletSequenceReads(): SequenceReads {
  let open: { owner: string; client: ReturnType<typeof createSequenceClient>; current(): boolean } | null = null
  async function client(owner: string) {
    if (open && open.owner === owner && open.current()) return open.client
    open = null
    const deployment = await sequenceDeployment()
    if (!deployment) return null
    const wallet = await setupWallet()
    if (wallet.owner !== owner) throw new Error('wallet_identity_changed')
    open = { owner, client: createSequenceClient(wallet, deployment), current: wallet.current }
    return open.client
  }
  return {
    async list(owner) {
      const reader = await client(owner)
      if (!reader) return null
      const { rows, older } = await reader.sequences()
      return { rows: rows.map(trackableSequence), older }
    },
    async members(owner, vault) {
      if (!/^0x[0-9a-f]{40}$/.test(vault)) throw new Error('invalid_address')
      const reader = await client(owner)
      if (!reader) throw new Error('no_deployment')
      return (await reader.members(vault as Address)).tokenIds.map(String)
    },
  }
}

const shortVault = (vault: string) => `${vault.slice(0, 6)}…${vault.slice(-4)}`

/** What a sequence row shows in place of its button once the service lists it as tracked. */
function trackingText(view: PerformanceView, vault: string): string | null {
  const enrolled = view.enrollments.find(item => item.vault === vault)
  return enrolled ? ENROLLMENT_STATUS_TEXT[enrolled.status] : null
}

/** The outcome of the last Start tracking, said where it was pressed. The code stays in data attributes and the title. */
function Outcome({ view, vault }: { view: PerformanceView; vault: string | null }) {
  const outcome = view.enrollment
  if (!outcome || (vault !== null && outcome.vault !== vault)) return null
  return <p role="status" className="dm-acct-line" data-enrollment-outcome={outcome.ok ? 'sent' : outcome.reason} data-enrollment-vault={outcome.vault} title={outcome.ok ? undefined : outcome.reason.replaceAll('_', ' ')}>
    {outcome.ok ? 'Tracking requested. The first observation appears after collection.' : enrollmentFailureText(outcome.reason)}
  </p>
}

function SequenceRow({ row, view, onTrack }: { row: TrackableSequence; view: PerformanceView; onTrack(vault: string): void }) {
  const text = trackingText(view, row.vault)
  // Just sent: the outcome line below says so, and the button is not offered again.
  const sent = view.enrollment?.vault === row.vault && view.enrollment.ok
  return <li className="grid gap-1 py-2" data-trackable-sequence={row.vault}>
    <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <span className="min-w-0">
        <span className="dm-acct-subtitle">Position #{row.rootTokenId}</span>{' '}
        <span className="dm-acct-note">Sequence</span>{' '}
        <span className="dm-acct-hash" title={row.vault} translate="no">{shortVault(row.vault)}</span>
      </span>
      {text ? <span className="dm-acct-line text-fg-muted" data-tracking-state="">{text}</span>
        : !sent && <Button variant="outline" size="sm" disabled={view.busy || view.starting !== null} onClick={() => onTrack(row.vault)}>{view.starting === row.vault ? 'Starting…' : 'Start tracking'}</Button>}
    </div>
    <Outcome view={view} vault={row.vault} />
  </li>
}

/**
 * Start tracking, offered for the sequences the owner's wallet lists. Nothing
 * is typed: each sequence's positions are read from its vault. Only when the
 * wallet created more sequences than the listing holds can an older one be
 * named by its address. Until the history service has answered, without a
 * deployment to read with, or while the wallet read fails, the block is left
 * out; why is in the section's data attributes.
 */
function TrackSequences({ view, onTrack }: { view: PerformanceView; onTrack(vault: string): void }) {
  const [address, setAddress] = useState('')
  const { sequences } = view
  useEffect(() => { let key = sessionKey(livePort.getSnapshot()); return livePort.subscribe(() => { const next = sessionKey(livePort.getSnapshot()); if (next !== key) { key = next; setAddress('') } }) }, [])
  if (view.state !== 'ready' || sequences.state !== 'ready' || (sequences.rows.length === 0 && !sequences.older)) return null
  const typed = address.toLowerCase()
  const listed = sequences.rows.some(row => row.vault === typed)
  const canType = /^0x[0-9a-f]{40}$/.test(typed) && !listed
  return <div className="dm-inset dm-acct-perf-form" data-track-sequences="">
    <h3 className="dm-acct-subtitle">Track your sequences</h3>
    <p className="dm-hint">Tracking starts forward collection for a sequence you own. Its positions are read from the chain. It grants no spending or automation permission.</p>
    {sequences.rows.length > 0 && <ul className="m-0 grid list-none divide-y divide-[var(--border)] p-0">{sequences.rows.map(row => <SequenceRow key={row.vault} row={row} view={view} onTrack={onTrack} />)}</ul>}
    {sequences.older && <details className="dm-details dm-acct-disclosure">
      <summary>An older sequence</summary>
      <form className="dm-acct-disclosure-body" onSubmit={event => { event.preventDefault(); if (canType) onTrack(typed) }}>
        <label className="dm-label dm-acct-lf" htmlFor="perf-track-sequence">Sequence address<input id="perf-track-sequence" name="sequence" className="dm-field dm-acct-mono-field" value={address} onChange={event => setAddress(event.target.value)} spellCheck={false} autoComplete="off" /></label>
        <Button variant="outline" size="sm" className="justify-self-start" type="submit" disabled={!canType || view.busy || view.starting !== null}>{view.starting === typed && canType ? 'Starting…' : 'Start tracking'}</Button>
        {canType && <Outcome view={view} vault={typed} />}
      </form>
    </details>}
  </div>
}

export default function Performance() {
  const controller = useMemo(() => createPerformanceController({ session: livePort, fetch: financialFetch, runtime,
    clock: realClock, visible: () => !document.hidden, sequences: walletSequenceReads() }), [])
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  useEffect(() => { const stop = controller.start(); const changed = () => controller.visibilityChanged(); document.addEventListener('visibilitychange', changed)
    return () => { stop(); document.removeEventListener('visibilitychange', changed) } }, [controller])
  const waiting = view.enrollments.filter(item => item.epochId === null)
  const empty = view.cards.length === 0 && waiting.length === 0
  return <section aria-label="Private performance" className="dm-acct-perf" aria-busy={view.busy || undefined} data-performance={view.state} data-performance-reason={view.reason ?? undefined}
    data-sequences={view.sequences.state} data-sequences-reason={view.sequences.reason ?? undefined}>
    <h2 className="sr-only">Your strategy history</h2>
    {/* One plain line; how a missing figure shows is its title, and each cell's own title says why. */}
    <p className="dm-acct-desc" title="Missing prices and incomplete history show as dashes.">Positions under automation, over the last 24 hours.</p>
    {view.state === 'signed_out' ? <Card level={2} className="dm-acct-plot dm-dots-chart">Sign in with your wallet to view private history.</Card> : <>
      {empty && <Card level={2} className="dm-acct-plot dm-dots-chart" title={view.reason ? `History could not be read: ${view.reason.replaceAll('_', ' ')}` : undefined}>
        {view.state === 'ready' ? 'No managed positions are tracked for this wallet.' : 'Managed positions for this wallet appear here.'}
      </Card>}
      {waiting.map(item => <Card level={2} className="dm-acct-perf-item" key={item.enrollmentId} data-enrollment-status={item.status} data-enrollment-reason={item.reason}>
        <p className="dm-acct-hash">Vault {item.vault}</p><p className="dm-acct-line">{ENROLLMENT_STATUS_TEXT[item.status]}. {ENROLLMENT_REASON_TEXT[item.reason]}</p>
      </Card>)}
      {view.cards.map(card => <PerformanceCard key={card.epochId} card={card} />)}
      {view.more && <div className="dm-acct-actions"><Button variant="ghost" size="sm" disabled={view.busy || view.paging} onClick={() => controller.nextPage()}>{view.paging ? 'Reading positions…' : 'Next positions'}</Button></div>}
      <TrackSequences view={view} onTrack={vault => { void controller.track(vault) }} />
    </>}
  </section>
}
