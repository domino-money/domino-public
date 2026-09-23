/**
 * The choices a sequence is created with, in the units a person reads —
 * percentages, minutes, hours, ETH — and their exact wire form: basis points,
 * seconds and wei, inside the bounds the contracts enforce (PolicyValidation
 * and the vault's limits check, as finance/sequence.ts options() repeats
 * them). Defaults are a starting point the owner may change, never a rule.
 *
 * Nothing here reads the chain, the wallet or the session.
 */
import { parseDecimal } from '../read/decimal'
import { DEFAULT_LIMITS, DEFAULT_UPSIDE_PERCENT } from './journey'

export type SequenceMode = 'compound' | 'domino'

export interface SequenceForm {
  /** Domino only: how far below the ceiling the next position becomes eligible, 0–20 %. */
  triggerPercent: string
  /** Domino only: how far a successor's floor may overlap downward, 0–20 %. */
  maxOverlapPercent: string
  /** Domino only: positions in the sequence including the root, 1–255. Auto-compound is always 1. */
  sequenceCap: string
  /** Domino only: how much higher a successor's ceiling sits, in % of the previous ceiling. */
  upsidePercent: string
  /** The least time between two automated runs. */
  minimumIntervalMinutes: string
  /** The most a balancing swap may lose to slippage. */
  maxSlippagePercent: string
  /** The most a balancing swap may move the pool's price. */
  maxPriceImpactPercent: string
  /** The most one automated run may spend on network gas, in ETH. */
  maxGasCostEth: string
  /** How old a price reading may be when a run is decided. */
  maxObservationAgeMinutes: string
  /** How far ahead earned fees are forecast when a run is judged worthwhile. */
  forecastHorizonHours: string
}

export const SEQUENCE_DEFAULTS: SequenceForm = {
  triggerPercent: DEFAULT_LIMITS.triggerPercent,
  maxOverlapPercent: DEFAULT_LIMITS.maxOverlapPercent,
  sequenceCap: DEFAULT_LIMITS.sequenceCap,
  upsidePercent: String(DEFAULT_UPSIDE_PERCENT),
  minimumIntervalMinutes: '60',
  maxSlippagePercent: '1',
  maxPriceImpactPercent: '1',
  maxGasCostEth: '0.005',
  maxObservationAgeMinutes: '5',
  forecastHorizonHours: '168',
}

/** What `sequenceOptionsFrom` hands to finance/sequence.ts `create`: its SequenceOptions, by shape. */
export interface SequenceCreation {
  automationMode: SequenceMode
  rootTokenId: bigint
  baseIsCurrency0: boolean
  consentToUncollectedFees: true
  triggerDistanceBps: number
  maxOverlapBps: number
  minimumIntervalSeconds: number
  maxPositions: number
  upsideBps: number
  maxSlippageBps: number
  maxPriceImpactBps: number
  maxGasCostWei: bigint
  maxObservationAgeSeconds: number
  forecastHorizonSeconds: number
}

export type SequenceCheck = { ok: true; options: SequenceCreation } | { ok: false; reason: string }

const MAX_UINT32 = 2 ** 32 - 1

/** A percentage with up to two decimals as whole basis points, or null. */
export function percentToBps(text: string): number | null {
  const value = parseDecimal(text.trim())
  if (!value || value.scale > 2 || value.coefficient < 0n) return null
  const bps = value.coefficient * 10n ** BigInt(2 - value.scale)
  return bps <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bps) : null
}

/** A whole, positive count of units as a number, or null. */
function wholeUnits(text: string): number | null {
  const trimmed = text.trim()
  return /^(?:0|[1-9]\d*)$/.test(trimmed) && Number(trimmed) <= Number.MAX_SAFE_INTEGER ? Number(trimmed) : null
}

/** An ETH amount with up to 18 decimals as wei, or null. */
export function ethToWei(text: string): bigint | null {
  const value = parseDecimal(text.trim())
  if (!value || value.scale > 18 || value.coefficient < 0n) return null
  return value.coefficient * 10n ** BigInt(18 - value.scale)
}

const within = (value: number | null, min: number, max: number) => value !== null && value >= min && value <= max

/**
 * The creation for a mode, a root NFT and the form, or the first thing wrong
 * with it. Auto-compound fixes the cap at one and keeps the successor limits
 * at their defaults: the contract still requires them inside their bounds.
 * The owner must choose which of the root pool's currencies is the base. This
 * orientation is immutable in the vault and determines its quote price and
 * successor direction; it cannot be inferred from the pool's token order.
 */
export function sequenceOptionsFrom(mode: SequenceMode, rootTokenId: bigint, baseIsCurrency0: boolean | null, form: SequenceForm): SequenceCheck {
  if (rootTokenId <= 0n) return { ok: false, reason: 'Choose the position NFT first.' }
  if (typeof baseIsCurrency0 !== 'boolean') return { ok: false, reason: 'Choose which pool currency is the quote first.' }
  const trigger = percentToBps(mode === 'domino' ? form.triggerPercent : SEQUENCE_DEFAULTS.triggerPercent)
  if (!within(trigger, 0, 2000)) return { ok: false, reason: 'Trigger distance is a percentage from 0 to 20, with up to two decimal places.' }
  const overlap = percentToBps(mode === 'domino' ? form.maxOverlapPercent : SEQUENCE_DEFAULTS.maxOverlapPercent)
  if (!within(overlap, 0, 2000)) return { ok: false, reason: 'Maximum overlap is a percentage from 0 to 20, with up to two decimal places.' }
  const cap = mode === 'domino' ? wholeUnits(form.sequenceCap) : 1
  if (!within(cap, 1, 255)) return { ok: false, reason: 'The number of positions is a whole number from 1 to 255.' }
  const upside = percentToBps(mode === 'domino' ? form.upsidePercent : SEQUENCE_DEFAULTS.upsidePercent)
  if (!within(upside, 1, 1_000_000)) return { ok: false, reason: 'Successor upside is a percentage from 0.01 to 10,000.' }
  const minutes = wholeUnits(form.minimumIntervalMinutes)
  if (minutes === null || minutes < 1 || minutes * 60 > MAX_UINT32) return { ok: false, reason: 'Minimum interval is a whole number of minutes, at least 1.' }
  const slippage = percentToBps(form.maxSlippagePercent)
  if (!within(slippage, 0, 9999)) return { ok: false, reason: 'Maximum slippage is a percentage below 100, with up to two decimal places.' }
  const impact = percentToBps(form.maxPriceImpactPercent)
  if (!within(impact, 0, 9999)) return { ok: false, reason: 'Maximum price impact is a percentage below 100, with up to two decimal places.' }
  const gas = ethToWei(form.maxGasCostEth)
  if (gas === null || gas <= 0n || gas >= 2n ** 128n) return { ok: false, reason: 'The gas cap per run is an amount of ETH above zero.' }
  const age = wholeUnits(form.maxObservationAgeMinutes)
  if (age === null || age < 1 || age * 60 > MAX_UINT32) return { ok: false, reason: 'Price reading age is a whole number of minutes, at least 1.' }
  const horizon = wholeUnits(form.forecastHorizonHours)
  if (horizon === null || horizon < 1 || horizon * 3600 > MAX_UINT32) return { ok: false, reason: 'The forecast horizon is a whole number of hours, at least 1.' }
  return {
    ok: true,
    options: {
      automationMode: mode,
      rootTokenId,
      baseIsCurrency0,
      consentToUncollectedFees: true,
      triggerDistanceBps: trigger as number,
      maxOverlapBps: overlap as number,
      minimumIntervalSeconds: minutes * 60,
      maxPositions: cap as number,
      upsideBps: upside as number,
      maxSlippageBps: slippage as number,
      maxPriceImpactBps: impact as number,
      maxGasCostWei: gas,
      maxObservationAgeSeconds: age * 60,
      forecastHorizonSeconds: horizon * 3600,
    },
  }
}

/** What a `#/sequence/…` link asks for: a mode, a position NFT id, both, or nothing. Anything else is ignored. */
export function sequenceIntent(segments: readonly string[]): { mode: SequenceMode | null; tokenId: string | null } {
  const [, first = '', second = ''] = segments.length && segments[0] === 'sequence' ? segments : ['sequence', ...segments]
  const isMode = (text: string): text is SequenceMode => text === 'compound' || text === 'domino'
  const isId = (text: string) => /^[1-9]\d{0,77}$/.test(text)
  if (isMode(first)) return { mode: first, tokenId: isId(second) ? second : null }
  if (isId(first)) return { mode: isMode(second) ? second : null, tokenId: first }
  return { mode: null, tokenId: null }
}
