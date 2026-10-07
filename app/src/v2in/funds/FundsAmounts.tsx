import { useMemo, useSyncExternalStore } from 'react'
import { crosschainSessionAccess } from '../../finance/v2/http'
import type { PairBalancesState } from '../../components/create/usePairBalances'
import { rawBalances } from '../../components/create/valuation'
import { wholeFromOther } from '../../lib/create/depositPlan'
import { takesOnly, type JourneyState, type PayWith } from '../../lib/create/journey'
import type { PayFacts } from '../../lib/create/poolPrices'
import { reviewPlan, reviewTerms } from '../../lib/create/reviewPlan'
import type { TokenCandidate } from '../../lib/read/screens/tokens'
import { useWalletIdentity } from '../../lib/walletIdentity'
import { isV2ChainId } from '../../v2/chains'
import type { V2ChainId } from '../../v2/types'
import { BringFunds } from './BringFunds'
import { fundsPage } from './live'
import { useS2Gate } from './useS2Gate'
import { amountRawOf, keptAmount, lackingTokens, payLacks } from './model'
import { PayLine } from './PayWith'
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
 *
 * Changed on purpose 2026-10-06 (the owner, on production: AI/PONS and CASHCAT/AI short on Robinhood Chain, and no offer at
 * all, since neither token is one a deposit delivers): the deposit may also be paid with one other token, the network's
 * ETH or its stable, which Domino V2's zap swaps for the pool's two (lib/create/journey.ts PayWith; ./PayWith.tsx), where
 * Domino's service says what that would be (`pay`, lib/create/poolPrices.ts PayFacts: only where the network's S1 gate is
 * live and no token of the pool can be brought). Offered in one line while the wallet is short of the amounts typed, first,
 * outside the offer's card, whatever S2's gate says (the review of 2026-10-06); chosen, its one panel and the way back are
 * the step's own (components/create/PairedAmounts.tsx), and the offer under it is about that token (`poolTokens` that
 * token alone, what it lacks against the balance `pay` says, "Use" setting its amount).
 */
export default function FundsAmounts({
  state,
  balances,
  onArrived,
  onPayWith,
  pay,
}: {
  state: JourneyState
  balances: PairBalancesState
  onBudget: (text: string) => void
  onDeposit: (candidate: TokenCandidate, text: string) => void
  /** Added 2026-10-05: funds brought from another network arrived; the amount step reads its balances again. */
  onArrived?: () => void
  /** Added 2026-10-06: pay with one other token (lib/create/journey.ts PayWith), or with the pool's own again (null). */
  onPayWith?: (payWith: PayWith | null) => void
  /** Added 2026-10-06: what paying with one other token would be: null where it is not offered, undefined while read. */
  pay?: PayFacts | null
}) {
  const pool = state.pool
  const found = pool ? pool.currencies[0].chainId : null
  const chainId: V2ChainId | null = found !== null && isV2ChainId(found) ? found : null
  const gate = useS2Gate(chainId)
  const identity = useWalletIdentity()
  const access = useSyncExternalStore(crosschainSessionAccess.subscribe, crosschainSessionAccess.getSnapshot, () => 'pending')
  const wallet = identity.kind === 'connected' ? identity.address.toLowerCase() : null
  const services = useMemo(() => (gate && wallet !== null ? fundsServices(gate, wallet, fundsPage) : null), [gate, wallet])
  if (!pool || chainId === null) return null

  const raw = rawBalances(balances)
  const planned = reviewPlan(state, raw)
  const typed = state.token ? pool.currencies.findIndex((currency) => currency.address === state.token?.key) : -1
  const independent: 0 | 1 | null = typed === 0 || typed === 1 ? typed : null
  // Changed on purpose 2026-10-06 (the owner's point 2b): what the other token alone must be for the typed amount
  // (depositPlan's `whole`, on Review's own terms), so bringing it never means bringing everything held elsewhere.
  const terms = reviewTerms(state)
  const wholeOther = planned && terms ? wholeFromOther(terms, planned.independent, planned.need[0], planned.need[1], terms.slippageBps) : null
  const lacks = lackingTokens({
    chainId,
    currencies: [pool.currencies[0], pool.currencies[1]],
    balances: raw,
    plan: planned?.plan ?? null,
    independent,
    wholeOther,
  })
  // The amount step's own reading of ETH on the position's chain, when the pool holds ETH.
  const nativeSide = pool.currencies.findIndex((currency) => currency.address === ZERO)
  const nativeOnDestination = state.payWith && pay?.nativeRaw != null ? pay.nativeRaw.toString() : raw && (nativeSide === 0 || nativeSide === 1) ? raw[nativeSide] : null
  // Added 2026-10-06: the amount typed, once the wallet covers it (after an arrival): "Use" keeps it as it is.
  const keep = keptAmount(planned?.plan ?? null, independent, state.budget, independent !== null ? pool.currencies[independent].symbol : null, independent !== null ? pool.currencies[independent].decimals : null)
  // Added 2026-10-06 (the integration review): a range beside today's price takes one token alone (the amount step types
  // the amount in it): the offer brings that one, and never makes the other one the amount's token.
  const only = takesOnly(state)
  const takes = only === null ? null : { side: only, symbol: pool.currencies[only].symbol }

  // Added 2026-10-06: paid with one other token (its panel is the step's own, components/create/PairedAmounts.tsx), the
  // offer is about that token: its amount against its balance here as Domino's service read it (`pay`), as the zap path's
  // offer sizes its inputs (model.ts payLacks); "Use" after an arrival keeps that amount once covered.
  const paid = state.payWith
  const amount = paid && amountRawOf(paid.text, paid.token.decimals)
  const held = paid && pay?.token.chainId === paid.token.chainId && pay.token.address.toLowerCase() === paid.token.address.toLowerCase() ? pay.raw : null
  const paidLacks = paid ? payLacks(chainId, paid.token.address, paid.text, paid.token.decimals, held) : lacks

  return (
    <>
      {onPayWith && !paid && pay && planned?.plan?.kind === 'short' && <PayLine token={pay.token} pair={pool.currencies} onPay={() => onPayWith({ token: pay.token, text: '' })} />}
      {gate && gate.mode !== 'off' && wallet !== null && (
        <BringFunds
          key={`${identity.kind === 'connected' ? identity.connectorName : ''}|${wallet}`}
          gate={gate}
          services={services}
          chainId={chainId}
          intentKey={JSON.stringify([chainId, pool.key, state.range?.lower, state.range?.upper, paid ? [paid.token.chainId, paid.token.address.toLowerCase(), paid.text] : [state.token?.key, state.budget]])}
          wallet={wallet}
          access={access}
          walletChainId={identity.kind === 'connected' ? identity.chainId : null}
          lacks={paidLacks}
          nativeOnDestination={nativeOnDestination}
          poolTokens={paid ? [paid.token.address] : [pool.currencies[0].address.toLowerCase(), pool.currencies[1].address.toLowerCase()]}
          discreet={paid ? !amount : planned === null}
          shortSaid={!paid}
          keep={paid ? (held !== null && amount && paidLacks.length === 0 ? { side: 0, text: paid.text, label: `${paid.text} ${paid.token.symbol ?? ''}` } : null) : keep}
          takes={paid ? null : takes}
          // Arriving funds never replace the amount the person typed with a smaller or larger bridge result.
          onUse={() => onArrived?.()}
          onArrived={onArrived}
        />
      )}
    </>
  )
}
