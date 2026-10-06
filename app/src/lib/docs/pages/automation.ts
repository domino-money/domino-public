import { b, doc, list, p, shot } from '../blocks'
import type { DocPage } from '../types'

/**
 * V2 automation (spec F7 §5; src/v2in/automate): one contract per position, an explicit mode, and a running start
 * (decision #12). Reference age and minimum interval stay fixed (#27). The pages say "your automation";
 * contract identities belong to Contracts. V1's separate lifecycle is explained under Your automation.
 */

export const AUTO_COMPOUND: DocPage = {
  slug: 'auto-compound',
  title: 'Auto-compound',
  summary: 'Adds a position’s earned fees back into the same position, so it grows, and nothing else.',
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
      id: 'what-it-did',
      title: 'See what it did',
      blocks: [
        p(doc('Receipts', 'positions', 'managed-positions'), ', on Positions, lists each automated run with the fees it used and its service fee. The position’s page shows its automation: its state, what it waits for, and the fees it collected and hasn’t reinvested yet. No sign-in is needed.'),
      ],
    },
    {
      id: 'limits',
      title: 'What it cannot do',
      blocks: [
        list(['Reduce your position’s liquidity.'], ['Pull tokens from your wallet.'], ['Sell your principal.']),
        // Changed on purpose 2026-10-06 (the owner's point 5): Auto-exit, its own product, is what closes a position.
        p('Only ', doc('Auto-exit', 'auto-exit'), ', turned on by you, can close the position.'),
      ],
    },
    {
      id: 'choices',
      title: 'What you choose',
      blocks: [
        p('Two limits, each 1% at first and at most 5%: the most a swap may lose to slippage, on top of the pool’s own fee, and the widest gap between the pool price and the reference price, a recent price Domino checks against. A wider gap lets automation run while the pool price is further away; above 2% it is risky, as someone can more easily move the pool price against you first.'),
        p('Two settings are fixed: a reference price no older than 5 minutes, and at most one automated run every 10 minutes. Within them, Domino runs it when a run pays off, and the card says what it waits for.'),
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
        p('On Automate, ', b('Set up Auto-compound'), ' opens the setup: choose the position, check its limits, and tick that the fees it has already earned and not collected are reinvested too, with the fee. ', b('Set up automation'), ' then asks your wallet to approve that one position and create its automation, in one confirmation when your wallet can send both together. ', b('Automate'), ' on a plain position opens the setup with that position chosen.'),
        p('Automation starts at once. The NFT stays in your wallet, and your automation keeps the fees it collected and hasn’t reinvested yet: withdraw them any time, with no fee. See ', doc('Your automation', 'your-automation'), '.'),
        p('Changes made to that position outside your automation stop it until you turn it back on: see ', doc('Risks', 'risks', 'automation-stops'), '.'),
      ],
    },
  ],
}

/** Changed on purpose 2026-10-01 (live note L12): the product's one name; the old slug is an alias (registry.ts). */
export const DOMINO_COMPOUNDER: DocPage = {
  slug: 'domino-compound',
  title: 'Domino-compound',
  summary: 'As the price nears the top of a range, earned fees open the next position one step higher.',
  sections: [
    {
      id: 'how-it-works',
      title: 'How it works',
      blocks: [
        p('Domino-compound puts earned fees to work higher up the price.'),
        // Changed on purpose 2026-10-05 (rugged97's F7 delta of 5 Oct, §5.5, the owner's rules): near the top, fees go only
        // to the next position, which starts at the current price; it is opened by the sequence's newest position alone.
        p('Fees normally go back into the position that earned them. When the price nears the top of its range, they stop going back into it: the newest position opens the next one, one step higher in the same pool, starting at the current price, and its fees go there.'),
        p('A next position is funded only from earned fees your automation holds, after the service fee. Automation never moves your principal; when a step does not pay off, or no more positions may open, it waits.'),
      ],
    },
    {
      id: 'limits',
      title: 'Limits you sign',
      blocks: [
        {
          kind: 'facts',
          rows: [
            // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): each with what it starts at (the new
            // automation's own defaults, Domino V1's, src/v2in/automate/constants.ts VAULT_DEFAULT_DOMINO).
            { label: 'Trigger distance', value: 'Up to 20%', note: 'How near the top of its range the price must be. 5% at first: the price is at 95% of the top.' },
            { label: 'Maximum overlap', value: 'Up to 20%', note: 'How far below the previous top the next position may start. 20% at first: with a top of 1, no lower than 0.80.' },
            // 2026-10-01 (audit E21): the setup's field names (screens/SequenceCreate.tsx).
            { label: 'Next range higher by', value: 'You set it; 50% at first', note: 'How far above the previous top the next position’s top sits, at least.' },
            { label: 'Positions in the sequence', value: 'A cap you set; 3 at first', note: 'Counts the position it starts from. At the cap, no next position opens, and fees near the top wait.' },
          ],
        },
        p('Each position opens at most one next position. A trigger only lets a step be considered; it never orders one. The swap limits and fixed settings are Auto-compound’s: see ', doc('What you choose', 'auto-compound', 'choices'), '.'),
      ],
    },
    {
      // The id stays, so links to it still land.
      id: 'sequence-vault',
      title: 'Where its positions live',
      blocks: [
        p('The position you start from stays in your wallet, and only that NFT is approved to your automation.'),
        p('Positions it opens, and earned fees not yet added back, are held by your automation until you withdraw them. Each next position can be withdrawn to your wallet any time, as a plain position. See ', doc('Your automation', 'your-automation'), '.'),
      ],
    },
    {
      id: 'start-and-stop',
      title: 'Start, pause and stop',
      blocks: [
        {
          kind: 'steps',
          items: [
            { title: 'Choose', body: ['On Automate, Set up Domino-compound: pick the position, check its limits, and tick that fees it has already earned and not collected are reinvested too.'] },
            { title: 'Approve and create', body: ['Your wallet approves that one position and creates its automation: one confirmation when your wallet can send both together.'] },
            { title: 'It runs', body: ['Automation starts at once. The position’s page has Pause, Resume and Leave automation.'] },
          ],
        },
        p('Collect fees, Close position and changes made outside Domino stop it too, until you turn it back on: see ', doc('Risks', 'risks', 'automation-stops'), '.'),
      ],
    },
    {
      id: 'service-fee',
      title: 'Service fee',
      blocks: [
        p('4% of the earned fees it uses, once, for every step it takes, including putting fees back into the same position. No extra fee for its own swaps, and none on withdrawals. See ', doc('Fees', 'fees', 'service-fee'), '.'),
      ],
    },
  ],
}

/**
 * 2026-10-04 (the owner: docs revalidated for V2): stop-loss and take-profit (spec F4, F7 §4; src/v2in/autoexit).
 * Changed on purpose 2026-10-06 (the owner's point 5; rugged97: "this stop loss-take profit product was named wrong. It is
 * AUTO-EXIT. When the price hits the edge of the range we close the position automatically and send the tokens to the
 * wallet. It must be separate from the rest"): Auto-exit, in its dialog's and card's own words, its prices the range's
 * edges, one per position, never with compounding. The old slug opens it (registry.ts DOC_ALIASES). The warnings are
 * §4.7's, as the dialog says them. Changed on purpose 2026-10-06 (the review of point 5): where it is
 * offered (every network's position page; New position's success on Robinhood Chain), and the card's own words.
 */
export const AUTO_EXIT: DocPage = {
  slug: 'auto-exit',
  title: 'Auto-exit',
  summary: 'Closes a position when the price reaches the end of its range, and sends the tokens to your wallet. 0.2%, only if it closes.',
  sections: [
    {
      id: 'what-it-is',
      title: 'What it is',
      blocks: [
        p('Auto-exit watches one position. When the price reaches the end of its range, Domino closes the position and sends the tokens to your wallet. You don’t type a price: the range’s ends are where it closes.'),
        p('For a range beside today’s price, a buy or a sell, only the far end counts: the position converts as the price crosses its range, and Auto-exit closes it once it has.'),
      ],
    },
    {
      id: 'turn-it-on',
      title: 'Turn it on',
      blocks: [
        p('Select ', b('Auto-exit'), ' below a position’s title, on any network, or right after you create a position. The dialog shows where it closes, the price now and its fee. ', b('Turn on Auto-exit'), ' asks your wallet for one signature, then one confirmation when your wallet can send the calls together.'),
        p('Behind it, Domino sets up an automation for that position alone, which never reinvests. Your position stays in your wallet. ', b('Details'), ' has the exact terms: both tokens as they come out, a 1% slippage limit on top of the pool fee, valid for a year.'),
      ],
    },
    {
      id: 'separate',
      title: 'Separate from compounding',
      blocks: [p('A position has compounding or Auto-exit, never both, and one Auto-exit at a time.')],
    },
    {
      id: 'cost',
      title: 'What it costs',
      blocks: [p('0.2% of the position’s value when it closes, only if it does: the only fee. Nothing while it waits.')],
    },
    {
      id: 'warnings',
      title: 'What it can’t promise',
      blocks: [
        list(
          ['The exit price is not guaranteed. In a sudden gap or a rug, the pool’s liquidity can disappear before Domino closes the position.'],
          ['Domino closes it once the reference price passes the end of your range and the pool price is within the slippage limit of it.'],
          ['On v3 pools the reference price is a time-weighted average. After a fast move the exit waits for it to catch up, and it may never happen if the pool empties first.'],
          ['Leave automation pauses Auto-exit; it doesn’t turn it off for good.'],
          ['If Domino stops automation for safety, Auto-exit stops too. You can still turn it off and withdraw at any time.'],
          ['Moving this position or approving another app on it pauses Auto-exit until you approve it again. Collecting fees doesn’t.'],
        ),
      ],
    },
    {
      id: 'after',
      title: 'On, off and after',
      blocks: [
        p('The position’s page shows where Auto-exit closes, with ', b('Turn off'), ', which ends it for good. Once it closes the position, the page says so with what you received; anything your wallet could not receive waits there to claim. The emptied NFT stays in your wallet.'),
      ],
    },
  ],
}

/**
 * 2026-10-04 (the owner: docs revalidated for V2): the contract behind Auto-compound, Domino-compound and Auto-exit
 * (spec F7 §1.5, §5.3–§5.6; src/v2in/automate VaultCard.tsx, VaultDialog.tsx), said as "your automation" (the owner,
 * 2026-10-04), with its card's and dialogs' own words, and what Domino V1's automation leaves to do (spec §1.1).
 */
export const YOUR_AUTOMATION: DocPage = {
  slug: 'your-automation',
  title: 'Your automation',
  summary: 'What runs Auto-compound, Domino-compound or Auto-exit on a position: what it holds, its card, and how to stop it.',
  sections: [
    {
      id: 'one-position',
      title: 'One position, one automation',
      blocks: [
        p('Setting up Auto-compound, Domino-compound or Auto-exit creates a contract for that one position: your automation. Made for your wallet alone; only your wallet controls it.'),
        p('Your position stays in your wallet: you approve only that NFT, and approving another app on it stops your automation.'),
      ],
    },
    {
      id: 'three-ways',
      title: 'Three ways',
      blocks: [
        list(
          [doc('Auto-compound', 'auto-compound'), ': its fees go back into the position. 2% of the fees it reinvests.'],
          [doc('Domino-compound', 'domino-compound'), ': near the top of its range, its fees open the next position one step higher. 4% of the fees it reinvests.'],
          [doc('Auto-exit', 'auto-exit'), ': closes the position at the end of its range and never reinvests. 0.2% only if it closes.'],
        ),
        p('Nothing is chosen for you.'),
      ],
    },
    {
      id: 'its-card',
      title: 'Its card',
      blocks: [
        p('It shows as ', b('Automation'), ' on the position’s page, and as a row of Managed positions: its network, its state (', b('Automation on'), ', ', b('Paused'), ', ', b('Auto-exit'), ' or ', b('Automation off'), '), what it waits for, and the fees it collected and hasn’t reinvested yet. Auto-exit’s own shows as its card instead.'),
        p(b('Details'), ' has its mode and fee, the positions Domino-compound opened, and ', b('Pause'), ' or ', b('Resume'), '. Pausing stops automated runs; Auto-exit stays on.'),
      ],
    },
    {
      id: 'waiting-fees',
      title: 'Fees waiting to be reinvested',
      blocks: [
        p('Your automation keeps the fees it collected and hasn’t reinvested yet. They’re yours: ', b('Withdraw to wallet'), ' sends them to your wallet any time, whatever its state, with no Domino fee.'),
        p('Once your position is closed, Domino returns them to your wallet on its next pass, or ', b('Return my reserves'), ' does it now. No fee either way.'),
        // 2026-10-04 (rugged97's delta of 4 Oct §2 item 1): a withdrawal names its recipient.
        p('If a token refuses your wallet, ', b('Send to another address you own'), ' appears.'),
      ],
    },
    {
      id: 'leave',
      title: 'Leave automation',
      blocks: [
        // 2026-10-04 (rugged97's delta of 4 Oct §2 item 3, #319): exitAll turns auto-exit off too.
        p(b('Leave automation'), ' sends the positions Domino-compound opened, and everything your automation can pay, to your wallet in one action, and the position stops being automated. No fee. ', doc('Auto-exit', 'auto-exit'), ' pauses until you turn it back on.'),
        p('Each next position can also be withdrawn alone. On a Uniswap v4 position, once nothing is left, ', b('Remove Domino from this position'), ' and ', b('Revoke approval'), ' end Domino’s access.'),
      ],
    },
    {
      id: 'when-it-stops',
      title: 'When it stops',
      blocks: [
        p('If you change the position, move it or approve another app, automation stops for it until you turn it back on. ', b('Turn back on'), ' asks your consent again for the fees it has not collected.'),
        p('If Domino stops automation on a network for safety, runs and Auto-exit stop there; you can still withdraw and manage your positions.'),
      ],
    },
    {
      id: 'domino-v1',
      title: 'Domino V1’s automation',
      blocks: [
        p('Domino V1’s automation ends when the new one starts, with no migration: withdraw what V1 holds for you with ', b('Withdraw to wallet'), ', then set up the new automation. A position still in V1’s automation can’t take the new one, or Auto-exit, until it leaves.'),
      ],
    },
  ],
}
