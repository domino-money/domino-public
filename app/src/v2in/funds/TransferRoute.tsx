import { TokenIcon } from '../../components/TokenIcon'
import { FUNDING_NETWORKS, NetworkMark } from '../../components/home/HomeCapabilities'
import { useInView } from '../../components/home/Vignettes'
import { bundledTokenArtwork } from '../../lib/bundledTokenArtwork'
import { networkName } from '../../lib/networkName'
import { holdingArtwork } from './model'
import type { TransferProgress } from './transferView'
import './transfer-route.css'

export interface TransferRouteProps {
  originChainId: number
  destinationChainId: number
  /** Delivered token, matched by chain/address only; no metadata or price request. */
  token?: { chainId: number; address: string } | null
  /** Refunds return the deposited asset, which may differ from the delivered token. */
  originToken?: { chainId: number; address: string } | null
  progress: TransferProgress
  /** A stopped or unknown read must not imply that the transfer failed or arrived. */
  paused?: boolean
}

function Port({ chainId, side }: { chainId: number; side: 'origin' | 'destination' }) {
  const name = networkName(chainId)
  const known = FUNDING_NETWORKS.find((network) => network === name)
  return <div className={`dm-funds-route-port dm-funds-route-${side}`}>
    <span className="dm-funds-route-platform" />
    <span className="dm-funds-route-network">
      {known ? <NetworkMark network={known} /> : <svg viewBox="0 0 24 24"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>}
    </span>
  </div>
}

/** An observed route, not a timed promise: only a real fill puts the token at the destination. */
export function TransferRoute({ originChainId, destinationChainId, token, originToken, progress, paused = false }: TransferRouteProps) {
  const state = progress.state
  const phase = state === 'filled' ? 'arrived' : state === 'refunded' ? 'returned'
    : state === 'failed' || state === 'refund_pending' ? 'returning' : state === 'refund_failed' ? 'attention'
      : state === 'pending' || state === 'awaiting_deposit' ? 'moving' : 'checking'
  const moving = !paused && (phase === 'moving' || phase === 'returning')
  const [ref, visible] = useInView<HTMLDivElement>(0.25, moving)
  const returning = phase === 'returning' || phase === 'returned' || phase === 'attention'
  const identity = returning ? originToken : token
  const identityChain = returning ? originChainId : destinationChainId
  const artwork = identity?.chainId === identityChain ? bundledTokenArtwork(identity.chainId, identity.address) ?? holdingArtwork(identity.chainId, identity.address) : null
  return <div ref={ref} className="dm-funds-route-art" aria-hidden="true" data-transfer-route={phase}
    data-transfer-moving={moving ? '' : undefined} data-route-running={moving && visible ? '' : undefined}
    data-route-balance={progress.balance} data-route-paused={paused ? '' : undefined}>
    <div className="dm-funds-route-scene">
      <span className="dm-funds-route-ground" />
      <div className="dm-funds-route-rail">
        <span className="dm-funds-route-line" />
        <span className="dm-funds-route-packet">
          <span className="dm-funds-route-coin">
            {artwork ? <TokenIcon symbol={artwork} size={23} /> : <svg viewBox="0 0 24 24"><ellipse cx="12" cy="12" rx="7" ry="8" /><path d="M10 8v8m4-8v8" /></svg>}
          </span>
        </span>
      </div>
      <Port chainId={originChainId} side="origin" />
      <Port chainId={destinationChainId} side="destination" />
    </div>
    <div className="dm-funds-route-labels"><span>{networkName(originChainId)}</span><span>{networkName(destinationChainId)}</span></div>
  </div>
}
