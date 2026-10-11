import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { crosschainSessionAccess } from '../../finance/v2/http'
import { useWalletIdentity } from '../../lib/walletIdentity'
import { v2Chain } from '../../v2/chains'
import { destinationChoices } from '../../v2/crosschain/present'
import { ZERO_ADDRESS } from '../../v2/types'
import { inputsOf, type Amounts, type JourneyState } from '../journey/model/state'
import { tokenBook } from '../journey/tokens'
import { BringFunds, type FundingContinuation } from './BringFunds'
import { fundsPage } from './live'
import { lackingZapTokens } from './model'
import { fundsServices } from './services'
import { useS2Gate } from './useS2Gate'
import { REVIEW_GAS_RESERVE_WEI } from '../../lib/create/reviewPlan'

type Read = { key: string; balances: ReadonlyMap<string, bigint> | null }
export const zapFundingScope = (state: JourneyState, walletKey: string | null, flowKey: string): string =>
  JSON.stringify([flowKey, walletKey, state.chainId, state.pool?.id, state.range, state.amounts, state.slippage])

/** The advanced V2 amount stage shares the guided journey's funding offer and chain-scoped balance reader.
 * Arrival refreshes actual balances without moving the wallet or replacing the amounts already entered. */
export function ZapFunds({ state, onAmounts, flowKey = '', onContinuationChange }: {
  state: JourneyState
  onAmounts: (amounts: Amounts) => void
  flowKey?: string
  onContinuationChange?: (key: string, continuation: FundingContinuation) => void
}) {
  const identity = useWalletIdentity()
  const wallet = identity.kind === 'connected' ? identity.address.toLowerCase() : null
  const walletKey = identity.kind === 'connected' ? `${identity.connectorName}|${wallet}` : null
  const walletChainId = identity.kind === 'connected' ? identity.chainId : null
  const gate = useS2Gate(state.chainId)
  const access = useSyncExternalStore(crosschainSessionAccess.subscribe, crosschainSessionAccess.getSnapshot, () => 'pending')
  const services = useMemo(() => (gate && wallet !== null ? fundsServices(gate, wallet, fundsPage) : null), [gate, wallet])
  const [read, setRead] = useState<Read | null>(null)
  const [revision, refresh] = useState(0)
  const book = tokenBook(state.chainId, state.pool?.tokens ?? [])
  // Gas joins the same read. Unknown decimals never establish a spendable token amount.
  const tokensKey = [...new Set([ZERO_ADDRESS, ...[...book.values()].filter((token) => token.decimals !== null).map((token) => token.address.toLowerCase())])].sort().join(',')
  const key = `${walletKey}|${state.chainId}|${tokensKey}`
  const enabled = gate !== null && gate.mode !== 'off' && wallet !== null && state.pool !== null
  useEffect(() => {
    if (!enabled) return
    let wanted = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempts = 0
    const check = async () => {
      const reply = await services?.readBalances?.(state.chainId, tokensKey.split(',')).catch(() => undefined)
      if (!wanted) return
      if (reply?.kind === 'ok') {
        setRead({ key, balances: new Map(reply.snapshot.balances.map(({ token, raw }) => [token, BigInt(raw)])) })
        return
      }
      setRead({ key, balances: null })
      if (++attempts < 4 && services?.readBalances) {
        timer = setTimeout(() => void check(), Math.max(10_500, reply?.kind === 'unavailable' ? reply.retryAfterMs ?? 0 : 0))
      }
    }
    void check()
    return () => { wanted = false; clearTimeout(timer) }
  }, [enabled, services, state.chainId, tokensKey, key, revision])

  const current = read?.key === key ? read : null
  const balances = current?.balances ?? null
  const inputs = inputsOf(state)
  const intentKey = zapFundingScope(state, walletKey, flowKey)
  const currentIntent = useRef(intentKey)
  useEffect(() => { currentIntent.current = intentKey; return () => { currentIntent.current = '' } }, [intentKey])
  const lacks = lackingZapTokens({ chainId: state.chainId, inputs, balances })
  const missing = !!inputs?.some((input) => !balances?.has(input.token))
  const targets = destinationChoices().find((d) => d.chainId === state.chainId)?.tokens.map((token) => token.address) ?? []
  if (!enabled || !gate || wallet === null || walletKey === null) return null
  const useToken = (token: string) => {
    // The arriving balance is not a new spending instruction, even when it exceeds the chosen amount.
    if (state.amounts.text[token]) onAmounts(state.amounts)
    refresh((value) => value + 1)
  }
  const coversInputs = (available: ReadonlyMap<string, bigint> | null) => inputs !== null && inputs.length > 0 && available !== null && inputs.every((input) =>
    (available.get(input.token) ?? -1n) >= input.amount + (input.token === ZERO_ADDRESS ? REVIEW_GAS_RESERVE_WEI : 0n)) &&
    (available.get(ZERO_ADDRESS) ?? -1n) >= REVIEW_GAS_RESERVE_WEI
  const funded = coversInputs(balances)
  const continuationChanged = (continuation: FundingContinuation) => onContinuationChange?.(intentKey, continuation.state !== 'ready' ? continuation : {
    ...continuation,
    run: async () => {
      if (currentIntent.current !== intentKey || !inputs || !services?.readBalances) return false
      const reply = await services.readBalances(state.chainId, [...new Set([ZERO_ADDRESS, ...inputs.map((input) => input.token)])]).catch(() => undefined)
      if (currentIntent.current !== intentKey) return false
      const available = reply?.kind === 'ok' ? new Map(reply.snapshot.balances.map(({ token, raw }) => [token, BigInt(raw)])) : null
      setRead({ key, balances: available })
      if (!coversInputs(available)) { refresh((value) => value + 1); return false }
      return continuation.run()
    },
  })
  return (
    <div data-zap-funds="" className="dm-flow-stack">
      {missing && <p className="dm-hint" role="status" data-zap-funds-balance={current === null ? 'pending' : 'unavailable'}>
        {current === null ? 'Checking the tokens in your wallet…' : `Balances on ${v2Chain(state.chainId).name} could not be checked yet.`}
      </p>}
      <BringFunds key={`${walletKey}|${state.chainId}`} gate={gate} services={services}
        chainId={state.chainId} wallet={wallet} access={access} walletChainId={walletChainId}
        lacks={lacks} nativeOnDestination={balances?.get(ZERO_ADDRESS)?.toString() ?? null} intentKey={intentKey}
        onContinuationChange={onContinuationChange ? continuationChanged : undefined}
        onUseAvailable={funded ? (token) => {
          if (!inputs?.some((input) => input.token === token)) return false
          refresh((value) => value + 1)
          return true
        } : undefined}
        poolTokens={targets} onUse={(side) => { if (targets[side]) useToken(targets[side]) }} onArrived={() => refresh((n) => n + 1)} />
    </div>
  )
}
