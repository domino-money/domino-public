import { createAutoExitClient, type AutoExitClient } from '../../finance/v2/autoExit'
import { createVaultClient, type V2BatchReceipt, type V2Event, type VaultClient } from '../../finance/v2/vault'
import type { PreparedV2, V2Receipt } from '../../finance/v2/transact'
import { v2Wallet } from '../../finance/v2/wallet'
import { v2Chain } from '../../v2/chains'
import type { Address, Hex, V2ChainId, V2Contracts } from '../../v2/types'
import { switchToChain, v2SwitchNotice } from '../../wallet/port'
import { simulateOnChain } from '../../lib/walletReads'

/**
 * The integrated automation screens' one way to the wallet, used only where a service's gate is `live` (src/v2/gate.ts:
 * a pinned real manifest and the backend's word); under `preview` nothing here is ever called, and the screens stop at
 * their review. The chain is switched first (wallet/port.ts switchToChain; a wallet that does not know Base or Arbitrum
 * One is told to add it, never asked to), then the closed money clients (finance/v2/vault.ts, autoExit.ts) on the page's
 * one wallet connection, which read `eth_chainId` again right before every send and signature. Nothing here names a
 * wallet method.
 *
 * One operation at a time: the clients refuse a second one while the first runs (`wallet_action_busy`), so every call
 * goes through the session's queue. A step is offered to the wallet once; its receipt is then read until it is in a
 * block ("Included"), and on until the chain's finalized block passes it ("Finalized"). A delay is never a failure.
 *
 * Domino V2 integration (2026-10-02): the money half of src/v2ui/vault/session.tsx, copied for the integrated screens.
 */

export interface AutomationSession {
  chainId: V2ChainId
  owner: Address
  contracts: V2Contracts
  vault: VaultClient
  autoExit: AutoExitClient
  /** Runs one client call after the ones before it have settled. */
  serial<T>(work: () => Promise<T>): Promise<T>
  /** Asks the wallet to be on this session's chain (a switch to the chain it is on asks nothing of the person). */
  ensureChain(): Promise<void>
}

const sessions = new Map<string, { session: AutomationSession; current: () => boolean }>()

/** The wallet onto `chainId`, or a failure carrying wallet/port.ts's own sentence (4902: "Add {chain} to your wallet, then try again."). */
export async function ensureChain(chainId: V2ChainId): Promise<void> {
  const outcome = await switchToChain(chainId)
  if (outcome !== 'switched') throw Object.assign(new Error(`wallet_switch_${outcome}`), { notice: v2SwitchNotice(outcome, v2Chain(chainId).name) })
}

/**
 * The session for the connected wallet on `chainId` with that chain's live contracts set (the gate's): the wallet
 * switched there first, then the two clients, built once per wallet, chain and set. The clients themselves refuse a
 * fixture set in a deployable build and check every component's code against the manifest before the first write.
 */
export async function openAutomation(chainId: V2ChainId, contracts: V2Contracts): Promise<AutomationSession> {
  await ensureChain(chainId)
  const wallet = await v2Wallet()
  const key = `${chainId}|${wallet.owner}|${Object.values(contracts.addresses).join(',')}`
  const known = sessions.get(key)
  if (known && known.current()) return known.session
  const chain = v2Chain(chainId)
  const simulator = chainId === 4663 ? simulateOnChain : undefined
  const vault = createVaultClient(wallet, chain, contracts, undefined, simulator)
  const autoExit = createAutoExitClient(wallet, chain, contracts, undefined, undefined, simulator)
  let tail: Promise<unknown> = Promise.resolve()
  const serial = <T,>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work, work)
    tail = run.catch(() => undefined)
    return run
  }
  const session: AutomationSession = Object.freeze({ chainId, owner: wallet.owner, contracts, vault, autoExit, serial, ensureChain: () => ensureChain(chainId) })
  sessions.set(key, { session, current: () => wallet.current() })
  return session
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** Where one step stands on screen. */
export type StepPhase =
  | { phase: 'idle' }
  | { phase: 'working'; note: 'checking' | 'wallet' | 'signing' }
  | { phase: 'sent'; hash?: Hex; batchId?: string }
  | { phase: 'included'; hash?: Hex; batchId?: string }
  | { phase: 'finalized'; hash?: Hex; batchId?: string }
  | { phase: 'signed' }
  /** `hash` / `batchId` / `offered`: it was handed to the wallet, so it is never offered again from here. */
  | { phase: 'failed'; hash?: Hex; batchId?: string; offered?: true }

export const IDLE: StepPhase = Object.freeze({ phase: 'idle' })

/** What a step is offered through: a client's one send and its receipt (the vault's or the module's). */
export interface TxClient {
  send(prepared: PreparedV2, acknowledged: boolean): Promise<Hex>
  /** Whether the client handed this prepared step to the wallet (then it is never offered again). */
  wasOffered(prepared: PreparedV2): boolean
  receipt(hash: Hex): Promise<V2Receipt & { events: readonly V2Event[] }>
}

export type IncludedReceipt = Extract<V2Receipt, { blockHash: Hex }> & { state: 'included' | 'finalized'; events: readonly V2Event[] }

/** The clients' codes that say the transaction read back is not the one reviewed: waiting changes nothing. */
const SETTLED = new Set(['receipt_not_from_this_review', 'transaction_does_not_match_review', 'invalid_receipt'])
const settled = (error: unknown) => error instanceof Error && SETTLED.has(error.message)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** How often a sent step's receipt is read: quickly at first, then every few seconds. */
const beat = (attempt: number) => Math.min(800 + attempt * 400, 4000)

/** A step that was offered: from here on a failure is an outcome the page could not read, never a step known to have failed. */
export class SentStepError extends Error {
  readonly hash: Hex
  constructor(code: 'receipt_reverted' | 'receipt_reorged' | 'receipt_unknown', hash: Hex) {
    super(code)
    this.name = 'SentStepError'
    this.hash = hash
  }
}

/** A step the client handed to the wallet whose send then failed without a hash: its outcome is the chain's to say. */
export class OfferedStepError extends Error {
  readonly cause: unknown
  constructor(cause: unknown) {
    super('receipt_unknown')
    this.name = 'OfferedStepError'
    this.cause = cause
  }
}

/**
 * One transaction step: the chain switched, the step prepared by its client (re-derived from the chain, simulated
 * there, its network budget read inside the client's own bounded port), offered to the wallet once, then its receipt
 * read until it is in a block. Resolves with the hash and that receipt; null when the page stopped wanting the answer.
 */
export async function sendStep(session: AutomationSession, client: TxClient, prepare: () => Promise<PreparedV2>, report: (phase: StepPhase) => void, alive: () => boolean): Promise<{ hash: Hex; receipt: IncludedReceipt } | null> {
  report({ phase: 'working', note: 'checking' })
  await session.ensureChain()
  const prepared = await session.serial(() => prepare())
  if (!alive()) return null
  report({ phase: 'working', note: 'wallet' })
  let hash: Hex
  try {
    hash = await session.serial(() => client.send(prepared, true))
  } catch (error) {
    if (client.wasOffered(prepared)) throw new OfferedStepError(error)
    throw error
  }
  report({ phase: 'sent', hash })
  for (let attempt = 0; ; attempt++) {
    await sleep(beat(attempt))
    if (!alive()) return null
    let receipt: Awaited<ReturnType<TxClient['receipt']>>
    try {
      receipt = await session.serial(() => client.receipt(hash))
    } catch (error) {
      if (settled(error)) throw new SentStepError('receipt_unknown', hash)
      continue
    }
    if (receipt.state === 'pending') continue
    if (receipt.state === 'reverted') throw new SentStepError('receipt_reverted', hash)
    if (receipt.state === 'reorged') throw new SentStepError('receipt_reorged', hash)
    report({ phase: receipt.state, hash })
    return { hash, receipt: receipt as IncludedReceipt }
  }
}

/** A batch's side of a step: prepared by its client, offered once, and read back (EIP-5792). */
export interface BatchClient<B> {
  prepareBatch(): Promise<B>
  send(batch: B): Promise<string>
  receipt(id: string): Promise<V2BatchReceipt>
}

/** A batch that was offered and whose outcome could not be read: never offered again from here. */
export class SentBatchError extends Error {
  readonly batchId: string
  constructor(code: 'receipt_reorged' | 'receipt_unknown', batchId: string) {
    super(code)
    this.name = 'SentBatchError'
    this.batchId = batchId
  }
}

/**
 * One EIP-5792 batch as one step (spec §5.1 "Lote", §4.4 item 7, rev3 §5.6): the chain switched, the batch prepared
 * (derived from the chain and simulated whole through the wallet), offered once, then read back until its transaction is
 * in a block. Not included or reverted: nothing of it ran (`batch_not_included`, `batch_reverted`).
 */
export async function sendBatchStep<B>(session: AutomationSession, batch: BatchClient<B>, report: (phase: StepPhase) => void, alive: () => boolean): Promise<{ batchId: string; receipt: IncludedReceipt } | null> {
  report({ phase: 'working', note: 'checking' })
  await session.ensureChain()
  const prepared = await session.serial(() => batch.prepareBatch())
  if (!alive()) return null
  report({ phase: 'working', note: 'wallet' })
  const batchId = await session.serial(() => batch.send(prepared))
  report({ phase: 'sent', batchId })
  for (let attempt = 0; ; attempt++) {
    await sleep(beat(attempt))
    if (!alive()) return null
    let receipt: V2BatchReceipt
    try {
      receipt = await session.serial(() => batch.receipt(batchId))
    } catch (error) {
      if (settled(error) || (error instanceof Error && error.message === 'receipt_duplicate_action')) throw new SentBatchError('receipt_unknown', batchId)
      continue
    }
    if (receipt.state === 'pending') continue
    if (receipt.state === 'not-included') throw new Error('batch_not_included')
    if (receipt.state === 'batch-reverted' || receipt.state === 'reverted') throw new Error('batch_reverted')
    if (receipt.state === 'reorged') throw new SentBatchError('receipt_reorged', batchId)
    report({ phase: receipt.state, batchId })
    return { batchId, receipt: receipt as IncludedReceipt }
  }
}

/** Reads an included step until the chain's finalized block passes it ("Finalized"), while the page wants it. */
export async function watchFinality(session: AutomationSession, read: () => Promise<{ state: string }>, done: () => void, alive: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt++) {
    await sleep(4000)
    if (!alive()) return
    try {
      const receipt = await session.serial(read)
      if (!alive()) return
      if (receipt.state === 'finalized') {
        done()
        return
      }
      if (receipt.state === 'reorged') return
    } catch (error) {
      if (settled(error)) return
    }
  }
}
