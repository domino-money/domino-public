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
 * (`app/src/deposit/present.ts`). This is the same idea for the two lanes that
 * did not have it.
 *
 * ## Why these are null
 *
 * rugged has not published the V4 contracts yet. There is no address to pin,
 * and a pin that does not exist must not be treated as a pin that passed: a
 * null here REFUSES every deployment record, so the wallet paths fail closed
 * until the real addresses are committed.
 *
 * That is deliberate. On the day the contracts are deployed, filling these in
 * is the switch that turns the wallet paths on — in git, reviewed, and part of
 * a build, rather than a value that arrives over the network.
 */

/** Lowercase 0x address, or null while the contracts are unpublished. */
type Pin = `0x${string}` | null

/**
 * `DominoVaultFactoryV4`. Every other sequence identity anchors to it, so this
 * is the only one that has to be pinned.
 */
export const SEQUENCE_FACTORY: Pin = null

/** `DominoSetup`, the contract the setup lane approves tokens to. */
export const SETUP_CONTRACT: Pin = null

/**
 * Uniswap v4 on Robinhood Chain, already pinned by the deposit lane and
 * repeated here so both records can be anchored to it as well. A record naming
 * a different position manager is not describing this chain's Uniswap.
 */
export const POSITION_MANAGER = '0x58daec3116aae6d93017baaea7749052e8a04fa7'

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

/** True while a deployable build has no pin for an identity, so a caller can say why it refused. */
export const unpinned = (pin: Pin): boolean => REQUIRED && pin === null

/**
 * Whether a record's address is the pinned one. In a deployable build an
 * absent pin refuses: an unpublished contract cannot be verified, and a record
 * that cannot be verified may not reach a wallet.
 */
export function pinned(pin: Pin, value: unknown): boolean {
  if (typeof value !== 'string') return false
  if (!REQUIRED) return true
  return typeof pin === 'string' && value.toLowerCase() === pin
}
