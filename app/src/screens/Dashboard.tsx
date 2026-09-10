import { useState } from 'react'
import { useLocalWorkspace } from 'core/local-workspace'
import { practiceFunding } from 'core/practice'
import type { PracticeEvent, PracticePosition } from 'core/practice'
import { usd } from 'core/position'
import { pendingFeesExplanation } from 'core/compound'
import { PAIR, feeTier } from '../lib/pair'
import { CreatePositionFlow } from '../components/CreatePositionFlow'
import { PositionDetailFlow } from '../components/PositionDetailFlow'
import { ReceiptModal } from '../components/ReceiptModal'
import { TokenIcon, TokenPair } from '../components/TokenIcon'
import { Amount, Button, Card, Display, Pill, cx } from '../components/ui'

const total = (values: string[]) => values.reduce((acc, v) => acc + Number(v), 0)

type Filter = 'all' | 'on' | 'paused'

/* -------------------------------------------------------------------------- */

/** One position, one full-width row. Nothing has to wrap. */
function PositionRow({ position, index, onOpen }: { position: PracticePosition; index: number; onOpen: () => void }) {
  const markerPct = ((PAIR.startPrice - position.lower) / (position.upper - position.lower)) * 100
  const inRange = PAIR.startPrice >= position.lower && PAIR.startPrice < position.upper

  return (
    <button
      onClick={onOpen}
      aria-label={`Open practice card ${index + 1}`}
      className="group grid w-full grid-cols-[auto_1fr_auto] items-center gap-4 rounded-[var(--radius-lg)] border bg-surface-1 p-4 text-left transition hover:bg-surface-2 md:grid-cols-[minmax(220px,1.3fr)_minmax(180px,1.2fr)_minmax(120px,0.8fr)_minmax(120px,0.8fr)_auto] md:gap-6 md:px-5"
    >
      {/* Pair */}
      <div className="flex items-center gap-3">
        <TokenPair base={PAIR.token} quote={PAIR.stable} size={28} ring="var(--surface-1)" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="whitespace-nowrap text-[14px] font-medium">{PAIR.label}</span>
            <span className="whitespace-nowrap rounded-[6px] bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-fg-muted">v4 · {feeTier(PAIR.feePips)}</span>
          </div>
          <p className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-fg-subtle">
            <span>Card {String(index + 1).padStart(2, '0')}</span>
            <span className="flex items-center gap-1" style={{ color: inRange ? 'var(--money-in)' : 'var(--money-wait)' }}>
              <span className="h-1.5 w-1.5 rounded-full bg-current" /> {inRange ? 'In range' : 'Out of range'}
            </span>
          </p>
        </div>
      </div>

      {/* Range */}
      <div className="col-span-3 md:col-span-1">
        <div className="relative h-1.5 rounded-full bg-surface-3">
          <div className="absolute inset-y-0 rounded-full" style={{ left: '0%', width: '100%', background: 'var(--accent)' }} />
          <div className="absolute -top-1 h-3.5 w-[3px] rounded-full" style={{ left: `${markerPct}%`, background: 'var(--primary)' }} />
        </div>
        <div className="mt-1.5 flex justify-between font-mono text-[10.5px] text-fg-subtle">
          <span>Min {usd(position.lower)}</span>
          <span>Max {usd(position.upper)}</span>
        </div>
      </div>

      {/* Value */}
      <div className="hidden md:block">
        <p className="text-[11px] text-fg-subtle">Value at start</p>
        <p className="tnum mt-0.5 font-mono text-[14px]">{usd(position.amount + Number(position.netAddedUsd))}</p>
      </div>

      {/* Fees */}
      <div className="hidden md:block">
        <p className="text-[11px] text-fg-subtle">Reinvested · waiting</p>
        <p className="mt-0.5 text-[13px]">
          <Amount value={position.netAddedUsd} tone="in" /> <span className="text-fg-subtle">·</span> <Amount value={position.reservesUsd} tone="wait" />
        </p>
      </div>

      {/* Status */}
      <div className="flex items-center gap-3 justify-self-end">
        <Pill tone={position.enabled ? 'in' : 'wait'}>{position.enabled ? 'Practice on' : 'Paused'}</Pill>
        <span className="text-fg-subtle transition group-hover:translate-x-0.5" aria-hidden="true">›</span>
      </div>
    </button>
  )
}

/* -------------------------------------------------------------------------- */

function ActivityRow({ event, book, onReceipt }: { event: PracticeEvent; book: ReturnType<typeof useLocalWorkspace>['book']; onReceipt: () => void }) {
  const titles: Record<PracticeEvent['kind'], string> = {
    created: 'Practice card created',
    compound: 'Fees reinvested',
    paused: 'Practice paused',
    resumed: 'Practice resumed',
  }
  const d = event.decision
  const waiting = d?.decision === 'wait'
  const funding = d ? practiceFunding(book, event) : undefined
  const cardNumber = Math.max(1, book.positions.findIndex((p) => p.id === event.positionId) + 1)

  return (
    <Card className="p-4 md:px-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <TokenPair base={PAIR.token} quote={PAIR.stable} size={26} ring="var(--surface-1)" />
          <div>
            <h4 className="text-[14px] font-medium">{d ? (waiting ? 'Reinvestment waiting' : titles.compound) : titles[event.kind]}</h4>
            <p className="mt-0.5 font-mono text-[11px] text-fg-subtle">{new Date(event.at).toLocaleString('en-US')} · Card {String(cardNumber).padStart(2, '0')}</p>
          </div>
        </div>
        {d && (
          <div className="flex items-center gap-3">
            <Pill tone={waiting ? 'wait' : 'in'}>{waiting ? 'Waiting' : 'Eligible'}</Pill>
            <Button variant="outline" onClick={onReceipt}>View receipt</Button>
          </div>
        )}
      </div>

      {d && (
        <>
          <div className="mt-4 grid grid-cols-2 gap-4 border-t border-dashed pt-4 sm:grid-cols-4">
            {(
              [
                ['Fees used', d.consumedFeesUsd, 'neutral'],
                ['Reinvested', d.reinvestedUsd, 'in'],
                ['Service fee', d.serviceFeeUsd, 'out'],
                ['Still waiting', d.reserveUsd, 'wait'],
              ] as const
            ).map(([label, value, tone]) => (
              <div key={label}>
                <p className="text-[11px] text-fg-subtle">{label}</p>
                <p className="mt-0.5 text-[14px]"><Amount value={value} tone={tone} /></p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[12px] leading-relaxed text-fg-muted">
            {pendingFeesExplanation(d)}
            {funding && <> Made up of <Amount value={funding.waitingFeesUsd} /> previously waiting and <Amount value={funding.newFeesUsd} /> newly earned.</>}
          </p>
        </>
      )}
    </Card>
  )
}

/* -------------------------------------------------------------------------- */

function Stat({ label, value, tone, sub }: { label: string; value: number; tone: 'in' | 'out' | 'wait' | 'neutral'; sub: string }) {
  return (
    <Card className="p-5">
      <p className="text-[12px] text-fg-muted">{label}</p>
      <p className="mt-2 text-[26px] leading-none"><Amount value={value} tone={tone} /></p>
      <p className="mt-2 text-[12px] text-fg-subtle">{sub}</p>
    </Card>
  )
}

export function Dashboard() {
  const { book, notice, loaded, saveBook } = useLocalWorkspace()
  const [creating, setCreating] = useState(false)
  const [selected, setSelected] = useState('')
  const [receipt, setReceipt] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  const position = book.positions.find((p) => p.id === selected) ?? null
  const index = book.positions.findIndex((p) => p.id === selected)
  const receiptEvent = book.events.find((e) => e.id === receipt)

  const awaiting = total(book.positions.map((p) => p.reservesUsd))
  const reinvested = total(book.positions.map((p) => p.netAddedUsd))
  const service = total(book.positions.map((p) => p.servicePaidUsd))

  const visible = book.positions.filter((p) => (filter === 'all' ? true : filter === 'on' ? p.enabled : !p.enabled))

  return (
    <main className="mx-auto max-w-[1100px] px-5 py-10">
      {notice && <output className="mb-6 block rounded-[var(--radius)] px-4 py-3 text-[13px]" style={{ background: 'var(--money-out-bg)', color: 'var(--money-out)' }}>{notice}</output>}

      <div className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <Display as="h1" className="text-[38px]">Your positions</Display>
          <p className="mt-2 max-w-[56ch] text-[14px] text-fg-muted">Practice workspace on Robinhood Chain. Build positions, run fee scenarios and read every receipt. Nothing here touches a wallet.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => (window.location.hash = '#/#pools')}>Explore pools</Button>
          <Button onClick={() => setCreating(true)}>New position</Button>
        </div>
      </div>

      {/* Totals across all cards */}
      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <Stat label="Fees awaiting reinvestment" value={awaiting} tone="wait" sub="Held for you. Re-checked on every run, never charged twice." />
        <Stat label="Reinvested so far" value={reinvested} tone="in" sub="Added back into your practice positions." />
        <Stat label="Service fees simulated" value={service} tone="out" sub="Charged only on fees that were used. Details in each receipt." />
      </div>

      {/* Wallet, stated honestly */}
      <Card level={2} className="mt-5 flex flex-wrap items-center justify-between gap-4 p-4 md:px-5">
        <div className="flex items-center gap-4">
          <div className="flex" aria-hidden="true">
            {['ETH', 'USDG', 'WETH', 'MARLIN'].map((s, i) => (
              <TokenIcon key={s} symbol={s} size={26} ring="var(--surface-2)" style={{ marginLeft: i ? -8 : 0 }} />
            ))}
          </div>
          <div>
            <h2 className="text-[14px] font-medium">Connect a wallet to see live positions</h2>
            <p className="mt-0.5 text-[12px] text-fg-muted">Not part of this build yet. Practice cards below work without one.</p>
          </div>
        </div>
        <Button variant="outline" disabled title="Wallet connection is not implemented yet">Connect wallet</Button>
      </Card>

      {/* Positions */}
      <section className="mt-10">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[15px] font-medium">
            Practice cards <span className="tnum font-mono text-[13px] text-fg-subtle">{book.positions.length}</span>
          </h2>
          <div className="flex gap-1 rounded-[var(--radius-pill)] border bg-surface-1 p-1">
            {(
              [
                ['all', 'All'],
                ['on', 'Practice on'],
                ['paused', 'Paused'],
              ] as const
            ).map(([key, label]) => (
              <button key={key} onClick={() => setFilter(key)} aria-pressed={filter === key} className={cx('rounded-[var(--radius-pill)] px-3 py-1 text-[12px] transition', filter === key ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:text-fg')}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {!loaded ? (
          <Card className="p-10 text-center text-[13px] text-fg-subtle">Loading…</Card>
        ) : book.positions.length === 0 ? (
          <Card className="flex flex-col items-center gap-3 p-12 text-center">
            <TokenPair base={PAIR.token} quote={PAIR.stable} size={40} />
            <p className="mt-1 text-[16px] font-medium">Meet your first liquidity card.</p>
            <p className="max-w-[44ch] text-[13px] leading-relaxed text-fg-muted">Build a hypothetical {PAIR.label} position and see how a range behaves as the price moves.</p>
            <Button className="mt-1" onClick={() => setCreating(true)}>Let’s try it</Button>
            <p className="text-[12px] text-fg-subtle">About a minute. No funds needed.</p>
          </Card>
        ) : (
          <div className="grid gap-3">
            {visible.map((p) => (
              <PositionRow key={p.id} position={p} index={book.positions.indexOf(p)} onOpen={() => setSelected(p.id)} />
            ))}
            <button onClick={() => setCreating(true)} className="flex items-center justify-center gap-3 rounded-[var(--radius-lg)] border border-dashed p-4 text-[13px] text-fg-muted transition hover:bg-surface-1 hover:text-fg">
              <span className="text-[18px] leading-none">+</span> Room for one more. Try another range or starting value.
            </button>
          </div>
        )}
      </section>

      {/* Activity, one card per row at every width */}
      <section id="activity" className="mt-10 scroll-mt-24">
        <h2 className="mb-4 text-[15px] font-medium">Activity</h2>
        {book.events.length === 0 ? (
          <Card className="p-10 text-center text-[13px] text-fg-muted">Actions and receipts will appear here, newest first.</Card>
        ) : (
          <div className="grid gap-3">
            {book.events.map((event) => (
              <ActivityRow key={event.id} event={event} book={book} onReceipt={() => setReceipt(event.id)} />
            ))}
          </div>
        )}
      </section>

      <div className="mt-10 grid gap-4 md:grid-cols-2">
        <Card level={2} className="relative overflow-hidden p-6">
          <div className="pointer-events-none absolute -right-8 -top-8 h-32 w-32 rounded-full blur-2xl" style={{ background: 'var(--primary)', opacity: 0.25 }} aria-hidden="true" />
          <Pill tone="accent">Advanced</Pill>
          <h3 className="mt-3 font-display text-[22px]">Carry fees forward</h3>
          <p className="mt-2 text-[13px] leading-relaxed text-fg-muted">Near the top of its range, a card can send its earned fees to open the next one, higher up, instead of feeding itself. Your deposit never moves.</p>
          <p className="mt-3 text-[12px] text-fg-subtle">Invite only, after its own review. Not available in this workspace.</p>
        </Card>
        <Card className="p-6">
          <h3 className="text-[15px] font-medium">Practice mode</h3>
          <p className="mt-2 text-[13px] leading-relaxed text-fg-muted">Positions and receipts are stored in this browser only. No wallet connection, no chain read, no transaction. Nothing can be deposited or withdrawn.</p>
        </Card>
      </div>

      <CreatePositionFlow open={creating} onClose={() => setCreating(false)} saveBook={saveBook} />
      <PositionDetailFlow position={position} index={index} onClose={() => setSelected('')} saveBook={saveBook} />
      {receiptEvent?.decision && (
        <ReceiptModal event={receiptEvent} decision={receiptEvent.decision} funding={practiceFunding(book, receiptEvent)} cardNumber={Math.max(1, book.positions.findIndex((p) => p.id === receiptEvent.positionId) + 1)} onClose={() => setReceipt('')} />
      )}
    </main>
  )
}
