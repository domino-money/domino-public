/** Public position evidence shared by lists and detail. No wallet writes or RPC transport live here. */
import type { PortfolioResponse, Position, PositionLive } from 'api-contracts/read-v6/types'
import { POSITION_MANAGER } from '../../lib/fees/constants'
import type { StatePositionOk, StateResponse } from '../../lib/fees/types'
import { isV2ChainId, v2Chain } from '../../v2/chains'
import { notePositionConfirmation, subscribePositionEvidence, type PositionChange } from '../../lib/positionEvidence'
import { confirmedOperationState, subscribeConfirmedOperations, type ConfirmedOperation } from '../../lib/confirmedOperations'
import { CREATED_POSITIONS } from './createdPositions'
export type { PositionChange } from '../../lib/positionEvidence'

export interface PositionIdentity { chainId: number; positionManager: string; tokenId: string }
export const positionKey = (p: PositionIdentity): string => `${p.chainId}:${p.positionManager.toLowerCase()}:${p.tokenId}`
/**
 * A state reading of one NFT. `timestamp`: its block's time (the chain's clock). `seen` (2026-10-14, package V1, review):
 * when this page took it, by its own clock (ms). The two are never compared: `seen` only tells how long ago, here,
 * nothing newer arrived (./valuation.ts usdAged).
 */
export interface PositionObservation { block: number; timestamp: number; seen: number; position: StatePositionOk }
const MAX_POSITIONS = 512
const MAX_WALLETS = 24
/** Portfolio answers whose arrival is remembered (servedSeen below): a few per wallet in view. */
const MAX_SERVED = 256
const validId = (id: string) => /^[1-9]\d{0,77}$/.test(id)
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ZERO_TOPIC = `0x${'0'.repeat(64)}`
export function burnedPositionIds(logs: readonly { address: string; topics: readonly string[] }[], manager: string): string[] {
  return [...new Set(logs.filter((log) => log.address.toLowerCase() === manager.toLowerCase() && log.topics.length === 4 && log.topics[0].toLowerCase() === TRANSFER && log.topics[2].toLowerCase() === ZERO_TOPIC && /^0x[0-9a-fA-F]{64}$/.test(log.topics[3])).map((log) => BigInt(log.topics[3]).toString()).filter(validId))]
}
/**
 * Added 2026-10-14 (the incident of 2026-10-13, package V1): the NFTs a receipt minted, from the position manager's own
 * Transfer from zero, so a creation names its NFT even when the receipt's summary could not be read, and never needs
 * the wallet-wide hold below.
 */
export function mintedPositionIds(logs: readonly { address: string; topics: readonly string[] }[], manager: string): string[] {
  return [...new Set(logs.filter((log) => log.address.toLowerCase() === manager.toLowerCase() && log.topics.length === 4 && log.topics[0].toLowerCase() === TRANSFER && log.topics[1].toLowerCase() === ZERO_TOPIC && /^0x[0-9a-fA-F]{64}$/.test(log.topics[3])).map((log) => BigInt(log.topics[3]).toString()).filter(validId))]
}

/**
 * Added 2026-10-14 (the incident of 2026-10-13, package V1): how long a hold on every position of a wallet lasts. A
 * confirmed action that names no NFT holds them all until each is read at or past its block; it had no time limit, so a
 * position the index never read again stayed "Updating", with no dollars, for as long as the page was open. A hold that
 * names its NFTs has none still: only a reading at or past its block lifts it.
 */
export const WALLET_HOLD_MS = 300_000
/** A hold: the block a position's reading must reach, and when it ends by itself (null: never). */
interface Hold { block: number; until: number | null }

/** The page's own timer, never keeping a test's process open for it. */
const pageTimer = (run: () => void, ms: number): void => {
  const timer: unknown = setTimeout(run, ms)
  if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof timer.unref === 'function') timer.unref()
}

/** Exported factory keeps concurrency/identity tests isolated from the browser singleton. */
export function createPositionSync(now: () => number = () => Date.now(), later: (run: () => void, ms: number) => void = pageTimer) {
  const observations = new Map<string, PositionObservation>()
  // Added 2026-10-14 (package V1, review): when each portfolio answer arrived here, by its `servedAt` (servedSeen below).
  const served = new Map<number, number>()
  // Changed on purpose 2026-10-14 (package V1): each hold with when it ends, read live (a wallet-wide one expires), in
  // place of two maps of standing maximums. In a position's own map a wallet-wide hold is listed as `wallet:<source>`.
  const positionSources = new Map<string, Map<string, Hold>>()
  const walletSources = new Map<string, Map<string, Hold>>()
  const orphanedBlocks = new Set<string>()
  const burns = new Map<string, { block: number; hash?: string }>()
  const portfolios = new Map<string, PortfolioResponse>()
  const listeners = new Set<(change: PositionChange) => void>()
  const recent: PositionChange[] = []
  const trim = <T>(map: Map<string, T>, max: number) => { while (map.size > max) map.delete(map.keys().next().value as string) }
  const notify = (change: PositionChange) => { for (const listener of listeners) listener(change) }
  const top = (holds: Map<string, Hold> | undefined): number => {
    const time = now()
    let block = 0
    for (const hold of holds?.values() ?? []) if ((hold.until === null || hold.until > time) && hold.block > block) block = hold.block
    return block
  }
  const minBlock = (identity: PositionIdentity) => top(positionSources.get(positionKey(identity)))
  const walletMinimum = (chainId: number, wallet: string) => top(walletSources.get(`${chainId}:${wallet}`))
  const advance = (sources: Map<string, Map<string, Hold>>, max: number, key: string, source: string, block: number, until: number | null) => {
    const contributions = sources.get(key) ?? new Map<string, Hold>()
    const before = contributions.get(source)
    if (!before || block > before.block) contributions.set(source, { block, until })
    sources.set(key, contributions)
    trim(sources, max)
  }
  const stale = (state: PositionLive, at: number): PositionLive => ({ ...state, freshness: { ...state.freshness, status: 'stale', ageSeconds: Math.max(0, at - state.snapshot.timestamp) } })
  const observation = (identity: PositionIdentity): PositionObservation | null => {
    const read = observations.get(positionKey(identity))
    return read && read.block >= minBlock(identity) ? read : null
  }
  /**
   * Added 2026-10-14 (the incident of 2026-10-13, package V1, review): when the portfolio answer served at `servedAt`
   * arrived here, by this page's own clock (ms). Stamped once, as the answer is reconciled (it arrives through
   * `reconcile` below), and the same moment for as long as it is asked for; one asked for here first is stamped then.
   * Until then "nothing newer for two minutes" was counted from the mount of whichever component drew the answer, so
   * every way back to a screen gave an old answer two more minutes as current; and an inventory reading, dated by this
   * page's clock, was compared with `servedAt` itself, rugged's server's clock (a device three minutes off lost its
   * dollars). `servedAt` is only the answer's name here: no clock of ours is ever compared with it.
   */
  const servedSeen = (servedAt: number): number => {
    const seen = served.get(servedAt) ?? now()
    // The newest asked for last: an old answer still on screen is never the one to give way.
    served.delete(servedAt)
    served.set(servedAt, seen)
    while (served.size > MAX_SERVED) served.delete(served.keys().next().value as number)
    return seen
  }
  return {
    minBlock,
    observation,
    servedSeen,
    burn: (identity: PositionIdentity) => burns.get(positionKey(identity)) ?? null,
    subscribe(listener: (change: PositionChange) => void, replay = false) {
      listeners.add(listener)
      if (replay) for (const change of recent) listener(change)
      return () => { listeners.delete(listener) }
    },
    changed(change: PositionChange) {
      const manager = change.positionManager ?? (isV2ChainId(change.chainId) ? v2Chain(change.chainId).uniswap.v4.positionManager : null)
      const block = change.block === undefined ? null : Number(change.block)
      const source = change.blockHash ? `${change.chainId}:${change.blockHash.toLowerCase()}` : 'unqualified'
      if (manager && block !== null && Number.isSafeInteger(block) && block > 0) {
        for (const tokenId of change.tokenIds ?? []) if (validId(tokenId)) {
          const key = positionKey({ chainId: change.chainId, positionManager: manager, tokenId })
          advance(positionSources, MAX_POSITIONS, key, source, block, null)
        }
        for (const tokenId of change.burnedTokenIds ?? []) if (validId(tokenId)) burns.set(positionKey({ chainId: change.chainId, positionManager: manager, tokenId }), { block, hash: change.blockHash })
        trim(burns, MAX_POSITIONS)
      }
      // An explicitly scoped operation advances only those NFTs. A wallet-wide barrier is reserved for
      // receipts whose affected positions are genuinely unknown, and ends by itself (WALLET_HOLD_MS).
      const scoped = change.tokenIds !== undefined || change.burnedTokenIds !== undefined
      if (!scoped && change.wallet && block !== null && Number.isSafeInteger(block) && block > 0) {
        const wallet = change.wallet.toLowerCase()
        const until = now() + WALLET_HOLD_MS
        advance(walletSources, MAX_WALLETS * 3, `${change.chainId}:${wallet}`, source, block, until)
        for (const position of portfolios.get(wallet)?.positions ?? []) if (position.chainId === change.chainId) advance(positionSources, MAX_POSITIONS, positionKey(position), `wallet:${source}`, block, until)
        // Added 2026-10-14 (package V1, review): its end told nobody, so a held row stayed "Updating" until some answer
        // happened to work the rows out again (never, while every read failed). One word at its end, of the kind the
        // lists rework themselves on without asking anything (./source.ts reprojects what it holds; ./activity.tsx
        // ignores it): no read is started by it.
        later(() => notify({ kind: 'state', chainId: change.chainId, wallet }), WALLET_HOLD_MS + 1)
      }
      const saved = { ...change, wallet: change.wallet?.toLowerCase(), kind: 'confirmed' as const }
      recent.push(saved)
      if (recent.length > 64) recent.shift()
      notify(saved)
    },
    /** A contradictory canonical block removes only the barriers/burns originating in that block. */
    rollback(operation: Pick<ConfirmedOperation, 'chainId' | 'wallet' | 'positionManager' | 'tokenIds' | 'block' | 'blockHash'>) {
      const source = `${operation.chainId}:${operation.blockHash.toLowerCase()}`
      for (let index = recent.length - 1; index >= 0; index--) if (recent[index].chainId === operation.chainId && recent[index].blockHash?.toLowerCase() === operation.blockHash.toLowerCase()) recent.splice(index, 1)
      orphanedBlocks.add(source)
      while (orphanedBlocks.size > 64) orphanedBlocks.delete(orphanedBlocks.values().next().value as string)
      const affected = new Set<string>()
      for (const [key, contributions] of positionSources) {
        // The block's own hold on the NFT, and the wallet-wide hold of the same block listed with it.
        const named = contributions.delete(source), wide = contributions.delete(`wallet:${source}`)
        if (!named && !wide) continue
        affected.add(key)
        if (!contributions.size) positionSources.delete(key)
      }
      for (const [key, contributions] of walletSources) if (contributions.delete(source) && !contributions.size) walletSources.delete(key)
      for (const [key, burn] of burns) if (key.startsWith(`${operation.chainId}:`) && burn.hash?.toLowerCase() === operation.blockHash.toLowerCase()) { burns.delete(key); affected.add(key) }
      for (const key of affected) observations.delete(key)
      // Known identities remain discoverable. An orphaned financial snapshot is never replayed as current state.
      for (const [wallet, body] of portfolios) portfolios.set(wallet, { ...body, positions: body.positions.map(position => affected.has(positionKey(position)) && position.state.status === 'live' && position.state.snapshot.hash.toLowerCase() === operation.blockHash.toLowerCase() ? { ...position, state: { status: 'not_read' } } : position) })
      notify({ kind: 'confirmed', chainId: operation.chainId, wallet: operation.wallet, positionManager: operation.positionManager, tokenIds: operation.tokenIds, blockHash: operation.blockHash })
    },
    /** `seen`: when the reading arrived here (ms, this page's clock); now, unless the bus hands it over later. */
    offerState(answer: StateResponse, seen: number = now()) {
      const ids: string[] = []
      for (const position of answer.positions) {
        if (!position.ok) continue
        const identity = { chainId: 4663, positionManager: POSITION_MANAGER, tokenId: position.tokenId }
        const key = positionKey(identity)
        const minimum = Math.max(minBlock(identity), walletMinimum(4663, position.owner.toLowerCase()))
        if (answer.block < minimum || answer.block <= (observations.get(key)?.block ?? 0)) continue
        // A later successful owner/state read proves the NFT exists after a reorg of its burn.
        if (answer.block >= (burns.get(key)?.block ?? Infinity)) burns.delete(key)
        observations.delete(key)
        observations.set(key, { block: answer.block, timestamp: answer.timestamp, seen, position })
        ids.push(position.tokenId)
      }
      trim(observations, MAX_POSITIONS)
      if (ids.length) notify({ kind: 'state', chainId: 4663, positionManager: POSITION_MANAGER, tokenIds: ids, block: answer.block })
    },
    reconcile(body: PortfolioResponse): PortfolioResponse {
      // The answer's arrival, once (a reprojection of the same answer changes nothing).
      servedSeen(body.servedAt)
      const wallet = body.wallet.toLowerCase()
      const before = portfolios.get(wallet)
      const previous = new Map(before?.positions.map((position) => [positionKey(position), position]) ?? [])
      const found = new Map<string, Position>()
      for (const position of body.positions) {
        const key = positionKey(position)
        // A live wallet-wide hold reaches a position this answer lists for the first time too, until the same end.
        if (walletMinimum(position.chainId, wallet) > minBlock(position)) {
          const time = now()
          for (const [source, hold] of walletSources.get(`${position.chainId}:${wallet}`) ?? []) if (hold.until === null || hold.until > time) advance(positionSources, MAX_POSITIONS, key, `wallet:${source}`, hold.block, hold.until)
        }
        const old = found.get(key) ?? previous.get(key)
        const state = position.state.status === 'live' && orphanedBlocks.has(`${position.chainId}:${position.state.snapshot.hash.toLowerCase()}`) ? { status: 'not_read' } as const : position.state
        const burn = burns.get(key)
        if (burn && state.status === 'live' && state.snapshot.number === burn.block && burn.hash && state.snapshot.hash !== burn.hash) burns.delete(key)
        const oldState = old?.state
        let next = state === position.state ? position : { ...position, state }
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
      trim(portfolios, MAX_WALLETS)
      return next
    },
  }
}

/** A brief, bounded catch-up after an included operation. It changes only read timing; it never supplies state,
 * balances or an automation mode. Failed reads retain their service Retry-After through the source's normal policy.
 */
export function createPortfolioCatchup(now = Date.now) {
  interface Target { chainId: number; manager: string | null; ids: readonly string[] | null; block: number; left: number; until: number }
  const wallets = new Map<string, Map<string, Target>>()
  return {
    note(change: PositionChange) {
      const block = change.block === undefined ? 0 : Number(change.block)
      if (!change.wallet || !Number.isSafeInteger(block) || block <= 0) return
      const wallet = change.wallet.toLowerCase()
      let targets = wallets.get(wallet)
      if (!targets) { targets = new Map(); wallets.set(wallet, targets) }
      const ids = change.tokenIds === undefined ? null : [...new Set(change.tokenIds.filter(validId))].sort()
      const manager = change.positionManager?.toLowerCase() ?? (isV2ChainId(change.chainId) ? v2Chain(change.chainId).uniswap.v4.positionManager : null)
      const key = `${change.chainId}:${manager ?? ''}:${ids?.join(',') ?? '*'}`
      const before = targets.get(key)
      if (!before || block > before.block) targets.set(key, { chainId: change.chainId, manager, ids, block, left: change.chainId === 4663 ? 6 : 24, until: now() + 300_000 })
      while (targets.size > 32) targets.delete(targets.keys().next().value as string)
      while (wallets.size > MAX_WALLETS) wallets.delete(wallets.keys().next().value as string)
    },
    delay(body: PortfolioResponse): number | null {
      const targets = wallets.get(body.wallet.toLowerCase())
      let soon: number | null = null
      for (const target of targets?.values() ?? []) {
        if (target.left === 0 || now() >= target.until) continue
        const chain = body.chains.find((value) => value.chainId === target.chainId)
        const current = chain?.status === 'current' && chain.indexedThrough !== null && chain.indexedThrough.number >= target.block
        const reached = current && (target.ids === null || target.ids.every((id) => {
          const position = body.positions.find((value) => value.chainId === target.chainId && value.positionManager.toLowerCase() === target.manager && value.tokenId === id)
          if (position?.state.status !== 'live' || position.state.snapshot.number < target.block) return false
          if (!position.vault) return true
          const vault = body.vaults.find((value) => value.chainId === target.chainId && value.address.toLowerCase() === position.vault!.address.toLowerCase())
          return vault?.state.status === 'read' && vault.state.snapshot.number >= target.block
        }))
        target.left = reached ? 0 : target.left - 1
        if (target.left > 0) {
          const delay = target.chainId === 4663 ? 2_000 : target.left > 18 ? 5_000 : 10_000
          soon = soon === null ? delay : Math.min(soon, delay)
        }
      }
      return soon
    },
  }
}

const shared = createPositionSync()
subscribePositionEvidence((evidence) => {
  if (evidence.kind === 'state') shared.offerState(evidence.value, evidence.at)
  else shared.changed(evidence.value)
})
for (const operation of confirmedOperationState()) if (operation.phase === 'reorged') { shared.rollback(operation); CREATED_POSITIONS.rollback(operation.chainId, operation.blockHash) }
subscribeConfirmedOperations(operation => { if (operation.phase === 'reorged') { shared.rollback(operation); CREATED_POSITIONS.rollback(operation.chainId, operation.blockHash) } })
export const positionChanged = notePositionConfirmation
export const subscribePositionChanges = shared.subscribe
export const reconcilePortfolio = shared.reconcile
export const offerPositionState = shared.offerState
export const positionObservation = shared.observation
export const portfolioSeenAt = shared.servedSeen
export const minimumPositionBlock = shared.minBlock
export const positionBurn = shared.burn
