/**
 * The owner's decisions for auto-exit (spec F7 rev2 §4.1, §4.4, §4.9, §9: decisions #18, #19, #24, #28 of 2 October),
 * each ONE named constant marked with its decision. The client (finance/v2/autoExit.ts mandateProblems) holds every term
 * to spec §4.2 either way.
 *
 * Changed on purpose 2026-10-06 (the owner's point 5; rugged97: "it is AUTO-EXIT, separate from the rest. When the price
 * hits the edge of the range we close the position automatically and send the tokens to the wallet. It must be
 * automatic"): no price is typed any more, the range's edges are the triggers (./form.ts), so the slippage shortcuts and
 * the screen's own slippage field are gone (the default stays), and an autonomous service runs for the app's longest
 * validity.
 *
 * Domino V2 integration (2026-10-02): the logic of src/v2ui/autoExit/constants.ts, copied for the integrated screens.
 */

/** Decision #19 (§4.4): the default slippage, on top of the pool's fee: 1% (100 bps). Auto-exit always uses it. */
export const AUTO_EXIT_DEFAULT_SLIPPAGE_BPS = 100

/** The longest validity the app signs: one year. Not a contract rule (it takes any future date below 2^64). */
export const AUTO_EXIT_MAX_VALIDITY_DAYS = 365

/**
 * The validity an Auto-exit is signed with. Changed on purpose 2026-10-06 (the owner's point 5: an autonomous service;
 * the plan: "validUntil = the app's existing maximum"): one year, the app's maximum, instead of the 30 days a typed order
 * started with. It still lapses on its own; turning it off ends it at once.
 */
export const AUTO_EXIT_DEFAULT_VALIDITY_DAYS = AUTO_EXIT_MAX_VALIDITY_DAYS

/**
 * Decision #18 (§4.1): auto-exit without automation is allowed: a protection-only vault (created paused, its module on;
 * `executeExit` ignores the pause) closes the position at its range's edge without reinvesting. Its copy is
 * AUTO_EXIT_PROTECTION_ONLY_TEXT. Changed on purpose 2026-10-06 (rugged97: "auto-exit has no fee compounding"): it is the
 * only way Auto-exit is set up; it is never offered on a running Auto-compound or Domino-compound automation.
 */
export const AUTO_EXIT_WITHOUT_AUTOMATION = true

/** Decision #18 (§4.1), in Auto-exit's words (Changed on purpose 2026-10-06, the owner's point 5). */
export const AUTO_EXIT_PROTECTION_ONLY_TEXT = "Auto-exit only closes this position. Domino doesn't reinvest its fees."

/**
 * Decision #24 (§4.9, §6.2): why an order or a vault waits comes from read-v6's `waiting` (the backend's last simulation
 * revert, `waiting.error`, or the automation's own `waiting.reason`), never guessed from the chain.
 */
export const AUTO_EXIT_WAITING_REASONS = 'read-v6-waiting' as const
