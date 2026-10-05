import { useMemo, useSyncExternalStore } from 'react'
import { crosschainSessionAccess } from '../../finance/v2/http'
import type { PairBalancesState } from '../../components/create/usePairBalances'
import { rawBalances } from '../../components/create/valuation'
import { candidatesFromPool, takesOnly, type JourneyState } from '../../lib/create/journey'
import { reviewPlan } from '../../lib/create/reviewPlan'
import type { TokenCandidate } from '../../lib/read/screens/tokens'
import { useWalletIdentity } from '../../lib/walletIdentity'
import { isV2ChainId } from '../../v2/chains'
import type { V2ChainId } from '../../v2/types'
import { BringFunds } from './BringFunds'
import { fundsPage } from './live'
import { useS2Gate } from './useS2Gate'
import { lackingTokens } from './model'
import { fundsServices } from './services'

const ZERO = '0x0000000000000000000000000000000000000000'

/**
 * The inline "Bring {token} from {network}" offer under New position's amounts, in a build with Domino V2 (opened lazily
 * from components/create/StageAmount.tsx, behind the bare `__DOMINO_V2__` define, through components/Deferred.tsx: drawn
 * as soon as its chunk is in, nothing while it loads, nothing should it fail). V1's own amounts (PairedAmounts) are mounted
 * by the step itself, above this, never by this chunk, so the inputs never remount and the caret is never lost when the
 * chunk lands (review of 2026-10-03, #15). Here only the offer (./BringFunds.tsx), where the gate opens S2 on the
 * position's chain, only while the position can't be funded there at all, counting the one-token swap (decided [owner,
 * 2026-10-02 evening]; ./model.ts lackingTokens), for a token a deposit from another network can deliver.
 *
 * Everything the offer decides from is the amount step's own: the pool, the range, the typed amount, and the wallet's
 * balances as the step read them (Review's own plan for them, lib/create/reviewPlan.ts). When the deposit has
 * arrived, the same position continues through the step's own handlers: the typed token's field, or the other token's
 * row, exactly as typing in it would. The offer's services (./services.ts, over the page's parts in ./live.ts) exist
 * only under a `live` gate, which the crosschain route's own capabilities decide; otherwise they are null and the offer
 * runs locked, still reading what the wallet holds on other networks.
 */
export default function FundsAmounts({
  state,
  balances,
  onBudget,
  onDeposit,
  onArrived,
}: {
  state: JourneyState
  balances: PairBalancesState
  onBudget: (text: string) => void
  onDeposit: (candidate: TokenCandidate, text: string) => void
  /** Added 2026-10-05: funds brought from another network arrived; the amount step reads its balances again. */
  onArrived?: () => void
}) {
  const pool = state.pool
  const found = pool ? pool.currencies[0].chainId : null
  const chainId: V2ChainId | null = found !== null && isV2ChainId(found) ? found : null
  const gate = useS2Gate(chainId)
  const identity = useWalletIdentity()
  const access = useSyncExternalStore(crosschainSessionAccess.subscribe, crosschainSessionAccess.getSnapshot, () => 'pending')
  const wallet = identity.kind === 'connected' ? identity.address.toLowerCase() : null
  const services = useMemo(() => (gate && wallet !== null ? fundsServices(gate, wallet, fundsPage) : null), [gate, wallet])
  if (!pool || chainId === null || !gate || gate.mode === 'off' || wallet === null) return null

  const raw = rawBalances(balances)
  const planned = reviewPlan(state, raw)
  const typed = state.token ? pool.currencies.findIndex((currency) => currency.address === state.token?.key) : -1
  const independent: 0 | 1 | null = typed === 0 || typed === 1 ? typed : null
  const lacks = lackingTokens({
    chainId,
    currencies: [pool.currencies[0], pool.currencies[1]],
    balances: raw,
    plan: planned?.plan ?? null,
    only: takesOnly(state),
    independent,
  })
  // The amount step's own reading of ETH on the position's chain, when the pool holds ETH.
  const nativeSide = pool.currencies.findIndex((currency) => currency.address === ZERO)
  const nativeOnDestination = raw && (nativeSide === 0 || nativeSide === 1) ? raw[nativeSide] : null

  const use = (side: 0 | 1, text: string) => {
    if (side === independent) onBudget(text)
    else onDeposit(candidatesFromPool(pool)[side], text)
  }

  return (
    <BringFunds
      key={`${identity.kind === 'connected' ? identity.connectorName : ''}|${wallet}|${pool.key}`}
      gate={gate}
      services={services}
      chainId={chainId}
      wallet={wallet}
      access={access}
      walletChainId={identity.kind === 'connected' ? identity.chainId : null}
      lacks={lacks}
      nativeOnDestination={nativeOnDestination}
      poolTokens={[pool.currencies[0].address.toLowerCase(), pool.currencies[1].address.toLowerCase()]}
      onUse={use}
      onArrived={onArrived}
    />
  )
}
