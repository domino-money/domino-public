/**
 * Every sentence the S2 screens say (spec F7 §3.4, §3.5, §3.6, §3.7, §3.9), in English, as the spec quotes them.
 * Placeholders are `{provider}`, `{destination}`, `{origin}` and `{token}`; ./present.ts fills them.
 *
 * Server text never reaches the screen: a candidate's `reason`, a provider's raw status and a fee's `reason` are
 * diagnostics, kept out of every sentence here. Addresses, hashes and amounts are shown as text. No USD anywhere, and
 * the Domino fee is never said to be charged before the deposit is `filled`: before that the quote says what the
 * provider will charge, and the fee's measurement (`measured`, `not collected`, `pending`, `unavailable`) is shown
 * in the receipt's details only.
 */
import type { CandidateStatus, DepositState, FeeStatus, Provider } from './types'

export const PROVIDER_NAME: Readonly<Record<Provider, string>> = Object.freeze({ relay: 'Relay', across: 'Across' })

/** §3.4: a candidate that has no price, or cannot do what was asked. `quoted` shows the quote instead (null). */
export const CANDIDATE_COPY: Readonly<Record<CandidateStatus, string | null>> = Object.freeze({
  quoted: null,
  destination_gas_unsupported: "{provider} can't deliver gas on {destination}.",
  // Added 2026-10-06 (crosschain-v1 1.1.0-rc.1): a quote by output whose deposit needs more than the wallet may send.
  // Changed on purpose 2026-10-06 (rugged's delta of 6 Oct §3): with both amounts known, ./present.ts says them instead
  // (feeLines.aboveMax); this sentence only when one cannot be written.
  input_above_max: '{provider} needs more than you can send from {origin}.',
  no_route: '{provider} has no route for this token.',
  amount_too_low: 'Amount too low for {provider}.',
  amount_too_high: 'Amount too high for {provider}.',
  rate_limited: '{provider} is busy. Try again shortly.',
  unavailable: '{provider} is unavailable right now.',
  rejected: '{provider} refused this request.',
  // Never offered: the runtime refuses any decision for an unsafe candidate.
  unsafe: "Domino's checks refused {provider}'s answer.",
  origin_not_supported: "{provider} isn't supported from {origin}.",
})

/** §3.4 `decision: null`, followed by one line per provider. */
export const NO_ROUTE = 'No route available right now.'

/** §3.7: what each tracking state says. */
export const STATE_COPY: Readonly<Record<DepositState, string>> = Object.freeze({
  awaiting_deposit: 'Waiting for {provider} to see your deposit…',
  pending: 'Bridging to {destination}…',
  filled: 'Arrived in your wallet on {destination}.',
  refund_pending: 'Not filled in time. Across will refund {token} to your wallet on {origin}, usually 2.5 to 3 hours after your deposit.',
  failed: "The bridge failed. Relay is refunding your deposit on {origin}, minus the refund's gas.",
  refunded: 'Refunded to your wallet on {origin}.',
  refund_failed:
    'Automatic refund failed. Reclaim your deposit at relay.link/withdraw with this wallet. If this is a smart or blocked wallet, contact Relay support.',
})

/** §3.7: the words for the Domino fee's measurement, in the receipt's details only. */
export const FEE_STATUS_WORDS: Readonly<Record<FeeStatus, string>> = Object.freeze({
  measured: 'measured',
  not_collected: 'not collected',
  pending: 'pending',
  unavailable: 'unavailable',
})

/** §3.6 step 1: a wallet's 4902 for the origin chain. */
export const ADD_ORIGIN = 'Add {origin} to your wallet, then try again.'
/** §3.9: after `filled`, the way on to S1 on the destination. */
export const CREATE_ON_DESTINATION = 'Create a position on {destination}'
/** §3.5: the network fee when the provider did not estimate it. */
export const NOT_REPORTED = 'Not reported'

/** The client's own failures: what the page says when no contract error code applies. */
export const FAILURE_COPY = Object.freeze({
  gate_required: 'Your site access has expired. Reload the page and enter the password again.',
  gate_unavailable: 'The site is temporarily unavailable. Try again later.',
  not_deployed: "Deposits from another network aren't available right now.",
  contract: "We got an answer this page doesn't accept, so nothing from it is shown.",
  owner: 'This answer was about another wallet, so nothing from it is shown.',
  echo: "This answer doesn't match what was asked, so nothing from it is shown.",
  expired: 'The quote expired. Getting a new one…',
  request_invalid: 'Something went wrong with this request.',
  network: 'The connection failed. The page will try again.',
  timeout: 'This took too long. Try again.',
  session_gone: 'Sign in again to continue.',
  aborted: '',
})

/** Replaces each `{name}` the values name; a placeholder without a value stays visible rather than becoming empty. */
export function fill(template: string, values: Partial<Record<'provider' | 'destination' | 'origin' | 'token', string>>): string {
  return template.replace(/\{(provider|destination|origin|token)\}/g, (whole, name: 'provider' | 'destination' | 'origin' | 'token') => values[name] ?? whole)
}

/** Basis points as a percent, exactly: 35 → "0.35%", 5 → "0.05%", 100 → "1%". */
export function bpsPercent(bps: number): string {
  if (!Number.isSafeInteger(bps) || bps < 0) return ''
  const padded = String(bps).padStart(3, '0')
  const whole = padded.slice(0, -2).replace(/^0+(?=\d)/, '')
  const fraction = padded.slice(-2).replace(/0+$/, '')
  return `${fraction ? `${whole}.${fraction}` : whole}%`
}

/** §3.5 lines. Every argument is already words: amounts with their token, chain and provider names. */
export const feeLines = {
  domino: (percent: string, amount: string, provider: string, chain: string) => `Domino fee (${percent}): ${amount}, charged by ${provider} on ${chain}`,
  bridge: (amount: string) => `Bridge fee: ${amount}`,
  receive: (amount: string, destination: string, minimum: string) => `You receive about ${amount} on ${destination} (at least ${minimum})`,
  network: (origin: string, provider: string | null) => `Network fee on ${origin}: ${provider === null ? NOT_REPORTED : `estimated by ${provider}`}`,
  eta: (duration: string) => `Arrives in about ${duration}`,
  destinationGas: (amount: string, destination: string) => `Includes ${amount} for network fees on ${destination}`,
  /** Added 2026-10-06 (rugged's delta of 6 Oct §3): what the candidate's deposit takes from the wallet on the origin. */
  send: (amount: string, origin: string) => `You send ${amount} on ${origin}`,
  /** Added 2026-10-06 (rugged's delta of 6 Oct §3): an `input_above_max` candidate, its input against the most the wallet may send. */
  aboveMax: (provider: string, needed: string, max: string, origin: string) => `${provider} needs ${needed}, you can send ${max} from ${origin}.`,
}
