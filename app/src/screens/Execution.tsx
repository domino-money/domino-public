import { useEffect, useState, useSyncExternalStore } from 'react'
import * as runtime from 'api-contracts/execution-v1/runtime.mjs'
import { createExecutionController, EXECUTION_SETTLED, EXECUTION_STATE_NOTE, EXECUTION_STATE_TEXT, type ExecutionItem } from '../finance/execution'
import { financialFetch } from '../finance/http'
import { livePort } from '../session/livePort'
import { realClock } from '../lib/clock'
import { shortAmount } from '../lib/format/amount'
import { groupRaw, hundredthsToPercentText } from '../lib/raw'
import { formatUnits } from '../lib/read/decimal'
import { useReadSource } from '../lib/read/screens/readContext'
import { readWithin } from '../lib/read/screens/screenRead'
import { CopyButton } from '../components/read/screens/CopyButton'
import { IconChevronDown } from '../components/icons'
import { Button, LinkButton, Pill } from '../components/ui'

type Receipt = NonNullable<ExecutionItem['receipt']>
type AmountField = Exclude<keyof Receipt['sources'][number], 'sourceId' | 'currency'>

/** A closed code, readable in a title. Never shown as text. */
const words = (code: string) => code.replaceAll('_', ' ')
/** A hash or an address at a glance; the whole value is its title and its copy. */
const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`

/** Public token details as the token read path returned them. No entry means the read is still to come or on its way. */
type TokenDetail =
  /** `decimals` is null when the read could not give units to show. */
  | { state: 'read'; symbol: string | null; decimals: number | null }
  /** A busy or briefly unavailable read, asked again once `at` (monotonic ms) has passed while the tab is visible. */
  | { state: 'waiting'; reason: string; tries: number; at: number }
  | { state: 'failed'; reason: string }

const TOKEN_TRIES = 3
/** Token details read so far, for the page's life: a token's symbol and decimals never change, so the receipts page and the Positions preview show them at once. */
const known = new Map<string, TokenDetail>()

/**
 * Token details for the currencies the shown receipts name: one address at a
 * time on the app's one paced read source; each one read is kept (known). A read
 * the service answered as busy, or as briefly unavailable, is asked again up to
 * three more times, 5 s, 10 s then 20 s later, and only while the tab is
 * visible. Decimals are never guessed: anything else leaves the token unknown.
 */
function useTokenDetails(addresses: readonly string[]): ReadonlyMap<string, TokenDetail> {
  const source = useReadSource()
  const [details, setDetails] = useState<ReadonlyMap<string, TokenDetail>>(() => new Map(known))
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
        known.set(next, detail = { state: 'read', symbol: asset.symbol, decimals: asset.displayUnitsAvailable ? asset.decimals : null })
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

/** One token amount at a readable length, every digit in its title; a dash that says in its title why it is not. */
function Amount({ raw, detail }: { raw: bigint; detail: TokenDetail | undefined }) {
  const exact = `${groupRaw(String(raw))} in the token’s smallest units.`
  const units = detail?.state === 'read' && detail.decimals !== null ? formatUnits(String(raw), detail.decimals) : null
  if (detail?.state === 'read' && units?.kind === 'units') {
    return <span title={`${units.text}. ${exact}`} data-amount="units">{shortAmount(units.text).short}{detail.symbol ? ` ${detail.symbol}` : ''}</span>
  }
  const why = detail === undefined || detail.state === 'waiting' ? 'Reading token details.'
    : detail.state === 'failed' ? `Token details unavailable: ${words(detail.reason)}.` : 'Token decimals unavailable.'
  const reason = detail === undefined ? 'reading' : detail.state === 'read' ? 'decimals_unavailable' : detail.reason
  return <span title={`${why} ${exact}`} data-amount="unknown" data-amount-reason={reason}>—</span>
}

/** Each token's amount over the receipt's sources, `fields` added together, in the order the tokens first appear. */
function sums(receipt: Receipt, fields: readonly AmountField[]): Array<[string, bigint]> {
  const total = new Map<string, bigint>()
  for (const source of receipt.sources) {
    const key = source.currency.toLowerCase()
    total.set(key, fields.reduce((sum, field) => sum + BigInt(source[field]), total.get(key) ?? 0n))
  }
  return [...total]
}

/** Several tokens' amounts on one line: those above zero, or a plain zero when none is. */
function Amounts({ pairs, tokens }: { pairs: Array<[string, bigint]>; tokens: ReadonlyMap<string, TokenDetail> }) {
  const shown = pairs.filter(([, raw]) => raw > 0n)
  if (shown.length === 0) return '0'
  return shown.map(([currency, raw], index) => <span key={currency} data-receipt-currency={currency}>{index > 0 && ' + '}<Amount raw={raw} detail={tokens.get(currency)} /></span>)
}

/**
 * What a finalized receipt did, in four lines. Fees already charged earlier
 * count with the new ones they were used or kept beside; the service fee is
 * only ever taken from the new ones.
 */
const LINES: ReadonlyArray<readonly [string, readonly AmountField[]]> = [
  ['Fees used', ['grossOriginalConsumedRaw', 'chargedConsumedRaw']],
  ['Service fee', ['serviceFeeRaw']],
  ['Added to your position', ['liquidityAddedRaw']],
  ['Kept for next time', ['originalAfterRaw', 'chargedAfterRaw']],
]

/** A technical value in a receipt's detail: short, whole in its title and its copy. */
function Identity({ label, value, field }: { label: string; value: string; field: string }) {
  return <div data-receipt-field={field}>
    <dt>{label}</dt>
    <dd><span className="dm-mono" title={value} translate="no">{short(value)}</span><CopyButton value={value} label={`Copy ${label.toLowerCase()}`} /></dd>
  </div>
}

/** The chip a person scans for, in five plain words; the exact state is its title. */
const chip = (state: ExecutionItem['state']): readonly [string, 'in' | 'out' | 'neutral'] =>
  state === 'reconciled' ? ['Done', 'in'] : state === 'cancelled' ? ['Cancelled', 'neutral'] : state === 'reverted' ? ['Failed', 'out'] : state === 'attention' ? ['On hold', 'neutral'] : ['In progress', 'neutral']

/** A row's summary and its toggle: the chip, what happened, what it added. */
function Summary({ state, what, children }: { state: ExecutionItem['state']; what: string; children?: React.ReactNode }) {
  const [label, tone] = chip(state)
  return <summary>
    <Pill tone={tone} dot className="dm-rcpt-chip" title={EXECUTION_STATE_TEXT[state]}>{label}</Pill>
    <span className="dm-rcpt-what">{what}</span>
    {children}
    <IconChevronDown size={16} className="dm-rcpt-chevron" />
  </summary>
}

// "re-\u2060add": a word joiner after the hyphen keeps "re-adds" on one line (2026-09-27, round 5 review: it broke at the
// hyphen on desktop and phone). Geist has no non-breaking hyphen, so U+2011 would be drawn in a fallback font.
function ReceiptRow({ item, refreshFailed, tokens }: { item: ExecutionItem; refreshFailed: string | undefined; tokens: ReadonlyMap<string, TokenDetail> }) {
  const receipt = item.receipt
  const title = [item.reason ? words(item.reason) : null, refreshFailed ? `Last refresh failed: ${words(refreshFailed)}` : null].filter(Boolean).join('. ')
  const transaction = receipt?.transactionHash ?? item.attempts.at(-1)?.transactionHash
  return <li title={title || undefined} data-execution-intent={item.intentId} data-execution-state={item.state}
    data-execution-reason={item.reason || undefined} data-execution-can-cancel={item.canCancel ? 'true' : 'false'} data-execution-refresh-reason={refreshFailed}>
    <details className="dm-rcpt-row">
      <Summary state={item.state} what={item.state === 'reconciled' ? 'Fees re-\u2060added' : item.state === 'reverted' ? 'Fees not re-\u2060added' : 'Re-\u2060adding fees'}>
        {receipt && <span className="dm-rcpt-amount tnum" data-receipt-added=""><Amounts pairs={sums(receipt, ['liquidityAddedRaw'])} tokens={tokens} /></span>}
      </Summary>
      <div className="dm-rcpt-detail">
        {receipt ? <dl className="dm-rcpt-facts">{LINES.map(([label, fields]) => <div key={label} data-receipt-line={fields[0]}>
          <dt title={fields[0] === 'serviceFeeRaw' ? 'Operator gas is included in this fee.' : undefined}>{fields[0] === 'serviceFeeRaw' ? `${label} (${hundredthsToPercentText(String(receipt.serviceFeeBps)) ?? receipt.serviceFeeBps}%)` : label}</dt>
          <dd className="tnum"><Amounts pairs={sums(receipt, fields)} tokens={tokens} /></dd>
        </div>)}</dl> : <p className="dm-rcpt-note">{EXECUTION_STATE_NOTE[item.state]}</p>}
        {item.canCancel && <div className="dm-rcpt-stop" data-execution-stop="">
          <p className="dm-rcpt-note">It can still be stopped: pause your automation before it is signed.</p>
          {/* 2026-09-24: the sequence page no longer manages sequences (the owner's simpler page); how to pause is on the docs. */}
          <LinkButton href="#/docs/non-custodial#pause-revoke-withdraw" variant="outline" size="sm">How to pause</LinkButton>
        </div>}
        {/* The technical part, last and small: whole values are one copy away, never a link out of the app. */}
        <dl className="dm-rcpt-tech">
          {transaction && <Identity label="Transaction" field="transaction-hash" value={transaction} />}
          {receipt && <Identity label="Fee paid to" field="service-fee-recipient" value={receipt.serviceFeeRecipient} />}
          <Identity label="Receipt ID" field="intent" value={item.intentId} />
        </dl>
      </div>
    </details>
  </li>
}

/** Every receipt cancelled before anything was sent, as one row; each one's id is inside, its reason in its title. */
function CancelledRow({ items }: { items: readonly ExecutionItem[] }) {
  const one = items.length === 1
  return <li data-execution-cancelled={items.length}>
    <details className="dm-rcpt-row">
      <Summary state="cancelled" what={one ? 'Cancelled before sending' : `${items.length} cancelled before sending`} />
      <div className="dm-rcpt-detail">
        <p className="dm-rcpt-note">Automation stopped {one ? 'it' : 'these'} before sending anything, so nothing changed and no fee was charged.</p>
        <ul className="dm-rcpt-ids">{items.map(item => <li key={item.intentId} className="dm-mono" translate="no" title={[item.intentId, item.reason && words(item.reason)].filter(Boolean).join('. ')}
          data-execution-intent={item.intentId} data-execution-state={item.state} data-execution-reason={item.reason || undefined}>{short(item.intentId)}</li>)}</ul>
      </div>
    </details>
  </li>
}

/**
 * The rows, newest first as far as the receipts can tell (execution-v1 carries
 * no time, and lists by id): what is still under way first, then the
 * finished ones by block, latest first, then one row for every receipt
 * cancelled before it was sent.
 */
function rowsOf(items: readonly ExecutionItem[]): ExecutionItem[][] {
  const cancelled = items.filter(item => item.state === 'cancelled')
  const block = (item: ExecutionItem) => Number(item.receipt?.blockNumberRaw ?? -1)
  const rest = items.filter(item => item.state !== 'cancelled')
    .sort((a, b) => Number(EXECUTION_SETTLED.has(a.state)) - Number(EXECUTION_SETTLED.has(b.state)) || block(b) - block(a))
  return [...rest.map(item => [item]), ...(cancelled.length ? [cancelled] : [])]
}

/**
 * One controller for the Positions tab's preview and the receipts page, so See
 * all and the way back show what was already read and share execution-v1's one
 * read per 30 s (2026-09-27, round 5 review: each view had its own, and read
 * the first page again on every move between them). The first view shown
 * starts it; it stops once no view has shown it for a moment, since a route
 * change unmounts one view just before it mounts the next.
 */
const controller = createExecutionController({ session: livePort, fetch: financialFetch, runtime, clock: realClock, visible: () => !document.hidden })
// Told of every change of the tab's visibility; stopped, it reads nothing (and its start clears what it held).
document.addEventListener('visibilitychange', () => controller.visibilityChanged())
let views = 0, stop: (() => void) | undefined, parting: ReturnType<typeof setTimeout> | undefined
function watch() {
  clearTimeout(parting); views++
  stop ??= controller.start()
  return () => { if (!--views) parting = setTimeout(() => { stop?.(); stop = undefined }) }
}

/**
 * Receipts read themselves: signed in and visible, the first page arrives
 * with no control to press, and each receipt that can still change is
 * refreshed where it stands. While the service is off, busy or failing, the
 * card stays a neutral empty line; why is in its title and data attributes.
 * One short row per receipt, its detail one click away. `limit`: Positions'
 * short preview, at most that many rows (its card links the full page); the
 * full page shows every row read and reads the next page on Show more.
 */
export default function Execution({ limit }: { limit?: number }) {
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  useEffect(watch, [])
  const rows = rowsOf(view.items).slice(0, limit)
  const tokens = useTokenDetails(rows.flatMap(row => row[0].receipt?.sources.map(source => source.currency) ?? []))
  return <section className="dm-acct-exec" aria-label="Execution receipts" aria-busy={view.busy || undefined} data-execution={view.state} data-execution-reason={view.reason ?? undefined}
    data-execution-rows={rows.length}>
    <h2 className="sr-only">Execution receipts</h2>
    {/* One plain line; the rule for uncertain transactions is its title, and each receipt's chip says where it stands. */}
    <p className="dm-acct-desc" title="An uncertain or reorganized transaction is never shown as completed.">What automation did for your positions.</p>
    {view.state === 'signed_out' ? <p className="dm-acct-quiet">Sign in with your wallet to see your receipts.</p>
      : view.items.length === 0 ? <p className="dm-acct-quiet" title={view.reason ? `Receipts could not be read: ${words(view.reason)}` : undefined}>{view.state === 'ready' ? 'Nothing yet. Each time automation re-\u2060adds your fees, its receipt shows here.' : 'Receipts for this wallet appear here.'}</p>
      : <>
        <ol className="dm-rcpt-list">{rows.map(row => row[0].state === 'cancelled'
          ? <CancelledRow key="cancelled" items={row} />
          : <ReceiptRow key={row[0].intentId} item={row[0]} refreshFailed={view.refreshFailed[row[0].intentId]} tokens={tokens} />)}</ol>
        {limit === undefined && view.more && <Button className="justify-self-center" variant="ghost" size="sm" disabled={view.busy} onClick={() => controller.nextPage()}>{view.busy ? 'Reading receipts…' : 'Show more'}</Button>}
      </>}
  </section>
}
