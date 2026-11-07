/**
 * Whether a Base or Arbitrum One position's pool can be opened from its Details (added 2026-11-06, review F1 and UI-2 of
 * the integrated branch): the network's pool page (screens/PoolDetail.tsx NetworkPoolFound) and New position's network
 * link find a pool only in that network's pools read for the token the link names (read-v6 chain-pools), which lists a
 * pool only while it is priced and holds active liquidity. So Details offers Pool and New position in this pool there only
 * once that read lists the position's pool; otherwise neither, as Robinhood Chain offers none for a pool it cannot open,
 * never a link to "We couldn't find this pool". `token`: journey/model/networks.ts networkPoolToken.
 *
 * One read per pool and token, shared with the pool page it opens (journey/served.ts chainPoolsOn: one answer for every
 * caller of the page within 20 s); a failure is asked again once after a quiet wait (`patiently`), then no link.
 */
import { poolsOfAnswer } from '../journey/model/chainReads'
import { chainPoolsOn, patiently, type ReadGate } from '../journey/served'
import type { OtherChainId } from '../../lib/create/otherChains'
import type { Address } from '../../v2/types'

export async function networkPoolListed(gate: ReadGate, chainId: OtherChainId, token: Address, poolId: string, signal: AbortSignal): Promise<boolean> {
  const said = await patiently(() => chainPoolsOn(gate, chainId, token), signal)
  if (signal.aborted || said.kind !== 'ok' || said.body.chainId !== chainId || said.body.token.toLowerCase() !== token.toLowerCase()) return false
  const key = poolId.toLowerCase()
  return poolsOfAnswer(chainId, null, said.body, said.receivedAt).some((option) => option.key.toLowerCase() === key)
}
