import { CAPABILITIES } from '../../capabilities'
import { b, diagram, doc, list, p } from '../blocks'
import type { DocPage } from '../types'

/**
 * Written for someone who has never provided liquidity (the owner, 2026-09-27: Domino is built for people who know
 * little or nothing about liquidity pools): short sentences, and each new word explained where it first appears.
 */
export const WHAT_IS_DOMINO: DocPage = {
  slug: 'what-is-domino',
  title: 'What Domino is',
  summary: 'Domino helps you earn trading fees with a Uniswap position on Robinhood Chain, and can put those fees back to work.',
  sections: [
    {
      id: 'what-it-does',
      title: 'What it does',
      blocks: [
        p('People trade one token for another in a pool, and every trade pays a small fee. You can supply the two tokens those trades draw on. That makes you a liquidity provider, and you earn a share of the fees.'),
        p('Your share lives in a position: your tokens in one pool, between a lowest and a highest price you choose, called your range. While the price stays inside your range, the position earns fees. See ', doc('Price ranges', 'ranges'), '.'),
        diagram('earning', 'Trades made while the price is inside your range pay your position a fee.', 'A price line moving over time across a shaded band, your range. While the line is inside the band it is drawn bright, with fee dots above it; outside the band it is grey.'),
      ],
    },
    {
      id: 'three-features',
      title: 'One position, three ways',
      blocks: [
        diagram('three-ways', 'What a position’s fees can do.', 'Three small scenes. Plain position: fees pile up beside the position. Auto-compound: fees go back into the same position, which grows. Domino-compound: fees open a second position one step higher.'),
        list(
          [b('Plain position'), ': opened in ', doc('New position', 'new-position'), '. Its fees wait in it until you collect them.'],
          [doc('Auto-compound', 'auto-compound'), ': its fees go back into the same position, so it grows.'],
          [doc('Domino-compound', 'domino-compounder'), ': near the top of its range, its fees open the next position one step higher.'],
        ),
        p('Every position starts plain. You choose what its fees do when Create position finishes, or later with ', b('Automate'), ' on the position in Positions.'),
      ],
    },
    {
      id: 'markets-positions-automate',
      title: 'Where things are',
      blocks: [
        list(
          [doc('Markets', 'markets'), ': the pools you can use, with a page for each.'],
          [doc('New position', 'new-position'), ': four steps, then your wallet creates the position.'],
          [doc('Positions', 'positions'), ': your positions, each with its own page, where you collect its fees or close it.'],
          [b('Automate'), ': the three ways side by side, and where ', doc('Auto-compound', 'auto-compound'), ' and ', doc('Domino-compound', 'domino-compounder'), ' are set up.'],
        ),
      ],
    },
    {
      id: 'your-wallet-signs',
      title: 'Your wallet signs every step you take',
      blocks: [
        // 2026-09-27 (review of 260a76a): Create position deposits in Domino's Setup contract before the mint (custody.ts), so
        // the page no longer says Domino never holds your tokens; it says what is true, that only your wallet takes them out.
        p('Nothing moves until your wallet signs. Your wallet shows each transaction before you sign it. Domino never holds your keys, and only your wallet can take your tokens out.'),
        p('Signing in is different: it only proves the address is yours, and allows nothing. See ', doc('what signing in proves', 'wallet', 'sign-in'), '.'),
        // 2026-09-27 (review of 260a76a, the owner's point 6): sequence vault and operator explained where a beginner first
        // meets them; activation, revocation and withdrawal are left to Non-custodial, which explains each.
        p('Automation works through a sequence vault: a contract made for your wallet alone, which only your wallet controls. Domino’s automation service, the operator, sends its transactions within the limits you signed. See ', doc('what the operator can do', 'non-custodial', 'operator'), '.'),
        // Changed on purpose (2026-09-25, audit of 754014c): no screen of this site offers activation any more.
        // Changed on purpose again (owner, 2026-09-25): a position's page offers Turn on once the service is ready, and Pause.
        // Turn on and Pause have no review wall (the owner's rule), so they go straight to the wallet (review of 2026-09-25).
        p('Automation starts paused. Once the service is ready for it, your position’s page offers Turn on, and Pause while it runs. Turn on and Pause go straight to your wallet, which shows the transaction.'),
      ],
    },
    {
      id: 'built-on-uniswap',
      title: 'Built on Uniswap',
      blocks: [
        p('Uniswap is an exchange made of smart contracts: programs on the chain that anyone can read. Every Domino position is a standard Uniswap position NFT on Robinhood Chain, a token in your wallet that stands for your position.'),
        // 2026-09-27 (review of 260a76a): no contract names a beginner has not met; Contracts names them.
        p('Domino’s own contracts, Domino V1, run there too: one opens your positions, and another makes your sequence vault. They are listed under ', doc('Contracts', 'contracts'), ', with the Uniswap contracts behind every position.'),
      ],
    },
  ],
}

export const WALLET: DocPage = {
  slug: 'wallet',
  title: 'Wallet and sign-in',
  summary: 'Connect a browser wallet on Robinhood Chain, and sign in to see your automation’s receipts and figures.',
  sections: [
    {
      id: 'connect',
      title: 'Connect a browser wallet',
      blocks: [
        p('A wallet is the app that holds your tokens and signs for you, such as a browser extension.'),
        p(b('Connect wallet'), ', in the header, lists the wallets installed in this browser. Choose one to connect it.'),
        p('Connecting only shows your address to the page. It moves nothing and proves nothing, and Domino stores nothing about it.'),
      ],
    },
    {
      id: 'robinhood-chain',
      title: 'Robinhood Chain in your wallet',
      blocks: [
        p(`Domino works on Robinhood Chain only, chain ID ${CAPABILITIES.chainId}. When your wallet is on another network, the wallet control offers `, b('Switch to Robinhood Chain'), '. If your wallet does not list the network, add it in the wallet first.'),
        p('Every transaction pays a small network fee, called gas, in ETH. Keep a little ETH in your wallet for it.'),
      ],
    },
    {
      id: 'sign-in',
      title: 'What signing in proves',
      blocks: [
        p('Sign in asks your wallet to sign a short message that names this site, your address and Robinhood Chain. It says: ', b('Sign in to Domino. This request does not authorize transactions or automation.')),
        p('The signature proves you control the address. It approves no token, deposits nothing, swaps nothing, withdraws nothing and starts no automation.'),
        p('A message that does not match this site, your address and the network is never sent to your wallet. Only standard wallet accounts can sign in, not an address with contract code.'),
      ],
    },
    {
      id: 'session',
      title: 'Sessions and signing out',
      blocks: [
        p('Signing in starts a session. The wallet control shows when it ends at the latest, and it ends sooner after 30 minutes idle. ', b('Sign out'), ' ends it.'),
        p('If your wallet changes account or network, the session is signed out.'),
      ],
    },
    {
      id: 'what-needs-sign-in',
      title: 'What needs sign-in',
      blocks: [
        // 2026-09-27: a position's page shows what Auto-compound added back with no sign-in (lib/automationImpact.ts reads it
        // from the chain), so the list names only the two cards that need a session.
        list(['Managed positions and Receipts, on ', doc('Positions', 'positions', 'managed-positions'), ': what automation did across your positions.'], ['Checking whether the automation service is ready for your sequence before activation.']),
        p('Public pages need no sign-in, a position’s page included, with what automation added back to it. Neither does anything your wallet does: creating a position, collecting its fees, closing it, setting up automation, pausing, revoking or withdrawing. Activation is the one step that also requires a live service check bound to your signed-in address and your sequence vault.'),
      ],
    },
  ],
}
