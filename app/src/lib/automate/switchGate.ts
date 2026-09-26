/**
 * What a sequence's root position offers its owner on its page (the owner, 2026-09-25: "vamos ligar tudo"): Turn on
 * for a paused sequence, Pause for one that runs, the way to sign in first, or nothing. Pure, so every case is tested
 * (tests/sequence-switch.test.mjs); components/positions/SequenceSwitch.tsx asks it at each render.
 *
 * Turn on is a promise that something will run, so it is offered only on the automation service's own word, asked for
 * this owner and this vault within the signed-in session that asked (finance/automationAvailability.ts, which fails
 * closed), and only until that word expires. Anything else (no answer yet, a refusal, an error, another owner, another
 * vault, another session, an old answer) offers nothing new: the pill still says Paused, and the page keeps its link to
 * the docs. The press asks the service again before anything is sent.
 *
 * Pause needs no service: the owner can always stop a sequence that runs.
 */

/** Turn on, Pause, Sign in to turn on, or nothing new. */
export type SwitchOffer = 'turn-on' | 'pause' | 'sign-in' | null

/** One answer of the automation service, as the switch keeps it: whose, for which vault, in which session, and when. */
export interface Readiness {
  owner: string
  vault: string
  epoch: number
  /** Local-clock time the answer arrived. */
  at: number
  /** Local-clock time the service's own "ready" expires (its expiresAtEpoch); null: not ready. */
  until: number | null
}

/*
 * How long an answer holds (the review of 2026-09-25): the execution contract lets a "ready" live at most 10 seconds
 * after the service's check (api-contracts/execution-v1 README and runtime.mjs), so the switch keeps one no longer than
 * the service's own expiry and never longer than READY_KEEP_MS, the 9 seconds the owner activation gate it replaces
 * kept (#205). It asks again READY_RENEW_LEAD_MS before a "ready" lapses, so a ready service stays shown; an answer
 * nobody renewed takes Turn on away. A "not ready" is asked again after NOT_READY_RECHECK_MS. Asked only while the page
 * is in view, the sequence paused and its owner signed in.
 */
/** The longest a "ready" answer is kept, whatever the service's expiry says. */
export const READY_KEEP_MS = 9_000
/** How long before a "ready" lapses it is asked again: 8 seconds after it arrived at the latest (READY_RENEW_MS). */
export const READY_RENEW_LEAD_MS = 1_000
/** How soon a "ready" answer is asked again, when the service's own expiry comes no sooner than READY_KEEP_MS. */
export const READY_RENEW_MS = READY_KEEP_MS - READY_RENEW_LEAD_MS
/** The shortest wait between two questions, however soon the service's answer expires. */
export const READY_RENEW_MIN_MS = 2_000
/** How soon a "not ready" answer is asked again. */
export const NOT_READY_RECHECK_MS = 45_000

/** Local-clock time a "ready" answer stops counting: its service's expiry, capped at READY_KEEP_MS after it arrived. */
export function readyUntil(readiness: Readiness): number {
  return readiness.until === null ? readiness.at : Math.min(readiness.until, readiness.at + READY_KEEP_MS)
}

/** How long after `readiness` arrived the service is asked again. */
export function renewIn(readiness: Readiness): number {
  return readiness.until === null
    ? NOT_READY_RECHECK_MS
    : Math.max(readyUntil(readiness) - readiness.at - READY_RENEW_LEAD_MS, READY_RENEW_MIN_MS)
}

/** The session as the switch needs it (session/port.ts SessionSnapshot, reduced). */
export type SwitchSession = { kind: 'signed_in'; owner: string; epoch: number } | { kind: string }

export interface SwitchInput {
  /** The position's sequence as the chain answered it (lib/automationState.ts), or null when it is not one of Domino's. */
  sequence: { paused: boolean; active: boolean; vault: string } | null
  /** The connected wallet, lowercase, when it holds the position on Robinhood Chain; null otherwise. */
  owner: string | null
  session: SwitchSession
  readiness: Readiness | null
  /** Local-clock time now. */
  now: number
  /** Whether the position holds liquidity: an empty position is never turned on. */
  liquid: boolean
}

/** Whether `readiness` is the service's fresh "ready" for this owner, this vault and this session. */
export function readyFor(readiness: Readiness | null, owner: string, vault: string, epoch: number, now: number): boolean {
  return (
    readiness !== null &&
    readiness.until !== null &&
    readiness.owner === owner.toLowerCase() &&
    readiness.vault === vault.toLowerCase() &&
    readiness.epoch === epoch &&
    now >= readiness.at &&
    now < readyUntil(readiness)
  )
}

/** The session signed in for `owner`, or null. */
function signedInAs(session: SwitchSession, owner: string): { owner: string; epoch: number } | null {
  if (session.kind !== 'signed_in' || !('owner' in session) || !('epoch' in session)) return null
  return session.owner === owner ? session : null
}

export function switchOffer({ sequence, owner, session, readiness, now, liquid }: SwitchInput): SwitchOffer {
  if (!sequence || !owner) return null
  // Running: Pause, which needs no service and no session. Stopped (not paused, its permission over the NFT lost): nothing here.
  if (!sequence.paused) return sequence.active ? 'pause' : null
  if (!liquid) return null
  const signed = signedInAs(session, owner)
  // Connected and not signed in: the service can only be asked within a session, so the way to sign in is offered.
  if (!signed) return session.kind === 'signed_out' ? 'sign-in' : null
  return readyFor(readiness, owner, sequence.vault, signed.epoch, now) ? 'turn-on' : null
}
