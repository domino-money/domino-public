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
        p('Markets lists selected Uniswap pools on Robinhood Chain. The selection is not a ranking or a recommendation.'),
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
            { title: CREATE.step.pool.title, body: [CREATE.step.pool.lead] },
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
        p('When your wallet is signed in and the service answers, Review also estimates how much of each token the deposit is expected to take, and the most it may take. Hover a figure to see until when its estimate is current; after that the figures show a dash until you open Review again.'),
        p(CREATE.balance.notEnabled),
      ],
    },
    {
      id: 'create',
      title: 'Create position',
      blocks: [
        p(b('Create position'), ' is the last step. It needs your wallet connected on Robinhood Chain, and no sign-in.'),
        p('Your wallet asks you to sign, in order: an exact approval for each token whose allowance is short, the deposit of both tokens, and the position itself. The deployment is checked on chain before each step, and each transaction is read back before the next one is asked for.'),
        p('When the position exists, it opens on Positions. If a deposit went through and the position did not (a declined signature, a closed tab), pressing Create position again creates it from that deposit, never depositing twice; the deposit can also be refunded.'),
        note(['Positions are created in hookless pools that have a fixed fee. A direct position carries no Domino percentage fee; network gas still applies.']),
      ],
    },
  ],
}

export const POSITIONS: DocPage = {
  slug: 'positions',
  title: 'Positions',
  summary: 'Look up any position NFT, and see your managed positions, receipts and wallet balances.',
  sections: [
    {
      id: 'position-nfts',
      title: 'Look up a position NFT',
      blocks: [
        p('Enter up to 10 position NFT IDs to look them up. The result is public data at one block: it does not show that anyone controls a wallet, and nothing in it can be signed or moved.'),
        p('The read service cannot list the positions a wallet holds, so on Positions a position is looked up by its ID. Where available, a pool’s page lists the positions in that pool.'),
      ],
    },
    {
      id: 'position-details',
      title: 'What a position shows',
      blocks: [
        list(
          ['Its pool, fee tier, tick spacing and hooks.'],
          ['Its range, and whether the pool price was inside it at that block.'],
          ['Its principal, and its ', b('unsettled fees'), ': fees earned and not yet collected.'],
          ['Its owner at that block, read from chain.'],
        ),
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
