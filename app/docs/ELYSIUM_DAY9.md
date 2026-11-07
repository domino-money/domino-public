# Elysium on day 9: the app's change

## Monday checklist

Line numbers of 7 Nov 2026 (branch `ely/money`); search for the quoted code if they moved. Each step is one reviewed line
or one check; nothing else is edited by hand on the day.

1. After rugged97's pull request is merged, read what the switch still waits for: `node --test tests/elysium-switch.test.mjs`
   (the skipped test "day 9 in the repository" names each missing piece), or the line a build prints
   (`Elysium stays off until: ...`).
2. Review rugged97's deployment record (`docs/deployments/v2-elysium-99901-<date>/deployment.json`: nine contracts,
   `contractNames` the 13, `public-chain-preparation`, verified at `finalized`), then pin it:
   `scripts/elysium-switch.mjs:73` `ELYSIUM_RECORD_PIN = Object.freeze({ path, sha256 })` (`sha256sum` of the committed file).
3. If his read-v6 or position-plan package moved its `CONTRACT_VERSION`, the app's versions follow it:
   `src/v2/read/v6.ts:28` `READ_V6_CONTRACT_VERSION` (`:30` the next version) and `src/v2/plan/types.ts:17`
   `S1_PLAN_CONTRACT_VERSION`; he updates `src/v2/pins.ts:15` and `:56` himself (`tests/v2/read-v6.test.mjs` holds all four).
   Whether read-v6 moved its version decides the publishing order (step 9).
4. Check Elysium's finality against the profile's `finality` text: `src/v2/elysium.ts:30` `finalityMinutes: 12`.
5. Once Elysium's explorer is published: `src/lib/elysiumIdentity.ts:59` `ELYSIUM_EXPLORER` (its host, no trailing slash);
   every explorer table takes it (`src/v2/explorers.ts:21`, `src/components/docs/DocsContent.tsx:33`,
   `src/components/pool/ExplorerAddress.tsx:19`). Until then no link is drawn, and the docs' "or Elysium's explorer"
   (`src/lib/docs/pages/custody.ts:97`, emptying automation if Domino is down) names none.
6. Once DEX Screener lists Elysium: its slug in `src/lib/tokenArtwork.ts:68` `DEX_CHAIN_SLUGS` and `:134` `EDGE_PATH`, and
   `functions/_lib/dexEdge.ts:80` `DEX_CHAINS`. Until then Elysium's tokens take the plain mark.
7. Once the real profile names Elysium's rank-1 stable: if it is Circle's own USDC there (not a bridged or other dollar
   token), add its address, lowercase, to `src/lib/bundledTokenArtwork.ts:10` `USDC` (`99901: '0x...'`), so it draws
   Circle's logo as Base's does; any other dollar token keeps the plain mark.
8. Run on fresh builds: `npm run typecheck`, `npm run lint`, `npm run build:unit`, `node --test tests/v2/*.test.mjs`,
   `node --test tests/elysium-switch.test.mjs tests/docs.test.mjs`, then `npm run build`, `npm run build:wallet-test`,
   `npm run build:wallet-test-v2` and `node --test tests/session.bundle.test.mjs`. "day 9 in the repository"
   (`tests/elysium-switch.test.mjs`) and "Elysium's pinned record" (`tests/v2/manifest-pin.test.mjs`: the real record
   admitted for production on 99901) must pass, not skip. Publish only after they pass: a profile the app's chain
   parser refuses (`src/v2/chains.ts` `chainOf`: its v4 addresses, the PositionManager's and StateView's codehashes,
   `wrappedNative`, a rank-1 stable) still builds green, then throws at load in every V2 chunk, on all four networks.
   Live, the bundle test gives domino v2 8,500 B and the pool history chart 500 B more
   (`tests/session.bundle.test.mjs:351`); if the real record is over that, measure and raise by that file's rule (7 Nov,
   after the review: the forced build's domino v2 is 2,132 B over today's test build, rehearsed packages included, beside
   the record's own 6,221 B: about 710 B under the allowance from today's release build of 683,935 B). Then
   `npm run test:v2in` (Elysium's money screens: its two Elysium suites).
9. The publishing order, which only rugged97 can settle (ask in the one batched message): read-v6 takes a portfolio or
   activity answer only when its chains are exactly the package's (`tests/v2/read-v6.test.mjs` "read-v6 takes a portfolio
   or activity answer only when..."), and the app, the read Worker (`bridge/src/worker.mjs:106`) and his read gateway each
   check it. **If his day-9 read-v6 is a new `CONTRACT_VERSION` served beside 1.1.0-rc.1**: his gateway and the read
   Worker serve both first, then the app (the position-fees window's way). **If it is the same version with four
   chains**: there is no safe order (an app ahead of the Worker, or behind it, refuses every portfolio and activity answer,
   so V2 positions, Receipts and the Wallet card go blank on Robinhood Chain, Base and Arbitrum One too); the gateway, the
   read Worker (with the owner's OK) and the app go out back to back in one window the owner picks, and until then no app
   or read Worker build from a `main` that carries his four-chain package is published.
10. Check rugged97's two packages against the rehearsal the forced test builds use (`scripts/elysium-rehearsal.mjs:61`
    `rehearseReadV6`, `:69` `rehearsePlan`): read-v6 `CONSTANTS.priceProfiles[99901]` (its `nativePool` keys) and
    position-plan-v1 `CONSTANTS.chains[99901]` (its `l1DataFeeSource`). Once his packages name 99901 the rehearsal changes
    nothing (each row is written only where his is missing); if his shape differs, `npm run test:v2in` says where.
11. Read with the owner (Monday, in the live preview): Home's "Open positions on" row
    (`src/components/home/HomeCapabilities.tsx:30` `POSITION_ROW`), the Wallet card's "Elysium's dollar token"
    (`src/lib/docs/pages/using.ts:307`: its symbol once the real profile names it), Privacy's "network provider outside
    Domino" for Elysium's balances (`src/lib/docs/pages/custody.ts:212`: rugged97 to confirm who reads them), and what
    Elysium lacks until steps 5 and 6: no explorer link, plain token marks, and on Markets, the pool page and New
    position's pool rows no TVL, 24h volume or APR (dashes) and no liquidity line on search hits, so the docs' "Tokens
    that share a name show their liquidity" (`src/lib/docs/pages/using.ts:55`) holds there only from step 6.

Funds from Elysium need no edit: `src/finance/v2/holdings.ts` `CANDIDATE_ORIGINS` and `src/v2in/funds/model.ts`
`BALANCE_ORIGINS` name it by themselves the day crosschain-v1 pins Relay or Across for 99901 (`ELYSIUM_FUNDS_FROM`). Funds
brought **to** Elysium stay off until its profile names a bridge (`src/v2/types.ts:35` `S2_DESTINATION_CHAIN_IDS` and the
deposit's two records, below).

Optional, not code: the hover ring in Elysium's colour (`src/styles/tokens.css:256`, `src/styles/v3-foundation.css:44`;
the owner's colour), and the mark's caching at the edge (`functions/_middleware.ts:419` `ICON_PATH`, the edge owner's).

## The chain

Elysium (Kinetiq) is an Arbitrum Orbit (Nitro) chain that settles to HyperEVM and pays its network fees in HYPE. Its
mainnet's chain id is **99901** (rugged97's #459, 6 Nov 2026: the id Conduit deployed, already in
`scripts/v2/deploy.mjs` `ENABLED_CHAINS`). It has **Uniswap v4 only** (Ascend's PoolManager, PositionManager,
StateView, V4Quoter, Universal Router and Permit2; no v3), so its profile names `uniswap.v3` null and its Domino
deployment registers **nine** contracts, not 13. HYPE is priced from a pool (no Chainlink), and its profile names no
bridge, so Bring funds (S2) stays off there. Its enabled profile, deployment record and service versions arrive in
rugged97's day-9 pull request; public launch is 9 Nov 2026. Until then `api-contracts/v2/chains/elysium.json` is a
disabled placeholder and the app serves Robinhood Chain, Base and Arbitrum One only.

The app names the id once: `ELYSIUM_V2_ID` in `src/lib/elysiumIdentity.ts`, a file that imports nothing, so lib/ (V1)
files and V2 files alike take it from there (`scripts/elysium-switch.mjs`, plain node, holds the build's own copy). Not
`config/chainIdentity.ts` `ELYSIUM_ID`, which is the old V1 section's testnet, 99801.

## The switch: Elysium turns on by itself

Changed on purpose 2026-11-07 (branch `ely/money`). One build-time fact, **Elysium is live**
(`scripts/elysium-switch.mjs` `elysiumSwitch`, written into every build as `__DOMINO_ELYSIUM_LIVE__` and read as
`src/lib/elysiumIdentity.ts` `ELYSIUM_LIVE`), is true exactly when every day-9 piece is in the repository:

| Piece | What the switch reads | Whose |
| --- | --- | --- |
| `profile` | an **enabled** profile of chain 99901 in `api-contracts/v2/chains/` (by directory, never a file by name) | rugged97 |
| `record` | `docs/deployments/v2-<slug>-99901-<date>/deployment.json` (by directory; rehearsals never count) | rugged97 |
| `pin` | that record's SHA-256 equal to `ELYSIUM_RECORD_PIN` (`scripts/elysium-switch.mjs:73`), written by a person | ours |
| `readV6` | `api-contracts/read-v6` `CONSTANTS.chainIds` names 99901 | rugged97 |
| `plan` | `api-contracts/position-plan-v1` `CONSTANTS.chains` has a 99901 row | rugged97 |

Any piece missing leaves Elysium **off**, the build and every test green, and the switch naming what is missing
(`missing`; a build prints `Elysium stays off until: ...` once anything of day 9 is there, and today's builds print
nothing). rugged97's pull request may land any part of it first: a profile without a record, a record without our pin,
read-v6 without 99901. The pin is never computed by the build: a record that is not pinned, or whose bytes differ from
its pin, is off, exactly as the other chains' records need their pins in `src/v2/manifest.ts` `V2_MANIFEST_PINS`. A pin
that is written but does not match its record fails `tests/elysium-switch.test.mjs`, as a drifted pin of the other chains
fails `tests/v2/manifest-pin.test.mjs`. Two things fail a build: a live build without Elysium's official mark
(`public/chains/elysium.png`, a square PNG, the owner's file), and a test override that names anything but an enabled 99901
profile.

**Everything follows the switch, nothing is handed to it.** `src/config/chainIdentity.ts:112` `V2_CHAIN_IDS` names 99901,
last, exactly when Elysium is live, so `isV2ChainId`, `V2_CHAINS`, the wallet's switching (`src/wallet/port.ts`
`switchToChain`), the session's networks (`src/session/machine.ts` `keptChains`) and every list built from them take it
with no edit. `src/v2/types.ts` `V2ChainId` always includes 99901, so TypeScript asks every `Record<V2ChainId, ...>` table
for its Elysium row; each row is written behind `ELYSIUM_LIVE`, so a build where Elysium is off carries none.

**What a live build carries.** The switch reads the profile and the pinned record's exact text and the build writes them
in as string literals (`__DOMINO_ELYSIUM_PROFILE__`, `__DOMINO_ELYSIUM_DEPLOYMENT__` with its pin
`__DOMINO_ELYSIUM_DEPLOYMENT_PIN__`), parsed once in `src/v2/elysiumFiles.ts`; `null` where Elysium is off. No app file
imports a file that may not exist (`tests/v2/chain-layouts.test.mjs`).

**Test builds.** `DOMINO_TEST_ELYSIUM_PROFILE` (and `DOMINO_TEST_ELYSIUM_FUNDS_FROM=1`) force the switch in the test builds
only (`npm run build:wallet-test-v2-elysium`, into `.wallet-test-v2-dist-elysium[-funds]`); the release build and every
other build ignore them. A forced build stands in for the whole of day 9 with the synthetic profile
`tests/fixtures/v2-chains/elysium-99901.json` (rugged97's `backend/tests/v2_hype_chain.py` `document(dexes=(4,))` shape on
99901) and no production record: Elysium's contracts there are the fork-rehearsal fixture
`src/v2/fixtures/manifest.elysium-99901.fixture.json` (Arbitrum One's rehearsal moved to that profile with v4 alone, as
`tests/v2/support/v4-only.mjs` `v4OnlyManifest` derives it; pinned in `src/v2/manifestFixtures.ts`), under the test
admission. Node tests force it the same way: `tests/v2/support/elysium-live.mjs` (`ELYSIUM_FORCED`, `withRecord`,
`withFunds`, `loadWith`, `runWith`).

**Day 9's packages, rehearsed** (added 7 Nov 2026, Elysium's screens). Without rugged97's day-9 read-v6 and position-plan-v1,
the packages the app bundles refuse every read and plan of chain 99901, so a forced build could only show Elysium's screens
empty. A forced test build, and only it, therefore bundles those two packages' data as his day-9 versions have them
(`scripts/elysium-rehearsal.mjs`, served by `vite.config.ts` `elysiumRehearsal` in place of each package's
`schema-data.mjs`): every chain-id enum that names Base and Arbitrum One takes 99901, an answer's one-per-chain `chains`
list one more entry, read-v6 `priceProfiles[99901]` prices HYPE at its native pool alone (the runtime's own `nativePool`
shape), and position-plan-v1 has a 99901 row from the profile. The runtimes are rugged97's, unchanged; nothing under
`api-contracts/` is written; the release build and every other build bundle the packages as they are
(`tests/elysium-switch.test.mjs`). `tests/support/elysium-day9.mjs` loads the same runtimes in node, and the browser suites'
fixture services check every Elysium answer with them.

**A second fact, funds can come from Elysium** (`ELYSIUM_FUNDS_FROM`, derived, never written by hand): Elysium is live
**and** crosschain-v1 pins Relay or Across for 99901 (`api-contracts/crosschain-v1` `CONSTANTS.chains`). On 6 Nov neither
bridge serves 99901, so Home's "Bring funds from" row does not name Elysium on day 9 (its own "Open positions on" row does,
below). The day crosschain-v1 pins it, that row lists Elysium last with its mark, the funding scene takes a sixth place,
its "Networks and transfers" line names it, Bring funds' page lists it, and the app looks for funds there
(`src/finance/v2/holdings.ts` `CANDIDATE_ORIGINS`, `src/v2in/funds/model.ts` `BALANCE_ORIGINS`, by themselves). Funds are never brought **to**
Elysium: `src/v2/types.ts` `S2_DESTINATION_CHAIN_IDS` stays the three (S2's gate is off there, no destination choice
names it) until its profile names a bridge, crosschain-v1 pins it as a destination and the deposit's two records
(`src/finance/v2/crosschain.ts` `isPendingBatch`, `src/v2/crosschain/steps.ts` `isJournalRecord`) take it.

How it is proven: `tests/elysium-switch.test.mjs` (every piece missing on its own, the pin, the release build ignoring the
override, the repository's own state as a skipped test until day 9), `tests/v2/elysium-chain.test.mjs` (the chain core
off and forced on), `tests/v2/chain-identity.test.mjs`, `tests/docs.test.mjs`, `tests/session.bundle.test.mjs` (today's
release build and test builds carry no `99901`, `WHYPE` or Elysium slug at all), `tests/v2/elysium-screens.test.mjs` (every
screen list off and forced on), `tests/v2in-browser/elysium-surface.test.mjs` and `tests/v2in-browser/elysium-money.test.mjs`
(every money screen on Elysium, forced on with day 9 rehearsed, and a service that does not name 99901 yet).

## What is done

- **The chain model takes a HYPE-native chain** with v4 alone: native `HYPE`, wrapped `WHYPE`, rank 2 the chain's own
  native and wrapped currencies, Nitro ordering, no L1 fee, its own finality, `nativeUsd: 'pool'` and `bridgeProviders`.
  `hasDex` / `chainHasDex` (`src/v2/chains.ts`) is the one question every list, picker, plan, client and read asks; the
  manifest parser (`src/v2/manifest.ts`) takes the nine-component shape only for such a chain, and the three live chains
  still fail closed on any missing component. Nothing of v3 is offered, planned, built, sent or read there.
  `tests/v2/v4-only-chain.test.mjs` and `tests/v2/v4-only-screens.test.mjs` run the synthetic profile through it.
- **Section 1, the chain list and the profile** (by the switch): `src/config/chainIdentity.ts:112`; Elysium's facts row
  `src/v2/chains.ts:213` (from `src/v2/elysium.ts`); its profile in the chain list `src/v2/chains.ts:362`.
- **Section 2, the deployment and the services** (by the switch): `ENABLED_CHAINS` `src/v2/manifest.ts:194`; its binding
  `:606`; `V2_DEPLOYMENTS` and `V2_MANIFEST_PINS` `:761`-`:762` (the pinned record, parsed under the production admission:
  a fork-rehearsal record is refused); the backend table's Elysium row, off, `src/v2/capabilities.ts:31` (its services
  open, as the other chains', from their routes' own answers: `src/v2/gate.ts` `serviceRouteOpen`); `S1_PLAN_CHAINS`
  `src/v2/gate.ts:142`; the preview's fixture, and its fallback to the pinned set where the synthetic fixture binds
  nothing (`src/v2/gate.ts:95`); S2 off there (`src/v2/gate.ts:176`, `src/v2/crosschain/present.ts`
  `destinationChoices`, `src/v2in/funds/BringFunds.tsx:111`); `FIXTURE_MANIFESTS` / `FIXTURE_PINS`
  `src/v2/manifestFixtures.ts:48`. read-v6: a capabilities answer may name chains beside the three, each ignored here
  (`src/v2/routes.ts:126` `v6Chains`; the three must still all be there, in order), and a portfolio or activity answer
  that names a chain the app does not serve has that chain's entries left out and its coverage recomputed
  (`src/v2/read/v6.ts:108` `servedOnly`), so rugged97's four-chain read-v6 landing before our pin never shows a chain no
  table names. The read Worker's capabilities take read-v6's own list (`bridge/src/worker.mjs:106`).
- **Section 3, identity** (by the switch): its name (`src/lib/networkName.ts`, the bring card, read-v6's coverage
  sentence), its mark (`src/lib/chainMarks.ts`, the owner's `public/chains/elysium.png`), its explorer rows `null` until
  checklist step 5 (`src/v2/explorers.ts:21`, `src/components/docs/DocsContent.tsx:33` and
  `src/components/pool/ExplorerAddress.tsx:19`: a network with no explorer there draws no link), WalletConnect's session
  chains (`src/wallet/walletConnectProvider.ts:34`).
- **Section 5, token pictures**: no DEX Screener slug for Elysium is known (checklist step 6); its tokens take the plain
  mark meanwhile. HYPE and WHYPE take it too (no Ether picture on a HYPE chain).
- **Per-chain tables that TypeScript asks for**: Automate's gates (`src/v2in/automate/SetupEntry.tsx:24`,
  `ProtectionSetup.tsx`, through `src/v2in/automate/gate.tsx:51` `useElysiumGate`: no hook at all where Elysium is off),
  New position's gates (`src/v2in/journey/source.ts:30`, the chain list), a V2 position's route
  (`src/v2in/route.ts:14`: `#/positions/elysium-v4-<id>` where live), and the type `TokenChainId`
  (`src/lib/read/types.ts:278`).
- **Section 4, the screens' lists** (7 Nov, Elysium's screens): `src/config/chainIdentity.ts` `OTHER_V2_CHAIN_IDS` and
  `isOtherV2ChainId` (the V2 chains beside Robinhood Chain) feed every list that wrote out "Base and Arbitrum One", and
  `V2_CHAIN_IDS` every list of "the three": New position's offered and read networks and `mergeGates`, a pool's chain, the
  network token, New position and network pool routes (`routes.ts`, `poolNetwork.ts`), the network token page's pools,
  `onNetwork` and its two copies, the Wallet card's Markets links, Automate's Auto-exit entry, the automation store, price
  recovery, the signature journal, vault hand-offs, the positions' network order, and a V2 position's page
  (`src/screens/Positions.tsx`). The Wallet card asks about Elysium's tokens in a read of their own
  (`src/v2in/walletNetworks/WalletNetworks.tsx`), so a service without 99901 leaves Base's rows as they are. Funds: Elysium is
  an origin only where funds can come from it (above); `src/finance/v2/fundingJournal.ts` and `SERVED_BALANCE_CHAINS` keep
  the three (destinations; Elysium's balances for funds go in the request of their own). Docs: `DocChain` and
  `EVERY_NETWORK` take 99901 only once its explorer is known (`src/lib/docs/elysium.ts` `ELYSIUM_LINKED`); `V3_NETWORKS`
  keeps the three.
- **Section 6, the words** (7 Nov): "Domino works with Uniswap v3 and v4 pools; Elysium has Uniswap v4 only." (What is
  Domino; Pools' "Uniswap v3 and v4"), the Wallet card's tokens on Elysium (Positions), Privacy's provider sentence naming
  Elysium; New position's amount step says "paid in HYPE" there (`src/lib/nativeWords.ts`). Figures' "in Uniswap v3 pools"
  sentence is true as it is. Today's words wherever Elysium is off.
- **Home** (7 Nov, the owner's order of 6 Nov): where Elysium is live the hero gains "Open positions on: Robinhood Chain,
  Base, Arbitrum One, Elysium" in the funding row's chips, Elysium last with its mark, each leading to New position
  (`POSITION_ROW`); today Home is what it was. The pool page's network segment and the position page's network chip draw
  Elysium's mark beside its name (the three networks' chips are unchanged).
- **Section 7, the tests** (7 Nov): the "served nowhere" checks turned around under `ELYSIUM_FORCED`
  (`tests/v2/hype-chain.test.mjs`, `tests/v2/v4-only-screens.test.mjs`), `tests/v2/elysium-screens.test.mjs`, and the browser
  suite above.
- **The review of 7 Nov** (two reviews, findings A to G and P1 to P13): rugged97's pull request turns nothing red,
  whichever pieces it lands (the tests that stood on the packages' three chains read the packages' own lists:
  `tests/elysium-switch.test.mjs`, `tests/forwarder.test.mjs`, `bridge/test/read-v6-*.test.mjs`, and three `tests/v2`
  files); read-v6's coverage sentence leaves out a chain the app has no name for (`src/v2/read/v6.ts` `coverageNote`);
  Home's row, the Wallet card's Elysium lane and the pool step's one-version leads fold out of the release build. Where
  Elysium is live: a short amount there says "Lower the amount, or add tokens to your wallet." (no funds are brought to
  it: `src/lib/elysiumIdentity.ts` `fundsBroughtTo`, held equal to `isS2Destination`), the network fee's reason
  (`src/lib/nativeWords.ts`) and a pool's Details name HYPE, Automate's pickers never draw HYPE as Ether
  (`src/components/automate/marks.tsx`), "Create a new pool (advanced)" names no Uniswap version
  (`src/v2in/journey/copy.ts` `ONE_VERSION`; the switch's test holds Elysium's profile to `uniswap.v3` null), the
  Wallet card keeps Elysium's rows through a failed re-read, and the docs never promise bringing funds to a position
  there and name its fee in HYPE.
- **The words**: the docs (`src/lib/docs/elysium.ts`, every page that names the networks), USD wording on a pool-priced
  chain (`src/v2in/position/usdAvailability.ts`), the screens naming the chain's own currency, and the identity slots in
  every place that draws a network's mark.

## Before day 9: what must exist

1. Elysium mainnet live with an explorer (or none yet: no link is drawn).
2. Uniswap v4 and Universal Router 2.1.2 on the chain (the schema admits 2.1.2 only). No v3 is needed.
3. rugged97's enabling pull request merged (docs/v2/QUALIFY_CHAIN.md, "After the qualification"):
   `api-contracts/v2/chains/elysium-99901.json` (enabled, `uniswap.v3` null, replacing `elysium.json`), the release
   manifest and the API schemas that list chain ids.
4. The deployment record `docs/deployments/v2-elysium-99901-<date>/deployment.json`, verified at `finalized`: nine
   contracts, `contractNames` the 13.
5. rugged97's service versions that name the chain: read-v6 (its `CONSTANTS.chainIds` and portfolio enum), and
   position-plan (`CONSTANTS.chains`). crosschain stays as it is: S2 is off on Elysium until Relay or Across serve it.
6. Done 7 Nov 2026: the owner's file, Kinetiq's official Elysium mark, at `app/public/chains/elysium.png`.

**Order.** Changed on purpose 2026-11-07 (review finding P3): it said the app must go "before or with" the four-chain
read gateway, which is unsafe the "before" way. read-v6 takes a portfolio or activity answer only when its chains are
exactly the package's `CONSTANTS.chainIds` (the schema's one-per-chain count and `api-contracts/read-v6/runtime.mjs:160`),
and three parties each hold every answer to their own copy of the package: the app, the read Worker
(`bridge/src/worker.mjs`) and rugged97's gateway. Under one `CONTRACT_VERSION`, any of them ahead of or behind the others
refuses every portfolio and activity answer, and V2 positions, Receipts and the Wallet card go blank on all three live
networks, Elysium's switch on or off (the package changes with his merge, not with our pin). The position-fees lesson
was about a new route, which a new version served beside the old one solved. So, in the one batched message to rugged97:
is the day-9 read-v6 a new contract version served beside 1.1.0-rc.1? Yes: his gateway and the read Worker serve both,
then the app. No: the three go out back to back in one window the owner picks (Monday checklist, step 9). First
read-only (portfolio, Top pools), then create and automate.

## Decisions for the owner (not code)

- **The gas reserves are in ETH terms.** `src/lib/create/reviewPlan.ts:22` `REVIEW_GAS_RESERVE_WEI` (0.0005 of the
  native currency) is kept for a step's network fee on every chain; on Elysium it is 0.0005 HYPE. Keep it, or set one
  per chain.
- **A kept dollar figure.** On the Ether chains a stale ETH feed keeps the last complete valuation
  (`src/v2in/lists/valuation.ts:39` `PASSING`). On Elysium, HYPE's pool not qualifying says `no_qualified_price_source`,
  which today clears it. Keep, or treat it as passing there too.
- **The chain picker's order** (spec open point 23): Elysium last, after Arbitrum One, unless the owner says otherwise.
  The switch puts it last in every list it touches.
- **Home's funding scene with six places** (built, shown only once funds can come from Elysium): Elysium fifth, just
  above Robinhood Chain, which keeps the foot of the column. Keep, or another order.
- **Elysium on Home before a bridge serves it.** Decided by the owner's order of 6 Nov ("o ícone da Elysium na página
  inicial"): Home's "Open positions on" row, shown only where Elysium is live (above). Keep its words and place, or another.
- **Elysium's token pictures.** HYPE and WHYPE have no picture (no Ether picture on a HYPE chain), and every Elysium
  token takes the plain mark until DEX Screener lists Elysium (checklist step 6); Circle's USDC gets its logo by step 7.
  A HYPE picture would be the owner's file, as Elysium's mark was. Keep the plain marks, or supply one.
- **Wallets that do not know Elysium.** The app never adds Base or Arbitrum One to a wallet (no network details, no
  public RPC); Elysium is the same: the person sees "Add Elysium to your wallet, then try again."

## Not touched

The old V1 Elysium section (`src/chains/elysium`, `src/config/chainElysium.ts`, testnet 99801) stays as it is and off.
