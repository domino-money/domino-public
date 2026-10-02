import { useEffect, useState, useSyncExternalStore } from 'react'
import * as runtime from 'api-contracts/execution-v1/runtime.mjs'
import { createExecutionController, EXECUTION_SETTLED, EXECUTION_STATE_NOTE, EXECUTION_STATE_TEXT, type ExecutionItem } from '../finance/execution'
import { financialFetch } from '../finance/http'
import { keep, keepFirst, readKept, sharedStart, useKeptWhileChecking, walletName } from '../finance/privateCards'
import { livePort } from '../session/livePort'
import { openWalletDialog, signedOutLine } from '../finance/signedOut'
import { realClock } from '../lib/clock'
import { NOTHING_YET_BOTH, type CardShows } from '../lib/automationCards'
import { shortAmount } from '../lib/format/amount'
import { groupRaw, hundredthsToPercentText } from '../lib/raw'
import { formatUnits } from '../lib/read/decimal'
import { chainToken } from '../lib/chainTokens'
import { chainRead } from '../lib/fees/answers'
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
/** How long this browser's copies stay shown: token details never change, and receipts are history (an open one is read again on sight). */
const KEPT_MS = 30 * 86_400_000
const ADDRESS = /^0x[0-9a-f]{40}$/
/** Kept token details, each an address with its symbol and decimals as the read path gave them; null when any is not. */
const keptTokens = (data: unknown): Array<[string, TokenDetail]> | null => Array.isArray(data) && data.length <= 64
  && data.every(([address, symbol, decimals]) => ADDRESS.test(address) && (symbol === null || (typeof symbol === 'string' && symbol.length <= 64)) && (decimals === null || (Number.isInteger(decimals) && decimals >= 0 && decimals <= 255)))
  ? data.map(([address, symbol, decimals]) => [address, { state: 'read', symbol, decimals }]) : null
/**
 * Token details read so far: a token's symbol and decimals never change, so
 * the receipts page and the Positions preview show them at once, and this
 * browser keeps them (public data) for the next visit (finance/privateCards.ts).
 */
const known = new Map<string, TokenDetail>(readKept('tokens', KEPT_MS, keptTokens))
/** Keeps the details read so far in this browser for the next visit. */
const keepKnown = () => keep('tokens', [...known].flatMap(([address, kept]) => kept.state === 'read' ? [[address, kept.symbol, kept.decimals]] : []).slice(-64))
/**
 * 2026-09-28 (speed wave B, item 25: Receipts named its tokens one at a time through the read path, 1.1 s apart, about
 * 2.7 to 4.5 s on a first visit): the tokens asked of the chain this visit. Before the read path, a token is named from
 * this visit's chain reads (lib/chainTokens.ts: the tokens the wallet's list and a position's state named). RPC-SPEC
 * (2026-10-01, the owner's rule: nothing is read from a public RPC): no other read of the chain; every other token goes on
 * to the read path (read-v1 `token`), as one the chain gave no decimals for always did.
 */
const onChain = new Set<string>()
async function fromChain(addresses: readonly string[]): Promise<Array<[string, TokenDetail]>> {
  return addresses.flatMap(address => {
    const token = chainToken(address)
    return token ? [[address, { state: 'read', symbol: token.symbol, decimals: token.decimals }]] : []
  })
}

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
    const fresh = chainRead() ? wanted.split(',').filter(address => details.get(address) === undefined && !onChain.has(address)) : []
    if (fresh.length > 0) {
      for (const address of fresh) onChain.add(address)
      void fromChain(fresh).then(found => {
        for (const [address, detail] of found) known.set(address, detail)
        if (found.length > 0) keepKnown()
        // Drawn again either way: a token the chain did not name goes on to the read path.
        setDetails(old => new Map([...old, ...found]))
      })
      return
    }
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
        keepKnown()
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
    // The symbol isolated in <bdi> (audit I2): a right-to-left control in it can never reorder the amounts around it.
    return <span title={`${units.text}. ${exact}`} data-amount="units">{shortAmount(units.text).short}{detail.symbol ? <> <bdi>{detail.symbol}</bdi></> : ''}</span>
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

// Changed on purpose (the owner, 2026-09-27, round 6): one plain phrase everywhere, the position page's "Fees added back"
// (it was "Fees re-added" here and "Re-added" on Managed positions).
function ReceiptRow({ item, refreshFailed, tokens }: { item: ExecutionItem; refreshFailed: string | undefined; tokens: ReadonlyMap<string, TokenDetail> }) {
  const receipt = item.receipt
  const title = [item.reason ? words(item.reason) : null, refreshFailed ? `Last refresh failed: ${words(refreshFailed)}` : null].filter(Boolean).join('. ')
  const transaction = receipt?.transactionHash ?? item.attempts.at(-1)?.transactionHash
  return <li title={title || undefined} data-execution-intent={item.intentId} data-execution-state={item.state}
    data-execution-reason={item.reason || undefined} data-execution-can-cancel={item.canCancel ? 'true' : 'false'} data-execution-refresh-reason={refreshFailed}>
    <details className="dm-rcpt-row">
      <Summary state={item.state} what={item.state === 'reconciled' ? 'Fees added back' : item.state === 'reverted' ? 'Fees not added back' : 'Adding fees back'}>
        {receipt && <span className="dm-rcpt-amount tnum" data-receipt-added=""><Amounts pairs={sums(receipt, ['liquidityAddedRaw'])} tokens={tokens} /></span>}
      </Summary>
      <div className="dm-rcpt-detail">
        {receipt ? <dl className="dm-rcpt-facts">{LINES.map(([label, fields]) => <div key={label} data-receipt-line={fields[0]}>
          <dt title={fields[0] === 'serviceFeeRaw' ? 'Operator gas is included in this fee.' : undefined}>{fields[0] === 'serviceFeeRaw' ? `${label} (${hundredthsToPercentText(String(receipt.serviceFeeBps)) ?? receipt.serviceFeeBps}%)` : label}</dt>
          <dd className="tnum"><Amounts pairs={sums(receipt, fields)} tokens={tokens} /></dd>
        </div>)}</dl> : <p className="dm-rcpt-note">{EXECUTION_STATE_NOTE[item.state]}</p>}
        {item.canCancel && <div className="dm-rcpt-stop" data-execution-stop="">
          <p className="dm-rcpt-note">It can still be stopped: press Pause on your position’s page before it is signed.</p>
          {/* 2026-09-24: the sequence page no longer manages sequences (the owner's simpler page); how to pause is on the docs.
              2026-10-01 (audit E18): the note says where Pause is; a receipt names no position to link to. */}
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

/** Receipts this browser keeps per wallet, the first rows first. */
const KEEP = 60
/**
 * The receipts this browser kept for `owner` (on Robinhood Chain), each one
 * checked as the contract's own status answer; null when there are none, or
 * any is not one.
 */
function keptReceipts(owner: string): ExecutionItem[] | null {
  return readKept(walletName('receipts', owner), KEPT_MS, data => Array.isArray(data) && data.length <= KEEP && new Set(data.map(item => item?.intentId)).size === data.length
    && data.every(item => runtime.validateResponse('status', { contractVersion: runtime.CONTRACT_VERSION, chainId: 4663, owner, item, executionAvailable: false })) ? data as ExecutionItem[] : null)
}

/**
 * One controller for the Positions tab's preview and the receipts page, so See
 * all and the way back show what was already read and share execution-v1's one
 * read per 30 s (2026-09-27, round 5 review: each view had its own, and read
 * the first page again on every move between them). The first view shown
 * starts it; it stops once no view has shown it for a moment, since a route
 * change unmounts one view just before it mounts the next.
 */
const controller = createExecutionController({ session: livePort, fetch: financialFetch, runtime, clock: realClock, visible: () => !document.hidden,
  cache: { load: keptReceipts, save: (owner, items) => keepFirst(walletName('receipts', owner), rowsOf(items).flat().slice(0, KEEP)) } })
// Hidden or stopped, it reads nothing and keeps what it shows.
const watch = sharedStart(controller)

/** Rows the receipts page shows at first, and adds on each Show more. */
const PAGE_ROWS = 10

/**
 * Receipts read themselves: signed in and visible, what this browser kept
 * shows at once and the list arrives with no control to press, merged into
 * the rows; each receipt that can still change is refreshed where it stands.
 * Nothing shown blanks for a refresh (the owner, 2026-09-27, round 6), and a
 * row opened, or rows shown with Show more, stay so. While the wallet's
 * session is checked, its kept receipts show. With nothing kept and the
 * service off, busy or failing, the card is a neutral empty line; why is in
 * its title and data attributes. One short row per receipt, its detail one
 * click away. `limit`: Positions' short preview, at most that many rows (its
 * card links the full page); the full page shows ten rows, and ten more on
 * each Show more, reading on past the receipts read when it runs out.
 */
export default function Execution({ limit, onShows }: { limit?: number; onShows?: (shows: CardShows | null) => void }) {
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  // Why there is no session, said as itself (2026-10-01, audit D2): sign-in may be switched off, the wallet elsewhere.
  const session = useSyncExternalStore(livePort.subscribe, livePort.getSnapshot)
  const out = signedOutLine(session.kind, 'receipts')
  useEffect(watch, [])
  const early = useKeptWhileChecking(view.state === 'checking', keptReceipts)
  const items = view.state === 'checking' ? early ?? [] : view.items
  // What this card has to show, for Positions (2026-10-01, audit D2, lib/automationCards.ts): nothing while signed out or
  // once read with none yet; a line of its own when the receipts could not be read; null while it is still being decided.
  // Told after every render; the page keeps what it was told before when this says the same.
  const showing: CardShows | null = view.state === 'signed_out' ? { kind: 'none', reason: session.kind, ...signedOutLine(session.kind, 'both') }
    : items.length > 0 ? { kind: 'content' }
      : view.state === 'checking' || view.state === 'loading' ? null
        : view.state === 'ready' ? { kind: 'none', reason: 'empty', text: NOTHING_YET_BOTH, action: null } : { kind: 'other' }
  useEffect(() => onShows?.(showing))
  const [shown, setShown] = useState(PAGE_ROWS)
  const all = rowsOf(items)
  const rows = all.slice(0, limit ?? shown)
  const hidden = all.length > rows.length
  const tokens = useTokenDetails(rows.flatMap(row => row[0].receipt?.sources.map(source => source.currency) ?? []))
  return <section className="dm-acct-exec" aria-label="Execution receipts" aria-busy={view.busy || view.reading || undefined} data-execution={view.state} data-execution-reason={view.reason ?? undefined}
    data-execution-rows={rows.length}>
    <h2 className="sr-only">Execution receipts</h2>
    {/* One plain line; the rule for uncertain transactions is its title, and each receipt's chip says where it stands. */}
    <p className="dm-acct-desc" title="An uncertain or reorganized transaction is never shown as completed.">What automation did for your positions.</p>
    {/* While the session is checked with nothing kept, the plate says nothing yet: the check is a moment, and its outcome decides the line. */}
    {view.state === 'signed_out' ? <div className="dm-acct-quiet" data-signed-out={session.kind}>
      <p>{out.text}</p>
      {out.action && <Button variant="outline" size="sm" onClick={openWalletDialog}>{out.action}</Button>}
    </div>
      : items.length === 0 ? <p className="dm-acct-quiet" title={view.reason ? `Receipts could not be read: ${words(view.reason)}` : undefined}>{view.state === 'ready' ? 'Nothing yet. Each time automation adds your fees back, its receipt shows here.' : view.state !== 'checking' && 'Receipts for this wallet appear here.'}</p>
      : <>
        <ol className="dm-rcpt-list">{rows.map(row => row[0].state === 'cancelled'
          ? <CancelledRow key="cancelled" items={row} />
          : <ReceiptRow key={row[0].intentId} item={row[0]} refreshFailed={view.refreshFailed[row[0].intentId]} tokens={tokens} />)}</ol>
        {limit === undefined && (hidden || view.more) && <Button className="justify-self-center" variant="ghost" size="sm" disabled={view.busy && !hidden}
          onClick={() => { setShown(shown + PAGE_ROWS); if (all.length <= shown + PAGE_ROWS) controller.nextPage() }}>{view.busy && !hidden ? 'Loading more…' : 'Show more'}</Button>}
      </>}
  </section>
}
