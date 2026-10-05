import { settingsProblems } from '../../finance/v2/vault'
import { percentToBps } from '../../lib/create/sequenceDefaults'
import type { Dex, VaultLimits, VaultPolicy } from '../../v2/types'
import {
  VAULT_BAND_WARNINGS, VAULT_DEFAULT_DOMINO, VAULT_DEFAULT_LIMITS, VAULT_DEFAULT_MODE, VAULT_MINIMUM_INTERVAL_SECONDS, VAULT_OBSERVATION_AGE_SECONDS,
  VAULT_PROTECTION_ONLY, VAULT_UI_MAX_PRICE_GAP_BPS, VAULT_UI_MAX_SLIPPAGE_BPS,
} from './constants'

/**
 * A vault's settings as the person types them (spec F7 rev2 §5.2), and their exact wire form: percentages to basis
 * points. The minimum interval and the reference price's age are FIXED (decision #27): not fields, never edited; a new
 * vault gets 600 s and 300 s, and a vault's settings changed later keep its own two values (nothing changed silently).
 * The bounds are the contract's, applied by the client's own check (finance/v2/vault.ts settingsProblems), so the form
 * refuses exactly what the factory and `setPolicy`/`setLimits` would revert, and the screen's caps (#12: slippage and
 * band up to 5%) come on top. Pure.
 *
 * Domino V2 integration (2026-10-02): the logic of src/v2ui/vault/form.ts, copied for the integrated screens.
 */

export interface VaultSettingsForm {
  /** 1 Auto-compound (2%), 2 Domino-compound (4%); null until the person picks (decision #12: no default). */
  mode: 1 | 2 | null
  /** Domino only on screen; validated always. 0–20 %. */
  triggerPercent: string
  /** Domino only on screen; validated always. 0–20 %. */
  maxOverlapPercent: string
  /** Domino only: positions in the sequence including this one, 1–255. Auto-compound is always 1. */
  maxPositions: string
  /** Domino only on screen; validated always. 0.01–10,000 %. */
  upsidePercent: string
  /** On top of the pool fee; up to 5% on screen (#12). */
  maxSlippagePercent: string
  /** The band between the pool price and the reference price; up to 5% on screen (#12). */
  maxPriceGapPercent: string
  /** FIXED (#27): at most one automated run every … seconds. */
  minimumIntervalSeconds: number
  /** FIXED (#27): the reference price's age, in seconds. */
  observationAgeSeconds: number
}

/** bps as the percentage text the form shows: 500 → "5", 125 → "1.25". */
export function bpsText(bps: number): string {
  const whole = Math.trunc(bps / 100)
  const rest = bps % 100
  return rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(2, '0').replace(/0$/, '')}`
}

/** The form a new automation vault starts with: decision #12's defaults, and no mode. */
export function defaultSettingsForm(): VaultSettingsForm {
  return {
    mode: VAULT_DEFAULT_MODE,
    triggerPercent: bpsText(VAULT_DEFAULT_DOMINO.triggerDistanceBps),
    maxOverlapPercent: bpsText(VAULT_DEFAULT_DOMINO.maxOverlapBps),
    maxPositions: String(VAULT_DEFAULT_DOMINO.maxPositions),
    upsidePercent: bpsText(VAULT_DEFAULT_LIMITS.upsideBps),
    maxSlippagePercent: bpsText(VAULT_DEFAULT_LIMITS.maxSlippageBps),
    maxPriceGapPercent: bpsText(VAULT_DEFAULT_LIMITS.maxPriceImpactBps),
    minimumIntervalSeconds: VAULT_MINIMUM_INTERVAL_SECONDS,
    observationAgeSeconds: VAULT_OBSERVATION_AGE_SECONDS,
  }
}

/**
 * The protection-only vault's settings (decision #25): Auto-compound recorded with one position, paused, every other
 * value at decision #12's defaults. Never edited: nothing is reinvested while it is paused.
 */
export function protectionSettings(): { policy: VaultPolicy; limits: VaultLimits } {
  return {
    policy: Object.freeze({
      mode: VAULT_PROTECTION_ONLY.mode,
      triggerDistanceBps: VAULT_DEFAULT_DOMINO.triggerDistanceBps,
      maxOverlapBps: VAULT_DEFAULT_DOMINO.maxOverlapBps,
      minimumIntervalSeconds: VAULT_MINIMUM_INTERVAL_SECONDS,
      maxPositions: VAULT_PROTECTION_ONLY.maxPositions,
    }),
    limits: VAULT_DEFAULT_LIMITS,
  }
}

/**
 * A vault's current settings as the form (the panel's "Change settings"). `askMode`: the mode starts unpicked, as when a
 * protection-only vault turns automation on (decision #25: asked explicitly, never the Auto-compound it recorded).
 */
export function settingsFormOf(policy: VaultPolicy, limits: VaultLimits, askMode = false): VaultSettingsForm {
  return {
    mode: askMode ? null : policy.mode,
    triggerPercent: bpsText(policy.triggerDistanceBps),
    maxOverlapPercent: bpsText(policy.maxOverlapBps),
    maxPositions: String(policy.mode === 2 ? policy.maxPositions : VAULT_DEFAULT_DOMINO.maxPositions),
    upsidePercent: bpsText(limits.upsideBps),
    maxSlippagePercent: bpsText(limits.maxSlippageBps),
    maxPriceGapPercent: bpsText(limits.maxPriceImpactBps),
    minimumIntervalSeconds: policy.minimumIntervalSeconds,
    observationAgeSeconds: limits.maxObservationAgeSeconds,
  }
}

/** A whole, positive number typed as text, or null. */
function whole(text: string): number | null {
  const t = text.trim()
  return /^(?:0|[1-9]\d{0,9})$/.test(t) ? Number(t) : null
}

/** A field the form could not read at all, or one over the screen's cap (before the contract's bounds are applied). */
export type FormProblem =
  | 'form_trigger'
  | 'form_overlap'
  | 'form_max_positions'
  | 'form_upside'
  | 'form_slippage'
  | 'form_slippage_cap'
  | 'form_price_gap'
  | 'form_price_gap_cap'

export type SettingsCheck = { ok: true; policy: VaultPolicy; limits: VaultLimits } | { ok: false; problems: readonly string[] }

/**
 * The policy and limits of a form, or every problem with it: the form's own (a field it cannot read, the mode not
 * picked, a value over the screen's cap) and the client's (the contract's bounds, spec §5.2), as closed codes for
 * SETTINGS_PROBLEM_TEXT. `members` is the vault's current number of positions (a new vault: 1). The mode is the form's,
 * never inferred; Auto-compound sends `maxPositions` 1 and the Domino fields as typed (the contract validates them).
 * `fixedLimits`: the limits are these, not the form's (only the policy is being changed).
 */
export function settingsFrom(form: VaultSettingsForm, dex: Dex, members = 1, fixedLimits?: VaultLimits): SettingsCheck {
  const problems: string[] = []
  const pct = (text: string, code: FormProblem): number | null => {
    const bps = percentToBps(text)
    if (bps === null) problems.push(code)
    return bps
  }
  if (form.mode !== 1 && form.mode !== 2) problems.push('vault_policy_mode')
  const trigger = pct(form.triggerPercent, 'form_trigger')
  const overlap = pct(form.maxOverlapPercent, 'form_overlap')
  const upside = fixedLimits ? fixedLimits.upsideBps : pct(form.upsidePercent, 'form_upside')
  // With `fixedLimits` (turning automation on: only the policy is sent), the vault's own limits stand, unedited.
  const slippage = fixedLimits ? fixedLimits.maxSlippageBps : pct(form.maxSlippagePercent, 'form_slippage')
  if (!fixedLimits && slippage !== null && slippage > VAULT_UI_MAX_SLIPPAGE_BPS) problems.push('form_slippage_cap')
  const gap = fixedLimits ? fixedLimits.maxPriceImpactBps : pct(form.maxPriceGapPercent, 'form_price_gap')
  if (!fixedLimits && gap !== null && gap > VAULT_UI_MAX_PRICE_GAP_BPS) problems.push('form_price_gap_cap')
  const cap = form.mode === 2 ? whole(form.maxPositions) : 1
  if (cap === null) problems.push('form_max_positions')
  if (problems.length) return { ok: false, problems: Object.freeze(problems) }
  const policy: VaultPolicy = Object.freeze({
    mode: form.mode as 1 | 2,
    triggerDistanceBps: trigger as number,
    maxOverlapBps: overlap as number,
    minimumIntervalSeconds: form.minimumIntervalSeconds,
    maxPositions: cap as number,
  })
  const limits: VaultLimits = fixedLimits ?? Object.freeze({
    maxSlippageBps: slippage as number,
    maxPriceImpactBps: gap as number,
    maxObservationAgeSeconds: form.observationAgeSeconds,
    upsideBps: upside as number,
  })
  const bounds = settingsProblems(policy, limits, dex, members)
  return bounds.length ? { ok: false, problems: Object.freeze(bounds) } : { ok: true, policy, limits }
}

/** What each problem says, beside its field. */
export const SETTINGS_PROBLEM_TEXT: Readonly<Record<string, string>> = Object.freeze({
  form_trigger: 'Enter a percentage from 0 to 20, with up to two decimals.',
  form_overlap: 'Enter a percentage from 0 to 20, with up to two decimals.',
  form_max_positions: 'Enter a whole number from 1 to 255.',
  form_upside: 'Enter a percentage from 0.01 to 10,000, with up to two decimals.',
  form_slippage: 'Enter a percentage up to 5, with up to two decimals.',
  form_slippage_cap: 'Enter a percentage up to 5, with up to two decimals.',
  form_price_gap: 'Enter a percentage up to 5, with up to two decimals.',
  form_price_gap_cap: 'Enter a percentage up to 5, with up to two decimals.',
  vault_policy_mode: 'Choose Auto-compound or Domino-compound.',
  vault_policy_trigger_distance: 'The distance must be from 0% to 20%.',
  vault_policy_max_overlap: 'The overlap must be from 0% to 20%.',
  vault_policy_minimum_interval: 'One of the settings is outside the allowed range.',
  vault_policy_max_positions: 'The number of positions must be from 1 to 255, and not below the positions your automation holds now.',
  vault_policy_simple_one_position: 'Auto-compound keeps a single position.',
  vault_limits_max_slippage: 'The slippage must be below 100%.',
  vault_limits_max_price_impact: 'The gap must be below 100%.',
  vault_limits_observation_age: 'One of the settings is outside the allowed range.',
  vault_limits_observation_age_v3: 'One of the settings is outside the allowed range.',
  vault_limits_upside: 'The next ceiling must be from 0.01% to 10,000% above.',
  vault_policy_missing: 'One of the settings is outside the allowed range.',
  vault_limits_missing: 'One of the settings is outside the allowed range.',
})

/** Which field a problem belongs to, so its sentence sits beside it ('fixed': the two fixed values, said together). */
export const PROBLEM_FIELD: Readonly<Record<string, keyof VaultSettingsForm | 'fixed'>> = Object.freeze({
  form_trigger: 'triggerPercent',
  vault_policy_trigger_distance: 'triggerPercent',
  form_overlap: 'maxOverlapPercent',
  vault_policy_max_overlap: 'maxOverlapPercent',
  form_max_positions: 'maxPositions',
  vault_policy_max_positions: 'maxPositions',
  vault_policy_simple_one_position: 'maxPositions',
  form_upside: 'upsidePercent',
  vault_limits_upside: 'upsidePercent',
  form_slippage: 'maxSlippagePercent',
  form_slippage_cap: 'maxSlippagePercent',
  vault_limits_max_slippage: 'maxSlippagePercent',
  form_price_gap: 'maxPriceGapPercent',
  form_price_gap_cap: 'maxPriceGapPercent',
  vault_limits_max_price_impact: 'maxPriceGapPercent',
  vault_policy_minimum_interval: 'fixed',
  vault_limits_observation_age: 'fixed',
  vault_limits_observation_age_v3: 'fixed',
  vault_policy_mode: 'mode',
})

/** "At most one automated run every 10 minutes." (§5.2, the fixed floor), for any whole number of seconds. */
export function intervalWords(seconds: number): string {
  if (seconds === 60) return 'At most one automated run every minute.'
  if (seconds % 60 === 0) return `At most one automated run every ${seconds / 60} minutes.`
  return `At most one automated run every ${seconds} seconds.`
}

/** "Reference price no older than 5 minutes" (§5.2, the fixed age), for any whole number of seconds. */
export function observationAgeWords(seconds: number): string {
  if (seconds === 60) return 'Reference price no older than 1 minute'
  if (seconds % 60 === 0) return `Reference price no older than ${seconds / 60} minutes`
  return `Reference price no older than ${seconds} seconds`
}

/**
 * The band's growing warning (§5.2, decisions #12 and #29) for the percentage typed: none up to 1%, then the wider
 * band's sentence, then above 2% the risky one. Null while the value cannot be read.
 */
export function bandWarning(gapText: string): string | null {
  const bps = percentToBps(gapText)
  if (bps === null) return null
  return VAULT_BAND_WARNINGS.find((w) => bps > w.aboveBps)?.text ?? null
}

/**
 * How far the pool price is from the reference price now (§5.2 "Distância atual", F1a "The band"), from the two sqrt
 * prices (Q64.96): X = (max(Pa, Ps) / min(Pa, Ps) − 1) × 100 with P = (sqrtPriceX96 / 2^96)², cut (never rounded up) to
 * two decimals; automation waits when max(a, s)² × 10000 > min(a, s)² × (10000 + band) (AnchorMath.withinBand). Exact
 * integers. Null for a zero or negative price, or a band outside 0–9,999 bps.
 */
export function bandDistance(anchorSqrtPriceX96: bigint, spotSqrtPriceX96: bigint, bandBps: number): { percent: string; outside: boolean; sentence: string } | null {
  if (anchorSqrtPriceX96 <= 0n || spotSqrtPriceX96 <= 0n || !Number.isInteger(bandBps) || bandBps < 0 || bandBps >= 10_000) return null
  const [low, high] = anchorSqrtPriceX96 < spotSqrtPriceX96 ? [anchorSqrtPriceX96, spotSqrtPriceX96] : [spotSqrtPriceX96, anchorSqrtPriceX96]
  const percent = percentOf(high * high - low * low, low * low, 2)
  const outside = high * high * 10_000n > low * low * BigInt(10_000 + bandBps)
  const sentence = outside
    ? `Right now the pool price is ${percent}% from the reference price; automation would wait.`
    : `Right now the pool price is ${percent}% from the reference price.`
  return { percent, outside, sentence }
}

/** A plain percentage of an exact fraction num / den × 100, trailing zeros dropped, cut (never rounded up) at `places`. */
function percentOf(num: bigint, den: bigint, places = 4): string {
  const scaled = (num * 100n * 10n ** BigInt(places)) / den
  const text = scaled.toString().padStart(places + 1, '0')
  const integer = text.slice(0, text.length - places)
  const fraction = text.slice(text.length - places).replace(/0+$/, '')
  return fraction ? `${integer}.${fraction}` : integer
}

/**
 * The swap floor of spec §5.2 for a pool fee (pips, hundredths of a basis point) and a slippage (bps):
 * (1 − fee) × (1 − slippage), as a percentage of the swap's value at the reference price. 1% and 1% → "98.01".
 * The pool fee counts at most 10% (F1b). Null for a slippage outside 0–9,999 bps.
 */
export function swapFloorPercent(poolFeePips: number, slippageBps: number): string | null {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) return null
  if (!Number.isInteger(poolFeePips) || poolFeePips < 0) return null
  const fee = BigInt(Math.min(poolFeePips, 100_000))
  return percentOf((1_000_000n - fee) * (10_000n - BigInt(slippageBps)), 10_000_000_000n)
}

/**
 * The floor example the slippage field shows (spec §5.2, §8.2 "mostra o exemplo de piso"), at a 1% pool fee and the
 * slippage typed: "On a pool with a 1% fee, a 1% limit means each swap returns at least 98.01% of its value at the
 * reference price." Null while the slippage cannot be read.
 */
export function floorExample(slippageText: string): string | null {
  const bps = percentToBps(slippageText)
  if (bps === null) return null
  const floor = swapFloorPercent(10_000, bps)
  return floor === null ? null : `On a pool with a 1% fee, a ${bpsText(bps)}% limit means each swap returns at least ${floor}% of its value at the reference price.`
}
