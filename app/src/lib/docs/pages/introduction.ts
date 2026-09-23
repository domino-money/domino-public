import { CAPABILITIES } from '../../capabilities'
import { b, doc, list, p } from '../blocks'
import type { DocPage } from '../types'

export const WHAT_IS_DOMINO: DocPage = {
  slug: 'what-is-domino',
  title: 'What Domino is',
  summary: 'Domino opens Uniswap positions on Robinhood Chain and puts their earned fees to work.',
  sections: [
    {
      id: 'what-it-does',
      title: 'What it does',
      blocks: [
        p('You pick a Uniswap pool and a price range, and open a position. While the price stays inside that range, the position earns a share of the pool’s trading fees.'),
        p('Then you choose what those fees do: wait in the position, go back into it, or open the next position one step higher. Automation acts only within limits your wallet signs.'),
      ],
    },
    {
      id: 'markets-positions-automate',
      title: 'Markets, Positions and Automate',
      blocks: [
        list(
          [doc('Markets', 'markets'), ' lists Uniswap pools on Robinhood Chain, with a page for each pool.'],
          [doc('New position', 'new-position'), ' plans a pool, a range and an amount, then creates the position with your wallet.'],
          [doc('Positions', 'positions'), ' looks up any position NFT, and shows your managed positions once you sign in.'],
          [b('Automate'), ' holds the two ways to put earned fees to work: ', doc('Auto-compound', 'auto-compound'), ' and ', doc('Domino-compound', 'domino-compounder'), '.'],
        ),
      ],
    },
    {
      id: 'your-wallet-signs',
      title: 'Your wallet signs every step you take',
      blocks: [
        p('Nothing moves until your wallet signs. Each wallet step is reviewed on its own, and shows its amounts, destination and limits before your wallet asks you to sign it.'),
        p('Signing in is not one of those steps: it proves you control an address and allows nothing. See ', doc('what signing in proves', 'wallet', 'sign-in'), '.'),
        p('Once you activate automation, its operator sends automation transactions within the limits you signed. See ', doc('what the operator can do', 'non-custodial', 'operator'), '.'),
        p('A new sequence starts paused. This site offers activation only to its signed-in owner after the live service confirms readiness for that exact sequence. If the check fails, pause, revocation, repair and withdrawal still work through your wallet.'),
      ],
    },
    {
      id: 'built-on-uniswap',
      title: 'Built on Uniswap',
      blocks: [
        p('Every Domino position is a standard Uniswap position NFT on Robinhood Chain.'),
        p('Domino’s own contracts, Domino V1, are deployed there as well: Setup opens positions, and a factory creates your sequence vault. They are listed under ', doc('Contracts', 'contracts'), ', with the Uniswap contracts behind every position.'),
      ],
    },
  ],
}

export const WALLET: DocPage = {
  slug: 'wallet',
  title: 'Wallet and sign-in',
  summary: 'Connect a browser wallet on Robinhood Chain, and sign in where a screen needs it.',
  sections: [
    {
      id: 'connect',
      title: 'Connect a browser wallet',
      blocks: [
        p(b('Connect wallet'), ', in the header, lists the wallets installed in this browser. Choose one to connect it.'),
        p('Connecting shows your address to the page. On its own it proves nothing about who controls that address, and it moves nothing.'),
        p('Domino stores nothing about the connection. Your wallet keeps its own permission for this site.'),
      ],
    },
    {
      id: 'robinhood-chain',
      title: 'Robinhood Chain in your wallet',
      blocks: [
        p(`Domino works on Robinhood Chain only, chain ID ${CAPABILITIES.chainId}. When your wallet is on another network, the wallet control offers `, b('Switch to Robinhood Chain'), '. If your wallet does not list the network, add it in the wallet first.'),
        p('Network gas on Robinhood Chain is paid in ETH.'),
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
        list(
          ['Deposit drafts kept by the deposit service, and their receipts.'],
          ['The assisted swap quote in Setup.'],
          ['Managed positions and automation receipts, on ', doc('Positions', 'positions', 'managed-positions'), '.'],
          ['Checking whether the automation service is ready for your sequence before activation.'],
        ),
        p('Public pages need no sign-in. Neither do a setup operation’s steps (fund, swap, mint and refund), sequence creation, pause, revocation, repair or withdrawal: they work with your wallet alone. Activation also requires a live service check bound to your signed-in address and your sequence vault.'),
      ],
    },
  ],
}
