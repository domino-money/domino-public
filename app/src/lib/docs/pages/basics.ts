import { CREATE } from '../../create/copy'
import { b, doc, list, note, p, screen } from '../blocks'
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
        p('A pool can also carry Uniswap’s protocol fee, taken from what a swap sells into the pool before the fee tier. It does not go to liquidity providers. A pool’s page shows it.'),
        // 2026-09-27 (review of 260a76a): pools of one pair and one fee can differ by their other settings.
        p('The same two tokens can have several pools, for example one per fee tier.'),
      ],
    },
    {
      id: 'dynamic-fees',
      title: 'Fixed fees and hooks',
      blocks: [
        p('Most pools charge a fixed fee. Some attach a small contract, called a hook, that can change the fee or add rules of its own.'),
        p('Domino works only with pools that have no hook and a fixed fee.'),
      ],
    },
    {
      id: 'pool-identity',
      title: 'A pool is its id',
      blocks: [
        p('Anyone can make a token with any name, so a name proves nothing. Domino tells tokens apart by their contract address on Robinhood Chain, and pools by their id, which comes from the two tokens, the fee and the pool’s other settings.'),
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
        p('A position provides liquidity between a lowest and a highest price: its range. You choose it when you open the position.'),
        p('A price here is the pool’s own price between its two tokens, such as 2,500 USDG per ETH, not a dollar price.'),
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
        p('Outside its range a position holds only one of its two tokens: the one that lost value against the other. It earns no trading fees until the price comes back into range.'),
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
        p('The ', screen('range simulator on Home', '#/#ranges'), ' lets you move the price across a range and see what a position would hold.'),
        p('On a pool’s page, ', b('Plan a range'), ' draws a band against that pool’s price. Nothing is saved or sent.'),
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
      blocks: [p('Every swap through a pool pays the pool’s fee tier. A position that is in range when the swap happens earns a share of that fee.')],
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
          [doc('Domino-compound', 'domino-compounder'), ': near the top of the range, fees open the next position one step higher.'],
        ),
        p('You choose once the position exists, when Create position finishes or later from Automate; automation starts only with its own wallet transactions. Collecting a position’s fees or closing it stops its automation.'),
      ],
    },
  ],
}
