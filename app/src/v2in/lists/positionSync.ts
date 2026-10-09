/** Public position evidence shared by lists and detail. No wallet writes or RPC transport live here. */
import type { PortfolioResponse, Position, PositionLive } from 'api-contracts/read-v6/types'
import { POSITION_MANAGER } from '../../lib/fees/constants'
import type { StatePositionOk, StateResponse } from '../../lib/fees/types'
import { isV2ChainId, v2Chain } from '../../v2/chains'
import { notePositionConfirmation, subscribePositionEvidence, type PositionChange } from '../../lib/positionEvidence'
export type { PositionChange } from '../../lib/positionEvidence'

export interface PositionIdentity { chainId: number; positionManager: string; tokenId: string }
export const positionKey = (p: PositionIdentity): string => `${p.chainId}:${p.positionManager.toLowerCase()}:${p.tokenId}`
export interface PositionObservation { block: number; timestamp: number; position: StatePositionOk }
const MAX_POSITIONS = 512
const MAX_WALLETS = 24
const validId = (id: string) => /^[1-9]\d{0,77}$/.test(id)
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ZERO_TOPIC = `0x${'0'.repeat(64)}`
export function burnedPositionIds(logs: readonly { address: string; topics: readonly string[] }[], manager: string): string[] {
  return [...new Set(logs.filter((log) => log.address.toLowerCase() === manager.toLowerCase() && log.topics.length === 4 && log.topics[0].toLowerCase() === TRANSFER && log.topics[2].toLowerCase() === ZERO_TOPIC && /^0x[0-9a-fA-F]{64}$/.test(log.topics[3])).map((log) => BigInt(log.topics[3]).toString()).filter(validId))]
}

/** Exported factory keeps concurrency/identity tests isolated from the browser singleton. */
export function createPositionSync() {
  const observations = new Map<string, PositionObservation>()
  const minimums = new Map<string, number>()
  const walletMinimums = new Map<string, number>()
  const burns = new Map<string, { block: number; hash?: string }>()
  const portfolios = new Map<string, PortfolioResponse>()
  const listeners = new Set<(change: PositionChange) => void>()
  const trim = <T>(map: Map<string, T>, max: number) => { while (map.size > max) map.delete(map.keys().next().value as string) }
  const notify = (change: PositionChange) => { for (const listener of listeners) listener(change) }
  const minBlock = (identity: PositionIdentity) => minimums.get(positionKey(identity)) ?? 0
  const stale = (state: PositionLive, at: number): PositionLive => ({ ...state, freshness: { ...state.freshness, status: 'stale', ageSeconds: Math.max(0, at - state.snapshot.timestamp) } })
  const observation = (identity: PositionIdentity): PositionObservation | null => {
    const read = observations.get(positionKey(identity))
    return read && read.block >= minBlock(identity) ? read : null
  }
  return {
    minBlock,
    observation,
    burn: (identity: PositionIdentity) => burns.get(positionKey(identity)) ?? null,
    subscribe(listener: (change: PositionChange) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    changed(change: PositionChange) {
      const manager = change.positionManager ?? (isV2ChainId(change.chainId) ? v2Chain(change.chainId).uniswap.v4.positionManager : null)
      const block = change.block === undefined ? null : Number(change.block)
      if (manager && block !== null && Number.isSafeInteger(block) && block > 0) {
        for (const tokenId of change.tokenIds ?? []) if (validId(tokenId)) {
          const key = positionKey({ chainId: change.chainId, positionManager: manager, tokenId })
          minimums.set(key, Math.max(minimums.get(key) ?? 0, block))
        }
        for (const tokenId of change.burnedTokenIds ?? []) if (validId(tokenId)) burns.set(positionKey({ chainId: change.chainId, positionManager: manager, tokenId }), { block, hash: change.blockHash })
        trim(burns, MAX_POSITIONS)
        trim(minimums, MAX_POSITIONS)
      }
      if (change.wallet && block !== null && Number.isSafeInteger(block) && block > 0) {
        const wallet = change.wallet.toLowerCase()
        const key = `${change.chainId}:${wallet}`
        walletMinimums.set(key, Math.max(walletMinimums.get(key) ?? 0, block))
        for (const position of portfolios.get(wallet)?.positions ?? []) if (position.chainId === change.chainId) minimums.set(positionKey(position), Math.max(minBlock(position), block))
        trim(walletMinimums, MAX_WALLETS * 3)
        trim(minimums, MAX_POSITIONS)
      }
      notify({ ...change, wallet: change.wallet?.toLowerCase(), kind: 'confirmed' })
    },
    offerState(answer: StateResponse) {
      const ids: string[] = []
      for (const position of answer.positions) {
        if (!position.ok) continue
        const identity = { chainId: 4663, positionManager: POSITION_MANAGER, tokenId: position.tokenId }
        const key = positionKey(identity)
        const minimum = Math.max(minBlock(identity), walletMinimums.get(`4663:${position.owner.toLowerCase()}`) ?? 0)
        if (answer.block < minimum || answer.block <= (observations.get(key)?.block ?? 0)) continue
        // A later successful owner/state read proves the NFT exists after a reorg of its burn.
        if (answer.block >= (burns.get(key)?.block ?? Infinity)) burns.delete(key)
        observations.delete(key)
        observations.set(key, { block: answer.block, timestamp: answer.timestamp, position })
        ids.push(position.tokenId)
      }
      trim(observations, MAX_POSITIONS)
      if (ids.length) notify({ kind: 'state', chainId: 4663, positionManager: POSITION_MANAGER, tokenIds: ids, block: answer.block })
    },
    reconcile(body: PortfolioResponse): PortfolioResponse {
      const wallet = body.wallet.toLowerCase()
      const before = portfolios.get(wallet)
      const previous = new Map(before?.positions.map((position) => [positionKey(position), position]) ?? [])
      const found = new Map<string, Position>()
      for (const position of body.positions) {
        const key = positionKey(position)
        const minimum = walletMinimums.get(`${position.chainId}:${wallet}`) ?? 0
        if (minimum > minBlock(position)) minimums.set(key, minimum)
        const old = found.get(key) ?? previous.get(key)
        const state = position.state
        const burn = burns.get(key)
        if (burn && state.status === 'live' && state.snapshot.number === burn.block && burn.hash && state.snapshot.hash !== burn.hash) burns.delete(key)
        const oldState = old?.state
        let next = position
        if (oldState?.status === 'live') {
          const reorganized = state.status === 'live' && state.snapshot.number === oldState.snapshot.number && state.snapshot.hash !== oldState.snapshot.hash
          if (reorganized) observations.delete(key)
          else if (state.status !== 'live' || state.snapshot.number < oldState.snapshot.number || state.snapshot.number < minBlock(position)) next = { ...position, state: stale(oldState, body.servedAt) }
        } else if (state.status === 'live' && state.snapshot.number < minBlock(position)) next = { ...position, state: { status: 'not_read' } }
        found.set(key, next)
      }
      // A partial inventory cannot delete known positions. Closed NFTs remain historical rows if a later
      // portfolio omits a burn; we do not infer a burn from absence or move an open NFT to Closed.
      for (const [key, old] of previous) {
        if (found.has(key)) continue
        const chain = body.chains.find((one) => one.chainId === old.chainId)
        const partial = body.truncated.positions || chain?.status !== 'current'
        const closed = old.state.status === 'live' && old.state.liquidity === '0'
        const observed = observation(old)
        const held = observed?.position.owner.toLowerCase()
        if (held && held !== wallet && held !== old.vault?.address.toLowerCase()) continue
        if (partial || closed || burns.has(key) || (old.state.status === 'live' && old.state.snapshot.number < minBlock(old))) {
          found.set(key, old.state.status === 'live' ? { ...old, state: stale(old.state, body.servedAt) } : old)
        }
      }
      const next = { ...body, positions: [...found.values()] }
      portfolios.delete(wallet)
      portfolios.set(wallet, next)
      trim(minimums, MAX_POSITIONS)
      trim(portfolios, MAX_WALLETS)
      return next
    },
  }
}

const shared = createPositionSync()
subscribePositionEvidence((evidence) => {
  if (evidence.kind === 'state') shared.offerState(evidence.value)
  else shared.changed(evidence.value)
})
export const positionChanged = notePositionConfirmation
export const subscribePositionChanges = shared.subscribe
export const reconcilePortfolio = shared.reconcile
export const offerPositionState = shared.offerState
export const positionObservation = shared.observation
export const minimumPositionBlock = shared.minBlock
export const positionBurn = shared.burn
