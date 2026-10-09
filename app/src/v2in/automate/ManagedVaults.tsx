import { useMemo } from 'react'
import { positionHref } from '../../components/explore/routes'
import { useWalletIdentity } from '../../lib/walletIdentity'
import { anyIn, chainsIn, useKeyed, useListsGate } from '../lists/hooks'
import { OWN_PORTFOLIO } from '../lists/source'
import { v2PositionHref } from '../route'
import { automatedPositions, shownVaultView } from './vaultView'
import type { Address } from '../../v2/types'

/** Positions own their automation controls. Only otherwise orphaned family funds need a separate navigation hint. */
export default function ManagedVaults() {
  const identity = useWalletIdentity()
  const wallet = identity.kind === 'connected' ? identity.address.toLowerCase() as Address : null
  const gate = useListsGate()
  const reply = useKeyed(OWN_PORTFOLIO, anyIn(gate, 'live') ? wallet : null)
  const body = reply?.kind === 'ok' ? reply.body : null
  const recoveries = useMemo(() => {
    if (!body || !wallet) return []
    const open = chainsIn(gate, 'live')
    const views = body.vaults.filter((vault) => open(vault.chainId)).map((vault) => shownVaultView(vault, body, wallet, body.servedAt, null))
    return automatedPositions(views, body).filter((row) => row.recovery && !body.positions.some((position) => position.chainId === row.current.chainId && position.dex === row.current.dex && position.tokenId === String(row.current.rootTokenId)))
  }, [body, wallet, gate])
  if (!recoveries.length) return null
  return <aside className="dm-automation-recovery" aria-label="Automation funds" data-automation-recovery="">
    {recoveries.map(({ key, current, vaults }) => {
      const held = vaults.some((view) => view.reserves.known && view.reserves.held)
      const children = new Set(vaults.flatMap((view) => view.successors.map(String))).size
      const href = current.chainId === 4663 && current.dex === 4 ? positionHref(String(current.rootTokenId)) : v2PositionHref({ chainId: current.chainId, dex: current.dex, tokenId: current.rootTokenId })
      return <p key={key}><a href={href}>Position #{String(current.rootTokenId)}</a><span>{held ? 'Funds available in automation' : children ? `${children} ${children === 1 ? 'position' : 'positions'} held by automation` : 'Automation balance unavailable'} · Review in position</span></p>
    })}
  </aside>
}
