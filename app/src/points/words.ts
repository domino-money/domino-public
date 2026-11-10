/**
 * Every word the Points page says (added 2026-11-07, the owner's Points page, Season 1): the words he approved in
 * integ-logs/points/PROPOSAL.md §3 (checked there by mock/check-words.mjs) and the chosen design's, direction C
 * "Corrente" (integ-logs/points/directions/data.mjs). A copy module: tests/screen-words.test.mjs reads every string of
 * it. No link is written here (the referral link is built in ./link.ts); no word says the page is not ready.
 */
import type { PointsErrorCode } from 'api-contracts/points-v1/types'

/** The kinds of Domino fee that earn points, in the app's own names (lib/create/copy.ts, the docs' Fees page). */
export type FeeKind = 'assistedSwap' | 'automation' | 'autoExit' | 'bridge'

export const POINTS_WORDS = {
  title: 'Points',
  tab: 'Points',
  chip: 'Connected wallet',

  // The line of play (Corrente): your referrer, you, the wallets you referred.
  lineLabel: 'Your referral line',
  yourReferrer: 'Your referrer',
  referrerToCome: 'The wallet whose link you open',
  invited: 'invited you',
  notLinked: 'Not linked yet',
  you: 'You',
  fromUse: (amount: string) => `${amount} from using Domino`,
  countingStarts: 'Counting starts 9 Nov',
  joined: (count: number) => `${count} ${count === 1 ? 'wallet' : 'wallets'} joined with your link`,
  referralPoints: (amount: string) => `+${amount} points`,
  joinHere: 'Wallets you refer join here',
  joinShare: '10% of their points, on top of yours',

  // The total.
  unit: 'points',
  totalTitle: (exact: string) => `${exact} points`,
  rule: 'Each wallet adds 10% of its points from use to the wallet that referred it, and keeps all of its own.',
  zero: 'Use Domino to earn points: an assisted swap, automation, Auto-exit or a deposit from another network.',
  zeroAction: 'New position',

  // Before 9 Nov, 00:00 UTC (and while the service is off before it: decision D4).
  // No break inside the date or the time (the prototype's line breaks: 'Season 1 starts / 9 Nov at 00:00 UTC.').
  starts: 'Season 1 starts 9 Nov at 00:00 UTC.',
  startsBody: 'From then on, every Domino fee your wallet pays earns points, counted every hour. Your link works already.',
  // After 9 Nov, before the first count reaches this wallet.
  started: 'Season 1 has started.',
  startedBody: 'Points are counted every hour from 9 Nov, 00:00 UTC. Yours show here after the next count.',
  // The service off after 9 Nov.
  off: 'Points can’t be shown right now.',
  offBody: 'Every Domino fee from 9 Nov 2026, 00:00 UTC counts toward them, so nothing is missed.',

  // Signed out.
  connectLead: 'Connect a wallet to see your points.',
  signInLead: 'Sign in to see your points.',
  sessionEnded: 'Your sign-in ended. Sign in again to see your points.',
  signInNote: 'Signing in is a free message, not a transaction. Your points belong to your wallet address, on any device.',
  connect: 'Connect wallet',
  signIn: 'Sign in',
  howItWorks: 'How Domino works',

  // Your link.
  yourLink: 'Your link',
  copy: 'Copy link',
  copied: 'Copied',
  copyLabel: 'Copy your referral link',

  // Link your referrer.
  linkTitle: 'Link your referrer',
  linkBody: 'You opened a referral link from',
  linkBodyRest: 'Linking adds 10% of your points from using Domino to theirs. You keep all of yours.',
  linkNote: 'Your wallet asks you to sign a message. It’s free, approves no transaction, and the link stays for all of Season 1.',
  linkAction: 'Link referrer',
  linkBusy: 'Waiting for your wallet…',
  linkLater: 'Not now',
  // The service off (or not answering): linking opens with the count; the referrer's share counts from the start anyway
  // (backend/points_season_1.json referral.countsFrom, PROPOSAL.md §6 step 6).
  linkWhenCounted: 'Linking opens when points are counted. Their 10% counts from 9 Nov, 00:00 UTC, whenever the link is made.',
  invitedSignIn: 'Sign in to link them as your referrer.',
  linkedTitle: 'Referrer linked',
  linkedTo: 'Linked to',
  linkedRest: 'It stays for all of Season 1.',
  existingIs: 'Your referrer is',
  existingRest: 'A wallet’s first link stays for all of Season 1.',
  declined: 'Nothing was signed, so nothing was linked.',

  // What earned them.
  earnedBy: 'What earned them',
  kinds: { assistedSwap: 'Assisted swaps', automation: 'Automation', autoExit: 'Auto-exit', bridge: 'Deposits from another network' } satisfies Record<FeeKind, string>,
  inFees: (amount: string) => `${amount} in fees`,
  counted: (clock: string) => `Counted every hour, last at ${clock}.`,
  seasonLine: (day: number | null) => `Season 1: 9 Nov 2026 to 9 Feb 2027${day === null ? '' : `, day ${day} of 92`}.`,

  // Season 1 (every state).
  seasonTitle: 'Season 1',
  seasonDates: '9 Nov 2026 to 9 Feb 2027',
  ways: [
    ['Use Domino', '1,000 points for every $1 in fees'],
    ['Refer a wallet', 'Plus 10% of its points from use'],
  ] as const,
  detailsTitle: 'How points are counted',
  // The docs' Points page has the whole of it (lib/docs/pages/points.ts): the rail stays short (the owner, 7 Nov).
  docsLink: 'How points work',
  details: [
    ['Assisted swap', '0.65% of the amount swapped'],
    ['Automation', 'Auto-compound 2%, Domino-compound 4% of the earned fees it uses'],
    ['Auto-exit', '0.2% of the position’s value, counted when that fee is $0.10 or more'],
    ['Deposit from another network', '0.35% of the amount deposited'],
    ['Each fee', 'Valued in US dollars when it is charged, less the network cost Domino paid to carry it out. 1,000 points per $1'],
    ['Season window', '9 Nov 2026, 00:00 UTC to 9 Feb 2027, 00:00 UTC'],
  ] as const,
  rulesHash: 'Rules (SHA-256)',
  countHash: 'Last count (SHA-256)',

  // A problem, in one quiet line.
  unavailable: 'Points can’t be loaded right now. Try again in a minute.',
  retry: 'Try again',
} as const

/** What a refusal of the points service means on the page (PROPOSAL.md §3 h). */
export type PointsProblem =
  /** One quiet line under the button that was pressed. */
  | { kind: 'line'; text: string }
  /** The service can't answer now: the line, and Try again. */
  | { kind: 'retry'; text: string }
  /** The sign-in ended: back to signing in, with its line. */
  | { kind: 'session'; text: string }

const REFERRAL_WORDS: Partial<Record<PointsErrorCode, string>> = {
  referral_self: 'You can’t refer yourself.',
  referral_wallet_excluded: 'This wallet can’t take part in referrals.',
  referral_season_closed: 'Season 1 has ended, so referrals are closed.',
  referral_message_not_fresh: 'The signature expired. Sign again to link.',
  referral_signature_invalid: 'The signature doesn’t match the connected wallet. Sign again with the same wallet.',
  referral_signature_mismatch: 'The signature doesn’t match the connected wallet. Sign again with the same wallet.',
}

/** The session's own refusals: the sign-in is gone, or belongs to another account, or cannot be used here. */
const SESSION_CODES: ReadonlySet<string> = new Set(['session_required', 'csrf_invalid', 'account_unsupported', 'preview_expired'])

/**
 * The page's words for a refusal: a code of the contract's, or the transport's own ending (`network`, `timeout`,
 * `contract`: an answer outside the contract, `off`: no points route answered).
 */
export function problemOf(code: string): PointsProblem {
  const referral = (REFERRAL_WORDS as Record<string, string | undefined>)[code]
  if (referral) return { kind: 'line', text: referral }
  if (SESSION_CODES.has(code)) return { kind: 'session', text: POINTS_WORDS.sessionEnded }
  return { kind: 'retry', text: POINTS_WORDS.unavailable }
}
