import { COPY } from '../../read/screens/copy'
import { doc, p } from '../blocks'
import type { DocPage } from '../types'

export const NON_CUSTODIAL: DocPage = {
  slug: 'non-custodial',
  title: 'Non-custodial',
  summary: 'Who holds your positions and fees, what the operator may do, and how you pause, revoke and withdraw.',
  lead: 'When you create an automation using Domino, you are the sole owner and only you can control it. Every step is fully automated by a contract whose controller is your signed wallet.',
  sections: [
    {
      id: 'your-wallet',
      title: 'The position you open stays in your wallet',
      blocks: [
        p('A position you create is a standard Uniswap position NFT in the wallet that signs.'),
        p('When you start Auto-compound or Domino-compound from it, that NFT stays in your wallet. You approve that one NFT to your sequence vault, never all of your NFTs.'),
        // 2026-09-27: Create position deposits through Domino's Setup contract itself (since 2026-09-23), and Setup's own
        // screen is linked from nowhere, so the sentence says where a reader meets a setup operation.
        p('Create position first deposits your tokens in Domino’s Setup contract, then turns them into your position. Until then the tokens you fund wait in a setup operation until you mint or refund. Only your wallet can do either, and a refund carries no Domino fee.'),
      ],
    },
    {
      id: 'sequence-vault',
      title: 'What your sequence vault holds',
      blocks: [
        p('Positions the automation opens, and earned fees not yet added back, are held by your own sequence vault until you withdraw them. Positions it opens are standard Uniswap position NFTs too.'),
        p('Your permission covers earned fees only, including fees still uncollected on your starting position when you create the sequence. Principal is never used.'),
        p('The vault is created for your wallet alone, and no function can change its owner. Only your wallet controls the vault: its withdrawals, limits and operator. Every withdrawal goes to your wallet.'),
      ],
    },
    {
      id: 'operator',
      title: 'What the operator can and cannot do',
      blocks: [
        p('Your wallet stays the vault’s only owner. The operator named in your review can only run fee-only steps within your limits, and pause.'),
        {
          kind: 'split',
          columns: [
            {
              title: 'The operator can',
              items: [
                ['Add a position’s earned fees back into it.'],
                ['Open or fund the next position from earned fees, within your limits.'],
                ['Swap earned fees in the same pool, within your slippage and price-impact limits.'],
                ['Pause automation.'],
              ],
            },
            {
              title: 'The operator cannot',
              items: [
                ['Withdraw positions or fees.'],
                ['Change your limits, or resume automation after a pause.'],
                ['Reduce a position’s liquidity, or pull tokens from your wallet.'],
                ['Send anything to an address of its choosing.'],
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'pause-revoke-withdraw',
      title: 'Pause, revoke and withdraw',
      blocks: [
        {
          kind: 'facts',
          rows: [
            // 2026-10-01 (audit E18): where Pause is (a receipt's How to pause lands here).
            { label: 'Pause', value: 'You or the operator', note: 'Stops automation. Only you can resume it. Your position’s page has the button, no sign-in needed.' },
            { label: 'Change your limits', value: 'You', note: 'The automation rules, and the limits every run is bound by. The paused state is unchanged.' },
            // 2026-10-01 (audit E21): the app's spelling.
            { label: 'Revoke the operator', value: 'You', note: 'Ends its authority over your vault. Once revoked, you can authorize the same operator again.' },
            { label: 'Revoke the NFT approval', value: 'You', note: 'Takes back the vault’s approval of your starting position, stopping automation.' },
            { label: 'Withdraw', value: 'You', note: 'Returns a position or earned fees the vault holds to your wallet.' },
          ],
        },
        // 2026-10-01 (audit E18): which has a screen. What signing in grants is on Wallet and sign-in.
        p('Each is a transaction your wallet signs on your sequence vault, even while paused or without the operator. Pause and fee withdrawals have buttons here; your wallet makes the rest on the block explorer. None carries a service fee.'),
        p(doc('Signing in', 'wallet', 'sign-in'), ' grants none of them.'),
      ],
    },
  ],
}

export const RISKS: DocPage = {
  slug: 'risks',
  title: 'Risks',
  summary: 'What Domino does not remove: moving prices, idle ranges, fees that fall short, automation that stops, and token and contract risk.',
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
        p('Automation adds earned fees to positions. It does not stop a token falling.'),
      ],
    },
    {
      id: 'automation-stops',
      title: 'Automation can stop',
      blocks: [
        // 2026-09-27: a position's page collects fees and closes (components/positions/PositionActions.tsx, since 2026-09-24),
        // and either stops automation on it, as its dialog says; the sentence names them.
        p('Automation stops if the position you started from has its fees collected or its liquidity changed outside Domino, or leaves your wallet. Collect fees and Close position on its page stop it too, and so does revoking the operator or the NFT approval.'),
        p('Restoring the vault’s permission over that position, while the position is still yours and still approved to the vault, or naming the operator again while it is revoked, is a transaction your wallet signs on your sequence vault. Activation stays a separate step you sign.'),
        p('Restoring that permission consents again to the fees the position has not collected, exactly as creating the vault did.'),
        p('After you revoke the NFT approval, or the position leaves your wallet, restarting takes a contract call that no Domino screen makes.'),
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
            { label: 'Managed positions', value: '6 hours', note: 'While you are signed in.' },
            { label: 'Receipts', value: '30 days', note: 'While you are signed in.' },
            { label: 'A position’s fee history', value: '7 days', note: 'Public chain data, no wallet in it.' },
            { label: 'Token names', value: '30 days', note: 'Public chain data.' },
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
        p('Token pictures and prices come from a public market data provider. Like any site it sees your internet address, never your wallet’s.'),
        p('The Wallet card asks Domino’s read service for a wallet’s tokens by its address. ', doc('Signing in', 'wallet', 'sign-in'), ' tells Domino’s sign-in service your address, for the session.'),
      ],
    },
  ],
}
