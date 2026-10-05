/**
 * The docs' screenshots (public/docs/<id>.webp, and <id>-phone.webp for a phone's screen): each one's size in pixels
 * and its plain description. Written by scripts/docs-shots.mjs, which takes the pictures from the app's own builds in
 * a made-up world. Do not edit by hand: re-run the script (its header has the command), and commit this file with the images.
 */
export const SHOTS = {
  'markets': { width: 1672, height: 1192, phone: { width: 780, height: 1152 }, alt: 'The Markets page: a table of pools, each with its pair, fee, price, TVL, 24-hour volume and APR.' },
  'pool': { width: 1672, height: 956, phone: { width: 780, height: 971 }, alt: 'A pool’s page: the pair, its fee and the Create a position button at the top, one sentence on what the pool earns, then its APR, 24-hour volume, TVL and price.' },
  'new-pool': { width: 1672, height: 2004, phone: { width: 780, height: 2178 }, alt: 'New position, step 1: a token is typed, the pools that trade it are listed with their figures, and one of them is chosen.' },
  'new-range': { width: 1672, height: 1556, phone: { width: 780, height: 1656 }, alt: 'New position, step 2: today’s price, the choice of how wide the range is, and its lowest and highest price.' },
  'new-amount': { width: 1672, height: 1960, phone: { width: 780, height: 1952 }, alt: 'New position, step 3: how much of each token goes in, beside the wallet’s balance of each, with the slippage tolerance under Advanced.' },
  'positions': { width: 1672, height: 884, phone: { width: 780, height: 1164 }, alt: 'Positions: your positions, one row each, with its pair, whether the price is in range, its value, its fees ready to collect, its own APR and how its fees are used.' },
  'position': { width: 1672, height: 1196, phone: { width: 780, height: 1695 }, alt: 'A position’s page: the pair and its state, its buttons, then what the position is worth, its fees ready to collect, its own APR and the price against its range.' },
  'automate': { width: 1672, height: 1390, phone: { width: 780, height: 1282 }, alt: 'Auto-compound on the Automate page: what it does, its service fee of 2% of the earned fees it uses, and its Set up Auto-compound button.' },
  'receipts': { width: 1672, height: 798, phone: { width: 780, height: 830 }, alt: 'The Receipts card on Positions, once you sign in: a short row for each time automation added a position’s fees back, with what it added back.' },
} as const satisfies Record<string, Shot>

/** A picture's size in pixels (twice its CSS size, for sharp text), its phone picture's, and its plain description. */
export interface Shot {
  readonly width: number
  readonly height: number
  readonly phone?: { readonly width: number; readonly height: number }
  readonly alt: string
}

export type ShotId = keyof typeof SHOTS
