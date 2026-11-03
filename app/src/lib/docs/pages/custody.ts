import { COPY } from '../../read/screens/copy'
import { doc, p } from '../blocks'
import type { DocPage } from '../types'

/**
 * Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): custody as Domino's new contracts keep it (spec F7
 * §1.5, in its suggested words): the position stays in the wallet, an action keeps nothing afterwards, and the contract
 * behind Auto-compound, Domino-compound and Auto-exit is "your automation" (the owner, 2026-10-04). Domino V1's
 * setup operation and sequence controls left with V1's automation, which ends when the new one starts.
 */
export const NON_CUSTODIAL: DocPage = {
  slug: 'non-custodial',
  title: 'Non-custodial',
  summary: 'Who holds your positions and fees, what Domino’s automation may and may not do, and the controls only you have.',
  lead: 'When you create an automation using Domino, you are the sole owner and only you can control it. Every step is fully automated by a contract whose controller is your signed wallet.',
  sections: [
    {
      id: 'your-wallet',
      title: 'The position you open stays in your wallet',
      blocks: [
        p('A position you create is a standard Uniswap position NFT in the wallet that signs. Each action on it is a single transaction, and Domino’s contract keeps nothing afterwards.'),
        p('Some actions first let Domino manage that one position, until you revoke it: see ', doc('Domino’s permission', 'manage-position', 'permission'), '.'),
        p('When you start Auto-compound or Domino-compound from it, that NFT stays in your wallet. You approve that one NFT to your automation, never all of your NFTs.'),
      ],
    },
    {
      // The id stays, so links to it still land.
      id: 'sequence-vault',
      title: 'What your automation holds',
      blocks: [
        p('Positions Domino-compound opens, and earned fees not yet added back, are held by your automation until you withdraw them. Positions it opens are standard Uniswap position NFTs too.'),
        p('Your permission covers earned fees only, including fees your position had not collected when you set it up. Principal is never used, except by an Auto-exit you turned on.'),
        p('Your automation is made for your wallet alone, and no function can change its owner. Only your wallet controls its withdrawals, limits and pause, and every withdrawal goes to your wallet.'),
      ],
    },
    {
      id: 'operator',
      title: 'What Domino’s automation can and cannot do',
      blocks: [
        p('Your wallet stays the only owner. Domino’s automation service, the operator, can only run fee-only steps within your limits, pause, and carry out an Auto-exit you turned on.'),
        {
          kind: 'split',
          columns: [
            {
              title: 'The operator can',
              items: [
                ['Add a position’s earned fees back into it.'],
                ['Open or fund the next position from earned fees, within your limits.'],
                ['Swap earned fees within your slippage and price-gap limits.'],
                ['Pause automation.'],
                ['Carry out an Auto-exit you turned on, exactly as you signed it.'],
                ['Return the fees it holds to your wallet once your position is closed.'],
              ],
            },
            {
              title: 'The operator cannot',
              items: [
                ['Withdraw positions or fees, except to close a position as your Auto-exit says.'],
                ['Change your limits, or resume automation after a pause.'],
                ['Pull tokens from your wallet.'],
                ['Send anything to anyone but you.'],
              ],
            },
          ],
        },
      ],
    },
    {
      // The id stays: a receipt's How to pause lands here.
      id: 'pause-revoke-withdraw',
      title: 'Your controls',
      blocks: [
        {
          kind: 'facts',
          rows: [
            { label: 'Pause', value: 'You, or Domino', note: 'Stops automated runs; Auto-exit stays on. Only you can resume.' },
            { label: 'Turn back on', value: 'You', note: 'Restarts automation after you left it, or after a change outside Domino stopped it.' },
            { label: 'Withdraw to wallet', value: 'You', note: 'Sends the fees your automation holds to your wallet, in any state.' },
            { label: 'Withdraw a next position', value: 'You', note: 'Sends a position Domino-compound opened to your wallet, as a plain position.' },
            { label: 'Leave automation', value: 'You', note: 'Everything your automation holds to your wallet, and automation stops; Auto-exit pauses.' },
            { label: 'Turn off Auto-exit', value: 'You', note: 'Ends it for good.' },
          ],
        },
        // Changed on purpose 2026-10-31 (QA round 2 follow-ups, N26): no Automated positions card on Positions.
        p('Each is a transaction your wallet signs, with no Domino fee, and none waits on Domino’s service. They are on the position’s page.'),
        p(doc('Signing in', 'wallet', 'sign-in'), ' grants none of them.'),
      ],
    },
    {
      // 2026-10-30 (QA2 N59): exitAll is Leave automation (onlyOwner); Robin Etherscan, as v2/explorers.ts says.
      id: 'if-domino-is-down',
      title: 'If Domino’s site is down',
      blocks: [
        p('Your position is a standard Uniswap position NFT in your wallet, so you can collect its fees or close it with any app that manages Uniswap positions on its network, or through that network’s Uniswap contract on ', doc('Contracts', 'contracts'), '.'),
        p('Your automation can be emptied from a block explorer: Robin Etherscan on Robinhood Chain, Basescan or Arbiscan. The transaction that set it up, in your wallet’s activity, shows its address: open that address on the explorer, connect your wallet and call ', { mono: 'exitAll' }, ', as Leave automation does. Only your wallet can call it, and everything goes to your wallet.'),
      ],
    },
  ],
}

export const RISKS: DocPage = {
  slug: 'risks',
  title: 'Risks',
  summary: 'What Domino does not remove: moving prices, idle ranges, fees that fall short, automation that stops, and token, bridge and contract risk.',
  sections: [
    {
      id: 'market-risk',
      title: 'Prices move',
      blocks: [p('Prices move, and what your position holds moves with them. Domino does not remove market risk.')],
    },
    {
      id: 'out-of-range',
      title: 'Ranges go idle',
      blocks: [
        // Changed on purpose 2026-10-01 (audit E13): which token, by side.
        p('Outside its range a position holds only one of its two tokens. In an ETH/USDG pool, below the range it holds only ETH, which fell; above it, only USDG, its ETH sold on the way up. It earns nothing until the price comes back.'),
        p('Positions that Domino-compound opens sit higher up the price. If the price turns back down, they can end up holding only the token, and a next position can start out of range.'),
      ],
    },
    {
      id: 'no-promised-return',
      title: 'No promised return',
      blocks: [
        p('Fees are not profit. A position can collect fees for weeks and still be worth less than holding the assets.'),
        // 2026-10-30 (QA2 N106): a worked example, in tokens (a Uniswap v3/v4 range; no dollar figures).
        p('An example: at 1 ETH = 2,000 USDG you add 1 ETH and 2,000 USDG, with a range of 1,000 to 4,000 USDG. At 4,000 the position holds only USDG, about 4,830; holding the two tokens instead would be worth 6,000. Fees have to cover that gap.'),
        // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): an exit is a limit, not a promise (2026-10-06: Auto-exit).
        p('Automation adds earned fees to positions. It does not stop a token falling, and Auto-exit limits a fall only when it closes the position: see ', doc('Auto-exit', 'auto-exit', 'warnings'), '.'),
      ],
    },
    {
      id: 'automation-stops',
      title: 'Automation can stop',
      blocks: [
        // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): spec F7 §1.5, §2.13, §5.3, §5.4.
        // 2026-10-30 (QA2 N49): by mode (v2in/position/constants.ts).
        p('Automation stops for a position if you change it, move it or approve another app on it. For compounding, Collect fees, Close position, Add liquidity and Withdraw count as changes too. Auto-exit pauses only when the position is moved or its approval changes.'),
        p('It stays stopped until you turn it back on: Turn back on, on the position’s page, consents again to the fees the position has not collected, exactly as setting it up did.'),
        p('Automation can also wait without stopping, for example until fees cover the network cost; its card says why. Domino can stop automation on a network for safety, and your controls keep working, even ', doc('without this site', 'non-custodial', 'if-domino-is-down'), '.'),
      ],
    },
    {
      id: 'figures-describe-pools',
      title: 'Figures describe pools',
      blocks: [
        p(COPY.figures.caveat),
        p('TVL and 24h volume come from Domino history where the deployment provides it, and otherwise from a market data provider that Domino does not reconcile. See ', doc('Figures and sources', 'figures'), '.'),
      ],
    },
    {
      // 2026-10-04 (the owner: docs revalidated for V2): spec F7 §3, F5.
      id: 'bridges',
      title: 'Bridges',
      blocks: [
        p('A deposit from another network travels through Relay or Across, which Domino does not run. If one can’t deliver, it refunds the deposit on the network it left from.'),
      ],
    },
    {
      id: 'tokens-and-contracts',
      title: 'Tokens and contracts',
      blocks: [
        p('A token’s issuer may be able to upgrade, pause or freeze it.'),
        p('Positions and automation run on smart contracts, and a contract can have defects. Once your wallet has sent a transaction, Domino cannot cancel it.'),
      ],
    },
  ],
}

/** 2026-10-01 (items I4, I6, A17): lib/browserCopies.ts and the fees history's ages; categories, never providers. */
export const PRIVACY: DocPage = {
  slug: 'privacy',
  title: 'Privacy',
  summary: 'What this browser keeps and for how long, and who sees your address when the site reads the chain.',
  sections: [
    {
      id: 'this-browser',
      title: 'What this browser keeps',
      blocks: [
        p('Connecting your wallet stores nothing about it on Domino’s servers. This browser keeps short-lived copies, so a page shows at once and then reads again:'),
        {
          kind: 'facts',
          rows: [
            // Fix round 1: a viewed address's tokens too (lib/walletMemory.ts).
            { label: 'Your positions', value: 'A day' },
            { label: 'Token balances', value: 'A day', note: 'Of your wallet and of an address you view.' },
            { label: 'Automated positions', value: '6 hours', note: 'While you are signed in.' },
            { label: 'Receipts', value: '30 days', note: 'While you are signed in.' },
            { label: 'A position’s fee history', value: '7 days', note: 'Public chain data, no wallet in it.' },
            { label: 'Token names', value: '30 days', note: 'Public chain data.' },
            // 2026-10-04 (the owner: docs revalidated for V2): finance/v2/crosschain.ts's deposit journal.
            { label: 'Deposits from another network', value: 'Until you remove one', note: 'The networks, the bridge and the transaction, so a deposit is followed after a reload.' },
          ],
        },
        p('An older copy is never shown, and is deleted the next time the site opens. Disconnecting your wallet here deletes its copies, and signing out deletes the signed-in ones. Clearing this site’s data deletes them all.'),
        // 2026-10-01 (items A1, V7; fix round 1): a viewed address's positions are never kept (OwnedPositions.tsx readOnly).
        p('To draw a position’s fee chart, it also keeps that position’s fees ready to collect each time this browser reads them, now or at a past moment, for 30 days: public chain data, no wallet address. The positions of an address you view are never kept.'),
      ],
    },
    {
      id: 'who-sees',
      title: 'Who sees your address',
      blocks: [
        // RPC-SPEC §7.6 (2026-10-01): no public node is asked.
        p('Your positions, their fees and their history, as the chain has them now, are read by Domino’s own servers, from Domino’s own Robinhood Chain node. Your browser asks only Domino, so no other node sees your address. Your wallet signs and sends through its own connection to the chain.'),
        p('A position’s fees at a past moment, for its chart, are read by Domino’s read service through an archive provider outside Domino. It is given only the position’s number and the block, never your address.'),
        // 2026-10-04 (the owner: docs revalidated for V2): read-v6, position-plan-v1, crosschain-v1 and the wallet's own reads.
        p('Your positions on Base and Arbitrum One, your automation and your Auto-exit come from Domino’s read service, which keeps its own record of Domino’s contracts. A quote, for a position or a deposit, is asked of Domino with your signed-in address; a deposit’s bridge, Relay or Across, is given your address, which sends and receives it. Before you sign, and for Look in my wallet, your wallet reads the network through its own connection.'),
        p('Token pictures and prices come from a public market data provider. Like any site it sees your internet address, never your wallet’s.'),
        p('The Wallet card asks Domino’s read service for a wallet’s tokens by its address. ', doc('Signing in', 'wallet', 'sign-in'), ' tells Domino’s sign-in service your address, for the session.'),
      ],
    },
  ],
}
