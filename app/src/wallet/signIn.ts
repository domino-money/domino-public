import { useSyncExternalStore } from 'react'
import { createSignInFlow } from '../session/signInFlow'
import { CROSSCHAIN_ORIGIN_CHAIN_IDS } from '../session/machine'
import { V2_CHAIN_IDS } from '../config/chainIdentity'
import { networkName } from '../lib/networkName'
import { describe } from '../components/wallet/copy'
import { switchToRobinhood, switchToChain, switchToOrigin, v2SwitchNotice, type ChainSwitchOutcome } from './port'
import { sessionController } from './session'

export const signInFlow = createSignInFlow({
  getSnapshot: sessionController.getSnapshot,
  subscribe: sessionController.subscribe,
  dispatch: sessionController.dispatch,
  switchNetwork: (chainId) => __DOMINO_V2__ ? V2_CHAIN_IDS.includes(chainId) ? switchToChain(chainId) : switchToOrigin(chainId) : switchToRobinhood(),
  networkName,
  canReturn: (chainId) => __DOMINO_V2__ && (V2_CHAIN_IDS.includes(chainId) || CROSSCHAIN_ORIGIN_CHAIN_IDS.includes(chainId)),
  explain: (snapshot) => describe(snapshot.view, snapshot.away),
  switchError: (outcome, chainId) => v2SwitchNotice(outcome as Exclude<ChainSwitchOutcome, 'switched'>, networkName(chainId)),
})
export const useSignInProgress = () => useSyncExternalStore(signInFlow.subscribe, signInFlow.getSnapshot)
