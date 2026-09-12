/**
 * Checks the server's sign-in message before the wallet is asked to sign it.
 *
 * The client never builds the EIP-4361 message: session-v1 issues it and the
 * wallet signs those exact bytes. What the client can do is refuse to show the
 * wallet anything other than the message this page expects for this origin,
 * this address and this chain. A message that differs in any byte is not
 * signed, whatever the reason: a misrouted response, a producer change, or a
 * foreign service answering on this path.
 *
 * The layout is the producer's (backend/session_siwe.py, and the challenge
 * fixture in api-contracts/session-v1): the domain line carries the full
 * origin with its scheme, the URI is the origin plus `/`, the statement is
 * fixed, timestamps have whole seconds, and there are no optional fields.
 */

export const SIWE_STATEMENT =
  'Sign in to Domino. This request does not authorize transactions or automation.'
export const MAX_MESSAGE_BYTES = 2048
/** The producer never issues a challenge that lives longer than this. */
export const MAX_CHALLENGE_SECONDS = 300

export type ChallengeProblem =
  | 'encoding'
  | 'too_large'
  | 'layout'
  | 'domain'
  | 'address'
  | 'statement'
  | 'uri'
  | 'version'
  | 'chain'
  | 'nonce'
  | 'issued_at'
  | 'expiration'
  | 'lifetime'

export type ChallengeCheck = { ok: true } | { ok: false; problem: ChallengeProblem }

export interface ExpectedChallenge {
  /** `location.origin` of this page. */
  origin: string
  /** The connected account, EIP-55 checksummed. */
  address: string
  chainId: number
  /** The `expiresAt` field of the same challenge response. */
  expiresAt: string
}

const NONCE = /^Nonce: ([A-Za-z0-9]{32,64})$/
const ISSUED = /^Issued At: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/
const EXPIRES = /^Expiration Time: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/

/** A real UTC instant, not merely the right shape (no 2026-02-30). */
function instant(value: string): number | null {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return null
  return new Date(time).toISOString().slice(0, 19) === value.slice(0, 19) ? time : null
}

export function checkChallengeMessage(message: string, expected: ExpectedChallenge): ChallengeCheck {
  const fail = (problem: ChallengeProblem): ChallengeCheck => ({ ok: false, problem })

  if (message.includes('\r')) return fail('encoding')
  if (new TextEncoder().encode(message).length > MAX_MESSAGE_BYTES) return fail('too_large')

  const lines = message.split('\n')
  if (lines.length !== 11 || lines[2] !== '' || lines[4] !== '') return fail('layout')
  if (lines[0] !== `${expected.origin} wants you to sign in with your Ethereum account:`) return fail('domain')
  if (lines[1] !== expected.address) return fail('address')
  if (lines[3] !== SIWE_STATEMENT) return fail('statement')
  if (lines[5] !== `URI: ${expected.origin}/`) return fail('uri')
  if (lines[6] !== 'Version: 1') return fail('version')
  if (lines[7] !== `Chain ID: ${expected.chainId}`) return fail('chain')
  if (!NONCE.test(lines[8])) return fail('nonce')

  const issuedText = ISSUED.exec(lines[9])?.[1]
  const issued = issuedText === undefined ? null : instant(issuedText)
  if (issued === null) return fail('issued_at')
  const expiresText = EXPIRES.exec(lines[10])?.[1]
  const expires = expiresText === undefined ? null : instant(expiresText)
  if (expires === null || expiresText !== expected.expiresAt) return fail('expiration')

  const lifetime = (expires - issued) / 1000
  if (lifetime <= 0 || lifetime > MAX_CHALLENGE_SECONDS) return fail('lifetime')
  return { ok: true }
}
