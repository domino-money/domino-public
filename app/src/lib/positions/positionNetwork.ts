/** A network change is preparation for an intentional action, never proof of ownership or permission to send. */
export type PositionWalletIdentity = { address: string; connectorUid: string; chainId: number } | null

export class PositionNetworkError extends Error {
  constructor(readonly outcome: string) { super(`position_network_${outcome}`) }
}

export async function ensurePositionNetwork({ owner, chainId, identity, switchChain, current, onSwitch }: {
  owner: string
  chainId: number
  identity: () => PositionWalletIdentity
  switchChain: (chainId: number) => Promise<string>
  current: () => boolean
  onSwitch: () => void
}): Promise<string> {
  const before = identity()
  const matches = (value: PositionWalletIdentity) => current() && before !== null && value !== null &&
    value.address.toLowerCase() === owner.toLowerCase() && value.connectorUid === before.connectorUid
  if (!matches(before)) throw new Error('wallet_identity_changed')
  if (before!.chainId !== chainId) {
    onSwitch()
    const outcome = await switchChain(chainId)
    if (!matches(identity())) throw new Error('wallet_identity_changed')
    if (outcome !== 'switched') throw new PositionNetworkError(outcome)
  }
  const after = identity()
  if (!matches(after) || after!.chainId !== chainId) throw new Error('wallet_identity_changed')
  return `${after!.connectorUid}|${after!.address.toLowerCase()}`
}
