import { Card, Display } from '../components/ui'

/**
 * Your positions, in the invited read-only alpha.
 *
 * There is nothing to list yet: finding a position takes a position lookup or
 * a wallet, and neither is part of this alpha. The screen says so, instead of
 * showing cards, totals, activity or receipts of any kind. A read-only lookup
 * by position id (#71) can replace this empty state; wallet discovery comes
 * after wallet sign-in has its own acceptance.
 */
export function Dashboard() {
  return (
    <main className="mx-auto max-w-[1100px] px-5 py-10">
      <Display as="h1" className="text-[38px]">
        Your positions
      </Display>
      <p className="mt-2 max-w-[56ch] text-[14px] text-fg-muted">Your liquidity positions on Robinhood Chain. Your wallet stays their owner.</p>

      <Card className="mt-8 flex flex-col items-center gap-3 p-12 text-center" data-empty="positions">
        <p className="text-[16px] font-medium">Your positions will appear here</p>
        <p className="max-w-[48ch] text-[13px] leading-relaxed text-fg-muted">Position lookup and wallet discovery are not available in the alpha.</p>
        <a
          href="#/#pools"
          className="mt-1 inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] border border-line-strong px-4 py-2 text-[13px] font-medium transition hover:bg-surface-2"
        >
          See the selected pools <span aria-hidden="true">→</span>
        </a>
      </Card>

      <Card level={2} className="mt-5 p-4 md:px-5">
        <h2 className="text-[14px] font-medium">Connect a wallet to see your positions</h2>
        <p className="mt-0.5 text-[12px] text-fg-muted">
          Sign in with the wallet control at the top of the page. It only proves you control an address: nothing here asks your wallet to
          approve, send or sign anything else.
        </p>
      </Card>
    </main>
  )
}
