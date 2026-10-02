/**
 * The second chain's own bar under the site's header (2026-10-01, the chain2 workstream): which network this part of the
 * site reads, its three pages, and the wallet chosen for it.
 */
import { Button, Chip, Pill, cx } from '../../../components/ui'
import { useSection } from './context'
import { shortAddress } from '../present'
import { sectionHref, type SectionScreen } from './routes'

const TABS: ReadonlyArray<{ screen: SectionScreen; label: string; also: readonly SectionScreen[] }> = [
  { screen: 'markets', label: 'Markets', also: ['pool'] },
  { screen: 'positions', label: 'Your positions', also: ['position', 'new'] },
  { screen: 'receipts', label: 'Receipts', also: [] },
]

export function SectionNav({ screen }: { screen: SectionScreen }) {
  const { chain, wallet, connect, source } = useSection()
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3" data-chain2-nav="">
      <div className="flex flex-wrap items-center gap-2">
        <Chip variant="plate">{chain.name}</Chip>
        {chain.network === 'testnet' && <Pill tone="wait">Testnet</Pill>}
        {source.kind === 'rehearsal' && <Pill tone="neutral" title="Pools and vaults from Domino's test run on this network">Test run</Pill>}
      </div>
      <nav aria-label={`${chain.name} pages`} className="flex flex-wrap items-center gap-1">
        {TABS.map((tab) => {
          const active = tab.screen === screen || tab.also.includes(screen)
          return (
            <a key={tab.screen} href={sectionHref(chain, tab.screen)} aria-current={active ? 'page' : undefined} className={cx('dm-btn dm-btn--sm', active ? 'dm-btn--secondary' : 'dm-btn--ghost')}>
              {tab.label}
            </a>
          )
        })}
        <Button size="sm" variant={wallet.account ? 'secondary' : 'soft'} onClick={connect} data-chain2-wallet-button="">
          {wallet.account ? (
            <>
              <span className="font-mono">{shortAddress(wallet.account)}</span>
              {!wallet.onChain && <span className="text-fg-subtle">· other network</span>}
            </>
          ) : (
            'Connect wallet'
          )}
        </Button>
      </nav>
    </div>
  )
}
