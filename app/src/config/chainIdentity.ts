/**
 * The chains' identities in the registry (2026-10-01, the chain2 workstream, part B, audit item G3): the one place each
 * chain's id, name and public addresses are written. Literals only, and no import, so that what every page carries can
 * read them without bringing a chain's whole record along. Changed on purpose 2026-11-07 (Elysium as a fourth V2 chain):
 * one import, Elysium's literals (lib/elysiumIdentity.ts, which imports nothing: its id's one literal and its build-time
 * switch), so V2's chain list follows the switch.
 *
 * Why: Robinhood Chain's id was declared in six places (session/machine.ts, read/screens/identity.ts, read/project.ts,
 * functions/_lib/owned.ts, wallet/chain.ts, lib/capabilities.ts) and its addresses copied into more, so a change made in
 * one copy and not in another would split the read path, and a second chain meant hand edits everywhere. Each of those
 * now reads its value from here. A chain's whole record (its RPCs with this page's budgets, its pace, its rules and
 * deployment) is built from these in config/chains.ts (Robinhood's network data is config/chainRobinhood.ts, Elysium's
 * record config/chainElysium.ts), which only the code that reads that chain loads.
 *
 * What is not here on purpose: the owner's money code keeps its own pins (finance/pin.ts and the other finance/*
 * modules, the deposit consumer, Create position's journey): they are compared with these by tests, never rewired
 * (the audit's G3: "não mexer nos pins de finance/*, só um teste de igualdade"). The docs' reference page names the
 * addresses in prose, checked against rugged97's deployment record by tests/docs.test.mjs.
 *
 * tests/chain-registry.test.mjs holds every value equal to rugged97's chain profiles and deployment records
 * (chains/robinhood-4663.json, chains/deployments/robinhood-v4.json, chains/elysium-99801.json, copies in
 * tests/fixtures/elysium/) and to the records built from them.
 */

import { ELYSIUM_LIVE, ELYSIUM_V2_ID } from '../lib/elysiumIdentity'

/** Multicall3 at its canonical address, the same on every chain it is deployed on (both of the registry's). */
export const MULTICALL3_CANONICAL = '0xca11bde05977b3631167028862be2a173976ca11'

// ---------------------------------------------------------------------------------------------------------------------
// Robinhood Chain (4663): Uniswap v4 and Domino V1, live.
// ---------------------------------------------------------------------------------------------------------------------

export const ROBINHOOD_KEY = 'robinhood'
export const ROBINHOOD_ID = 4663
export const ROBINHOOD_NAME = 'Robinhood Chain'
export const ROBINHOOD_NATIVE = { name: 'Ether', symbol: 'ETH', decimals: 18 } as const
/** The chain's explorer (rugged97's chains/robinhood-4663.json explorerUrl), with no trailing slash. */
export const ROBINHOOD_EXPLORER = 'https://robinhoodchain.blockscout.com'

/**
 * The chain's official RPC: the wallet's own RPC, offered only in the wallet's "add network" (wallet/chain.ts
 * ADD_ROBINHOOD_CHAIN) and the docs' network details; this site never reads it. Changed on purpose 2026-10-01 (RPC-SPEC,
 * the owner's rule: nothing is read from a public RPC): every chain read goes to rugged97's read gateway (/api/read/*) or,
 * through the site's own fixed routes, to Domino's own node (functions/_lib/localRpc.ts); the three public fallbacks
 * the page read from since 2026-09-28 are gone. Pending rugged's answer on a public endpoint of his node (PLANO §5.6).
 */
export const ROBINHOOD_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com'

/** Native ETH: the zero address, as a Uniswap v4 pool key names it. */
export const ROBINHOOD_NATIVE_ADDRESS = '0x0000000000000000000000000000000000000000'
/** Wrapped ether on Robinhood Chain. */
export const ROBINHOOD_WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
/** USDG, the dollar every selected pool trades against; $1 by definition across the app (DESIGN-V2 §22.8). */
export const ROBINHOOD_USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'

/** Uniswap v4 PositionManager (the same pin as finance/pin.ts). */
export const ROBINHOOD_POSITION_MANAGER = '0x58daec3116aae6d93017baaea7749052e8a04fa7'
/** Uniswap v4 PoolManager: every Initialize, ModifyLiquidity, Swap, Donate and ProtocolFeeUpdated. */
export const ROBINHOOD_POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
/** Uniswap v4 StateView: slot0, fee growth inside a range, a position's last fee growth. */
export const ROBINHOOD_STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'
/** DominoSetupV1 (the same pin as finance/pin.ts SETUP_CONTRACT). */
export const ROBINHOOD_SETUP = '0x676f449fcfcd0f5ce4c7a1db2d98c7d6565dd37a'

// ---------------------------------------------------------------------------------------------------------------------
// Elysium Testnet (99801): rugged97's Uniswap v3 profile, unqualified (its whole record: config/chainElysium.ts).
// ---------------------------------------------------------------------------------------------------------------------

export const ELYSIUM_KEY = 'elysium'
export const ELYSIUM_ID = 99801
export const ELYSIUM_NAME = 'Elysium Testnet'
/**
 * Its deployment's status in rugged97's registry (chains/deployments/elysium-v3-unqualified.json): unqualified, so the
 * section stays off on domino.money (chains/elysium/mode.ts). Qualifying it is a reviewed change of this line and of
 * the record's contracts.
 */
export const ELYSIUM_STATUS: 'qualified' | 'unqualified' = 'unqualified'

// ---------------------------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------------------------
// Domino V2's other chains (spec F7 §1.2): Base and Arbitrum One. Identity only: their full profiles are
// api-contracts/v2/chains (src/v2/chains.ts, which a test holds equal to these), and the site reads neither chain itself
// (no public RPC, the owner's rule): only the wallet's own provider and the V2 read API do. Not in REGISTRY_CHAIN_IDS:
// V2 is off in every deployable build (src/v2/flag.ts), and V1 reads and keeps sessions exactly as before.
// ---------------------------------------------------------------------------------------------------------------------

export const BASE_ID = 8453
export const BASE_NAME = 'Base'
export const ARBITRUM_ID = 42161
export const ARBITRUM_NAME = 'Arbitrum One'

/**
 * Every chain Domino V2 may serve, as a type: Robinhood Chain, Base, Arbitrum One and Elysium (src/v2/types.ts V2ChainId).
 * Changed on purpose 2026-11-07 (Elysium as a fourth V2 chain): Elysium's mainnet id is always in the type, so every
 * table typed per chain (`Record<V2ChainId, ...>`) says what it holds for it; which chains a build serves is the list
 * below. A table's Elysium row is written behind ELYSIUM_LIVE, so a build where Elysium is off carries none.
 */
export type V2ChainIdOf = typeof ROBINHOOD_ID | typeof BASE_ID | typeof ARBITRUM_ID | typeof ELYSIUM_V2_ID

/**
 * The chains Domino V2 serves, in the picker's order (spec §1.2; open point 23 leaves the launch order to the owner).
 * Changed on purpose 2026-11-06 (Elysium readiness): the app's one list of them. src/v2/chains.ts serves these and no
 * other (a profile of a chain id not here is ignored). Changed on purpose 2026-11-07 (Elysium as a fourth V2 chain,
 * switched on by itself): Elysium, last, exactly when the build's switch says it is live (lib/elysiumIdentity.ts
 * ELYSIUM_LIVE: rugged97's enabled profile and deployment record, our pin of the record, read-v6 and position-plan naming
 * it; scripts/elysium-switch.mjs); the three otherwise, as before. The list follows the switch, never the reverse, so
 * isV2ChainId, the chain list, the wallet's switching (wallet/port.ts) and the session's networks (session/machine.ts)
 * take Elysium on with no edit here.
 */
const V2_CHAIN_ID_LIST: readonly V2ChainIdOf[] = Object.freeze(ELYSIUM_LIVE ? [ROBINHOOD_ID, BASE_ID, ARBITRUM_ID, ELYSIUM_V2_ID] : [ROBINHOOD_ID, BASE_ID, ARBITRUM_ID])
export const V2_CHAIN_IDS: readonly number[] = V2_CHAIN_ID_LIST

/**
 * The V2 chains beside Robinhood Chain, as a type and as the list (added 2026-11-07, Elysium's screens): Base, Arbitrum
 * One, and Elysium where the build serves it, in the picker's order. Robinhood Chain is the chain whose pools, Top pools
 * and search Domino's own read service lists; these are the networks every screen reads through read-v6's chain reads
 * (a network token page, a network pool page, New position's network rows, the Wallet card's other networks). Every such
 * list takes this one, so a further chain is one row of V2_CHAIN_ID_LIST.
 */
export type OtherV2ChainIdOf = Exclude<V2ChainIdOf, typeof ROBINHOOD_ID>
export const OTHER_V2_CHAIN_IDS: readonly OtherV2ChainIdOf[] = Object.freeze(V2_CHAIN_ID_LIST.filter((chainId): chainId is OtherV2ChainIdOf => chainId !== ROBINHOOD_ID))
/** Whether `value` is one of OTHER_V2_CHAIN_IDS (a number, never its text). */
export const isOtherV2ChainId = (value: unknown): value is OtherV2ChainIdOf => (OTHER_V2_CHAIN_IDS as readonly unknown[]).includes(value)

// ---------------------------------------------------------------------------------------------------------------------

/**
 * Every chain of the registry, by id (config/chains.ts CHAINS, the same order): the networks this app reads. The wallet
 * session keeps a signed-in account's session while its wallet moves between them (session/machine.ts, part B, audit
 * item G11), and ends it, as before, when the wallet leaves them.
 */
export const REGISTRY_CHAIN_IDS: readonly number[] = Object.freeze([ROBINHOOD_ID, ELYSIUM_ID])
