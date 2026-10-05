import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { browserOriginWallet } from '../../finance/v2/crosschain'
import { createHoldingsCache, readHoldingsReport, type HoldingsReport, type OriginCandidate } from '../../finance/v2/holdings'
import { crosschainSessionAccess } from '../../finance/v2/http'
import { useWalletIdentity } from '../../lib/walletIdentity'
import { v2Chain } from '../../v2/chains'
import { destinationChoices } from '../../v2/crosschain/present'
import { ZERO_ADDRESS, type Address } from '../../v2/types'
import { inputsOf, type Amounts, type JourneyState } from '../journey/model/state'
import { tokenBook } from '../journey/tokens'
import { BringFunds } from './BringFunds'
import { fundsPage } from './live'
import { lackingZapTokens } from './model'
import { fundsServices } from './services'
import { useS2Gate } from './useS2Gate'

const cachedRead = createHoldingsCache()
type Read = { key: string; report: HoldingsReport | null }

/** The live V2 amount stage uses the same S2 quote, consent, sender and recovery as the legacy journey. Destination
 * balances come only from the already-connected wallet network. Typing does not reread, switch or sign anything. */
export function ZapFunds({ state, onAmounts }: { state: JourneyState; onAmounts: (amounts: Amounts) => void }) {
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
  // Unknown decimals stay unknown: that token is not used to establish a shortage.
  // Address labels make failed reads unambiguous even when two tokens share a symbol.
  const tokensKey = JSON.stringify([...book.values()].filter((token) => token.decimals !== null).map((token) => ({ address: token.address, symbol: token.address, decimals: token.decimals! })))
  const candidate = useMemo<OriginCandidate>(() => ({ chainId: state.chainId, name: v2Chain(state.chainId).name, tokens: JSON.parse(tokensKey) }), [state.chainId, tokensKey])
  const key = `${walletKey}|${state.chainId}|${tokensKey}`
  const enabled = gate !== null && gate.mode !== 'off' && wallet !== null && state.pool !== null
  useEffect(() => {
    if (!enabled || walletChainId !== candidate.chainId) return
    let wanted = true
    void cachedRead(key, async () => readHoldingsReport(await browserOriginWallet(), candidate), revision > 0)
      .then((report) => { if (wanted) setRead({ key, report }) })
      .catch(() => { if (wanted) setRead({ key, report: null }) })
    return () => { wanted = false }
  }, [enabled, walletChainId, candidate, key, revision])

  const current = read?.key === key ? read : null
  const balances = current?.report ? new Map(candidate.tokens.filter((t) => !current.report!.unread.includes(t.address)).map((t) => [t.address, current.report!.holdings.find((holding) => holding.token === t.address)?.raw ?? 0n])) : null
  const inputs = inputsOf(state)
  const lacks = lackingZapTokens({ chainId: state.chainId, inputs, balances })
  const missing = !!inputs?.some((input) => !balances?.has(input.token))
  const targets = destinationChoices().find((d) => d.chainId === state.chainId)?.tokens.map((token) => token.address) ?? []
  if (!enabled || !gate || wallet === null || walletKey === null) return null
  const useToken = (token: string, text: string) => {
    const isPoolToken = state.pool?.pool.currency0 === token || state.pool?.pool.currency1 === token
    // A newly selected funding token replaces the old inputs, without claiming the old desired position value.
    onAmounts({ mode: isPoolToken ? 'pool' : 'other', other: isPoolToken ? null : token as Address, text: { [token]: text } })
    refresh((value) => value + 1)
  }
  return (
    <div data-zap-funds="" className="dm-flow-stack">
      {missing && <p className="dm-hint" role="status" data-zap-funds-balance={current === null ? 'pending' : 'unavailable'}>
        {current === null && walletChainId === state.chainId ? 'Checking the tokens in your wallet…' : `Some balances on ${candidate.name} could not be checked. Your deposit will be checked again before confirmation.`}
      </p>}
      <BringFunds key={`${walletKey}|${state.chainId}|${state.pool?.id}`} gate={gate} services={services}
        chainId={state.chainId} wallet={wallet} access={access} walletChainId={walletChainId}
        lacks={lacks} nativeOnDestination={balances?.get(ZERO_ADDRESS)?.toString() ?? null}
        poolTokens={targets} onUse={(side, text) => { if (targets[side]) useToken(targets[side], text) }} onUseToken={useToken} onArrived={() => refresh((n) => n + 1)} />
    </div>
  )
}
