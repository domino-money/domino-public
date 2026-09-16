import { CREATE } from '../../create/copy'
import { b, doc, list, note, p, screen } from '../blocks'
import type { DocPage } from '../types'

export const POOLS: DocPage = {
  slug: 'pools',
  title: 'Pools and fee tiers',
  summary: 'A pool trades two tokens, and every swap through it pays the pool’s fee tier.',
  sections: [
    {
      id: 'two-tokens',
      title: 'Two tokens, one pool',
      blocks: [
        // Written here, not imported: outside its range a position holds only one of its tokens (see RANGES).
        p('Liquidity is always a pair: the pool trades one asset against the other, and a position in range holds some of each.'),
        p('Swappers trade through the pool. Liquidity providers supply the two tokens those swaps draw on, and earn the pool’s trading fee in return.'),
        note([CREATE.token.nativeNote]),
      ],
    },
    {
      id: 'fee-tiers',
      title: 'Fee tiers',
      blocks: [
        p('A pool’s fee tier is the share of every swap it charges. Swappers pay it to the pool’s liquidity providers, on each trade. It is not a charge on your deposit.'),
        p('A pool can also carry Uniswap’s protocol fee, taken from what a swap sells into the pool before the fee tier. It does not go to liquidity providers. A pool’s page shows it.'),
        p('Pools of the same two tokens can charge different fee tiers. Each pool’s page shows its own.'),
      ],
    },
    {
      id: 'dynamic-fees',
      title: 'Fixed and dynamic fees',
      blocks: [
        p('A fixed fee is the same for every swap. In a pool with a dynamic fee, a hook contract attached to the pool sets the fee instead.'),
        p('Deposits and automation in Domino work with hookless pools that have a fixed fee.'),
      ],
    },
    {
      id: 'pool-identity',
      title: 'A pool is its id',
      blocks: [
        p('A pool is defined by its two tokens, its fee, its tick spacing and its hooks. Together they give the pool its id.'),
        p('Domino identifies a pool by that id, and a token by its contract address on Robinhood Chain. Never by a symbol.'),
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
        p('A position provides liquidity between a lower and an upper price: its range. You choose it when you plan and open the position.'),
        p('A price here is the pool’s own ratio between its two tokens, not a dollar price.'),
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
      id: 'ticks',
      title: 'Ticks',
      blocks: [
        p('Uniswap measures prices in ticks, and each tick is a 0.01% step. A range starts and ends on a tick.'),
        p('Every pool has a tick spacing, and range bounds must be multiples of it. A pool’s page shows its tick spacing, and each step of a range drawn there is one tick spacing.'),
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
      title: 'Unsettled fees',
      blocks: [
        p('Fees a position has earned but not yet collected are its unsettled fees. ', doc('Positions', 'positions', 'position-details'), ' shows them for any position NFT you look up, beside its principal: the liquidity deposited in it.'),
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
          [b('Self-managing'), ': fees wait in the position until you collect them.'],
          [doc('Auto-compound', 'auto-compound'), ': fees go back into the same position.'],
          [doc('Domino-compound', 'domino-compounder'), ': near the top of the range, fees open the next position one step higher.'],
        ),
        p('You record the choice in the Automation step of ', doc('New position', 'new-position'), '; automation starts only with its own wallet transactions.'),
      ],
    },
  ],
}
