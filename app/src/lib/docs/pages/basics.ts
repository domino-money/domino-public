import { CREATE } from '../../create/copy'
import { b, doc, list, note, p, screen } from '../blocks'
// 2026-11-06: Elysium's words where it is live (../elysium.ts).
import { ELYSIUM_LIVE, OTHERS } from '../elysium'
import type { DocPage } from '../types'

export const POOLS: DocPage = {
  slug: 'pools',
  title: 'Pools and fee tiers',
  summary: 'A pool trades two tokens, and every swap through it pays the pool’s fee.',
  sections: [
    {
      id: 'two-tokens',
      title: 'Two tokens, one pool',
      blocks: [
        p('A pool holds two tokens and lets people swap one for the other. Its price is how many of one token buy one of the other.'),
        // Written here, not imported: outside its range a position holds only one of its tokens (see RANGES).
        p('Liquidity is always a pair: the pool trades one asset against the other, and a position in range holds some of each.'),
        p('People who swap are traders. People who supply the two tokens are liquidity providers, and they earn the pool’s fee in return.'),
        note([CREATE.token.nativeNote]),
      ],
    },
    {
      id: 'fee-tiers',
      title: 'Fee tiers',
      blocks: [
        p('A pool’s fee tier is the share of every swap it charges, such as 0.30%. Traders pay it on each trade, and it goes to the pool’s liquidity providers. It is never taken from your deposit.'),
        // Changed on purpose 2026-10-31 (QA round 2 follow-ups, R48): the pool page's own name.
        p('A pool can also carry Uniswap’s protocol fee, taken from what a swap sells into the pool before the fee tier. It does not go to liquidity providers. A pool’s page shows it in Technical details.'),
        // 2026-09-27 (review of 260a76a): pools of one pair and one fee can differ by their other settings.
        p('The same two tokens can have several pools, for example one per fee tier.'),
      ],
    },
    {
      id: 'dynamic-fees',
      title: 'Fixed fees and hooks',
      blocks: [
        // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): only a Uniswap v4 pool can carry a hook.
        p('Most pools charge a fixed fee. A Uniswap v4 pool can also attach a small contract, called a hook, that can change the fee or add rules of its own.'),
        p('Domino works only with pools that have no hook and a fixed fee.'),
      ],
    },
    {
      // 2026-10-04 (the owner: docs revalidated for V2): Domino's new contracts open positions in both kinds of pool.
      id: 'versions',
      title: 'Uniswap v3 and v4',
      blocks: [
        p(`Domino works with two kinds of Uniswap pools, v3 and v4${ELYSIUM_LIVE ? '; Elysium has Uniswap v4 only' : ''}. For you they work the same: two tokens, a fee tier and your range. A position’s Details names its kind.`),
        p('One difference shows: a v3 pool holds WETH, never ETH. ETH you pay with goes in as WETH, and what the range doesn’t use comes back as WETH.'),
      ],
    },
    {
      id: 'pool-identity',
      title: 'A pool is its id',
      blocks: [
        // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): a token is its network and its address.
        p('Anyone can make a token with any name, so a name proves nothing. Domino tells tokens apart by their network and their contract address, and pools by their id, which comes from the two tokens, the fee and the pool’s other settings.'),
      ],
    },
  ],
}

export const RANGES: DocPage = {
  slug: 'ranges',
  title: 'Price ranges',
  summary: 'A position earns trading fees only while the pool price sits inside the range you choose.',
  sections: [
    {
      id: 'price-band',
      title: 'A band of prices',
      blocks: [
        // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): a position's range can be changed later.
        p('A position provides liquidity between a lowest and a highest price: its range. You choose it when you open the position, and can ', doc('change it later', 'manage-position', 'change-range'), '.'),
        // 2026-10-01 (audit E21): as every screen writes a price.
        p('A price here is the pool’s own price between its two tokens, such as 1 ETH = 2,500 USDG, not a dollar price.'),
      ],
    },
    {
      id: 'in-range',
      title: 'In range',
      blocks: [p('While the pool price sits inside the range, a share of every swap fee lands in the position, trade after trade. The position holds some of each token.')],
    },
    {
      id: 'out-of-range',
      title: 'Out of range',
      blocks: [
        // Changed on purpose 2026-10-01 (audit E13): which token, by side.
        p('Outside its range a position holds only one of its two tokens. In an ETH/USDG pool, above the range it holds only USDG; below it, only ETH. It earns no trading fees until the price comes back into range.'),
      ],
    },
    {
      // 2026-10-01 (audit E13): one-sided ranges (lib/create/journey.ts takesOnly).
      id: 'one-sided',
      title: 'A range beside the price',
      blocks: [
        p('A range can sit wholly above or below today’s price. One above starts with only the token being priced, such as ETH, and sells it as the price climbs through the range. One below starts with only the other, such as USDG, and buys as the price falls into it.'),
        // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): Domino swaps what you pay with into that token.
        p('Either earns once the price enters it. New position puts in that one token only, and swaps what you pay with into it when needed.'),
      ],
    },
    {
      id: 'narrow-or-wide',
      title: 'Narrow or wide',
      blocks: [
        p('A narrow range puts all of your tokens to work close to the price, so it earns more from each trade while the price stays inside it. The price also leaves it sooner.'),
        p('A wide range earns less from each trade, and the price stays inside it longer. New position offers ', b('Closer'), ' and ', b('Wider'), ' ranges around the price, or ', b('Custom'), ' for your own.'),
      ],
    },
    {
      id: 'ticks',
      title: 'Ticks',
      blocks: [
        p('Uniswap counts prices in small steps called ticks, each 0.01%. A range starts and ends on a step the pool allows, its tick spacing, so New position may move your prices slightly outward to the nearest one.'),
      ],
    },
    {
      id: 'try-a-range',
      title: 'Try a range',
      blocks: [
        // 2026-09-27 (the owner's round 6, points 3 and 7): the simulator on Home, redone in plain words for beginners, and
        // the pool page's typical range in place of Plan a range.
        p('The ', screen('range simulator on Home', '/#ranges'), ' lets you move the price and see, in plain words, whether a position earns fees and what it holds.'),
        // Changed on purpose 2026-10-31 (QA round 2 follow-ups, R48): the pool page's own name.
        p('On a pool’s page, ', b('Choosing a price range'), ' draws the band New position starts on against that pool’s price. Nothing is saved or sent.'),
      ],
    },
  ],
}

export const EARNED_FEES: DocPage = {
  slug: 'earned-fees',
  title: 'Earned fees',
  summary: 'What a position earns from swaps, where those fees wait, and why they are not profit.',
  sections: [
    {
      id: 'where-fees-come-from',
      title: 'Where fees come from',
      blocks: [
        p('Every swap through a pool pays the pool’s fee tier. A position that is in range when the swap happens earns a share of that fee.'),
        // Who sees it is on Privacy (item I4). RPC-SPEC §11.4.
        p('A position’s page adds up its fees from the chain: those paid out each time they were collected or compounded, read from its own records, and those ready to collect now. Its chart shows measured moments, including about a day and a week ago. Some positions’ Fees earned can’t be measured, such as one whose liquidity changed after it opened; Fees ready to collect is always exact. See ', doc('who sees those reads', 'privacy', 'who-sees'), '.'),
        // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): a position Domino V1's reads do not cover
        // (src/v2in/position/PositionPage.tsx: no dollar value and no APR without a qualified source, decision #22).
        // Changed on purpose 2026-11-06 (O-19): dollars where priced; position-fees, worded to hold before and after it opens.
        p(`Those figures are for positions in Robinhood Chain’s Uniswap v4 pools. On ${OTHERS}, Fees earned and Your APR come from Domino’s own record of a position’s fees, where that record follows it. A position it doesn’t follow, like one in a Robinhood Chain v3 pool, shows its fees ready to collect, in dollars when its tokens have a price.`),
      ],
    },
    {
      id: 'unsettled-fees',
      // 2026-09-27: the product's words (Fees ready to collect beside Position value); the id stays, so links still land.
      title: 'Fees ready to collect',
      blocks: [
        p('Fees a position has earned and you have not collected yet are ready to collect. ', doc('Positions', 'positions', 'position-details'), ' shows them for each of your positions, beside its value: what the position holds.'),
        p(b('Collect fees'), ', on the position’s page, sends them to your wallet. The position stays open and keeps earning.'),
      ],
    },
    {
      id: 'fees-are-not-profit',
      title: 'Fees are not profit',
      blocks: [
        p('A position can collect fees for weeks and still be worth less than holding the assets.'),
        p('As the price moves, a position’s mix of its two tokens changes. Fee income has to cover that gap before a position is ahead of simply holding. See ', doc('Risks', 'risks'), '.'),
      ],
    },
    {
      id: 'what-fees-do-next',
      title: 'What fees can do next',
      blocks: [
        list(
          [b('Plain position'), ': fees wait in the position until you collect them.'],
          [doc('Auto-compound', 'auto-compound'), ': fees go back into the same position.'],
          [doc('Domino-compound', 'domino-compound'), ': near the top of the range, fees open the next position one step higher.'],
        ),
        // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): a change outside automation stops it until the
        // owner turns it back on (spec F7 §1.5, §2.13).
        // Changed on purpose 2026-10-31 (QA round 2 follow-ups, N49): compounding only.
        p('You choose once the position exists, from Automate or the position’s page; automation starts only with its own wallet transactions. With Auto-compound or Domino-compound, collecting a position’s fees, or any other change to it, stops that automation until you turn it back on.'),
      ],
    },
  ],
}
