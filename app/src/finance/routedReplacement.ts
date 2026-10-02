import { decodeFunctionData, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, pad, zeroAddress, type Address, type Hex } from 'viem'
import { ROUTE_PERMIT2, UNIVERSAL_ROUTER } from './pin.js'
import type { RouteEvidence } from './routedJournal.js'
import { routeExecuteAbi, routePermitAbi } from './routedSwap.js'

/**
 * What took the nonce of a routed Uniswap swap the wallet replaced (fix round 2, 2026-10-01). "Speed up" sends the same
 * router call under another hash; "Cancel" sends 0 ETH to the account itself. The swap's own hash is never mined in
 * either case, so only the transaction at its nonce tells them apart. It is found in the block where the account's
 * mined nonce passed it (its nonce read at block heights, a few dozen reads at most), then its receipt is read.
 * - `swapped`: the reviewed router call succeeded: the swap happened and its fee was collected, so a second swap must
 *   never be offered for this deposit;
 * - `spent` (fix round 3.1): the input's Permit2 allowance reads exactly as the reviewed swap leaves it once it has taken
 *   its input (the amount less the swap's input, the same expiry and nonce). Changed on purpose in fix round 3.2: a sign,
 *   not proof. The swap most likely went through, but the owner revoking the allowance (Permit2's lockdown, or approve to 0
 *   with the same expiry) leaves the same state with nothing swapped. Every guard of `swapped` holds (no second swap is
 *   offered for the deposit), and the page never says the swap went through on this alone (CreatePosition.tsx ROUTE_SPENT).
 *   What proves the swap (the reviewed call found at the nonce or by its logs) is read first, and reads `swapped`;
 * - `reverted`: the reviewed router call at that nonce reverted: nothing was swapped and no swap fee was collected;
 * - `not_swapped`: the swap did not happen and never can now (below);
 * - `untouched` (fix round 3.1): the swap has not taken its input, but nothing yet proves it never can: its allowance
 *   expires at `until` (seconds, the chain's time), after which a press finds it `not_swapped`;
 * - `changed` (fix round 3.1): the allowance was read and has changed otherwise since the send (set again, spent by
 *   another amount, signed again): the wallet used Uniswap meanwhile, and nothing more is known. Fix round 3.2: never let
 *   go on the person's word while the reviewed call could still go through; once its deadline has passed on the chain's
 *   clock (RouteEvidence.deadline), it is one nothing could tell apart, as `unknown` (CreatePosition.tsx);
 * - `unknown`: it could not be told apart (nothing read, or nothing to read: an ETH input). The caller keeps every guard
 *   against a second swap (no new swap is offered on its own) and says so; only the person's own word after checking
 *   their wallet lets it go (CreatePosition.tsx).
 *
 * Changed on purpose in fix round 3 (2026-10-01): the nonce read at a block height needs that block's state, and the
 * wallet's RPC keeps little of it (about 2,000 blocks, some 3 minutes, on the chain's own RPC; none on publicnode). The
 * search never goes further back than the block the swap was sent after (`sentAfter`, kept in the journal); a router
 * call that succeeded is the swap only when its calldata is the reviewed one (`swap`, its keccak256).
 *
 * Changed on purpose in fix round 3.1 (2026-10-01), after the recheck of 3267fe6:
 * - a wallet may sign the swap under a nonce of its own (MetaMask sets its own), so the transaction at the nonce the page
 *   prepared is not surely the swap's replacement. `not_swapped` now needs proof that holds whatever nonce the swap went
 *   out with: a transaction shaped as a wallet's Cancel (0 ETH to the account itself, no data) at the nonce, and for an
 *   ERC-20 input the allowance read untouched beside it; or the allowance untouched and expired (Permit2 refuses an
 *   expired allowance, and the reviewed router call carries the same deadline), so nothing can take the input any more.
 *   Any other transaction at the nonce is not taken for a cancel;
 * - a spent allowance is `spent`, never `unknown`, and an allowance changed otherwise is `changed`: neither is ever let
 *   go on the person's word;
 * - where old state is gone, the reviewed router call is looked for by the pool's tokens it moved for this wallet (two
 *   eth_getLogs per ERC-20 token of the pool, Transfer to and from the wallet, from the block the swap was sent after,
 *   inside the chain RPC's 100,000-block limit even for a filter of several values), so an ETH input that went through
 *   reads `swapped` too. Logs only ever prove the swap; an empty answer proves nothing;
 * - a refused nonce read on the way down (state the node no longer keeps) ends the doubling there and the search
 *   bisects above it, instead of giving up.
 *
 * Changed on purpose in fix round 3.2 (2026-10-02), after the recheck of 418f7bf:
 * - the logs are read oldest first: the reviewed call is mined right after the block it was sent after, so it is the
 *   oldest of the window, and a wallet busy with that token since never pushes it past the transactions looked at;
 * - a wallet's RPC that refuses state at a numbered block (dRPC answers 'latest' only) still shows a spent or changed
 *   allowance, read at 'latest': a node behind cannot show a spend that has not happened, and either keeps every guard.
 *   An untouched allowance counts only where it is read at a block where the nonce is seen passed;
 * - the allowance kept at the send is only ever the one the swap was offered against (exactly its input): a node still
 *   behind the permit just mined is read again a moment later, and its stale answer never kept (settledPermit);
 * - a swap offered with no hash back (`unanswered`): a transaction shaped as a Cancel at its nonce proves nothing, since
 *   the wallet may still show the swap and sign it under the next nonce; the page waits for the router call's deadline;
 * - what this cannot tell apart, said plainly: an ETH input (no allowance to read) whose replacement is in state the
 *   wallet's RPC no longer keeps, on an RPC that serves no logs from the block it was sent after (publicnode serves logs
 *   only about 100 blocks back, dRPC only spans of 100 to 200 blocks), reads `unknown`: the page says it could not
 *   confirm the swap and asks the person to check their wallet activity. The logs prove the swap only where the RPC
 *   serves them (the chain's own RPC does).
 * Every read goes through the wallet's own provider (the caller's `request`); a wallet whose reads go through the page's
 * own line (WalletConnect) is asked none of them (walletOwnReads).
 */
export type RoutedReplacement = 'swapped' | 'spent' | 'reverted' | 'not_swapped' | 'untouched' | 'changed' | 'unknown'
export interface ReplacementFinding { kind: RoutedReplacement; until?: number }
type Request = (method: string, params: unknown[]) => Promise<unknown>
interface ChainTx { hash?: string; from?: string; to?: string | null; input?: string; nonce?: string; value?: string }
/** A Permit2 allowance as Permit2.allowance(owner, token, spender) returns it. */
export interface PermitState { amount: bigint; expiration: bigint; nonce: bigint }
/** The pool a routed swap was for: its PoolKey. */
export interface RoutePoolKey { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }
/**
 * Where to look (fix round 3.1): `tokens`, the pool's currencies; `input`, the swap's input token when known (the same
 * press); `thisPool`, whether the record is known to be this pool's (its digest matched), so its input is surely among
 * `tokens` and an allowance that matches neither digest has changed. `unanswered` (fix round 3.2): the swap was offered
 * with no hash back, so the wallet may still show it: a Cancel-shaped transaction at its nonce proves nothing.
 */
export interface ReplacementContext { tokens: readonly string[]; input?: string; thisPool?: boolean; unanswered?: boolean }

/** Reads of the account's nonce at block heights, at most: about 2^23 blocks back, far past what a node keeps. */
const MAX_READS = 48
/** How far under the head read before the send `sentAfter` is kept: a node a few blocks ahead of the one that checked the nonce. */
const SENT_MARGIN = 8n
/** Permit2 never spends from an allowance of the largest amount (it stays unlimited): such an allowance proves nothing. */
const UNLIMITED = 2n ** 160n - 1n
/** The most blocks one log read spans: the chain RPC's limit for a filter with several values in a place (functions/_lib/owned.ts). */
const LOG_SPAN = 100_000n
/** The transactions that moved a pool's token for this wallet that are looked at, at most: the oldest first (fix round 3.2). */
const MAX_LOG_TXS = 8
/** How far this device's clock may be ahead of the chain's, in seconds, where the chain's cannot be read (deadlinePassed). */
const CLOCK_MARGIN = 300n
/** Reads of the router's allowance before a swap is offered, and the pause between them, for a node behind the permit (settledPermit). */
const EVIDENCE_READS = 3
const EVIDENCE_PAUSE_MS = 500
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const quantity = (value: unknown): bigint | null => (typeof value === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(value) ? BigInt(value) : null)
const hex = (value: bigint) => `0x${value.toString(16)}`
const isAddress = (value: string) => /^0x[0-9a-f]{40}$/.test(value)
const isHash = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
/** The ERC-20 tokens among `values`, lowercased, each once. */
const erc20s = (values: readonly string[]) => [...new Set(values.map(value => value.toLowerCase()))].filter(value => value !== zeroAddress && isAddress(value))

/** The reviewed router calldata as the journal keeps it: its keccak256 only. */
export const swapDigest = (data: Hex) => keccak256(data.toLowerCase() as Hex)
/** A Permit2 allowance of `owner` for `token` to the router, as the journal keeps it: a digest only. */
export function permitDigest(owner: string, token: string, state: PermitState): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'string' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint160' }, { type: 'uint48' }, { type: 'uint48' }],
    ['domino.routed-permit.v1', owner.toLowerCase() as Address, token.toLowerCase() as Address, UNIVERSAL_ROUTER, state.amount, Number(state.expiration), Number(state.nonce)]))
}
/** The owner and the pool a routed swap was for, as the journal keeps them: a digest only (fix round 3.1). */
export function poolDigest(owner: string, key: RoutePoolKey): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'string' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
    ['domino.routed-pool.v1', owner.toLowerCase() as Address, key.currency0.toLowerCase() as Address, key.currency1.toLowerCase() as Address, key.fee, key.tickSpacing, key.hooks.toLowerCase() as Address]))
}
/** Permit2.allowance(owner, token, router) at block `at` (the latest by default), through the wallet. */
export async function permitOf(request: Request, owner: string, token: string, at = 'latest'): Promise<PermitState> {
  const data = encodeFunctionData({ abi: routePermitAbi, functionName: 'allowance', args: [owner as Address, token as Address, UNIVERSAL_ROUTER] })
  const reply = await request('eth_call', [{ to: ROUTE_PERMIT2, data }, at])
  if (typeof reply !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(reply)) throw new Error('invalid_permit_allowance')
  const [amount, expiration, nonce] = decodeFunctionResult({ abi: routePermitAbi, functionName: 'allowance', data: reply as Hex })
  return { amount, expiration: BigInt(expiration), nonce: BigInt(nonce) }
}

/**
 * The connected wallet's own reads, for telling a replaced swap apart (fix round 3.1): null when the wallet answers no
 * reads itself and its provider hands them to the site instead (WalletConnect, wallet/walletConnect.ts), which serves no
 * read of the chain (lib/walletReads.ts readOnChain refuses each, RPC-SPEC D6; the owner's rule: nothing is read from a
 * public RPC). None is asked then: the journal keeps no read evidence, and a replacement reads `unknown`.
 */
export function walletOwnReads(rpc: { request(method: string, params: unknown[]): Promise<unknown>; readsThroughPage?: boolean }): Request | null {
  return rpc.readsThroughPage === true ? null : (method, params) => rpc.request(method, params)
}

/**
 * What the swap about to be sent leaves in the journal (fix round 3): read right before it is offered to the wallet,
 * once its nonce is known to be the next one. A read that fails leaves its part out, and the swap goes on as before:
 * a replacement is then told apart only from what the chain still keeps. `reads` null (walletOwnReads): nothing is read,
 * and only the digests that need no read are kept. `gross`: the swap's input, for the allowance it leaves (`spent`).
 */
export async function routeEvidence(reads: Request | null, owner: string, tokenIn: string, gross: bigint, data: Hex, key: RoutePoolKey): Promise<RouteEvidence> {
  const token = tokenIn.toLowerCase()
  const erc20 = token !== zeroAddress && isAddress(token)
  const [head, permit] = reads === null ? [null, null] : await Promise.all([
    reads('eth_blockNumber', []).then(quantity, () => null),
    erc20 ? settledPermit(reads, owner, token, gross) : Promise.resolve(null),
  ])
  return {
    sentAfter: head === null ? null : head > SENT_MARGIN ? head - SENT_MARGIN : 0n,
    swap: swapDigest(data),
    permit: permit ? permitDigest(owner, token, permit) : null,
    spent: permit && gross > 0n && permit.amount >= gross ? permitDigest(owner, token, { ...permit, amount: permit.amount - gross }) : null,
    pool: poolDigest(owner, key),
    deadline: routeDeadline(data),
  }
}

/**
 * The router's Permit2 allowance as the swap about to be offered finds it (fix round 3.2). The swap is offered only once
 * that allowance is exactly its input (finance/setup.ts prepareRoutedStep), so any other reading is a node still behind
 * the permit just mined: it is read again a moment later, a few times, and never kept. Kept stale, a later cancel read
 * as `changed` and a swap that went through matched neither digest. A read that fails leaves it out, as before; an
 * unlimited allowance is never spent from, so it proves nothing.
 */
async function settledPermit(reads: Request, owner: string, token: string, gross: bigint): Promise<PermitState | null> {
  for (let attempt = 1; ; attempt++) {
    const state = await permitOf(reads, owner, token).catch(() => null)
    if (!state) return null
    if (state.amount === gross && state.amount < UNLIMITED) return state
    if (attempt >= EVIDENCE_READS) return null
    await new Promise(resolve => setTimeout(resolve, EVIDENCE_PAUSE_MS))
  }
}

/**
 * The reviewed router call's deadline (fix round 3.2): the third argument of Universal Router's execute, seconds on the
 * chain's clock, read from the calldata itself, so it needs no read (and is kept for a WalletConnect wallet too). Null for
 * calldata that is not one (it was checked before it was offered: finance/routedSwap.ts checkRoutedSwap).
 */
export function routeDeadline(data: Hex): bigint | null {
  try {
    const deadline = decodeFunctionData({ abi: routeExecuteAbi, data }).args[2]
    return deadline > 0n && deadline < 2n ** 64n ? deadline : null
  } catch { return null }
}

/**
 * Whether the chain's clock is past `deadline` (fix round 3.2), the router call's: then it can never go through. Read as
 * the newest block's time through the wallet's own provider (a node behind answers an older time: never past too soon).
 * A wallet that answers no reads itself (walletOwnReads null), or a read that fails: this device's clock less the five
 * minutes it may be ahead of the chain's (the swap's own check refuses a clock further off), never a read of the site's
 * (it serves none, RPC-SPEC D6). False for no deadline.
 */
export async function deadlinePassed(reads: Request | null, deadline: bigint | null, deviceNow = Date.now() / 1000): Promise<boolean> {
  if (deadline === null) return false
  if (reads) {
    try {
      const block = await reads('eth_getBlockByNumber', ['latest', false]) as { timestamp?: unknown } | null
      const time = quantity(block?.timestamp)
      if (time !== null) return time > deadline
    } catch { /* this device's clock, below */ }
  }
  return BigInt(Math.floor(deviceNow)) - CLOCK_MARGIN > deadline
}

/**
 * `evidence`: what the journal kept at the send (null for a record of the release before); `context`: where the swap's
 * tokens may be (ReplacementContext).
 */
export async function routedReplacement(request: Request, owner: Address, nonce: bigint, evidence: RouteEvidence | null, context: ReplacementContext = { tokens: [] }): Promise<ReplacementFinding> {
  let history: History
  try { history = await fromHistory(request, owner, nonce, evidence) } catch { history = 'unknown' }
  if (history === 'swapped' || history === 'reverted') return { kind: history }
  // The reviewed call, found by what it paid this wallet: proof that needs no old state, nor the nonce it went out with.
  if (await fromLogs(request, owner, evidence, context).catch(() => false)) return { kind: 'swapped' }
  const permit = await fromPermit(request, owner, nonce, evidence, context).catch(() => null)
  // Fix round 3.2: a sign of the swap, not proof (a revoke leaves the same allowance): the caller keeps every guard of a
  // completed swap and never says it went through on this alone.
  if (permit?.state === 'spent') return { kind: 'spent' }
  // Fix round 3.2: a swap offered with no hash back may still be in the wallet, to be signed under the next nonce: a cancel
  // at its nonce proves nothing for it, only an allowance that can no longer be spent does.
  const cancelled = history === 'cancel' && context.unanswered !== true
  if (permit?.state === 'untouched') return permit.expired || cancelled ? { kind: 'not_swapped' } : { kind: 'untouched', until: permit.until }
  if (permit?.state === 'changed') return { kind: 'changed' }
  // No allowance to tell by (an ETH input, or one that could not be read at the send): a cancel at the nonce is the swap's.
  // An allowance kept at the send but unread now proves nothing beside it.
  if (cancelled && !evidence?.permit) return { kind: 'not_swapped' }
  return { kind: 'unknown' }
}

/** What the transaction at the swap's nonce is: the reviewed call (`swapped`, `reverted`), a wallet's Cancel, anything else. */
type History = 'swapped' | 'reverted' | 'cancel' | 'other' | 'unknown'

/** The transaction at `nonce` as the chain's recent state finds it, and what it did. */
async function fromHistory(request: Request, owner: Address, nonce: bigint, evidence: RouteEvidence | null): Promise<History> {
  const account = owner.toLowerCase()
  let reads = 0
  const countAt = async (block: bigint) => {
    if (++reads > MAX_READS) throw new Error('replacement_search_too_long')
    const count = quantity(await request('eth_getTransactionCount', [owner, hex(block)]))
    if (count === null) throw new Error('invalid_transaction_count')
    return count
  }
  /** The nonce at `block`, or null where the node refused it (state it no longer keeps): never past MAX_READS. */
  const countOrNull = (block: bigint) => countAt(block).catch((error: unknown) => {
    if (error instanceof Error && error.message === 'replacement_search_too_long') throw error
    return null
  })
  const latest = quantity(await request('eth_blockNumber', []))
  if (latest === null || await countAt(latest) <= nonce) return 'unknown'
  // `high`: a block where the nonce has passed; `low`: one where it had not, or that cannot be read (-1: before the first
  // block). The block the swap was sent after is such a `low` with no read: its state may be long gone.
  const sentAfter = evidence?.sentAfter ?? null
  let high = latest, low = sentAfter !== null && sentAfter < latest ? sentAfter : -1n
  for (let step = 1n; latest - step > low; step *= 2n) {
    const probe = latest - step
    const count = await countOrNull(probe)
    // Fix round 3.1: a refused read ends the doubling there; the block is searched for above it.
    if (count !== null && count > nonce) high = probe
    else { low = probe; break }
  }
  while (high - low > 1n) {
    const middle: bigint = (low + high) / 2n
    const count = await countOrNull(middle)
    if (count !== null && count > nonce) high = middle
    else low = middle
  }
  // A block found above state the node no longer keeps may not hold the transaction: its body says (never assumed).
  const block = await request('eth_getBlockByNumber', [hex(high), true]) as { transactions?: unknown[] } | null
  const tx = (block?.transactions ?? []).find((entry): entry is ChainTx => typeof entry === 'object' && entry !== null
    && (entry as ChainTx).from?.toLowerCase() === account && quantity((entry as ChainTx).nonce) === nonce)
  if (!tx || !isHash(tx.hash)) return 'unknown'
  const to = typeof tx.to === 'string' ? tx.to.toLowerCase() : null
  const input = typeof tx.input === 'string' && tx.input !== '' ? tx.input.toLowerCase() : '0x'
  if (to === UNIVERSAL_ROUTER) {
    // Only the reviewed call is the swap, included or reverted (fix round 3.1: a reverted router call too). Another
    // router call did something else, and what it left is not the reviewed deposit.
    if (!evidence?.swap || !/^0x(?:[0-9a-f]{2})*$/.test(input) || swapDigest(input as Hex) !== evidence.swap) return 'other'
    const receipt = await request('eth_getTransactionReceipt', [tx.hash]) as { transactionHash?: string; status?: string } | null
    if (receipt?.transactionHash?.toLowerCase() !== tx.hash.toLowerCase()) return 'unknown'
    if (receipt.status === '0x0') return 'reverted'
    return receipt.status === '0x1' ? 'swapped' : 'unknown'
  }
  // A wallet's Cancel: 0 ETH to the account itself, no data. Anything else at the nonce (another dapp's transaction the
  // wallet put there, a call the account's own code runs) is not taken for one.
  return to === account && input === '0x' && quantity(tx.value) === 0n ? 'cancel' : 'other'
}

/**
 * Whether the reviewed router call succeeded, found by the pool's tokens it moved for this wallet since the block the swap
 * was sent after (fix round 3.1): two eth_getLogs per ERC-20 token of the pool (Transfer to the wallet, its output; and
 * from it, an ERC-20 input), a single value in each place, spanning LOG_SPAN blocks at most; then each transaction found
 * is read until one is this wallet's reviewed call with its receipt successful. Whatever nonce it went out with. False
 * proves nothing.
 */
async function fromLogs(request: Request, owner: Address, evidence: RouteEvidence | null, context: ReplacementContext): Promise<boolean> {
  if (!evidence?.swap || evidence.sentAfter === null) return false
  const tokens = erc20s([...context.tokens, ...(context.input ? [context.input] : [])])
  if (!tokens.length) return false
  const head = quantity(await request('eth_blockNumber', []))
  if (head === null || head <= evidence.sentAfter) return false
  const from = evidence.sentAfter + 1n
  const to = head < evidence.sentAfter + LOG_SPAN ? head : evidence.sentAfter + LOG_SPAN
  const account = owner.toLowerCase()
  const found: { hash: string; block: bigint; index: bigint }[] = [], party = pad(account as Hex)
  // What it paid this wallet (its output), and what it took from it (an ERC-20 input, for a swap whose output is ETH).
  for (const [token, topics] of tokens.flatMap(token => [[token, [TRANSFER, null, party]], [token, [TRANSFER, party]]] as const)) {
    const logs = await request('eth_getLogs', [{ address: token, topics, fromBlock: hex(from), toBlock: hex(to) }]).catch(() => null)
    if (!Array.isArray(logs)) continue
    for (const log of logs) {
      const entry = log as { transactionHash?: unknown; blockNumber?: unknown; logIndex?: unknown } | null
      // A log with no block (pending) goes last.
      if (isHash(entry?.transactionHash)) found.push({ hash: entry.transactionHash.toLowerCase(), block: quantity(entry.blockNumber) ?? 2n ** 64n, index: quantity(entry.logIndex) ?? 0n })
    }
  }
  // Changed on purpose in fix round 3.2: the oldest first, by block and place in it, across every filter. The reviewed call
  // is mined right after the block it was sent after, so it is the oldest of the window; read newest first (as it was), a
  // wallet with eight later transfers of that token pushed it out, and an ETH input that went through read `unknown`.
  found.sort((a, b) => (a.block === b.block ? (a.index < b.index ? -1 : a.index > b.index ? 1 : 0) : a.block < b.block ? -1 : 1))
  const hashes = [...new Set(found.map(entry => entry.hash))]
  for (const hash of hashes.slice(0, MAX_LOG_TXS)) {
    const tx = await request('eth_getTransactionByHash', [hash]) as ChainTx | null
    const input = typeof tx?.input === 'string' ? tx.input.toLowerCase() : ''
    if (tx?.hash?.toLowerCase() !== hash || tx.from?.toLowerCase() !== account || tx.to?.toLowerCase() !== UNIVERSAL_ROUTER
      || !/^0x(?:[0-9a-f]{2})*$/.test(input) || swapDigest(input as Hex) !== evidence.swap) continue
    const receipt = await request('eth_getTransactionReceipt', [hash]) as { transactionHash?: string; status?: string } | null
    if (receipt?.transactionHash?.toLowerCase() === hash && receipt.status === '0x1') return true
  }
  return false
}

/**
 * The input's Permit2 allowance as it is now (fix rounds 3 and 3.1), read at one block where the nonce has passed, so
 * the transaction that took it is in the state read (a node behind that block refuses the reads: never an older state, as
 * a lagging node could answer 'latest'), with that block's time:
 * - `untouched`: exactly as before the send. `expired` once that time is past its expiry: Permit2 then refuses to spend
 *   it, and the reviewed router call, which carries the same deadline, reverts, so nothing can take the input any more;
 * - `spent`: exactly as the reviewed swap leaves it (a sign, fix round 3.2: a revoke leaves it so too);
 * - `changed`: read for every token the input may be, matching neither, where the input is surely among them.
 * Null: nothing to read, or nothing read.
 *
 * Fix round 3.2: where the wallet's RPC refuses state at a numbered block (dRPC answers 'latest' only), the allowance is
 * read at 'latest', and only `spent` and `changed` are taken from it: a node behind cannot show a spend that has not
 * happened, and either keeps every guard; `untouched` there could be a node behind the swap, so it counts as unread.
 */
async function fromPermit(request: Request, owner: Address, nonce: bigint, evidence: RouteEvidence | null, context: ReplacementContext):
  Promise<{ state: 'untouched'; expired: boolean; until: number } | { state: 'spent' | 'changed' } | null> {
  if (!evidence?.permit) return null
  const tokens = erc20s(context.input ? [context.input] : context.tokens)
  if (!tokens.length) return null
  const block = await request('eth_getBlockByNumber', ['latest', false]) as { number?: unknown; timestamp?: unknown } | null
  const head = quantity(block?.number), time = quantity(block?.timestamp)
  if (head === null || time === null) return null
  // Null: the numbered read refused (or unreadable); 'latest' is read instead, for a spent or changed allowance only.
  const count = await request('eth_getTransactionCount', [owner, hex(head)]).then(quantity, () => null)
  if (count !== null && count <= nonce) return null
  const exact = count !== null
  let read = 0
  for (const token of tokens) {
    const state = await permitOf(request, owner, token, exact ? hex(head) : 'latest').catch(() => null)
    if (!state) continue
    const digest = permitDigest(owner, token, state)
    if (digest === evidence.permit) {
      if (exact) return { state: 'untouched', expired: time > state.expiration, until: Number(state.expiration) }
      continue
    }
    if (evidence.spent && digest === evidence.spent) return { state: 'spent' }
    read++
  }
  return read === tokens.length && (context.input !== undefined || context.thisPool === true) ? { state: 'changed' } : null
}
