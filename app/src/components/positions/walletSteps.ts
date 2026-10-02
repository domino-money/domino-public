import { formatUnits } from '../../lib/read/decimal'

/**
 * What the owner's position actions (PositionActions.tsx), the refund of a
 * held deposit (HeldDeposits.tsx) and a sequence's Turn on and Pause
 * (SequenceSwitch.tsx) share: how long a sent step is watched, what is read
 * after the wallet replaced one, and how an amount is written. Plain helpers:
 * no wallet, no chain, nothing from finance/.
 */

/** How long a sent step is watched for its receipt, and how often. */
export const RECEIPT_WAIT_MS = 300_000
export const RECEIPT_EVERY_MS = 2_000

/**
 * How a watched step ended: in a block, reverted there, its block gone, replaced in the wallet, still waiting past the
 * watch, not readable at all by the end of the watch (its outcome unknown), or no longer this page's.
 *
 * `replaced` (2026-10-01, audit C14): the person pressed "Speed up" or "Cancel" in the wallet. The client's receipt says
 * so once the chain does not know the hash it was given and the account's nonce has passed it (finance/setup.ts and
 * finance/position.ts receipt); the page then reads the state again (readAfterReplaced) to know whether the step
 * happened. It used to be watched as pending for the full five minutes.
 */
export type Watched = 'included' | 'reverted' | 'reorged' | 'replaced' | 'waiting' | 'unknown' | 'stopped'

/**
 * The clients' own codes (finance/setup.ts and finance/position.ts receipt) that say the transaction read back is not
 * the one reviewed. Waiting never changes them, so the watch ends on them; any other failed read (a wallet's
 * -32603, a rate-limited node, a read that timed out or found the client busy) is read again at the next beat.
 */
const SETTLED_FAILURES: ReadonlySet<string> = new Set([
  'receipt_not_from_this_review', 'transaction_does_not_match_review', 'invalid_transaction_hash', 'invalid_transaction',
  'invalid_receipt', 'operation_receipt_required', 'transaction_operation_mismatch', 'invalid_transaction_value',
  'operation_not_owned', 'deployment_code_changed', 'deployment_identity_changed',
])
const settled = (error: unknown) => error instanceof Error && SETTLED_FAILURES.has(error.message)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Reads a sent step's receipt every two seconds until it is in a block, reverted, reorganized away or replaced in the
 * wallet, for five minutes at most. A read that fails is read again at the next beat; the watch ends early only on a
 * failure that says the transaction is not the one reviewed, which it throws. `alive` says whether the page still wants
 * the answer; nothing is ever sent again from here. `timing` is for tests.
 */
export async function watchReceipt(read: () => Promise<{ state: string }>, alive: () => boolean, timing = { everyMs: RECEIPT_EVERY_MS, waitMs: RECEIPT_WAIT_MS }): Promise<Watched> {
  const until = Date.now() + timing.waitMs
  for (;;) {
    await sleep(timing.everyMs)
    if (!alive()) return 'stopped'
    let state: string | null
    try {
      state = (await read()).state
    } catch (error) {
      if (settled(error)) throw error
      state = null
    }
    if (!alive()) return 'stopped'
    if (state === 'included' || state === 'finalized') return 'included'
    if (state === 'reverted' || state === 'reorged' || state === 'replaced') return state
    if (Date.now() > until) return state === null ? 'unknown' : 'waiting'
  }
}

/** How many times the state is read after a step the wallet replaced, RECEIPT_EVERY_MS apart, before it is said not to have happened. */
export const REPLACED_READS = 6

/**
 * After a step the wallet replaced (audit C14): whether it happened after all, from the state read again. A sped-up
 * step did happen, under another hash; a cancelled one did not. Read until `happened` says so, at most REPLACED_READS
 * times, so a node still behind the replacement's block is not taken for a cancel (as Create position reads its
 * operation again). A read that fails is read again at the next beat, and thrown only when none could be read: the
 * caller then says the outcome is unknown. Null once the page no longer wants the answer. Nothing is sent from here.
 */
export async function readAfterReplaced<T>(read: () => Promise<T>, happened: (value: T) => boolean, alive: () => boolean, everyMs = RECEIPT_EVERY_MS): Promise<boolean | null> {
  let answered = false
  let failure: unknown = null
  for (let tries = 0; ; tries++) {
    try {
      const value = await read()
      if (!alive()) return null
      if (happened(value)) return true
      answered = true
    } catch (error) {
      if (!alive()) return null
      failure = error
    }
    if (tries + 1 >= REPLACED_READS) {
      if (answered) return false
      throw failure
    }
    await sleep(everyMs)
    if (!alive()) return null
  }
}

/** A step sent whose outcome the page could not read: said instead of a failure, which it may not be. */
export const outcomeUnknown = (what: string) => `The ${what} was sent, but its outcome could not be read. Check your wallet activity before trying again.`

// Whether a wallet error is the person declining is finance/nonce.ts personRefused, the latch's own rule, which the
// screens that send import directly (fix round 1, 2026-10-01: this module's own check knew EIP-1193's code alone, so a
// phone's WalletConnect refusal or a Ledger's was read as an outcome that may be unknown).

/** A token as the page names it: its symbol, or its shortened address when it has none. */
export function currencyName(currency: { address: string; symbol: string | null }): string {
  if (currency.symbol) return currency.symbol
  return /^0x0{40}$/i.test(currency.address) ? 'ETH' : `${currency.address.slice(0, 6)}…${currency.address.slice(-4)}`
}

/**
 * A raw amount in the token's units to six significant digits, cut rather than rounded so an amount received or
 * a minimum is never written larger than it is; never an exponent, trailing zeros dropped. Null when its decimals
 * are unknown, so a figure is never guessed. `exact` has every digit, for a title.
 */
export function amountText(raw: bigint | string, decimals: number | null): { text: string; exact: string } | null {
  const units = formatUnits(String(raw), decimals)
  if (!units || units.kind !== 'units') return null
  const [whole, fraction = ''] = units.text.split('.')
  const lead = whole.replace(/[^0-9]/g, '').replace(/^0+/, '')
  const zeros = /^0*/.exec(fraction)?.[0].length ?? 0
  const places = lead.length >= 6 ? 0 : lead.length > 0 ? 6 - lead.length : zeros + 6
  const kept = fraction.slice(0, places).replace(/0+$/, '')
  return { text: kept ? `${whole}.${kept}` : whole, exact: units.text }
}
