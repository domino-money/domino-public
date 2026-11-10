/**
 * A wallet's referral link (the owner's decision D1, 7 Nov 2026): `https://domino.money/points?ref=<wallet in lower
 * case>`, the same on every host the page is served from, and never changing. The page shows it without its scheme and
 * with the wallet short (the copy rules keep links out of the words); Copy link copies it whole.
 *
 * Pure. Not a copy module: the link is an address, not words (tests/screen-words.test.mjs reads ./words.ts).
 */
import { shortAddress } from './format'

/** The site a referral link names, whichever host serves the page. */
export const REFERRAL_ORIGIN = 'https://domino.money'
export const REFERRAL_HOST = 'domino.money'
export const REFERRAL_PATH = '/points?ref='

/** The link Copy link copies. */
export const referralUrl = (wallet: string): string => `${REFERRAL_ORIGIN}${REFERRAL_PATH}${wallet.toLowerCase()}`

/** The link as the page shows it: `domino.money/points?ref=` and the wallet, short. */
export const shownLink = (wallet: string): { lead: string; wallet: string } => ({
  lead: `${REFERRAL_HOST}${REFERRAL_PATH}`,
  wallet: shortAddress(wallet.toLowerCase()),
})
