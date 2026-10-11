import { useMemo, useState, useSyncExternalStore } from 'react'
import { crosschainSessionAccess } from '../../finance/v2/http'
import type { PairBalancesState } from '../../components/create/usePairBalances'
import { rawBalances, usdOf } from '../../components/create/valuation'
import { paymentEstimate, preferredPayment } from '../../lib/create/payFunding'
import { wholeFromOther } from '../../lib/create/depositPlan'
import { takesOnly, type JourneyState, type PayWith } from '../../lib/create/journey'
import type { PayFacts } from '../../lib/create/poolPrices'
import { reviewPlan, reviewTerms } from '../../lib/create/reviewPlan'
import { maxSpend, REVIEW_GAS_RESERVE_WEI } from '../../lib/create/reviewPlan'
import type { TokenCandidate } from '../../lib/read/screens/tokens'
import { useWalletIdentity } from '../../lib/walletIdentity'
import { isV2ChainId } from '../../v2/chains'
import type { V2ChainId } from '../../v2/types'
import { BringFunds } from './BringFunds'
import { fundsPage } from './live'
import { useS2Gate } from './useS2Gate'
import { amountRawOf, keptAmount, lackingTokens, payLacks } from './model'
import { remoteFundingChoice, remotePayment } from './fundingBudget'
import { fundingContext } from '../../lib/create/fundingContext'
import type { FundingContinuation } from './BringFunds'
import { PayLine } from './PayWith'
import { fundsServices } from './services'

const ZERO = '0x0000000000000000000000000000000000000000'

/** Funding assistance below the stable amount inputs. S1 local conversion remains independent of S2 bridging. */
export default function FundsAmounts({
  state,
  balances,
  onArrived,
  onPayWith,
  pay,
  flowKey = '',
  onContinuationChange,
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
  flowKey?: string
  onContinuationChange?: (key: string, continuation: FundingContinuation) => void
}) {
  const pool = state.pool
  const found = pool ? pool.currencies[0].chainId : null
  const chainId: V2ChainId | null = found !== null && isV2ChainId(found) ? found : null
  const gate = useS2Gate(chainId)
  const identity = useWalletIdentity()
  const access = useSyncExternalStore(crosschainSessionAccess.subscribe, crosschainSessionAccess.getSnapshot, () => 'pending')
  const wallet = identity.kind === 'connected' ? identity.address.toLowerCase() : null
  const services = useMemo(() => (gate && wallet !== null ? fundsServices(gate, wallet, fundsPage) : null), [gate, wallet])
  const [tracking, setTracking] = useState<string | null>(null)
  const trackingKey = `${wallet}|${chainId}`
  const contextKey = fundingContext(state, identity.kind === 'connected' ? `${identity.connectorName}|${wallet}` : '', flowKey)
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
  const nativeOnDestination = raw && (nativeSide === 0 || nativeSide === 1) && raw[nativeSide] !== null ? raw[nativeSide] : !pay?.stale && pay?.nativeRaw != null ? pay.nativeRaw.toString() : null
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
  const held = paid && !pay?.stale && pay?.token.chainId === paid.token.chainId && pay.token.address.toLowerCase() === paid.token.address.toLowerCase() ? pay.raw : null
  const paidLacks = paid ? payLacks(chainId, paid.token.address, paid.text, paid.token.decimals, held) : lacks
  const totalUsd = planned ? usdOf(pool, planned.need) : null
  const alternative = preferredPayment(pay, totalUsd)
  const estimate = alternative ? paymentEstimate(totalUsd, alternative) : null
  const offerPayment = !!onPayWith && !paid && alternative !== null && (planned === null || planned.plan?.kind === 'short')
  const localAvailable = alternative?.raw != null ? maxSpend(alternative.raw, alternative.token.address === ZERO) : 0n
  const localGas = alternative?.token.address === ZERO || (alternative?.nativeRaw != null && alternative.nativeRaw >= REVIEW_GAS_RESERVE_WEI)
  const usableLocal = offerPayment && localGas && localAvailable > 0n && (planned === null || (estimate !== null && localAvailable >= estimate.raw))
  const choosePayment = () => {
    if (alternative && onPayWith) onPayWith({ token: alternative.token, text: estimate?.text ?? '', ...(estimate ? { estimated: true } : {}) })
  }
  const remote = remoteFundingChoice({ state, planned, pay, alternative, nativeRaw: nativeOnDestination })
  const showPayment = offerPayment && !(remote?.payment && localAvailable <= 0n)
  const poolTokens = pool.currencies.map((currency) => currency.address.toLowerCase())
  const conversionAfterArrival = !paid && !!onPayWith
  const selectionKey = JSON.stringify([flowKey, chainId, pool.key, state.range?.lower, state.range?.upper, state.slippageBps, paid ? [paid.token.chainId, paid.token.address.toLowerCase()] : state.token?.key])

  return (
    <>
      {tracking !== trackingKey && showPayment && alternative && <PayLine facts={alternative} pair={pool.currencies} onPay={choosePayment} />}
      {gate && gate.mode !== 'off' && wallet !== null && (
        <BringFunds
          key={`${identity.kind === 'connected' ? identity.connectorName : ''}|${wallet}`}
          gate={gate}
          optional={usableLocal || remote !== null}
          remoteBudget={remote?.budget}
          selectionKey={selectionKey}
          checking={paid ? pay === undefined || held === null : raw === null}
          services={services}
          onTrackingChange={(active) => setTracking((was) => active ? trackingKey : was === trackingKey ? null : was)}
          onContinuationChange={onContinuationChange ? (value) => onContinuationChange(contextKey, value) : undefined}
          onUseAvailable={usableLocal && alternative ? (token) => {
            if (alternative.token.address.toLowerCase() !== token.toLowerCase()) return false
            choosePayment()
            return true
          } : undefined}
          continuation={usableLocal && alternative ? <PayLine facts={alternative} pair={pool.currencies} onPay={choosePayment} /> : null}
          chainId={chainId}
          intentKey={JSON.stringify([flowKey, chainId, pool.key, state.range?.lower, state.range?.upper, state.slippageBps, paid ? [paid.token.chainId, paid.token.address.toLowerCase(), paid.text] : [state.token?.key, state.budget]])}
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
          onRemoteUse={conversionAfterArrival ? (token, inputRaw) => {
            const payment = remotePayment(chainId, poolTokens, token, inputRaw)
            if (payment) onPayWith?.(payment)
          } : undefined}
          onArrived={onArrived}
        />
      )}
    </>
  )
}
