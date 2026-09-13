import { IconArrowUpRight } from '../icons'
import { TokenIcon } from '../TokenIcon'
import { LinkButton, cx } from '../ui'

/**
 * The protocol under every Domino position, as a quiet strip at the foot of
 * the Selected pools card: Uniswap's own mark (the bundled artwork, nothing
 * behind it and no halo), one sentence, and a link to uniswap.org in a new tab.
 * Static: reads nothing.
 */
export function UniswapStrip({ className }: { className?: string }) {
  return (
    <div className={cx('flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6', className)}>
      <div className="flex min-w-0 items-center gap-4">
        <TokenIcon symbol="UNI" size={40} />
        <div className="min-w-0">
          <h3 className="text-lead font-medium text-fg">Built on Uniswap</h3>
          <p className="mt-0.5 text-[13px] leading-[18px] text-fg-muted">Every Domino position is a standard Uniswap position NFT on Robinhood Chain.</p>
        </div>
      </div>
      <LinkButton href="https://uniswap.org" target="_blank" rel="noreferrer" variant="outline" className="shrink-0 max-sm:w-full">
        uniswap.org
        <IconArrowUpRight size={14} />
        <span className="sr-only">, opens in a new tab</span>
      </LinkButton>
    </div>
  )
}
