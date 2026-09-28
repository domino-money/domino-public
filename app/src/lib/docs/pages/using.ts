import { CREATE } from '../../create/copy'
import { b, doc, list, note, p, shot } from '../blocks'
import type { DocPage } from '../types'

export const MARKETS: DocPage = {
  slug: 'markets',
  title: 'Markets',
  summary: 'The Uniswap pools you can use on Robinhood Chain, their figures, and a page for each pool.',
  sections: [
    {
      id: 'pools-table',
      title: 'The pools table',
      blocks: [
        p('Markets lists selected Uniswap pools on Robinhood Chain. Once a day, at 12:00 UTC, Domino ranks pools with no hooks, a fixed fee and a minimum 24h volume and liquidity by estimated 24h fee APR; the line under the title states the thresholds. When that list is unavailable, a fixed selection is shown instead. Neither is a recommendation.'),
        shot('markets', 'Each row is a pool. Select it to open the pool’s page.'),
        list(
          [b('Price'), ': the pool’s own price between its two tokens, not a dollar price.'],
          [b('TVL'), ', total value locked: what all the tokens in the pool are worth.'],
          [b('24h volume'), ': how much was traded through the pool over the last day.'],
          [b('APR'), ': the pool’s fees over a year, as a rate, worked out from the last day. It describes the pool, not your position, and is not a promise.'],
        ),
        p('The APR is Domino’s own where its history covers the day, and the estimated APR otherwise. Filter the rows by asset or by pair name.'),
      ],
    },
    {
      id: 'unavailable-figures',
      title: 'Missing figures',
      blocks: [
        p('A figure that cannot be shown as a number shows a dash, Unavailable, Not reported or Not current, never a zero. Hover it to see why.'),
        p('When the read service is busy, the page asks again by itself. ', doc('Figures and sources', 'figures'), ' explains where each figure comes from.'),
      ],
    },
    {
      id: 'find-a-token',
      title: 'Find a token by name',
      blocks: [
        p(b('Search the pool catalogue'), ', under the table, reaches pools beyond the selected ones. Type the name of a token from the selected pools, or paste any token’s contract address.'),
        p('The token is read from chain. ', b('Find pools'), ' then lists its existing pools, each verified on chain.'),
      ],
    },
    {
      id: 'pool-page',
      title: 'A pool’s page',
      blocks: [
        shot('pool', 'A pool’s page: its chart and figures, and New position at the top.'),
        p('A pool’s page shows its price, TVL, 24h volume, APR and fee tier, with 24h fees where Domino history provides them. On request it draws hourly candles of either token’s USD price, with volume.'),
        p('Its details list the pool id, tokens, fee, protocol fee, tick spacing, hooks, 24h volume over TVL and the block the pool was verified at. Where available, the page also shows the pool’s on-chain activity over the last 24 hours and the positions in the pool.'),
        p(b('Plan a range'), ' draws a band against the pool’s price without saving or sending anything. ', b('New position'), ' opens the flow with this pool already chosen.'),
      ],
    },
  ],
}

export const NEW_POSITION: DocPage = {
  slug: 'new-position',
  title: 'New position',
  summary: 'Plan a position in four steps, then create it with your wallet.',
  sections: [
    {
      id: 'four-steps',
      title: 'Four steps',
      blocks: [
        {
          kind: 'steps',
          items: [
            { title: CREATE.step.pool.title, body: [CREATE.step.pool.lead] },
            { title: CREATE.step.range.title, body: [CREATE.step.range.lead] },
            { title: CREATE.step.amount.title, body: [CREATE.step.amount.lead] },
            { title: CREATE.step.review.title, body: [CREATE.step.review.lead] },
          ],
        },
      ],
    },
    {
      id: 'step-pool',
      title: 'Pool',
      blocks: [
        shot('new-pool', 'Step 1: choosing the pool.'),
        p('Type a token’s name or paste its address, then choose a pool. Only pools without hooks and with a fixed fee are listed, largest TVL first.'),
      ],
    },
    {
      id: 'step-range',
      title: 'Range',
      blocks: [
        shot('new-range', 'Step 2: the band is your range; the dotted line is the price now.'),
        p(b('Closer'), ' and ', b('Wider'), ' are ready-made ranges around the pool’s price; ', b('Custom'), ' takes your own lowest and highest price. See ', doc('Price ranges', 'ranges'), '.'),
      ],
    },
    {
      id: 'step-amount',
      title: 'Amount',
      blocks: [
        shot('new-amount', 'Step 3: the amounts and the slippage tolerance.'),
        p('Type an amount of either token; the other follows from your range and the pool’s price.'),
        p('Slippage tolerance is how far the price may move against you before a step stops instead of going through. It starts at 0.5%; choose 0.1% to 5%.'),
      ],
    },
    {
      id: 'review',
      title: 'Review',
      blocks: [
        p('Review lists every choice and the wallet steps in order. The steps are what your wallet signs when you press Create position: any approval, the deposit, then the position. Automation is set up afterwards, from Automate, on the position you opened.'),
        shot('new-review', 'Step 4: your choices, then the steps your wallet asks you to sign.'),
        p('If your wallet holds only one of the two tokens, part of it is swapped for the other inside the same pool before the position is created: one more signature, and the pool’s fee and Domino’s assisted-swap fee (0.65%) on the swapped part. Review shows how much is swapped before you sign.'),
      ],
    },
    {
      id: 'create',
      title: 'Create position',
      blocks: [
        p(b('Create position'), ' is the last step. It needs your wallet connected on Robinhood Chain, and no sign-in.'),
        p('Your wallet asks you to sign, in order: an approval for each token it has not yet allowed, the deposit of both tokens (or of the one your wallet holds, then the swap of part of it inside the pool), and the position itself. Some wallets sign them all at once. With one token, the pool is checked first: if it cannot swap part of your deposit, Create position says so before anything is deposited.'),
        p('When the position exists, you choose what its fees do. If a deposit went through and the position did not, pressing Create position again finishes it from that deposit, never depositing twice; the deposit can also be refunded.'),
        note(['Positions are created in hookless pools that have a fixed fee. A direct position carries no Domino percentage fee, except the assisted-swap fee on the part swapped when your wallet holds one token; network gas still applies.']),
      ],
    },
  ],
}

export const POSITIONS: DocPage = {
  slug: 'positions',
  title: 'Positions',
  summary: 'Your positions and a page for each, collecting fees and closing, what automation did, and your wallet’s balances.',
  sections: [
    {
      id: 'your-positions',
      title: 'Your positions',
      blocks: [
        shot('positions', 'Your positions, and how each one’s fees are used.'),
        p('Connect your wallet on Robinhood Chain and Positions lists the positions it created with Domino, read from the chain for your address: there is no ID to type, and nothing is kept in your browser. ', b('Open'), ' positions still hold liquidity; ', b('Closed'), ' ones hold none. Position NFTs made elsewhere are not listed.'),
        // 2026-09-27 (the owner's point 6): the product's plain words, Value and Fees ready to collect, once Principal and Unclaimed fees.
        p('Each row shows the pair, whether the price is in range, its value and its fees ready to collect. The list updates itself every 30 seconds; select a row to open its page.'),
        p('Each open row also says how its fees are used; ', b('Automate'), ' on a plain one sets up automation. Deposits that never became a position are listed too, each with its refund.'),
      ],
    },
    {
      id: 'position-details',
      title: 'A position’s page',
      blocks: [
        shot('position', 'The top of a position’s page.'),
        // 2026-09-27: the page's key figures and order as the owner's round 5 made them (points 2, 4, 5 and 10).
        list(
          ['At the top: the pair, whether it is in range, how its fees are used, and its buttons.'],
          [b('Position value'), ': what it holds, in each token and, with USDG, in dollars.'],
          [b('Fees ready to collect'), ': fees earned and not yet collected.'],
          [b('Your APR'), ': this position’s own fees as a yearly rate, from its history. Not the pool’s APR, and not a promise.'],
          [b('Current price'), ': the pool’s price now, on a bar between the two ends of your range.'],
          ['Further down: its fees over time, its price against its range, its activity and, closed at the end, its technical details.'],
        ),
        p('With automation, its Fees earned card says how much was added back, and the chart marks each time. No sign-in is needed.'),
        p('The page updates itself every minute. Everything on it is public chain data.'),
      ],
    },
    {
      id: 'collect-and-close',
      title: 'Collect fees and close',
      blocks: [
        p(b('Collect fees'), ' sends a position’s earned fees to your wallet. The position stays open.'),
        p(b('Close position'), ' sends all of its tokens and their fees to your wallet. The empty position NFT stays in your wallet.'),
        // 2026-09-27 (review of 260a76a): only Close has a slippage limit and an "At least" row (PositionActions.tsx).
        p('Each shows what you receive and the network fee before your wallet asks you to sign; Close also shows the least you receive within your slippage limit. Collecting fees or closing stops Domino automation for that position.'),
      ],
    },
    {
      id: 'managed-positions',
      title: 'What automation did',
      blocks: [
        // 2026-09-27: the two cards as round 5 made them (short rows, See all on a page of their own). A position's own page
        // shows what automation added back without sign-in (position-details, above).
        p('Sign in, and Positions adds two cards. ', b('Managed positions'), ' shows each position under automation over the last 24 hours. ', b('Receipts'), ' lists each automation run and what it re-added; ', b('See all'), ' opens every receipt on a page of its own.'),
        shot('receipts', 'Receipts: each time automation re-added a position’s fees.'),
        p('A receipt shows Done only once the chain has settled its transaction.'),
        p(b('Managed positions'), ' also lists your wallet’s automations, each with ', b('Start tracking'), ': it records how one does from then on, and grants no permission.'),
      ],
    },
    {
      id: 'wallet-balances',
      title: 'Wallet balances',
      blocks: [p('The Wallet card lists the token balances of the connected wallet, or of any address you enter. Balances are public data, not proof of wallet control.')],
    },
  ],
}
