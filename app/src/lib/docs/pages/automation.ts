import { ROADMAP_PILL } from '../../capabilities'
import { b, doc, list, note, p, shot } from '../blocks'
import type { DocPage } from '../types'

/**
 * Public terms stay accurate whether one admitted pilot vault is live or none are. Changed on purpose (2026-09-25, audit
 * of 754014c): the automation page no longer has owner controls, so no screen of this site activates, pauses, revokes or
 * withdraws; the note no longer says this site offers activation. Changed on purpose again (owner, 2026-09-25): a
 * position's page offers Turn on once the service confirms it is ready for that sequence, and Pause while it runs
 * (components/positions/SequenceSwitch.tsx); revocation and withdrawal still have no screen.
 */
const SERVICE_SCOPE = note(
  ['Automation availability is checked for each owner and sequence. A new sequence starts paused. Activation, pause, revocation and withdrawal are transactions your wallet signs on your sequence vault. Your position’s page offers Turn on once the automation service confirms it is ready for your sequence, and Pause while it runs.'],
  // The pill's own words (audit E3).
  ROADMAP_PILL['owner-scoped'],
)

export const AUTO_COMPOUND: DocPage = {
  slug: 'auto-compound',
  title: 'Auto-compound',
  summary: 'Adds a position’s earned fees back into the same position, so it grows, and nothing else.',
  status: 'Compound',
  sections: [
    {
      id: 'how-it-works',
      title: 'How it works',
      blocks: [
        // 2026-09-27: what it never touches is the list under What it cannot do, so it is not said twice.
        p('Auto-compound collects the fees your position has earned and adds them back into the same position. The range stays as it is; the position holds more, so its share of each trade’s fee grows while in range.'),
      ],
    },
    {
      // 2026-09-27 (the owner's point 10): what Auto-compound did is on the position's own page, read from the chain.
      id: 'what-it-did',
      title: 'See what it did',
      blocks: [
        p('A position’s page shows, with no sign-in, how much Auto-compound added back and how many times, and marks each time on its Fees earned chart. See ', doc('A position’s page', 'positions', 'position-details'), '.'),
      ],
    },
    {
      id: 'limits',
      title: 'What it cannot do',
      blocks: [
        list(['Reduce your position’s liquidity.'], ['Pull tokens from your wallet.'], ['Sell your principal.']),
        p('The contract does not let automation reduce liquidity.'),
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
      // 2026-09-27 (review of 260a76a): 2 is 2% of the 100 used, not of the 98 put back (FeeAccounting.sol).
      blocks: [p('2% of the earned fees it uses, taken once: of 100 USDG of fees it uses, 2 go to the service fee and 98 back into your position. It works on that one position only. Never on principal, and earned fees that wait are not charged. See ', doc('Fees', 'fees', 'service-fee'), '.')],
    },
    {
      id: 'where-it-starts',
      title: 'Where it starts',
      blocks: [
        shot('automate', 'Auto-compound on Automate, with its set-up button.'),
        p('Auto-compound runs on a position NFT you opened with Domino and still hold. Setup takes two wallet transactions: approve that one NFT to its sequence vault, then create the sequence, which starts paused. Activation is a separate wallet transaction when the service is ready for your sequence.'),
        // 2026-09-27: Automate has offered Set up Auto-compound since the three features joined up (2026-09-24), and a plain
        // position's row offers Automate; the page now says where it starts.
        p('On Automate, ', b('Set up Auto-compound'), ' opens the setup: choose the position, then one button asks your wallet for both transactions. ', b('Automate'), ' on a plain position in Positions opens it with that position chosen.'),
        SERVICE_SCOPE,
        p(
          'Custody is the same as for Domino-compound: the NFT stays in your wallet, and ',
          doc('your sequence vault', 'non-custodial', 'sequence-vault'),
          ' holds earned fees not yet added back until you withdraw them. You ',
          doc('pause, revoke and withdraw', 'non-custodial', 'pause-revoke-withdraw'),
          ' with your wallet.',
        ),
        p('Changes made to that NFT outside Domino can stop it, and so do Collect fees and Close position on its page: see ', doc('Risks', 'risks', 'automation-stops'), '.'),
      ],
    },
  ],
}

/** Changed on purpose 2026-10-01 (live note L12): the product's one name; the old slug is an alias (registry.ts). */
export const DOMINO_COMPOUNDER: DocPage = {
  slug: 'domino-compound',
  title: 'Domino-compound',
  summary: 'As the price nears the top of a range, earned fees open the next position one step higher.',
  status: 'Domino',
  sections: [
    {
      id: 'how-it-works',
      title: 'How it works',
      blocks: [
        p('Domino-compound puts earned fees to work higher up the price.'),
        p('Fees normally go back into the position that earned them. When the price nears the top of its range, they can instead open the next position one step higher in the same pool, or add to the one it already opened.'),
        p('A next position is funded only from earned fees inside your sequence vault, after the service fee. Automation never moves your principal; when a step is not justified, it waits.'),
      ],
    },
    {
      id: 'limits',
      title: 'Limits you sign',
      blocks: [
        {
          kind: 'facts',
          rows: [
            { label: 'Trigger distance', value: 'Up to 20%', note: 'How near the top of its range the price must be: 5% means the price is at 95% of the top.' },
            { label: 'Maximum overlap', value: 'Up to 20%', note: 'How far below the previous top the next position may start: with a top of 1 and 20%, no lower than 0.80.' },
            // 2026-10-01 (audit E21): the setup's field names (screens/SequenceCreate.tsx).
            { label: 'Next range higher by', value: 'You set it; the app draws the next range at 50%', note: 'How far above the previous top the next position’s top sits, at least.' },
            { label: 'Positions in the sequence', value: 'A cap you set', note: 'Counts the position it starts from. At the cap, fees fund an existing position or wait.' },
          ],
        },
        p('Each position opens at most one next position. A trigger only lets a step be considered; it never orders one.'),
      ],
    },
    {
      id: 'sequence-vault',
      title: 'Where its positions live',
      blocks: [
        p('The position you start from stays in your wallet. Only that NFT is approved to your sequence vault, a contract created for your wallet.'),
        p('Positions it opens, and earned fees not yet added back, are held by your sequence vault until you withdraw them. See ', doc('who controls the vault', 'non-custodial', 'sequence-vault'), '.'),
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
          ' with your wallet on your sequence vault. Collect fees, Close position and changes made outside Domino stop it too: see ',
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
        p('4% of the earned fees it uses, once, for every step it takes, including putting fees back into the same position. No extra fee for its own balancing swaps, and none on withdrawals. See ', doc('Fees', 'fees', 'service-fee'), '.'),
      ],
    },
  ],
}
