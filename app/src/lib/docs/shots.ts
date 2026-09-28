/**
 * The docs' screenshots (public/docs/<id>.webp, and <id>-phone.webp for a phone's screen): each one's size in pixels
 * and its plain description. Written by scripts/docs-shots.mjs, which takes the pictures from the app's own builds in
 * a made-up world. Do not edit by hand: re-run the script (its header has the command), and commit this file with the images.
 */
export const SHOTS = {
  'markets': { width: 1672, height: 1115, phone: { width: 780, height: 1177 }, alt: 'The Markets page: a table of pools, each with its pair, fee, price, TVL, 24-hour volume and APR.' },
  'pool': { width: 1672, height: 2183, phone: { width: 780, height: 2073 }, alt: 'A pool’s page: the pair, its fee and the New position button at the top, the hourly chart of its USD price and volume, then its price, TVL, 24-hour volume, estimated APR and fee tier.' },
  'new-pool': { width: 1672, height: 1980, phone: { width: 780, height: 2128 }, alt: 'New position, step 1: a token is typed, the pools that trade it are listed with their figures, and one of them is chosen.' },
  'new-range': { width: 1672, height: 2036, phone: { width: 780, height: 2352 }, alt: 'New position, step 2: the price range, drawn as a band around the pool’s current price, with its lowest and highest price.' },
  'new-amount': { width: 1672, height: 1832, phone: { width: 780, height: 1904 }, alt: 'New position, step 3: how much of each token goes in, beside the wallet’s balance of each, and the slippage tolerance.' },
  'new-review': { width: 1672, height: 2212, phone: { width: 780, height: 2344 }, alt: 'New position, step 4: the review lists every choice, the steps your wallet asks you to sign, and the Create position button.' },
  'positions': { width: 1672, height: 1040, phone: { width: 780, height: 1296 }, alt: 'Positions: your positions, each with its pair, whether the price is in range, its value and its fees ready to collect, and how its fees are used.' },
  'position': { width: 1672, height: 1143, phone: { width: 780, height: 1373 }, alt: 'A position’s page: the pair and its state, its buttons, then what the position is worth, its fees ready to collect, its own APR and the price against its range.' },
  'automate': { width: 1672, height: 1306, phone: { width: 780, height: 1098 }, alt: 'Auto-compound on the Automate page: what it does, its service fee of 2% of the earned fees it uses, and its Set up Auto-compound button.' },
  'receipts': { width: 1672, height: 798, phone: { width: 780, height: 830 }, alt: 'The Receipts card on Positions, once you sign in: a short row for each time automation re-added a position’s fees, with what it re-added.' },
} as const satisfies Record<string, Shot>

/** A picture's size in pixels (twice its CSS size, for sharp text), its phone picture's, and its plain description. */
export interface Shot {
  readonly width: number
  readonly height: number
  readonly phone?: { readonly width: number; readonly height: number }
  readonly alt: string
}

export type ShotId = keyof typeof SHOTS
