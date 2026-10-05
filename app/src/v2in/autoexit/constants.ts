/**
 * The owner's decisions for auto-exit (spec F7 rev2 §4.1, §4.4, §4.9, §9: decisions #18, #19, #24, #28 of 2 October),
 * each ONE named constant marked with its decision, and the validity, which no decision sets (still the conservative
 * choice). The client (finance/v2/autoExit.ts mandateProblems) holds every term to spec §4.2 either way.
 *
 * Domino V2 integration (2026-10-02): the logic of src/v2ui/autoExit/constants.ts, copied for the integrated screens.
 */

/** Decision #19 (§4.4): the default slippage, on top of the pool's fee: 1% (100 bps). */
export const AUTO_EXIT_DEFAULT_SLIPPAGE_BPS = 100

/** Decision #19 (§4.4): the slippage shortcuts, 0.5%, 1% and 2%. */
export const AUTO_EXIT_SLIPPAGE_SHORTCUTS_BPS: readonly number[] = Object.freeze([50, 100, 200])

/**
 * Decision #28 (§4.4): besides the shortcuts, a free value up to 5% (500 bps), the vault's own cap. The module's cap is
 * 10% (`MAX_SLIPPAGE_BPS`); the screen never offers more than 5%.
 */
export const AUTO_EXIT_UI_MAX_SLIPPAGE_BPS = 500

/**
 * The validity a new order starts with: 30 days. No decision sets it; spec §4.2 only requires a date in the future. A
 * short validity is the conservative side, since a signed order is Domino's one power over principal (§1.5): one that
 * is forgotten lapses within a month instead of staying armed for years, and the person signs again to keep it.
 */
export const AUTO_EXIT_DEFAULT_VALIDITY_DAYS = 30

/** The longest validity the form takes: one year. Not a contract rule (it takes any future date below 2^64). */
export const AUTO_EXIT_MAX_VALIDITY_DAYS = 365

/**
 * Decision #18 (§4.1): auto-exit without automation is allowed: a protection-only vault (created paused, its module on;
 * `executeExit` ignores the pause) gives stop-loss and take-profit without reinvesting. Its copy is
 * AUTO_EXIT_PROTECTION_ONLY_TEXT.
 */
export const AUTO_EXIT_WITHOUT_AUTOMATION = true

/** Decision #18 (§4.1): what a protection-only vault says. */
export const AUTO_EXIT_PROTECTION_ONLY_TEXT = "Protection only: Domino doesn't reinvest this position. It only watches your stop-loss and take-profit."

/**
 * Decision #24 (§4.9, §6.2): why an order or a vault waits comes from read-v6's `waiting` (the backend's last simulation
 * revert, `waiting.error`, or the automation's own `waiting.reason`), never guessed from the chain.
 */
export const AUTO_EXIT_WAITING_REASONS = 'read-v6-waiting' as const
