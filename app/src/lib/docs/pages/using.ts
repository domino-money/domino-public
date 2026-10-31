import { CREATE } from '../../create/copy'
import { b, doc, list, note, p, shot } from '../blocks'
import type { DocPage } from '../types'

export const MARKETS: DocPage = {
  slug: 'markets',
  title: 'Markets',
  summary: 'Browse today’s Robinhood Chain pools, search tokens on Base and Arbitrum One, and understand their figures.',
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
        // Changed on purpose 2026-10-03 (the owner): the table no longer says how many pools are left ("4 of 6 today").
        p('A pool can leave the list during the day, for example when its figures can’t be checked, and some days fewer than six pools pass every check, so the list can be shorter until the next one. ', b('Pinned'), ' marks a pool Domino chose itself. When the list is unavailable, a fixed selection, ', b('Selected pools'), ', takes its place.'),
        shot('markets', 'Each row is a pool. Select it to open the pool’s page.'),
        list(
          [b('Price'), ': the pool’s own price between its two tokens, not a dollar price.'],
          [b('TVL'), ', total value locked: what all the tokens in the pool are worth.'],
          [b('24h volume'), ': how much was traded through the pool over the last day.'],
          [b('APR'), ': the pool’s fees over a year, as a rate, worked out from the last day. It describes the pool, not your position, and is not a promise.'],
        ),
        p('The APR is Domino’s own where its history covers the day, and the estimated APR otherwise. Filter the rows by asset.'),
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
        p('The search at the top finds tokens on Robinhood Chain, Base and Arbitrum One. Search a known token by name, or paste its contract address. Check the network label before choosing.'),
        // 2026-10-01 (items V2, V3, I1).
        p('On Robinhood Chain, a token’s page lists stored and provider-listed pools, each once: today’s list first, then by liquidity. High-fee or unsupported pools stay behind ', b('Show all'), '.'),
        p('On Base and Arbitrum One, the token’s page shows pools verified by Domino’s reader. ', b('New position'), ' keeps the token and network; choose the pool in the next screen.'),
        p('An unavailable lookup does not mean the token does not exist.'),
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
        p(b('Estimate your earnings'), ' works out your share of the pool’s recent fees for an amount you type. ', b('Price range'), ' draws the band New position starts on against the pool’s price. Open ', b('Recent activity'), ' for the last day in words. A pool Domino can’t open positions in says why instead.'),
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

/**
 * Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): New position as it runs on Domino's new contracts
 * (src/v2in/journey): an amount in either token or both, or another token, swapped by Domino when needed; Review's quote
 * from the planning service (sign-in); and Create position as one transaction after any exact approval, Domino's
 * contract keeping nothing. Its sentences are written here: a V1 file never imports src/v2in.
 */
export const NEW_POSITION: DocPage = {
  slug: 'new-position',
  title: 'New position',
  summary: 'Plan a position in four steps, then review and confirm the steps in your wallet.',
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
            { title: CREATE.step.amount.title, body: ['Enter an amount in either token, or both. Domino swaps for you when needed.'] },
            { title: CREATE.step.review.title, body: [CREATE.step.review.lead] },
          ],
        },
        // 2026-09-27 (the owner's round 6, point 8): one flow, wherever it starts; the pool page's button is Create a
        // position (r6/poolpage). 2026-10-04: New position has no network choice (the owner, 2026-10-02).
        // Changed on purpose 2026-10-05 (the owner: the search across the three networks, each result with its network's
        // tag): still no network choice; the search finds tokens on Base and Arbitrum One too.
        p('New position works on Robinhood Chain, Base and Arbitrum One. From a pool’s page, ', b('Create a position'), ' opens these same four steps, with that pool already chosen.'),
      ],
    },
    {
      id: 'step-pool',
      title: 'Pool',
      blocks: [
        shot('new-pool', 'Step 1: choosing the pool.'),
        p('Search by name or contract address, then choose a pool. Check the network; Markets keeps your selection.'),
      ],
      subsections: [
        {
          id: 'new-pool',
          title: 'Create a new pool (advanced)',
          blocks: [
            p('A pool with no price offers ', b('Create a new pool (advanced)'), ': your first deposit sets its price. Confirm that a price differing from the market lets arbitrageurs take the difference from your deposit. Network fees are higher.'),
          ],
        },
      ],
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
        p('Type an amount in either token, or both, and Domino swaps between them to fit your range; or pay with ', b('Another token'), ', such as USDG, ETH or WETH. A range beside today’s price takes its one token only: see ', doc('A range beside the price', 'ranges', 'one-sided'), '. A wallet that can’t fund the position is offered to ', doc('bring funds from another network', 'bring-funds'), '.'),
        // 2026-09-27 (round 6): the tolerance moved under the amount step's Advanced, closed until opened.
        p('Under ', b('Advanced'), ', slippage tolerance is how far the price may move before a step stops. It starts at 0.5%; choose 0.1% to 5%.'),
      ],
    },
    {
      id: 'review',
      title: 'Review',
      blocks: [
        p('Review shows what you put in, any swap Domino makes and its fee, what goes into the position, what comes back to your wallet, and the network fee. Automation is set up afterwards, from Automate, on the position you opened.'),
        p('Its quote needs sign-in and lasts 3 minutes. If the price moves within your slippage, the position can come out smaller and the rest returns to your wallet: Review says by how much at most.'),
      ],
    },
    {
      id: 'create',
      title: 'Create position',
      blocks: [
        p(b('Create position'), ' is the last step: your wallet allows each token for the exact amount, if needed, then one transaction puts your tokens in, makes any swap and sends you the position NFT, with anything the range doesn’t use. Domino’s contract keeps nothing afterwards. Some wallets confirm it all at once: see ', doc('Wallet requests', 'wallet-requests'), '.'),
        p('On Robinhood Chain, Review lists approval, deposit and creation as separate wallet steps.'),
        note(['No Domino fee unless a swap is needed: then 0.65% of the amount swapped, shown on Review. Network gas still applies.']),
      ],
    },
  ],
}

/**
 * 2026-10-04 (the owner: docs revalidated for V2): a deposit from another network, inline in New position's amount step
 * (src/v2in/funds; spec F7 §3): through Relay or Across to the person's own signed-in wallet, 0.35% charged by the
 * bridge, no Domino contract on the way.
 */
export const BRING_FUNDS: DocPage = {
  slug: 'bring-funds',
  title: 'Bring funds from another network',
  summary: 'Move tokens from another network to your own wallet, through a bridge, and use them in a new position.',
  sections: [
    {
      id: 'where',
      title: 'Where it appears',
      blocks: [
        // 2026-10-10: transfer offers follow the position amount; remote funding is optional when local funds cover it.
        p('In the Amount step, Domino shows funds available on other networks. Enter your position amount to check a transfer. If you can already pay on the position’s network, ', b('Use another network'), ' lets you check this option too.'),
        p('Domino checks supported balances on Robinhood Chain, Ethereum, Base, Arbitrum One and OP Mainnet, excluding the position’s network. Transfers need an available route and ETH for fees. Nothing moves until you confirm in your wallet.'),
      ],
    },
    {
      id: 'how',
      title: 'How it works',
      blocks: [
        {
          kind: 'steps',
          items: [
            { title: 'Check your funds', body: ['Domino quotes what your position needs, using one or more networks. Each amount is the maximum to send; network fees are separate. Edit the position amount to change it.'] },
            { title: 'Get a quote', body: ['Domino compares quotes from Relay and Across. The quote shows what you receive, the least you receive, about how long it takes, Domino’s fee and the network fee.'] },
            { title: 'Confirm the transfer', body: ['Select Use these funds, then confirm in your wallet: a token takes an approval of the exact amount and then the deposit, in one confirmation when your wallet can send both together; ETH takes one. Different networks may need separate confirmations.'] },
            { title: 'Continue your position', body: ['The funds arrive in your own wallet on the position’s network. Continue to review any token conversion and confirm the position. The transfer itself does not create it.'] },
          ],
        },
        p('Open ', b('Transfer details'), ' to see the fees and arrival estimate. If the quote expires, select ', b('Update transfer'), ' before continuing. Domino follows transfers already sent, even after a reload or a change of pool.'),
      ],
    },
    {
      id: 'cost',
      title: 'What it costs',
      blocks: [
        p('0.35% of what you deposit, charged by the bridge as Domino’s fee: Relay takes it from what you send, Across from what arrives. Each bridge also charges its own fee, shown in the quote, and each network its gas.'),
        p('You can also bridge with any other service and use Domino with what arrives in your wallet: then Domino charges no bridge fee.'),
      ],
    },
    {
      id: 'refunds',
      title: 'If it doesn’t arrive',
      blocks: [
        p('If a bridge can’t deliver, it refunds you on the network you sent from: Across in full, usually 2.5 to 3 hours after your deposit; Relay minus the refund’s gas. The step says what is happening, and how to reclaim a deposit if an automatic refund fails.'),
      ],
    },
    {
      id: 'your-wallet',
      title: 'Your wallet at both ends',
      blocks: [
        p('The deposit leaves from your signed-in wallet and arrives in the same wallet: no request can name another one, and no Domino contract holds it on the way. A quote needs sign-in.'),
      ],
    },
  ],
}

export const POSITIONS: DocPage = {
  slug: 'positions',
  title: 'Positions',
  summary: 'Your positions on every network and their pages, what you and your automation did, and wallet balances.',
  sections: [
    {
      id: 'your-positions',
      title: 'Your positions',
      blocks: [
        shot('positions', 'Your positions and how their fees are used.'),
        p('Connect your wallet and Positions lists the positions it created with Domino, on any of its networks, read from the chain: there is no ID to type. ', b('Open'), ' positions hold liquidity; ', b('Closed'), ' ones hold none. Position NFTs made elsewhere are not listed.'),
        p('Each row shows the pair, its network, range status, value, fees ready to collect and ', b('Your APR'), ' when its history can be measured. Values use dollars when priced, else tokens.'),
        p('Select a row to open its page and manage its automation. Closed rows keep the history and show any fees still waiting to collect.'),
      ],
    },
    {
      id: 'position-details',
      title: 'A position’s page',
      blocks: [
        shot('position', 'The top of a position’s page.'),
        // 2026-09-27: the page's key figures and order as the owner's round 5 made them (points 2, 4, 5 and 10).
        list(
          ['At the top: the pair, whether it is in range, how its fees are used, and the actions available for this position: see ', doc('Manage a position', 'manage-position'), '.'],
          [b('Position value'), ': what it holds, in each token and, with USDG, in dollars.'],
          [b('Fees ready to collect'), ': earned and not yet collected.'],
          [b('Your APR'), ': this position’s own fees as a yearly rate, from its history. Not the pool’s APR, and not a promise.'],
          [b('Current price'), ': the pool’s price now, on a bar between your range’s two ends.'],
          ['Automation controls sit below the title. Below the figures: price and fee charts, Activity and technical Details.'],
        ),
        p('Zero fees show a flat chart; missing history is never filled with invented values.'),
      ],
    },
    {
      id: 'price-range',
      title: 'The Price range chart',
      blocks: [
        p('One line says first whether the position earns fees: ', b('Earning fees'), ' while the price is inside your range, ', b('Not earning'), ' outside it, with how far the price must move to come back, or ', b('Closed'), '.'),
        p('The band marks ', b('Max'), ' and ', b('Min'), ', with the price ', b('Now'), '. History starts when this position opened, up to 7 days: green inside the range, red outside. Unread history is not filled in. Closed charts stop at the verified closing time, marked ', b('Last'), '.'),
        p('Fees earned offers 24H, 7D and All. A recent position’s periods start at its opening.'),
      ],
    },
    {
      id: 'managed-positions',
      title: 'What automation did',
      blocks: [
        p('Automation is shown with its position. Open the position to set up, pause or stop it, or recover tokens it holds. ', b('Receipts'), ' lists what you and your automation did, each action with its fees and what came back. Once your wallet is connected, select ', b('Receipts'), ' beside New position, or the card’s ', b('See all'), ', for the full list.'),
        shot('receipts', 'Receipts: each time automation added fees back.'),
        p('Public on-chain activity needs no signature. Additional account history may ask you to sign in. A receipt is final only once its network settles it.'),
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

/**
 * 2026-10-04 (the owner: docs revalidated for V2): what a position's page does to it (src/v2in/position, and V1's
 * components/positions/PositionActions.tsx), in the dialogs' own words, and what each costs. Collect fees and Close
 * position moved here from Positions, word for word.
 */
export const MANAGE_POSITION: DocPage = {
  slug: 'manage-position',
  title: 'Manage a position',
  summary: 'Add to a position, change its range, withdraw, collect its fees or close it, from its page.',
  sections: [
    {
      id: 'from-its-page',
      title: 'From a position’s page',
      blocks: [
        p('The available actions are shown below the position’s title: ', b('Collect fees'), ', ', b('Add liquidity'), ', ', b('Change range'), ', ', b('Withdraw'), ', ', doc('Auto-exit', 'auto-exit'), ' and ', b('Close position'), '.'),
        p('Each opens a dialog: your choice, then Review with what you receive, then your wallet. Each action is a single transaction, and Domino’s contract keeps nothing afterwards. No Domino fee unless it needs a swap: then 0.65% of the amount swapped. A quote needs sign-in and lasts 3 minutes.'),
      ],
    },
    {
      id: 'add-liquidity',
      title: 'Add liquidity',
      blocks: [
        p(b('Add liquidity'), ' puts more into the same position and range, in one token or both, or another token: Domino swaps for you when needed. On a Uniswap v4 position, its uncollected fees also go to your wallet.'),
      ],
    },
    {
      id: 'change-range',
      title: 'Change range',
      blocks: [
        p(b('Change range'), ' closes this position and opens a new one, with a new NFT, in the range you choose: ', b('Narrow ±1%'), ', ', b('Medium ±5%'), ' or ', b('Wide ±20%'), ' around today’s price, or ', b('Custom'), '. It moves all of the position, or 50% or 25%, and swaps only when the new range needs it.'),
      ],
    },
    {
      id: 'withdraw',
      title: 'Withdraw',
      blocks: [
        p(b('Withdraw'), ' takes all of a position, or 50% or 25% of it, to your wallet: both tokens, with no Domino fee, or only one, which Domino swaps for you. ', b('You receive'), ' shows what comes to your wallet before you sign.'),
        p('Receiving one token, part may come back unconverted if the price moves within your slippage; Review says how much at most.'),
      ],
    },
    {
      id: 'collect-and-close',
      title: 'Collect fees and close',
      blocks: [
        p(b('Collect fees'), ' sends a position’s earned fees to your wallet; it stays open.'),
        p(b('Close position'), ' sends its tokens and fees to your wallet; the empty NFT stays there.'),
        // 2026-09-27 (review of 260a76a): only Close has a slippage tolerance and an "At least" row (PositionActions.tsx).
        p('Each shows what you receive and the network fee before you sign; Close also shows the least you receive within your slippage tolerance. Neither carries a Domino fee.'),
      ],
    },
    {
      id: 'permission',
      title: 'Domino’s permission',
      blocks: [
        p('To add to a Uniswap v4 position, change a range or withdraw into one token, you first let Domino manage that one position: Domino can manage this position for you when you ask. ', b('Revoke'), ', in its Details, takes that back, and giving it to another app ends Domino’s, and any automation on it.'),
      ],
    },
    {
      id: 'with-automation',
      title: 'With automation on',
      blocks: [
        // 2026-10-30 (QA2 N49): by mode (v2in/position/constants.ts).
        p('While a position is automated, ', b('Change range'), ' isn’t available. With compounding, Add liquidity, Withdraw and Collect fees first ask you to tick that this pauses it; ', b('Turn automation back on'), ' restarts it. With Auto-exit, Collect fees and Withdraw in both tokens leave it on; Add liquidity on Uniswap v4 and Withdraw in one token pause it until you approve the position again.'),
        p('A position Domino-compound opened has no actions of its own until withdrawn from your automation. Withdrawing an automated position leaves its collected fees with your automation, and the page takes you to withdrawing them.'),
      ],
    },
  ],
}
