/**
 * Set by vite.config.ts from the build mode, never from the environment.
 *
 * Comparisons with these constants are folded at build time, so a branch
 * another mode needs, and every module only that branch imports, is absent
 * from a bundle that cannot reach it. The deployable modes (production and
 * development, the two that write to dist) read live through the same-origin
 * bridge from the reviewed pool selection and render no build banner.
 */
declare const __DOMINO_READ_MODE__: 'fixture' | 'bridge'
/** True for the modes that write to dist, which is what gets deployed. */
declare const __DOMINO_DEPLOYABLE__: boolean
/** The pools the bridge reads: the reviewed selection, or the package fixture pool a local stub serves. */
declare const __DOMINO_POOL_SET__: 'selected' | 'fixture'
/**
 * Wallet sign-in: EIP-6963 discovery and a SIWE session against session-v1.
 * True in the deployable modes and in wallet-test; the feature is one lazy
 * chunk, so a build without it emits no wallet code at all.
 */
declare const __DOMINO_WALLET_SESSION__: boolean
/**
 * The probes the wallet browser tests drive. True in wallet-test only: a
 * deployable build folds this to false, and scripts/deploy-markers.mjs
 * refuses any bundle that still names it.
 */
declare const __DOMINO_TEST_HOOKS__: boolean
declare const __DOMINO_LOCAL_LIVE__: boolean
