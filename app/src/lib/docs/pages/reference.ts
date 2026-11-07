import { CAPABILITIES } from '../../capabilities'
import { CREATE } from '../../create/copy'
import { b, doc, p } from '../blocks'
// 2026-11-06: Elysium's words where it is live (../elysium.ts).
import { ELYSIUM_LINKED, ELYSIUM_LIVE, ELYSIUM_PERMIT2, ELYSIUM_POSITION_MANAGER, ELYSIUM_V2_ID, GAS_IN, NETWORKS, NETWORKS_OR, OTHERS } from '../elysium'
import type { DocChain, DocPage } from '../types'

const { feeLabels, feeValues } = CREATE.review

/** 2026-10-30 (QA2 N24): the networks an address row's explorer links name; 2026-11-07: Elysium once linked. */
const EVERY_NETWORK: readonly DocChain[] = ELYSIUM_LINKED ? [4663, 8453, 42161, ELYSIUM_V2_ID as DocChain] : [4663, 8453, 42161]
/** 2026-11-06: Domino's v3 contracts' networks; a v4-only one never joins (docs/ELYSIUM_DAY9.md). */
const V3_NETWORKS: readonly DocChain[] = [4663, 8453, 42161]
const ROBINHOOD = [4663] as const
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'

/**
 * Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): Domino's five fees (spec F7 §1.6), each with when
 * it applies, and when nothing is charged ("Sem tarifa Domino").
 */
export const FEES: DocPage = {
  slug: 'fees',
  title: 'Fees',
  summary: 'Domino’s fees, when each applies and when nothing is charged, network gas and the pool’s trading fee.',
  sections: [
    {
      id: 'at-a-glance',
      title: 'At a glance',
      blocks: [
        {
          kind: 'facts',
          rows: [
            { label: feeLabels.swap, value: feeValues.swap, note: 'When something you do needs a swap. Once per action.' },
            // 2026-10-30 (QA2 N71): Domino's fee (bridgeAppFeeBps), as Bring funds says.
            { label: 'Deposit from another network', value: '0.35% of the amount deposited', note: 'Domino’s fee, which Relay or Across collects. The bridge’s own fee and network gas come on top, in the quote. None if you bridge another way.' },
            { label: feeLabels.service, value: feeValues.service, note: 'On the earned fees automation uses, each time. Never on principal, never on a direct deposit.' },
            { label: 'Auto-exit fee', value: '0.2% of the position’s value, principal included', note: 'When Auto-exit closes a position: the only fee.' },
            // Changed on purpose 2026-10-01 (audit E24).
            { label: feeLabels.gas, value: 'Paid by the wallet that sends it', note: 'Your wallet pays for the steps you sign, and shows the network fee before you sign.' },
            { label: feeLabels.pool, value: 'The pool’s fee tier', note: 'Paid by swappers to the pool’s liquidity providers, on each trade. Not a charge on your deposit; a swap you make pays it.' },
          ],
        },
      ],
    },
    {
      id: 'no-fee',
      title: 'When nothing is charged',
      blocks: [
        p('No Domino fee for finding pools, connecting your wallet, creating or adding without a swap, changing a range without a swap, withdrawing in both tokens, collecting fees, withdrawing from your automation, pausing, turning off Auto-exit or revoking a permission.'),
      ],
    },
    {
      id: 'assisted-swap-fee',
      title: 'Assisted swap fee',
      blocks: [
        p('0.65% of the amount swapped, once per action: of 500 USDG swapped, 3.25 USDG. Review shows it before you sign, and the receipt the exact fee.'),
        p('It is not added on top of the service fee, and the automation’s own balancing swaps carry no swap fee.'),
      ],
    },
    {
      id: 'service-fee',
      title: 'Domino service fee',
      blocks: [
        // 2026-09-27 (review of 260a76a): the example counts the fees Auto-compound uses, of which 98 go back.
        p('Auto-compound charges 2% of the earned fees it uses. Domino-compound charges 4% for every automated step, including putting fees back into the same position. Each run is charged once: of 100 USDG of fees Auto-compound uses, 2 go to the service fee and 98 back into your position.'),
        p('It is never charged on principal, on a deposit or on a withdrawal. Earned fees that wait are not charged, a run that fails charges nothing, and Domino pays the runs’ gas.'),
      ],
    },
    {
      id: 'network-gas',
      title: 'Network gas',
      // Changed on purpose 2026-10-01 (audit E24). 2026-10-04 (the owner: docs revalidated for V2): on each network, and Base's L1 data fee.
      blocks: [p(`Gas is paid ${ELYSIUM_LIVE ? 'in ETH, or in HYPE on Elysium,' : 'in ETH'} on the network of the transaction, by the wallet that sends it, which shows it before you sign. On Base it includes the L1 data fee, for storing the transaction on Ethereum.`)],
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
        // 2026-10-04 (the owner: docs revalidated for V2): read-v6, the record of Domino's new contracts on the three networks.
        // Changed on purpose 2026-11-06 (O-19, R-07): read-v6's dollars; position-fees, worded to hold before and after it opens.
        p(`Positions on ${OTHERS}, and in Uniswap v3 pools, come from Domino’s record of its contracts, read at a named block. Their dollar values use prices Domino reads on each network, or the pool’s own price when a token has none. Their Fees earned and APR come from Domino’s record of their fees, where it follows them.`),
        p('A pool’s activity and the positions in it come from indexed chain events, up to a named block; activity indexed too far behind shows dashes.'),
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
        // Changed on purpose 2026-10-01 (audit E19).
        p('TVL and 24h volume that Domino history does not cover, and hourly candles of either token’s USD price with volume, come from a market data provider, as each figure’s title says. Domino does not reconcile them with chain data.'),
        // 2026-10-01 (item V1, lib/read/figureFallback.ts).
        p('When it does not answer, a figure may stand in: the last one this browser saw, a second provider’s, or the one today’s list was chosen with, its title saying which and when.'),
      ],
    },
    {
      id: 'calculated-by-domino',
      title: 'Calculated by Domino',
      blocks: [
        // Each term is held together with no-break spaces, so on a phone the formula wraps only at a ×.
        p('Estimated APR is calculated from the provider’s 24h volume and TVL, the pool’s fixed fee and its protocol fee: ', { mono: '24h volume × fee tier × (1 − protocol fee) × 365 ÷ TVL' }, '. No estimate is given when a pool’s protocol fee differs by swap direction. It leaves out rewards, gas, service fees and price changes.'),
      ],
    },
    {
      id: 'age',
      title: 'Source and age',
      blocks: [
        // Changed on purpose 2026-10-01 (audit E19).
        p('A provider’s figure says in its title that a market data provider reported it, and how long ago, and a figure read from chain names its block. In a pools table, hover a pool’s name for its row’s sources, including how old its Domino history is.'),
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

/**
 * Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): Domino's contracts, one address on the three
 * networks (CREATE3, spec F7 §1.3, §7.2). Changed on purpose 2026-10-04 (V2 deployed, #327; the owner: the docs show the V2
 * contracts): their 13 addresses, from the verified records the app pins (docs/deployments/v2-*-2026-10-04, src/v2/
 * manifest.ts), each under its own contract name. Domino V1's live addresses exactly as before, and its automation ending
 * with no migration (spec §1.1); the Uniswap contracts the positions live in, from the backend's constants (Robinhood
 * Chain) and the chain profiles (api-contracts/v2/chains). "Vault" is said here once, as the contract's own name (the
 * owner, 2026-10-04).
 */
export const CONTRACTS: DocPage = {
  slug: 'contracts',
  title: 'Contracts',
  summary: `Domino’s contracts on its ${ELYSIUM_LIVE ? 'four' : 'three'} networks, Domino V1 on Robinhood Chain, and the Uniswap contracts behind every position.`,
  sections: [
    {
      id: 'new-contracts',
      title: 'Domino’s contracts',
      blocks: [
        p(`Domino’s contracts run on ${NETWORKS}, each at one address on every network, so check the network as well as the address.${ELYSIUM_LIVE ? ' Elysium has Uniswap v4 only, so the Uniswap v3 ones are not on it.' : ''}`),
        {
          kind: 'addresses',
          rows: [
            { label: 'DominoZapV4', role: 'Create, add, change range and withdraw, in Uniswap v4', address: '0x376b92929bbe778c6dd64e8d73f8688686288e8a', chains: EVERY_NETWORK, domino: true },
            { label: 'DominoZapV4Steps', role: 'DominoZapV4’s helper', address: '0x355b0997d5e04392862a8e8d21d911851b2eefbe', chains: EVERY_NETWORK, domino: true },
            { label: 'DominoZapV3', role: 'The same in Uniswap v3', address: '0xe30d7e07a67198c45d4c7b67d8423cbb6c7ea5a0', chains: V3_NETWORKS, domino: true },
            { label: 'DominoV2VaultFactory', role: 'Makes each automation contract (vault), Uniswap v4', address: '0xc71a561853514efc2271f1d10c13ec95834792ba', chains: EVERY_NETWORK, domino: true },
            { label: 'DominoV2VaultFactory', role: 'The same, Uniswap v3', address: '0xa7dfb61a6597d09742cb7f9a8780c9c74ebc34f4', chains: V3_NETWORKS, domino: true },
            { label: 'DominoV2VaultV4', role: 'What each Uniswap v4 automation copies', address: '0xa3ff8d74e4ec4a19f35d92b7eec852ba6f7e2bbb', chains: EVERY_NETWORK, domino: true },
            { label: 'DominoV2VaultV3', role: 'What each Uniswap v3 automation copies', address: '0xd55c0f5ff8ad1ded828edb36be77e0f3677ad4a4', chains: V3_NETWORKS, domino: true },
            { label: 'DominoV2VaultExecutorV4', role: 'Runs automation steps, Uniswap v4', address: '0xf3f68d8461c2071e2b8d88a60ce64f527f1d6639', chains: EVERY_NETWORK, domino: true },
            { label: 'DominoV2VaultExecutorV3', role: 'The same, Uniswap v3', address: '0xd8d3bf832b234855fee2ac36ac4803aa7f9adca9', chains: V3_NETWORKS, domino: true },
            { label: 'DominoV2VaultSwapModule', role: 'Automation swaps', address: '0xbf22a36bbb419846e073cf0c6c729f669d7f348a', chains: EVERY_NETWORK, domino: true },
            { label: 'DominoAutoExit', role: 'Carries out Auto-exit; 0.2% when it closes a position', address: '0x6109fc514a88a8e85e6e5c863238ddba9a98be36', chains: EVERY_NETWORK, domino: true },
            { label: 'DominoRegistry', role: 'Fee currencies, swap routes, and stopping automation for safety', address: '0x25d4f013ecff3790e384e16ca9951bba6cd715fa', chains: EVERY_NETWORK, domino: true },
            { label: 'DominoPriceAnchor', role: 'The reference price automation and Auto-exit check', address: '0x8c1edc4280d9533f6336f760380ba329e1f81f43', chains: EVERY_NETWORK, domino: true },
          ],
        },
        p('Each contract that charges a fee pays it to Domino’s fee recipient. A fee it cannot pay at once waits in that contract, apart from your funds, until it is paid.'),
      ],
    },
    {
      // docs/deployments/v1-robinhood-mainnet-2026-09-21: the two contracts a wallet meets. Its automation contracts are
      // clones made per owner, so they have no address here.
      id: 'domino-contracts',
      title: 'Domino V1 on Robinhood Chain',
      blocks: [
        p('Domino V1’s contracts stay on Robinhood Chain. Its automation ends when the new automation starts, and nothing moves from V1 to it by itself: there is no migration. Withdraw what V1 holds for you, then set up the new automation. See ', doc('Older automation', 'your-automation', 'domino-v1'), '.'),
        {
          kind: 'addresses',
          rows: [
            { label: 'DominoSetupV1', role: 'Deposit approvals, then fund, assisted swap, mint and refund', address: '0x676f449fcfcd0f5ce4c7a1db2d98c7d6565dd37a', chains: ROBINHOOD },
            { label: 'DominoVaultFactoryV1', role: 'Made each Domino V1 automation', address: '0x16bf6eaba7b31118627b277e97249720dfe1c7ff', chains: ROBINHOOD },
          ],
        },
        p('A deposit made with V1 that never became a position can still be refunded through Setup, from Positions.'),
      ],
    },
    {
      id: 'uniswap-contracts',
      title: 'Uniswap contracts on Robinhood Chain',
      blocks: [
        p('Domino positions live in Uniswap’s own deployments. On Robinhood Chain:'),
        {
          kind: 'addresses',
          rows: [
            { label: 'PoolManager', role: 'Every pool’s state and swaps', address: '0x8366a39cc670b4001a1121b8f6a443a643e40951', chains: ROBINHOOD },
            { label: 'PositionManager', role: 'Position NFTs', address: '0x58daec3116aae6d93017baaea7749052e8a04fa7', chains: ROBINHOOD },
            { label: 'StateView', role: 'Pool prices and ticks', address: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b', chains: ROBINHOOD },
            // 2026-10-01 (audit E17, E20): finance/pin.ts ROUTE_PERMIT2, UNIVERSAL_ROUTER.
            { label: 'Permit2', role: 'Allowance for a swap through Uniswap, only when Review shows one', address: '0x000000000022d473030f116ddee9f6b43ac78ba3', chains: ROBINHOOD },
            { label: 'Universal Router', role: 'A swap through Uniswap, only when Review shows one', address: '0x204faca1764b154221e35c0d20abb3c525710498', chains: ROBINHOOD },
          ],
        },
      ],
    },
    {
      // 2026-10-04 (the owner: docs revalidated for V2): api-contracts/v2/chains/*.json, which tests/docs.test.mjs holds these to.
      id: 'position-nfts',
      title: 'Position NFTs on each network',
      blocks: [
        p('The Uniswap contract each position NFT belongs to, which your wallet names when you approve one:'),
        {
          kind: 'addresses',
          rows: [
            { label: 'NonfungiblePositionManager', role: 'Robinhood Chain, Uniswap v3', address: '0x73991a25c818bf1f1128deaab1492d45638de0d3', chains: ROBINHOOD },
            { label: 'PositionManager', role: 'Base, Uniswap v4', address: '0x7c5f5a4bbd8fd63184577525326123b519429bdc', chains: [8453] },
            { label: 'NonfungiblePositionManager', role: 'Base, Uniswap v3', address: '0x03a520b32c04bf3beef7beb72e919cf822ed34f1', chains: [8453] },
            { label: 'PositionManager', role: 'Arbitrum One, Uniswap v4', address: '0xd88f38f930b7952f2db2432cb002e7abbf3dd869', chains: [42161] },
            { label: 'NonfungiblePositionManager', role: 'Arbitrum One, Uniswap v3', address: '0xc36442b4a4522e871399cd717abdd847ab11fe88', chains: [42161] },
            ...(ELYSIUM_LIVE && ELYSIUM_POSITION_MANAGER ? [{ label: 'PositionManager', role: 'Elysium, Uniswap v4', address: ELYSIUM_POSITION_MANAGER, ...(ELYSIUM_LINKED ? { chains: [ELYSIUM_V2_ID as DocChain] } : {}) }] : []),
          ],
        },
        p(!ELYSIUM_LIVE ? 'Permit2 has the same address on all three networks.' : ELYSIUM_PERMIT2 === PERMIT2 ? 'Permit2 has the same address on all four networks.' : 'Permit2 has the same address on Robinhood Chain, Base and Arbitrum One.'),
      ],
    },
    {
      id: 'network',
      title: 'Networks',
      blocks: [
        {
          kind: 'facts',
          rows: [
            { label: 'Robinhood Chain', value: `Chain ID ${CAPABILITIES.chainId}` },
            { label: 'Base', value: 'Chain ID 8453' },
            { label: 'Arbitrum One', value: 'Chain ID 42161' },
            ...(ELYSIUM_LIVE ? [{ label: 'Elysium', value: `Chain ID ${ELYSIUM_V2_ID}` }, { label: 'Gas token', value: 'ETH, and HYPE on Elysium' }] : [{ label: 'Gas token', value: 'ETH, on each' }]),
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
      // 2026-09-27 (the owner: Domino is for people who know nothing about liquidity pools): the words a first-time reader meets first.
      id: 'the-basics',
      title: 'The basics',
      blocks: [
        {
          kind: 'terms',
          items: [
            { id: 'liquidity', term: 'Liquidity', text: ['Tokens supplied to a pool so others can trade.'] },
            { id: 'liquidity-provider', term: 'Liquidity provider', text: ['Someone who supplies a pool’s two tokens and earns a share of its fees.'] },
            { id: 'position', term: 'Position', text: ['Your tokens in one pool, between the lowest and highest price you chose.'] },
            { id: 'apr', term: 'APR', text: ['A yearly rate: a period’s fees scaled to a year. It describes the past, not a promise.'] },
            { id: 'slippage', term: 'Slippage tolerance', text: ['How far the price may move against you before a step stops instead of going through.'] },
            { id: 'gas', term: 'Gas', text: [`The network fee every transaction pays, ${GAS_IN}.`] },
            { id: 'smart-contract', term: 'Smart contract', text: ['A program on the chain that anyone can read.'] },
          ],
        },
      ],
    },
    {
      id: 'pools-and-positions',
      title: 'Pools and positions',
      blocks: [
        {
          kind: 'terms',
          items: [
            { id: 'network', term: 'Network', text: [`A blockchain Domino works on: ${NETWORKS_OR}.`] },
            { id: 'pool', term: 'Pool', text: ['Where two tokens are traded for each other.'] },
            { id: 'pool-id', term: 'Pool id', text: ['A pool’s identifier. Domino names pools by id, never by symbol.'] },
            { id: 'fee-tier', term: 'Fee tier', text: ['The share of every swap a pool charges, paid to its liquidity providers.'] },
            { id: 'hook', term: 'Hook', text: ['A contract a Uniswap v4 pool can attach to change its fee or add rules. Domino uses pools without one.'] },
            { id: 'protocol-fee', term: 'Protocol fee', text: ['Uniswap’s fee on a pool’s swaps, taken from what a swap sells into the pool before the fee tier. It does not go to liquidity providers.'] },
            { id: 'range', term: 'Range', text: ['The lowest and highest price a position provides liquidity between.'] },
            { id: 'tick', term: 'Tick', text: ['Uniswap’s price step, 0.01%. Ranges end on multiples of a pool’s tick spacing.'] },
            { id: 'in-range', term: 'In range', text: ['The pool price is inside a position’s range. Only then does it earn fees.'] },
            { id: 'out-of-range', term: 'Out of range', text: ['The pool price is outside a position’s range. It holds one token only and earns no fees.'] },
            { id: 'position-nft', term: 'Position NFT', text: ['The standard Uniswap token that stands for a position. Positions lists the ones your wallet created with Domino.'] },
            { id: 'principal', term: 'Principal', text: ['What a position holds, not counting its fees: its Position value.'] },
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
            // 2026-09-27: the product's words (Fees ready to collect), and the owner's point 4, Your APR.
            { id: 'fees-ready-to-collect', term: 'Fees ready to collect', text: ['Earned fees not yet collected. Collect fees sends them to your wallet.'] },
            { id: 'your-apr', term: 'Your APR', text: ['A position’s own fees as a yearly rate. Not the pool’s APR, and not a promise.'] },
            { id: 'service-fee', term: 'Service fee', text: ['Domino’s fee on automation: Auto-compound 2%, Domino-compound 4% of the earned fees it uses, each time.'] },
            { id: 'assisted-swap-fee', term: 'Assisted swap fee', text: ['0.65% of the amount swapped, when an action needs a swap.'] },
            { id: 'domino-history', term: 'Domino history', text: ['Domino’s own record of a pool’s last 24 hours, where the deployment provides it. Figures from it are marked Domino history.'] },
            { id: 'tvl', term: 'TVL', text: ['Total value locked: what the tokens in a pool are worth, from Domino history or, where it has none, a market data provider.'] },
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
            { id: 'plain-position', term: 'Plain position', text: ['No automation: earned fees wait in the position until you collect them.'] },
            { id: 'auto-compound', term: 'Auto-compound', text: ['Automation that adds a position’s earned fees back into the same position.'] },
            { id: 'domino-compound', term: 'Domino-compound', text: ['Near the top of a range, earned fees open or fund the next position one step higher.'] },
            // 2026-10-04 (the owner: the reader meets "your automation", never the contract's name).
            { id: 'your-automation', term: 'Your automation', text: ['The contract made for your wallet that runs one position’s automation or Auto-exit.'] },
            { id: 'auto-exit', term: 'Auto-exit', text: ['Domino closing a position by itself when the price reaches the end of its range, the tokens sent to your wallet.'] },
            { id: 'reference-price', term: 'Reference price', text: ['The recent price automation and Auto-exit check, not the last trade.'] },
            { id: 'operator', term: 'Operator', text: ['Domino’s automation service. It acts within your limits, can pause, and pays only you.'] },
            { id: 'trigger-distance', term: 'Trigger distance', text: ['How near its range’s top the price must be for a next position. Up to 20%.'] },
            { id: 'maximum-overlap', term: 'Maximum overlap', text: ['How far below the previous top a next position may start. Up to 20%.'] },
            // 2026-10-01 (audit E21): the setup's field name.
            { id: 'upside', term: 'Next range higher by', text: ['How far above the previous top a next position’s top sits, at least. 50% at first.'] },
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
            { id: 'sign-in', term: 'Sign-in', text: ['A signature that proves you control an address. It authorizes no transaction and no automation.'] },
            { id: 'session', term: 'Session', text: ['What signing in starts. It ends after 30 minutes idle, at its end time, or when you sign out.'] },
            { id: 'receipt', term: 'Receipt', text: ['A record of what you or your automation did.'] },
            { id: 'bridge', term: 'Bridge', text: ['A service that moves tokens from one network to another. Domino uses Relay or Across.'] },
          ],
        },
      ],
    },
  ],
}
