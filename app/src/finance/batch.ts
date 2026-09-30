import type { Address, Hex } from 'viem'

/**
 * EIP-5792 batches, as the owner clients share them (./setup.ts for Create position, ./sequence.ts for a sequence's
 * creation; docs/plans/2026-09-25-eip5792-batches-design.md): what the wallet can do, a batch simulated whole before
 * the wallet is asked, one offer behind the page's latch (./nonce.ts), and the wallet's status for it. What a batch
 * did is read from the chain by each client, from the state it was made to change. This is the one module that names
 * the batch methods (tests/session.source-guard.test.mjs).
 */

/** What the connected wallet says it can do with a batch on Robinhood Chain (EIP-5792 version 2, `atomic`). */
export type AtomicStatus = 'supported' | 'ready' | 'unsupported'
/** One call of a batch, as `wallet_sendCalls` carries it. */
export interface BatchCall { to: Address; data: Hex; value: Hex }
/** A simulation the page can run elsewhere when the wallet does not carry `eth_simulateV1` (the chain's own RPC). */
export type BatchSimulator = (params: unknown[]) => Promise<unknown>
/** The wallet's side of a batch: its provider, and the page's latch for the batch it offers, keyed by what the batch opens. */
export interface BatchWallet {
  owner: Address
  request(method: string, params: unknown[]): Promise<unknown>
  batchOffered?(key: Hex): string | null
  claimBatch?(key: Hex): Promise<string>
  recordBatch?(key: Hex, claim: string, id: string): Promise<void>
  releaseBatch?(key: Hex, claim: string): Promise<void>
}
type Request = (method: string, params: unknown[]) => Promise<unknown>

const fail = (code: string): never => { throw new Error(code) }
const quantity = (value: unknown): bigint => typeof value === 'string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value) ? BigInt(value) : fail('invalid_wallet_quantity')
/**
 * Gas a batch's own frame may add to its calls' (a delegate's execute, or a bundler's validation and EntryPoint): for
 * checking the owner can afford the batch only, since the wallet sets the batch's gas itself.
 */
export const BATCH_FRAME_GAS = 150_000n
/** EIP-5792's refusals of a batch the wallet cannot make, and JSON-RPC's unknown method: the step-by-step flow instead. */
export const BATCH_UNSUPPORTED: ReadonlySet<number> = new Set([4200, -32601, 5700, 5710, 5740, 5760])
/** An `eth_simulateV1` the provider does not carry, as opposed to a simulation that ran. */
const unsupportedMethod = (error: unknown) => {
  const node = error as { code?: unknown; message?: unknown } | null
  return !!node && (node.code === 4200 || node.code === -32601 || node.code === -32004
    || (typeof node.message === 'string' && /method .*(not (supported|found|available|exist))|unsupported method|does not exist/i.test(node.message)))
}

/**
 * The chain a key of a capabilities reply names: hex as EIP-5792 writes it ("0x1237", in either case, leading zeros
 * allowed), or decimal ("4663"), as viem's own getCapabilities reads both (Number(key)). Anything else names none.
 */
const chainOfKey = (key: string): number | null =>
  /^0x[0-9a-f]{1,16}$/i.test(key) ? Number.parseInt(key.slice(2), 16) : /^[0-9]{1,16}$/.test(key) ? Number(key) : null
/** The `atomic` status one chain's entry states, or null when it states none. */
const statusOf = (entry: unknown): unknown => {
  const atomic = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).atomic : null
  return atomic && typeof atomic === 'object' ? (atomic as Record<string, unknown>).status ?? null : null
}
const RANK: Record<AtomicStatus, number> = { unsupported: 0, ready: 1, supported: 2 }

/**
 * What a `wallet_getCapabilities` reply says of chain 4663 (EIP-5792 version 2). Its entry is found under any key that
 * names 4663, hex or decimal; entries that disagree count as the weakest of them. With no `atomic` there, the entry
 * under chain 0, which the standard reserves for what the wallet supports on every chain, is read instead. Any other
 * shape, version 1's `atomicBatch` included, is `unsupported`: version 1 wallets do not take the version 2 batch sent.
 */
export function atomicStatusOf(reply: unknown): AtomicStatus {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return 'unsupported'
  const found: unknown[] = [], everywhere: unknown[] = []
  for (const [key, entry] of Object.entries(reply as Record<string, unknown>)) {
    const chain = chainOfKey(key)
    const status = statusOf(entry)
    if (status === null) continue
    if (chain === 4663) found.push(status)
    else if (chain === 0) everywhere.push(status)
  }
  const stated = found.length > 0 ? found : everywhere
  if (stated.length === 0) return 'unsupported'
  return stated.map((status): AtomicStatus => (status === 'supported' || status === 'ready' ? status : 'unsupported'))
    .reduce((weakest, status) => (RANK[status] < RANK[weakest] ? status : weakest))
}

/**
 * The connected wallet's EIP-5792 atomic batches on chain 4663, read through its own provider: `supported` when the
 * account executes a batch atomically now, `ready` when the wallet would first upgrade it (EIP-7702) and asks the person
 * to, `unsupported` otherwise (atomicStatusOf reads the reply). A wallet that refuses the chain filter as an invalid
 * parameter (-32602, as drafts before version 2 took only the account) is asked once more without it. A read that
 * fails or times out is `unsupported`: no batch is offered then, and the steps go one by one. Reads only.
 */
export async function atomicStatus(wallet: { owner: Address; request: Request }, timeoutMs = 5_000): Promise<AtomicStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const ask = async () => {
    try {
      return await wallet.request('wallet_getCapabilities', [wallet.owner, ['0x1237']])
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== -32602) throw error
      return wallet.request('wallet_getCapabilities', [wallet.owner])
    }
  }
  try {
    return atomicStatusOf(await Promise.race([ask(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('wallet_timeout')), timeoutMs) })]))
  } catch {
    return 'unsupported'
  } finally { clearTimeout(timer) }
}

/**
 * A batch simulated whole before the wallet is asked (eth_simulateV1): each call from the owner, as the account's own
 * execution makes it, state carried from one to the next. Through the wallet, or through `fallback` when the wallet does
 * not carry the method (ten seconds at most); with neither, `batch_simulation_unavailable`. Any call that fails is
 * `batch_simulation_reverted`. The gas its calls used, together.
 */
export async function simulateBatch(request: Request, owner: Address, calls: readonly BatchCall[], fallback?: BatchSimulator): Promise<bigint> {
  const params = [{ blockStateCalls: [{ calls: calls.map(call => ({ from: owner, to: call.to, data: call.data, value: call.value })) }], validation: false }, 'latest']
  let reply: unknown
  try {
    reply = await request('eth_simulateV1', params)
  } catch (error) {
    if (!unsupportedMethod(error)) throw error
    if (!fallback) return fail('batch_simulation_unavailable')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      reply = await Promise.race([fallback(params), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('wallet_timeout')), 10_000) })])
    } catch { return fail('batch_simulation_unavailable') } finally { clearTimeout(timer) }
  }
  const block = Array.isArray(reply) && reply.length === 1 ? reply[0] as { calls?: unknown } : null
  const results = block && Array.isArray(block.calls) && block.calls.length === calls.length ? block.calls as { status?: unknown; gasUsed?: unknown }[] : fail('invalid_simulation_reply')
  if (results.some(result => result?.status !== '0x1')) return fail('batch_simulation_reverted')
  return results.reduce((sum, result) => sum + quantity(result.gasUsed), 0n)
}

/**
 * Offers a batch to the wallet once (EIP-5792 wallet_sendCalls, version 2.0.0, atomic required), after the latch for
 * `key` is claimed: another tab, or this one after a lost answer, is refused. `stillValid` is asked after the claim and
 * before the wallet: false frees the claim, since nothing was asked. A refusal in the wallet, or a wallet that cannot
 * batch, frees it; an answer that never came keeps it, and the chain decides later. The wallet's id for the batch.
 */
export async function offerBatch(request: Request, wallet: BatchWallet, key: Hex, calls: readonly BatchCall[], stillValid: () => boolean): Promise<string> {
  const { claimBatch, recordBatch, releaseBatch } = wallet
  if (!claimBatch || !recordBatch || !releaseBatch) return fail('batch_coordination_unavailable')
  const claim = await claimBatch(key)
  if (!stillValid()) {
    await releaseBatch(key, claim)
    return fail('wallet_review_expired')
  }
  let reply: unknown
  try {
    reply = await request('wallet_sendCalls', [{ version: '2.0.0', chainId: '0x1237', from: wallet.owner, atomicRequired: true, calls }])
  } catch (error) {
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
    // A definite refusal: nothing was sent, and nothing of it can execute.
    if (code === 4001 || code === 5750 || BATCH_UNSUPPORTED.has(code as number)) await releaseBatch(key, claim)
    if (code === 5750) return fail('batch_upgrade_declined')
    if (BATCH_UNSUPPORTED.has(code as number)) return fail('batch_unsupported')
    throw error
  }
  const id = typeof reply === 'string' ? reply : reply && typeof reply === 'object' ? (reply as { id?: unknown }).id : undefined
  if (typeof id !== 'string') return fail('wallet_result_unknown')
  await recordBatch(key, claim, id)
  return id
}

/**
 * The wallet's status code for a batch (EIP-5792 wallet_getCallsStatus): 100 pending, 200 confirmed, 400 not included,
 * 500 reverted. Null when there is no id to ask about (an answer that never came) or the wallet no longer knows it
 * (5730): the chain decides then.
 */
export async function batchCallsStatus(request: Request, id: string): Promise<number | null> {
  if (id === '') return null
  try {
    const reply = await request('wallet_getCallsStatus', [id]) as { status?: unknown } | null
    return reply && typeof reply.status === 'number' ? reply.status : fail('invalid_wallet_reply')
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== 5730) throw error
    return null
  }
}
