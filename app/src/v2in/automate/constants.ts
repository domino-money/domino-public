import type { VaultLimits } from '../../v2/types'

/**
 * The owner's decisions for a new vault (spec F7 rev2 §5.1, §5.2, §9: decisions #12, #25, #27, #29 of 2 October),
 * each ONE named constant marked with its decision. They replace the "most conservative" placeholders of the first
 * revision. The form and the client (finance/v2/vault.ts settingsProblems) still hold every value to the contract's
 * bounds; the screen's own caps (#12) are tighter.
 *
 * Domino V2 integration (2026-10-02): the logic of src/v2ui/vault/constants.ts, copied for the integrated automation
 * screens (src/v2in/automate), which never import the rejected #/v2 screens. Same values, same decisions.
 *
 * Where the Domino values come from: V1's own defaults (src/lib/create/journey.ts DEFAULT_LIMITS and
 * DEFAULT_UPSIDE_PERCENT, sequenceDefaults.ts), converted to the V2 units; tests/v2/auto-vault-form.test.mjs checks they
 * still equal V1's.
 *
 * Decisions #13 (the gas ceiling is the backend's) and #14 (no V1 migration flow) are honoured by offering neither.
 */

/** Decision #12 (§5.1): a vault created for automation starts running. */
export const VAULT_AUTOMATION_START_PAUSED = false

/**
 * Decision #12 (§5.1, §8.2 "Sem modo padrão"): no default mode. The person picks Auto-compound (2%) or Domino-compound
 * (4%); creating stays off until they do.
 */
export const VAULT_DEFAULT_MODE: 1 | 2 | null = null

/**
 * Decision #25 (§5.1 "Só proteção"): a protection-only vault starts paused, with Auto-compound and one position recorded
 * because the contract requires a valid mode; nothing is reinvested while it is paused. Turning automation on later asks
 * the mode explicitly (`setPolicy`) before `resume()`. On screen it is "Auto-exit" (2026-10-06, the owner's point 5), never "Paused".
 */
export const VAULT_PROTECTION_ONLY = Object.freeze({ startPaused: true, mode: 1, maxPositions: 1 } as const)

/**
 * Decisions #12 and #27 (§5.2): at most one automated run every 10 minutes (600 s). A floor, FIXED: never edited on
 * screen ("At most one automated run every 10 minutes.").
 */
export const VAULT_MINIMUM_INTERVAL_SECONDS = 600

/** Decisions #12 and #27 (§5.2): a reference price no older than 5 minutes (300 s). FIXED: never edited on screen. */
export const VAULT_OBSERVATION_AGE_SECONDS = 300

/**
 * Decision #12 (§5.2): the Domino-only fields at V1's defaults: trigger 5% (500 bps), overlap 20% (2,000 bps),
 * 3 positions counting the root, the next ceiling at least 50% above (5,000 bps). Auto-compound sends the same values
 * (the contract validates them in either mode) with one position.
 */
export const VAULT_DEFAULT_DOMINO = Object.freeze({ triggerDistanceBps: 500, maxOverlapBps: 2000, maxPositions: 3, upsideBps: 5000 } as const)

/**
 * Decision #12 (§5.2): the limits a new vault starts with: 1% slippage on top of the pool fee, a 1% band between the
 * pool price and the reference price, the fixed reference age (#27) and the Domino upside.
 */
export const VAULT_DEFAULT_LIMITS: Readonly<VaultLimits> = Object.freeze({
  maxSlippageBps: 100,
  maxPriceImpactBps: 100,
  maxObservationAgeSeconds: VAULT_OBSERVATION_AGE_SECONDS,
  upsideBps: VAULT_DEFAULT_DOMINO.upsideBps,
})

/** Decision #12 (§5.2): the screen takes a slippage up to 5% (the contract, below 100%). */
export const VAULT_UI_MAX_SLIPPAGE_BPS = 500

/** Decision #12 (§5.2): the screen takes a band (`maxPriceImpactBps`) up to 5% (the contract, below 100%). */
export const VAULT_UI_MAX_PRICE_GAP_BPS = 500

/**
 * Decisions #12 and #29 (§5.2 "Aviso que cresce com o valor", texts valid as written): up to 1% no warning; above 1% and
 * up to 2% the first; above 2% (to the 5% cap) the second. Checked from the widest down.
 */
export const VAULT_BAND_WARNINGS: readonly { readonly aboveBps: number; readonly text: string }[] = Object.freeze([
  Object.freeze({ aboveBps: 200, text: "Risky: with a band this wide, it's easier for someone to move the pool price against you before automation runs." }),
  Object.freeze({ aboveBps: 100, text: 'A wider band lets automation run while the pool price is further from the reference price.' }),
])

/**
 * §5.2 "Distância atual" (decision #12): on v3 the reference price is `priceAnchor.twapSqrtPrice(pool, window)` with the
 * window Domino's planner uses (F6). F6 (docs/v2/F6_BACKEND.md: "v3 TWAP reads (observe)"), F3 and F1 do not state that
 * window, so it is not guessed: null, and the current distance shows as unavailable on v3, as on v4 (no route to the
 * publisher's observations yet, §6.2). A number here (seconds) would have to be the planner's stated window.
 */
export const VAULT_ANCHOR_TWAP_WINDOW_SECONDS: number | null = null
