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
        p('Only a ', doc('stop-loss or take-profit', 'stop-loss'), ' order you signed can withdraw the position.'),
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
        p('Fees normally go back into the position that earned them. When the price nears the top of its range, they can instead open the next position one step higher in the same pool, or add to the one it already opened.'),
        p('A next position is funded only from earned fees your automation holds, after the service fee. Automation never moves your principal; when a step does not pay off, it waits.'),
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
            { label: 'Positions in the sequence', value: 'A cap you set; 3 at first', note: 'Counts the position it starts from. At the cap, fees fund an existing position or wait.' },
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
 * 2026-10-04 (the owner: docs revalidated for V2): stop-loss and take-profit (spec F4, F7 §4; src/v2in/autoexit), in the
 * order dialog's own words; the warnings are §4.7's, which the review asks the person to tick as read.
 */
export const STOP_LOSS: DocPage = {
  slug: 'stop-loss',
  title: 'Stop-loss / take-profit',
  summary: 'Withdraw a position automatically at a price you choose. The fee is 0.2%, only if it runs.',
  sections: [
    {
      id: 'what-it-is',
      title: 'What it is',
      blocks: [
        p('A stop-loss withdraws at a lower price; a take-profit, at a higher one. Each is an order you sign, which fires once and can be cancelled any time.'),
        p('An exit sends the position only to your wallet, as signed. Receipts call it auto-exit.'),
      ],
    },
    {
      id: 'set-it-up',
      title: 'Set it up',
      blocks: [
        p('Select ', b('Stop-loss / take-profit'), ' below a position’s title. Its dialog shows the pool price: type an exit price or choose a percentage. Saved or unavailable prices offer no shortcuts. On Automate, this action starts ', b('Protection only'), '. Choose:'),
        list(
          [b('Lower exit'), ' when the displayed price falls, ', b('Upper exit'), ' when it rises, or both. Switching price units keeps the same targets.'],
          ['What you receive: both tokens, or only one.'],
          [b('Max slippage, on top of the pool fee'), ': 1% at first, up to 5%.'],
          ['How long it stays valid: 30 days at first, up to a year.'],
        ),
        p('Review shows the terms, fee and warnings to acknowledge. Your wallet then signs and registers the order; exact signed prices are under each trigger’s details.'),
      ],
    },
    {
      id: 'protection-only',
      title: 'Protection only',
      blocks: [
        p('An order needs Domino’s automation on the position. A plain position gets ', b('Protection only'), ' first: Domino doesn’t reinvest it, only watches your orders, and charges no automation fee.'),
      ],
    },
    {
      id: 'cost',
      title: 'What it costs',
      blocks: [
        p('0.2% of the position’s value at exit, only if the order runs: the only fee, even when converting. Fees your automation holds come back free.'),
      ],
    },
    {
      id: 'warnings',
      title: 'What it can’t promise',
      blocks: [
        list(
          ['The trigger price is not guaranteed. In a price gap or a rug, liquidity can disappear before the exit.'],
          ['The exit runs only after the reference price crosses your trigger and the pool price is within your slippage of it.'],
          ['On v3 pools the reference price is a time-weighted average. After a fast move the exit waits for it to catch up, and it may never happen if the pool empties first.'],
          ['When converting, your slippage limit comes on top of the pool’s own fee.'],
          ['Turning auto-exit off for your automation pauses your orders; it doesn’t cancel them.'],
          ['If one order fires, your other orders on this position stay active.'],
          ['If Domino stops automation for safety, auto-exits stop too. You can still cancel your orders and withdraw at any time.'],
        ),
      ],
    },
    {
      id: 'after',
      title: 'Orders and what follows',
      blocks: [
        p('Orders show ', b('Active'), ', ', b('Expired'), ', ', b('Cancelled'), ' or ', b('Executed'), ' and what they await. ', b('Cancel order'), ' stops one permanently; pausing automation does not. An executed order sends the position to your wallet after the fee; amounts your wallet cannot receive wait in the card to claim.'),
      ],
    },
  ],
}

/**
 * 2026-10-04 (the owner: docs revalidated for V2): the contract behind Auto-compound, Domino-compound and Protection only
 * (spec F7 §1.5, §5.3–§5.6; src/v2in/automate VaultCard.tsx, VaultDialog.tsx), said as "your automation" (the owner,
 * 2026-10-04), with its card's and dialogs' own words, and what Domino V1's automation leaves to do (spec §1.1).
 */
export const YOUR_AUTOMATION: DocPage = {
  slug: 'your-automation',
  title: 'Your automation',
  summary: 'What runs Auto-compound, Domino-compound or Protection only on a position: what it holds, its card, and how to stop it.',
  sections: [
    {
      id: 'one-position',
      title: 'One position, one automation',
      blocks: [
        p('Setting up Auto-compound, Domino-compound or Protection only creates a contract for that one position: your automation. Made for your wallet alone; only your wallet controls it.'),
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
          [b('Protection only'), ': Domino doesn’t reinvest this position; it only watches your ', doc('stop-loss and take-profit', 'stop-loss'), '. 0.2% only if an exit runs.'],
        ),
        p('Nothing is chosen for you.'),
      ],
    },
    {
      id: 'its-card',
      title: 'Its card',
      blocks: [
        p('It shows as ', b('Automation'), ' on the position’s page, and as a row of Managed positions: its network, its state (', b('Automation on'), ', ', b('Paused'), ', ', b('Protection only'), ' or ', b('Automation off'), '), what it waits for, and the fees it collected and hasn’t reinvested yet.'),
        p(b('Details'), ' has its mode and fee, the positions Domino-compound opened, and ', b('Pause'), ' or ', b('Resume'), '. Pausing stops automated runs; your stop-loss orders stay active.'),
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
        p(b('Leave automation'), ' sends the positions Domino-compound opened, and everything your automation can pay, to your wallet in one action, and the position stops being automated. No fee. Your ', doc('stop-loss', 'stop-loss'), ' orders pause until you turn auto-exit back on.'),
        p('Each next position can also be withdrawn alone. On a Uniswap v4 position, once nothing is left, ', b('Remove Domino from this position'), ' and ', b('Revoke approval'), ' end Domino’s access.'),
      ],
    },
    {
      id: 'when-it-stops',
      title: 'When it stops',
      blocks: [
        p('If you change the position, move it or approve another app, automation stops for it until you turn it back on. ', b('Turn back on'), ' asks your consent again for the fees it has not collected.'),
        p('If Domino stops automation on a network for safety, runs and exit orders stop there; you can still withdraw and manage your positions.'),
      ],
    },
    {
      id: 'domino-v1',
      title: 'Domino V1’s automation',
      blocks: [
        p('Domino V1’s automation ends when the new one starts, with no migration: withdraw what V1 holds for you with ', b('Withdraw to wallet'), ', then set up the new automation. A position still in V1’s automation can’t take the new one, or a stop-loss, until it leaves.'),
      ],
    },
  ],
}
