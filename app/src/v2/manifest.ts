/**
 * Domino V2's per-chain deployment manifests, pinned in git, and the only source of a Domino V2 address in the app
 * (spec F7 rev2 §7.2, §7.3).
 *
 * Changed on purpose (data) 2026-10-02 (Domino V2 rev2 §7): the format is PR #302's (issue #301's deploy tool:
 * scripts/v2/deploy.mjs writes it, docs/v2/DEPLOYMENT.md documents it, scripts/v2/deploy-manifest.schema.json is its
 * structural schema and `validateManifest` in scripts/v2/deploy-schema.mjs its semantic check), and the rules are the
 * backend loader's on main, rule for rule (backend/v2_manifest.py `checked_manifest` and `checked_deployment`).
 * #302 writes one manifest per chain at `docs/deployments/v2-<slug>-<chainId>-<date>/deployment.json`.
 *
 * What a manifest is held to before any address in it reaches a money client:
 *
 * `checkV2Manifest` (this file; backend `checked_manifest` without the two rules that need a hash function):
 *   - exact keys at every level: the 18 top keys, `chain` {name, chainId, nativeCurrency}, `createx` {address,
 *     runtimeCodeHash, salts, guardedSalts}, `build` {the compiler profile, sourceTreeSha256, workingTreeSourceChanges,
 *     sourceHashes, chainProfileSha256}, each receipt and the verification record;
 *   - `schemaVersion` 1, `kind` domino-v2-deployment, `status` prepared or verified, `environment`
 *     public-chain-preparation, fork-rehearsal or local-test, any chain id only for local-test (else 4663, 8453, 42161);
 *     `sourceCommit` 40 lowercase hex, `releaseTag` [a-zA-Z0-9][a-zA-Z0-9._-]{0,100};
 *   - `contractNames` exactly the 13 (F0's eleven CREATE3 components and the two vault executors) and `policies` exactly
 *     MANIFEST_POLICIES (its fees are V2_FEES, its auto-exit windows V2_WINDOWS);
 *   - six roles, lowercase addresses, none a placeholder (below 2^16 or one repeated digit), operator ≠ publisher, none a
 *     component or CreateX;
 *   - `contracts` the 13, lowercase and distinct; `createx` the canonical CreateX and its code hash, a raw and a guarded
 *     salt for each of the 11 CREATE3 components, each raw salt `deployer ‖ 0x00 ‖ …` (the rest needs keccak, below);
 *   - the eleven dependencies, nonzero; a nonzero runtime code hash for each of the 13 contracts and 11 dependencies;
 *     two or more distinct charge currencies, ranks 1..255;
 *   - the fixed compiler profile, the source hashes' paths under src/v2/ or deploy-fixtures/, a 64-hex sourceTreeSha256;
 *   - verified: one distinct receipt for each of the 11 deployed components, each in a block ≥ 1, no zero hash, one hash
 *     per block; a verification record ('exact_precomputed_immutable_runtime', 'checked') at or after every receipt,
 *     agreeing with a receipt in its own block, `checkedAt` with a zone. Prepared: no receipts, `verification` null.
 *
 * finance/v2/deployment.ts `checkV2Prediction` (the backend's other two rules, which need keccak256 and SHA-256, so they
 * run where viem is allowed): every address is CreateX's deployCreate3 for `roles.deployer` (`predict()`), the salts
 * recorded are those, and `build.sourceTreeSha256` is sha256(canonical(sourceHashes)). `admitV2Contracts` runs it before
 * any address of a set reaches a money client.
 *
 * `checkV2Deployment` (backend `checked_deployment`): bound to the app's chain profile (api-contracts/v2/chains): the
 * chain id, and outside local-test its name and native symbol; the dependencies at the profile's addresses; the profile's
 * CreateX, and outside local-test its verified code hash, the dependencies' verified code hashes and the profile's charge
 * currencies; then the admission:
 *   - `production`: verified, environment public-chain-preparation, built from committed sources
 *     (`workingTreeSourceChanges` false), verified at the `finalized` tag, no role a key of the public test mnemonic.
 *     The ONLY admission of the pinned map (`parseV2Manifest`, `v2Availability`), in every build.
 *   - `fork-rehearsal` / `local-test`: verified, with that environment. Test admissions, through
 *     `parseV2FixtureManifest` only, which a deployable build refuses before reading (`manifest_fixture_refused`), and
 *     which a Vite build takes only with `__DOMINO_V2__` on (the v2-test build).
 *
 * Every refusal is one of MANIFEST_ERRORS. Nothing here falls back to another address: a chain without a pinned
 * manifest has no V2 there, and its screens say "Not available on {chain} yet" (spec §7.3 point 3).
 *
 * A Domino V2 address comes ONLY from a manifest in this file's map, compiled into the build from git and pinned by its
 * SHA-256 in tests/v2/manifest-pin.test.mjs. Never from an API reply, never from storage, never from the network.
 * Uniswap, Permit2 and tokens come from the chain profiles (./chains.ts) and are cross-checked here.
 *
 * Plain TypeScript with no viem and no wallet (tests/session.source-guard.test.mjs), so a screen may ask
 * `v2Availability` without reaching the wallet feature. The code each address holds is checked against
 * `runtimeCodeHashes` before the session's first write, in src/finance/v2/deployment.ts.
 */
import robinhoodProfile from '../../../api-contracts/v2/chains/robinhood-4663.json'
import baseProfile from '../../../api-contracts/v2/chains/base-8453.json'
import arbitrumProfile from '../../../api-contracts/v2/chains/arbitrum-42161.json'
import robinhood4663 from '../../../docs/deployments/v2-robinhood-4663-2026-10-04/deployment.json'
import base8453 from '../../../docs/deployments/v2-base-8453-2026-10-04/deployment.json'
import arbitrum42161 from '../../../docs/deployments/v2-arbitrum-42161-2026-10-04/deployment.json'
import { isV2ChainId, v2Chain, type V2Chain } from './chains'
import { V2_FIXTURE_SETS_TAKEN, V2_ON } from './flag'
import {
  V2_FEES,
  V2_WINDOWS,
  type Address,
  type Hex,
  type V2Admission,
  type V2ChainId,
  type V2CodeComponent,
  type V2Component,
  type V2Contracts,
  type V2DeployedComponent,
  type V2DeploymentFacts,
  type V2Environment,
  type V2ManifestContract,
} from './types'

// ---------------------------------------------------------------------------
// The format (#302), as backend/v2_manifest.py pins it
// ---------------------------------------------------------------------------

/** The `kind` of a deployment manifest. */
export const MANIFEST_KIND = 'domino-v2-deployment'
export const MANIFEST_SCHEMA_VERSION = 1
/** The backend's bound on a manifest file's bytes (checked on the pinned files by tests/v2/manifest-pin.test.mjs). */
export const MAX_MANIFEST_BYTES = 262144
/** CreateX, the same address and code on every V2 chain (docs/v2/DEPLOYMENT.md). */
export const CREATE_X: Address = '0xba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed'
export const CREATE_X_CODE_HASH: Hex = '0xbd8a7ea8cfca7b4e5f5041d7d4b17bc317c5ce42cfbc42066a00cf26b43eb53f'
/** keccak256 of CreateX's CREATE3 proxy init code (0x67363d3d37363d34f03d5260086018f3). */
export const CREATE3_PROXY_INITCODE_HASH: Hex = '0x21c35dbe1b344a2488cf3321d6ce542f8e9f305544ff09e4993a62319a497c1f'

/** The 13 Domino contracts of a deployment, by the manifest's own name, with their Solidity contract names. */
export const CONTRACT_NAMES: Readonly<Record<V2ManifestContract, string>> = Object.freeze({
  registry: 'DominoRegistry',
  priceAnchor: 'DominoPriceAnchor',
  autoExit: 'DominoAutoExit',
  vaultSwap: 'DominoV2VaultSwapModule',
  'vault.v3': 'DominoV2VaultV3',
  'vault.v4': 'DominoV2VaultV4',
  'vaultFactory.v3': 'DominoV2VaultFactory',
  'vaultFactory.v4': 'DominoV2VaultFactory',
  'zap.v4.steps': 'DominoZapV4Steps',
  'zap.v3': 'DominoZapV3',
  'zap.v4': 'DominoZapV4',
  'vaultExecutor.v3': 'DominoV2VaultExecutorV3',
  'vaultExecutor.v4': 'DominoV2VaultExecutorV4',
})
/** The 13, in the manifest's order. */
export const MANIFEST_CONTRACTS = Object.freeze(Object.keys(CONTRACT_NAMES)) as readonly V2ManifestContract[]
/** The eleven deployCreate3 components, in deployment order; each vault implementation creates its executor. */
export const DEPLOY_ORDER = Object.freeze(MANIFEST_CONTRACTS.filter((name) => !name.startsWith('vaultExecutor.'))) as readonly V2DeployedComponent[]

export const ROLE_NAMES = Object.freeze(['deployer', 'governance', 'guardian', 'feeRecipient', 'operator', 'publisher'] as const)
export type V2Role = (typeof ROLE_NAMES)[number]

/**
 * `policies`, exactly (spec §7.2, §7.3 point 5): the fees are the app's V2_FEES (65 / 35 / 200 / 400 / 20 bps), the
 * auto-exit's observation age and TWAP window the app's V2_WINDOWS (300 s / 600 s); the rest are #302's fixed values.
 */
export const MANIFEST_POLICIES = Object.freeze({
  assistedSwapFeeBps: V2_FEES.assistedSwapBps,
  bridgeAppFeeBps: V2_FEES.bridgeAppBps,
  simpleCompoundFeeBps: V2_FEES.automationSimpleBps,
  dominoCompoundFeeBps: V2_FEES.automationDominoBps,
  autoExitFeeBps: V2_FEES.autoExitBps,
  automationFeeBasis: 'consumed_original_earned_fees_once_not_principal',
  additionalAutomationSwapFeeBps: 0,
  timelockSeconds: 86400,
  minTwapSeconds: 60,
  autoExitMaxObservationAgeSeconds: V2_WINDOWS.v4ObservationMaxSeconds,
  autoExitMinTwapSeconds: V2_WINDOWS.v3TwapMinSeconds,
  minimumUniversalRouterVersion: 212,
  hookedPoolsAllowed: false,
})

/** The eleven dependencies a deployment is built against, each the chain profile's own. */
export const MANIFEST_DEPENDENCIES = Object.freeze(['v3Factory', 'v3PositionManager', 'v3Quoter', 'v3SwapRouter', 'v4PoolManager', 'v4PositionManager', 'v4StateView', 'v4Quoter', 'universalRouter', 'permit2', 'wrappedNative'] as const)
export type V2Dependency = (typeof MANIFEST_DEPENDENCIES)[number]

export const ENVIRONMENTS: readonly V2Environment[] = Object.freeze(['public-chain-preparation', 'local-test', 'fork-rehearsal'] as const)
/** The chains a manifest outside local-test may name. */
export const ENABLED_CHAINS: readonly number[] = Object.freeze([4663, 8453, 42161])
export const ADMISSIONS: readonly V2Admission[] = Object.freeze(['production', 'fork-rehearsal', 'local-test'] as const)
/** The compiler profile every V2 build uses. */
export const BUILD_PROFILE = Object.freeze({ version: '0.8.26+commit.8a97fa7a', optimizerRuns: 200, viaIR: true, evmVersion: 'cancun', bytecodeHash: 'none' })
export const TOP_LEVEL = Object.freeze(['schemaVersion', 'kind', 'status', 'environment', 'chain', 'sourceCommit', 'releaseTag', 'contractNames', 'contracts', 'dependencies', 'roles', 'policies', 'chargeCurrencies', 'runtimeCodeHashes', 'createx', 'build', 'deploymentReceipts', 'verification'] as const)
const RECEIPT_KEYS = ['transactionHash', 'blockNumber', 'blockHash', 'gasUsed', 'effectiveGasPrice'] as const
const VERIFICATION_KEYS = ['blockNumber', 'blockHash', 'blockTag', 'codeHashes', 'wiring', 'checkedAt'] as const

/**
 * The first ten accounts of the public test mnemonic ("test test ... junk"), whose keys every Anvil and Hardhat user
 * holds: never a production role (backend PUBLIC_TEST_ACCOUNTS, PR #302's review, item 2).
 */
export const PUBLIC_TEST_ACCOUNTS: readonly Address[] = Object.freeze([
  '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc', '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
  '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65', '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc',
  '0x976ea74026e726554db657fa54763abd0c3a0aa9', '0x14dc79964da2c08b23698b3d3cc7ca32193d9955',
  '0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f', '0xa0ee7a142d267c1f36714e4a8f75612f20a79720',
] as const)

/** The components the app calls (spec §7.2), by the app's name → the manifest's name. */
export const APP_COMPONENTS: Readonly<Record<V2Component, V2ManifestContract>> = Object.freeze({
  registry: 'registry',
  priceAnchor: 'priceAnchor',
  autoExit: 'autoExit',
  zapV3: 'zap.v3',
  zapV4: 'zap.v4',
  vaultFactoryV3: 'vaultFactory.v3',
  vaultFactoryV4: 'vaultFactory.v4',
})

/** Every contract whose code finance/v2/deployment.ts verifyV2Code can check, by the app's name → the manifest's. */
export const CODE_COMPONENTS: Readonly<Record<V2CodeComponent, V2ManifestContract>> = Object.freeze({
  ...APP_COMPONENTS,
  vaultSwap: 'vaultSwap',
  vaultV3: 'vault.v3',
  vaultV4: 'vault.v4',
  zapV4Steps: 'zap.v4.steps',
  vaultExecutorV3: 'vaultExecutor.v3',
  vaultExecutorV4: 'vaultExecutor.v4',
})

/** A manifest that passed checkV2Manifest, as the file holds it. */
export interface V2Manifest {
  readonly schemaVersion: 1
  readonly kind: typeof MANIFEST_KIND
  readonly status: 'prepared' | 'verified'
  readonly environment: V2Environment
  readonly chain: { readonly name: string; readonly chainId: number; readonly nativeCurrency: string }
  readonly sourceCommit: string
  readonly releaseTag: string
  readonly contractNames: Readonly<Record<V2ManifestContract, string>>
  readonly contracts: Readonly<Record<V2ManifestContract, Address>>
  readonly dependencies: Readonly<Record<V2Dependency, Address>>
  readonly roles: Readonly<Record<V2Role, Address>>
  readonly policies: typeof MANIFEST_POLICIES
  readonly chargeCurrencies: readonly { readonly token: Address; readonly rank: number }[]
  readonly runtimeCodeHashes: Readonly<Record<V2ManifestContract | V2Dependency, Hex>>
  readonly createx: {
    readonly address: Address
    readonly runtimeCodeHash: Hex
    readonly salts: Readonly<Record<V2DeployedComponent, Hex>>
    readonly guardedSalts: Readonly<Record<V2DeployedComponent, Hex>>
  }
  readonly build: typeof BUILD_PROFILE & {
    readonly sourceTreeSha256: string
    readonly workingTreeSourceChanges: boolean
    readonly sourceHashes: Readonly<Record<string, string>>
    readonly chainProfileSha256: string
  }
  readonly deploymentReceipts: Readonly<Partial<Record<V2DeployedComponent, V2Receipt>>>
  readonly verification: V2Verification | null
}
export interface V2Receipt {
  readonly transactionHash: Hex
  readonly blockNumber: number
  readonly blockHash: Hex
  readonly gasUsed: string
  readonly effectiveGasPrice: string
}
export interface V2Verification {
  readonly blockNumber: number
  readonly blockHash: Hex
  readonly blockTag: string
  readonly codeHashes: 'exact_precomputed_immutable_runtime'
  readonly wiring: 'checked'
  readonly checkedAt: string
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * The closed set of refusals: #302's validateManifest codes where it has one (the backend says `v2_deployment_invalid`
 * for all of them), then the backend's binding and admission refusals, then the app's own gate.
 */
export const MANIFEST_ERRORS = [
  'manifest_fields_invalid',
  'manifest_identity_invalid',
  'manifest_chain_invalid',
  'manifest_environment_invalid',
  'manifest_chain_not_enabled',
  'manifest_source_invalid',
  'manifest_contracts_or_policy_changed',
  'manifest_roles_invalid',
  'manifest_role_placeholder',
  'manifest_operator_publisher_conflict',
  'manifest_addresses_invalid',
  'manifest_role_component_conflict',
  'manifest_createx_invalid',
  'manifest_createx_changed',
  'manifest_dependencies_invalid',
  'manifest_dependency_address_invalid',
  'manifest_codehash_keys_invalid',
  'manifest_codehash_invalid',
  'manifest_currencies_invalid',
  'manifest_build_invalid',
  'manifest_prepared_has_receipts',
  'manifest_receipts_incomplete',
  'manifest_receipt_invalid',
  'manifest_verification_invalid',
  // backend checked_deployment
  'manifest_chain_unsupported',
  'manifest_admission_invalid',
  'manifest_chain_mismatch',
  'manifest_dependency_mismatch',
  'manifest_not_executed',
  'manifest_not_admitted',
  // the app's gate on the test admissions
  'manifest_fixture_refused',
] as const
export type ManifestErrorCode = (typeof MANIFEST_ERRORS)[number]
/** A refusal: `message` and `code` are the code; `detail` says which field, for logs and tests (never shown). */
export type ManifestError = Error & { code: ManifestErrorCode; detail: string }

const fail = (code: ManifestErrorCode, detail: string): never => {
  throw Object.assign(new Error(code), { code, detail })
}
const ensure = (condition: boolean, code: ManifestErrorCode, detail: string): void => {
  if (!condition) fail(code, detail)
}

export const isManifestError = (error: unknown): error is ManifestError =>
  error instanceof Error && (MANIFEST_ERRORS as readonly string[]).includes((error as Partial<ManifestError>).code ?? '')

// Declared here, module-scoped, as src/finance/pin.ts does and for the same reason: a compile that Vite never touched
// (the CommonJS test build, a backend harness) sees no ambient declaration and answers "not a deployable build". Vite
// replaces the identifier with the mode row's literal (vite.config.ts MODES).
declare const __DOMINO_DEPLOYABLE__: boolean | undefined
// Changed on purpose (data) 2026-10-02 (Domino V2 integration, the preview-v2 build): preview-v2 is the real site for V1
// (`__DOMINO_DEPLOYABLE__` true there) yet takes fixture sets up to a review (V2_FIXTURE_SETS_TAKEN, ./flag.ts): their
// sends and signatures are refused by src/finance/v2/liveLock.ts instead. The deployable builds refuse them here, as before.
const DEPLOYABLE: boolean = typeof __DOMINO_DEPLOYABLE__ === 'boolean' && __DOMINO_DEPLOYABLE__ && !V2_FIXTURE_SETS_TAKEN
/**
 * Whether this build may take a manifest under a TEST admission (fork-rehearsal, local-test): never a deployable build;
 * of the Vite builds, only the one that carries V2 (v2-test: `__DOMINO_V2__` on, not deployable); and the node test
 * build, which no Vite define reaches.
 */
const TEST_ADMISSIONS: boolean = !DEPLOYABLE && (typeof __DOMINO_DEPLOYABLE__ !== 'boolean' || V2_ON)

// ---------------------------------------------------------------------------
// Field readers, as backend/v2_manifest.py reads them
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const HEX64 = /^[0-9a-f]{64}$/
const DECIMAL = /^(?:0|[1-9][0-9]*)$/
const COMMIT = /^[0-9a-f]{40}$/
const RELEASE_TAG = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/
const ZERO = /^0x0+$/
const REPEATED_DIGIT = /^0x([0-9a-f])\1{39}$/
/** A string whose UTF-16 is well formed (the backend's canonical() refuses a lone surrogate, which JavaScript would escape). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const isAddress = (value: unknown): value is Address => typeof value === 'string' && ADDRESS.test(value)
const isHash = (value: unknown): value is Hex => typeof value === 'string' && HASH.test(value)
/** A JSON integer the way `Number.isSafeInteger(x) && x >= 0` sees it. */
const isInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const isZero = (value: string): boolean => ZERO.test(value)

/** `_keys`: an object whose keys are exactly `expected`, no more and no fewer. */
function exactKeys(value: unknown, expected: readonly string[], code: ManifestErrorCode, where: string): Json {
  if (!isObject(value)) return fail(code, where)
  const keys = Object.keys(value).sort()
  const want = [...expected].sort()
  ensure(keys.length === want.length && keys.every((key, index) => key === want[index]), code, where)
  return value
}

/**
 * deploy.mjs `canonical`: JSON.stringify with every object's keys sorted (by UTF-16 code unit, as Array#sort does and
 * as the backend's canonical() sorts them). finance/v2/deployment.ts hashes `build.sourceHashes` with it.
 */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    (isObject(entry) ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])) : entry))
}

/**
 * `checkedAt`: an ISO 8601 time WITH its zone (deploy.mjs writes toISOString's `Z`; the backend's datetime.fromisoformat
 * refuses a time without one). The app reads the extended calendar form: YYYY-MM-DD, `T` or a space, hh[:mm[:ss[.,f]]],
 * then `Z` or ±hh[:mm[:ss]]. Python also reads the basic (20261002T142432Z) and week-date (2026-W40-5) forms, which
 * #302 never writes: the app refuses those (closed: V2 stays off on that chain).
 */
const CHECKED_AT = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2})(?::(\d{2})(?::(\d{2})(?:[.,]\d+)?)?)?(?:Z|[+-](\d{2})(?::?(\d{2})(?::?(\d{2})(?:\.\d+)?)?)?)$/
function zonedTime(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const match = CHECKED_AT.exec(value)
  if (!match) return false
  const [, y, mo, d, h, mi, s, oh, om, os] = match
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days && Number(h) <= 23 && Number(mi ?? 0) <= 59 && Number(s ?? 0) <= 59
    && Number(oh ?? 0) <= 23 && Number(om ?? 0) <= 59 && Number(os ?? 0) <= 59
}

// ---------------------------------------------------------------------------
// checked_manifest
// ---------------------------------------------------------------------------

/**
 * The backend's `checked_manifest` (and #302's validateManifest plus the structural schema), every rule but the two that
 * need a hash function: the CREATE3 prediction of `contracts` and the salts, and `build.sourceTreeSha256`, which
 * finance/v2/deployment.ts `checkV2Prediction` checks. Throws a ManifestError; returns the manifest as given.
 */
export function checkV2Manifest(raw: unknown): V2Manifest {
  const m = exactKeys(raw, TOP_LEVEL, 'manifest_fields_invalid', 'manifest')
  ensure(m.schemaVersion === MANIFEST_SCHEMA_VERSION && m.kind === MANIFEST_KIND && (m.status === 'prepared' || m.status === 'verified'), 'manifest_identity_invalid', 'schemaVersion, kind, status')

  const chain = exactKeys(m.chain, ['name', 'chainId', 'nativeCurrency'], 'manifest_chain_invalid', 'chain')
  ensure(isInteger(chain.chainId) && chain.chainId > 0 && typeof chain.name === 'string' && chain.name !== ''
    && typeof chain.nativeCurrency === 'string' && chain.nativeCurrency !== '', 'manifest_chain_invalid', 'chain')
  ensure((ENVIRONMENTS as readonly unknown[]).includes(m.environment), 'manifest_environment_invalid', 'environment')
  ensure(m.environment === 'local-test' || ENABLED_CHAINS.includes(chain.chainId as number), 'manifest_chain_not_enabled', `chain.chainId ${String(chain.chainId)}`)
  ensure(typeof m.sourceCommit === 'string' && COMMIT.test(m.sourceCommit) && typeof m.releaseTag === 'string' && RELEASE_TAG.test(m.releaseTag), 'manifest_source_invalid', 'sourceCommit, releaseTag')
  ensure(canonical(m.contractNames) === canonical(CONTRACT_NAMES), 'manifest_contracts_or_policy_changed', 'contractNames')
  ensure(canonical(m.policies) === canonical(MANIFEST_POLICIES), 'manifest_contracts_or_policy_changed', 'policies')

  // Roles (deploy.mjs validateRoles on lower-case addresses).
  const roles = exactKeys(m.roles, ROLE_NAMES, 'manifest_roles_invalid', 'roles')
  for (const name of ROLE_NAMES) {
    const value = roles[name]
    ensure(isAddress(value), 'manifest_roles_invalid', `roles.${name}`)
    ensure(BigInt(value as string) >= 65536n && !REPEATED_DIGIT.test(value as string), 'manifest_role_placeholder', `roles.${name}`)
  }
  ensure(roles.operator !== roles.publisher, 'manifest_operator_publisher_conflict', 'roles.operator, roles.publisher')

  // Contracts: the 13, well formed and distinct. That each is the CREATE3 prediction for roles.deployer is
  // finance/v2/deployment.ts checkV2Prediction's (it needs keccak256).
  const contracts = exactKeys(m.contracts, MANIFEST_CONTRACTS, 'manifest_addresses_invalid', 'contracts')
  for (const name of MANIFEST_CONTRACTS) ensure(isAddress(contracts[name]) && !isZero(contracts[name] as string), 'manifest_addresses_invalid', `contracts.${name}`)
  ensure(new Set(Object.values(contracts)).size === MANIFEST_CONTRACTS.length, 'manifest_addresses_invalid', 'contracts: two at one address')
  const components = new Set(Object.values(contracts))
  for (const name of ROLE_NAMES) ensure(!components.has(roles[name]) && roles[name] !== CREATE_X, 'manifest_role_component_conflict', `roles.${name}`)

  // CreateX: the canonical one, and a raw and a guarded salt per CREATE3 component. Each raw salt starts with the
  // deployer and the zero chain byte; the rest of it, and the guarded salt, are checkV2Prediction's.
  const createx = exactKeys(m.createx, ['address', 'runtimeCodeHash', 'salts', 'guardedSalts'], 'manifest_createx_invalid', 'createx')
  ensure(createx.address === CREATE_X && createx.runtimeCodeHash === CREATE_X_CODE_HASH, 'manifest_createx_changed', 'createx.address, createx.runtimeCodeHash')
  const salts = exactKeys(createx.salts, DEPLOY_ORDER, 'manifest_createx_changed', 'createx.salts')
  const guarded = exactKeys(createx.guardedSalts, DEPLOY_ORDER, 'manifest_createx_changed', 'createx.guardedSalts')
  for (const name of DEPLOY_ORDER) {
    ensure(isHash(salts[name]) && (salts[name] as string).startsWith(`${roles.deployer as string}00`), 'manifest_createx_changed', `createx.salts.${name}`)
    ensure(isHash(guarded[name]), 'manifest_createx_changed', `createx.guardedSalts.${name}`)
  }

  // Dependencies, code hashes, charge currencies.
  const dependencies = exactKeys(m.dependencies, MANIFEST_DEPENDENCIES, 'manifest_dependencies_invalid', 'dependencies')
  for (const name of MANIFEST_DEPENDENCIES) ensure(isAddress(dependencies[name]) && !isZero(dependencies[name] as string), 'manifest_dependency_address_invalid', `dependencies.${name}`)
  const codeHashes = exactKeys(m.runtimeCodeHashes, [...MANIFEST_CONTRACTS, ...MANIFEST_DEPENDENCIES], 'manifest_codehash_keys_invalid', 'runtimeCodeHashes')
  for (const [name, value] of Object.entries(codeHashes)) ensure(isHash(value) && !isZero(value), 'manifest_codehash_invalid', `runtimeCodeHashes.${name}`)
  const charge = m.chargeCurrencies
  ensure(Array.isArray(charge) && charge.length >= 2, 'manifest_currencies_invalid', 'chargeCurrencies')
  for (const [index, currency] of (charge as unknown[]).entries()) {
    const entry = exactKeys(currency, ['token', 'rank'], 'manifest_currencies_invalid', `chargeCurrencies[${index}]`)
    ensure(isAddress(entry.token) && typeof entry.rank === 'number' && Number.isInteger(entry.rank) && entry.rank > 0 && entry.rank < 256, 'manifest_currencies_invalid', `chargeCurrencies[${index}]`)
  }
  ensure(new Set((charge as Json[]).map((currency) => currency.token)).size === (charge as unknown[]).length, 'manifest_currencies_invalid', 'chargeCurrencies: a token twice')

  // The build: the fixed compiler profile and the source tree. sha256(canonical(sourceHashes)) is checkV2Prediction's.
  const build = exactKeys(m.build, [...Object.keys(BUILD_PROFILE), 'sourceTreeSha256', 'workingTreeSourceChanges', 'sourceHashes', 'chainProfileSha256'], 'manifest_build_invalid', 'build')
  for (const [key, value] of Object.entries(BUILD_PROFILE)) ensure(build[key] === value, 'manifest_build_invalid', `build.${key}`)
  ensure(typeof build.chainProfileSha256 === 'string' && HEX64.test(build.chainProfileSha256) && typeof build.workingTreeSourceChanges === 'boolean', 'manifest_build_invalid', 'build.chainProfileSha256, build.workingTreeSourceChanges')
  const sourceHashes = build.sourceHashes
  ensure(isObject(sourceHashes) && Object.keys(sourceHashes).length > 0, 'manifest_build_invalid', 'build.sourceHashes')
  for (const [path, value] of Object.entries(sourceHashes as Json)) {
    ensure((path.startsWith('src/v2/') || path.startsWith('deploy-fixtures/')) && !path.split('/').includes('..') && !LONE_SURROGATE.test(path)
      && typeof value === 'string' && HEX64.test(value), 'manifest_build_invalid', `build.sourceHashes.${path}`)
  }
  ensure(typeof build.sourceTreeSha256 === 'string' && HEX64.test(build.sourceTreeSha256), 'manifest_build_invalid', 'build.sourceTreeSha256')

  // Receipts and the verification record.
  const receipts = m.deploymentReceipts
  const verification = m.verification
  ensure(isObject(receipts), 'manifest_receipts_incomplete', 'deploymentReceipts')
  if (m.status === 'prepared') {
    ensure(verification === null && Object.keys(receipts as Json).length === 0, 'manifest_prepared_has_receipts', 'deploymentReceipts, verification')
    return raw as V2Manifest
  }
  exactKeys(receipts, DEPLOY_ORDER, 'manifest_receipts_incomplete', 'deploymentReceipts')
  const blocks = new Map<number, string>()
  for (const name of DEPLOY_ORDER) {
    const receipt = exactKeys((receipts as Json)[name], RECEIPT_KEYS, 'manifest_receipt_invalid', `deploymentReceipts.${name}`)
    ensure(isHash(receipt.transactionHash) && isHash(receipt.blockHash) && isInteger(receipt.blockNumber)
      && typeof receipt.gasUsed === 'string' && DECIMAL.test(receipt.gasUsed)
      && typeof receipt.effectiveGasPrice === 'string' && DECIMAL.test(receipt.effectiveGasPrice), 'manifest_receipt_invalid', `deploymentReceipts.${name}`)
    // No transaction is in the genesis block, no hash is zero, and a block has one hash.
    const block = receipt.blockNumber as number
    const hash = receipt.blockHash as string
    ensure(block >= 1 && !isZero(receipt.transactionHash as string) && !isZero(hash) && (blocks.get(block) ?? hash) === hash, 'manifest_receipt_invalid', `deploymentReceipts.${name}`)
    blocks.set(block, hash)
  }
  ensure(new Set(DEPLOY_ORDER.map((name) => ((receipts as Json)[name] as Json).transactionHash)).size === DEPLOY_ORDER.length, 'manifest_receipt_invalid', 'deploymentReceipts: one transaction twice')
  const record = exactKeys(verification, VERIFICATION_KEYS, 'manifest_verification_invalid', 'verification')
  ensure(isInteger(record.blockNumber) && isHash(record.blockHash) && typeof record.blockTag === 'string'
    && record.codeHashes === 'exact_precomputed_immutable_runtime' && record.wiring === 'checked', 'manifest_verification_invalid', 'verification')
  // Verified after the deployment, at a block whose hash the receipts agree with.
  const at = record.blockNumber as number
  const anchor = record.blockHash as string
  ensure(at >= Math.max(...blocks.keys()) && !isZero(anchor) && (blocks.get(at) ?? anchor) === anchor, 'manifest_verification_invalid', 'verification.blockNumber, verification.blockHash')
  ensure(zonedTime(record.checkedAt), 'manifest_verification_invalid', 'verification.checkedAt')
  return raw as V2Manifest
}

// ---------------------------------------------------------------------------
// checked_deployment: bound to the app's chain profile, then admitted
// ---------------------------------------------------------------------------

/** What the backend's ChainProfile gives checked_deployment, read from the same profile files ./chains.ts reads. */
interface ProfileBinding {
  readonly name: string
  readonly nativeSymbol: string
  /** deploy.mjs `dependencyMap`: the dependencies a deployment on this chain is built against, lower case. */
  readonly dependencies: Readonly<Record<V2Dependency, string>>
  readonly createx: string
  readonly createxCodeHash: string
  /** The code hash the profile's verification list recorded at each dependency's address; null if none, or absent. */
  readonly dependencyCodeHashes: Readonly<Record<V2Dependency, string | null>>
  /** The charge currencies in the profile's order, as deploy.mjs writes them into a manifest. */
  readonly chargeCurrencies: readonly { readonly token: string; readonly rank: number }[]
}

function bindingOf(profile: unknown): ProfileBinding {
  // A missing field reads as a value no manifest holds, so a broken profile refuses every manifest (never throws here).
  const at = (value: unknown, ...path: string[]): unknown => path.reduce<unknown>((node, key) => (isObject(node) ? node[key] : undefined), value)
  const lower = (value: unknown): string => (typeof value === 'string' ? value.toLowerCase() : '!')
  const dependencies: Record<V2Dependency, string> = {
    v3Factory: lower(at(profile, 'uniswap', 'v3', 'factory')),
    v3PositionManager: lower(at(profile, 'uniswap', 'v3', 'positionManager')),
    v3Quoter: lower(at(profile, 'uniswap', 'v3', 'quoterV2')),
    v3SwapRouter: lower(at(profile, 'uniswap', 'v3', 'swapRouter02')),
    v4PoolManager: lower(at(profile, 'uniswap', 'v4', 'poolManager')),
    v4PositionManager: lower(at(profile, 'uniswap', 'v4', 'positionManager')),
    v4StateView: lower(at(profile, 'uniswap', 'v4', 'stateView')),
    v4Quoter: lower(at(profile, 'uniswap', 'v4', 'quoter')),
    universalRouter: lower(at(profile, 'uniswap', 'universalRouter', 'address')),
    permit2: lower(at(profile, 'permit2')),
    wrappedNative: lower(at(profile, 'wrappedNative', 'address')),
  }
  const records = at(profile, 'verification', 'contracts')
  const verified = (address: string): string | null => {
    const found = Array.isArray(records) ? records.filter((record) => isObject(record) && lower(record.address) === address) : []
    const hash = found.length === 1 ? (found[0] as Json).codehash : null
    return typeof hash === 'string' && HASH.test(hash) ? hash : null
  }
  const charge = at(profile, 'chargeCurrencies')
  const name = at(profile, 'name')
  const nativeSymbol = at(profile, 'nativeSymbol')
  const createxCodeHash = at(profile, 'deployer', 'codehash')
  return Object.freeze({
    name: typeof name === 'string' ? name : '!',
    nativeSymbol: typeof nativeSymbol === 'string' ? nativeSymbol : '!',
    dependencies: Object.freeze(dependencies),
    createx: lower(at(profile, 'deployer', 'address')),
    createxCodeHash: typeof createxCodeHash === 'string' ? createxCodeHash : '!',
    dependencyCodeHashes: Object.freeze(Object.fromEntries(MANIFEST_DEPENDENCIES.map((key) => [key, verified(dependencies[key])])) as Record<V2Dependency, string | null>),
    chargeCurrencies: Object.freeze(Array.isArray(charge) ? charge.map((c: unknown) => ({ token: lower(at(c, 'address')), rank: at(c, 'rank') as number })) : []),
  })
}

const BINDINGS: Readonly<Record<V2ChainId, ProfileBinding>> = Object.freeze({
  4663: bindingOf(robinhoodProfile),
  8453: bindingOf(baseProfile),
  42161: bindingOf(arbitrumProfile),
})

/**
 * The facts a set carries from its manifest, for finance/v2/deployment.ts's keccak checks and the other contracts.
 * Exported for the tests (checkV2Manifest, then finance/v2/deployment.ts checkV2Prediction of these, is the backend's
 * whole `checked_manifest`); the app reaches it through the parsers below only.
 */
export function manifestFacts(m: V2Manifest, admission: V2Admission): V2DeploymentFacts {
  const pick = <K extends string, V>(source: Readonly<Record<string, V>>, keys: readonly K[]) =>
    Object.freeze(Object.fromEntries(keys.map((key) => [key, source[key]]))) as Readonly<Record<K, V>>
  return Object.freeze({
    environment: m.environment,
    admission,
    releaseTag: m.releaseTag,
    sourceCommit: m.sourceCommit,
    deployer: m.roles.deployer,
    createx: m.createx.address,
    contracts: pick(m.contracts, MANIFEST_CONTRACTS),
    codeHashes: pick(m.runtimeCodeHashes, MANIFEST_CONTRACTS),
    salts: pick(m.createx.salts, DEPLOY_ORDER),
    guardedSalts: pick(m.createx.guardedSalts, DEPLOY_ORDER),
    sourceHashes: Object.freeze({ ...m.build.sourceHashes }),
    sourceTreeSha256: m.build.sourceTreeSha256,
  })
}

/**
 * The backend's `checked_deployment`: the manifest checked, bound to the app's profile of `chainId`, and admitted for
 * `admission`; then the V2 contracts the app uses there (addresses lowercase), with the manifest's facts in
 * `deployment`. Throws a ManifestError. The test admissions go through parseV2FixtureManifest, never here directly.
 */
function checkV2Deployment(raw: unknown, chainId: number, admission: V2Admission): V2Contracts {
  ensure((ADMISSIONS as readonly unknown[]).includes(admission), 'manifest_admission_invalid', String(admission))
  if (!isV2ChainId(chainId)) return fail('manifest_chain_unsupported', String(chainId))
  const m = checkV2Manifest(raw)
  const chain: V2Chain = v2Chain(chainId)
  const profile = BINDINGS[chainId]
  const local = m.environment === 'local-test'
  ensure(m.chain.chainId === chain.chainId, 'manifest_chain_mismatch', `chain.chainId ${m.chain.chainId}, asked ${chainId}`)
  ensure(local || (m.chain.name === profile.name && m.chain.nativeCurrency === profile.nativeSymbol), 'manifest_chain_mismatch', `chain.name ${m.chain.name}, chain.nativeCurrency ${m.chain.nativeCurrency}`)
  // The deployment went through the profile's CreateX, and outside a local test its verified code.
  ensure(canonical(m.dependencies) === canonical(profile.dependencies), 'manifest_dependency_mismatch', 'dependencies')
  ensure(profile.createx === CREATE_X && (local || profile.createxCodeHash === CREATE_X_CODE_HASH), 'manifest_dependency_mismatch', 'the profile\'s CreateX')
  if (!local) {
    for (const name of MANIFEST_DEPENDENCIES) ensure(m.runtimeCodeHashes[name] === profile.dependencyCodeHashes[name], 'manifest_dependency_mismatch', `runtimeCodeHashes.${name}`)
    ensure(canonical(m.chargeCurrencies) === canonical(profile.chargeCurrencies), 'manifest_dependency_mismatch', 'chargeCurrencies')
  }
  ensure(m.status === 'verified', 'manifest_not_executed', 'status')
  const refused = {
    production: m.environment !== 'public-chain-preparation' || m.build.workingTreeSourceChanges
      || m.verification?.blockTag !== 'finalized' || ROLE_NAMES.some((name) => PUBLIC_TEST_ACCOUNTS.includes(m.roles[name])),
    'fork-rehearsal': m.environment !== 'fork-rehearsal',
    'local-test': !local,
  }[admission]
  ensure(!refused, 'manifest_not_admitted', `${admission}: environment ${m.environment}`)

  const app = Object.entries(APP_COMPONENTS) as [V2Component, V2ManifestContract][]
  return Object.freeze({
    chainId,
    addresses: Object.freeze(Object.fromEntries(app.map(([name, key]) => [name, m.contracts[key]])) as Record<V2Component, Address>),
    codeHashes: Object.freeze(Object.fromEntries(app.map(([name, key]) => [name, m.runtimeCodeHashes[key]])) as Record<V2Component, Hex>),
    fixture: admission !== 'production',
    deployment: manifestFacts(m, admission),
  })
}

/**
 * A deployment manifest for the chain it is asked for, under the PRODUCTION admission, in every build: the V2 contracts
 * the app may use there, addresses lowercase, `fixture: false`. Throws a ManifestError otherwise. Its callers are
 * v2Availability, with the pinned map below, and the tests: a manifest handed in from anywhere else (an API reply,
 * storage) is not a pinned one, however well it parses.
 */
export function parseV2Manifest(raw: unknown, chainId: number): V2Contracts {
  return checkV2Deployment(raw, chainId, 'production')
}

/**
 * The same checks under a TEST admission (`fork-rehearsal` or `local-test`; src/v2/manifestFixtures.ts is the app's
 * caller). Refused outright, before the manifest is read, by a deployable build and by any Vite build without V2
 * (`manifest_fixture_refused`). Yields `fixture: true`, which never enables a real financial operation.
 */
export function parseV2FixtureManifest(raw: unknown, chainId: number, admission: 'fork-rehearsal' | 'local-test'): V2Contracts {
  if (!TEST_ADMISSIONS) return fail('manifest_fixture_refused', 'a deployable build takes production manifests only')
  ensure(admission === 'fork-rehearsal' || admission === 'local-test', 'manifest_admission_invalid', String(admission))
  return checkV2Deployment(raw, chainId, admission)
}

// ---------------------------------------------------------------------------
// The deployable map
// ---------------------------------------------------------------------------

/** Where a pinned manifest lives in the repository and the SHA-256 of its exact bytes (LF line endings). */
export interface ManifestPin {
  readonly path: string
  readonly sha256: string
}

/*
 * chainId → that chain's deployment manifest, imported at build time from git, and chainId → its SHA-256 pin.
 * Changed on purpose 2026-10-04 (V2 deployed, #327): Robinhood, Base and Arbitrum, the verified manifests of release
 * v2-release-2026-10-04 (source 559c509f), the same 13 addresses on all three (CREATE3).
 *
 * When #301 publishes a chain's manifest (one chain, one reviewed commit; production admission only: verified,
 * public-chain-preparation, committed sources, `finalized`, real roles):
 *   1. Import the file by a RELATIVE path, so the CommonJS test build resolves it too (never an alias, never a fetch):
 *        import base8453 from '../../../docs/deployments/v2-base-8453-<date>/deployment.json'
 *   2. Add it to V2_DEPLOYMENTS:   8453: base8453,
 *   3. Add its pin to V2_MANIFEST_PINS, the SHA-256 of the file's exact bytes (`sha256sum` of the committed file):
 *        8453: { path: 'docs/deployments/v2-base-8453-<date>/deployment.json', sha256: '<64 hex>' },
 *   4. Run `node scripts/test.mjs`: tests/v2/manifest-pin.test.mjs hashes the file against its pin, checks it is its own
 *      canonical JSON (no duplicate key) and within MAX_MANIFEST_BYTES, parses it for its own chain under the production
 *      admission, runs finance/v2/deployment.ts checkV2Prediction (CREATE3 and the source tree), and checks every
 *      deployed chain shows the same addresses (CREATE3).
 * The money clients run the prediction again before taking the set and check each component's runtime code on chain
 * before the session's first write (src/finance/v2/deployment.ts), and a feature is switched on per chain only with its
 * backend capability (spec §1.1).
 */
export const V2_DEPLOYMENTS: Readonly<Partial<Record<V2ChainId, unknown>>> = Object.freeze({
  4663: robinhood4663,
  8453: base8453,
  42161: arbitrum42161,
})
export const V2_MANIFEST_PINS: Readonly<Partial<Record<V2ChainId, ManifestPin>>> = Object.freeze({
  4663: { path: 'docs/deployments/v2-robinhood-4663-2026-10-04/deployment.json', sha256: '3f07f48cac98b8bc61851736a3332ac4b972069bb7b57401c816bfbcfd6e0f0d' },
  8453: { path: 'docs/deployments/v2-base-8453-2026-10-04/deployment.json', sha256: '48c409dfd5b0c25a85ce71f61b795a716fbe9e0615aa24e50f4fe3ef99f07b56' },
  42161: { path: 'docs/deployments/v2-arbitrum-42161-2026-10-04/deployment.json', sha256: '0ed3a7965bd4d56dff66ef1012ea8a84b2473d902506b0664baf90f7e0bef39d' },
})

export type V2Availability =
  | { readonly available: false; readonly copy: string; readonly reason: 'not_deployed' | ManifestErrorCode }
  | { readonly available: true; readonly contracts: V2Contracts }

/** "Not available on {chain} yet" (spec §7.3 point 3). */
export const notAvailableCopy = (chain: V2Chain): string => `Not available on ${chain.name} yet`

/** Whether V2 is on for a chain: only with a pinned manifest that passes every check, and then its contracts. */
export function v2Availability(chainId: V2ChainId): V2Availability {
  return availabilityOf(chainId, V2_DEPLOYMENTS[chainId])
}

/**
 * The same answer for a given manifest, under the production admission. Only v2Availability (with the pinned map) and
 * the tests call it. A manifest that fails a check leaves V2 off on that chain, with the same copy; it never throws past
 * here.
 */
export function availabilityOf(chainId: V2ChainId, manifest: unknown): V2Availability {
  const chain = v2Chain(chainId)
  if (manifest === undefined) return Object.freeze({ available: false, copy: notAvailableCopy(chain), reason: 'not_deployed' })
  try {
    return Object.freeze({ available: true, contracts: parseV2Manifest(manifest, chainId) })
  } catch (error) {
    if (!isManifestError(error)) throw error
    return Object.freeze({ available: false, copy: notAvailableCopy(chain), reason: error.code })
  }
}
