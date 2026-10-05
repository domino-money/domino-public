import { useEffect, useState } from 'react'
import { Button, KeyValue } from '../../components/ui'
import type { Dex } from '../../v2/types'
import { RECEIPT_POLL_MS } from './constants'
import { COPY } from './copy'
import { actionError, type ActionError } from './errors'
import type { ActionPosition } from './model'
import { connectPosition, inTurn, type OpenGate } from './wallet'

/** Whether the zap holds this NFT's individual approval and this wallet may revoke it: the zap client's own read. */
async function readApproval(gate: OpenGate, dex: Dex, tokenId: bigint): Promise<boolean | null> {
  const connection = await connectPosition(gate)
  if (!connection.zap) return null
  const answer = await connection.zap.positionApproval(dex, tokenId)
  return answer.zapApproved && answer.revocable
}

/** "Revoke": approve(address(0), tokenId), one transaction through the closed client, followed until it is on chain. */
async function revokeApproval(gate: OpenGate, dex: Dex, tokenId: bigint, sent: () => void): Promise<void> {
  const connection = await connectPosition(gate)
  if (!connection.zap) throw new Error('deployment_not_live')
  const prepared = await connection.zap.prepareRevoke(dex, tokenId)
  const hash = await connection.zap.send(prepared, true)
  sent()
  let state = 'pending'
  while (state !== 'included' && state !== 'finalized') {
    const receipt = await connection.zap.receipt(hash).catch(() => ({ state: 'pending' as const }))
    if (receipt.state === 'reverted') throw new Error('batch_simulation_reverted')
    state = receipt.state
    if (state !== 'included' && state !== 'finalized') await new Promise((resolve) => setTimeout(resolve, RECEIPT_POLL_MS))
  }
}

/**
 * Whether Domino's zap holds this position's individual approval (spec F7 §2.5.1 recommendation, §8.2 "Card da posição":
 * "Domino can manage this position for you when you ask.", with "Revoke"), as the chain has it: the zap client's own read
 * (`positionApproval`, its code checked against the manifest first), through the wallet, only when the wallet is already
 * on the position's chain (no switch for a read) and only under `live` (in the preview no Domino contract exists on any
 * chain, so no position can hold its approval).
 */
export function useZapApproval(gate: OpenGate | null, position: ActionPosition | null, walletOnChain: boolean) {
  const [approved, setApproved] = useState<boolean | null>(null)
  const [revoking, setRevoking] = useState<'idle' | 'wallet' | 'sent'>('idle')
  const [revoked, setRevoked] = useState(false)
  const [error, setError] = useState<ActionError | null>(null)
  const [round, setRound] = useState(0)
  const live = gate !== null && gate.mode === 'live' ? gate : null
  const dex = position?.dex ?? null
  const tokenId = position?.tokenId ?? null
  const readable = live !== null && dex !== null && tokenId !== null && walletOnChain && position?.vault?.role !== 'successor'

  useEffect(() => {
    if (!readable || !live || dex === null || tokenId === null) return
    let alive = true
    void inTurn(() => readApproval(live, dex, tokenId)).then((answer) => { if (alive) setApproved(answer) }, () => { if (alive) setApproved(null) })
    return () => {
      alive = false
    }
  }, [readable, live, dex, tokenId, round])

  async function revoke() {
    if (!live || dex === null || tokenId === null || revoking !== 'idle') return
    setError(null)
    setRevoking('wallet')
    try {
      await revokeApproval(live, dex, tokenId, () => setRevoking('sent'))
      setRevoked(true)
      setApproved(false)
      setRound((n) => n + 1)
    } catch (failure) {
      setError(actionError(failure, live.chainId))
    } finally {
      setRevoking('idle')
    }
  }

  return { approved, revoking, revoked, error, revoke: () => void revoke() }
}

/** The approval as one fact of the position's Details list, with "Revoke"; nothing when the zap holds no approval. */
export function ApprovalFact({ approval }: { approval: ReturnType<typeof useZapApproval> }) {
  if (approval.approved !== true && !approval.revoked && !approval.error) return null
  return (
    <KeyValue label={COPY.custody.permission} data-position-zap-approval={approval.approved ? 'approved' : approval.revoked ? 'revoked' : 'unknown'}>
      <span className="grid justify-items-end gap-2">
        {approval.approved === true && <span>{COPY.custody.zapApproved}</span>}
        {approval.approved === true && (
          <Button type="button" variant="outline" size="sm" disabled={approval.revoking !== 'idle'} aria-busy={approval.revoking !== 'idle' || undefined} onClick={approval.revoke} data-position-revoke="">
            {approval.revoking === 'idle' ? COPY.custody.revoke : COPY.custody.revoking}
          </Button>
        )}
        {approval.revoked && approval.approved === false && <span data-position-revoked="">{COPY.custody.revoked}</span>}
        {approval.error && (
          <span role="alert" className="text-caption text-fg-muted" data-error-code={approval.error.code}>
            {approval.error.copy}
          </span>
        )}
      </span>
    </KeyValue>
  )
}
