import { CAPABILITIES } from '../../capabilities'
import { WALLETCONNECT_PROJECT_ID } from '../../../config/walletConnect'
import { b, diagram, doc, list, p } from '../blocks'
import type { Block, DocPage } from '../types'

/**
 * Written for someone who has never provided liquidity (the owner, 2026-09-27: Domino is built for people who know
 * little or nothing about liquidity pools): short sentences, and each new word explained where it first appears.
 *
 * Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): Domino's new contracts run on three networks, a
 * position's page manages it, a stop-loss or take-profit can protect it, and automation is set up on the position and
 * starts at once. The machinery behind Auto-compound, Domino-compound and Protection only is "your automation" (the
 * owner, 2026-10-04): the reader meets those names, never the contract's.
 */
export const WHAT_IS_DOMINO: DocPage = {
  slug: 'what-is-domino',
  title: 'What Domino is',
  summary: 'Domino helps you earn trading fees with Uniswap positions on Robinhood Chain, Base and Arbitrum One, and can put those fees to work.',
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
          [doc('Domino-compound', 'domino-compound'), ': near the top of its range, its fees open the next position one step higher.'],
        ),
        p('Every position starts plain; you choose what its fees do later, with ', b('Automate'), '.'),
        p('A ', doc('stop-loss or take-profit', 'stop-loss'), ' can also withdraw a position by itself at a price you set.'),
      ],
    },
    {
      id: 'markets-positions-automate',
      title: 'Where things are',
      blocks: [
        list(
          [doc('Markets', 'markets'), ': the pools you can use on Robinhood Chain, with a page for each.'],
          [doc('New position', 'new-position'), ': four steps on Robinhood Chain, Base or Arbitrum One, then your wallet creates the position. Tokens on another network can be ', doc('brought over first', 'bring-funds'), '.'],
          [doc('Positions', 'positions'), ': your positions on Robinhood Chain, Base and Arbitrum One, each with a page where you ', doc('manage it', 'manage-position'), '.'],
          [b('Automate'), ': the three ways and a stop-loss side by side, and where ', doc('Auto-compound', 'auto-compound'), ' and ', doc('Domino-compound', 'domino-compound'), ' are set up.'],
        ),
      ],
    },
    {
      id: 'your-wallet-signs',
      title: 'Your wallet signs every step you take',
      blocks: [
        // 2026-09-27 (review of 260a76a): only your wallet takes your tokens out; Non-custodial says who holds what.
        p('Nothing moves until your wallet signs. Your wallet shows each transaction before you sign it. Domino never holds your keys, and only your wallet can take your tokens out.'),
        p('Signing in is different: it only proves the address is yours, and allows nothing. See ', doc('what signing in proves', 'wallet', 'sign-in'), '.'),
        // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): what runs automation, in the owner's words.
        p('Automation works through a contract made for your wallet alone, which only your wallet controls, and Domino’s automation service acts only within the limits you signed. It starts once your wallet sets it up. See ', doc('Your automation', 'your-automation'), '.'),
      ],
    },
    {
      id: 'built-on-uniswap',
      title: 'Built on Uniswap',
      blocks: [
        p('Uniswap is an exchange made of smart contracts: programs on the chain that anyone can read. Every Domino position is a standard Uniswap position NFT, a token in your wallet that stands for your position. Domino works with Uniswap v3 and v4 pools.'),
        p('Domino’s own contracts run beside them on each of its three networks: one acts on your positions, one runs your automation, one carries out stop-loss and take-profit orders. See ', doc('Contracts', 'contracts'), '.'),
      ],
    },
  ],
}

/** Whether the Connect dialog offers WalletConnect (wallet/walletConnect.ts): the docs name it only then. */
const WALLETCONNECT = /^[0-9a-f]{32}$/.test(WALLETCONNECT_PROJECT_ID)

/** 2026-10-01 (audit C3, C4): a phone, in the Connect dialog's words. What this browser keeps is on Privacy now. */
const PHONE: Block = p(
  'On a phone, open this site in your wallet app’s own browser: with none in the phone’s browser, ',
  b('Connect wallet'),
  ' offers MetaMask, Coinbase Wallet and Trust Wallet to open it in.',
  ...(WALLETCONNECT ? [' It also offers ', b('WalletConnect'), ': scan its code with your wallet app, or open the app from it.'] : []),
)

export const WALLET: DocPage = {
  slug: 'wallet',
  title: 'Wallet and sign-in',
  summary: 'Connect a wallet from a computer or a phone, use Domino’s three networks, and sign in for quotes.',
  sections: [
    {
      id: 'connect',
      title: 'Connect a wallet',
      blocks: [
        p('A wallet holds your tokens and signs for you: an extension in a computer’s browser, or an app on a phone.'),
        p(b('Connect wallet'), ', in the header, lists the wallets in this browser. Choose one to connect it. With none, it offers MetaMask and Rabby to install.'),
        PHONE,
        // Changed on purpose 2026-10-04 (the owner's UI round of 2026-10-03): the wallet dialog shows the address, not the app's name.
        p('Once connected, its dialog shows your address, with ', b('Copy'), ', and whether you are signed in. Connecting moves nothing and proves nothing. What this browser keeps, and who sees your address, is under ', doc('Privacy', 'privacy'), '.'),
      ],
    },
    {
      // The id stays, so links to it still land.
      id: 'robinhood-chain',
      title: 'Networks in your wallet',
      blocks: [
        // Changed on purpose 2026-10-01 (audit C1, the owner's OK): Switch to Robinhood Chain asks a wallet that lacks the
        // network to add it, with the details below (src/wallet/chain.ts ADD_ROBINHOOD_CHAIN, which
        // tests/wallet-compat.test.mjs holds these rows to); they are here too for a wallet that must be told by hand.
        // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): Base and Arbitrum One too, which Domino asks
        // the wallet to switch to and never adds itself ("Add {chain} to your wallet, then try again.").
        p(`Domino works on Robinhood Chain, chain ID ${CAPABILITIES.chainId}, Base, 8453, and Arbitrum One, 42161, and asks your wallet to switch networks when a step needs it. `, b('Switch to Robinhood Chain'), ' also asks it to add that network if it lacks it; to add it by hand:'),
        {
          kind: 'facts',
          rows: [
            { label: 'Network name', value: 'Robinhood Chain' },
            { label: 'Chain ID', value: String(CAPABILITIES.chainId) },
            { label: 'Currency symbol', value: 'ETH' },
            { label: 'RPC URL', value: 'https://rpc.mainnet.chain.robinhood.com' },
            { label: 'Block explorer', value: 'https://robinhoodchain.blockscout.com' },
          ],
        },
        p('If your wallet lacks Base or Arbitrum One, Domino says so: add it there, then try again. Each transaction pays a small network fee, called gas, in ETH: keep a little on each network you use.'),
      ],
    },
    {
      id: 'sign-in',
      title: 'What signing in proves',
      blocks: [
        p('Sign in asks your wallet to sign a short message that names this site, your address and Robinhood Chain. It says: ', b('Sign in to Domino. This request does not authorize transactions or automation.')),
        p('The signature proves you control the address. It approves no token, deposits nothing, swaps nothing, withdraws nothing and starts no automation.'),
        // Changed on purpose 2026-10-01 (audit E16): a smart account signs in; a contract wallet cannot.
        p('A message that does not match this site, your address and the network is never sent to your wallet. Standard wallet accounts can sign in, including ones turned into a smart account; a contract wallet, such as a multisig, cannot.'),
      ],
    },
    {
      id: 'session',
      title: 'Sessions and signing out',
      blocks: [
        p('Signing in starts a session. The wallet control shows when it ends at the latest, and it ends sooner after 30 minutes idle. ', b('Sign out'), ' ends it.'),
        // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): the session is kept across the three networks (session/machine.ts keptChains).
        p('Moving between Domino’s three networks keeps the session; changing account, or moving elsewhere, signs it out.'),
      ],
    },
    {
      id: 'what-needs-sign-in',
      title: 'What needs sign-in',
      blocks: [
        // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): a quote (position-plan-v1) and a deposit from
        // another network (crosschain-v1) are asked for the signed-in wallet; Domino V1's automation cards still need it.
        list(
          ['A quote: for ', doc('New position', 'new-position'), ', and for Add liquidity, Change range or a withdrawal in one token on a position’s page.'],
          [doc('Bringing funds from another network', 'bring-funds'), '.'],
          ['What Domino V1’s automation did, in Managed positions and Receipts on ', doc('Positions', 'positions', 'managed-positions'), '.'],
        ),
        p('Public pages need no sign-in, and neither does a step without a quote, such as collecting fees, closing a position, or setting up automation or a stop-loss.'),
      ],
    },
  ],
}

/** 2026-10-01 (audit E16, E24, C2, C14): what the wallet shows, one signature for all, a request left open. */
export const WALLET_REQUESTS: DocPage = {
  slug: 'wallet-requests',
  title: 'Wallet requests',
  summary: 'What your wallet shows before you sign, signatures that carry a plan, steps signed at once, and requests left open.',
  sections: [
    {
      id: 'before-you-sign',
      title: 'Before you sign',
      blocks: [
        p('Each step Domino asks for opens in your wallet, which shows what the transaction does and its network fee, paid in ETH. Nothing is sent until you confirm it there, and a step you reject sends nothing.'),
        // 2026-10-01 (audit C14). Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): the new contracts'
        // steps say the same in their own words ("Nothing more will be sent from here: check your wallet’s activity").
        p('A step is never sent twice. If you press ', b('Speed up'), ' or ', b('Cancel'), ' in your wallet while Domino waits for a step, or its answer goes missing, Domino reads the network again and sends nothing more on its own: it tells you what happened, or asks you to check your wallet’s activity.'),
      ],
    },
    {
      id: 'signatures',
      title: 'Signatures',
      blocks: [
        p('Some steps are a signature instead of a transaction. ', b('Sign the deposit'), ' signs one message that carries the whole plan, valid for 5 minutes; the transaction after it uses it. An exit order is a signature too: see ', doc('Stop-loss / take-profit', 'stop-loss'), '.'),
        p('A signature does only what it says, and only until it expires. If the transaction that used one fails, Domino offers ', b('Cancel the signature'), ' before a new quote.'),
      ],
    },
    {
      id: 'all-at-once',
      title: 'Sign all steps at once',
      blocks: [
        p('Some wallets confirm every step at once: they all go through together, or none do. Review says so when yours can. A wallet may first ask you to turn on its smart account: your address stays the same, your key stays in control, and the smart account stays on until you turn it off in your wallet.'),
        p('Wallets that cannot, such as Rabby, keep the steps separate, and Review lists each one.'),
      ],
    },
    {
      id: 'request-open',
      title: 'A request still open',
      blocks: [
        p('A step may say an earlier request from this site is still open in your wallet, or not settled on the network yet. Approve or reject it in your wallet. If you already rejected or closed it, press ', b('I rejected it in my wallet'), ': nothing is sent, and your next press checks everything again.'),
      ],
    },
  ],
}
