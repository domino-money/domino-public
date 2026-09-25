import { b, doc, list, note, p } from '../blocks'
import type { DocPage } from '../types'

/**
 * Public terms stay accurate whether one admitted pilot vault is live or none are. Changed on purpose (2026-09-25, audit
 * of 754014c): the automation page no longer has owner controls, so no screen of this site activates, pauses, revokes or
 * withdraws; the note no longer says this site offers activation.
 */
const SERVICE_SCOPE = note(
  ['Automation availability is checked for each owner and sequence. A new sequence starts paused. Activation, pause, revocation and withdrawal are transactions your wallet signs on your sequence vault, activation only once the automation service confirms readiness for it. No Domino screen makes them today.'],
  'Per sequence',
)

export const AUTO_COMPOUND: DocPage = {
  slug: 'auto-compound',
  title: 'Auto-compound',
  summary: 'Adds a position’s earned fees back into the same position, and nothing else.',
  status: 'Compound',
  sections: [
    {
      id: 'how-it-works',
      title: 'How it works',
      blocks: [
        p('Auto-compound adds a position’s earned fees back into the same position. The range stays as it is, and the fees become more liquidity inside it.'),
        p('It uses proven earned fees only. No wallet asset is pulled and no principal is sold.'),
      ],
    },
    {
      id: 'limits',
      title: 'What it cannot do',
      blocks: [
        list(['Reduce your position’s liquidity.'], ['Pull tokens from your wallet.'], ['Sell your principal.']),
        p('The contract does not let automation reduce a position’s liquidity.'),
      ],
    },
    {
      id: 'choices',
      title: 'What you choose',
      blocks: [
        p('The quote currency is the token prices are counted in. It sets which way prices count as higher for your sequence, and it cannot be changed once the sequence is created.'),
        p('Every run also keeps within limits that start at defaults you can change: the least time between runs, the most a swap may lose to slippage or move the price, a gas cap per run, how old a price reading may be, and how far ahead fees are forecast.'),
      ],
    },
    {
      id: 'service-fee',
      title: 'Service fee',
      blocks: [p('2% of the earned fees it consumes, taken once. Only the root position is used, with a position cap of one and no successors. Never on principal, and earned fees that wait are not charged. See ', doc('Fees', 'fees', 'service-fee'), '.')],
    },
    {
      id: 'where-it-starts',
      title: 'Where it starts',
      blocks: [
        p('Auto-compound runs on a position NFT you opened with Domino and still hold. Setup takes two wallet transactions: approve that one NFT to its sequence vault, then create the sequence, which starts paused. Activation is a separate wallet transaction when the service is ready for your sequence.'),
        SERVICE_SCOPE,
        p(
          'Custody is the same as for Domino Compounder: the NFT stays in your wallet, and ',
          doc('your sequence vault', 'non-custodial', 'sequence-vault'),
          ' holds earned fees not yet reinvested until you withdraw them. You ',
          doc('pause, revoke and withdraw', 'non-custodial', 'pause-revoke-withdraw'),
          ' with your wallet.',
        ),
        p('Changes made to that NFT outside Domino can stop it: see ', doc('Risks', 'risks', 'automation-stops'), '.'),
      ],
    },
  ],
}

export const DOMINO_COMPOUNDER: DocPage = {
  slug: 'domino-compounder',
  title: 'Domino Compounder',
  summary: 'As the price nears the top of a range, earned fees open the next position one step higher.',
  status: 'Domino',
  sections: [
    {
      id: 'how-it-works',
      title: 'How it works',
      blocks: [
        p('Domino Compounder puts earned fees to work higher up the price. In the app you choose it as ', b('Domino-compound'), '.'),
        p('Fees normally return to the position that earned them. Near the top of its range, they can instead open the next position one step higher in the same pool, or fund the one it already opened.'),
        p('A next position is funded only from earned fees inside your sequence vault, after the service fee. Automation never moves your principal, and when an action is not justified, it waits with a reason.'),
      ],
    },
    {
      id: 'limits',
      title: 'Limits you sign',
      blocks: [
        {
          kind: 'facts',
          rows: [
            {
              label: 'Trigger distance',
              value: 'Up to 20%',
              note: 'How near its range’s ceiling the price must be: a 5% trigger means the price at 95% of the ceiling.',
            },
            {
              label: 'Maximum overlap',
              value: 'Up to 20%',
              note: 'How far below the previous ceiling the next position’s floor may start. With a ceiling of 1 and 20% overlap, the floor cannot be below 0.80.',
            },
            { label: 'Upside', value: 'You set it; the app draws the next range at 50%', note: 'The next position’s ceiling sits at least this far above the previous ceiling.' },
            { label: 'Positions', value: 'A cap you set', note: 'Counts the position it starts from. At the cap, fees fund an existing position or wait.' },
          ],
        },
        p('Each position opens at most one next position. A trigger only makes a step eligible to be evaluated; it never orders one.'),
      ],
    },
    {
      id: 'sequence-vault',
      title: 'Where its positions live',
      blocks: [
        p('The position you start from stays in your wallet. Only that NFT is approved to your sequence vault, a contract created for your wallet.'),
        p('Positions it opens, and earned fees not yet reinvested, are held by your sequence vault until you withdraw them. See ', doc('who controls the vault', 'non-custodial', 'sequence-vault'), '.'),
      ],
    },
    {
      id: 'start-and-stop',
      title: 'Start, pause and stop',
      blocks: [
        {
          kind: 'steps',
          items: [
            { title: 'Approve one NFT', body: ['Approve only the position you start from, to its sequence vault.'] },
            { title: 'Create the sequence', body: ['A second transaction creates the vault with the limits you set. It starts paused.'] },
            { title: 'Activate it', body: ['After the service confirms readiness for your sequence, a separate wallet transaction takes it out of pause. Signing in or opening a page never does.'] },
          ],
        },
        p(
          'On Automate, ',
          b('Set up Domino-compound'),
          ' opens the setup, where one button asks your wallet for both transactions. You ',
          doc('pause, revoke and withdraw', 'non-custodial', 'pause-revoke-withdraw'),
          ' with your wallet on your sequence vault. Changes made outside Domino stop automation too: see ',
          doc('Risks', 'risks', 'automation-stops'),
          '.',
        ),
        SERVICE_SCOPE,
      ],
    },
    {
      id: 'service-fee',
      title: 'Service fee',
      blocks: [
        p('4% of the earned fees consumed, once, for every Domino recipe, including reinvestment into the source. No extra swap fee for the automation’s own balancing, and no Domino service fee on withdrawals. See ', doc('Fees', 'fees', 'service-fee'), '.'),
      ],
    },
  ],
}
