/**
 * Elysium's words every page may need before V2 loads (added 2026-11-06, Elysium readiness): its name, its chain id, where
 * its official mark is served from, whether it is live and whether funds can come from it. Home draws the "Bring funds
 * from" row from them, the network tables (lib/networkName.ts, lib/chainMarks.ts) and the docs take their Elysium rows
 * from them, and src/v2/elysium.ts builds Elysium's whole record on them. A V1 file never imports a V2 module statically
 * (tests/session.source-guard.test.mjs), so they live here.
 *
 * Its mainnet is chain 99901 (rugged97's #459; the id was not known before 6 Nov 2026) with Uniswap v4 alone, so its
 * profile names `uniswap.v3` null and its Domino deployment has nine contracts (src/v2/elysium.ts `dexes`).
 * ELYSIUM_V2_ID below is that id's one literal in the app's source: lib/ and V2 files alike take it from here (this file
 * imports nothing, so a V1 file may), config/chainIdentity.ts's V2 chain list included. scripts/elysium-switch.mjs, plain
 * node, holds the build's own copy.
 *
 * Changed on purpose 2026-11-06 (the Elysium surface): the switch. ELYSIUM_LIVE is one build-time fact; vite.config.ts and
 * scripts/elysium-switch.mjs compute it, a test build may force it with a fixture profile, the release build never.
 * Changed on purpose 2026-11-07 (Elysium as a fourth V2 chain, switched on by itself): it is true only once every day-9
 * piece is in the repository: rugged97's enabled profile of chain 99901 (api-contracts/v2/chains) and its deployment
 * record (docs/deployments/v2-<slug>-99901-<date>), our reviewed pin of that record (scripts/elysium-switch.mjs
 * ELYSIUM_RECORD_PIN), and the read-v6 and position-plan packages naming 99901. The app's V2 chain list FOLLOWS it
 * (config/chainIdentity.ts V2_CHAIN_IDS names 99901 exactly when it is true), and with that list every chain table,
 * service, screen, the wallet's and the session's networks. Today it is false: no V2 chain is Elysium, no table holds
 * its name or its mark (lib/networkName.ts, lib/chainMarks.ts), and funds cannot come from it. What is still written by
 * hand on the day is docs/ELYSIUM_DAY9.md's Monday checklist.
 * Changed on purpose 2026-11-07 (Elysium's pre-launch, the owner's order: Elysium on the site before its network opens):
 * until it is live, the build is in pre-launch (ELYSIUM_PRELAUNCH below, scripts/elysium-switch.mjs ELYSIUM_OPENS_ON),
 * and two screens name Elysium, nothing else: Home's "Open positions on" row, with Elysium's mark and when it opens,
 * leading to the docs (screens/Landing.tsx), and the last section of the docs' What Domino is
 * (lib/docs/pages/introduction.ts). Neither reads chain 99901 nor offers a choice; live, both give way by themselves.
 *
 * Literals and the build's defines only: no import.
 */

/**
 * `__DOMINO_ELYSIUM_LIVE__`, `__DOMINO_ELYSIUM_FUNDS_FROM__`, `__DOMINO_ELYSIUM_PRELAUNCH__` and
 * `__DOMINO_ELYSIUM_OPENING__` are Vite defines written for every mode (vite.config.ts). Declared here, module-scoped, as
 * src/v2/flag.ts declares V2's, so a compile outside Vite (.test-build), and the Pages Functions, which have no define,
 * answer "off" unless a test says otherwise (globalThis.__DOMINO_ELYSIUM_LIVE__ before a fresh module load).
 */
declare const __DOMINO_ELYSIUM_LIVE__: boolean | undefined
declare const __DOMINO_ELYSIUM_FUNDS_FROM__: boolean | undefined
declare const __DOMINO_ELYSIUM_FUNDS_TO__: boolean | undefined
declare const __DOMINO_ELYSIUM_DESTINATIONS__: readonly string[] | null | undefined
declare const __DOMINO_ELYSIUM_PRELAUNCH__: boolean | undefined
declare const __DOMINO_ELYSIUM_OPENING__: ElysiumOpening | null | undefined

/**
 * Elysium mainnet's chain id (rugged97's #459; scripts/v2/deploy.mjs ENABLED_CHAINS). Not config/chainIdentity.ts
 * ELYSIUM_ID, which is the old V1 section's testnet, 99801.
 */
export const ELYSIUM_V2_ID = 99901

/** Whether Elysium is live in this build: every day-9 piece is in the repository (scripts/elysium-switch.mjs), so V2 serves chain 99901. */
export const ELYSIUM_LIVE: boolean = typeof __DOMINO_ELYSIUM_LIVE__ === 'boolean' && __DOMINO_ELYSIUM_LIVE__

/** The opening day (month from 1) and its two English forms, from scripts/elysium-switch.mjs (added 2026-11-07). */
export interface ElysiumOpening { readonly at: readonly [number, number, number]; readonly short: string; readonly long: string }
/**
 * Pre-launch (added 2026-11-07): not live, and a day is written (scripts/elysium-switch.mjs ELYSIUM_OPENS_ON). Live
 * always wins. A boolean literal in every build, so each pre-launch branch folds out where it is false.
 */
export const ELYSIUM_PRELAUNCH: boolean = !ELYSIUM_LIVE && typeof __DOMINO_ELYSIUM_PRELAUNCH__ === 'boolean' && __DOMINO_ELYSIUM_PRELAUNCH__
/** The opening day and its words, in pre-launch only; null elsewhere. Whether it has passed is the visitor's own date (lib/elysiumOpening.ts). */
export const ELYSIUM_OPENING: ElysiumOpening | null = ELYSIUM_PRELAUNCH && typeof __DOMINO_ELYSIUM_OPENING__ === 'object' ? __DOMINO_ELYSIUM_OPENING__ : null

/** The app's one name for it (lib/networkName.ts), on every screen. */
export const ELYSIUM_NAME = 'Elysium'
/**
 * Where Elysium's official mark is served from (public/chains). Changed on purpose 2026-11-07: the owner supplied
 * Kinetiq's mark as a PNG (128 x 128, white inside the circle, transparent outside), so it is public/chains/elysium.png,
 * in the repository. Nothing draws it while Elysium is off; a live build without it, or with anything but a square PNG
 * there, fails (scripts/elysium-switch.mjs).
 */
export const ELYSIUM_MARK = '/chains/elysium.png'
/**
 * Elysium's block explorer, for a person's own click (v2/explorers.ts, components/docs/DocsContent.tsx,
 * components/pool/ExplorerAddress.tsx): its host with no trailing slash, or null while it has none known, and then no
 * link to it is drawn anywhere (added 2026-11-07). A day-9 line once its explorer is published (docs/ELYSIUM_DAY9.md).
 * Changed on purpose 2026-11-09 (Elysium's day 9, checklist step 5): Kinetiq's explorer, published at
 * elysium.kinetiq.xyz/explorer (rugged97's note of 9 Nov); its pages are `/tx/<hash>` and `/address/<address>` at the
 * host's root, lower case taken, as the other explorers'.
 */
export const ELYSIUM_EXPLORER: string | null = 'https://elysium.kinetiq.xyz'
/** What a link to it is called, as "Robinhood explorer" is Robinhood Chain's. */
export const ELYSIUM_EXPLORER_NAME = 'Elysium explorer'
/**
 * Whether funds can come from it (Home's "Bring funds from" row and its funding scene, the docs' Bring funds page):
 * Elysium is live, and the crosschain-v1 contract the app reads the origins listing with pins Relay or Across for chain
 * 99901, so the listing can name it as an origin (scripts/elysium-switch.mjs). False on 6 Nov 2026: neither bridge
 * serves 99901, and its profile names no bridge, so Bring funds starts off there in both directions.
 */
export const ELYSIUM_FUNDS_FROM: boolean = ELYSIUM_LIVE && typeof __DOMINO_ELYSIUM_FUNDS_FROM__ === 'boolean' && __DOMINO_ELYSIUM_FUNDS_FROM__
/**
 * Whether funds can be brought to it from another network (added 2026-11-09, Elysium's day 9, the owner: funds brought
 * to Elysium from other networks as on Base): Elysium is live, its profile names a bridge, and crosschain-v1 pins Relay or
 * Across for chain 99901 and lists what a deposit may deliver there (scripts/elysium-switch.mjs `fundsTo`). False on
 * 9 Nov 2026: Relay serves 99901 (its USDC), but the profile names no bridge yet and crosschain-v1 has no 99901, so it
 * turns on by itself the day rugged97's packages carry it, with no change here.
 */
export const ELYSIUM_FUNDS_TO: boolean = ELYSIUM_LIVE && typeof __DOMINO_ELYSIUM_FUNDS_TO__ === 'boolean' && __DOMINO_ELYSIUM_FUNDS_TO__
/**
 * What a deposit may deliver on Elysium, where ELYSIUM_FUNDS_TO (crosschain-v1's destinations["99901"], lowercase: its
 * USDC, as Relay bridges it, never its native HYPE unless the package lists it); empty elsewhere (added 2026-11-09).
 */
export const ELYSIUM_DESTINATION_TOKENS: readonly string[] = ELYSIUM_FUNDS_TO && typeof __DOMINO_ELYSIUM_DESTINATIONS__ === 'object' && Array.isArray(__DOMINO_ELYSIUM_DESTINATIONS__)
  ? Object.freeze(__DOMINO_ELYSIUM_DESTINATIONS__.map((token) => String(token).toLowerCase()))
  : Object.freeze([])
/**
 * Whether New position can offer, below a position's amounts, to bring funds from another network to `chainId` (added
 * 2026-11-07, review finding P1): every network but Elysium where the build serves it, since no bridge brings funds there
 * (src/v2/types.ts S2_DESTINATION_CHAIN_IDS, which the V1 screens New position shares never import; the two are held
 * equal on every V2 chain in tests/v2/elysium-screens.test.mjs). Where none is offered, a short amount says Robinhood
 * Chain's own words: lower it, or add tokens to the wallet.
 * Changed on purpose 2026-11-09 (Elysium's day 9, the owner: funds brought to Elysium from other networks as on Base):
 * Elysium too, once funds can be brought to it (ELYSIUM_FUNDS_TO).
 */
export const fundsBroughtTo = (chainId: number | null | undefined): boolean => !(ELYSIUM_LIVE && !ELYSIUM_FUNDS_TO && chainId === ELYSIUM_V2_ID)
