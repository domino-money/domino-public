import { lazy, Suspense } from 'react'
import { Card, Display } from '../components/ui'
import { ChainPositionsSlot, SlotBoundary, SlotFailed } from '../lib/read/screens/slots'
const Performance = __DOMINO_WALLET_SESSION__ ? lazy(() => import('./Performance')) : null
const Execution = __DOMINO_WALLET_SESSION__ ? lazy(() => import('./Execution')) : null

/** Private history and receipts are scoped to the signed-in wallet. */
export function Dashboard() {
  return (
    <main className="mx-auto max-w-[1100px] px-5 py-10">
      <Display as="h1" className="text-[38px]">
        Your positions
      </Display>
      <p className="mt-2 max-w-[56ch] text-[14px] text-fg-muted">Your liquidity positions on Robinhood Chain. Your wallet stays their owner.</p>
      {__DOMINO_WALLET_SESSION__ && <div className="mt-4 flex flex-wrap gap-5"><a href="#/setup" className="underline underline-offset-4">Create or recover a position</a><a href="#/sequence" className="underline underline-offset-4">Create or manage a sequence</a><a href="#/pools" className="underline underline-offset-4">Explore pools</a></div>}
      {Performance && <Suspense fallback={<p role="status">Loading private history…</p>}><Performance /></Suspense>}
      {Execution && <Suspense fallback={<p role="status">Loading receipts…</p>}><Execution /></Suspense>}

      {!Performance && <Card className="mt-8 flex flex-col items-center gap-3 p-12 text-center" data-empty="positions">
        <p className="text-[16px] font-medium">Your positions will appear here</p>
        <p className="max-w-[48ch] text-[13px] leading-relaxed text-fg-muted">
          Look a position up by its id below. Finding every position a wallet holds comes with wallet discovery, which is not in the alpha yet.
        </p>
        <a
          href="#/pools"
          className="mt-1 inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] border border-line-strong px-4 py-2 text-[13px] font-medium transition hover:bg-surface-2"
        >
          Explore pools <span aria-hidden="true">→</span>
        </a>
      </Card>}

      {/* Public position NFTs, looked up by id: nothing is read until asked. */}
      {ChainPositionsSlot && SlotBoundary && SlotFailed && (
        <SlotBoundary
          fallback={
            <div className="mt-10">
              <SlotFailed />
            </div>
          }
        >
          <Suspense fallback={null}>
            <ChainPositionsSlot />
          </Suspense>
        </SlotBoundary>
      )}

      {!Performance && <Card level={2} className="mt-5 p-4 md:px-5">
        <h2 className="text-[14px] font-medium">Connect a wallet to see your positions</h2>
        <p className="mt-0.5 text-[12px] text-fg-muted">
          Sign in with the wallet control at the top of the page. Sign-in only proves your address. Deposit approvals and transactions are reviewed separately in setup.
        </p>
      </Card>}
    </main>
  )
}
