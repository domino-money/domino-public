import { numberToHex, type Address, type Hex } from 'viem'
import type { V2Chain } from '../../v2/chains'
import type { V2ChainId } from '../../v2/types'
import { definiteRefusal } from '../nonce'
import { refuseUnlessLive } from './liveLock'
import type { ConfirmationRead } from '../../lib/edge/confirmation'
import { edgeReadsReceipts } from '../../config/receiptSources'

/**
 * The one way a V2 money client offers a transaction to a wallet (spec F7 §1.3, §1.8, §2.4 check 11, §2.10), shared by
 * finance/v2/zap.ts, vault.ts and autoExit.ts. It is the V1 owner clients' discipline (finance/position.ts, setup.ts),
 * bound to ONE chain:
 *
 *   - reviews and sends use the connected wallet; Robinhood receipt reads use the site's fixed route to its existing node;
 *   - every operation is bounded in time and in calls, one at a time, and stops when the wallet, its account or its
 *     chain changes (`current()`, and `eth_accounts` / `eth_chainId` read at the start of every operation); a receipt's
 *     reads, only those methods, have the same bounds and checks outside the one-at-a-time lock (2026-10-14, review of
 *     C3 on main: `reads`);
 *   - a step is simulated from the owner (`eth_call`) and estimated (`eth_estimateGas` × 1.2) before it is offered,
 *     and its exact transaction simulated again right before the wallet sees it;
 *   - a nonce is offered once: the pending nonce must equal the latest (nothing in flight), it is claimed in the
 *     page's journal (keyed by chain and owner, finance/nonce.ts in PHASE B) before the wallet is asked, and released
 *     only after a definite refusal (4001) or before the provider was invoked; a step is never sent twice;
 *   - `eth_chainId` is read again immediately before `eth_sendTransaction`, after everything else: the V2 contracts
 *     have the same address on every chain, so a wallet that moved to another chain would send the same call there;
 *   - a receipt is read only for a hash this transactor sent, and the transaction behind it must be the reviewed one;
 *     "included" and "finalized" are separate states (the chain's `finalized` block), and a delay is never a failure.
 *
 * This module and the three clients are the only V2 files that name wallet transaction methods
 * (tests/session.source-guard.test.mjs). It names no batch method: batches stay finance/batch.ts's (PHASE B).
 */

/** The page's journal of offered nonces, keyed by chain and owner (finance/nonce.ts, generalized per chain in PHASE B). */
export interface NonceJournal {
  nonceOffered(chainId: V2ChainId, nonce: bigint): boolean
  claimNonce(chainId: V2ChainId, nonce: bigint): Promise<string>
  releaseRejectedNonce(chainId: V2ChainId, nonce: bigint, token: string): Promise<void>
  /**
   * V1's settle (../nonce.ts, 2026-10-01 audit C2): a latch met again while the chain shows nothing pending for that
   * nonce is let go once the page that claimed it is gone, or once it is older than `maxAge`; true when it was.
   */
  settleNonce?(chainId: V2ChainId, nonce: bigint, now: number, maxAge: number): Promise<boolean>
  /**
   * V1's forget (../nonce.ts): the person says the request is gone from the wallet ("I rejected it in my wallet"); the
   * latch is let go, whoever holds it. Asked only while the chain shows that nonce still the next with nothing pending.
   * Changed on purpose (data) 2026-10-02 (Domino V2 rev2 review, F3).
   */
  forgetNonce?(chainId: V2ChainId, nonce: bigint): Promise<boolean>
}

/** How long a nonce latch may hold with nothing pending on chain before it is let go: V1's own (finance/setup.ts NONCE_LATCH_EXPIRY_S). */
export const NONCE_LATCH_EXPIRY_S = 600

/**
 * A signature nonce held in the page's journal from the moment a signature is asked for until it is known used or
 * cancelled (spec §2.5.2 "Escolha do nonce", §2.10, §4.4): Permit2's unordered nonce, the zap's relayed nonce, the
 * auto-exit module's mandate nonce. Only public data: chain, owner, the verifying contract, the nonce.
 */
export interface SignedNonce {
  chainId: V2ChainId
  owner: Address
  space: 'permit2' | 'zap' | 'autoExit'
  verifier: Address
  nonce: bigint
}
export interface SignatureJournal {
  held(entry: SignedNonce): boolean
  record(entry: SignedNonce): Promise<void>
  forget(entry: SignedNonce): Promise<void>
  /** Every signature nonce still held for this owner on this chain: what may need cancelling. */
  list(chainId: V2ChainId, owner: Address): readonly SignedNonce[]
}

/** The connected wallet, as a V2 client sees it: one owner, the chain the client acts on, and the page's journals. */
export interface V2Wallet extends NonceJournal {
  owner: Address
  /** Whether the same connector and account are still connected. */
  current(): boolean
  /**
   * The chain the connector last reported (wagmi's connection chainId, updated on `chainChanged`), checked before and
   * after every wallet call of an operation as V1's `current()` checks 4663: a wallet moved to another chain mid-way
   * stops the operation at once, so no read of one review comes from another chain (the V2 contracts have the same
   * address on every chain). `eth_chainId` is still read from the wallet itself at the start of every operation and
   * right before every send.
   */
  chainId(): number | null
  request(method: string, params: unknown[]): Promise<unknown>
  signatures: SignatureJournal
  /** Fixed public receipt reads on Domino's existing node. Absent only in isolated clients/tests. */
  confirmation?: ConfirmationRead
}

/** What a step may cost: the gas units, the fee ceiling, the priority fee, and ETH to keep. */
export interface V2GasBudget {
  maxGas: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  reserveWei: bigint
}

export interface V2Transaction {
  from: Address
  to: Address
  data: Hex
  value: Hex
  nonce: Hex
  gas: Hex
  maxFeePerGas: Hex
  maxPriorityFeePerGas: Hex
  /** The chain's id in hex: the wallet refuses the transaction on any other chain. */
  chainId: Hex
  type: '0x2'
}

/** One reviewed transaction, ready for the wallet. Frozen; only the transactor that issued it can send it. */
export interface PreparedV2 {
  kind: string
  chainId: V2ChainId
  owner: Address
  /** Unix seconds: the review is good until then (25 s after its simulation). */
  expiresAt: number
  /** The most the step may cost in network fees: its gas limit at the fee ceiling (Base adds its L1 data fee). */
  networkFeeWei: bigint
  transaction: Readonly<V2Transaction>
  summary: readonly string[]
}

export interface V2Log {
  address: Address
  topics: readonly Hex[]
  data: Hex
  logIndex: number
}

export type V2Receipt =
  | { state: 'pending' }
  | { state: 'reorged' }
  | {
      state: 'included' | 'finalized' | 'reverted'
      blockHash: Hex
      transactionHash?: Hex
      blockNumber: bigint
      gasUsed: bigint
      effectiveGasPrice: bigint
      /** Base's L1 data fee (the receipt's `l1Fee`); null on Nitro chains, where gasUsed already includes it, or when not reported. */
      l1Fee: bigint | null
      logs: readonly V2Log[]
      /**
       * (2026-10-15, pack 8): the block's time (Unix seconds) from the header this client already read to check the block;
       * absent when that read named none. Only shown (a session receipt's time); nothing is decided on it.
       */
      blockTimestamp?: number
    }

/** A simulation the contract refused, with its revert data when the wallet passed it on: for src/v2/errors.ts to say. */
export class V2Revert extends Error {
  readonly data: Hex | null
  constructor(data: Hex | null) {
    super('v2_simulation_reverted')
    this.name = 'V2Revert'
    this.data = data
  }
}

/** How long a prepared step stays good, and how long a wallet prompt may stay open (finance/setup.ts SIGN_WINDOW_S). */
export const REVIEW_S = 25
export const SIGN_WINDOW_S = 180
const MAX_UINT128 = (1n << 128n) - 1n

const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
/** (2026-10-15, pack 8): a header's `timestamp` as V2Receipt's `blockTimestamp`, or nothing when it is not a quantity. */
export const headerTime = (value: unknown): { blockTimestamp?: number } => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,12}$/.test(value)) return {}
  const seconds = Number.parseInt(value.slice(2), 16)
  return Number.isSafeInteger(seconds) && seconds > 0 ? { blockTimestamp: seconds } : {}
}
const fail = (code: string): never => { throw new Error(code) }
export const asHex = (value: unknown): Hex => (typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value) ? (value as Hex) : fail('invalid_wallet_reply'))
export const quantity = (value: unknown): bigint =>
  typeof value === 'string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value) ? BigInt(value) : fail('invalid_wallet_quantity')
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : fail('invalid_wallet_reply'))

/**
 * A contract's refusal inside a wallet's error, walked like finance/setup.ts revertOf: code 3 or a message that says it
 * reverted, and 0x-hex `data` at any of four levels. A refusal in the wallet (4001) or a rate limit (429) is never one.
 */
export function revertIn(error: unknown): { data: Hex | null } | null {
  let reverted = false
  let other = false
  let data: Hex | null = null
  const walk = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || depth > 4) return
    const node = value as { code?: unknown; message?: unknown; data?: unknown; originalError?: unknown; cause?: unknown; error?: unknown }
    if (node.code === 4001 || node.code === 429) other = true
    if (node.code === 3) reverted = true
    if (typeof node.data === 'string' && /^0x(?:[0-9a-fA-F]{2})+$/.test(node.data)) {
      reverted = true
      data ??= node.data.toLowerCase() as Hex
    }
    if (typeof node.message === 'string' && /execution reverted|revert/i.test(node.message)) reverted = true
    for (const next of [node.data, node.originalError, node.cause, node.error]) walk(next, depth + 1)
  }
  walk(error, 0)
  return reverted && !other ? { data } : null
}

/**
 * A wallet's definite refusal: nothing was signed or sent. V1's own rule (../nonce.ts definiteRefusal, 2026-10-01 audit
 * C2 with the owner's OK): 4001 and the other codes and hardware-wallet words that prove the request never left the
 * wallet. Any other failure is an unknown outcome and keeps its nonce held.
 */
export const refused = (error: unknown): boolean => definiteRefusal(error)

/**
 * One wallet call through the bounded port. `onUserRejection` runs after a definite refusal. `answerKept` (Domino V2 rev2
 * review, F2; finance/v2/crosschain.ts's own): the send's own call (eth_sendTransaction, a batch's offer), whose answer
 * — a hash, a batch id — is kept even when the wallet's account or chain changed, or the window ended, after the wallet
 * answered: the wallet may have sent it, and an answer thrown away would let the page offer the same action again.
 */
export type Rpc = (method: string, params: unknown[], onUserRejection?: () => Promise<void>, answerKept?: boolean) => Promise<unknown>

/**
 * The owner's decision D2 (incident 2026-10-13, design §7): the person's own wallet is the second source of a Robinhood
 * receipt this page sent, after the site's fixed reader. False: the fixed reader alone, as before 2026-10-14. Its window:
 * three reads through the wallet's provider, or the wallet's failure, which the caller meets as "ask again".
 */
export const WALLET_SECOND_SOURCE = true
const WALLET_SECOND_S = 5
/**
 * The only wallet methods the second source may call (C3 review): identity's two and the three it reads. Changed on
 * purpose 2026-10-14 (review of C3 on main): and every receipt read through the wallet (`reads` in createTransactor).
 */
const WALLET_SECOND_READS: ReadonlySet<string> = new Set(['eth_accounts', 'eth_chainId', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber'])

/** The fixed reader's three fields, read through the wallet's own provider (the second source): reads only. */
async function walletAnswer(rpc: Rpc, hash: Hex): Promise<{ transaction: unknown; receipt: unknown; block: unknown }> {
  const transaction = await rpc('eth_getTransactionByHash', [hash])
  if (transaction === null) return { transaction: null, receipt: null, block: null }
  const receipt = await rpc('eth_getTransactionReceipt', [hash])
  const number = receipt && typeof receipt === 'object' ? (receipt as { blockNumber?: unknown }).blockNumber : null
  const block = typeof number === 'string' ? await rpc('eth_getBlockByNumber', [number, false]) : null
  return { transaction, receipt, block }
}

/**
 * Receipt data uses the site's fixed reader on Robinhood; transaction review and effect checks remain in the client.
 *
 * Changed on purpose 2026-10-14 (incident C3, the owner's decision D2): `second` is the person's own wallet, read-only,
 * which the fixed reader asks after two missed reads of this hash (lib/edge/confirmation.ts). Its three fields are
 * answered here exactly as the reader's, so every check below holds for either source.
 *
 * Changed on purpose 2026-10-14 (C3 review): every read here is the money client's own, so it asks in the foreground lane
 * whether or not a second source is given (the D2 switch turns off the wallet, not the lane; the vault's batch receipt
 * passes none). An answer of the second source is at most "included": the finalized block is the site's node's, and it is
 * never joined to a block hash another node gave, so a release that waits for finality rests on one node's own read.
 */
export async function receiptRpc(wallet: V2Wallet, chain: V2Chain, hash: Hex, fallback: Rpc, second?: () => Promise<{ transaction: unknown; receipt: unknown; block: unknown }>): Promise<Rpc> {
  // Changed on purpose 2026-10-15 (pack 8, C5): the chain's row in ../../config/receiptSources.ts, not its id (the same chain).
  if (!wallet.confirmation || !edgeReadsReceipts(chain.chainId)) return fallback
  let fromSecond = false
  const answer = await wallet.confirmation.read(hash, { foreground: true, second: second && (async () => { const value = await second(); fromSecond = true; return value }) })
  return async (method, params) => {
    if (method === 'eth_getTransactionByHash' && params[0] === hash) return answer.transaction
    if (method === 'eth_getTransactionReceipt' && params[0] === hash) return answer.receipt
    if (method === 'eth_getBlockByNumber' && params[1] === false) {
      if (params[0] === 'finalized') return fromSecond ? fail('finality_not_from_second_source') : wallet.confirmation!.finalized()
      const raw = answer.receipt as { blockNumber?: unknown } | null
      if (raw && params[0] === raw.blockNumber) return answer.block
    }
    throw new Error('invalid_confirmation_read')
  }
}

/** What one step is: where it goes, what it carries, the ETH it sends, and its review lines. */
export interface StepDraft {
  kind: string
  to: Address
  data: Hex
  value: bigint
  summary: readonly string[]
}

/**
 * A network budget from the chain's own price now, through the wallet: twice the gas price as the ceiling. The
 * priority fee depends on how the chain orders transactions (spec open point 21): Robinhood and Arbitrum (Nitro)
 * order by arrival, so none is offered; Base (OP Stack) orders by priority fee, so the wallet's own suggestion
 * (`eth_maxPriorityFeePerGas`), kept under the ceiling. Reads only.
 */
export async function suggestV2Gas(rpc: Rpc, chain: V2Chain, maxGas = DEFAULT_MAX_GAS): Promise<V2GasBudget> {
  const price = quantity(await rpc('eth_gasPrice', []))
  const floor = 10_000_000n
  const maxFeePerGas = price * 2n > floor ? price * 2n : floor
  let maxPriorityFeePerGas = 0n
  if (chain.ordering === 'priority-fee') {
    const tip = quantity(await rpc('eth_maxPriorityFeePerGas', []))
    maxPriorityFeePerGas = tip < maxFeePerGas ? tip : maxFeePerGas
  }
  return { maxGas, maxFeePerGas, maxPriorityFeePerGas, reserveWei: 0n }
}

/** The gas ceiling of a budget read at prepare time (suggestV2Gas's default). */
export const DEFAULT_MAX_GAS = 8_000_000n

/** GasPriceOracle.getL1FeeUpperBound(uint256 unsignedTxSize) (OP Stack, Fjord): an upper bound of the L1 data fee. */
const L1_FEE_UPPER_BOUND = '0xf1c7a58b' as const
/** Bytes an EIP-1559 transaction's unsigned envelope adds to its calldata, with room to spare (the oracle adds the signature). */
const UNSIGNED_ENVELOPE_BYTES = 160n

/**
 * The most a step (or a batch) may pay in L1 data fee on an OP Stack chain (post-B4 review F5): the chain's
 * GasPriceOracle asked, through the wallet's own provider and right before the offer, for its upper bound at the
 * step's size; 0 on Nitro, where gasUsed already includes it. A reply that is not a word is refused (never guessed).
 */
export async function l1FeeCeiling(rpc: Rpc, chain: V2Chain, calldataBytes: bigint): Promise<bigint> {
  if (!chain.l1FeeInReceipt) return 0n
  if (!chain.l1FeeOracle || calldataBytes < 0n) return fail('l1_fee_unavailable')
  const size = (calldataBytes + UNSIGNED_ENVELOPE_BYTES).toString(16).padStart(64, '0')
  let reply: unknown
  try {
    reply = await rpc('eth_call', [{ to: chain.l1FeeOracle, data: `${L1_FEE_UPPER_BOUND}${size}` }, 'latest'])
  } catch (error) {
    if (revertIn(error)) return fail('l1_fee_unavailable')
    throw error
  }
  if (typeof reply !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(reply)) return fail('l1_fee_unavailable')
  return BigInt(reply)
}

/**
 * A refusal raised by the bounded wallet port BEFORE the wallet's provider was invoked (the account or chain changed,
 * the window closed, too many calls): nothing reached the wallet, so a nonce claimed for that request is let go
 * (post-B4 review F9). Its message is the same code as before.
 */
export class WalletNotAsked extends Error {}

/**
 * Changed on purpose (data) 2026-10-02 (Domino V2 integration): `liveLock` runs first in `send`, before any wallet request
 * or nonce claim: each client hands in its own (./liveLock.ts refuseUnlessLive with its contracts set); without one, the
 * chain must be live.
 */
export function createTransactor(wallet: V2Wallet, chain: V2Chain, now: () => number = () => Date.now() / 1000, liveLock: () => void = () => refuseUnlessLive(chain.chainId, null)) {
  const owner = wallet.owner.toLowerCase() as Address
  if (!ADDRESS.test(owner)) return fail('invalid_wallet_owner')
  const issued = new WeakSet<PreparedV2>()
  const offered = new Set<string>()
  const sent = new Map<Hex, PreparedV2>()
  let busy = false
  const key = (nonce: bigint) => `${chain.chainId}|${nonce}`

  /** One operation at a time, inside `seconds`, at most 48 wallet calls, stopping the moment the wallet changes. */
  function bounded<T>(work: (rpc: Rpc) => Promise<T>, seconds = REVIEW_S): Promise<T> {
    return port(work, seconds, true)
  }

  /**
   * `bounded`'s port. `exclusive` false (C3 review: the receipt's second source, below, and nothing else): the same window,
   * call bound and wallet checks, outside the one-operation lock, so a background read never meets the person's press
   * with "wallet_action_busy", nor waits for it.
   * Changed on purpose 2026-10-14 (review of C3 on main): `reads` below, for the second source and for every receipt read
   * through the wallet, and nothing else.
   */
  async function port<T>(work: (rpc: Rpc) => Promise<T>, seconds: number, exclusive: boolean): Promise<T> {
    if (exclusive && busy) return fail('wallet_action_busy')
    if (exclusive) busy = true
    const end = now() + seconds
    let calls = 0
    const rpc: Rpc = async (method, params, onUserRejection, answerKept) => {
      if (!wallet.current() || now() >= end || ++calls > 48) throw new WalletNotAsked('wallet_action_expired')
      // The connector's own report of its chain, before and after every call (as V1's current() checks 4663).
      if (wallet.chainId() !== chain.chainId) throw new WalletNotAsked('wallet_wrong_chain')
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        // A definite refusal stays observable even after the deadline has won; an unknown outcome keeps its nonce held.
        const request = wallet.request(method, params).catch(async (error: unknown) => {
          if (refused(error)) await onUserRejection?.()
          throw error
        })
        const result = await Promise.race([request, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('wallet_timeout')), Math.max(1, (end - now()) * 1000)) })])
        // The send's own answer is kept whatever changed after it came (F2): the caller records it and says so.
        if (answerKept) return result
        if (!wallet.current() || now() >= end) return fail('wallet_identity_changed')
        if (wallet.chainId() !== chain.chainId) return fail('wallet_wrong_chain')
        return result
      } finally {
        clearTimeout(timer)
      }
    }
    try {
      return await work(rpc)
    } finally {
      if (exclusive) busy = false
    }
  }

  /**
   * Added 2026-10-14 (review of C3 on main): `port` outside the one-operation lock, the receipt's methods only
   * (WALLET_SECOND_READS). The second source's (C3 review), and now every read of what this client sent, or of a hash the
   * person names, through the wallet (`receipt` and `replacement` below). On Base and Arbitrum One those reads took the
   * lock: since C3 a close in a block is followed until final, and a direct exit until its block, in the background,
   * through the same kept client the person's next review and send use, and "Close 2 positions" or "Continue to next
   * group" pressed while such a read was out failed with "wallet_action_busy", nothing open in the wallet.
   */
  function reads<T>(work: (rpc: Rpc) => Promise<T>, seconds: number): Promise<T> {
    return port((rpc) => work((method, params) => (WALLET_SECOND_READS.has(method) ? rpc(method, params) : fail('receipt_read_not_allowed'))), seconds, false)
  }

  /** The wallet's account must be the owner and its chain this client's. Another chain is `wallet_wrong_chain`: switch first. */
  async function identity(rpc: Rpc): Promise<void> {
    const accounts = await rpc('eth_accounts', [])
    if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || accounts[0].toLowerCase() !== owner) return fail('wallet_identity_changed')
    if (quantity(await rpc('eth_chainId', [])) !== BigInt(chain.chainId)) return fail('wallet_wrong_chain')
  }

  /** A read of a contract at a block, through the wallet's provider. */
  const call = async (rpc: Rpc, to: Address, data: Hex, block: Hex | 'latest' = 'latest', from?: Address): Promise<Hex> =>
    asHex(await rpc('eth_call', [from ? { from, to, data } : { to, data }, block]))

  /** The latest block's number and time, which every read of one review is pinned to. */
  async function latestBlock(rpc: Rpc): Promise<{ number: bigint; timestamp: bigint; tag: Hex }> {
    const block = record(await rpc('eth_getBlockByNumber', ['latest', false]))
    const number = quantity(block.number)
    return { number, timestamp: quantity(block.timestamp), tag: numberToHex(number) }
  }

  /** The step simulated from the owner, as the account's own execution makes it; a refusal is a V2Revert with its data. */
  async function simulate(rpc: Rpc, tx: { from: Address; to: Address; data: Hex; value: Hex }): Promise<Hex> {
    try {
      return asHex(await rpc('eth_call', [tx, 'latest']))
    } catch (error) {
      const revert = revertIn(error)
      if (revert) throw new V2Revert(revert.data)
      throw error
    }
  }

  /** Whether the owner can be paid plain ETH (finance/setup.ts acceptsNativeEth): an EIP-7702 delegate may refuse it. */
  async function acceptsNativeEth(rpc: Rpc): Promise<boolean> {
    if (asHex(await rpc('eth_getCode', [owner, 'latest'])) === '0x') return true
    try {
      await rpc('eth_call', [{ from: owner, to: owner, value: '0x1' }, 'latest'])
      return true
    } catch (error) {
      if (revertIn(error)) return false
      throw error
    }
  }

  function checkBudget(gas: V2GasBudget) {
    if (gas.maxGas < 21_000n || gas.maxGas > 15_000_000n || gas.maxFeePerGas <= 0n || gas.maxFeePerGas > MAX_UINT128
      || gas.maxPriorityFeePerGas < 0n || gas.maxPriorityFeePerGas > gas.maxFeePerGas || gas.reserveWei < 0n) return fail('invalid_gas_budget')
  }

  /** Nothing of this owner may be in flight on this chain: the pending nonce is the latest, and it was never offered here. */
  async function freeNonce(rpc: Rpc): Promise<bigint> {
    const latest = quantity(await rpc('eth_getTransactionCount', [owner, 'latest']))
    const pending = quantity(await rpc('eth_getTransactionCount', [owner, 'pending']))
    if (latest !== pending || offered.has(key(pending))) return fail('pending_wallet_transaction')
    // Another page's latch (or this page's before a reload) on a nonce the chain shows nothing pending for: let go by
    // V1's rule only (its page is gone, or it is too old); otherwise the request may still be open in the wallet.
    if (wallet.nonceOffered(chain.chainId, pending) && !(await wallet.settleNonce?.(chain.chainId, pending, now(), NONCE_LATCH_EXPIRY_S))) return fail('pending_wallet_transaction')
    return pending
  }

  /**
   * One step reviewed: simulated from the owner, estimated with a fifth more room, its cost checked against the
   * budget and the owner's ETH, and frozen with the owner's free nonce. Call inside `bounded`, after `identity`.
   * `gas` null (post-B4 review F8): the budget is read here, through this bounded port (this chain, this account),
   * at the moment of the review, never carried over from an earlier one. On an OP Stack chain the step's L1 data fee
   * ceiling is added to its cost (F5). `inspect` (Domino V2 rev2 review, F4) is handed what the owner's simulation
   * returned, and refuses the step by throwing (the zap client decodes its ActionResult there).
   */
  async function prepare(rpc: Rpc, draft: StepDraft, budget: V2GasBudget | null, inspect?: (returned: Hex) => void): Promise<PreparedV2> {
    const gas = budget ?? (await suggestV2Gas(rpc, chain))
    checkBudget(gas)
    if (!ADDRESS.test(draft.to) || draft.value < 0n || draft.value > MAX_UINT128) return fail('invalid_step')
    const nonce = await freeNonce(rpc)
    const tx = { from: owner, to: draft.to, data: draft.data, value: numberToHex(draft.value) }
    const returned = await simulate(rpc, tx)
    inspect?.(returned)
    let estimate: bigint
    try {
      estimate = quantity(await rpc('eth_estimateGas', [tx]))
    } catch (error) {
      const revert = revertIn(error)
      if (revert) throw new V2Revert(revert.data)
      throw error
    }
    const limit = (estimate * 120n + 99n) / 100n
    if (limit > gas.maxGas) return fail('gas_budget_exceeded')
    const cost = limit * gas.maxFeePerGas + (await l1FeeCeiling(rpc, chain, BigInt((draft.data.length - 2) / 2)))
    if (quantity(await rpc('eth_getBalance', [owner, 'latest'])) < cost + draft.value + gas.reserveWei) return fail('native_gas_reserve_insufficient')
    const prepared: PreparedV2 = Object.freeze({
      kind: draft.kind,
      chainId: chain.chainId,
      owner,
      expiresAt: now() + REVIEW_S,
      networkFeeWei: cost,
      summary: Object.freeze([...draft.summary]),
      transaction: Object.freeze({
        ...tx,
        nonce: numberToHex(nonce),
        gas: numberToHex(limit),
        maxFeePerGas: numberToHex(gas.maxFeePerGas),
        maxPriorityFeePerGas: numberToHex(gas.maxPriorityFeePerGas),
        chainId: chain.hex,
        type: '0x2' as const,
      }),
    })
    issued.add(prepared)
    return prepared
  }

  /**
   * Offers a prepared step to the wallet once. Refused unless acknowledged, issued here, unexpired and still the
   * owner's; everything is read and simulated again, the nonce claimed, and the chain read one last time right before
   * the wallet is asked. A refusal (4001) releases the nonce; any other outcome keeps it held. Never sent twice.
   *
   * Changed on purpose (data) 2026-10-02 (Domino V2 rev2 review): the wallet's answer to the send is kept even when its
   * account or chain changed, or the window ended, after it answered (F2): the hash enters `sent` and is returned, so
   * the step is followed to its receipt and never offered again. `options.inspect` is handed what the last simulation
   * returned, before the nonce is claimed (F4); `options.onRefusal` runs after a definite refusal of the send, even one
   * that arrives after the window ended (F3: the caller lets go of what it held for it).
   */
  function send(prepared: PreparedV2, acknowledged: boolean, extra?: (rpc: Rpc) => Promise<void>, options: { inspect?: (returned: Hex) => void; onRefusal?: () => Promise<void> } = {}): Promise<Hex> {
    // Changed on purpose (data) 2026-10-02 (Domino V2 integration): nothing is sent with contracts that are not live
    // (./liveLock.ts), refused before the wallet is asked anything and before a nonce is claimed.
    try {
      liveLock()
    } catch (error) {
      return Promise.reject(error)
    }
    return bounded(async (rpc) => {
      if (!acknowledged || !issued.has(prepared) || prepared.expiresAt <= now() || prepared.owner !== owner || prepared.chainId !== chain.chainId) {
        return fail('wallet_review_required')
      }
      await identity(rpc)
      await extra?.(rpc)
      const nonce = await freeNonce(rpc)
      if (numberToHex(nonce) !== prepared.transaction.nonce) return fail('pending_wallet_transaction')
      // The chain may have moved since the review: the exact transaction is simulated again before the wallet sees it.
      const { from, to, data, value } = prepared.transaction
      const returned = await simulate(rpc, { from, to, data, value })
      options.inspect?.(returned)
      if (prepared.expiresAt <= now()) return fail('wallet_review_expired')
      const claim = await wallet.claimNonce(chain.chainId, nonce)
      // Immediately before the wallet is asked: the same chain, still (spec §1.3). The provider has not been invoked
      // for this nonce yet, so releasing the claim on any failure here is certain.
      let chainNow: bigint
      try {
        chainNow = quantity(await rpc('eth_chainId', []))
      } catch (error) {
        await wallet.releaseRejectedNonce(chain.chainId, nonce, claim)
        throw error
      }
      if (chainNow !== BigInt(chain.chainId) || !wallet.current() || prepared.expiresAt <= now()) {
        await wallet.releaseRejectedNonce(chain.chainId, nonce, claim)
        return fail(chainNow !== BigInt(chain.chainId) ? 'wallet_wrong_chain' : 'wallet_review_expired')
      }
      offered.add(key(nonce))
      issued.delete(prepared)
      let hash: unknown
      try {
        hash = await rpc('eth_sendTransaction', [prepared.transaction], async () => {
          // Only this exact claim, only after a definite refusal; nothing is offered again without a new review.
          await wallet.releaseRejectedNonce(chain.chainId, nonce, claim)
          offered.delete(key(nonce))
          await options.onRefusal?.()
        }, true)
      } catch (error) {
        // The port refused before the provider was invoked: the wallet never saw it, so the claim is let go (F9).
        if (error instanceof WalletNotAsked) {
          await wallet.releaseRejectedNonce(chain.chainId, nonce, claim)
          offered.delete(key(nonce))
        }
        throw error
      }
      if (typeof hash !== 'string' || !HASH.test(hash.toLowerCase())) return fail('wallet_result_unknown')
      const sentHash = hash.toLowerCase() as Hex
      sent.set(sentHash, prepared)
      return sentHash
    }, SIGN_WINDOW_S)
  }

  /** Where a step this transactor sent stands, with its logs and costs once included. */
  function receipt(hash: Hex, recovered?: Pick<V2Transaction, 'from' | 'to' | 'data' | 'value' | 'nonce' | 'chainId'>): Promise<V2Receipt> {
    // Changed on purpose 2026-10-14 (incident C3, the owner's decision D2): on Robinhood the fixed reader asks this
    // owner's own wallet, read-only and bounded, after two missed reads of this hash. A wallet gone or on another chain
    // fails that read (`identity`); the caller asks again, and the fixed reader is asked first again next time.
    // Changed on purpose 2026-10-14 (C3 review): through its own port, outside the one-operation lock (a settlement's read
    // in the background held it up to 5 s, and the person's next press met "wallet_action_busy"), and reads only
    // (`reads`, since the review of C3 on main).
    const second = WALLET_SECOND_SOURCE ? () => reads(async (rpc) => {
      await identity(rpc)
      return walletAnswer(rpc, hash)
    }, WALLET_SECOND_S) : undefined
    const readReceipt = async (rpc: Rpc): Promise<V2Receipt> => {
      const known = sent.get(hash)
      const reviewed = known?.transaction ?? recovered
      // A recovered identity authorizes reads only: it is never added to issued/offered and cannot be sent.
      if (!HASH.test(hash) || !reviewed || reviewed.from !== owner || quantity(reviewed.chainId) !== BigInt(chain.chainId)) return fail('receipt_not_from_this_review')
      const read = await receiptRpc(wallet, chain, hash, rpc, second)
      const tx = (await read('eth_getTransactionByHash', [hash])) as Record<string, unknown> | null
      if (tx === null) return { state: 'pending' }
      if (!tx || String(tx.hash).toLowerCase() !== hash || String(tx.from).toLowerCase() !== owner || String(tx.to).toLowerCase() !== reviewed.to
        || String(tx.input).toLowerCase() !== reviewed.data.toLowerCase() || quantity(tx.value) !== BigInt(reviewed.value) || quantity(tx.nonce) !== BigInt(reviewed.nonce)) {
        return fail('transaction_does_not_match_review')
      }
      const raw = (await read('eth_getTransactionReceipt', [hash])) as Record<string, unknown> | null
      if (raw === null) return { state: 'pending' }
      if (!raw || String(raw.transactionHash).toLowerCase() !== hash || String(raw.from).toLowerCase() !== owner || typeof raw.blockHash !== 'string'
        || !HASH.test(raw.blockHash.toLowerCase()) || !['0x0', '0x1'].includes(String(raw.status)) || !Array.isArray(raw.logs)) return fail('invalid_receipt')
      const blockNumber = quantity(raw.blockNumber)
      const blockHash = raw.blockHash.toLowerCase() as Hex
      const block = (await read('eth_getBlockByNumber', [numberToHex(blockNumber), false])) as { hash?: string; timestamp?: unknown } | null
      if (!block) return { state: 'pending' }
      if (String(block.hash).toLowerCase() !== blockHash) return { state: 'reorged' }
      const logs = (raw.logs as unknown[]).map((entry): V2Log => {
        const log = record(entry)
        if (typeof log.address !== 'string' || !ADDRESS.test(log.address.toLowerCase()) || !Array.isArray(log.topics)) return fail('invalid_receipt')
        return Object.freeze({
          address: log.address.toLowerCase() as Address,
          topics: Object.freeze(log.topics.map((topic) => (typeof topic === 'string' && HASH.test(topic.toLowerCase()) ? (topic.toLowerCase() as Hex) : fail('invalid_receipt')))),
          data: asHex(log.data),
          logIndex: Number(quantity(log.logIndex)),
        })
      })
      const costs = {
        transactionHash: hash,
        blockHash,
        blockNumber,
        gasUsed: quantity(raw.gasUsed),
        effectiveGasPrice: quantity(raw.effectiveGasPrice),
        l1Fee: chain.l1FeeInReceipt && typeof raw.l1Fee === 'string' ? quantity(raw.l1Fee) : null,
        logs: Object.freeze(logs),
        ...headerTime(block.timestamp),
      }
      if (raw.status === '0x0') return { state: 'reverted', ...costs }
      // A finality timeout cannot erase a successfully verified inclusion.
      const final = await read('eth_getBlockByNumber', ['finalized', false]).catch(() => null) as { number?: string } | null
      if (!final?.number || quantity(final.number) < blockNumber) return { state: 'included', ...costs }
      return { state: 'finalized', ...costs }
    }
    // This hash/review already authorizes public confirmation. Changing or disconnecting the wallet cannot
    // cancel it. The fixed reader is bounded separately and cannot simulate, sign, send, or offer a nonce.
    // Changed on purpose 2026-10-15 (pack 8, C5): the chain's row in ../../config/receiptSources.ts, not its id (the same chain).
    if (edgeReadsReceipts(chain.chainId) && wallet.confirmation) return readReceipt(async () => fail('receipt_read_not_allowed'))
    // Changed on purpose 2026-10-14 (review of C3 on main): reads only, outside the one-operation lock (`reads`, above).
    return reads(async rpc => { await identity(rpc); return readReceipt(rpc) }, REVIEW_S)
  }

  /**
   * A user-supplied replacement is read only. A different effect can release tracking only after canonical finality.
   * Changed on purpose 2026-10-14 (review of C3 on main): its reads too are outside the one-operation lock (`reads`): a
   * close the person found by its replacement's hash is followed until final in the background like any other.
   */
  async function replacement(originalHash: Hex | null, candidateHash: Hex, reviewed: Pick<V2Transaction, 'from' | 'to' | 'data' | 'value' | 'nonce' | 'chainId'>) {
    const candidate = await reads(async (rpc) => {
      await identity(rpc)
      if (originalHash !== null && !HASH.test(originalHash) || !HASH.test(candidateHash) || reviewed.from !== owner || quantity(reviewed.chainId) !== BigInt(chain.chainId)) return fail('receipt_not_from_this_review')
      const original = originalHash ? await rpc('eth_getTransactionByHash', [originalHash]) as Record<string, unknown> | null : null
      if (original !== null && (!original || String(original.hash).toLowerCase() !== originalHash || String(original.from).toLowerCase() !== owner || String(original.to).toLowerCase() !== reviewed.to
        || String(original.input).toLowerCase() !== reviewed.data.toLowerCase() || quantity(original.value) !== BigInt(reviewed.value) || quantity(original.nonce) !== BigInt(reviewed.nonce))) return fail('transaction_does_not_match_review')
      const tx = await rpc('eth_getTransactionByHash', [candidateHash]) as Record<string, unknown> | null
      if (tx === null) return null
      if (!tx || String(tx.hash).toLowerCase() !== candidateHash || String(tx.from).toLowerCase() !== owner || quantity(tx.nonce) !== BigInt(reviewed.nonce)
        || typeof tx.to !== 'string' || !ADDRESS.test(tx.to.toLowerCase())) return fail('transaction_does_not_match_review')
      return { ...reviewed, to: tx.to.toLowerCase() as Address, data: asHex(tx.input), value: numberToHex(quantity(tx.value)) }
    }, REVIEW_S)
    if (!candidate) return { receipt: { state: 'pending' } as V2Receipt, replaced: false, final: false }
    const same = candidate.to === reviewed.to && candidate.data.toLowerCase() === reviewed.data.toLowerCase() && BigInt(candidate.value) === BigInt(reviewed.value)
    const found = await receipt(candidateHash, candidate)
    let final = found.state === 'finalized'
    if (found.state === 'reverted') final = await reads(async (rpc) => {
      const block = await rpc('eth_getBlockByNumber', ['finalized', false]) as { number?: string } | null
      if (!block?.number || quantity(block.number) < found.blockNumber) return false
      const canonical = await rpc('eth_getBlockByNumber', [numberToHex(found.blockNumber), false]) as { hash?: string } | null
      return canonical?.hash?.toLowerCase() === found.blockHash
    }, REVIEW_S)
    return { receipt: found, replaced: !same, final }
  }

  return {
    chain,
    owner,
    bounded,
    identity,
    call,
    latestBlock,
    simulate,
    acceptsNativeEth,
    prepare,
    send,
    receipt,
    replacement,
    /**
     * Changed on purpose (data) 2026-10-02 (Domino V2 PHASE B, post-B4 review item 3 for the vault's and the mandate's
     * EIP-5792 batches): the same check a step makes before it is offered, for a batch, as V1's setup does before its
     * own: nothing of this owner in flight on this chain (latest equals pending, and no nonce latch held). Call inside
     * `bounded`.
     */
    freeNonce,
    /** Whether this step was handed to the wallet: its nonce is held until the chain says what became of it. */
    wasOffered: (prepared: PreparedV2) => offered.has(`${prepared.chainId}|${BigInt(prepared.transaction.nonce)}`),
    /**
     * Added 2026-11-02 (review A1, Close positions): where `nonce` stands for this owner on this chain, as V1's
     * ../setup.ts nonceStanding and S2's ./crosschain.ts `standing` say it: taken (`passed`), still the next one with
     * nothing pending (`open`), the next one behind something pending (`pending`), or ahead of the chain (`behind`).
     * Reads only. Call inside `bounded`.
     */
    async nonceStanding(rpc: Rpc, nonce: bigint): Promise<'passed' | 'open' | 'pending' | 'behind'> {
      const latest = quantity(await rpc('eth_getTransactionCount', [owner, 'latest']))
      const pending = quantity(await rpc('eth_getTransactionCount', [owner, 'pending']))
      if (latest > nonce) return 'passed'
      if (latest < nonce) return 'behind'
      return pending > latest ? 'pending' : 'open'
    },
    /**
     * Changed on purpose (data) 2026-10-02 (Domino V2 rev2 review, F3): "I rejected it in my wallet" for a step this
     * transactor offered with no answer. Its latch here and in the page's journal is let go only while the chain shows
     * that nonce still the next one with nothing pending (V1's rule, ../setup.ts forgetOpenRequest); true when it was.
     * Call inside `bounded`.
     */
    async forgetOffered(rpc: Rpc, nonce: bigint): Promise<boolean> {
      const latest = quantity(await rpc('eth_getTransactionCount', [owner, 'latest']))
      const pending = quantity(await rpc('eth_getTransactionCount', [owner, 'pending']))
      if (latest !== pending || latest !== nonce) return false
      offered.delete(key(nonce))
      if (wallet.nonceOffered(chain.chainId, nonce)) await wallet.forgetNonce?.(chain.chainId, nonce)
      return true
    },
  }
}
export type Transactor = ReturnType<typeof createTransactor>
