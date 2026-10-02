import { CREATE } from '../../create/copy'
import { b, doc, list, note, p, shot } from '../blocks'
import type { DocPage } from '../types'

export const MARKETS: DocPage = {
  slug: 'markets',
  title: 'Markets',
  summary: 'The Uniswap pools you can use on Robinhood Chain, their figures, and how to find any token’s pools.',
  sections: [
    {
      id: 'pools-table',
      title: 'The pools table',
      blocks: [
        // 2026-09-28: the line under the table's title that stated the thresholds was removed (the owner), so this no
        // longer points to it. Later that day the list's rules became featured-policy v2 (rugged's handoff): today's
        // APR, a 24h volume floor and a TVL floor, and the safety rules; no other market rule. The floors are named but
        // not stated, in symbols or in words: the owner took the figures off Markets, and the pictured list below is not
        // held to them (tests/docs.test.mjs).
        p('Markets lists selected Uniswap pools on Robinhood Chain. Once a day, at 12:00 UTC, Domino ranks pools by estimated 24h fee APR. A pool needs no hooks, a fixed fee, tokens that pass Domino’s checks, and enough 24h volume and TVL. The list is not a recommendation.'),
        // 2026-10-01 (audit E14, B1, B5).
        p('A pool can leave the list during the day, for example when its figures can’t be checked, and its place stays empty until the next one: the title then says how many are left, such as 4 of 6 today. ', b('Pinned'), ' marks a pool Domino chose itself. When the list is unavailable, a fixed selection, ', b('Selected pools'), ', takes its place.'),
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
        // Changed on purpose 2026-10-01 (live note L12, fix round 1): a phone has no hover.
        p('A figure that cannot be shown as a number shows a dash, Unavailable, Not reported or Not current, never a zero. Its title says why; on a phone, so does the info button at the end of a row that has one.'),
        // 2026-10-01 (item V1).
        p('When the read service is busy, the page asks again by itself. Meanwhile an earlier figure, or a second market data provider’s, may stand in, with its source and time in its title. See ', doc('Figures and sources', 'figures'), '.'),
      ],
    },
    {
      id: 'find-a-token',
      title: 'Find a token’s pools',
      blocks: [
        // Changed on purpose 2026-10-01 (audit E19, live note L12): no Find pools button; any name works.
        p(b('Search the pool catalogue'), ', under the table, reaches every other pool. Type a token’s name or paste its address; its pools are listed, each verified on chain.'),
        // 2026-10-01 (items V2, V3, I1).
        p('A token’s page lists the pools Domino stores and those a market data provider lists, each once: today’s list first, then by liquidity. Pools with a very high fee, or that Domino can’t open positions in, are flagged and kept behind ', b('Show all'), '.'),
        p('Anyone can name a token anything. Tokens that share a name show their liquidity and say so, and one posing as USDG, WETH or ETH is called out; a pool holding one shows a warning instead of ', b('Create a position'), '.'),
      ],
    },
  ],
}

/** A pool's page, its own docs page since 2026-10-01, so Markets keeps to its 450 words. */
export const POOL_PAGE: DocPage = {
  slug: 'pool-page',
  title: 'A pool’s page',
  summary: 'What a pool earns, its figures and price, an estimate for an amount you type, and its technical details.',
  sections: [
    {
      id: 'pool-page',
      title: 'At the top',
      blocks: [
        // 2026-09-27 (the owner's round 6, points 7 and 8): the page reworked for beginners, what matters on top and the
        // technical facts in Details; its Create a position opens the same New position flow as everywhere else.
        // 2026-09-28 (round 6 review): the estimate shares the pool's fees with the money already in it, and a pool
        // Domino can't open positions in has no estimate or typical range.
        shot('pool', 'A pool’s page: what the pool earns and its key figures, with Create a position at the top.'),
        p('A pool’s page opens with one sentence on what the pool is and what it earns, then its APR, 24h volume, TVL and price, with 24h fees where Domino history provides them, and a chart of its price from its own swaps.'),
        p(b('Create a position'), ' opens the same four steps of New position as anywhere else, with this pool already chosen.'),
      ],
    },
    {
      id: 'estimates',
      title: 'Estimates and activity',
      blocks: [
        p(b('Estimate your earnings'), ' works out your share of the pool’s recent fees for an amount you type. ', b('A typical range'), ' draws the band New position starts on against the price now. ', b('Recent activity'), ' says the last day in words. A pool Domino can’t open positions in says why instead.'),
      ],
    },
    {
      id: 'pool-details',
      title: 'Details',
      blocks: [
        p(b('Details'), ', closed until opened, lists the pool id, tokens, fees, tick spacing, hooks, where the figures come from and the block the pool was verified at.'),
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
        // 2026-09-27 (the owner's round 6, point 8): one flow, wherever it starts; the pool page's button is Create a
        // position (r6/poolpage).
        p('From a pool’s page, ', b('Create a position'), ' opens these same four steps, with that pool already chosen.'),
      ],
    },
    {
      id: 'step-pool',
      title: 'Pool',
      blocks: [shot('new-pool', 'Step 1: choosing the pool.')],
    },
    {
      id: 'step-range',
      title: 'Range',
      blocks: [
        shot('new-range', 'Step 2: pick how wide your range is; its lowest and highest price show under it.'),
        p(b('Closer'), ' and ', b('Wider'), ' are ready-made ranges around the pool’s price; ', b('Custom'), ' takes your own lowest and highest price. See ', doc('Price ranges', 'ranges'), '.'),
      ],
    },
    {
      id: 'step-amount',
      title: 'Amount',
      blocks: [
        shot('new-amount', 'Step 3: the amounts; slippage is under Advanced.'),
        // Changed on purpose 2026-10-01 (audit E13).
        p('Type an amount of either token; the other follows from your range. A range beside today’s price asks for its one token only: see ', doc('A range beside the price', 'ranges', 'one-sided'), '.'),
        // 2026-09-27 (round 6): the tolerance moved under the amount step's Advanced, closed until opened.
        p('Under ', b('Advanced'), ', slippage tolerance is how far the price may move before a step stops. It starts at 0.5%; choose 0.1% to 5%.'),
      ],
    },
    {
      id: 'review',
      title: 'Review',
      blocks: [
        p('Review lists every choice and the wallet steps in order. The steps are what your wallet signs when you press Create position: any approval, the deposit, then the position. Automation is set up afterwards, from Automate, on the position you opened.'),
        shot('new-review', 'Step 4: your choices, then the steps your wallet asks you to sign.'),
        // Changed on purpose 2026-10-01 (audit E20).
        p('If your wallet holds only one of the two tokens, part of it is swapped for the other first, in the same pool or through Uniswap where that gets more: one more signature, and the pool’s fee and Domino’s assisted-swap fee (0.65%) on the swapped part. Review shows how much is swapped before you sign.'),
      ],
    },
    {
      id: 'create',
      title: 'Create position',
      blocks: [
        p(b('Create position'), ' is the last step. It needs your wallet on Robinhood Chain, and no sign-in.'),
        p('Your wallet asks you to sign, in order: an approval for each token it has not yet allowed, the deposit of both tokens (or of the one your wallet holds, then the swap of part of it inside the pool), and the position itself. Some wallets sign all at once: see ', doc('Wallet requests', 'wallet-requests', 'all-at-once'), '. With one token, the pool is checked first: if it cannot swap part of your deposit, Create position says so before anything is deposited.'),
        p('When the position exists, you choose what its fees do. If a deposit went through and the position did not, pressing Create position again finishes it from that deposit, never depositing twice; the deposit can also be refunded.'),
        note(['A direct position carries no Domino percentage fee, except the assisted-swap fee on the part swapped when your wallet holds one token; network gas still applies.']),
      ],
    },
  ],
}

export const POSITIONS: DocPage = {
  slug: 'positions',
  title: 'Positions',
  summary: 'Your positions and their pages, collecting fees, closing, what automation did, and wallet balances.',
  sections: [
    {
      id: 'your-positions',
      title: 'Your positions',
      blocks: [
        shot('positions', 'Your positions and how their fees are used.'),
        // 2026-09-28: the list shows this browser's copy of it at once while the chain is read (OwnedPositions.tsx).
        p('Connect your wallet on Robinhood Chain and Positions lists the positions it created with Domino, read from the chain: there is no ID to type, and only this browser keeps a copy, for a day. ', b('Open'), ' positions hold liquidity; ', b('Closed'), ' ones hold none. Position NFTs made elsewhere are not listed.'),
        // 2026-09-27 (the owner's point 6): the product's plain words, Value and Fees ready to collect, once Principal and Unclaimed fees.
        // Changed on purpose 2026-10-01 (audit E15, item A18); RPC-SPEC §11.4.
        p('Each row shows the pair, whether the price is in range, its value, its fees ready to collect and ', b('Your APR'), ' since it opened, or “on its page”. It updates every 30 seconds; select a row to open its page.'),
        p('Open rows also say how their fees are used, or offer ', b('Automate'), '. Deposits that never became a position are listed too, with their refund.'),
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
          [b('Fees ready to collect'), ': earned and not yet collected.'],
          [b('Your APR'), ': this position’s own fees as a yearly rate, from its history. Not the pool’s APR, and not a promise.'],
          [b('Current price'), ': the pool’s price now, on a bar between your range’s two ends.'],
          ['Further down: its fees over time, price against its range, activity and, closed, technical details.'],
        ),
        p('With automation, its Fees earned card says how much was added back, and the chart marks each time. No sign-in is needed.'),
        p('The page updates every minute; everything on it is public chain data.'),
      ],
    },
    {
      id: 'collect-and-close',
      title: 'Collect fees and close',
      blocks: [
        p(b('Collect fees'), ' sends a position’s earned fees to your wallet; it stays open.'),
        p(b('Close position'), ' sends its tokens and fees to your wallet; the empty NFT stays there.'),
        // 2026-09-27 (review of 260a76a): only Close has a slippage tolerance and an "At least" row (PositionActions.tsx).
        p('Each shows what you receive and the network fee before you sign; Close also shows the least you receive within your slippage tolerance. Collecting fees or closing stops that position’s Domino automation.'),
      ],
    },
    {
      id: 'managed-positions',
      title: 'What automation did',
      blocks: [
        // 2026-09-27: the two cards as round 5 made them (short rows, See all on a page of their own). A position's own page
        // shows what automation added back without sign-in (position-details, above). Round 6, point 1: one phrase for it
        // everywhere, "Fees added back". Changed on purpose 2026-10-01 (audit E15, D2).
        p(b('Managed positions'), ' and ', b('Receipts'), ' fill in once you sign in and have automation; until then, one line stands for both. Managed positions shows each automated position over the last 24 hours. Receipts lists each automation run and the fees it added back; ', b('See all'), ' opens every receipt on a page of its own.'),
        shot('receipts', 'Receipts: each time automation added fees back.'),
        p('A receipt shows Done only once the chain has settled its transaction.'),
        p(b('Managed positions'), ' also lists your wallet’s automations, each with ', b('Start tracking'), ': it records how one does from then on, and grants no permission.'),
      ],
    },
    {
      id: 'wallet-balances',
      title: 'Wallet balances',
      // Round 6 (2026-09-27): every token in dollars, the three largest first (the owner's rule).
      // 2026-10-01 (audit V7). Changed on purpose 2026-10-01 (integration pass 3): "read-only" is a word the docs never use
      // (tests/docs.test.mjs, the words); what it meant, said plainly.
      blocks: [p('The Wallet card shows the tokens of the connected wallet, or any address, in dollars: the three largest first, the rest under ', b('Show all'), '. ', b('View address'), ' also lists that address’s positions, just to look at. Balances are public data.')],
    },
  ],
}
