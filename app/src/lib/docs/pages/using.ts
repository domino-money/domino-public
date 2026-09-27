import { CREATE } from '../../create/copy'
import { b, doc, list, note, p } from '../blocks'
import type { DocPage } from '../types'

export const MARKETS: DocPage = {
  slug: 'markets',
  title: 'Markets',
  summary: 'Uniswap pools on Robinhood Chain, their figures, and a page for each pool.',
  sections: [
    {
      id: 'pools-table',
      title: 'The pools table',
      blocks: [
        p('Markets lists selected Uniswap pools on Robinhood Chain. Once a day, at 12:00 UTC, Domino ranks pools with no hooks, a fixed fee and a minimum 24h volume and liquidity by estimated 24h fee APR; the line under the title states the thresholds. When that list is unavailable, a fixed selection is shown instead. Neither is a recommendation.'),
        p('Each row shows a pool’s price, TVL, 24h volume and APR, and opens the pool’s page. The APR is Domino’s own where its history covers the day, and the estimated APR otherwise. Filter the rows by asset or by pair name.'),
        p('Price is the pool’s own ratio between its two tokens, not a dollar price.'),
      ],
    },
    {
      id: 'unavailable-figures',
      title: 'Missing figures',
      blocks: [
        p('A figure that cannot be shown as a number shows a dash, Unavailable, Not reported or Not current, never a zero. Hover it to see why.'),
        p('A provider’s figure names its source and how long ago it was retrieved, and a price names the block it was read at. ', doc('Figures and sources', 'figures'), ' explains each kind.'),
        p('When the read service is busy, the page asks again by itself.'),
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
            { title: CREATE.step.pool.title, body: [CREATE.step.pool.lead, ' Only pools without hooks and with a fixed fee are listed, largest TVL first, each with its TVL, 24h volume and estimated APR.'] },
            { title: CREATE.step.range.title, body: [CREATE.step.range.lead, ' See ', doc('Price ranges', 'ranges'), '.'] },
            { title: CREATE.step.amount.title, body: [CREATE.step.amount.lead, ' A position holds both of the pool’s tokens, so the step shows a row for each: type an amount in either and the other follows from your range and the pool’s price. There is no choice of which token to deposit. The slippage tolerance is chosen here too: 0.1%, 0.5% or 1% as presets, or any exact hundredth of a percent from 0.1% to 5%. It starts at 0.5%, and above 1% the step says what that allows.'] },
            { title: CREATE.step.review.title, body: [CREATE.step.review.lead] },
          ],
        },
      ],
    },
    {
      id: 'review',
      title: 'Review',
      blocks: [
        p('Review lists every choice and the wallet steps in order. The steps are what your wallet signs when you press Create position: any approval, the deposit, then the position. Automation is set up afterwards, from Automate, on the position you opened.'),
        p('If your wallet holds only one of the two tokens, part of it is swapped for the other inside the same pool before the position is created: one more signature, and the pool’s fee and Domino’s assisted-swap fee (0.65%) on the swapped part. Review shows how much is swapped before you sign.'),
      ],
    },
    {
      id: 'create',
      title: 'Create position',
      blocks: [
        p(b('Create position'), ' is the last step. It needs your wallet connected on Robinhood Chain, and no sign-in.'),
        p('Your wallet asks you to sign, in order: an exact approval for each token whose allowance is short, the deposit of both tokens (or of the one your wallet holds, then the swap of part of it inside the pool), and the position itself. The deployment is checked on chain before each step, and each transaction is read back before the next one is asked for. With one token, the pool is checked first: if it cannot swap part of your deposit, Create position says so before anything is deposited.'),
        p('When the position exists, Review offers to open it on Positions or to set up its automation. If a deposit went through and the position did not (a declined signature, a closed tab), pressing Create position again creates it from that deposit, never depositing twice; the deposit can also be refunded.'),
        note(['Positions are created in hookless pools that have a fixed fee. A direct position carries no Domino percentage fee, except the assisted-swap fee on the part swapped when your wallet holds one token; network gas still applies.']),
      ],
    },
  ],
}

export const POSITIONS: DocPage = {
  slug: 'positions',
  title: 'Positions',
  summary: 'The positions you created with Domino, open and closed, a page for each, and your managed positions, receipts and wallet balances.',
  sections: [
    {
      id: 'your-positions',
      title: 'Your positions',
      blocks: [
        p('Connect your wallet on Robinhood Chain and Positions lists the positions it created with Domino, read from the chain for your address: there is no ID to type, and nothing is kept in your browser. ', b('Open'), ' positions still hold liquidity; ', b('Closed'), ' ones hold none. Position NFTs made elsewhere are not listed.'),
        p('Each row shows the pool and its fee tier, whether the pool price is inside the range, the principal and the fees not yet collected. Select a row to open the position’s own page.'),
        p('Under an open row: its feature, Plain position, Auto-compound or Domino-compound, and whether its sequence is paused. ', b('Automate'), ' on a plain one opens the automation page with it chosen.'),
        p('Deposits you made that never became a position are listed under them, each with its refund.'),
      ],
    },
    {
      id: 'position-details',
      title: 'What a position shows',
      blocks: [
        list(
          ['Its pool, fee tier, tick spacing and hooks.'],
          ['Its range, the pool’s current price against it, and whether that price is inside it.'],
          ['Its principal, and its ', b('unclaimed fees'), ': fees earned and not yet collected.'],
          ['Its owner, read from chain.'],
        ),
        p('Every figure is public data at one block. It does not show that anyone controls a wallet.'),
      ],
    },
    {
      id: 'managed-positions',
      title: 'Managed positions and receipts',
      blocks: [
        p(b('Managed positions'), ' shows the history of positions under automation, over a rolling 24-hour window. ', b('Receipts'), ' shows the transactions automation submitted and what they did.'),
        p('Both show the signed-in wallet’s own, and load by themselves once you sign in; when receipts cannot be read, the page asks again by itself. A receipt that can still change is updated where it stands, and a transaction that is uncertain or was reorganized is never shown as completed.'),
        p(b('Managed positions'), ' can also list the sequence vaults your wallet created, each with ', b('Start tracking'), ' until it is tracked. Tracking collects a vault’s history from then on and grants no spending or automation permission.'),
      ],
    },
    {
      id: 'wallet-balances',
      title: 'Wallet balances',
      blocks: [
        p('The Wallet card lists the token balances of the connected wallet, or of any address you enter. Balances are public data at one block, not proof of wallet control. The card calls a listing complete only when it can show that it is.'),
      ],
    },
  ],
}
