import type { ActivityResponse, IndexedToken } from 'api-contracts/read-v6/types'
import type { ConfirmedOperation } from '../../lib/confirmedOperations'
import { isV2ChainId, positionManagerOrNull, v2Chain, V2_CHAINS } from '../../v2/chains'
import type { ActivityPosition } from './activityModel'
import { decodedEventWords, tokenNamer, type ShownReceipt } from './model'

export interface SessionActivity {
  proof: ConfirmedOperation
  tokenId: string
  chain: string
}

/** A verified setup receipt is useful immediately, even before the public index catches up.
 * Keep its provenance: observation time is not a block timestamp and inclusion is not finality.
 */
export function sessionActivity(wallet: string | null, proofs: readonly ConfirmedOperation[], indexed: readonly ActivityResponse['items'][number][], position?: ActivityPosition): SessionActivity[] {
  if (!wallet) return []
  return proofs.flatMap(proof => {
    if (proof.wallet !== wallet.toLowerCase() || proof.phase === 'reorged' || !proof.vault || !proof.positionManager) return []
    const chain = V2_CHAINS.find(item => item.chainId === proof.chainId)
    if (!chain) return []
    const event = proof.events.find(item => item.eventName === 'Initialized' && item.address.toLowerCase() === proof.vault
      && String(item.args.owner).toLowerCase() === proof.wallet && proof.tokenIds.includes(String(item.args.rootTokenId)))
    if (!event) return []
    const dex = Number(event.args.dex)
    if (dex !== 3 && dex !== 4) return []
    if (positionManagerOrNull(chain, dex)?.toLowerCase() !== proof.positionManager) return []
    const tokenId = String(event.args.rootTokenId)
    if (position && (position.chainId !== proof.chainId || position.dex !== dex || position.tokenId !== tokenId)) return []
    // Another log from this transaction is not proof that this setup has reached the index.
    if (indexed.some(item => item.kind === 'vault_created' && item.chainId === proof.chainId
      && item.tx.hash.toLowerCase() === proof.hash && item.tx.snapshot.hash.toLowerCase() === proof.blockHash && item.tx.snapshot.number === proof.block
      && item.vault.toLowerCase() === proof.vault && item.owner.toLowerCase() === proof.wallet && item.dex === dex && item.rootTokenId === tokenId)) return []
    return [{ proof, tokenId, chain: chain.name }]
  }).sort((a, b) => b.proof.at - a.proof.at)
}

/** Immediate and indexed records share one visible limit and one pagination control. */
export function activityWindow<I, R>(immediate: readonly I[], rows: readonly R[], shown: number) {
  return { immediate: immediate.slice(0, shown), visible: rows.slice(0, Math.max(0, shown - immediate.length)), total: immediate.length + rows.length, hidden: immediate.length + rows.length > shown }
}

/**
 * Added (2026-10-15, pack 8): every other automation step this browser sent and checked in a block (turned on or off,
 * paused, resumed, settings or limits saved, Auto-exit on or off, a withdrawal from the automation) is a row at once, in
 * the words read-v6's own row will say (model.ts decodedEventWords), until read-v6 lists the same transaction. A setup is
 * sessionActivity's row above; an approval or a step no receipt row says draws nothing. Never a time: the operation's is
 * this page's clock, not the block's.
 */
export function sessionAutomation(wallet: string | null, proofs: readonly ConfirmedOperation[], indexed: readonly ActivityResponse['items'][number][], tokens: readonly IndexedToken[], position?: ActivityPosition): (ShownReceipt & { observedAt: number })[] {
  if (!wallet) return []
  const owner = wallet.toLowerCase()
  return proofs.flatMap(proof => {
    if (proof.wallet !== owner || proof.phase === 'reorged' || proof.indexed || !isV2ChainId(proof.chainId)) return []
    if (proof.events.some(event => event.eventName === 'Initialized')) return []
    if (indexed.some(item => item.chainId === proof.chainId && item.tx.hash.toLowerCase() === proof.hash)) return []
    if (position && (position.chainId !== proof.chainId || !(proof.tokenIds.includes(position.tokenId)
      || proof.events.some(event => event.eventName === 'MandateRegistered' && String(event.args.tokenId) === position.tokenId)))) return []
    const chainId = proof.chainId
    const name = tokenNamer(tokens)
    const said = proof.events.map(event => decodedEventWords(event, owner, address => name(chainId, address))).filter((line): line is string => line !== null)
    if (!said.length) return []
    return [{ id: `session:${chainId}:${proof.hash}`, chainId, chain: v2Chain(chainId).name, kind: 'vault_event' as const, what: said[0], amount: null,
      lines: said.slice(1).map(value => ({ label: 'Also', value, data: 'event' })), fees: [], gas: null, hash: proof.hash, block: proof.block, at: null,
      confirmed: true, finalized: proof.phase === 'finalized', observedAt: proof.at }]
  }).sort((a, b) => b.observedAt - a.observedAt)
}

/**
 * Added (2026-10-15, pack 8): the rows Receipts and a position's Activity draw before read-v6 lists them, newest first:
 * a setup (`setup`, its own row), any other automation step, and the person's own position actions (`view`, the receipt
 * row read-v6's item will replace). `receipts` are the session receipts already chosen (./sessionReceipts.ts).
 */
export type ImmediateRow = { key: string; observedAt: number } & ({ setup: SessionActivity; view?: undefined } | { view: ShownReceipt; setup?: undefined })
export function immediateRows(setups: readonly SessionActivity[], automation: readonly (ShownReceipt & { observedAt: number })[], receipts: readonly { view: ShownReceipt; observedAt: number }[]): ImmediateRow[] {
  const rows = new Map<string, ImmediateRow>()
  for (const item of setups) rows.set(`${item.proof.chainId}:${item.proof.hash}`, { key: `${item.proof.chainId}:${item.proof.hash}`, observedAt: item.proof.at, setup: item })
  for (const view of automation) if (!rows.has(`${view.chainId}:${view.hash}`)) rows.set(`${view.chainId}:${view.hash}`, { key: `${view.chainId}:${view.hash}`, observedAt: view.observedAt, view })
  // A position action's own receipt says more than the automation words of the same transaction.
  for (const item of receipts) rows.set(`${item.view.chainId}:${item.view.hash.toLowerCase()}`, { key: `${item.view.chainId}:${item.view.hash.toLowerCase()}`, observedAt: item.observedAt, view: item.view })
  return [...rows.values()].sort((a, b) => b.observedAt - a.observedAt)
}
