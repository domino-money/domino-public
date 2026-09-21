/**
 * The bound on a person's slippage tolerance, and how that tolerance is
 * written, beside the SDK that enforces it.
 *
 * lib/create/slippage.ts declares the same two ends and the same formatter,
 * and this is a second declaration on purpose, boxed in from both sides:
 *
 *   - setup.ts may not import OUT of src/finance, because
 *     backend/tests/test_setup_sdk_evm.py compiles it alone with
 *     `--rootDir app/src/finance` to check the SDK against DominoSetup.sol,
 *     and anything outside stops that compile at TS6059 before it checks
 *     anything at all. tests/build-guard.test.mjs runs the same compile so it
 *     is caught here rather than in a suite we do not own.
 *   - lib/create may not import INTO src/finance either: finance/ is the
 *     wallet feature, and a build with the wallet flag off must not reach it
 *     (tests/session.source-guard.test.mjs).
 *
 * So the two cannot share a module in either direction. They are pinned to
 * each other instead, in tests/create-journey.test.mjs, which compares both
 * ends and the written form across the whole range.
 *
 * The bound is the product's own, 0.1% to 5%, and the backend's request
 * models check the same numbers (backend/onboarding_models.py, `Slippage`).
 * The provider adapters admit 0 to 9999 behind them; that is not a limit a
 * person is offered.
 */

/** The ends of the choice, in basis points: 0.1% to 5%, both included. */
export const SLIPPAGE_MIN_BPS = 10
export const SLIPPAGE_MAX_BPS = 500

/**
 * A whole number of basis points as its percentage, without the sign: 50 is
 * "0.5", 500 is "5". Basis points are hundredths of a percent, so this is the
 * decimal point moved two places, never a division a float could round.
 */
export function slippagePercent(bps: number): string {
  const fraction = String(bps % 100).padStart(2, '0').replace(/0+$/, '')
  return fraction === '' ? String(Math.trunc(bps / 100)) : `${Math.trunc(bps / 100)}.${fraction}`
}

/** The same percentage as it is written on screen: 50 is "0.5%". */
export const slippageWritten = (bps: number): string => `${slippagePercent(bps)}%`
