import { useEffect, useState, useSyncExternalStore } from 'react'
import * as runtime from 'api-contracts/performance-v2/runtime.mjs'
import type { CardsResponse, EpochsResponse, Metrics } from 'api-contracts/performance-v2/types'
import type { Address } from 'viem'
import { sessionKey } from '../session/port'
import { livePort } from '../session/livePort'
import { openWalletDialog, signedOutLine } from '../finance/signedOut'
import { realClock } from '../lib/clock'
import { MANAGED_APPEAR, MANAGED_LINE, NOTHING_YET_BOTH, type CardShows } from '../lib/automationCards'
import {
  COLLECTION_TEXT, ENROLLMENT_REASON_TEXT, ENROLLMENT_STATUS_TEXT, PERFORMANCE_STATUS_TEXT,
  createPerformanceController, enrollmentFailureText, exactDecimal, formatMetricPercent, formatMetricUsd, performanceReasonText, trackableSequence, utcSeconds,
  type PerformanceView, type SequenceReads, type TrackableSequence,
} from '../finance/performance'
import { financialFetch } from '../finance/http'
import { keep, readKept, sharedStart, useKeptWhileChecking, walletName } from '../finance/privateCards'
import { readRelease } from '../finance/release'
import { setupWallet } from '../finance/wallet'
import { createSequenceClient, sequenceDeploymentFrom, type SequenceDeployment } from '../finance/sequence'
import { Button, Card } from '../components/ui'

type PerfCard = CardsResponse['cards'][number]
type Tracked = Extract<PerfCard, { kind: 'tracked' }>
type Field = { name: Exclude<keyof Metrics, 'projectedApyPercent'>; label: string; unit: 'usd' | 'percent' }

/** The three figures a managed position shows at a glance; the rest are one click away (MORE). */
const MAIN: readonly Field[] = [
  { name: 'newTradingFeesUsd', label: 'Fees earned', unit: 'usd' },
  // Changed on purpose (the owner, 2026-09-27, round 6): the position page's one plain phrase, not "Re-added".
  { name: 'reinvestedUsd', label: 'Fees added back', unit: 'usd' },
  { name: 'netFeeAprPercent', label: 'APR after fees', unit: 'percent' },
]
const MORE: readonly Field[] = [
  { name: 'actualServiceFeesUsd', label: 'Service fees', unit: 'usd' },
  { name: 'otherStrategyCostsUsd', label: 'Other costs', unit: 'usd' },
  { name: 'netFeeIncomeUsd', label: 'Fees after costs', unit: 'usd' },
  { name: 'externalDepositsUsd', label: 'You added', unit: 'usd' },
  { name: 'externalWithdrawalsUsd', label: 'You took out', unit: 'usd' },
  { name: 'timeWeightedCapitalUsd', label: 'Average amount in', unit: 'usd' },
  { name: 'grossFeeAprPercent', label: 'APR before fees', unit: 'percent' },
  { name: 'operatorCostsUsd', label: 'Network costs (in the service fee)', unit: 'usd' },
]

const reasonsText = (card: PerfCard) => card.performanceReasons.map(performanceReasonText).join(' ')
/** A vault at a glance; the whole address is its title. */
const shortVault = (vault: string) => `${vault.slice(0, 6)}…${vault.slice(-4)}`

/** What a metric cell's title adds: where the figure stops being the whole story. Never a caption on screen. */
function fieldNote(field: Field, card: PerfCard): string[] {
  const notes: string[] = []
  if (field.unit === 'percent') notes.push('Over the last 24 hours, as a yearly rate. Historical, not a forecast.')
  if (field.name === 'netFeeIncomeUsd') notes.push('Fees earned, less service fees and other costs.')
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

/** One row's head: its name (the position's own page, when there is one) and where its figures stand. */
function Head({ name, href, status, title }: { name: string; href?: string; status: string; title?: string }) {
  return <div className="dm-mp-head">
    {href ? <a className="dm-mp-name" href={href}>{name}</a> : <span className="dm-mp-name">{name}</span>}
    <span className="dm-pill dm-pill--neutral dm-acct-status" title={title || undefined}>{status}</span>
  </div>
}

/**
 * One managed position in one short row: its name, where its figures stand,
 * and the three that matter at a glance. Every other figure, and the
 * automation's address, is inside All figures.
 */
function PerformanceCard({ card }: { card: PerfCard }) {
  const status = PERFORMANCE_STATUS_TEXT[card.performanceStatus]
  if (card.kind !== 'tracked') {
    return <li className="dm-mp-row" data-performance-status={card.performanceStatus} data-collection-status={card.collectionStatus} data-collection-reason={card.collectionReason}>
      <Head name="Position unavailable" status={status} title={reasonsText(card)} />
    </li>
  }
  return <li className="dm-mp-row" title={cardTitle(card)}
    data-performance-status={card.performanceStatus} data-collection-status={card.collectionStatus} data-collection-reason={card.collectionReason}
    data-snapshot-age={card.snapshotAgeSeconds} data-snapshot-block={card.snapshot.blockNumber} data-window-start={card.financial.windowStart} data-window-end={card.financial.windowEnd}
    data-external-flows={card.financial.externalFlowsComplete ? 'complete' : 'incomplete'} data-operator-costs-reason={card.financial.operatorCostsReason} data-complete-24h={card.complete24h ? 'true' : 'false'}>
    <Head name={`Position #${card.rootTokenId}`} href={`#/positions/${card.rootTokenId}`} status={status} title={reasonsText(card)} />
    <dl className="dm-mp-figs">{MAIN.map(field => <MetricCell key={field.name} field={field} card={card} />)}</dl>
    <details className="dm-details dm-mp-more">
      <summary>All figures</summary>
      <div>
        <dl className="dm-mp-figs">{MORE.map(field => <MetricCell key={field.name} field={field} card={card} />)}</dl>
        <p className="dm-acct-note">Automation <span className="dm-mono" title={card.vault} translate="no">{shortVault(card.vault)}</span></p>
      </div>
    </details>
  </li>
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
    {outcome.ok ? 'Tracking requested. Its figures show here once they are first read.' : enrollmentFailureText(outcome.reason)}
  </p>
}

/** One automation the wallet owns, named by its position; its address is only the row's title (2026-09-27, round 5 review). */
function SequenceRow({ row, view, onTrack }: { row: TrackableSequence; view: PerformanceView; onTrack(vault: string): void }) {
  const text = trackingText(view, row.vault)
  // Just sent: the outcome line below says so, and the button is not offered again.
  const sent = view.enrollment?.vault === row.vault && view.enrollment.ok
  return <li className="grid gap-1 py-2" title={row.vault} data-trackable-sequence={row.vault}>
    <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <span className="dm-acct-subtitle min-w-0">Position #{row.rootTokenId}</span>
      {text ? <span className="dm-acct-line text-fg-muted" data-tracking-state="">{text}</span>
        : !sent && <Button variant="outline" size="sm" disabled={view.busy || view.starting !== null} onClick={() => onTrack(row.vault)}>{view.starting === row.vault ? 'Starting…' : 'Start tracking'}</Button>}
    </div>
    <Outcome view={view} vault={row.vault} />
  </li>
}

/** Whether Start tracking has an automation of the wallet's to show: the history has answered and the wallet listed one. */
const trackable = ({ state, sequences }: PerformanceView) => state === 'ready' && sequences.state === 'ready' && (sequences.rows.length > 0 || sequences.older)
/** Whether one of them is left to track: a listed automation the service does not track, or an older one to name. */
const untracked = (view: PerformanceView) => view.sequences.older || view.sequences.rows.some(row => !trackingText(view, row.vault))

/**
 * The empty plate's sentence (2026-09-27, round 5 review): neutral until the
 * history and the wallet's automations are read; then Start tracking below
 * when it has one to offer, and Turn on Auto-compound only when the wallet
 * has none. Never both at once.
 */
function emptyText(view: PerformanceView): string {
  // While the session is checked with nothing kept: no line yet (2026-09-27, round 6), the check decides it in a moment.
  if (view.state === 'checking') return ''
  if (view.state !== 'ready' || view.sequences.state === 'idle' || view.sequences.state === 'reading') return MANAGED_APPEAR
  if (!trackable(view)) return NOTHING_YET
  return untracked(view) ? 'Nothing tracked yet: press Start tracking below.' : MANAGED_APPEAR
}
const NOTHING_YET = 'Nothing here yet. Turn on Auto-compound for a position and how it does shows here.'

/** Whether Start tracking is drawn below the plate (TrackSequences): an offer the person can act on. */
const offersTracking = (view: PerformanceView) => trackable(view) && (!!view.enrollment || untracked(view))

/**
 * What this card has to show, for Positions (2026-10-01, audit D2, lib/automationCards.ts): nothing while signed out
 * (the session's own reason) or once read with nothing yet, so the page can say one line for this card and Receipts;
 * a line of its own when the history could not be read; null while it is still being decided (the session checked
 * with nothing kept, the history or the wallet's automations on their way).
 */
function shows(view: PerformanceView, kind: Parameters<typeof signedOutLine>[0], empty: boolean): CardShows | null {
  if (view.state === 'signed_out') return { kind: 'none', reason: kind, ...signedOutLine(kind, 'both') }
  if (!empty || view.more || offersTracking(view)) return { kind: 'content' }
  if (view.state === 'checking' || view.state === 'loading' || (view.state === 'ready' && (view.sequences.state === 'idle' || view.sequences.state === 'reading'))) return null
  return emptyText(view) === NOTHING_YET ? { kind: 'none', reason: 'empty', text: NOTHING_YET_BOTH, action: null } : { kind: 'other' }
}

/**
 * Start tracking, offered for the sequences the owner's wallet lists. Nothing
 * is typed: each sequence's positions are read from its vault. Only when the
 * wallet created more sequences than the listing holds can an older one be
 * named by its address. Until the history service has answered, without a
 * deployment to read with, or while the wallet read fails, the block is left
 * out; why is in the section's data attributes. So it is once every listed
 * automation is tracked.
 */
function TrackSequences({ view, onTrack }: { view: PerformanceView; onTrack(vault: string): void }) {
  const [address, setAddress] = useState('')
  const { sequences } = view
  useEffect(() => { let key = sessionKey(livePort.getSnapshot()); return livePort.subscribe(() => { const next = sessionKey(livePort.getSnapshot()); if (next !== key) { key = next; setAddress('') } }) }, [])
  // Every automation the wallet lists already tracked, none older and nothing pressed here this visit: the rows above say it
  // all, so the block is left out rather than naming each position twice (2026-09-27, round 5 review).
  if (!trackable(view) || (!view.enrollment && !untracked(view))) return null
  const typed = address.toLowerCase()
  const listed = sequences.rows.some(row => row.vault === typed)
  const canType = /^0x[0-9a-f]{40}$/.test(typed) && !listed
  return <div className="dm-inset dm-acct-perf-form" data-track-sequences="">
    <h3 className="dm-acct-subtitle">Track your automations</h3>
    <p className="dm-hint">Tracking only watches how your automation is doing: it can’t move your funds or change anything.</p>
    {sequences.rows.length > 0 && <ul className="m-0 grid list-none divide-y divide-[var(--border)] p-0">{sequences.rows.map(row => <SequenceRow key={row.vault} row={row} view={view} onTrack={onTrack} />)}</ul>}
    {sequences.older && <details className="dm-details dm-acct-disclosure">
      <summary>An older automation</summary>
      <form className="dm-acct-disclosure-body" onSubmit={event => { event.preventDefault(); if (canType) onTrack(typed) }}>
        <label className="dm-label dm-acct-lf" htmlFor="perf-track-sequence">Automation address<input id="perf-track-sequence" name="sequence" className="dm-field dm-acct-mono-field" value={address} onChange={event => setAddress(event.target.value)} spellCheck={false} autoComplete="off" /></label>
        <Button variant="outline" size="sm" className="justify-self-start" type="submit" disabled={!canType || view.busy || view.starting !== null}>{view.starting === typed && canType ? 'Starting…' : 'Start tracking'}</Button>
        {canType && <Outcome view={view} vault={typed} />}
      </form>
    </details>}
  </div>
}

/**
 * What this browser kept of `owner`'s Managed positions (the first page, at
 * most six hours old: the figures are the last 24 hours'), each answer
 * checked against the contract again; null when there is none, or it is not.
 */
function keptManaged(owner: string): { enrollments: EpochsResponse['enrollments']; cards: CardsResponse['cards'] } | null {
  return readKept(walletName('managed', owner), 21_600_000, data => {
    const { epochs, cards } = (data ?? {}) as { epochs?: EpochsResponse; cards?: CardsResponse | null }
    return runtime.validateResponse('epochs', epochs) && epochs?.owner === owner && (cards === null || (runtime.validateResponse('cards', cards) && cards?.owner === owner))
      ? { enrollments: epochs.enrollments, cards: cards?.cards ?? [] } : null
  })
}

/**
 * One controller for every view of Managed positions, so the way back to
 * Positions shows at once what was read and reads at the service's own pace
 * (the owner, 2026-09-27, round 6: each view had its own, and started empty).
 */
const controller = createPerformanceController({ session: livePort, fetch: financialFetch, runtime, clock: realClock, visible: () => !document.hidden,
  sequences: walletSequenceReads(), cache: { load: keptManaged, save: (owner, epochs, cards) => keep(walletName('managed', owner), { epochs, cards }) } })
const watch = sharedStart(controller)

/** `onShows` (Positions, 2026-10-01, audit D2): told what this card has to show, after every render (lib/automationCards.ts). */
export default function Performance({ onShows }: { onShows?: (shows: CardShows | null) => void }) {
  const live = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  // Why there is no session, said as itself (2026-10-01, audit D2): sign-in may be switched off, the wallet elsewhere.
  const session = useSyncExternalStore(livePort.subscribe, livePort.getSnapshot)
  const out = signedOutLine(session.kind, 'managed')
  useEffect(watch, [])
  // While the wallet's session is checked, what this browser kept for it (the controller shows the same once signed in).
  const early = useKeptWhileChecking(live.state === 'checking', keptManaged)
  const view = early ? { ...live, ...early } : live
  const waiting = view.enrollments.filter(item => item.epochId === null)
  const empty = view.cards.length === 0 && waiting.length === 0
  const showing = shows(view, session.kind, empty)
  // Told after every render; the page keeps what it was told before when this says the same (sameShows).
  useEffect(() => onShows?.(showing))
  return <section aria-label="Private performance" className="dm-acct-perf" aria-busy={view.busy || undefined} data-performance={view.state} data-performance-reason={view.reason ?? undefined}
    data-sequences={view.sequences.state} data-sequences-reason={view.sequences.reason ?? undefined}>
    <h2 className="sr-only">Your strategy history</h2>
    {/* One plain line; how a missing figure shows is its title, and each cell's own title says why. */}
    <p className="dm-acct-desc" title="Missing prices and incomplete history show as dashes.">{MANAGED_LINE}</p>
    {view.state === 'signed_out' ? <Card level={2} className="dm-acct-plot dm-dots-chart" data-signed-out={session.kind}>
      <p>{out.text}</p>
      {out.action && <Button variant="outline" size="sm" onClick={openWalletDialog}>{out.action}</Button>}
    </Card> : <>
      {empty && <Card level={2} className="dm-acct-plot dm-dots-chart" title={view.reason ? `History could not be read: ${view.reason.replaceAll('_', ' ')}` : undefined}>
        {emptyText(view)}
      </Card>}
      {!empty && <ul className="dm-mp-list">
        {/* Named by its position, as the tracked rows are (2026-09-27, round 5 review): the service lists the ids in number
            order, and a sequence's first position is its oldest, so the first id is the one it started from. The automation's
            address is only the row's title. */}
        {waiting.map(item => <li className="dm-mp-row" key={item.enrollmentId} title={item.vault} data-enrollment-status={item.status} data-enrollment-reason={item.reason}>
          <Head name={`Position #${item.tokenIds[0]}`} href={`#/positions/${item.tokenIds[0]}`} status={ENROLLMENT_STATUS_TEXT[item.status]} />
          <p className="dm-acct-note">{ENROLLMENT_REASON_TEXT[item.reason]}</p>
        </li>)}
        {view.cards.map(card => <PerformanceCard key={card.epochId} card={card} />)}
      </ul>}
      {view.more && <Button className="justify-self-center" variant="ghost" size="sm" disabled={view.busy || view.paging} onClick={() => controller.nextPage()}>{view.paging ? 'Reading positions…' : 'Show more'}</Button>}
      <TrackSequences view={view} onTrack={vault => { void controller.track(vault) }} />
    </>}
  </section>
}
