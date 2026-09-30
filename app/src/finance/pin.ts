/**
 * The contract identities this BUILD trusts, shipped from git.
 *
 * Every deployment record the app receives — from the release Worker, or from
 * the saved recovery profile in localStorage — is then checked against the
 * chain. That check proves the record is SELF-CONSISTENT. It cannot prove the
 * record is ours, because every address it compares comes from the record
 * itself: a substituted factory answers its own `implementation()`, its own
 * code hash, its own `predictVault()`, and every clause passes.
 *
 * What that buys an attacker who can alter the reply — a browser extension
 * with host permission, an on-path interceptor, or a planted localStorage
 * entry for the recovery path — is the spender of a real ERC-721 approval over
 * a real Uniswap v4 position. The person is shown "the predicted sequence" and
 * signs their NFT away to an address the attacker chose. The position is lost,
 * principal and all.
 *
 * So one anchor must come from outside the record. Pinning the FACTORY is
 * enough: `verify()` already reads `implementation`, `positionManager`,
 * `poolManager`, `stateView` and `serviceFeeRecipient` back off the factory,
 * and chains the engine, read helper, routing helper and price guard off the
 * implementation. A genuine factory forces all of them, and `sequenceIdentity`
 * derives the vault address from factory and implementation — so the address a
 * person approves becomes the real one.
 *
 * The deposit lane has pinned its two addresses since it was written
 * (`app/src/deposit/present.ts`). This is the same idea for the setup and
 * sequence lanes.
 *
 * ## What is pinned
 *
 * Domino V1 on Robinhood Chain mainnet (chain 4663): the seven contracts
 * rugged deployed on 2026-09-21 and verified at a finalized block, frozen at
 * tag `v1-release-2026-09-21` (source commit 3384424). The addresses below
 * are the ones the release profiles under
 * `docs/deployments/v1-robinhood-mainnet-2026-09-21/` name, and the handoff
 * (`docs/V1_MAINNET_FRONTEND_HANDOFF_0XDECIMAL.md`, §4.1) is the instruction
 * to commit them. "V1" is the public name; the implementation still answers
 * `implementationVersion() == 4`, which `verify()` in sequence.ts insists on.
 *
 * `SEQUENCE_FACTORY` anchors every sequence record: the factory it names must
 * be this one, and every other sequence identity is read back off it on chain.
 * `SETUP_CONTRACT` anchors every setup record: the contract the setup lane
 * approves tokens to must be this one. A record naming any other address is
 * refused with `deployment_identity_unpinned` before a client is built from it.
 *
 * Committing these removed the build-side refusal — in git, reviewed, part of
 * a build, never a value that arrives over the network. The wallet paths
 * still open only when the release Worker serves an admitted profile
 * (available: true), which is a deployment act outside git. A different
 * address is a different commit, for the same reason. What the pins
 * do NOT say is whether the service can operate a particular sequence:
 * that takes an owner-bound live readiness check. Nothing here may be read
 * as permission to activate or as a promise of execution.
 */

/**
 * Lowercase 0x address. `null` stays in the type: a lane without one refuses
 * every record rather than passing.
 */
type Pin = `0x${string}` | null

/**
 * `DominoVaultFactoryV1`. Every other sequence identity anchors to it, so this
 * is the only one that has to be pinned. Not the implementation, which is the
 * clone template (`DominoVaultV1`): `verify()` reads that back off the factory.
 */
export const SEQUENCE_FACTORY: Pin = '0x16bf6eaba7b31118627b277e97249720dfe1c7ff'

/** `DominoSetupV1`, the contract the setup lane approves tokens to. */
export const SETUP_CONTRACT: Pin = '0x676f449fcfcd0f5ce4c7a1db2d98c7d6565dd37a'

/**
 * Uniswap v4 on Robinhood Chain, already pinned by the deposit lane and
 * repeated here so both records can be anchored to it as well. A record naming
 * a different position manager is not describing this chain's Uniswap.
 */
export const POSITION_MANAGER = '0x58daec3116aae6d93017baaea7749052e8a04fa7'

/**
 * Uniswap's V4Quoter on Robinhood Chain, and the keccak256 of its runtime
 * code (6,118 bytes, read 2026-09-23). Create position asks it, through the
 * wallet and before anything is approved or deposited, whether the pool can
 * swap part of a one-token deposit (finance/setup.ts quotePool). It is not in
 * the setup release record, so it is anchored here, in git: the code embeds
 * the PoolManager it quotes against as an immutable, so this hash names this
 * chain's deployment, and the client also reads poolManager() back against
 * the verified release. A redeployed quoter is a new commit, never a silent
 * pass: a different hash refuses the check, and a one-token deposit with it.
 */
export const V4_QUOTER = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94'
export const V4_QUOTER_CODE_HASH = '0xd707b1da8cb165e5ea35a3b4450d971eb562ec171e23492aa117036b78a868f6'

/** Owner-requested routed swaps only; these are never selected by a quote. */
export const ROUTE_PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
export const UNIVERSAL_ROUTER = '0x204faca1764b154221e35c0d20abb3c525710498'
export const ROUTE_FEE_RECIPIENT = '0x1488c84dafc03f7f4c4fb986f83ba99fd530c6f4'

/**
 * Uniswap v4's StateView on the same chain, the one the published setup
 * profile names beside the position manager. The owner's own position actions
 * (./position.ts) read prices, liquidity and fee growth from it directly,
 * with no profile in between, so the address is shipped here rather than
 * taken from any reply.
 */
export const STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'

/**
 * Only a DEPLOYABLE build insists on the pin.
 *
 * `__DOMINO_DEPLOYABLE__` is a Vite `define`, written from the mode's own row
 * (`vite.config.ts` MODES, one `define` for every mode, no condition), so a
 * dist always carries the literal `true` or `false` — never nothing. A dist
 * written in a test mode is refused before it can be uploaded, and the
 * deployable modes carry no test hooks; `tests/build-guard.test.mjs` proves
 * both, and that the define is still written for every mode.
 *
 * So the question this asks is "is this a build that says it is deployable",
 * and a compile Vite never touched answers no. That matters because four
 * harnesses compile these SDKs outside Vite and hand them a contract deployed
 * seconds earlier on a throwaway fork: rugged's two backend suites, his
 * release tooling, and our own `.test-build`. Their job is the SDK's encoding
 * against the contract, at addresses no constant in git could name.
 *
 * An earlier version defaulted to TRUE when the define was absent, reasoning
 * that anything outside Vite should fail closed too. It cost nothing to an
 * attacker — nothing outside a build reaches a person's wallet — and broke
 * every one of those four, which are a real safety net. A test that wants the
 * deployable behaviour says so, as tests/performance.controller.test.mjs does.
 */
// Declared here, module-scoped, and not taken from src/build-flags.d.ts.
// backend/tests/test_setup_sdk_evm.py and test_sequence_sdk_evm.py compile
// setup.ts and sequence.ts ALONE with tsc, to check the SDK against the
// contract; that compile sees no ambient declarations, so relying on the
// global one broke rugged's backend suite from a file of ours. Vite replaces
// the identifier either way.
declare const __DOMINO_DEPLOYABLE__: boolean | undefined
const REQUIRED: boolean = typeof __DOMINO_DEPLOYABLE__ === 'boolean' && __DOMINO_DEPLOYABLE__

/**
 * True when a deployable build has no pin for an identity, so a caller can say
 * why it refused. Both pins above are set, so a published build never sees
 * this; it stays so a lane added without an address refuses by name
 * (`deployment_not_pinned`) rather than passing.
 */
export const unpinned = (pin: Pin): boolean => REQUIRED && pin === null

/**
 * Whether a record's address is the pinned one. In a deployable build an
 * absent pin refuses: a record that cannot be anchored may not reach a wallet.
 */
export function pinned(pin: Pin, value: unknown): boolean {
  if (typeof value !== 'string') return false
  if (!REQUIRED) return true
  return typeof pin === 'string' && value.toLowerCase() === pin
}
