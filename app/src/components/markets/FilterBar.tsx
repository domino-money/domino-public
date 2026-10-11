import { catalogueTokens } from '../../config/selectedPoolCatalogue'
import { useFeatured } from '../../lib/read/featuredSource'
import { READ_CURRENCIES } from '../../lib/read/screens/featuredPools'
import { unreadToken } from '../../lib/read/project'
import { TokenMark } from '../TokenIcon'
import { Select } from '../ui'

/**
 * Narrow the selected pools by one token from the list on screen.
 * The page owns this local filter; the main search discovers other pools.
 */
export function FilterBar({
  asset,
  onAsset,
}: {
  asset: string | null
  onAsset: (asset: string | null) => void
}) {
  const featured = useFeatured()
  const options = [
    { value: null, label: 'All tokens', separatorAfter: true },
    // An embedded row without addresses (ETH/USDG) names its tokens by its pool's read currencies, for this filter only
    // (audit B9, 2026-10-01): the catalogue itself never carries native ETH's zero address.
    ...catalogueTokens(featured.entries.map((entry) => (entry.addresses || !READ_CURRENCIES[entry.poolId] ? entry : { ...entry, addresses: READ_CURRENCIES[entry.poolId] }))).map((token) => ({
      value: token.address,
      // Text only, in <bdi>: a featured list's labels are its symbols, untrusted text.
      label: <bdi>{token.label}</bdi>,
      // Bundled artwork by address when there is some; otherwise the same mark the pool rows use.
      icon: <TokenMark token={{ ...unreadToken(token.address), artwork: token.artwork }} size={16} />,
    })),
  ]
  return (
    <div className="dm-mkt-filters">
      <Select<string | null> id="markets-asset" label="Asset" value={asset} options={options} onChange={onAsset} className="dm-mkt-asset" />
    </div>
  )
}
