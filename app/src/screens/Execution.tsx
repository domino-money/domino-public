import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import * as runtime from 'api-contracts/execution-v1/runtime.mjs'
import { createExecutionController, EXECUTION_STATE_NOTE, EXECUTION_STATE_TEXT, type ExecutionItem } from '../finance/execution'
import { financialFetch } from '../finance/http'
import { livePort } from '../session/livePort'
import { realClock } from '../lib/clock'
import { groupRaw, hundredthsToPercentText } from '../lib/raw'
import { formatUnits } from '../lib/read/decimal'
import { useReadSource } from '../lib/read/screens/readContext'
import { readWithin } from '../lib/read/screens/screenRead'
import { CopyButton } from '../components/read/screens/CopyButton'
import { Button, Card, LinkButton } from '../components/ui'

type Receipt = NonNullable<ExecutionItem['receipt']>
type SourceAmounts = Receipt['sources'][number]

/** A closed code, readable in a title. Never shown as text. */
const words = (code: string) => code.replaceAll('_', ' ')

/** Public token details as the token read path returned them. No entry means the read is still to come or on its way. */
type TokenDetail =
  /** `decimals` is null when the read could not give units to show. */
  | { state: 'read'; symbol: string | null; decimals: number | null }
  /** A busy or briefly unavailable read, asked again once `at` (monotonic ms) has passed while the tab is visible. */
  | { state: 'waiting'; reason: string; tries: number; at: number }
  | { state: 'failed'; reason: string }

const TOKEN_TRIES = 3

/**
 * Token details for the currencies the shown receipts name: one address at a
 * time on the app's one paced read source, kept while the card is open. A read
 * the service answered as busy, or as briefly unavailable, is asked again up to
 * three more times, 5 s, 10 s then 20 s later, and only while the tab is
 * visible. Decimals are never guessed: anything else leaves the token unknown.
 */
function useTokenDetails(addresses: readonly string[]): ReadonlyMap<string, TokenDetail> {
  const source = useReadSource()
  const [details, setDetails] = useState<ReadonlyMap<string, TokenDetail>>(() => new Map())
  const [tick, setTick] = useState(0)
  const wanted = [...new Set(addresses.map(address => address.toLowerCase()))].sort().join(',')
  useEffect(() => {
    if (!source || !wanted) return
    const now = realClock.monoMs()
    const next = wanted.split(',').find(address => {
      const detail = details.get(address)
      return detail === undefined || (detail.state === 'waiting' && detail.at <= now && !document.hidden)
    })
    if (!next) return
    const last = details.get(next)
    const tries = last?.state === 'waiting' ? last.tries : 0
    const controller = new AbortController()
    void readWithin(source, 'token', { token: next }, { signal: controller.signal }).then(outcome => {
      if (controller.signal.aborted) return
      let detail: TokenDetail
      if (outcome.state === 'ok') {
        const asset = outcome.data.asset
        detail = { state: 'read', symbol: asset.symbol, decimals: asset.displayUnitsAvailable ? asset.decimals : null }
      } else {
        const reason = outcome.state === 'unavailable' ? (outcome.cause.kind === 'producer' ? outcome.cause.code : outcome.cause.kind) : outcome.state === 'local' ? outcome.code : outcome.state
        const transient = outcome.state === 'busy' || outcome.state === 'local' || (outcome.state === 'unavailable' && outcome.retryable)
        detail = transient && tries < TOKEN_TRIES ? { state: 'waiting', reason, tries: tries + 1, at: realClock.monoMs() + 5_000 * 2 ** tries } : { state: 'failed', reason }
      }
      setDetails(old => new Map(old).set(next, detail))
    })
    return () => controller.abort()
  }, [source, wanted, details, tick])
  // Wakes the reader when a waiting read is due, and again when a hidden tab is shown.
  useEffect(() => {
    const waiting = [...details.values()].flatMap(detail => detail.state === 'waiting' ? [detail.at] : [])
    if (waiting.length === 0) return
    const wake = () => { if (!document.hidden) setTick(n => n + 1) }
    const timer = setTimeout(wake, Math.max(0, Math.min(...waiting) - realClock.monoMs()))
    document.addEventListener('visibilitychange', wake)
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', wake) }
  }, [details])
  return details
}

/** One amount in token units, or a dash that says in its title why it is not. */
function Amount({ raw, detail }: { raw: string; detail: TokenDetail | undefined }) {
  const units = detail?.state === 'read' && detail.decimals !== null ? formatUnits(raw, detail.decimals) : null
  if (detail?.state === 'read' && units?.kind === 'units') {
    return <span title={`${groupRaw(raw)} in the token's smallest units.`} data-amount="units">{units.text}{detail.symbol ? ` ${detail.symbol}` : ''}</span>
  }
  const why = detail === undefined || detail.state === 'waiting' ? 'Reading token details.'
    : detail.state === 'failed' ? `Token details unavailable: ${words(detail.reason)}.` : 'Token decimals unavailable.'
  const reason = detail === undefined ? 'reading' : detail.state === 'read' ? 'decimals_unavailable' : detail.reason
  return <span title={`${why} ${groupRaw(raw)} in the token's smallest units.`} data-amount="unknown" data-amount-reason={reason}>—</span>
}

/** A full identity string with a copy button. Shown whole, never as a link. */
function Identity({ label, value, field }: { label: string; value: string; field: string }) {
  return <div className="grid min-w-0 gap-0.5" data-receipt-field={field}>
    <dt className="dm-acct-note">{label}</dt>
    <dd className="m-0 flex min-w-0 items-start gap-1">
      <span className="dm-acct-hash min-w-0 text-fg" translate="no">{value}</span>
      {/* Centred on the first line of the value, which may wrap on a phone. */}
      <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} className="-mt-[3px]" />
    </dd>
  </div>
}

const SOURCE_FIELDS: ReadonlyArray<readonly [Exclude<keyof SourceAmounts, 'sourceId' | 'currency'>, string]> = [
  ['grossOriginalConsumedRaw', 'Earned fees used'],
  ['chargedConsumedRaw', 'Already charged funds used'],
  ['serviceFeeRaw', 'Service fee'],
  ['liquidityAddedRaw', 'Added to liquidity'],
  ['originalAfterRaw', 'Earned fees left'],
  ['chargedAfterRaw', 'Charged funds left'],
]

function Source({ source, detail }: { source: SourceAmounts; detail: TokenDetail | undefined }) {
  const symbol = detail?.state === 'read' ? detail.symbol : null
  return <div className="grid min-w-0 gap-1" data-receipt-source={source.sourceId} data-receipt-currency={source.currency}>
    <p className="dm-acct-hash">Source {source.sourceId}<br />Token {source.currency}{symbol ? ` (${symbol})` : ''}</p>
    <dl className="dm-acct-metrics">{SOURCE_FIELDS.map(([name, label]) => <div key={name} data-source-field={name}>
      <dt>{label}</dt>
      <dd className="tnum"><Amount raw={source[name]} detail={detail} /></dd>
    </div>)}</dl>
  </div>
}

function ReceiptItem({ item, refreshFailed, tokens }: { item: ExecutionItem; refreshFailed: string | undefined; tokens: ReadonlyMap<string, TokenDetail> }) {
  const receipt = item.receipt
  const title = [item.reason ? words(item.reason) : null, refreshFailed ? `Last refresh failed: ${words(refreshFailed)}` : null].filter(Boolean).join('. ')
  return <Card level={2} className="dm-acct-exec-item" title={title || undefined} data-execution-intent={item.intentId} data-execution-state={item.state}
    data-execution-reason={item.reason || undefined} data-execution-can-cancel={item.canCancel ? 'true' : 'false'} data-execution-refresh-reason={refreshFailed}>
    <h3 className="dm-acct-subtitle">{EXECUTION_STATE_TEXT[item.state]}</h3>
    <p className="dm-acct-hash">Sequence {item.sequenceHash}<br />Intent {item.intentId}</p>
    {/* A finalized receipt names its own transaction below; the other attempts, if any, stay listed here. */}
    {item.attempts.filter(attempt => attempt.transactionHash !== receipt?.transactionHash).map(attempt => <p className="dm-acct-hash" key={attempt.transactionHash}>Transaction {attempt.ordinal + 1}: {attempt.transactionHash}</p>)}
    {receipt ? <>
      <p className="dm-acct-line">Finalized on the canonical chain at block {receipt.blockNumberRaw}.</p>
      <dl className="m-0 grid gap-2">
        <Identity label="Transaction hash" field="transaction-hash" value={receipt.transactionHash} />
        <Identity label="Block hash" field="block-hash" value={receipt.blockHash} />
        <Identity label="Service fee recipient" field="service-fee-recipient" value={receipt.serviceFeeRecipient} />
      </dl>
      <p className="dm-acct-line">Service fee: {hundredthsToPercentText(String(receipt.serviceFeeBps)) ?? receipt.serviceFeeBps}% of the earned fees used. Operator gas is included in that fee.</p>
      <p className="dm-acct-line">Liquidity added: {groupRaw(receipt.liquidityIncreaseRaw)} raw units.</p>
      {receipt.sources.map(source => <Source key={`${source.sourceId}:${source.currency}`} source={source} detail={tokens.get(source.currency.toLowerCase())} />)}
    </> : <p className="dm-acct-line text-fg-muted">{EXECUTION_STATE_NOTE[item.state]}</p>}
    {item.canCancel && <div className="dm-acct-choices" data-execution-stop="">
      <p className="dm-acct-line">It can still be stopped: pause your sequence before it is signed.</p>
      <LinkButton href="#/sequence" variant="outline" size="sm">Pause the sequence</LinkButton>
    </div>}
  </Card>
}

/**
 * Receipts read themselves: signed in and visible, the first page arrives
 * with no control to press, and each receipt that can still change is
 * refreshed where it stands. While the service is off, busy or failing, the
 * card stays a neutral empty line; why is in its title and data attributes.
 */
export default function Execution() {
  const controller = useMemo(() => createExecutionController({ session: livePort, fetch: financialFetch, runtime, clock: realClock, visible: () => !document.hidden }), [])
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  useEffect(() => { const stop = controller.start(), changed = () => controller.visibilityChanged(); document.addEventListener('visibilitychange', changed); return () => { document.removeEventListener('visibilitychange', changed); stop() } }, [controller])
  const tokens = useTokenDetails(view.items.flatMap(item => item.receipt?.sources.map(source => source.currency) ?? []))
  return <section className="dm-acct-exec" aria-label="Execution receipts" aria-busy={view.busy || undefined} data-execution={view.state} data-execution-reason={view.reason ?? undefined}>
    <h2 className="sr-only">Execution receipts</h2>
    {/* One plain line; the rule for uncertain transactions is its title, and each receipt's state says it in words. */}
    <p className="dm-acct-desc" title="An uncertain or reorganized transaction is never shown as completed.">Transactions automation sent for your sequences.</p>
    {view.state === 'signed_out' ? <p className="dm-acct-quiet">Sign in with your wallet to view private execution receipts.</p>
      : view.items.length === 0 ? <p className="dm-acct-quiet" title={view.reason ? `Receipts could not be read: ${words(view.reason)}` : undefined}>{view.state === 'ready' ? 'No receipts for this wallet.' : 'Receipts for this wallet appear here.'}</p>
      : <>
        {view.items.map(item => <ReceiptItem key={item.intentId} item={item} refreshFailed={view.refreshFailed[item.intentId]} tokens={tokens} />)}
        {view.more && <Button className="justify-self-start" variant="ghost" size="sm" disabled={view.busy} onClick={() => controller.nextPage()}>{view.busy ? 'Reading receipts…' : 'More receipts'}</Button>}
      </>}
  </section>
}
