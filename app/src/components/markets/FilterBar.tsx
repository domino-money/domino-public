import { catalogueTokens } from '../../config/selectedPoolCatalogue'
import { useFeatured } from '../../lib/read/featuredSource'
import { unreadToken } from '../../lib/read/project'
import { TokenMark } from '../TokenIcon'
import { SearchField, Select } from '../ui'

/**
 * The two ways to narrow the selected pools on Markets: one token, from the
 * tokens the list on screen names by address (lib/read/featuredSource.ts),
 * and a few letters of a pair's name.
 * Both live in the page's state only: nothing is read, stored or put in the
 * address bar, and typing reads nothing.
 */
export function FilterBar({
  asset,
  query,
  onAsset,
  onQuery,
}: {
  asset: string | null
  query: string
  onAsset: (asset: string | null) => void
  onQuery: (query: string) => void
}) {
  const featured = useFeatured()
  const options = [
    { value: null, label: 'All tokens', separatorAfter: true },
    ...catalogueTokens(featured.entries).map((token) => ({
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
      <SearchField
        id="markets-search"
        aria-label="Filter selected pools by pair name"
        placeholder="Pair name"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        className="dm-mkt-search"
      />
    </div>
  )
}
