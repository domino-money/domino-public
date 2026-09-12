import { lazy, Suspense } from 'react'
import { SlotBoundary, SlotFailed } from '../lib/read/screens/slots'
import { Display, Eyebrow, Pill } from '../components/ui'

const Explorer = lazy(() => import('../components/read/screens/PoolExplorer').then((m) => ({ default: m.PoolExplorer })))

/** Public exploration only. The route itself starts no read. */
export function Pools() {
  return (
    <main className="mx-auto max-w-[1100px] px-5 py-8 sm:py-10">
      <div className="flex flex-wrap items-center gap-3">
        <Eyebrow>Uniswap v4 · Robinhood Chain</Eyebrow>
        <Pill tone="accent">Read-only explorer</Pill>
      </div>
      <Display as="h1" className="mt-4 text-[38px] sm:text-[46px]">Explore pools</Display>
      <p className="mt-3 text-[14px] leading-relaxed text-fg-muted">Choose your tokens. Find a pool. Explore its range.</p>
      {SlotBoundary && SlotFailed && (
        <SlotBoundary fallback={<SlotFailed />}>
          <Suspense fallback={<p role="status" className="mt-8 text-[13px] text-fg-muted">Loading pool explorer…</p>}>
            <Explorer />
          </Suspense>
        </SlotBoundary>
      )}
      <div className="mt-5 flex flex-wrap justify-between gap-3 text-[12px] text-fg-subtle">
        <p>Public data only. No deposits, approvals or signatures.</p>
        <a href="#/#pools" className="underline underline-offset-4 hover:text-fg">View selected pools</a>
      </div>
    </main>
  )
}
