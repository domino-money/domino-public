import type { Address } from 'viem'
import { atomicStatus, type AtomicStatus } from './batch'
import { suggestGasBudget } from './gas'
import { readRelease } from './release'
import {
  RESERVE_VAULT_PAGE,
  createSequenceClient,
  recoveryDeployment,
  sequenceDeploymentFrom,
  sequenceProviderReadError,
  walkFeeReserves,
  type SequenceDeployment,
  type VaultReserves,
} from './sequence'
import { readSequenceSnapshot } from './sequenceSnapshot'
import type { GasBudget, WalletRpc } from './setup'
import { setupWallet } from './wallet'
import { errorCode } from './words'

/**
 * Fees waiting in an owner's vault, live (2026-10-02, the V1 incident of rugged97's spec rev3 §2.13): the reads that find
 * them and the client that withdraws them, for components/positions/FeeReserves.tsx (the Positions screen's card and a
 * vault-managed position's page).
 *
 * Every chain read here is the money client's (./sequence.ts), through the connected wallet's own provider, which the
 * owner's rule allows for the money flows (RPC-SPEC, the decisions table): the wallet's vaults by the factory's nonce
 * (ownedVaults, which falls back to the trusted read snapshot of rugged97's node when the wallet rejects a read), then
 * each vault's reserves (walkFeeReserves). No public RPC is asked, and nothing is read at all without a deployment to
 * check the vaults against: the published sequence release, expired or not (a withdrawal is owner recovery, which the
 * client checks as such), else the profile this browser saved when the wallet last verified one, else the V1 release
 * this build ships for recovery (./pin.ts SEQUENCE_RECOVERY_RECORD).
 *
 * Changed on purpose 2026-10-02 (review of the fee withdrawal):
 * - finding 5: with no release (expired after 2026-10-21, or switched off) and no saved profile (a phone that never set
 *   up automation), nothing was read and the card never showed; the shipped record is the last resort now;
 * - findings 2 and 6: every vault the factory lists is read, the first RESERVE_VAULT_PAGE at once and the rest a page at a
 *   time after (readMoreReserves), not the sixteen newest alone;
 * - finding 8: a read of one vault is kept a minute, a vault whose read failed is asked again by the screen, which keeps
 *   its last good read on screen meanwhile.
 */

/** Kept by Set up automation once the wallet verified the release (./sequenceLive.ts), and by a withdrawal here. */
const RECOVERY_PROFILE_KEY = 'domino.sequence.public-recovery.v1'
const MAX_PROFILE_CHARS = 8192
/** How long a read of an owner's reserves is kept before a screen that opens asks again. */
export const RESERVES_KEEP_MS = 60_000

/** The release read at any age: a withdrawal is owner recovery, which an expired profile may still check on chain. */
const readRecoveryRelease = () => readRelease('/api/setup/v1/sequence-release', (value) => sequenceDeploymentFrom(value, 0))

/** The profile this browser saved, parsed as strictly as the release, marked expired so it only ever reads and recovers. */
function savedProfile(): SequenceDeployment | null {
  try {
    const raw = localStorage.getItem(RECOVERY_PROFILE_KEY)
    return raw && raw.length <= MAX_PROFILE_CHARS ? recoveryDeployment(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

/**
 * The V1 release this build ships for recovery (./pin.ts SEQUENCE_RECOVERY_RECORD), marked expired. Test builds only:
 * the browser tests' fake chain stands in for it (window.__dominoRecoveryRecord, set by the test), and without one there
 * is none, so no other test's page reads a vault it was not given.
 */
function shippedRecord(): SequenceDeployment | null {
  if (__DOMINO_TEST_HOOKS__) {
    const injected = (window as { __dominoRecoveryRecord?: unknown }).__dominoRecoveryRecord
    return injected === undefined ? null : recoveryDeployment(injected)
  }
  return recoveryDeployment()
}

/** Release reads that may answer a moment later: a read of the reserves that met one is asked again, not said to have nothing. */
const PASSING_RELEASE = new Set(['network', 'timeout', 'bridge_unavailable', 'upstream_unavailable', 'status_502', 'status_503', 'status_504'])

/**
 * The deployment an owner's vaults are checked against, and whether it is the published one. With none at all, why:
 * `passing` when the release read may answer a moment later.
 */
async function reserveDeployment(): Promise<{ deployment: SequenceDeployment; published: boolean } | { deployment: null; passing: boolean }> {
  const release = await readRecoveryRelease()
  if (release.kind === 'available') return { deployment: release.deployment, published: true }
  const kept = savedProfile() ?? shippedRecord()
  return kept ? { deployment: kept, published: false } : { deployment: null, passing: PASSING_RELEASE.has(release.reason) }
}

/** A batch simulated on the site's simulate route, for a wallet without eth_simulateV1 (as ./sequenceLive.ts). */
const simulateOnChain = async (params: unknown[]) => (await import('../lib/chain/chainCode')).simulateOnChain(params)

export type ReserveClient = ReturnType<typeof createSequenceClient>

function clientOver(wallet: WalletRpc, deployment: SequenceDeployment): ReserveClient {
  return createSequenceClient(wallet, deployment, () => Date.now() / 1000, undefined, readSequenceSnapshot, { simulate: simulateOnChain })
}

/** What a withdrawal needs, fresh at each press: the client over the connected wallet, a network budget from its own price, and what it can batch. */
export interface ReserveWithdrawalKit {
  client: ReserveClient
  /** A vault's reserves read now, every member of it (./sequence.ts walkFeeReserves), never a kept read. */
  reserves: (vault: Address) => Promise<VaultReserves>
  gas: GasBudget
  atomic: () => Promise<AtomicStatus>
  /** Keeps the published profile once the wallet verified it on chain, for a withdrawal while none is published. */
  verified: () => void
}

export async function connectWithdrawal(): Promise<ReserveWithdrawalKit> {
  const found = await reserveDeployment()
  if (!found.deployment) throw new Error('sequence_admission_unavailable')
  const wallet = await setupWallet().catch((error) => {
    throw sequenceProviderReadError(error)
  })
  const client = clientOver(wallet, found.deployment)
  const gas = await suggestGasBudget(wallet)
  const verified = () => {
    if (!found.published) return
    try {
      localStorage.setItem(RECOVERY_PROFILE_KEY, JSON.stringify({ contractVersion: '1.0.0-rc.1', chainId: 4663, available: true, deployment: found.deployment }))
    } catch {
      /* Optional: a later withdrawal still reads the published release, or the shipped one. */
    }
  }
  return { client, reserves: (vault) => walkFeeReserves(client, vault), gas, atomic: () => atomicStatus(wallet), verified }
}

/** An owner's reserves as a screen shows them. */
export type ReserveRead =
  /** Nothing to read with: no wallet on Robinhood Chain, no deployment, or (for one vault) a vault that is not this wallet's. */
  | { kind: 'none'; reason: string }
  /**
   * `order`: every vault the factory lists, newest first (the one asked, on a position's page). `vaults`: those read now.
   * `failed`: those whose read failed this time, asked again by the screen. `unread`: the pages after the first, which
   * the screen reads next (readMoreReserves). `beyond`: the owner created more than RESERVE_VAULT_CAP vaults.
   */
  | { kind: 'ready'; order: readonly Address[]; vaults: readonly VaultReserves[]; failed: readonly Address[]; unread: readonly Address[]; beyond: boolean }
  | { kind: 'failed'; reason: string }

/** A later read of some of an owner's vaults (readMoreReserves). */
export type ReserveMore = { kind: 'ready'; vaults: readonly VaultReserves[]; failed: readonly Address[] } | { kind: 'none' | 'failed'; reason: string }

/** Failures that say there is nothing here to read, rather than a read that did not go through: never asked again on a timer. */
const NOTHING_HERE = new Set(['connect_robinhood_wallet', 'sequence_admission_unavailable', 'unqualified_sequence', 'deployment_identity_changed', 'deployment_not_pinned', 'deployment_identity_unpinned', 'invalid_sequence_release'])
const reasonOf = (error: unknown) => errorCode(error) ?? 'sequence_read_unexpected'
const outcome = (error: unknown): { kind: 'none' | 'failed'; reason: string } => {
  const reason = reasonOf(error)
  return NOTHING_HERE.has(reason) ? { kind: 'none', reason } : { kind: 'failed', reason }
}

/** One client per connected owner, kept while that wallet stays connected; its reads run one at a time, as the client requires. */
let open: { owner: string; wallet: WalletRpc; client: ReserveClient } | null = null
let lane: Promise<unknown> = Promise.resolve()
function queued<T>(work: () => Promise<T>): Promise<T> {
  const run = lane.then(work, work)
  lane = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}
async function readerFor(owner: string): Promise<ReserveClient | null> {
  if (open && open.owner === owner && open.wallet.current()) return open.client
  open = null
  const found = await reserveDeployment()
  // A release read that may answer a moment later is a read that did not go through, asked again by the screen.
  if (!found.deployment) {
    if (found.passing) throw new Error('sequence_release_unreachable')
    return null
  }
  const wallet = await setupWallet()
  if (wallet.owner !== owner) throw new Error('wallet_identity_changed')
  open = { owner, wallet, client: clientOver(wallet, found.deployment) }
  return open.client
}
const letGoOf = (owner: string) => {
  if (open?.owner === owner && !open.wallet.current()) open = null
}

/** The reads kept per owner and filter, and per owner and vault, each with when it was asked. */
const kept = new Map<string, { at: number; read: Promise<ReserveRead> }>()
const keptVaults = new Map<string, { at: number; read: Promise<VaultReserves> }>()
const listeners = new Set<(owner: string) => void>()

/** One vault's reserves, every member of it; a good read under RESERVES_KEEP_MS old is shared, and a failed one never kept. */
function vaultRead(owner: string, client: ReserveClient, vault: Address): Promise<VaultReserves> {
  const key = `${owner}|${vault.toLowerCase()}`
  const before = keptVaults.get(key)
  if (before && Date.now() - before.at < RESERVES_KEEP_MS) return before.read
  const read = queued(() => walkFeeReserves(client, vault))
  keptVaults.set(key, { at: Date.now(), read })
  read.catch(() => {
    if (keptVaults.get(key)?.read === read) keptVaults.delete(key)
  })
  return read
}

/** `vaults` read one after the other: those read, and those whose read failed (a vault that is not this wallet's is neither). */
async function readVaults(owner: string, client: ReserveClient, vaults: readonly Address[]): Promise<{ vaults: VaultReserves[]; failed: Address[] }> {
  const read: VaultReserves[] = []
  const failed: Address[] = []
  for (const address of vaults) {
    try {
      read.push(await vaultRead(owner, client, address))
    } catch (error) {
      if (!NOTHING_HERE.has(reasonOf(error))) failed.push(address)
    }
  }
  return { vaults: read, failed }
}

async function readNow(owner: string, vault: Address | null): Promise<ReserveRead> {
  try {
    const client = await queued(() => readerFor(owner))
    if (!client) return { kind: 'none', reason: 'sequence_admission_unavailable' }
    if (vault) {
      const one = await vaultRead(owner, client, vault)
      return { kind: 'ready', order: [vault], vaults: [one], failed: [], unread: [], beyond: false }
    }
    const listed = await queued(() => client.ownedVaults())
    const first = await readVaults(owner, client, listed.vaults.slice(0, RESERVE_VAULT_PAGE))
    return { kind: 'ready', order: listed.vaults, vaults: first.vaults, failed: first.failed, unread: listed.vaults.slice(RESERVE_VAULT_PAGE), beyond: listed.older }
  } catch (error) {
    letGoOf(owner)
    return outcome(error)
  }
}

/**
 * The connected owner's reserves: every vault it created (the first RESERVE_VAULT_PAGE of them read now, the rest named
 * in `unread`), or only `vault` (a position's page, whose read names its vault). A read younger than RESERVES_KEEP_MS is
 * shared, unless `fresh`. Never throws.
 */
export function readOwnerReserves(owner: string, vault: Address | null = null, fresh = false): Promise<ReserveRead> {
  const key = `${owner.toLowerCase()}|${vault?.toLowerCase() ?? '*'}`
  const before = kept.get(key)
  if (before && !fresh && Date.now() - before.at < RESERVES_KEEP_MS) return before.read
  const read = readNow(owner.toLowerCase(), vault ? (vault.toLowerCase() as Address) : null)
  kept.set(key, { at: Date.now(), read })
  // A failure is not kept: the screen asks again on its own.
  void read.then((answer) => {
    if (answer.kind === 'failed' && kept.get(key)?.read === read) kept.delete(key)
  })
  return read
}

/** Some of the connected owner's vaults read now: a page not read yet, or vaults whose read failed. Never throws. */
export async function readMoreReserves(owner: string, vaults: readonly Address[]): Promise<ReserveMore> {
  const who = owner.toLowerCase()
  try {
    const client = await queued(() => readerFor(who))
    if (!client) return { kind: 'none', reason: 'sequence_admission_unavailable' }
    return { kind: 'ready', ...(await readVaults(who, client, vaults)) }
  } catch (error) {
    letGoOf(who)
    return outcome(error)
  }
}

/** A withdrawal changed `owner`'s reserves: every read kept for it is dropped, and every screen showing them reads again. */
export function reservesChanged(owner: string): void {
  const prefix = `${owner.toLowerCase()}|`
  for (const key of kept.keys()) if (key.startsWith(prefix)) kept.delete(key)
  for (const key of keptVaults.keys()) if (key.startsWith(prefix)) keptVaults.delete(key)
  for (const listener of listeners) listener(owner.toLowerCase())
}

/** Told whenever a withdrawal changed an owner's reserves. */
export function watchReservesChanged(listener: (owner: string) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
