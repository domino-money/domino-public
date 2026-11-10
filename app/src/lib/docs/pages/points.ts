import { doc, list, p, screen } from '../blocks'
import type { DocPage } from '../types'

/**
 * Points (added 2026-11-07, the owner: a Docs page that explains Season 1 in depth, beside the Points page). The rules are
 * the season's own, as rugged97's backend counts them (backend/points_season_1.json, docs/points/POINTS.md, PR #467): the
 * window, 1,000 points per US dollar of Domino's net revenue from a wallet, the four fees' rates, one level of
 * referrals at 10% with the first link holding, the hourly count kept with its hash, and who is left out. It promises
 * nothing: points are a count of use, not money and not a token. The link is written without its scheme, as the docs
 * write no address (tests/docs.test.mjs).
 */
export const POINTS: DocPage = {
  slug: 'points',
  title: 'Points',
  summary: 'Season 1 of Domino points: what they count, how a wallet earns them, referrals, and what points are not.',
  sections: [
    {
      id: 'what-points-are',
      title: 'What points are',
      blocks: [
        p('Points count how much a wallet uses Domino in Season 1: every Domino fee it pays earns points, and each wallet it refers adds a share. They belong to the wallet’s address, on any device. The ', screen('Points page', '/points'), ' shows yours once your wallet signs in, a free message, not a transaction.'),
      ],
    },
    {
      id: 'season-1',
      title: 'Season 1',
      blocks: [
        {
          kind: 'facts',
          rows: [
            { label: 'Starts', value: '9 Nov 2026, 00:00 UTC', note: 'Nothing before the start counts.' },
            { label: 'Ends', value: '9 Feb 2027, 00:00 UTC', note: 'A fee charged after the end counts for no season.' },
          ],
        },
      ],
    },
    {
      id: 'earning',
      title: 'How a wallet earns points',
      blocks: [
        p('1,000 points for each US dollar Domino receives from the wallet in fees, on every network Domino serves. Each fee is valued in US dollars when it is charged, less the network cost Domino paid to carry it out. A fee in a token Domino cannot value counts nothing.'),
        {
          kind: 'facts',
          rows: [
            { label: 'Assisted swap', value: '0.65% of the amount swapped' },
            { label: 'Automation', value: 'Auto-compound 2%, Domino-compound 4%', note: 'Of the earned fees it uses.' },
            { label: 'Auto-exit', value: '0.2% of the position’s value', note: 'Counted when that fee is at least ten US cents.' },
            { label: 'Deposit from another network', value: '0.35% of the amount deposited' },
          ],
        },
        p('For example, of 500 USDG swapped, the fee is 3.25 USDG: 3,250 points while USDG is worth one US dollar. Anything with no Domino fee earns no points. See ', doc('Fees', 'fees'), ' for when each applies.'),
      ],
    },
    {
      id: 'referrals',
      title: 'Referrals',
      blocks: [
        p('Your link is ', { mono: 'domino.money/points?ref=' }, ' and your wallet’s address; the Points page copies it whole.'),
        list(
          ['A wallet you refer adds 10% of its points from using Domino to yours, and keeps all of its own.'],
          ['One level: never 10% of the points its own referrals bring it.'],
          ['Linking is the referred wallet’s choice: on the Points page it signs in, then signs one free message that approves no transaction.'],
          ['Its first link holds for the whole season.'],
          ['The 10% counts from the season’s start, whenever the link is made, and shows after the next count.'],
          ['No wallet refers itself, and referrals are checked when the season ends.'],
        ),
      ],
    },
    {
      id: 'counted',
      title: 'Counted every hour, and kept',
      blocks: [
        p('Points are counted every hour from the fees recorded on chain, and the Points page shows the time of your latest count. Each count is kept with its SHA-256, as are the season’s rules, so a count can be checked against the rules it was made with. A change to the rules applies only from the day it is published.'),
      ],
    },
    {
      id: 'not-counted',
      title: 'Who is not counted',
      blocks: [
        p('Domino’s team, the wallets that run its contracts, the owners of its governance multisig and the public test accounts earn no points, refer no one and cannot be referred.'),
      ],
    },
    {
      id: 'not-money',
      title: 'What points are not',
      blocks: [
        p('Points are a count of use. They are not money and not a token: they cannot be sent, traded or withdrawn, and hold no value of their own. Domino makes no promise about what points may lead to, or that they lead to anything.'),
      ],
    },
  ],
}
