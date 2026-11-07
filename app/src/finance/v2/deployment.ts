import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getContractAddress,
  getCreate2Address,
  keccak256,
  sha256,
  stringToBytes,
  stringToHex,
  type Abi,
} from 'viem'
import zapInterface from '../../../../api-contracts/v2/abi/IDominoZap.json'
import { hasDex, isV2ChainId, positionManagerOf, v2Chain, type V2Chain } from '../../v2/chains'
import { V2_FIXTURE_SETS_TAKEN } from '../../v2/flag'
import { APP_COMPONENTS, CODE_COMPONENTS, CREATE3_PROXY_INITCODE_HASH, CREATE_X, DEPLOY_ORDER, canonical, componentsFor, deployOrderFor, v2Availability } from '../../v2/manifest'
import type { Address, Dex, Hex, V2CodeComponent, V2Component, V2Contracts, V2DeployedComponent, V2DeploymentFacts, V2ManifestContract } from '../../v2/types'

/**
 * The on-chain checks of a pinned V2 deployment, before the session's first write (spec F7 §7.3 point 4, §2.1), and
 * the manifest checks that need keccak256 or SHA-256 (spec rev2 §7.2).
 *
 * Changed on purpose (data) 2026-10-02 (Domino V2 rev2 §7): `checkV2Prediction` is the half of the backend's
 * `checked_manifest` (backend/v2_manifest.py) that src/v2/manifest.ts cannot run without a hash function: every one of
 * the 13 addresses is CreateX's deployCreate3 for `roles.deployer` (`predict()`: salt = deployer ‖ 0x00 ‖
 * bytes11(keccak256("domino.v2.<component>")), guarded = keccak256(abi.encode(deployer, salt)), proxy =
 * CREATE2(CreateX, guarded, CREATE3_PROXY_INITCODE_HASH), the component = the proxy's CREATE at nonce 1, each executor
 * its vault implementation's CREATE at nonce 1), the raw and guarded salts recorded are those, and
 * `build.sourceTreeSha256` is sha256(canonical(sourceHashes)). admitV2Contracts runs it before any address of a set
 * reaches a money client.
 *
 * The manifest (src/v2/manifest.ts) is the only source of a Domino V2 address, and it is pinned in git. What it cannot
 * prove is what each address holds on the chain the wallet is on, so before a money client first writes to a component
 * it asks for that component's code and compares keccak256(code) with the manifest's `runtimeCodeHashes`, as V1's
 * `deployment_code_changed` does: no code is `deployment_missing`, other code is `deployment_code_changed`. And each zap
 * must name the chain's own Uniswap position manager (`zap.positionManager()`), the v3 NonfungiblePositionManager for
 * `zap.v3` and the v4 PositionManager for `zap.v4`, and says whether it takes positions in hooked v4 pools
 * (`zap.hookedPoolsAllowed()`, false today; spec §1.4).
 *
 * The reads are INJECTED: the client hands in its own bounded read through the wallet's provider, on the chain of the
 * action. This module asks the wallet nothing itself and names no wallet method
 * (tests/session.source-guard.test.mjs lets only the closed clients do that).
 *
 * Each check is made once per page session per chain, component, address and code hash: a second check of the same is
 * free, and another chain is checked again. A failed or unreadable check is never remembered, so the next attempt reads
 * again. The code of a deployed V2 contract cannot change at its address, which is what makes once enough.
 */

/** The client's read of an address's code on the action's chain: a hex string, '0x' when nothing is deployed there. */
export type GetCode = (address: Address) => Promise<unknown>
/** The client's read-only call on the action's chain: the raw return data as a hex string. */
export type ReadCall = (to: Address, data: Hex) => Promise<unknown>

/** The closed set of refusals. The first three are V1's, with V1's words (finance/words.ts) for two of them. */
export const DEPLOYMENT_ERRORS = [
  'deployment_missing',
  'deployment_code_changed',
  'deployment_identity_changed',
  'deployment_read_invalid',
  'deployment_chain_mismatch',
  'deployment_component_unknown',
  'deployment_fixture_refused',
  'deployment_not_pinned',
  // Changed on purpose (data) 2026-10-02 (Domino V2 rev2 §7): the manifest's facts against the CREATE3 prediction.
  'deployment_addresses_changed',
  'deployment_salts_changed',
  'deployment_source_tree_changed',
] as const
export type DeploymentErrorCode = (typeof DEPLOYMENT_ERRORS)[number]

const fail = (code: DeploymentErrorCode): never => {
  throw Object.assign(new Error(code), { code })
}

// Declared here, module-scoped, as src/finance/pin.ts does: a compile outside Vite answers "not a deployable build".
declare const __DOMINO_DEPLOYABLE__: boolean | undefined
// Changed on purpose (data) 2026-10-02 (Domino V2 integration, the preview-v2 build): preview-v2 is the real site for V1
// (`__DOMINO_DEPLOYABLE__` true there) yet takes fixture sets up to a review (V2_FIXTURE_SETS_TAKEN, src/v2/flag.ts): their
// sends and signatures are refused by ./liveLock.ts instead. The deployable builds refuse them here, as before.
const DEPLOYABLE: boolean = typeof __DOMINO_DEPLOYABLE__ === 'boolean' && __DOMINO_DEPLOYABLE__ && !V2_FIXTURE_SETS_TAKEN

const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/

/**
 * Fixture contracts (src/v2/manifestFixtures.ts) never pass a deployable build's checks, whatever a chain holds. A set
 * that does not say it is real (`fixture` anything but false) counts as a fixture: fail closed.
 */
function admit(contracts: V2Contracts): void {
  if (contracts.fixture !== false && DEPLOYABLE) fail('deployment_fixture_refused')
}

// Changed on purpose (data) 2026-10-02 (Domino V2 integration): exported for ./liveLock.ts, whose live set is this same one.
export const sameSet = (a: V2Contracts, b: V2Contracts): boolean =>
  a.chainId === b.chainId && Object.keys(a.addresses).length === Object.keys(b.addresses).length
  && (Object.keys(a.addresses) as V2Component[]).every((name) => {
    const address = b.addresses[name], hash = b.codeHashes[name]
    return typeof address === 'string' && address.toLowerCase() === a.addresses[name]?.toLowerCase()
      && typeof hash === 'string' && hash.toLowerCase() === a.codeHashes[name]?.toLowerCase()
  })
  // A set that carries its manifest's facts carries exactly the pinned manifest's.
  && (b.deployment === undefined || canonical(b.deployment) === canonical(a.deployment))

// ---------------------------------------------------------------------------
// The CREATE3 prediction (backend/v2_manifest.py `predict`, deploy.mjs `precomputeAddresses`)
// ---------------------------------------------------------------------------

/** F0: deployer (20 bytes) ‖ 0x00 ‖ bytes11(keccak256("domino.v2.<component>")): the chain byte off, so the same everywhere. */
export function componentSalt(deployer: Address, component: V2DeployedComponent): Hex {
  return `${deployer.toLowerCase()}00${keccak256(stringToHex(`domino.v2.${component}`)).slice(2, 24)}` as Hex
}

/** CreateX's guard for a sender-prefixed salt without the chain flag: keccak256(abi.encode(deployer, salt)). */
export function guardedSalt(deployer: Address, salt: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [deployer, salt]))
}

export interface V2Prediction {
  readonly contracts: Readonly<Record<V2ManifestContract, Address>>
  readonly salts: Readonly<Record<V2DeployedComponent, Hex>>
  readonly guardedSalts: Readonly<Record<V2DeployedComponent, Hex>>
}

/**
 * The 13 addresses, the raw and the guarded salts CreateX's deployCreate3 gives `deployer` (lowercase): each component
 * the CREATE at nonce 1 of the proxy CREATE2(CreateX, guarded salt, CREATE3_PROXY_INITCODE_HASH) deploys, each executor
 * its vault implementation's CREATE at nonce 1. The same on every chain.
 */
export function predictV2Deployment(deployer: Address): V2Prediction {
  const from = deployer.toLowerCase() as Address
  const contracts = {} as Record<V2ManifestContract, Address>
  const salts = {} as Record<V2DeployedComponent, Hex>
  const guardedSalts = {} as Record<V2DeployedComponent, Hex>
  for (const component of DEPLOY_ORDER) {
    salts[component] = componentSalt(from, component)
    guardedSalts[component] = guardedSalt(from, salts[component])
    const proxy = getCreate2Address({ from: CREATE_X, salt: guardedSalts[component], bytecodeHash: CREATE3_PROXY_INITCODE_HASH })
    contracts[component] = getContractAddress({ from: proxy, nonce: 1n }).toLowerCase() as Address
  }
  contracts['vaultExecutor.v3'] = getContractAddress({ from: contracts['vault.v3'], nonce: 1n }).toLowerCase() as Address
  contracts['vaultExecutor.v4'] = getContractAddress({ from: contracts['vault.v4'], nonce: 1n }).toLowerCase() as Address
  return Object.freeze({ contracts: Object.freeze(contracts), salts: Object.freeze(salts), guardedSalts: Object.freeze(guardedSalts) })
}

const predictions = new Map<string, V2Prediction>()
/** The prediction for a deployer, made once per page session. */
function predictionFor(deployer: Address): V2Prediction {
  const key = deployer.toLowerCase()
  const known = predictions.get(key)
  if (known) return known
  const made = predictV2Deployment(key as Address)
  predictions.set(key, made)
  return made
}

const HASH = /^0x[0-9a-f]{64}$/

/**
 * The manifest checks that need a hash function (the rest are src/v2/manifest.ts checkV2Manifest's): the 13 contracts
 * are the CREATE3 prediction for the facts' deployer through the canonical CreateX (`deployment_addresses_changed`), the
 * raw and guarded salts are the prediction's (`deployment_salts_changed`), and `sourceTreeSha256` is
 * sha256(canonical(sourceHashes)) (`deployment_source_tree_changed`). Throws the first refusal. Changed on purpose
 * 2026-11-06 (Elysium readiness; backend `checked_manifest`): of a chain with v4 alone, the nine contracts and eight
 * salts of its versions (whose vault the facts record), each at the same CREATE3 address as on the other chains.
 */
export function checkV2Prediction(facts: V2DeploymentFacts): void {
  if (!facts || typeof facts !== 'object' || typeof facts.deployer !== 'string' || !/^0x[0-9a-f]{40}$/.test(facts.deployer)) fail('deployment_addresses_changed')
  if (facts.createx !== CREATE_X) fail('deployment_addresses_changed')
  const predicted = predictionFor(facts.deployer)
  const dexes = ([3, 4] as const).filter((dex) => facts.contracts && Object.hasOwn(facts.contracts, `vault.v${dex}`))
  if (dexes.length === 0) fail('deployment_addresses_changed')
  const pick = (source: Readonly<Record<string, string>>, keys: readonly string[]) => Object.fromEntries(keys.map((key) => [key, source[key]]))
  const order = deployOrderFor(dexes)
  if (canonical(facts.contracts) !== canonical(pick(predicted.contracts, componentsFor(dexes)))) fail('deployment_addresses_changed')
  if (canonical(facts.salts) !== canonical(pick(predicted.salts, order)) || canonical(facts.guardedSalts) !== canonical(pick(predicted.guardedSalts, order))) fail('deployment_salts_changed')
  if (typeof facts.sourceTreeSha256 !== 'string' || sha256(stringToBytes(canonical(facts.sourceHashes))).slice(2) !== facts.sourceTreeSha256) fail('deployment_source_tree_changed')
  for (const name of Object.keys(facts.contracts) as V2ManifestContract[]) {
    const hash = facts.codeHashes?.[name]
    if (typeof hash !== 'string' || !HASH.test(hash)) fail('deployment_addresses_changed')
  }
}

/** A set built from a manifest: its facts pass checkV2Prediction, and its components are the facts' own. */
function checkFacts(contracts: V2Contracts): void {
  const facts = contracts.deployment
  if (!facts) return fail('deployment_addresses_changed')
  checkV2Prediction(facts)
  for (const [name, key] of Object.entries(APP_COMPONENTS) as [V2Component, V2ManifestContract][]) {
    if (!Object.hasOwn(contracts.addresses, name) || !Object.hasOwn(contracts.codeHashes, name)) continue
    if (String(contracts.addresses[name]).toLowerCase() !== facts.contracts[key] || String(contracts.codeHashes[name]).toLowerCase() !== facts.codeHashes[key]) fail('deployment_addresses_changed')
  }
}

/**
 * What a V2 money client may be built with (spec §7.3 points 1 and 6: Domino addresses only from the chain's pinned
 * manifest, never from an API reply or storage), checked by every client's constructor:
 *   - `chain` is the app's own profile of a V2 chain (src/v2/chains.ts), the very object, not a look-alike;
 *   - the contracts set is for that chain;
 *   - in a deployable build, it is not a fixture, the chain's PINNED manifest (src/v2/manifest.ts v2Availability, the
 *     production admission) passes checkV2Prediction, and the set is exactly the one that manifest gives. The code check
 *     below then proves what those addresses hold on chain. Until #301 publishes a manifest, the pinned map is empty and
 *     a deployable build builds no V2 client at all;
 *   - in a test build, a set that carries its manifest's facts (a fixture manifest's) passes checkV2Prediction too; a
 *     set a test builds by hand carries none and is taken as it is (it never reaches a deployable bundle).
 */
export function admitV2Contracts(chain: V2Chain, contracts: V2Contracts): void {
  if (!chain || !isV2ChainId(chain.chainId) || chain !== v2Chain(chain.chainId)) fail('deployment_chain_mismatch')
  if (!contracts || typeof contracts !== 'object' || contracts.chainId !== chain.chainId) fail('deployment_chain_mismatch')
  admit(contracts)
  if (!DEPLOYABLE) {
    if (contracts.deployment !== undefined) checkFacts(contracts)
    return
  }
  const pinned = v2Availability(chain.chainId)
  if (!pinned.available || pinned.contracts.deployment?.admission !== 'production') return fail('deployment_not_pinned')
  checkFacts(pinned.contracts)
  if (!sameSet(pinned.contracts, contracts)) fail('deployment_not_pinned')
}

/** Remembers a check while it runs and after it passes; forgets it when it fails. */
function once<T>(memo: Map<string, Promise<T>>, key: string, check: () => Promise<T>): Promise<T> {
  const known = memo.get(key)
  if (known) return known
  const pending = check()
  memo.set(key, pending)
  pending.catch(() => {
    if (memo.get(key) === pending) memo.delete(key)
  })
  return pending
}

// ---------------------------------------------------------------------------
// Runtime code
// ---------------------------------------------------------------------------

const codeChecks = new Map<string, Promise<void>>()

async function checkCode(getCode: GetCode, at: Address, expected: Hex): Promise<void> {
  const code = await getCode(at)
  if (typeof code !== 'string' || !HEX_BYTES.test(code)) return fail('deployment_read_invalid')
  if (code === '0x') return fail('deployment_missing')
  if (keccak256(code.toLowerCase() as Hex) !== expected.toLowerCase()) return fail('deployment_code_changed')
}

const isAppComponent = (name: string): name is V2Component => Object.hasOwn(APP_COMPONENTS, name)

/**
 * Where a component is and the code it must hold. The components the app calls come from the set itself. The others
 * (Changed on purpose (data) 2026-10-02, Domino V2 rev2 §7: each vault implementation and its executor, the vault's
 * swap module, the v4 zap's steps) come from the manifest's facts, re-checked against the CREATE3 prediction first: in
 * a deployable build the PINNED manifest's facts, never the set's.
 */
function codeTarget(contracts: V2Contracts, component: V2CodeComponent): { at: Address; expected: Hex } {
  if (isAppComponent(component)) {
    // A set of a chain without v3 has no v3 component: asking for one is refused, never read.
    const at = Object.hasOwn(contracts.addresses, component) ? contracts.addresses[component] : undefined
    const hash = Object.hasOwn(contracts.codeHashes, component) ? contracts.codeHashes[component] : undefined
    if (typeof at !== 'string' || typeof hash !== 'string') return fail('deployment_component_unknown')
    return { at: at.toLowerCase() as Address, expected: hash.toLowerCase() as Hex }
  }
  if (!Object.hasOwn(CODE_COMPONENTS, component)) return fail('deployment_component_unknown')
  const pinned = DEPLOYABLE ? v2Availability(contracts.chainId) : null
  const facts = pinned ? (pinned.available ? pinned.contracts.deployment : undefined) : contracts.deployment
  if (!facts) return fail('deployment_component_unknown')
  checkV2Prediction(facts)
  const name = CODE_COMPONENTS[component]
  const at = facts.contracts[name], expected = facts.codeHashes[name]
  // A vault implementation or executor of a version the chain lacks (v3 on a chain with v4 alone) is no component of it.
  if (typeof at !== 'string' || typeof expected !== 'string') return fail('deployment_component_unknown')
  return { at, expected }
}

/**
 * Checks, one read at a time, that each component the caller is about to use holds the code its manifest pinned.
 * Throws the first refusal; resolves when every one matches.
 */
export async function verifyV2Code(getCode: GetCode, contracts: V2Contracts, components: readonly V2CodeComponent[]): Promise<void> {
  admit(contracts)
  // Every V2 write uses at least one component: an empty list is a caller's mistake, never a pass.
  if (components.length === 0) fail('deployment_component_unknown')
  for (const component of components) {
    const { at, expected } = codeTarget(contracts, component)
    await once(codeChecks, `${contracts.chainId}:${component}:${at}:${expected}`, () => checkCode(getCode, at, expected))
  }
}

// ---------------------------------------------------------------------------
// The zaps' position managers and hook policy
// ---------------------------------------------------------------------------

const ZAP_ABI = (zapInterface as unknown as { abi: Abi }).abi

/** The zap's two views this module calls, encoded from api-contracts/v2/abi/IDominoZap.json. */
export const ZAP_CALLS = Object.freeze({
  positionManager: encodeFunctionData({ abi: ZAP_ABI, functionName: 'positionManager' }),
  hookedPoolsAllowed: encodeFunctionData({ abi: ZAP_ABI, functionName: 'hookedPoolsAllowed' }),
})

export interface ZapCheck {
  readonly dex: Dex
  readonly zap: Address
  /** The chain's own Uniswap position manager for this dex, as the zap named it. */
  readonly positionManager: Address
  /** Whether the zap takes positions in v4 pools with a hook (spec §1.4). False today: such pools are hidden. */
  readonly hookedPoolsAllowed: boolean
}

const zapChecks = new Map<string, Promise<ZapCheck>>()

async function view(call: ReadCall, to: Address, functionName: keyof typeof ZAP_CALLS): Promise<unknown> {
  const data = await call(to, ZAP_CALLS[functionName])
  if (typeof data !== 'string' || !HEX_BYTES.test(data)) return fail('deployment_read_invalid')
  if (data === '0x') return fail('deployment_missing')
  try {
    return decodeFunctionResult({ abi: ZAP_ABI, functionName, data: data as Hex })
  } catch {
    return fail('deployment_read_invalid')
  }
}

async function checkZap(call: ReadCall, dex: Dex, zap: Address, expected: Address): Promise<ZapCheck> {
  const named = await view(call, zap, 'positionManager')
  if (typeof named !== 'string' || named.toLowerCase() !== expected) return fail('deployment_identity_changed')
  const hooked = await view(call, zap, 'hookedPoolsAllowed')
  if (typeof hooked !== 'boolean') return fail('deployment_read_invalid')
  return Object.freeze({ dex, zap, positionManager: expected, hookedPoolsAllowed: hooked })
}

/**
 * Checks each asked zap against the chain's profile (spec §2.1 recommendation): `zap.v3.positionManager()` must be the
 * chain's v3 NonfungiblePositionManager and `zap.v4.positionManager()` its v4 PositionManager, else
 * `deployment_identity_changed`; then reads `hookedPoolsAllowed()`. One read at a time, once per session per chain and
 * zap. Resolves to each zap's answer by dex. Changed on purpose 2026-11-06 (Elysium readiness): by default the zaps of
 * the chain's own versions (both on Robinhood Chain, Base and Arbitrum One, as before); a version the chain or the set
 * lacks is refused (`deployment_component_unknown`) before any read.
 */
export async function checkZapPositionManager(call: ReadCall, contracts: V2Contracts, chain: V2Chain, dexes: readonly Dex[] = chain.dexes): Promise<Readonly<Partial<Record<Dex, ZapCheck>>>> {
  admit(contracts)
  if (chain.chainId !== contracts.chainId) fail('deployment_chain_mismatch')
  const result: Partial<Record<Dex, ZapCheck>> = {}
  for (const dex of dexes) {
    const named = dex === 3 ? contracts.addresses.zapV3 : contracts.addresses.zapV4
    if (!hasDex(chain, dex) || typeof named !== 'string') return fail('deployment_component_unknown')
    const zap = named.toLowerCase() as Address
    const expected = positionManagerOf(chain, dex).toLowerCase() as Address
    result[dex] = await once(zapChecks, `${contracts.chainId}:${dex}:${zap}:${expected}`, () => checkZap(call, dex, zap, expected))
  }
  return Object.freeze(result)
}

/** Forgets every check this session made (a test's fresh start; the app has no reason to call it). */
export function forgetV2DeploymentChecks(): void {
  codeChecks.clear()
  zapChecks.clear()
  predictions.clear()
}
