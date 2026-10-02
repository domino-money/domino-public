/**
 * New position on the second chain, as rugged97's actions service drives it (2026-10-01, the chain2 workstream, audit
 * items G2 and G7): prepare a draft, have the wallet sign exactly it, watch its receipt, and prepare the next one.
 *
 * The money logic is his, untouched: his service (uniswap-v3-actions-v1) prepares every transaction as a draft (the
 * exact calldata, gas, fee caps, nonce and the code pins of every contract it touches, under a content id his runtime's
 * verifyDraft checks), one transaction at a time: an exact token approval first where one is missing, then the vault's
 * open. This module only drives that sequence and refuses anything that is not exactly what was asked:
 * - a draft is used only when verifyDraft accepts it and it is for this owner, this vault and this very action, on the
 *   registry's chain, from the owner, not expired;
 * - before the wallet is asked, the vault is inspected again and must be in the state the draft was prepared for (his
 *   state hash, state nonce, policy version and the same code pins), as his own app does;
 * - the wallet is asked once per draft (`OwnerSigner`, which checks the chain, the account, the pending nonce, the code
 *   pins and the expiry again and sends nothing else); a refusal in the wallet goes back to the review, and nothing is
 *   ever sent again on its own;
 * - after a hash, only its receipt is asked, again and again by itself while it is pending (no Retry button), and the
 *   transaction it names must be the draft's (from, to, data, value, nonce), or the flow stops as replaced;
 * - the next draft is prepared only after the previous one's receipt says confirmed.
 *
 * Pure: the service, the wallet, the clock and the pause are handed in (tests/elysium-flow.test.mjs).
 */
import type { ChainConfig } from '../../config/chainKit'
import type { Draft, InspectResponse, OpenAction, PrepareResponse, ReceiptResponse } from '../../../functions/_lib/uniswap-v3/contracts/uniswap-v3-actions-v1/types'
import { ServiceError, type Identity, type V3Api } from './api'

export type SignerFailure = 'rejected' | 'wrong_chain' | 'account_changed' | 'nonce_changed' | 'code_changed' | 'expired' | 'unavailable' | 'failed'

export class SignerError extends Error {
  constructor(
    readonly kind: SignerFailure,
    message: string,
  ) {
    super(message)
    this.name = 'SignerError'
  }
}

/** The wallet side (part B wires the concrete one): sends exactly the draft's transaction, once, and returns its hash. */
export interface OwnerSigner {
  send(draft: Draft, signal?: AbortSignal): Promise<string>
}

export interface OpenInput {
  readonly owner: string
  readonly vault: string
  readonly tickLower: number
  readonly tickUpper: number
  readonly amount0Raw: string
  readonly amount1Raw: string
  readonly slippageBps: number
}

/** Why the flow stopped, in words the screen maps to a sentence. */
export type FlowStop =
  /** His service did not answer, or refused. */
  | 'service'
  /** The draft was not for this owner, vault, action or chain, or did not verify. */
  | 'draft_changed'
  /** The vault changed after the draft was prepared. */
  | 'state_changed'
  | 'expired'
  /** The wallet could not send (another chain, another account, a nonce or code that changed). */
  | 'wallet'
  | 'reverted'
  /** The receipt names another transaction: it was replaced in the wallet. */
  | 'replaced'

export type FlowState =
  | { readonly step: 'idle' }
  | { readonly step: 'preparing'; readonly transaction: number }
  | { readonly step: 'review'; readonly draft: Draft; readonly transaction: number; readonly refused: boolean }
  | { readonly step: 'checking'; readonly draft: Draft; readonly transaction: number }
  | { readonly step: 'wallet'; readonly draft: Draft; readonly transaction: number }
  | { readonly step: 'confirming'; readonly draft: Draft; readonly transaction: number; readonly hash: string; readonly slow: boolean }
  | { readonly step: 'done'; readonly hashes: readonly string[]; readonly block: number }
  | { readonly step: 'stopped'; readonly reason: FlowStop; readonly detail: string | null; readonly hash: string | null; readonly transaction: number }

/** A transaction the flow sent, for the receipts list (receipts.ts). */
export interface SentTransaction {
  readonly hash: string
  readonly vault: string
  readonly owner: string
  readonly step: Draft['step']
  readonly sentAt: number
}

export interface FlowDeps {
  readonly chain: ChainConfig
  readonly api: V3Api
  readonly identity: Identity
  readonly signer: OwnerSigner
  /** Milliseconds. */
  now(): number
  pause(ms: number, signal?: AbortSignal): Promise<void>
  onChange(state: FlowState): void
  /** Told of every hash the wallet returned, before its receipt is asked. */
  sent?(transaction: SentTransaction): void
  /** Told of every receipt's outcome. */
  settled?(hash: string, state: 'confirmed' | 'reverted' | 'replaced', block: number | null): void
}

/** How often a pending receipt is asked again: often at first, then less, never stopping on its own. */
export const RECEIPT_ASK_MS = 3_000
export const RECEIPT_SLOW_MS = 120_000
export const RECEIPT_SLOW_ASK_MS = 10_000
/** A draft is not sent with less than this left before it expires (the wallet's prompt takes time). */
export const EXPIRY_MARGIN_S = 10

const canonical = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])])) : value
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))

/** The open action an input asks for, exactly as his schema writes it. */
export function openAction(input: OpenInput): OpenAction {
  return { kind: 'open', tickLower: input.tickLower, tickUpper: input.tickUpper, amount0Raw: input.amount0Raw, amount1Raw: input.amount1Raw, slippageBps: input.slippageBps }
}

/** Whether a prepared answer is the draft asked for: verified, this owner's, this vault's, this action, this chain, in time. */
export async function draftFits(deps: Pick<FlowDeps, 'chain' | 'api' | 'now'>, prepared: PrepareResponse, input: OpenInput, action: OpenAction): Promise<boolean> {
  const draft = prepared.draft
  const owner = input.owner.toLowerCase()
  const vault = input.vault.toLowerCase()
  return (
    (await deps.api.runtimes.actions.runtime.verifyDraft(draft)) &&
    prepared.owner === owner &&
    prepared.vault === vault &&
    draft.owner === owner &&
    draft.vault === vault &&
    same(draft.action, action) &&
    draft.transaction.chainId === deps.chain.id &&
    draft.transaction.from === owner &&
    draft.transaction.valueRaw === '0' &&
    draft.expiresAt > Math.floor(deps.now() / 1000) + EXPIRY_MARGIN_S
  )
}

/** Whether a fresh inspection of the vault is the state the draft was prepared for. */
export const stateFits = (draft: Draft, fresh: InspectResponse): boolean =>
  fresh.vault === draft.vault && fresh.owner === draft.owner && fresh.stateHash === draft.stateHash && fresh.stateNonce === draft.stateNonce && fresh.policyVersion === draft.policyVersion && same(fresh.contractPins, draft.contractPins)

/** Whether a receipt is the draft's own transaction. A pending one names none yet. */
export function receiptFits(draft: Draft, hash: string, receipt: ReceiptResponse): boolean {
  if (receipt.transactionHash !== hash || receipt.owner !== draft.owner || receipt.vault !== draft.vault) return false
  if (!receipt.transaction) return receipt.state === 'pending'
  const sent = draft.transaction
  return receipt.transaction.from === sent.from && receipt.transaction.to === sent.to && receipt.transaction.data === sent.data && receipt.transaction.valueRaw === sent.valueRaw && receipt.transaction.nonce === sent.nonce
}

export interface OpenFlow {
  start(input: OpenInput): Promise<void>
  /** Asks the wallet for the draft under review (from 'review' only). */
  confirm(): Promise<void>
  /** Stops waiting and forgets the review; a sent transaction's receipt stays the receipts list's to follow. */
  cancel(): void
  state(): FlowState
}

export function createOpenFlow(deps: FlowDeps): OpenFlow {
  let state: FlowState = { step: 'idle' }
  let controller: AbortController | null = null
  let input: OpenInput | null = null
  const hashes: string[] = []

  const set = (next: FlowState) => {
    state = next
    deps.onChange(next)
  }
  const stop = (reason: FlowStop, transaction: number, detail: string | null = null, hash: string | null = null) => set({ step: 'stopped', reason, detail, hash, transaction })
  const live = (signal: AbortSignal) => !signal.aborted

  async function prepare(transaction: number, signal: AbortSignal): Promise<void> {
    if (!input) return
    set({ step: 'preparing', transaction })
    const action = openAction(input)
    let prepared: PrepareResponse
    try {
      prepared = await deps.api.actions('prepare', { ...deps.identity, owner: input.owner.toLowerCase(), vault: input.vault.toLowerCase(), action }, deps.identity, signal)
    } catch (error) {
      if (!live(signal)) return
      return stop('service', transaction, error instanceof ServiceError ? (error.code ?? error.kind) : null)
    }
    if (!live(signal)) return
    if (!(await draftFits(deps, prepared, input, action))) return stop('draft_changed', transaction)
    if (live(signal)) set({ step: 'review', draft: prepared.draft, transaction, refused: false })
  }

  async function follow(draft: Draft, hash: string, transaction: number, signal: AbortSignal): Promise<void> {
    const since = deps.now()
    for (;;) {
      if (!live(signal)) return
      let receipt: ReceiptResponse | null = null
      try {
        receipt = await deps.api.actions('receipt', { ...deps.identity, owner: draft.owner, vault: draft.vault, transactionHash: hash }, deps.identity, signal)
      } catch (error) {
        // A service that does not answer now is asked again; the transaction is never sent again.
        if (!live(signal) || (error instanceof ServiceError && error.kind === 'aborted')) return
      }
      if (receipt) {
        if (!receiptFits(draft, hash, receipt)) {
          deps.settled?.(hash, 'replaced', null)
          return stop('replaced', transaction, null, hash)
        }
        if (receipt.state === 'reverted') {
          deps.settled?.(hash, 'reverted', receipt.anchor?.number ?? null)
          return stop('reverted', transaction, receipt.gasUsedRaw, hash)
        }
        if (receipt.state === 'confirmed') {
          deps.settled?.(hash, 'confirmed', receipt.anchor?.number ?? null)
          if (draft.readyForAction) return set({ step: 'done', hashes: [...hashes], block: receipt.anchor?.number ?? 0 })
          // An approval confirmed: the next transaction is prepared now, from the vault's new state.
          return prepare(transaction + 1, signal)
        }
      }
      const slow = deps.now() - since >= RECEIPT_SLOW_MS
      if (state.step === 'confirming' && state.slow !== slow) set({ ...state, slow })
      await deps.pause(slow ? RECEIPT_SLOW_ASK_MS : RECEIPT_ASK_MS, signal)
    }
  }

  return {
    state: () => state,
    async start(next) {
      controller?.abort()
      controller = new AbortController()
      input = next
      hashes.length = 0
      await prepare(1, controller.signal)
    },
    async confirm() {
      if (state.step !== 'review' || !controller || !input) return
      const signal = controller.signal
      const { draft, transaction } = state
      set({ step: 'checking', draft, transaction })
      if (draft.expiresAt <= Math.floor(deps.now() / 1000) + EXPIRY_MARGIN_S) return stop('expired', transaction)
      let fresh: InspectResponse
      try {
        fresh = await deps.api.actions('inspect', { ...deps.identity, vault: draft.vault }, deps.identity, signal)
      } catch (error) {
        if (!live(signal)) return
        return stop('service', transaction, error instanceof ServiceError ? (error.code ?? error.kind) : null)
      }
      if (!live(signal)) return
      if (!stateFits(draft, fresh) || !(await deps.api.runtimes.actions.runtime.verifyDraft(draft))) return stop('state_changed', transaction)
      set({ step: 'wallet', draft, transaction })
      let hash: string
      try {
        hash = (await deps.signer.send(draft, signal)).toLowerCase()
      } catch (error) {
        if (!live(signal)) return
        // Refused in the wallet: nothing was sent, and the same draft may be reviewed again.
        if (error instanceof SignerError && error.kind === 'rejected') return set({ step: 'review', draft, transaction, refused: true })
        if (error instanceof SignerError && error.kind === 'expired') return stop('expired', transaction)
        return stop('wallet', transaction, error instanceof SignerError ? error.kind : null)
      }
      if (!/^0x[0-9a-f]{64}$/.test(hash)) return stop('wallet', transaction, 'invalid_hash')
      hashes.push(hash)
      deps.sent?.({ hash, vault: draft.vault, owner: draft.owner, step: draft.step, sentAt: deps.now() })
      set({ step: 'confirming', draft, transaction, hash, slow: false })
      await follow(draft, hash, transaction, signal)
    },
    cancel() {
      controller?.abort()
      controller = null
      input = null
      set({ step: 'idle' })
    },
  }
}
