import { CAPABILITIES } from '../../capabilities'
import { CREATE } from '../../create/copy'
import { COPY } from '../../read/screens/copy'
import { b, doc, p } from '../blocks'
import type { DocPage } from '../types'

const { feeLabels, feeValues, feeNotes } = CREATE.review

export const FEES: DocPage = {
  slug: 'fees',
  title: 'Fees',
  summary: 'The Domino service fee, the assisted swap fee, network gas and the pool’s trading fee.',
  sections: [
    {
      id: 'at-a-glance',
      title: 'At a glance',
      blocks: [
        {
          kind: 'facts',
          rows: [
            { label: feeLabels.service, value: feeValues.service, note: 'Once, when Auto-compound or Domino-compound consumes earned fees. Never on principal, never on a direct deposit.' },
            { label: feeLabels.swap, value: feeValues.swap, note: feeNotes.swap },
            { label: feeLabels.gas, value: 'Paid by the wallet that sends it', note: 'Your wallet pays for the steps you sign; each shows its gas limit before you sign.' },
            { label: feeLabels.pool, value: 'The pool’s fee tier', note: 'Paid by swappers to the pool’s liquidity providers, on each trade. Not a charge on your deposit; a swap you make pays it.' },
          ],
        },
      ],
    },
    {
      id: 'service-fee',
      title: 'Domino service fee',
      blocks: [
        p('Auto-compound charges 2% of consumed earned fees. Domino-compound charges 4% for every automated recipe, including reinvestment into the source. Each is taken once; changing the mode and rate requires a reviewed owner transaction.'),
        p('It is never charged on principal, on a direct deposit or on a withdrawal. Earned fees that wait are not charged, and an automation transaction that fails charges nothing.'),
        p('Gas for automation transactions is paid by the operator that sends them, and is included in the fee.'),
      ],
    },
    {
      id: 'assisted-swap-fee',
      title: 'Assisted swap fee',
      blocks: [
        p('0.65% of the amount swapped. It applies only when your wallet holds one of a new position’s two tokens and Create position swaps part of it for the other inside the same pool; Review shows the swap, and your wallet shows it before you sign.'),
        p('It is not added on top of the service fee, and the automation’s own balancing swaps carry no swap fee.'),
      ],
    },
    {
      id: 'network-gas',
      title: 'Network gas',
      blocks: [p('Gas is paid in ETH by the wallet that sends the transaction. Your wallet pays for the steps you sign, and each step shows its gas limit before you sign it.')],
    },
    {
      id: 'pool-trading-fee',
      title: 'Pool trading fee',
      blocks: [
        p('Swappers pay a pool’s fee tier to its liquidity providers, on each trade. It is what an in-range position earns, not a charge on your deposit. A swap you make, such as the one Create position makes when your wallet holds one token, pays it, and any protocol fee, like any other. See ', doc('Pools and fee tiers', 'pools', 'fee-tiers'), '.'),
      ],
    },
  ],
}

/**
 * Categories, never providers: a provider can change, what each category means cannot.
 * Domino history comes first where a deployment provides it; the provider's figures and the estimate are the fallback.
 * No word here calls a figure current, live, updated or qualified (tests/docs.test.mjs).
 */
export const FIGURES: DocPage = {
  slug: 'figures',
  title: 'Figures and sources',
  summary: 'Where each figure comes from: the chain, Domino’s own pool history, a market data provider, or a calculation by Domino.',
  sections: [
    {
      id: 'read-from-chain',
      title: 'Read from chain',
      blocks: [
        p('Pool prices, ticks, fee tiers, protocol fees, tick spacings and hooks, position NFTs and token balances are read from Robinhood Chain. Each names the block it was read at.'),
        p('A pool’s price is the ratio between its two tokens at that block, not a dollar price.'),
        p('A pool’s on-chain activity and the positions in it come from indexed chain events, up to a named block. Activity indexed too far behind the chain shows dashes.'),
      ],
    },
    {
      id: 'domino-history',
      title: 'Domino history',
      blocks: [
        p('Where the deployment provides it, Domino keeps its own record of each pool’s last 24 hours. When that record covers them in full, a pool’s TVL, 24h volume, 24h fees and APR come from it, marked ', b('Domino history'), '.'),
        p('Otherwise TVL and 24h volume are a provider’s, and the APR is the estimate below or an older full day of Domino history, dated in its title. 24h fees come only from Domino history.'),
      ],
    },
    {
      id: 'reported-by-a-provider',
      title: 'Reported by a provider',
      blocks: [
        p('TVL and 24h volume that Domino history does not cover, and hourly candles of either token’s USD price with volume, come from a market data provider, named in each figure’s title. Domino does not reconcile them with chain data.'),
      ],
    },
    {
      id: 'calculated-by-domino',
      title: 'Calculated by Domino',
      blocks: [
        // Each term is held together with no-break spaces, so on a phone the formula wraps only at a ×.
        p('Estimated APR is calculated from the provider’s 24h volume and TVL, the pool’s fixed fee and its protocol fee: ', { mono: '24h\u00a0volume × fee\u00a0tier × (1\u00a0−\u00a0protocol\u00a0fee) × 365\u00a0÷\u00a0TVL' }, '. No estimate is given when a pool’s protocol fee differs by swap direction. It leaves out rewards, gas, service fees and price changes.'),
        p('A pool’s 24h volume over TVL is also calculated by Domino, from two figures of the same source.'),
        p(COPY.figures.caveat),
      ],
    },
    {
      id: 'age',
      title: 'Source and age',
      blocks: [
        p('A provider’s figure names the provider in its title, with how long ago it was retrieved, and a figure read from chain names its block. In a pools table, hover a pool’s name for its row’s sources, including how old its Domino history is.'),
        p('An older figure keeps the same type, and its title says so.'),
      ],
    },
    {
      id: 'unavailable',
      title: 'Missing figures',
      blocks: [
        p('A figure that could not be read, or has grown too old to use, shows as a dash or as Unavailable, and one its source did not report shows as Not reported. Domino history over less than a full 24 hours shows a word saying so, not a number. None is shown as zero, and each title says what is missing.'),
      ],
    },
  ],
}

export const CONTRACTS: DocPage = {
  slug: 'contracts',
  title: 'Contracts',
  summary: 'Domino V1 and the Uniswap contracts it builds on, on Robinhood Chain, with their addresses.',
  sections: [
    {
      // docs/deployments/v1-robinhood-mainnet-2026-09-21: the two contracts a wallet meets. The vault is a clone made per owner, so it has no address here.
      id: 'domino-contracts',
      title: 'Domino V1 on Robinhood Chain',
      blocks: [
        p('Domino’s own contracts are deployed on Robinhood Chain as Domino V1. Your wallet meets two of them directly, besides your own sequence vault: the Setup contract, which holds a setup operation until you mint or refund, and the factory that creates your sequence vault.'),
        {
          kind: 'addresses',
          rows: [
            { label: 'DominoSetupV1', role: 'Setup operations: fund, assisted swap, mint, refund', address: '0x676f449fcfcd0f5ce4c7a1db2d98c7d6565dd37a' },
            { label: 'DominoVaultFactoryV1', role: 'Creates your sequence vault', address: '0x16bf6eaba7b31118627b277e97249720dfe1c7ff' },
          ],
        },
        p('Your sequence vault is a contract of its own, created for your wallet by the factory. Service readiness is checked for each owner and vault before this site offers activation: see ', doc('Domino Compounder', 'domino-compounder', 'start-and-stop'), '.'),
      ],
    },
    {
      id: 'uniswap-contracts',
      title: 'Uniswap contracts on Robinhood Chain',
      blocks: [
        p('Domino positions live in Uniswap’s own deployment on Robinhood Chain.'),
        {
          kind: 'addresses',
          rows: [
            { label: 'PoolManager', role: 'Every pool’s state and swaps', address: '0x8366a39cc670b4001a1121b8f6a443a643e40951' },
            { label: 'PositionManager', role: 'Position NFTs', address: '0x58daec3116aae6d93017baaea7749052e8a04fa7' },
            { label: 'StateView', role: 'Pool prices and ticks', address: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b' },
            { label: 'Permit2', role: 'Token allowances for deposits', address: '0x000000000022d473030f116ddee9f6b43ac78ba3' },
          ],
        },
      ],
    },
    {
      id: 'network',
      title: 'Network',
      blocks: [
        {
          kind: 'facts',
          rows: [
            { label: 'Network', value: 'Robinhood Chain' },
            { label: 'Chain ID', value: String(CAPABILITIES.chainId) },
            { label: 'Gas token', value: 'ETH' },
          ],
        },
      ],
    },
  ],
}

export const GLOSSARY: DocPage = {
  slug: 'glossary',
  title: 'Glossary',
  summary: 'The words Domino uses, in one place.',
  sections: [
    {
      id: 'pools-and-positions',
      title: 'Pools and positions',
      blocks: [
        {
          kind: 'terms',
          items: [
            { id: 'pool', term: 'Pool', text: ['A Uniswap pool that trades two tokens, defined by its tokens, fee, tick spacing and hooks.'] },
            { id: 'pool-id', term: 'Pool id', text: ['The identifier a pool’s definition gives it. Domino identifies a pool by its id, never by a symbol.'] },
            { id: 'fee-tier', term: 'Fee tier', text: ['The share of every swap a pool charges, paid by swappers to its liquidity providers.'] },
            { id: 'dynamic-fee', term: 'Dynamic fee', text: ['A fee set by a hook contract instead of fixed in the pool.'] },
            { id: 'protocol-fee', term: 'Protocol fee', text: ['Uniswap’s fee on a pool’s swaps, taken from what a swap sells into the pool before the fee tier. It does not go to liquidity providers.'] },
            { id: 'range', term: 'Range', text: ['The lower and upper price a position provides liquidity between.'] },
            { id: 'tick', term: 'Tick', text: ['Uniswap’s unit of price, a 0.01% step. Range bounds are multiples of a pool’s tick spacing.'] },
            { id: 'in-range', term: 'In range', text: ['A position is in range while the pool price sits inside its range. Only then does it earn trading fees.'] },
            { id: 'position-nft', term: 'Position NFT', text: ['The standard Uniswap NFT that represents a position. Positions lists the ones your wallet created with Domino.'] },
            { id: 'principal', term: 'Principal', text: ['The liquidity deposited in a position. Automation never reduces it.'] },
          ],
        },
      ],
    },
    {
      id: 'fees-and-figures',
      title: 'Fees and figures',
      blocks: [
        {
          kind: 'terms',
          items: [
            { id: 'earned-fees', term: 'Earned fees', text: ['Trading fees a position has earned while in range.'] },
            { id: 'unsettled-fees', term: 'Unsettled fees', text: ['Earned fees not yet collected from a position.'] },
            { id: 'service-fee', term: 'Service fee', text: ['Domino’s fee on automation: Auto-compound 2%; Domino-compound 4% of earned fees consumed, once.'] },
            { id: 'assisted-swap-fee', term: 'Assisted swap fee', text: ['The fee on the swap Create position makes when your wallet holds one of the two tokens: 0.65% of the amount swapped.'] },
            { id: 'domino-history', term: 'Domino history', text: ['Domino’s own record of a pool’s last 24 hours, where the deployment provides it. Figures from it are marked Domino history.'] },
            { id: 'tvl', term: 'TVL', text: ['Total value locked: the value of the tokens in a pool, from Domino history or, where it has none, a market data provider.'] },
            { id: 'volume-24h', term: '24h volume', text: ['The value swapped through a pool over the last 24 hours, from Domino history or, where it has none, a market data provider.'] },
            {
              id: 'estimated-apr',
              term: 'Estimated APR',
              text: ['A yearly rate calculated from a pool’s reported 24h volume and TVL, its fee tier and its protocol fee. It describes the pool, not a position, and is shown where Domino history gives no APR.'],
            },
          ],
        },
      ],
    },
    {
      id: 'automation',
      title: 'Automation',
      blocks: [
        {
          kind: 'terms',
          items: [
            { id: 'self-managing', term: 'Self-managing', text: ['No automation: earned fees wait in the position until you collect them.'] },
            { id: 'auto-compound', term: 'Auto-compound', text: ['Automation that adds a position’s earned fees back into the same position.'] },
            {
              id: 'domino-compounder',
              term: 'Domino Compounder',
              text: ['Automation that, near the top of a range, uses earned fees to open or fund the next position one step higher. In the app it is Domino-compound.'],
            },
            { id: 'sequence', term: 'Sequence', text: ['The vault contract created for your wallet that holds the positions automation opens and earned fees not yet reinvested. Only your wallet can withdraw from it.'] },
            { id: 'operator', term: 'Operator', text: ['The address that carries out automation within your limits. It can pause, but cannot withdraw, change limits or resume.'] },
            { id: 'trigger-distance', term: 'Trigger distance', text: ['How near the top of its range the price must be before a next position is considered. Up to 20%.'] },
            { id: 'maximum-overlap', term: 'Maximum overlap', text: ['How far below the previous ceiling a next position’s floor may start. Up to 20%.'] },
            { id: 'upside', term: 'Upside', text: ['How far above the previous ceiling a next position’s ceiling sits, at least. You set it; the app draws it at 50%.'] },
          ],
        },
      ],
    },
    {
      id: 'wallet',
      title: 'Wallet',
      blocks: [
        {
          kind: 'terms',
          items: [
            { id: 'sign-in', term: 'Sign-in', text: ['A signature over a message that proves you control an address. It authorizes no transaction and no automation.'] },
            { id: 'session', term: 'Session', text: ['What signing in starts. It ends after 30 minutes idle, at its end time, or when you sign out.'] },
            { id: 'setup', term: 'Setup', text: ['Domino V1’s setup contract: it holds a deposit until its position is minted.'] },
            { id: 'receipt', term: 'Receipt', text: ['A record of a transaction automation submitted and what it did, on Positions once you sign in.'] },
          ],
        },
      ],
    },
  ],
}
