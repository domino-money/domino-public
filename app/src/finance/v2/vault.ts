import { decodeEventLog, decodeFunctionResult, encodeAbiParameters, encodeErrorResult, encodeEventTopics, encodeFunctionData, getContractAddress, keccak256, numberToHex, type Abi } from 'viem'
import priceAnchorAbi from '../../../../api-contracts/v2/abi/IDominoPriceAnchor.json'
import v3PoolAbi from '../../../../api-contracts/v2/abi/IUniswapV3PoolMinimal.json'
import { isV2ChainId, v3TickSpacing, type V2Chain } from '../../v2/chains'
import { V2_FIXTURE_SETS_TAKEN } from '../../v2/flag'
import { V2_FEES, ZERO_ADDRESS, type Address, type Dex, type Hex, type PoolRef, type PositionRef, type V2ChainId, type V2Component, type V2Contracts, type VaultInit, type VaultLimits, type VaultPolicy } from '../../v2/types'
import { BATCH_FRAME_GAS, atomicStatus, batchCallsState, offerBatch, simulateBatch, type AtomicStatus, type BatchCall, type BatchSimulator } from '../batch'
import { chainNonceJournal } from '../nonce'
import { REGISTRY_ABI, V3_POSITION_MANAGER_ABI, V4_POSITION_MANAGER_ABI, VAULT_ABI, VAULT_FACTORY_ABI } from './abi'
import { admitV2Contracts, verifyV2Code } from './deployment'
import { AUTO_EXIT_EVENTS_ABI, implementationErrorSelector, VAULT_EVENTS_ABI, VAULT_FACTORY_EVENTS_ABI } from './implementations'
import { refuseUnlessLive } from './liveLock'
import { edgeReadsReceipts, edgeSimulates } from '../../config/receiptSources'
import { createTransactor, l1FeeCeiling, quantity, receiptRpc, refused, REVIEW_S, revertIn, SIGN_WINDOW_S, suggestV2Gas, V2Revert, WalletNotAsked, type PreparedV2, type Rpc, type Transactor, type V2GasBudget, type V2Log, type V2Receipt, type V2Wallet } from './transact'

/**
 * Domino V2's automation vault, as its owner drives it from the wallet (spec F7 §5, milestone M3): create a vault for a
 * position, set its policy and limits, pause, resume and rearm it, withdraw what it holds, end it, and switch its
 * auto-exit module. Every write goes through the shared V2 sender (./transact.ts); every read through the connected
 * wallet's own provider, pinned to one block per review.
 *
 * This is money code: an approval to the wrong address hands a person's position away. So:
 *   - a vault address is never taken from outside. It is `factory.predictVault(owner, factory.nextNonce(owner))` before
 *     creation, or a vault the factory of its DEX says it made (`factory.isVault`), whose `owner()` is the wallet;
 *   - the factory is the chain's pinned manifest's (`contracts`), and before the first write of the session its runtime
 *     code must hash to the manifest's (`deployment_code_changed`; no code is `deployment_missing`). A FIXTURE contracts
 *     set is refused outright in a deployable build;
 *   - the only NFT approvals ever built are individual (`approve(vault, tokenId)`, never `setApprovalForAll`) on the
 *     chain profile's own position manager, to the predicted vault or the owner's own factory vault, and the revoke
 *     `approve(address(0), tokenId)`;
 *   - every step is re-derived from the chain right before it is prepared and again right before it is sent: a step is
 *     offered only while it is the first one still needed, with exactly the reviewed calldata. If another vault was
 *     created from this wallet in between (another tab), the predicted address moved and the approval points at the
 *     old one: that is `vault_nonce_moved`, and the caller reviews again, which predicts again and asks a NEW approval
 *     (spec §5.1 "Corrida");
 *   - `rearm(false)` is never built, and `setExitModule` only ever names address(0) or the manifest's `autoExit`.
 *
 * Failures are closed codes (`vault_*`, `deployment_*`, the sender's `wallet_*`); the screens word them (VAULT_TEXT
 * holds the spec's copy for the ones this client raises). Raw amounts are bigints, never JS numbers.
 *
 * Changed on purpose 2026-10-06 (stale since the V2 screens went live): the integrated screens (src/v2in/automate,
 * src/v2in/autoexit) drive this client wherever a gate is live; a creation's derivation is shared with ./autoExit.ts
 * (vaultCreation), which turns Auto-exit on in one batch.
 */

// Declared here, module-scoped, exactly as finance/pin.ts does (see its note): a compile Vite never touched answers
// "not deployable", and a test that wants the deployable behaviour sets the global and loads a fresh module copy.
declare const __DOMINO_DEPLOYABLE__: boolean | undefined
// Changed on purpose (data) 2026-10-02 (Domino V2 integration, the preview-v2 build): preview-v2 is the real site for V1
// (`__DOMINO_DEPLOYABLE__` true there) yet takes fixture sets up to a review (V2_FIXTURE_SETS_TAKEN, src/v2/flag.ts): their
// sends and signatures are refused by ./liveLock.ts instead. The deployable builds refuse them here, as before.
const DEPLOYABLE: boolean = typeof __DOMINO_DEPLOYABLE__ === 'boolean' && __DOMINO_DEPLOYABLE__ && !V2_FIXTURE_SETS_TAKEN

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const CODE_HASH = /^0x[0-9a-f]{64}$/
const MAX_ROOT_TOKEN_ID = (1n << 96n) - 1n
const MAX_UINT256 = (1n << 256n) - 1n
const MAX_UINT32 = 4_294_967_295
/**
 * `UnexpectedNonce(uint256,uint256)`: another `createVault` of this owner landed first. The factory's own selector
 * (api-contracts/v2/implementations/DominoV2VaultFactory.json; D7 resolved), no longer declared here by hand.
 */
export const UNEXPECTED_NONCE_SELECTOR = implementationErrorSelector('vaultFactory', 'UnexpectedNonce(uint256,uint256)')
/**
 * Changed on purpose (data) 2026-10-02 (Domino V2 integration, spec rev4 §5.6, #311): the v3 NonfungiblePositionManager's
 * refusal of a token that does not exist, Error("Invalid token ID"), exactly as DominoV2VaultV3's `_rootClosed()` matches
 * it (a burned root is closed; any other refusal leaves it open).
 */
const V3_NO_SUCH_TOKEN = encodeErrorResult({ abi: [{ type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] }], errorName: 'Error', args: ['Invalid token ID'] })
const COMPONENTS: readonly V2Component[] = ['registry', 'autoExit', 'zapV3', 'zapV4', 'vaultFactoryV3', 'vaultFactoryV4']

const fail = (code: string): never => { throw new Error(code) }
const isAddress = (value: unknown): value is Address => typeof value === 'string' && ADDRESS.test(value)
const lower = (value: string): Address => (isAddress(value) ? (value.toLowerCase() as Address) : fail('invalid_wallet_reply'))
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const isUint = (value: unknown, max: bigint): value is bigint => typeof value === 'bigint' && value >= 0n && value <= max
const inRange = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max

// ---------------------------------------------------------------------------
// The deployment (shared with ./autoExit.ts): the contracts set at construction, the code check through ./deployment.ts.
// ---------------------------------------------------------------------------

/**
 * The contracts set a V2 money client may act with on `chain`: from that chain's manifest (its chainId must be the
 * chain's), well formed, and never a fixture in a deployable build. Throws a closed code otherwise. @internal
 */
export function v2ContractsFor(chain: V2Chain, contracts: V2Contracts): V2Contracts {
  if (!chain || !isV2ChainId(chain.chainId)) return fail('chain_not_supported')
  if (!contracts || typeof contracts !== 'object' || contracts.chainId !== chain.chainId) return fail('deployment_chain_mismatch')
  // A set that does not say it is real is treated as a fixture: fail closed.
  if (contracts.fixture !== false && DEPLOYABLE) return fail('deployment_fixture_refused')
  // The app's own chain profile, and in a deployable build exactly the chain's PINNED manifest set (./deployment.ts).
  admitV2Contracts(chain, contracts)
  const addresses = {} as Record<V2Component, Address>
  const codeHashes = {} as Record<V2Component, Hex>
  const take = (name: V2Component) => {
    const address = contracts.addresses?.[name]
    const hash = contracts.codeHashes?.[name]
    if (!isAddress(address) || same(address, ZERO_ADDRESS)) return fail('deployment_invalid')
    if (typeof hash !== 'string' || !CODE_HASH.test(hash.toLowerCase())) return fail('deployment_invalid')
    addresses[name] = address.toLowerCase() as Address
    codeHashes[name] = hash.toLowerCase() as Hex
  }
  for (const name of COMPONENTS) take(name)
  // Changed on purpose (data) 2026-10-02 (Domino V2 rev2 §5.2 and the manifest loader to #302): the price anchor (§5.2's
  // v3 TWAP, read only after its code is checked) and the manifest's facts (the code checks of the vault
  // implementations, executors and swap module) are carried through when the set has them; a set built without them
  // keeps the six components, and nothing here reads the anchor.
  if (contracts.addresses?.priceAnchor !== undefined || contracts.codeHashes?.priceAnchor !== undefined) take('priceAnchor')
  return Object.freeze({
    chainId: contracts.chainId,
    addresses: Object.freeze(addresses),
    codeHashes: Object.freeze(codeHashes),
    fixture: contracts.fixture !== false,
    ...(contracts.deployment ? { deployment: contracts.deployment } : {}),
  })
}

/** The price anchor's views (api-contracts/v2/abi/IDominoPriceAnchor.json) and a v3 pool's `slot0`. @internal */
const PRICE_ANCHOR_ABI = (priceAnchorAbi as unknown as { abi: Abi }).abi
const V3_POOL_ABI = (v3PoolAbi as unknown as { abi: Abi }).abi

/** A v3 pool's address: CREATE2 from the chain's v3 factory and init code hash, salt keccak256(abi.encode(token0, token1, fee)). */
function v3PoolOf(chain: V2Chain, pool: PoolRef): Address {
  const salt = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }], [pool.currency0, pool.currency1, pool.fee]))
  return getContractAddress({ opcode: 'CREATE2', from: chain.uniswap.v3.factory, salt, bytecodeHash: chain.uniswap.v3.poolInitCodeHash }).toLowerCase() as Address
}

/**
 * What §5.2's current distance needs on a v3 vault, at one block (spec F7 rev2 §5.2, §6.2): the reference price,
 * `priceAnchor.twapSqrtPrice(pool, secondsAgo)` (its code checked against the manifest first), and the pool's spot
 * (`slot0`). Added on purpose (data) 2026-10-02 (Domino V2 rev2 §5.2). @internal
 */
export interface VaultReference extends V2Snapshot {
  anchorSqrtPriceX96: bigint
  spotSqrtPriceX96: bigint
  secondsAgo: number
}

/**
 * The manifest's code check (spec §7.3 point 4) through ./deployment.ts: before the first write of the session,
 * `keccak256(eth_getCode(c))` of every component a write uses must be the manifest's hash (`deployment_code_changed`;
 * no code is `deployment_missing`), read through the wallet's provider at the latest block. Once per page session per
 * chain, component, address and hash (deployment.ts's memo); a failed check is read again next time. @internal
 */
export const verifyComponents = (rpc: Rpc, contracts: V2Contracts, components: readonly V2Component[]): Promise<void> =>
  verifyV2Code((address) => rpc('eth_getCode', [address, 'latest']), contracts, components)

// ---------------------------------------------------------------------------
// Reads, shared with ./autoExit.ts
// ---------------------------------------------------------------------------

/** Where a read is made: the wallet's provider inside one bounded operation, at one block. @internal */
export interface ReadAt {
  rpc: Rpc
  block: Hex | 'latest'
}

/** Every V2 read result carries its chain and the block it was read at (spec §6.1). */
export interface V2Snapshot {
  chainId: V2ChainId
  blockNumber: bigint
  blockTimestamp: bigint
}

/** A contract's view at `at`, decoded; a contract's refusal becomes `onRevert` when one is given. @internal */
export async function viewAt<T>(t: Transactor, at: ReadAt, to: Address, abi: Abi, functionName: string, args: readonly unknown[] = [], onRevert?: string): Promise<T> {
  let data: Hex
  try {
    data = await t.call(at.rpc, to, encodeFunctionData({ abi, functionName, args }), at.block)
  } catch (error) {
    if (onRevert && revertIn(error)) return fail(onRevert)
    throw error
  }
  return decodeFunctionResult({ abi, functionName, data }) as T
}

/** The chain profile's position manager for a DEX: Uniswap v4's PositionManager, or v3's NonfungiblePositionManager. */
export const managerOf = (chain: V2Chain, dex: Dex): Address => (dex === 4 ? chain.uniswap.v4.positionManager : chain.uniswap.v3.positionManager)
/** The ABI of that manager, with ERC-721's individual approve. */
export const managerAbi = (dex: Dex): Abi => (dex === 4 ? V4_POSITION_MANAGER_ABI : V3_POSITION_MANAGER_ABI)
/** The vault factory of a DEX, from the manifest. */
export const factoryOf = (contracts: V2Contracts, dex: Dex): Address => (dex === 4 ? contracts.addresses.vaultFactoryV4 : contracts.addresses.vaultFactoryV3)
export const factoryComponent = (dex: Dex): V2Component => (dex === 4 ? 'vaultFactoryV4' : 'vaultFactoryV3')

interface RawPool { dex: number; currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }
interface RawMember { active: boolean; parent: bigint; successor: bigint; tickLower: number; tickUpper: number }
interface RawRef { dex: number; positionManager: string; tokenId: bigint }

/** A vault as the factory of its DEX vouches for it, with its owner, root and pool, all at one block. */
export interface VaultIdentity {
  vault: Address
  dex: Dex
  factory: Address
  owner: Address
  root: PositionRef
  pool: PoolRef
}

/**
 * Who a vault is, from the chain only: one of the manifest's two factories must say it made it (`isVault`), and its
 * root must sit on that DEX's position manager of the chain profile. Anything else is `vault_unknown` or
 * `vault_identity_mismatch`: an address that merely claims to be a vault is never used. @internal
 */
export async function readVaultIdentity(t: Transactor, chain: V2Chain, contracts: V2Contracts, at: ReadAt, vault: string): Promise<VaultIdentity> {
  if (!isAddress(vault) || same(vault, ZERO_ADDRESS)) return fail('vault_invalid_address')
  const address = vault.toLowerCase() as Address
  let dex: Dex | null = null
  for (const candidate of [4, 3] as const) {
    if (await viewAt<boolean>(t, at, factoryOf(contracts, candidate), VAULT_FACTORY_ABI, 'isVault', [address])) {
      dex = candidate
      break
    }
  }
  if (dex === null) return fail('vault_unknown')
  const owner = lower(await viewAt<string>(t, at, address, VAULT_ABI, 'owner'))
  const root = await viewAt<RawRef>(t, at, address, VAULT_ABI, 'root')
  const pool = await viewAt<RawPool>(t, at, address, VAULT_ABI, 'pool')
  if (root.dex !== dex || !same(root.positionManager, managerOf(chain, dex)) || pool.dex !== dex) return fail('vault_identity_mismatch')
  if (root.tokenId <= 0n || root.tokenId > MAX_ROOT_TOKEN_ID) return fail('vault_identity_mismatch')
  return {
    vault: address,
    dex,
    factory: factoryOf(contracts, dex),
    owner,
    root: Object.freeze({ dex, positionManager: managerOf(chain, dex), tokenId: root.tokenId }),
    pool: Object.freeze({ dex, currency0: lower(pool.currency0), currency1: lower(pool.currency1), fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: lower(pool.hooks) }),
  }
}

/** The latest block, as the pin every read of one review uses. @internal */
export async function pinBlock(t: Transactor, rpc: Rpc): Promise<{ at: ReadAt; snapshot: V2Snapshot }> {
  const block = await t.latestBlock(rpc)
  return { at: { rpc, block: block.tag }, snapshot: Object.freeze({ chainId: t.chain.chainId, blockNumber: block.number, blockTimestamp: block.timestamp }) }
}

/** A receipt's log, decoded with the ABI of the contract that emitted it. */
export interface V2Event {
  address: Address
  logIndex: number
  eventName: string
  args: Readonly<Record<string, unknown>>
}

/** The logs of known contracts decoded with their ABI; a log of any other contract, or one that does not decode, is left out. @internal */
export function decodeEvents(logs: readonly V2Log[], sources: readonly { address: Address; abi: Abi }[]): readonly V2Event[] {
  const events: V2Event[] = []
  for (const log of logs) {
    const source = sources.find((s) => same(s.address, log.address))
    if (!source || log.topics.length === 0) continue
    try {
      const decoded = decodeEventLog({ abi: source.abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] })
      events.push(Object.freeze({ address: log.address, logIndex: log.logIndex, eventName: String(decoded.eventName), args: Object.freeze({ ...(decoded.args as unknown as Record<string, unknown>) }) }))
    } catch {
      // A log this ABI does not describe (another interface of the same contract): not this client's to say.
    }
  }
  return Object.freeze(events)
}

// ---------------------------------------------------------------------------
// EIP-5792 batches (shared with ./autoExit.ts): spec §5.1 "Lote", §4.4 item 7, §8.2 "Criar vault"
// ---------------------------------------------------------------------------

/**
 * The page's latch for one V2 batch, on the batch latch of the action's chain (finance/nonce.ts chainNonceJournal):
 * claimed before the wallet is asked, so another tab, or this one after a lost answer, never offers the same batch twice;
 * let go only when the batch is known never to run (a definite refusal, a wallet that cannot batch, 5750, not included,
 * reverted) or once it ran (its outcome read on chain), and freed when it is older than V2_BATCH_LATCH_EXPIRY_S.
 */
export interface V2BatchLatch {
  batchOffered(key: Hex): string | null
  claimBatch(key: Hex): Promise<string>
  recordBatch(key: Hex, claim: string, id: string): Promise<void>
  releaseBatch(key: Hex, claim: string): Promise<void>
  /** Frees the latch claimed more than `maxAge` seconds ago (or whose page is gone without an answer): true when it did. */
  expireBatch(key: Hex, maxAge: number): Promise<boolean>
}

/**
 * How long a V2 batch's latch holds, 25 minutes. A vault's batch is bound to the factory's nonce for its owner and a
 * mandate's to its id, each usable once on chain (`UnexpectedNonce`, `MandateAlreadyRegistered` / `NonceAlreadyUsed`):
 * a second batch for the same key can only revert whole. Past this, a batch the wallet never answered for is let go,
 * as V1's setup does (finance/setup.ts BATCH_LATCH_EXPIRY_S, 1,500 s).
 */
export const V2_BATCH_LATCH_EXPIRY_S = 1_500

/** The page's own batch latch for one owner on one chain, in the browser. */
export function browserV2BatchLatch(chainId: V2ChainId, owner: Address): V2BatchLatch {
  const journal = chainNonceJournal(chainId)
  const who = owner.toLowerCase()
  return {
    batchOffered: (key) => journal.batchOffered(who, key),
    claimBatch: (key) => journal.claimBatch(who, key, Date.now() / 1000),
    recordBatch: (key, claim, id) => journal.recordBatch(who, key, claim, id),
    releaseBatch: (key, claim) => journal.releaseBatch(who, key, claim),
    expireBatch: (key, maxAge) => journal.expireBatch(who, key, Date.now() / 1000, maxAge),
  }
}

/** Lets a latch go once its batch is known to be over: by the wallet's id when it gave one, else at once by its age. @internal */
export async function settleBatchLatch(latch: V2BatchLatch, key: Hex): Promise<void> {
  const id = latch.batchOffered(key)
  if (id === null) return
  if (id !== '') await latch.releaseBatch(key, id)
  else await latch.expireBatch(key, 0)
}

/** A gas budget a batch may use (the shared sender's own bounds). @internal */
export function checkBatchBudget(gas: V2GasBudget): void {
  if (gas.maxGas < 21_000n || gas.maxGas > 15_000_000n || gas.maxFeePerGas <= 0n || gas.maxFeePerGas >= 1n << 128n
    || gas.maxPriorityFeePerGas < 0n || gas.maxPriorityFeePerGas > gas.maxFeePerGas || gas.reserveWei < 0n) fail('invalid_gas_budget')
}

/**
 * A batch's calls simulated whole through the wallet's eth_simulateV1, or the site's qualified Robinhood simulator
 * when supplied. Without either, the steps go one by one. Its cost is checked against the budget and the owner's
 * ETH. `budget` null (post-B4 review F8): the budget is read here, through this bounded port, at the moment of the
 * review. On an OP Stack chain the L1 data fee ceiling of the batch's whole calldata is added to its cost (F5). The gas
 * its calls used, and the most the batch may cost. @internal
 */
export async function simulateV2Batch(rpc: Rpc, chain: V2Chain, owner: Address, calls: readonly BatchCall[], budget: V2GasBudget | null, simulator?: BatchSimulator): Promise<{ gasUsed: bigint; networkFeeWei: bigint }> {
  const gas = budget ?? (await suggestV2Gas(rpc, chain))
  checkBatchBudget(gas)
  // The site's fallback is exclusively the existing Robinhood node route. Never send another chain's calls to it.
  // Changed on purpose 2026-10-15 (pack 8, C5): the chain's row in ../../config/receiptSources.ts, not its id (the same chain).
  const gasUsed = await simulateBatch((method, params) => rpc(method, params), owner, calls, edgeSimulates(chain.chainId) ? simulator : undefined)
  // The wallet runs the calls in one transaction of its own (its delegate's execute, or a bundler's): room for that frame.
  const limit = ((gasUsed + BATCH_FRAME_GAS) * 120n + 99n) / 100n
  if (limit > gas.maxGas) fail('gas_budget_exceeded')
  const calldataBytes = calls.reduce((sum, call) => sum + BigInt((call.data.length - 2) / 2), 0n)
  const cost = limit * gas.maxFeePerGas + (await l1FeeCeiling(rpc, chain, calldataBytes))
  if (quantity(await rpc('eth_getBalance', [owner, 'latest'])) < cost + gas.reserveWei) fail('native_gas_reserve_insufficient')
  return { gasUsed, networkFeeWei: cost }
}

/**
 * Offers a batch to the wallet once, behind its latch (finance/batch.ts offerBatch: version 2.0.0, atomic required, the
 * action's chain). Call inside the transactor's `bounded`, right after `eth_chainId` was read again. The claim is let go
 * when the wallet was never asked (the bounded port refused before invoking the provider: WalletNotAsked, post-B4
 * review item 4), or when a definite refusal arrives after the operation's deadline won. The wallet's id for the batch.
 * @internal
 */
export async function offerV2Batch(rpc: Rpc, owner: Address, chainId: V2ChainId, latch: V2BatchLatch, key: Hex, calls: readonly BatchCall[], stillValid: () => boolean): Promise<string> {
  // Changed on purpose (data) 2026-10-02 (Domino V2 integration): the backstop of the batch offers (./liveLock.ts): no batch
  // on a chain whose contracts are not live, before any claim or wallet request. Each caller checked its own set first.
  refuseUnlessLive(chainId, null)
  let claim: string | undefined
  const batchWallet = {
    owner,
    request: (method: string, params: unknown[]) => rpc(method, params),
    batchOffered: (k: Hex) => latch.batchOffered(k),
    claimBatch: async (k: Hex) => { claim = await latch.claimBatch(k); return claim },
    recordBatch: (k: Hex, token: string, id: string) => latch.recordBatch(k, token, id),
    releaseBatch: (k: Hex, token: string) => latch.releaseBatch(k, token),
  }
  // The one request offerBatch makes is the offer itself.
  const request = async (method: string, params: unknown[]) => {
    try {
      return await rpc(method, params, async () => {
        if (claim !== undefined) await latch.releaseBatch(key, claim)
      })
    } catch (error) {
      // Refused before the provider was invoked: the wallet never saw the batch, so nothing of it can run.
      if (error instanceof WalletNotAsked && claim !== undefined) await latch.releaseBatch(key, claim)
      throw error
    }
  }
  return offerBatch(request, batchWallet, key, calls, stillValid, chainId)
}

/**
 * The receipt of the transaction that carried a batch, read from the chain once `holds` says its logs are the batch's:
 * the shared sender's states ("included" then "finalized" at the chain's finalized block; a delay is never a failure).
 * @internal
 */
export async function receiptOfBatch(rpc: Rpc, chain: V2Chain, hash: Hex, holds: (logs: readonly V2Log[]) => boolean, wallet?: V2Wallet): Promise<V2Receipt> {
  if (wallet) rpc = await receiptRpc(wallet, chain, hash, rpc)
  const raw = (await rpc('eth_getTransactionReceipt', [hash])) as Record<string, unknown> | null
  if (raw === null) return { state: 'pending' }
  if (!raw || typeof raw !== 'object' || String(raw.transactionHash).toLowerCase() !== hash || typeof raw.blockHash !== 'string'
    || !/^0x[0-9a-fA-F]{64}$/.test(raw.blockHash) || !['0x0', '0x1'].includes(String(raw.status)) || !Array.isArray(raw.logs)) return fail('invalid_receipt')
  const blockNumber = quantity(raw.blockNumber)
  const blockHash = raw.blockHash.toLowerCase() as Hex
  const block = (await rpc('eth_getBlockByNumber', [numberToHex(blockNumber), false])) as { hash?: string } | null
  if (!block) return { state: 'pending' }
  if (String(block.hash).toLowerCase() !== blockHash) return { state: 'reorged' }
  const logs = (raw.logs as unknown[]).map((entry): V2Log => {
    const log = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null
    if (!log || !isAddress(log.address) || !Array.isArray(log.topics) || typeof log.data !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(log.data)) return fail('invalid_receipt')
    const topics = log.topics.map((topic) => (typeof topic === 'string' && /^0x[0-9a-fA-F]{64}$/.test(topic) ? (topic.toLowerCase() as Hex) : fail('invalid_receipt')))
    return Object.freeze({ address: (log.address as string).toLowerCase() as Address, topics: Object.freeze(topics), data: log.data as Hex, logIndex: Number(quantity(log.logIndex)) })
  })
  const costs = {
    transactionHash: hash,
    blockHash, blockNumber, gasUsed: quantity(raw.gasUsed), effectiveGasPrice: quantity(raw.effectiveGasPrice),
    l1Fee: chain.l1FeeInReceipt && typeof raw.l1Fee === 'string' ? quantity(raw.l1Fee) : null, logs: Object.freeze(logs),
  }
  if (raw.status === '0x0') return { state: 'reverted', ...costs }
  if (!holds(logs)) return fail('receipt_not_from_this_review')
  const final = await rpc('eth_getBlockByNumber', ['finalized', false]).catch(() => null) as { number?: string } | null
  if (!final?.number || quantity(final.number) < blockNumber) return { state: 'included', ...costs }
  return { state: 'finalized', ...costs }
}

/** A hash learned for one batch offered by this client; never an authorization to send. */
export interface KnownBatchConfirmation { transactionHash?: Hex }

/** Once its wallet envelope names one hash, this authorized Robinhood batch can be followed without a live wallet. */
export async function knownBatchState(t: Transactor, wallet: V2Wallet, chain: V2Chain, rpc: Rpc, id: string, known: KnownBatchConfirmation): Promise<Awaited<ReturnType<typeof batchCallsState>>> {
  // Changed on purpose 2026-10-15 (pack 8, C5): the chain's row in ../../config/receiptSources.ts, not its id (the same chain).
  const fixed = edgeReadsReceipts(chain.chainId) && wallet.confirmation !== undefined
  if (fixed && known.transactionHash) return { status: 200, transactionHash: known.transactionHash }
  await t.identity(rpc)
  const calls = await batchCallsState((method, params) => rpc(method, params), id)
  if (fixed && calls && calls.status >= 200 && calls.status < 300 && calls.transactionHash) known.transactionHash = calls.transactionHash
  return calls
}

/**
 * The one transaction whose logs carry `topics` from `address` since `fromBlock`, through the wallet's provider: null
 * while none is found (a node behind, or not yet included); two or more is `receipt_duplicate_action`. @internal
 */
export async function transactionWithLog(rpc: Rpc, address: Address, topics: readonly (Hex | null)[], fromBlock: bigint): Promise<Hex | null> {
  const found = await rpc('eth_getLogs', [{ address, topics, fromBlock: numberToHex(fromBlock), toBlock: 'latest' }])
  if (!Array.isArray(found)) return fail('invalid_wallet_reply')
  const hashes = new Set<string>()
  for (const entry of found) {
    const log = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null
    if (!log || log.removed === true) continue
    if (typeof log.transactionHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(log.transactionHash)) return fail('invalid_wallet_reply')
    hashes.add(log.transactionHash.toLowerCase())
  }
  if (hashes.size === 0) return null
  if (hashes.size > 1) return fail('receipt_duplicate_action')
  return [...hashes][0] as Hex
}

/** Where a V2 batch stands: the receipt of the transaction that carried it, with its events, or the wallet's word that it never ran. */
export type V2BatchReceipt = (V2Receipt & { events: readonly V2Event[] }) | { state: 'not-included'; events: readonly V2Event[] } | { state: 'batch-reverted'; events: readonly V2Event[] }

// ---------------------------------------------------------------------------
// Policy and limits (spec §5.2)
// ---------------------------------------------------------------------------

/**
 * The deployed vault's own limits (Changed on purpose 2026-10-04, rugged97's delta of 4 Oct §2 item 2, #317:
 * DominoV2VaultBase MAX_SLIPPAGE_BPS, MAX_ANCHOR_BAND_BPS, MAX_OBSERVATION_AGE_SECONDS, MIN_INTERVAL_SECONDS): slippage up
 * to 10% (1,000 bps), the band up to 5% (500), a reference price 1 to 300 s old, and at least 600 s between executions;
 * outside them the contract reverts InvalidLimits or InvalidPolicy. The screen's own caps (5%, 5%, the fixed 300 s and
 * 600 s) sit inside them.
 */
export const VAULT_CONTRACT_LIMITS = Object.freeze({ maxSlippageBps: 1000, maxPriceImpactBps: 500, maxObservationAgeSeconds: 300, minimumIntervalSeconds: 600 } as const)

/**
 * Every setting outside the contract's limits (spec §5.2, VAULT_CONTRACT_LIMITS above), as closed codes; empty when all
 * are allowed. `members` is the vault's current number of positions (`maxPositions` may not go below it); on v3 the
 * reference price's age is at least 60 s (the TWAP's minimum window, #301; the spec's recommendation). The form shows
 * these before anything is signed; the client refuses a review with any of them.
 */
export function settingsProblems(policy: VaultPolicy, limits: VaultLimits, dex: Dex, members = 1): string[] {
  const problems: string[] = []
  if (!policy || typeof policy !== 'object') problems.push('vault_policy_missing')
  else {
    if (policy.mode !== 1 && policy.mode !== 2) problems.push('vault_policy_mode')
    if (!inRange(policy.triggerDistanceBps, 0, 2000)) problems.push('vault_policy_trigger_distance')
    if (!inRange(policy.maxOverlapBps, 0, 2000)) problems.push('vault_policy_max_overlap')
    if (!inRange(policy.minimumIntervalSeconds, VAULT_CONTRACT_LIMITS.minimumIntervalSeconds, MAX_UINT32)) problems.push('vault_policy_minimum_interval')
    if (!inRange(policy.maxPositions, 1, 255) || policy.maxPositions < members) problems.push('vault_policy_max_positions')
    // Auto-compound keeps the root alone: exactly one position (going back to it needs the successors withdrawn).
    if (policy.mode === 1 && policy.maxPositions !== 1) problems.push('vault_policy_simple_one_position')
  }
  if (!limits || typeof limits !== 'object') problems.push('vault_limits_missing')
  else {
    if (!inRange(limits.maxSlippageBps, 0, VAULT_CONTRACT_LIMITS.maxSlippageBps)) problems.push('vault_limits_max_slippage')
    if (!inRange(limits.maxPriceImpactBps, 0, VAULT_CONTRACT_LIMITS.maxPriceImpactBps)) problems.push('vault_limits_max_price_impact')
    if (!inRange(limits.maxObservationAgeSeconds, 1, VAULT_CONTRACT_LIMITS.maxObservationAgeSeconds)) problems.push('vault_limits_observation_age')
    else if (dex === 3 && limits.maxObservationAgeSeconds < 60) problems.push('vault_limits_observation_age_v3')
    if (!inRange(limits.upsideBps, 1, 1_000_000)) problems.push('vault_limits_upside')
  }
  return problems
}

const policyOf = (p: VaultPolicy): VaultPolicy => Object.freeze({ mode: p.mode, triggerDistanceBps: p.triggerDistanceBps, maxOverlapBps: p.maxOverlapBps, minimumIntervalSeconds: p.minimumIntervalSeconds, maxPositions: p.maxPositions })
const limitsOf = (l: VaultLimits): VaultLimits => Object.freeze({ maxSlippageBps: l.maxSlippageBps, maxPriceImpactBps: l.maxPriceImpactBps, maxObservationAgeSeconds: l.maxObservationAgeSeconds, upsideBps: l.upsideBps })
function checkSettings(policy: VaultPolicy, limits: VaultLimits, dex: Dex, members: number) {
  const problems = settingsProblems(policy, limits, dex, members)
  if (problems.length) fail(`vault_invalid_settings: ${problems.join(' ')}`)
}

/** "2%" or "4%": the automation fee of a mode, from the contracts' constants (spec §1.6). */
export const automationFeeText = (mode: 1 | 2): '2%' | '4%' => (mode === 2 ? `${V2_FEES.automationDominoBps / 100}%` : `${V2_FEES.automationSimpleBps / 100}%`) as '2%' | '4%'

// ---------------------------------------------------------------------------
// Copy (spec §5.1, §5.3, §5.6, §5.8, §4.5): the English the screens show for this client's keys and codes.
// ---------------------------------------------------------------------------

export const VAULT_TEXT = Object.freeze({
  vault_consent_uncollected_fees: 'Fees this position has already earned and not collected will be reinvested by automation, and the {fee} fee applies when they are.',
  vault_v3_owed_to_wallet: 'Amounts waiting to be collected from this position will be sent to your wallet when automation starts.',
  // Changed on purpose 2026-10-06 (the owner's point 5: the product is Auto-exit, never "orders" on screen): the same
  // meaning in its name.
  vault_exit_module_off_pauses: "Turning Auto-exit off for your automation pauses it; it doesn't cancel it.",
  // Changed on purpose 2026-10-04 (rugged97's delta of 4 Oct §2 item 3, #319): exitAll also turns the exit module off. The
  // delta's words without "on this vault" (the owner: no "vault" on screen); 2026-10-06, Auto-exit by its name.
  vault_exit_all_pauses_orders: 'This also pauses Auto-exit. You can turn it back on later.',
  vault_pause_keeps_auto_exit: 'Pausing stops automated runs. Auto-exit stays on.',
  vault_halted: 'Domino has stopped automation on {chain} for safety. You can still withdraw and manage your positions.',
  vault_stops_automation: 'This stops automation for this position until you turn it back on.',
  // The codes this client raises that the spec gives copy for (§5.8).
  vault_hooked_pool: "Pools with hooks can't be automated yet.",
  vault_foreign_subscriber: 'Another app is connected to this position. Remove it at Uniswap first.',
  vault_consent_required: 'Confirm that earned fees become automation fees.',
  vault_nonce_moved: 'Another automation was set up from this wallet. Review again: your approval must point to the new one.',
  vault_approval_missing: 'Approve this position for your automation from the wallet that holds it, then try again.',
  vault_not_owner: 'Only the owner of this automation can do this.',
  vault_invalid_settings: 'One of the settings is outside the allowed range.',
  vault_amount_zero: 'Enter an amount greater than zero.',
  vault_amount_exceeds_reserves: "That's more than your automation holds in {token}.",
  // Changed on purpose 2026-10-04 (rugged97's delta of 4 Oct §2 item 1): a withdrawal's recipient, named by the owner.
  vault_recipient_invalid: 'Choose a wallet to receive the funds.',
  vault_child_not_withdrawable: "This position can't be withdrawn this way.",
  // Changed on purpose (data) 2026-10-02 (Domino V2 integration, spec rev4 §5.6, #311): returnReserves(), its note and
  // its refusals (the contract's RootOpen and SuccessorActive, checked here before anything is sent).
  vault_returns_to_owner: 'The fees your automation holds go to your wallet, and only to it. No Domino fee: you pay only the network fee.',
  vault_root_open: "Your position still holds liquidity, so its fees can't be returned this way. Use Withdraw to wallet.",
  vault_successor_active: 'A position your automation opened is still active. Withdraw it from your automation first.',
} as const)
export type VaultTextKey = keyof typeof VAULT_TEXT

// ---------------------------------------------------------------------------
// Reviews and steps
// ---------------------------------------------------------------------------

export type VaultStepKind =
  | 'approve-root'
  | 'create-vault'
  | 'pause'
  | 'resume'
  | 'rearm'
  | 'set-policy'
  | 'set-limits'
  | 'withdraw-reserves'
  | 'withdraw-child'
  | 'recover-token'
  | 'recover-position'
  | 'exit-all'
  | 'set-exit-module'
  | 'unsubscribe'
  | 'revoke-approval'
  /** Changed on purpose (data) 2026-10-02 (Domino V2 integration, spec rev4 §5.6, #311). */
  | 'return-reserves'

/** One transaction of a review: where it goes, its exact calldata (no value: no V2 vault step carries ETH), its lines. */
export interface VaultStep {
  kind: VaultStepKind
  to: Address
  data: Hex
  summary: readonly string[]
}

/** What the owner asks for to create a vault for a position (spec §5.1). */
export interface VaultCreateRequest {
  dex: Dex
  tokenId: bigint
  policy: VaultPolicy
  limits: VaultLimits
  startPaused: boolean
  /** Must be true: the owner read and accepted VAULT_TEXT.vault_consent_uncollected_fees. */
  consentToUncollectedFees: boolean
}

export interface VaultCreateReview {
  kind: 'create'
  chainId: V2ChainId
  owner: Address
  dex: Dex
  factory: Address
  /** The factory's nonce for this owner (`nextNonce`), not the wallet's transaction nonce. */
  nonce: bigint
  /** `factory.predictVault(owner, nonce)`: where the vault will be, and the only address the root is approved to. */
  vault: Address
  init: VaultInit
  /** The root's pool (v3: tickSpacing from the profile, null for a tier outside its table). */
  pool: { currency0: Address; currency1: Address; fee: number; tickSpacing: number | null; hooks: Address }
  /** v3: what the position manager owes the root now (sent to the wallet at arming); null on v4. */
  owed: readonly [bigint, bigint] | null
  approvalNeeded: boolean
  consent: { key: 'vault_consent_uncollected_fees'; fee: '2%' | '4%' }
  warnings: readonly VaultTextKey[]
  steps: readonly VaultStep[]
  snapshot: V2Snapshot
}

/** An owner action on an existing vault (spec §5.3, §5.6, §4.5). */
export type VaultAction =
  | { kind: 'pause' }
  | { kind: 'resume' }
  /** Takes custody of the root again; the consent is the same as creation's (rearm(false) is never sent). */
  | { kind: 'rearm'; consentToUncollectedFees: boolean }
  | { kind: 'set-policy'; policy: VaultPolicy }
  | { kind: 'set-limits'; limits: VaultLimits }
  /**
   * `recipient`: the owner's own wallet when left out. Another address the owner names only after a transfer to the wallet
   * failed (TokenCallFailed: a token that refuses that wallet; rugged97's delta of 4 Oct §2 item 1).
   */
  | { kind: 'withdraw-reserves'; token: Address; amount: bigint; recipient?: Address }
  /** An active successor (never the root) to the wallet. */
  | { kind: 'withdraw-child'; tokenId: bigint }
  | { kind: 'recover-token'; token: Address; amount: bigint }
  | { kind: 'recover-position'; tokenId: bigint }
  | { kind: 'exit-all' }
  /** address(0) (auto-exit off: pauses the orders) or the manifest's autoExit; nothing else. */
  | { kind: 'set-exit-module'; module: Address }
  /** v4, after exitAll: remove the vault as the root's subscriber on the PositionManager. */
  | { kind: 'unsubscribe' }
  /** approve(address(0), root) on the position manager: the vault's approval revoked. */
  | { kind: 'revoke-approval' }
  /**
   * Changed on purpose (data) 2026-10-02 (Domino V2 integration, spec rev4 §5.6, #311): `returnReserves()`, every reserve
   * of both pool tokens to the vault's owner, without any fee, once the root is closed (read live) and no successor is
   * active. Anyone may call it; this client offers it to the owner ("Return my reserves"), who pays only the gas.
   */
  | { kind: 'return-reserves' }

export interface VaultActionReview {
  kind: VaultAction['kind']
  chainId: V2ChainId
  owner: Address
  vault: Address
  dex: Dex
  action: VaultAction
  notes: readonly VaultTextKey[]
  steps: readonly VaultStep[]
  snapshot: V2Snapshot
}

export type VaultReview = VaultCreateReview | VaultActionReview

export type VaultReceipt = V2Receipt & { events: readonly V2Event[] }

/**
 * A vault's creation sent whole as ONE EIP-5792 batch (spec §5.1 "Lote", §8.2 "Criar vault"): the review's two steps,
 * `[approve(predicted vault, tokenId), createVault(init, n)]`, exactly the calldata the review showed, re-derived from
 * the chain right before and simulated whole through the wallet. Frozen; only the client that prepared it sends it,
 * once.
 */
export interface VaultCreateBatch {
  chainId: V2ChainId
  owner: Address
  /** The latch key: keccak256(abi.encode(chainId, factory, owner, n)), one batch per factory nonce of this owner. */
  key: Hex
  vault: Address
  factory: Address
  /** The factory's nonce for this owner the batch creates the vault at. */
  nonce: bigint
  kinds: readonly VaultStepKind[]
  calls: readonly BatchCall[]
  gasUsed: bigint
  /** The most the batch may cost in network fees: its calls' gas, with room for the wallet's own frame, at the fee ceiling. */
  networkFeeWei: bigint
  /** Unix seconds: good until then (25 s after its simulation). */
  expiresAt: number
}

/** A vault creation batch's latch key: keccak256(abi.encode(uint256 chainId, address factory, address owner, uint256 n)). */
export function vaultBatchKey(chainId: V2ChainId, factory: Address, owner: Address, nonce: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }], [BigInt(chainId), factory, owner, nonce]))
}

// ---------------------------------------------------------------------------
// A creation's facts, through any V2 client's bounded port (Added on purpose 2026-10-06, the owner's point 5: Auto-exit
// turned on as a signature plus ONE batch, approve + createVault + setExitModule + registerMandate; ./autoExit.ts builds
// that batch with exactly the derivation below, the vault client's own, so its approval and its creation are never
// built twice or another way).
// ---------------------------------------------------------------------------

/** One vault step: where it goes, its exact calldata, its lines. @internal */
const vaultStep = (kind: VaultStepKind, to: Address, abi: Abi, functionName: string, args: readonly unknown[], summary: readonly string[]): VaultStep =>
  Object.freeze({ kind, to, data: encodeFunctionData({ abi, functionName, args }), summary: Object.freeze([...summary]) })

/** Who holds an NFT on a DEX's manager; null when the manager refuses (burned, never minted). @internal */
async function holderAt(t: Transactor, chain: V2Chain, at: ReadAt, dex: Dex, tokenId: bigint): Promise<Address | null> {
  try {
    return lower(await viewAt<string>(t, at, managerOf(chain, dex), managerAbi(dex), 'ownerOf', [tokenId]))
  } catch (error) {
    if (revertIn(error)) return null
    throw error
  }
}
const approvedAt = async (t: Transactor, chain: V2Chain, at: ReadAt, dex: Dex, tokenId: bigint): Promise<Address> => lower(await viewAt<string>(t, at, managerOf(chain, dex), managerAbi(dex), 'getApproved', [tokenId], 'vault_position_not_found'))
const subscriberAt = async (t: Transactor, chain: V2Chain, at: ReadAt, tokenId: bigint): Promise<Address> => lower(await viewAt<string>(t, at, managerOf(chain, 4), V4_POSITION_MANAGER_ABI, 'subscriber', [tokenId], 'vault_position_not_found'))

/**
 * The root of a vault this wallet has not created yet (spec §5.1), read at `at`: the NFT held by the wallet on its DEX's
 * manager, its pool (v4: no hook), what v3 owes it, the factory's nonce for the wallet and `predictVault(owner, n)`
 * (still free), the v4 subscriber (none, or that prediction) and the NFT's current individual approval. Closed codes as
 * the vault client's review raises them. @internal
 */
export interface NewVaultRoot {
  dex: Dex
  manager: Address
  factory: Address
  /** The factory's nonce for this owner (`nextNonce`). */
  nonce: bigint
  /** `factory.predictVault(owner, nonce)`. */
  vault: Address
  pool: VaultCreateReview['pool']
  owed: readonly [bigint, bigint] | null
  approved: Address
}

export async function newVaultRoot(t: Transactor, chain: V2Chain, contracts: V2Contracts, at: ReadAt, dex: Dex, tokenId: bigint): Promise<NewVaultRoot> {
  if (dex !== 3 && dex !== 4) return fail('vault_invalid_dex')
  if (typeof tokenId !== 'bigint' || tokenId <= 0n || tokenId > MAX_ROOT_TOKEN_ID) return fail('vault_invalid_token_id')
  const manager = managerOf(chain, dex)
  const factory = factoryOf(contracts, dex)
  const holder = await holderAt(t, chain, at, dex, tokenId)
  if (holder === null) return fail('vault_position_not_found')
  if (holder !== t.owner) return fail('vault_root_not_owned')
  let pool: VaultCreateReview['pool']
  let owed: readonly [bigint, bigint] | null = null
  if (dex === 4) {
    const [key] = await viewAt<readonly [RawPool]>(t, at, manager, V4_POSITION_MANAGER_ABI, 'getPoolAndPositionInfo', [tokenId])
    if (key.tickSpacing === 0) return fail('vault_position_not_found')
    // A v4 pool with a hook is refused for automation (spec §1.4; the factory reverts HookedPool).
    if (!same(key.hooks, ZERO_ADDRESS)) return fail('vault_hooked_pool')
    pool = Object.freeze({ currency0: lower(key.currency0), currency1: lower(key.currency1), fee: key.fee, tickSpacing: key.tickSpacing, hooks: ZERO_ADDRESS })
  } else {
    const position = await viewAt<readonly unknown[]>(t, at, manager, V3_POSITION_MANAGER_ABI, 'positions', [tokenId], 'vault_position_not_found')
    const fee = position[4] as number
    pool = Object.freeze({ currency0: lower(position[2] as string), currency1: lower(position[3] as string), fee, tickSpacing: v3TickSpacing(chain, fee), hooks: ZERO_ADDRESS })
    owed = Object.freeze([position[10] as bigint, position[11] as bigint] as const)
  }
  const nonce = await viewAt<bigint>(t, at, factory, VAULT_FACTORY_ABI, 'nextNonce', [t.owner])
  const vault = lower(await viewAt<string>(t, at, factory, VAULT_FACTORY_ABI, 'predictVault', [t.owner, nonce]))
  if (same(vault, ZERO_ADDRESS)) return fail('vault_prediction_invalid')
  // The predicted address must be free: a vault already there means the nonce this read saw is stale.
  if (await viewAt<boolean>(t, at, factory, VAULT_FACTORY_ABI, 'isVault', [vault])) return fail('vault_nonce_moved')
  if (dex === 4) {
    const subscriber = await subscriberAt(t, chain, at, tokenId)
    if (subscriber !== ZERO_ADDRESS && subscriber !== vault) return fail('vault_foreign_subscriber')
  }
  const approved = await approvedAt(t, chain, at, dex, tokenId)
  return { dex, manager, factory, nonce, vault, pool, owed, approved }
}

/** A creation's facts and the steps it needs now: the individual approval to the prediction when missing, then `createVault(init, n)`. @internal */
export interface VaultCreation extends NewVaultRoot {
  init: VaultInit
  steps: readonly VaultStep[]
}

/** Everything spec §5.1 requires of a creation, read at `at` through `t`, and the steps it needs (the vault client's own review). @internal */
export async function vaultCreation(t: Transactor, chain: V2Chain, contracts: V2Contracts, at: ReadAt, request: VaultCreateRequest): Promise<VaultCreation> {
  const { dex, tokenId } = request
  if (dex !== 3 && dex !== 4) return fail('vault_invalid_dex')
  if (typeof tokenId !== 'bigint' || tokenId <= 0n || tokenId > MAX_ROOT_TOKEN_ID) return fail('vault_invalid_token_id')
  if (request.consentToUncollectedFees !== true) return fail('vault_consent_required')
  if (typeof request.startPaused !== 'boolean') return fail('vault_invalid_request')
  checkSettings(request.policy, request.limits, dex, 1)
  const root = await newVaultRoot(t, chain, contracts, at, dex, tokenId)
  const init: VaultInit = Object.freeze({
    root: Object.freeze({ dex, positionManager: root.manager, tokenId }),
    policy: policyOf(request.policy),
    limits: limitsOf(request.limits),
    startPaused: request.startPaused,
    consentToUncollectedFees: true,
  })
  const mode = init.policy.mode === 2 ? 'Domino-compound' : 'Auto-compound'
  const steps: VaultStep[] = []
  if (root.approved !== root.vault) {
    // Individual, exact: this one NFT to the predicted vault on the chain's own manager. Never setApprovalForAll.
    steps.push(vaultStep('approve-root', root.manager, managerAbi(dex), 'approve', [root.vault, tokenId], [`Approve position #${tokenId} to your new vault ${root.vault}.`]))
  }
  steps.push(vaultStep('create-vault', root.factory, VAULT_FACTORY_ABI, 'createVault', [init, root.nonce], [`Create your vault ${root.vault} and turn on ${mode} for position #${tokenId}.`]))
  return { ...root, init, steps: Object.freeze(steps) }
}

/**
 * Every reserve of a vault withdrawn to its owner as ONE EIP-5792 batch (spec F7 rev3 §2.13, §5.6: closing a root never
 * leaves fees stuck): `withdrawReserves(token, reserves(token))` for each pool token holding more than zero, exactly the
 * amounts read on chain right before and simulated whole through the wallet. Withdrawals carry no fee. Frozen; only the
 * client that prepared it sends it, once. Added on purpose (data) 2026-10-02 (Domino V2 rev3, the automation screens).
 */
export interface VaultWithdrawBatch {
  chainId: V2ChainId
  owner: Address
  /** The latch key: one batch per vault state (withdrawBatchKey). */
  key: Hex
  vault: Address
  /** The vault's stateNonce the batch was read at: its first withdrawal moves it to stateNonce + 1. */
  stateNonce: bigint
  /** The block it was read at: its transaction is looked for from there. */
  fromBlock: bigint
  /** Who receives every withdrawal: the owner's own wallet, or the address the owner named (delta of 4 Oct §2 item 1). */
  recipient: Address
  amounts: readonly { token: Address; amount: bigint }[]
  calls: readonly BatchCall[]
  gasUsed: bigint
  networkFeeWei: bigint
  /** Unix seconds: good until then (25 s after its simulation). */
  expiresAt: number
}

/** A withdraw-all batch's latch key: keccak256(abi.encode(uint256 chainId, address vault, address owner, uint256 stateNonce, string "withdraw-all")). */
export function withdrawBatchKey(chainId: V2ChainId, vault: Address, owner: Address, stateNonce: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'string' }], [BigInt(chainId), vault, owner, stateNonce, 'withdraw-all']))
}

// ---------------------------------------------------------------------------
// The panel's read (spec §5.4, §5.5, §5.6)
// ---------------------------------------------------------------------------

export interface VaultMember {
  tokenId: bigint
  role: 'root' | 'successor'
  active: boolean
  parent: bigint
  successor: bigint
  tickLower: number
  tickUpper: number
  /** Per pool token: earned fees not yet charged, and units already charged (`lot`). */
  lots: readonly { token: Address; uncharged: bigint; charged: bigint }[]
}

export interface VaultSnapshot extends V2Snapshot {
  vault: Address
  dex: Dex
  factory: Address
  owner: Address
  /** Whether the connected wallet is this vault's owner. */
  ownedByWallet: boolean
  pool: PoolRef
  root: PositionRef
  /** `positions()`: the active members, root first. */
  positions: readonly bigint[]
  members: readonly VaultMember[]
  policy: VaultPolicy
  limits: VaultLimits
  paused: boolean
  /** Live: false as soon as custody is gone (spec §5.4). */
  rootArmed: boolean
  stateNonce: bigint
  exitModule: Address
  /** Whether the module is the manifest's auto-exit (anything else but zero cannot be set by the vault). */
  autoExitEnabled: boolean
  quoteCurrency: Address
  lastExecutionAt: bigint
  /**
   * Per pool token: `reserves` ("Fees collected, not yet reinvested": idle + every member's lots) and `idleReserves`
   * ("Not used by automation"). The vault's `owedFees` are never read here: they are not the owner's (spec §5.6).
   */
  reserves: readonly { token: Address; total: bigint; idle: bigint }[]
  /** The root as its position manager has it now: null when the read refused (a burned NFT). */
  custody: { holder: Address | null; approved: Address | null; subscriber: Address | null }
  /** `registry.automationHalted()`: the chain's banner (VAULT_TEXT.vault_halted). */
  halted: boolean
}

export interface Custody {
  armed: boolean
  /**
   * Why the root is disarmed, when a live read can say it: 4 when the owner no longer holds it, the vault lost its
   * individual approval, or (v4) its subscription. Otherwise 'unknown': only the vault's last `RootDisarmed(reason)`
   * log says (1, 2, 3, 6, 7), and v3's reason 5 needs the last `RootCheckpointed` log compared with `positions(root)`.
   * PHASE A reads no logs (they need the V2 read API or a log reader), so those stay 'unknown'. null while armed.
   */
  reason: 4 | 'unknown' | null
  lost: readonly ('owner' | 'approval' | 'subscription')[]
}

/** The root's custody derived live from a snapshot (spec §5.4). Pure. */
export function liveCustody(snapshot: VaultSnapshot): Custody {
  const lost: ('owner' | 'approval' | 'subscription')[] = []
  const { holder, approved, subscriber } = snapshot.custody
  if (holder === null || holder !== snapshot.owner) lost.push('owner')
  if (approved === null || approved !== snapshot.vault) lost.push('approval')
  if (snapshot.dex === 4 && subscriber !== snapshot.vault) lost.push('subscription')
  if (lost.length) return Object.freeze({ armed: false, reason: 4 as const, lost: Object.freeze(lost) })
  if (snapshot.rootArmed) return Object.freeze({ armed: true, reason: null, lost: Object.freeze([]) })
  return Object.freeze({ armed: false, reason: 'unknown' as const, lost: Object.freeze([]) })
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/** How many members one bounded read takes (three reads each, inside the sender's 48-call budget). */
const MEMBERS_PER_READ = 12

interface ReviewInternal {
  components: readonly V2Component[]
  /** The review's steps derived again at `at`; throws the closed code of the first failed check. */
  rebuild: (at: ReadAt) => Promise<readonly VaultStep[]>
  /**
   * What the review's steps are bound to on chain, for the hand-over latch (post-B4 review F2): a creation's factory
   * and nonce (`create|factory|n`), or an action's vault and its `stateNonce` at the review (`action|vault|nonce`).
   */
  marker: string
}

/** A step's hand-over key: its review's chain binding and its exact call. */
const handOverKey = (marker: string, step: VaultStep) => `${marker}|${step.kind}|${step.to}|${step.data}`

/**
 * The vault client for one wallet on one chain, with that chain's pinned contracts set. Construction refuses a set of
 * another chain, a malformed one, and a fixture in a deployable build.
 */
export function createVaultClient(wallet: V2Wallet, chain: V2Chain, supplied: V2Contracts, now: () => number = () => Date.now() / 1000, simulator?: BatchSimulator) {
  const contracts = v2ContractsFor(chain, supplied)
  const batchSimulator = edgeSimulates(chain.chainId) ? simulator : undefined
  // Changed on purpose (data) 2026-10-02 (Domino V2 integration): every step and batch of this client only with live
  // contracts (./liveLock.ts), refused before any wallet request.
  const t = createTransactor(wallet, chain, now, () => refuseUnlessLive(chain.chainId, contracts))
  const owner = t.owner
  const verify = (rpc: Rpc, components: readonly V2Component[]) => verifyComponents(rpc, contracts, components)
  const reviews = new WeakMap<VaultReview, ReviewInternal>()
  const issued = new WeakMap<PreparedV2, { review: VaultReview; step: VaultStep; key: string }>()
  const sentSteps = new Map<Hex, { review: VaultReview; step: VaultStep; key: string }>()
  const activeStepHashes = new Map<string, Hex>()
  /**
   * The steps handed to the wallet whose outcome is not known yet (post-B4 review F2), by hand-over key: a withdrawal
   * whose answer was lost must never be offered again while its reserves still read as there. Marked right before the
   * shared sender is called; let go only when the wallet was never asked or refused definitely (the shared sender's
   * `wasOffered` is then false), or once the step's receipt is final (finalized, or reverted: nothing of it ran). Any
   * other outcome keeps it, and the same step is refused (`review_already_sent`), from this review or a new one at the
   * same vault state.
   */
  const handedOver = new Set<string>()
  const issuedBatches = new WeakSet<VaultCreateBatch>()
  const batchOrigins = new WeakMap<VaultCreateBatch, VaultCreateReview>()
  const offeredBatches = new Map<string, { batch: VaultCreateBatch; review: VaultCreateReview } & KnownBatchConfirmation>()
  const issuedWithdraws = new WeakSet<VaultWithdrawBatch>()
  const offeredWithdraws = new Map<string, { batch: VaultWithdrawBatch } & KnownBatchConfirmation>()
  const view = <T>(at: ReadAt, to: Address, abi: Abi, functionName: string, args: readonly unknown[] = [], onRevert?: string) => viewAt<T>(t, at, to, abi, functionName, args, onRevert)
  const step = vaultStep
  /**
   * Where a withdrawal of the vault's reserves goes (rugged97's delta of 4 Oct §2 item 1): the owner's own wallet, or an
   * address the owner names once a transfer to that wallet failed (TokenCallFailed). Never address(0) (InvalidRecipient),
   * the vault, one of the tokens or a Domino contract: what is sent there is lost or locked (`vault_recipient_invalid`).
   */
  const recipientOf = (named: Address | undefined, wallet: Address, vault: Address, tokens: readonly Address[]): Address => {
    if (named === undefined) return wallet
    if (typeof named !== 'string' || !isAddress(named)) return fail('vault_recipient_invalid')
    const to = named.toLowerCase() as Address
    if (to === ZERO_ADDRESS || to === vault || tokens.includes(to) || Object.values(contracts.addresses).some((a) => String(a).toLowerCase() === to)) return fail('vault_recipient_invalid')
    return to
  }

  /** The vault's identity, and the wallet must be its owner. */
  async function ownedVault(at: ReadAt, vault: string): Promise<VaultIdentity> {
    const identity = await readVaultIdentity(t, chain, contracts, at, vault)
    if (identity.owner !== owner) return fail('vault_not_owner')
    return identity
  }

  /** Who holds an NFT on a manager; null when the manager refuses (burned, never minted). */
  const holderOf = (at: ReadAt, dex: Dex, tokenId: bigint): Promise<Address | null> => holderAt(t, chain, at, dex, tokenId)
  const approvedOf = (at: ReadAt, dex: Dex, tokenId: bigint): Promise<Address> => approvedAt(t, chain, at, dex, tokenId)
  const subscriberOf = (at: ReadAt, tokenId: bigint): Promise<Address> => subscriberAt(t, chain, at, tokenId)

  /**
   * Whether the root is closed, read live as the vault's `returnReserves()` reads it (Changed on purpose (data)
   * 2026-10-02, Domino V2 integration, spec rev4 §5.6, #311): v4, `getPositionLiquidity(root) == 0` (a burned NFT gives 0
   * too); v3, `positions(root).liquidity == 0`, or the manager's own refusal of the token (Error("Invalid token ID")),
   * any other refusal leaving it open. The step's simulation is still the last word.
   */
  async function rootClosed(at: ReadAt, dex: Dex, tokenId: bigint): Promise<boolean> {
    if (dex === 4) return (await view<bigint>(at, managerOf(chain, 4), V4_POSITION_MANAGER_ABI, 'getPositionLiquidity', [tokenId])) === 0n
    try {
      const position = await view<readonly unknown[]>(at, managerOf(chain, 3), V3_POSITION_MANAGER_ABI, 'positions', [tokenId])
      return position[7] === 0n
    } catch (error) {
      const reverted = revertIn(error)
      if (reverted) return reverted.data === V3_NO_SUCH_TOKEN
      throw error
    }
  }

  // ----- creation -----

  /**
   * Everything spec §5.1 requires of a creation, read at `at`, and the steps it needs. Changed on purpose 2026-10-06 (the
   * owner's point 5, Auto-exit in one batch): the derivation itself moved to the module (vaultCreation above), unchanged,
   * so ./autoExit.ts builds its one batch with exactly this one.
   */
  const createFacts = (at: ReadAt, request: VaultCreateRequest): Promise<VaultCreation> => vaultCreation(t, chain, contracts, at, request)

  // ----- owner actions -----

  async function actionSteps(at: ReadAt, vault: string, action: VaultAction): Promise<{ identity: VaultIdentity; steps: readonly VaultStep[]; notes: readonly VaultTextKey[] }> {
    const identity = await ownedVault(at, vault)
    const { dex, root, pool } = identity
    const at0 = identity.vault
    const manager = managerOf(chain, dex)
    const own = (kind: VaultStepKind, functionName: string, args: readonly unknown[], summary: readonly string[]) => step(kind, at0, VAULT_ABI, functionName, args, summary)
    const notes: VaultTextKey[] = []
    const steps: VaultStep[] = []
    switch (action?.kind) {
      case 'pause': {
        if (await view<boolean>(at, at0, VAULT_ABI, 'paused')) return fail('vault_step_not_needed')
        notes.push('vault_pause_keeps_auto_exit')
        steps.push(own('pause', 'pause', [], ['Pause automation for this vault.', VAULT_TEXT.vault_pause_keeps_auto_exit]))
        break
      }
      case 'resume': {
        if (!(await view<boolean>(at, at0, VAULT_ABI, 'paused'))) return fail('vault_step_not_needed')
        steps.push(own('resume', 'resume', [], ['Resume automation for this vault.']))
        break
      }
      case 'rearm': {
        // rearm(false) reverts InvalidInit and is never built: the consent is the owner's, explicitly.
        if (action.consentToUncollectedFees !== true) return fail('vault_consent_required')
        if (await view<boolean>(at, at0, VAULT_ABI, 'rootArmed')) return fail('vault_step_not_needed')
        const holder = await holderOf(at, dex, root.tokenId)
        if (holder !== owner) return fail('vault_root_not_owned')
        if (dex === 4) {
          const subscriber = await subscriberOf(at, root.tokenId)
          if (subscriber !== ZERO_ADDRESS && subscriber !== at0) return fail('vault_foreign_subscriber')
        }
        const mode = (await view<VaultPolicy>(at, at0, VAULT_ABI, 'policy')).mode
        notes.push('vault_consent_uncollected_fees')
        if ((await approvedOf(at, dex, root.tokenId)) !== at0) {
          steps.push(step('approve-root', manager, managerAbi(dex), 'approve', [at0, root.tokenId], [`Approve position #${root.tokenId} to your vault ${at0}.`]))
        }
        steps.push(own('rearm', 'rearm', [true], [`Turn automation back on for position #${root.tokenId}.`, VAULT_TEXT.vault_consent_uncollected_fees.replace('{fee}', automationFeeText(mode === 2 ? 2 : 1))]))
        break
      }
      case 'set-policy': {
        const members = (await view<readonly bigint[]>(at, at0, VAULT_ABI, 'positions')).length
        checkSettings(action.policy, (await view<VaultLimits>(at, at0, VAULT_ABI, 'limits')), dex, members)
        steps.push(own('set-policy', 'setPolicy', [policyOf(action.policy)], ['Save the new automation settings.']))
        break
      }
      case 'set-limits': {
        const members = (await view<readonly bigint[]>(at, at0, VAULT_ABI, 'positions')).length
        checkSettings((await view<VaultPolicy>(at, at0, VAULT_ABI, 'policy')), action.limits, dex, members)
        steps.push(own('set-limits', 'setLimits', [limitsOf(action.limits)], ['Save the new limits.']))
        break
      }
      case 'withdraw-reserves': {
        if (!isAddress(action.token)) return fail('vault_invalid_token')
        const token = action.token.toLowerCase() as Address
        if (token !== pool.currency0 && token !== pool.currency1) return fail('vault_token_not_in_pool')
        if (!isUint(action.amount, MAX_UINT256) || action.amount === 0n) return fail('vault_amount_zero')
        const reserves = await view<bigint>(at, at0, VAULT_ABI, 'reserves', [token])
        if (action.amount > reserves) return fail('vault_amount_exceeds_reserves')
        // Changed on purpose 2026-10-04 (rugged97's audit remediation, #323): `withdrawReserves(token, amount, recipient)`;
        // the recipient is the owner's own wallet unless the owner names another (delta of 4 Oct §2 item 1).
        const recipient = recipientOf(action.recipient, owner, at0, [pool.currency0, pool.currency1])
        const to = recipient === owner ? 'your wallet' : recipient
        steps.push(own('withdraw-reserves', 'withdrawReserves', [token, action.amount, recipient], [`Withdraw ${action.amount} (raw units) of ${token} from your vault to ${to}.`]))
        break
      }
      case 'withdraw-child': {
        if (typeof action.tokenId !== 'bigint' || action.tokenId <= 0n) return fail('vault_invalid_token_id')
        if (action.tokenId === root.tokenId) return fail('vault_child_is_root')
        const member = await view<RawMember>(at, at0, VAULT_ABI, 'member', [action.tokenId])
        if (!member.active) return fail('vault_child_inactive')
        steps.push(own('withdraw-child', 'withdrawChild', [action.tokenId], [`Withdraw position #${action.tokenId} from your vault to your wallet. It is no longer automated.`]))
        break
      }
      case 'recover-token': {
        if (!isAddress(action.token)) return fail('vault_invalid_token')
        if (!isUint(action.amount, MAX_UINT256) || action.amount === 0n) return fail('vault_amount_zero')
        const token = action.token.toLowerCase() as Address
        steps.push(own('recover-token', 'recoverToken', [token, action.amount], [`Recover ${action.amount} (raw units) of ${token} that your vault holds outside its reserves.`]))
        break
      }
      case 'recover-position': {
        if (typeof action.tokenId !== 'bigint' || action.tokenId <= 0n) return fail('vault_invalid_token_id')
        if ((await holderOf(at, dex, action.tokenId)) !== at0) return fail('vault_position_not_held')
        steps.push(own('recover-position', 'recoverPosition', [action.tokenId], [`Recover position #${action.tokenId} from your vault to your wallet.`]))
        break
      }
      case 'exit-all': {
        // Changed on purpose 2026-10-04 (rugged97's delta of 4 Oct §2 item 3, #319): the deployed exitAll also turns the exit
        // module off when one is on (ExitModuleSet(0)), so this vault's auto-exit orders pause, not revoked; said in the review.
        const pausesOrders = lower(await view<string>(at, at0, VAULT_ABI, 'exitModule')) !== ZERO_ADDRESS
        if (pausesOrders) notes.push('vault_exit_all_pauses_orders')
        steps.push(own('exit-all', 'exitAll', [], [
          'End automation for this vault: its successor positions and the reserves it can pay go to your wallet, and the root position stops being automated.',
          ...(pausesOrders ? [VAULT_TEXT.vault_exit_all_pauses_orders] : []),
        ]))
        break
      }
      case 'set-exit-module': {
        if (!isAddress(action.module)) return fail('vault_exit_module_refused')
        const module = action.module.toLowerCase() as Address
        // Only address(0) or the auto-exit the manifest names (the vault refuses anything else, spec §4.1).
        if (module !== ZERO_ADDRESS && module !== contracts.addresses.autoExit) return fail('vault_exit_module_refused')
        const current = lower(await view<string>(at, at0, VAULT_ABI, 'exitModule'))
        if (current === module) return fail('vault_step_not_needed')
        if (module === ZERO_ADDRESS) {
          notes.push('vault_exit_module_off_pauses')
          steps.push(own('set-exit-module', 'setExitModule', [module], ['Turn off Auto-exit for this vault.', VAULT_TEXT.vault_exit_module_off_pauses]))
        } else {
          steps.push(own('set-exit-module', 'setExitModule', [module], ['Turn on Auto-exit for this vault.']))
        }
        break
      }
      case 'unsubscribe': {
        if (dex !== 4) return fail('vault_unsubscribe_v4_only')
        if ((await holderOf(at, dex, root.tokenId)) !== owner) return fail('vault_root_not_owned')
        if ((await subscriberOf(at, root.tokenId)) !== at0) return fail('vault_not_subscribed')
        if (await view<boolean>(at, at0, VAULT_ABI, 'rootArmed')) notes.push('vault_stops_automation')
        steps.push(step('unsubscribe', manager, V4_POSITION_MANAGER_ABI, 'unsubscribe', [root.tokenId], ['Remove Domino from this position.']))
        break
      }
      case 'revoke-approval': {
        if ((await holderOf(at, dex, root.tokenId)) !== owner) return fail('vault_root_not_owned')
        if ((await approvedOf(at, dex, root.tokenId)) !== at0) return fail('vault_nothing_to_revoke')
        if (await view<boolean>(at, at0, VAULT_ABI, 'rootArmed')) notes.push('vault_stops_automation')
        steps.push(step('revoke-approval', manager, managerAbi(dex), 'approve', [ZERO_ADDRESS, root.tokenId], ['Revoke your vault\'s approval on this position.']))
        break
      }
      case 'return-reserves': {
        // Changed on purpose (data) 2026-10-02 (Domino V2 integration, spec rev4 §5.6, #311): the contract's own two
        // conditions, read here first, in its order: no active successor (`positions()` holds the root alone, else
        // SuccessorActive), then the root closed, read live (else RootOpen); and something to pay. It pays all of
        // reserves(token), both pool tokens, to owner() alone, without any charge.
        if ((await view<readonly bigint[]>(at, at0, VAULT_ABI, 'positions')).length !== 1) return fail('vault_successor_active')
        if (!(await rootClosed(at, dex, root.tokenId))) return fail('vault_root_open')
        let held = false
        for (const token of [pool.currency0, pool.currency1]) if ((await view<bigint>(at, at0, VAULT_ABI, 'reserves', [token])) > 0n) held = true
        if (!held) return fail('vault_reserves_empty')
        notes.push('vault_returns_to_owner')
        steps.push(own('return-reserves', 'returnReserves', [], ['Return everything your vault holds to your wallet, and only to it. No fee.']))
        break
      }
      default:
        return fail('vault_action_unknown')
    }
    return { identity, steps: Object.freeze(steps), notes: Object.freeze(notes) }
  }

  const componentsFor = (dex: Dex, action?: VaultAction): readonly V2Component[] => {
    const list: V2Component[] = [factoryComponent(dex), 'registry']
    if (action?.kind === 'set-exit-module' && isAddress(action.module) && !same(action.module, ZERO_ADDRESS)) list.push('autoExit')
    return Object.freeze(list)
  }

  /**
   * A step may be prepared or sent only while it is the FIRST one the chain still needs, with exactly the reviewed
   * calldata: re-derived from the latest block, after the deployment's code check.
   */
  async function checkStep(rpc: Rpc, review: VaultReview, wanted: VaultStep): Promise<void> {
    const internal = reviews.get(review)
    if (!internal) return fail('vault_review_unknown')
    await verify(rpc, internal.components)
    const current = await internal.rebuild({ rpc, block: 'latest' })
    if (!current.some((s) => s.kind === wanted.kind)) return fail('vault_step_not_needed')
    const first = current[0]
    if (first.kind !== wanted.kind) return fail(first.kind === 'approve-root' ? 'vault_approval_missing' : 'vault_step_out_of_order')
    if (first.to !== wanted.to || first.data !== wanted.data) return fail('vault_review_stale')
  }

  /** A createVault the factory refused because another one of this owner landed first: review again (spec §5.1). */
  async function nonceMoved<T>(work: Promise<T>): Promise<T> {
    try {
      return await work
    } catch (error) {
      if (error instanceof V2Revert && error.data?.startsWith(UNEXPECTED_NONCE_SELECTOR)) return fail('vault_nonce_moved')
      throw error
    }
  }

  /**
   * A creation's steps the chain still needs now, as one batch's calls: exactly the review's own (same kind, target and
   * calldata), in its order, `createVault` last. Fewer than two is `batch_not_needed` (the approval is already given:
   * the one step goes on its own); another vault of this owner landed first is `vault_nonce_moved`, as for a step.
   */
  /**
   * The withdraw-all calls of a vault at the latest block: the owner's vault, every pool token's `reserves(token)` above
   * zero (the vault pays idle reserves first, then uncharged fees, then charged units; never a fee), one
   * `withdrawReserves` each. Fewer than two is `batch_not_needed` (the single step does it); none, `vault_reserves_empty`.
   * A withdrawal of this vault handed to the wallet at this vault state with no known outcome refuses it
   * (`review_already_sent`): nothing is offered twice.
   */
  async function withdrawAllCalls(rpc: Rpc, vault: Address, named?: Address): Promise<{ identity: VaultIdentity; stateNonce: bigint; block: bigint; recipient: Address; amounts: { token: Address; amount: bigint }[]; calls: BatchCall[] }> {
    const { at, snapshot } = await pinBlock(t, rpc)
    const identity = await ownedVault(at, vault)
    const recipient = recipientOf(named, identity.owner, identity.vault, [identity.pool.currency0, identity.pool.currency1])
    const stateNonce = await view<bigint>(at, identity.vault, VAULT_ABI, 'stateNonce')
    const sent = `action|${identity.vault}|${stateNonce}|withdraw-reserves|`
    for (const key of handedOver) if (key.startsWith(sent)) fail('review_already_sent')
    const amounts: { token: Address; amount: bigint }[] = []
    for (const token of [identity.pool.currency0, identity.pool.currency1]) {
      const amount = await view<bigint>(at, identity.vault, VAULT_ABI, 'reserves', [token])
      if (amount > 0n) amounts.push({ token, amount })
    }
    if (amounts.length === 0) fail('vault_reserves_empty')
    if (amounts.length < 2) fail('batch_not_needed')
    // The owner's own wallet receives every reserve (#323's recipient argument; identity.owner is the connected owner),
    // unless the owner named another address after a transfer to it failed (delta of 4 Oct §2 item 1).
    const calls = amounts.map((a): BatchCall => Object.freeze({ to: identity.vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'withdrawReserves', args: [a.token, a.amount, recipient] }), value: '0x0' as Hex }))
    return { identity, stateNonce, block: snapshot.blockNumber, recipient, amounts, calls }
  }

  async function createBatchCalls(rpc: Rpc, review: VaultCreateReview): Promise<{ kinds: VaultStepKind[]; calls: BatchCall[] }> {
    const internal = reviews.get(review)
    if (!internal) return fail('vault_review_unknown')
    await verify(rpc, internal.components)
    const steps = await internal.rebuild({ rpc, block: 'latest' })
    if (steps.length < 2) return fail('batch_not_needed')
    const kinds: VaultStepKind[] = []
    const calls: BatchCall[] = []
    for (const current of steps) {
      const shown = review.steps.find((s) => s.kind === current.kind)
      if (!shown || shown.to !== current.to || shown.data !== current.data) return fail('vault_review_stale')
      kinds.push(current.kind)
      calls.push(Object.freeze({ to: current.to, data: current.data, value: '0x0' as Hex }))
    }
    if (kinds[kinds.length - 1] !== 'create-vault') return fail('vault_step_out_of_order')
    return { kinds, calls }
  }

  async function readMembers(vault: Address, block: Hex, ids: readonly bigint[], rootId: bigint, tokens: readonly [Address, Address]): Promise<VaultMember[]> {
    const members: VaultMember[] = []
    for (let i = 0; i < ids.length; i += MEMBERS_PER_READ) {
      const chunk = ids.slice(i, i + MEMBERS_PER_READ)
      members.push(...await t.bounded(async (rpc) => {
        await t.identity(rpc)
        const at: ReadAt = { rpc, block }
        const out: VaultMember[] = []
        for (const tokenId of chunk) {
          const { active, parent, successor, tickLower, tickUpper } = await view<RawMember>(at, vault, VAULT_ABI, 'member', [tokenId])
          const lots: VaultMember['lots'][number][] = []
          for (const token of tokens) {
            const lot = await view<{ uncharged: bigint; charged: bigint }>(at, vault, VAULT_ABI, 'lot', [tokenId, token])
            lots.push(Object.freeze({ token, uncharged: lot.uncharged, charged: lot.charged }))
          }
          out.push(Object.freeze({ tokenId, role: tokenId === rootId ? 'root' as const : 'successor' as const, active, parent, successor, tickLower, tickUpper, lots: Object.freeze(lots) }))
        }
        return out
      }))
    }
    return members
  }

  return {
    chain,
    contracts,
    owner,

    /**
     * Reviews a vault's creation for a position the wallet holds (spec §5.1): the root, its pool (v4: no hook) and its
     * subscriber (v4: none, or the predicted vault), what v3 owes it, the settings within §5.2, then `n = nextNonce`,
     * `vault = predictVault(owner, n)`, and the steps: the individual approval to that vault when it is missing, then
     * `createVault(init, n)`. Reads only, at one block.
     */
    reviewCreate: (asked: VaultCreateRequest) => t.bounded(async (rpc): Promise<VaultCreateReview> => {
      await t.identity(rpc)
      const { at, snapshot } = await pinBlock(t, rpc)
      const facts = await createFacts(at, asked)
      // What the review showed, copied: the caller's object changing afterwards changes nothing that is sent.
      const request: VaultCreateRequest = Object.freeze({ dex: asked.dex, tokenId: asked.tokenId, policy: facts.init.policy, limits: facts.init.limits, startPaused: asked.startPaused, consentToUncollectedFees: true })
      const warnings: VaultTextKey[] = facts.owed && (facts.owed[0] > 0n || facts.owed[1] > 0n) ? ['vault_v3_owed_to_wallet'] : []
      const review: VaultCreateReview = Object.freeze({
        kind: 'create',
        chainId: chain.chainId,
        owner,
        dex: request.dex,
        factory: factoryOf(contracts, request.dex),
        nonce: facts.nonce,
        vault: facts.vault,
        init: facts.init,
        pool: facts.pool,
        owed: facts.owed,
        approvalNeeded: facts.approved !== facts.vault,
        consent: Object.freeze({ key: 'vault_consent_uncollected_fees' as const, fee: automationFeeText(facts.init.policy.mode) }),
        warnings: Object.freeze(warnings),
        steps: facts.steps,
        snapshot,
      })
      reviews.set(review, {
        components: componentsFor(request.dex),
        rebuild: async (latest) => {
          const again = await createFacts(latest, request)
          // Another vault of this owner landed: the approval would point at the old prediction. Review again.
          if (again.nonce !== review.nonce || again.vault !== review.vault) return fail('vault_nonce_moved')
          return again.steps
        },
        marker: `create|${review.factory}|${review.nonce}`,
      })
      return review
    }),

    /**
     * Reviews one owner action on a vault the factory made and the wallet owns (spec §5.3, §5.6, §4.5), with the
     * checks each needs before anything is sent. Reads only, at one block.
     */
    reviewAction: (vault: Address, action: VaultAction) => t.bounded(async (rpc): Promise<VaultActionReview> => {
      await t.identity(rpc)
      const { at, snapshot } = await pinBlock(t, rpc)
      const { identity, steps, notes } = await actionSteps(at, vault, action)
      // The vault's state the review saw: a step handed over at this state is never offered again at it (F2).
      const stateNonce = await view<bigint>(at, identity.vault, VAULT_ABI, 'stateNonce')
      // What the review showed, copied (the settings deeply): the caller's object changing afterwards changes nothing.
      const frozen = Object.freeze({ ...action, ...(action.kind === 'set-policy' ? { policy: policyOf(action.policy) } : {}), ...(action.kind === 'set-limits' ? { limits: limitsOf(action.limits) } : {}) }) as VaultAction
      const review: VaultActionReview = Object.freeze({ kind: frozen.kind, chainId: chain.chainId, owner, vault: identity.vault, dex: identity.dex, action: frozen, notes, steps, snapshot })
      reviews.set(review, {
        components: componentsFor(identity.dex, frozen),
        rebuild: async (latest) => (await actionSteps(latest, identity.vault, frozen)).steps,
        marker: `action|${identity.vault}|${stateNonce}`,
      })
      return review
    }),

    /**
     * One step of a review this client issued, prepared for the wallet: the deployment's code checked, the step
     * re-derived at the latest block (it must still be the first one needed, with the reviewed calldata), then
     * simulated, estimated and frozen by the shared sender.
     */
    prepareStep: (review: VaultReview, index: number, gas: V2GasBudget | null = null) => t.bounded(async (rpc): Promise<PreparedV2> => {
      const internal = reviews.get(review)
      if (!internal) return fail('vault_review_unknown')
      if (!Number.isInteger(index) || index < 0 || index >= review.steps.length) return fail('vault_step_unknown')
      const wanted = review.steps[index]
      const key = handOverKey(internal.marker, wanted)
      // A step handed over whose outcome is not known yet is never prepared again (post-B4 review F2).
      if (handedOver.has(key)) return fail('review_already_sent')
      await t.identity(rpc)
      await checkStep(rpc, review, wanted)
      // `gas` null: the budget is read by the shared sender, through this bounded port, at this review (F8).
      const prepared = await nonceMoved(t.prepare(rpc, { kind: wanted.kind, to: wanted.to, data: wanted.data, value: 0n, summary: wanted.summary }, gas))
      issued.set(prepared, { review, step: wanted, key })
      return prepared
    }),

    /**
     * Offers a prepared step once (shared sender), after the step is derived again from the chain. The step is marked
     * handed over first; the mark goes only when the wallet was never asked or refused definitely.
     */
    send: async (prepared: PreparedV2, acknowledged: boolean): Promise<Hex> => {
      refuseUnlessLive(chain.chainId, contracts)
      const origin = issued.get(prepared)
      if (!origin) return fail('wallet_review_required')
      // The very step already offered is the shared sender's refusal (never sent twice); another review's is this one's.
      if (handedOver.has(origin.key)) return fail(t.wasOffered(prepared) ? 'wallet_review_required' : 'review_already_sent')
      handedOver.add(origin.key)
      activeStepHashes.delete(origin.key)
      let hash: Hex
      try {
        hash = await nonceMoved(t.send(prepared, acknowledged, (rpc) => checkStep(rpc, origin.review, origin.step)))
      } catch (error) {
        if (refused(error) || !t.wasOffered(prepared)) handedOver.delete(origin.key)
        throw error
      }
      sentSteps.set(hash, origin)
      activeStepHashes.set(origin.key, hash)
      return hash
    },

    /** Whether a prepared step was handed to the wallet (its outcome is then the chain's to say; it is never offered again). */
    wasOffered: (prepared: PreparedV2): boolean => t.wasOffered(prepared),

    /** A new view of the same reviewed step may resume its known transaction, never offer it again.
     * The factory nonce/state marker and exact calldata bind it to this client's owner, chain and intended effect.
     */
    sentStep: (review: VaultReview, index: number): Hex | null => {
      const internal = reviews.get(review), step = review.steps[index]
      if (!internal || !step) return null
      const key = handOverKey(internal.marker, step)
      if (!handedOver.has(key)) return null
      return activeStepHashes.get(key) ?? null
    },

    /** Where a step this client sent stands, with the vault's, the factory's and the module's events decoded. */
    receipt: async (hash: Hex): Promise<VaultReceipt> => {
      const receipt = await t.receipt(hash)
      const origin = sentSteps.get(hash)
      // Final: what the step did (or that it reverted, doing nothing) is known for good, and the step may be reviewed anew.
      if (origin && activeStepHashes.get(origin.key) === hash && (receipt.state === 'finalized' || receipt.state === 'reverted')) handedOver.delete(origin.key)
      if (receipt.state === 'pending' || receipt.state === 'reorged' || !origin) return { ...receipt, events: Object.freeze([]) }
      const vault = origin.review.vault
      // Decoded with what each contract itself declares (./implementations.ts), so every event a step emits is said.
      const events = decodeEvents(receipt.logs, [
        { address: contracts.addresses.vaultFactoryV3, abi: VAULT_FACTORY_EVENTS_ABI },
        { address: contracts.addresses.vaultFactoryV4, abi: VAULT_FACTORY_EVENTS_ABI },
        { address: vault, abi: VAULT_EVENTS_ABI },
        { address: contracts.addresses.autoExit, abi: AUTO_EXIT_EVENTS_ABI },
      ])
      return { ...receipt, events }
    },

    /**
     * The vault panel's figures (spec §5.4–§5.6), every one at the same block: identity, policy, limits, state, every
     * member with its lots, both pool tokens' reserves and idle reserves, the root's live custody reads, and the
     * registry's halt. Reads only; a vault the factory did not make is `vault_unknown`.
     */
    readVault: async (vault: Address): Promise<VaultSnapshot> => {
      const head = await t.bounded(async (rpc) => {
        await t.identity(rpc)
        const { at, snapshot } = await pinBlock(t, rpc)
        const identity = await readVaultIdentity(t, chain, contracts, at, vault)
        const address = identity.vault
        const v = <T>(fn: string, args: readonly unknown[] = []) => view<T>(at, address, VAULT_ABI, fn, args)
        const positions = await v<readonly bigint[]>('positions')
        const policy = await v<VaultPolicy>('policy')
        const limits = await v<VaultLimits>('limits')
        const paused = await v<boolean>('paused')
        const rootArmed = await v<boolean>('rootArmed')
        const stateNonce = await v<bigint>('stateNonce')
        const exitModule = lower(await v<string>('exitModule'))
        const quoteCurrency = lower(await v<string>('quoteCurrency'))
        const lastExecutionAt = await v<bigint>('lastExecutionAt')
        const tokens = [identity.pool.currency0, identity.pool.currency1] as const
        const reserves: VaultSnapshot['reserves'][number][] = []
        for (const token of tokens) {
          reserves.push(Object.freeze({ token, total: await v<bigint>('reserves', [token]), idle: await v<bigint>('idleReserves', [token]) }))
        }
        const holder = await holderOf(at, identity.dex, identity.root.tokenId)
        let approved: Address | null = null
        try {
          approved = lower(await view<string>(at, managerOf(chain, identity.dex), managerAbi(identity.dex), 'getApproved', [identity.root.tokenId]))
        } catch (error) {
          if (!revertIn(error)) throw error
        }
        let subscriber: Address | null = null
        if (identity.dex === 4) {
          try {
            subscriber = lower(await view<string>(at, managerOf(chain, 4), V4_POSITION_MANAGER_ABI, 'subscriber', [identity.root.tokenId]))
          } catch (error) {
            if (!revertIn(error)) throw error
          }
        }
        const halted = await view<boolean>(at, contracts.addresses.registry, REGISTRY_ABI, 'automationHalted')
        return { at, snapshot, identity, positions, policy, limits, paused, rootArmed, stateNonce, exitModule, quoteCurrency, lastExecutionAt, tokens, reserves, holder, approved, subscriber, halted }
      })
      const members = await readMembers(head.identity.vault, head.at.block as Hex, head.positions, head.identity.root.tokenId, head.tokens)
      return Object.freeze({
        ...head.snapshot,
        vault: head.identity.vault,
        dex: head.identity.dex,
        factory: head.identity.factory,
        owner: head.identity.owner,
        ownedByWallet: head.identity.owner === owner,
        pool: head.identity.pool,
        root: head.identity.root,
        positions: Object.freeze([...head.positions]),
        members: Object.freeze(members),
        policy: policyOf(head.policy),
        limits: limitsOf(head.limits),
        paused: head.paused,
        rootArmed: head.rootArmed,
        stateNonce: head.stateNonce,
        exitModule: head.exitModule,
        autoExitEnabled: head.exitModule === contracts.addresses.autoExit,
        quoteCurrency: head.quoteCurrency,
        lastExecutionAt: head.lastExecutionAt,
        reserves: Object.freeze(head.reserves),
        custody: Object.freeze({ holder: head.holder, approved: head.approved, subscriber: head.subscriber }),
        halted: head.halted,
      })
    },

    /**
     * What the connected wallet can do with an EIP-5792 batch on this chain (finance/batch.ts atomicStatus, through the
     * wallet's own provider): 'supported' or 'ready' offers a creation as one batch; 'unsupported' (or a read that
     * failed) keeps the steps. Reads only.
     */
    atomicSupport: () => t.bounded(async (rpc): Promise<AtomicStatus> => {
      await t.identity(rpc)
      return atomicStatus({ owner, request: (method, params) => rpc(method, params) }, 5_000, chain.chainId)
    }),

    /**
     * A creation review as ONE batch (spec §5.1 "Lote"): `[approve(predicted vault, tokenId), createVault(init, n)]`,
     * re-derived at the latest block (the same calldata the review showed, or refused), simulated whole through the
     * wallet's eth_simulateV1 only (a wallet without it is `batch_simulation_unavailable`: the steps instead), its cost
     * checked against the budget and the owner's ETH. Reads only.
     */
    prepareCreateBatch: (review: VaultReview, gas: V2GasBudget | null = null) => t.bounded(async (rpc): Promise<VaultCreateBatch> => {
      if (!review || review.kind !== 'create' || !reviews.has(review)) return fail('vault_review_unknown')
      if (gas) checkBatchBudget(gas)
      await t.identity(rpc)
      // Nothing of this owner in flight on this chain, as before a step (post-B4 review item 3, V1 setup's rule).
      await t.freeNonce(rpc)
      const { kinds, calls } = await createBatchCalls(rpc, review)
      // `gas` null: the budget read here, through this bounded port; Base's L1 data fee ceiling in the cost (F8, F5).
      const { gasUsed, networkFeeWei } = await simulateV2Batch(rpc, chain, owner, calls, gas, batchSimulator)
      const batch: VaultCreateBatch = Object.freeze({
        chainId: chain.chainId,
        owner,
        key: vaultBatchKey(chain.chainId, review.factory, owner, review.nonce),
        vault: review.vault,
        factory: review.factory,
        nonce: review.nonce,
        kinds: Object.freeze(kinds),
        calls: Object.freeze(calls),
        gasUsed,
        networkFeeWei,
        expiresAt: now() + REVIEW_S,
      })
      issuedBatches.add(batch)
      batchOrigins.set(batch, review)
      return batch
    }),

    /**
     * Offers a prepared creation batch to the wallet once, behind the page's latch for this owner's factory nonce (on
     * this chain's latch): the calls derived again and simulated again, `eth_chainId` read right before the wallet, never
     * offered twice. The latches of this owner's earlier factory nonces are let go first: the factory moved past them, so
     * nothing of their batches can run. The wallet's id for the batch.
     */
    sendBatch: async (batch: VaultCreateBatch, acknowledged: boolean, latchFor: (chainId: V2ChainId, owner: Address) => V2BatchLatch = browserV2BatchLatch): Promise<string> => {
      refuseUnlessLive(chain.chainId, contracts)
      const review = batchOrigins.get(batch)
      if (!acknowledged || !review || !issuedBatches.has(batch) || batch.expiresAt <= now() || batch.owner !== owner || batch.chainId !== chain.chainId) return fail('wallet_review_required')
      const latch = latchFor(chain.chainId, owner)
      for (let n = batch.nonce > 4n ? batch.nonce - 4n : 0n; n < batch.nonce; n++) await settleBatchLatch(latch, vaultBatchKey(chain.chainId, batch.factory, owner, n))
      if (latch.batchOffered(batch.key) !== null && !(await latch.expireBatch(batch.key, V2_BATCH_LATCH_EXPIRY_S))) return fail('batch_already_offered')
      return t.bounded(async (rpc) => {
        await t.identity(rpc)
        await t.freeNonce(rpc)
        // The chain may have moved since the review: the exact calls are derived and simulated again before the wallet sees them.
        const { calls } = await createBatchCalls(rpc, review)
        if (calls.length !== batch.calls.length || calls.some((call, i) => call.to !== batch.calls[i].to || call.data !== batch.calls[i].data)) fail('vault_review_stale')
        await simulateBatch((method, params) => rpc(method, params), owner, batch.calls, batchSimulator)
        if (batch.expiresAt <= now()) fail('wallet_review_expired')
        // Immediately before the wallet is asked: the same chain, still (spec §1.3).
        if (quantity(await rpc('eth_chainId', [])) !== BigInt(chain.chainId)) fail('wallet_wrong_chain')
        issuedBatches.delete(batch)
        const id = await offerV2Batch(rpc, owner, chain.chainId, latch, batch.key, batch.calls, () => wallet.current() && wallet.chainId() === chain.chainId && batch.expiresAt > now())
        offeredBatches.set(id, { batch, review })
        return id
      }, SIGN_WINDOW_S)
    },

    /**
     * Where a creation batch this client offered stands: the wallet's status while it knows the batch (100 pending; 400
     * not included or 500 reverted: nothing of it ran, its latch is let go), then the chain: the transaction carrying
     * this owner's `VaultCreated` for the predicted vault, from the review's block, and its receipt, "included" then
     * "finalized", with the factory's and the vault's events. Once it ran (or reverted on chain), its latch is let go.
     */
    batchReceipt: (id: string, latchFor: (chainId: V2ChainId, owner: Address) => V2BatchLatch = browserV2BatchLatch) => t.bounded(async (rpc): Promise<V2BatchReceipt> => {
      const known = offeredBatches.get(id)
      if (!known) return fail('receipt_not_from_this_review')
      const { batch, review } = known
      const latch = latchFor(chain.chainId, owner)
      const none: readonly V2Event[] = Object.freeze([])
      const calls = await knownBatchState(t, wallet, chain, rpc, id, known)
      const status = calls?.status ?? null
      if (status !== null && status >= 100 && status < 200) return { state: 'pending', events: none }
      if (status === 400 || status === 500) {
        await latch.releaseBatch(batch.key, id)
        return { state: status === 400 ? 'not-included' : 'batch-reverted', events: none }
      }
      const topics = (encodeEventTopics({ abi: VAULT_FACTORY_ABI, eventName: 'VaultCreated', args: { owner, vault: batch.vault } } as Parameters<typeof encodeEventTopics>[0]) as (Hex | null)[]).slice(0, 3)
      const hash = calls?.transactionHash ?? await transactionWithLog(rpc, batch.factory, topics, review.snapshot.blockNumber)
      if (hash === null) return { state: 'pending', events: none }
      const receipt = await receiptOfBatch(rpc, chain, hash, (logs) => logs.some((log) => log.address === batch.factory && log.topics[0] === topics[0] && log.topics[2] === topics[2]), wallet)
      if (receipt.state === 'pending' || receipt.state === 'reorged') return { ...receipt, events: none }
      known.transactionHash = hash
      await latch.releaseBatch(batch.key, id)
      if (receipt.state === 'reverted') return { ...receipt, events: none }
      return { ...receipt, events: decodeEvents(receipt.logs, [{ address: batch.factory, abi: VAULT_FACTORY_EVENTS_ABI }, { address: batch.vault, abi: VAULT_EVENTS_ABI }]) }
    }),

    /**
     * Every reserve of `vault` as ONE batch (spec F7 rev3 §2.13, §5.6; "Withdraw to wallet"): the amounts read at the
     * latest block, simulated whole through the wallet's eth_simulateV1 (a wallet without it is
     * `batch_simulation_unavailable`: one step per token instead), its cost checked against the budget and the owner's
     * ETH. Reads only. Added on purpose (data) 2026-10-02 (Domino V2 rev3).
     */
    prepareWithdrawAllBatch: (vault: Address, gas: V2GasBudget | null = null, recipient?: Address) => t.bounded(async (rpc): Promise<VaultWithdrawBatch> => {
      if (gas) checkBatchBudget(gas)
      await t.identity(rpc)
      // The vault's own refusals first (nothing to withdraw, one token only, a withdrawal already handed over), then
      // nothing of this owner in flight on this chain, as before a step.
      const { identity, stateNonce, block, amounts, calls, recipient: to } = await withdrawAllCalls(rpc, vault, recipient)
      await t.freeNonce(rpc)
      const { gasUsed, networkFeeWei } = await simulateV2Batch(rpc, chain, owner, calls, gas, batchSimulator)
      const batch: VaultWithdrawBatch = Object.freeze({
        chainId: chain.chainId,
        owner,
        key: withdrawBatchKey(chain.chainId, identity.vault, owner, stateNonce),
        vault: identity.vault,
        stateNonce,
        fromBlock: block,
        recipient: to,
        amounts: Object.freeze(amounts.map((a) => Object.freeze(a))),
        calls: Object.freeze(calls),
        gasUsed,
        networkFeeWei,
        expiresAt: now() + REVIEW_S,
      })
      issuedWithdraws.add(batch)
      return batch
    }),

    /**
     * Offers a prepared withdraw-all batch to the wallet once, behind the page's latch for this vault state (on this
     * chain's latch): the calls derived and simulated again, `eth_chainId` read right before the wallet, never offered
     * twice. The wallet's id for the batch.
     */
    sendWithdrawAllBatch: async (batch: VaultWithdrawBatch, acknowledged: boolean, latchFor: (chainId: V2ChainId, owner: Address) => V2BatchLatch = browserV2BatchLatch): Promise<string> => {
      refuseUnlessLive(chain.chainId, contracts)
      if (!acknowledged || !issuedWithdraws.has(batch) || batch.expiresAt <= now() || batch.owner !== owner || batch.chainId !== chain.chainId) return fail('wallet_review_required')
      const latch = latchFor(chain.chainId, owner)
      if (latch.batchOffered(batch.key) !== null && !(await latch.expireBatch(batch.key, V2_BATCH_LATCH_EXPIRY_S))) return fail('batch_already_offered')
      return t.bounded(async (rpc) => {
        await t.identity(rpc)
        await t.freeNonce(rpc)
        const { stateNonce, calls } = await withdrawAllCalls(rpc, batch.vault, batch.recipient)
        if (stateNonce !== batch.stateNonce || calls.length !== batch.calls.length || calls.some((call, i) => call.to !== batch.calls[i].to || call.data !== batch.calls[i].data)) fail('vault_review_stale')
        await simulateBatch((method, params) => rpc(method, params), owner, batch.calls, batchSimulator)
        if (batch.expiresAt <= now()) fail('wallet_review_expired')
        if (quantity(await rpc('eth_chainId', [])) !== BigInt(chain.chainId)) fail('wallet_wrong_chain')
        issuedWithdraws.delete(batch)
        const id = await offerV2Batch(rpc, owner, chain.chainId, latch, batch.key, batch.calls, () => wallet.current() && wallet.chainId() === chain.chainId && batch.expiresAt > now())
        offeredWithdraws.set(id, { batch })
        return id
      }, SIGN_WINDOW_S)
    },

    /**
     * Where a withdraw-all batch stands: the wallet's status while it knows it (100 pending; 400 or 500: nothing of it
     * ran, its latch is let go), then the chain: the transaction whose `ReservesWithdrawn` at the vault moved it from the
     * batch's stateNonce (one transaction, found by its log from the batch's block), and its receipt with the vault's
     * events. Once it ran (or reverted on chain), its latch is let go.
     */
    withdrawAllReceipt: (id: string, latchFor: (chainId: V2ChainId, owner: Address) => V2BatchLatch = browserV2BatchLatch) => t.bounded(async (rpc): Promise<V2BatchReceipt> => {
      const known = offeredWithdraws.get(id)
      if (!known) return fail('receipt_not_from_this_review')
      const { batch } = known
      const latch = latchFor(chain.chainId, owner)
      const none: readonly V2Event[] = Object.freeze([])
      const calls = await knownBatchState(t, wallet, chain, rpc, id, known)
      const status = calls?.status ?? null
      if (status !== null && status >= 100 && status < 200) return { state: 'pending', events: none }
      if (status === 400 || status === 500) {
        await latch.releaseBatch(batch.key, id)
        return { state: status === 400 ? 'not-included' : 'batch-reverted', events: none }
      }
      const topic = (encodeEventTopics({ abi: VAULT_EVENTS_ABI, eventName: 'ReservesWithdrawn', args: { token: batch.amounts[0].token } } as Parameters<typeof encodeEventTopics>[0]) as (Hex | null)[]).slice(0, 2)
      const moved = (log: { address: string; topics: readonly string[]; data: string }) => {
        if (log.address.toLowerCase() !== batch.vault || log.topics[0]?.toLowerCase() !== topic[0] || log.topics[1]?.toLowerCase() !== topic[1]) return false
        try {
          const decoded = decodeEventLog({ abi: VAULT_EVENTS_ABI, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] })
          return (decoded.args as unknown as { stateNonce?: bigint }).stateNonce === batch.stateNonce + 1n
        } catch {
          return false
        }
      }
      const hashes = new Set<string>()
      if (calls?.transactionHash) hashes.add(calls.transactionHash)
      else {
        const found = await rpc('eth_getLogs', [{ address: batch.vault, topics: topic, fromBlock: numberToHex(batch.fromBlock), toBlock: 'latest' }])
        if (!Array.isArray(found)) return fail('invalid_wallet_reply')
        for (const entry of found) {
          const log = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null
          if (!log || log.removed === true || !Array.isArray(log.topics) || typeof log.data !== 'string' || typeof log.address !== 'string') continue
          if (typeof log.transactionHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(log.transactionHash)) return fail('invalid_wallet_reply')
          if (moved({ address: log.address, topics: log.topics as string[], data: log.data })) hashes.add(log.transactionHash.toLowerCase())
        }
      }
      if (hashes.size === 0) return { state: 'pending', events: none }
      if (hashes.size > 1) return fail('receipt_duplicate_action')
      const receipt = await receiptOfBatch(rpc, chain, [...hashes][0] as Hex, (logs) => logs.some(moved), wallet)
      if (receipt.state === 'pending' || receipt.state === 'reorged') return { ...receipt, events: none }
      known.transactionHash = [...hashes][0] as Hex
      await latch.releaseBatch(batch.key, id)
      if (receipt.state === 'reverted') return { ...receipt, events: none }
      return { ...receipt, events: decodeEvents(receipt.logs, [{ address: batch.vault, abi: VAULT_EVENTS_ABI }]) }
    }),

    /**
     * §5.2's two prices for a v3 vault, at one block (Added on purpose (data) 2026-10-02, Domino V2 rev2 §5.2): the
     * reference price, `priceAnchor.twapSqrtPrice(pool, secondsAgo)` with `secondsAgo` the planner's own window, read
     * only once the anchor's runtime code is the manifest's (verifyV2Code), and the pool's spot. A v4 vault (no route to
     * the publisher's observations yet), a set without the anchor, a window outside 1 to 2^32 − 1, or the anchor's
     * refusal (`TwapUnavailable`…) is `vault_reference_unavailable`: the distance is then shown as unavailable. Reads only.
     */
    readReference: (vault: Address, secondsAgo: number) => t.bounded(async (rpc): Promise<VaultReference> => {
      await t.identity(rpc)
      const { at, snapshot } = await pinBlock(t, rpc)
      const identity = await readVaultIdentity(t, chain, contracts, at, vault)
      const anchorAt = contracts.addresses.priceAnchor
      if (identity.dex !== 3 || !anchorAt || !inRange(secondsAgo, 1, MAX_UINT32)) return fail('vault_reference_unavailable')
      await verifyComponents(rpc, contracts, ['priceAnchor'])
      const pool = identity.pool
      const slot0 = await view<readonly unknown[]>(at, v3PoolOf(chain, pool), V3_POOL_ABI, 'slot0', [], 'vault_reference_unavailable')
      const spot = slot0[0]
      const key = { dex: pool.dex, currency0: pool.currency0, currency1: pool.currency1, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: pool.hooks }
      const anchor = await view<bigint>(at, anchorAt, PRICE_ANCHOR_ABI, 'twapSqrtPrice', [key, secondsAgo], 'vault_reference_unavailable')
      if (typeof spot !== 'bigint' || spot <= 0n || typeof anchor !== 'bigint' || anchor <= 0n) return fail('vault_reference_unavailable')
      return Object.freeze({ ...snapshot, anchorSqrtPriceX96: anchor, spotSqrtPriceX96: spot, secondsAgo })
    }),

    /** The chain's halt banner flag (`registry.automationHalted()`), with its block. Reads only. */
    readHalted: () => t.bounded(async (rpc) => {
      await t.identity(rpc)
      const { at, snapshot } = await pinBlock(t, rpc)
      return Object.freeze({ ...snapshot, halted: await view<boolean>(at, contracts.addresses.registry, REGISTRY_ABI, 'automationHalted') })
    }),

    /** Whether the factory of either DEX says it made `vault`. Reads only. */
    isFactoryVault: (vault: Address) => t.bounded(async (rpc) => {
      await t.identity(rpc)
      const { at } = await pinBlock(t, rpc)
      try {
        await readVaultIdentity(t, chain, contracts, at, vault)
        return true
      } catch (error) {
        if (error instanceof Error && (error.message === 'vault_unknown' || error.message === 'vault_invalid_address')) return false
        throw error
      }
    }),
  }
}
export type VaultClient = ReturnType<typeof createVaultClient>
