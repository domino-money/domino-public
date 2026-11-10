# Elysium on day 9: the app's change

## Day 9, as it went (9 Nov 2026)

The checklist below, step by step, as it was done; it stays as written for the next chain (the owner's rule: every chain
the Robinhood recipe).

1. The switch waited for read-v6 alone once the record was pinned. rugged97's #486 named 99901 under the same versions
   (1.1.0-rc.1, 1.2.0-rc.1), and its part 2 opened `chain-tokens` to 99901.
2. Record `docs/deployments/v2-elysium-99901-2026-11-09/deployment.json` reviewed (nine contracts at the three chains'
   addresses, the 13 names, verified at `finalized` 3,322,484) and pinned (`d3d4f694…`).
3. No version moved: nothing to follow.
4. `finalityMinutes` stays 12: mainnet `finalized` trails the head by 6 to 25 minutes in batch steps (350 s at the
   profile's block, 10 to 25 minutes during the deployment).
5. Kinetiq's explorer, `https://elysium.kinetiq.xyz` (`/tx/`, `/address/` at the root): `ELYSIUM_EXPLORER`. Domino's
   contracts there still await source verification on it (rugged97, with the owner's OK).
6. DEX Screener lists Elysium as `elysium` from its first day: `src/lib/tokenArtwork.ts` `DEX_CHAIN_SLUGS` and `EDGE_PATH`
   (where Elysium is live) and `functions/_lib/dexEdge.ts` `DEX_CHAINS`.
7. Its USDC (`0xb47c…0b65`) is the bridged token of Elysium's canonical bridge, not Circle's: the plain mark stays.
8. The full list passed on `main` + #486 + this change (the real-Vite HMR test fails locally on `main` too).
9. rugged97's reader and gateway from #486 went first (23:38 UTC), the three chains checked through the live read Worker;
   then the preview held, #486 merged, the read Worker (four chains) and the position-plan Worker (its live build still
   refused 99901) deployed from that `main`, then the app. `position-fees` stays out of the read Worker's
   `ENABLED_V6_READS` until rugged97's gateway serves it: enabled for a moment, it answered 503 `upstream_unavailable`
   on Base and on Elysium alike, so it was taken out again before any page relied on it.
10. read-v6 `priceProfiles[99901]` and position-plan-v1 `chains[99901]` have the rehearsal's shape.
11. Read with the owner in the live site, once this change is published.

Funds brought **to** Elysium are no longer a hand edit: `scripts/elysium-switch.mjs` derives `fundsTo` (Elysium live, its
profile naming a bridge, crosschain-v1 pinning Relay or Across for 99901 and listing its destinations there), so they turn
on by themselves with rugged97's crosschain change (Relay alone, USDC alone); the crosschain Worker is deployed again after
it.

## Monday checklist

Line numbers of 7 Nov 2026 (branch `ely/money`, then `ready/day9` and `ready/ely-prelaunch`); search for the quoted code if they moved. Each step is one reviewed line
or one check; nothing else is edited by hand on the day.

1. After rugged97's pull request is merged (only as the Order's step 3 below says: after his gateway is checked, with the
   preview held, since CI uploads every green `main` to the preview), read what the switch still waits for:
   `npm run build:unit`, then `node --test tests/elysium-switch.test.mjs` (changed on purpose 2026-11-07, day-9
   rehearsal: on a fresh checkout that file needs the compiled `.test-build` first)
   (the skipped test "day 9 in the repository" names each missing piece), or the line a build prints
   (`Elysium stays off until: ...`).
2. Review rugged97's deployment record (`docs/deployments/v2-elysium-99901-<date>/deployment.json`: nine contracts,
   `contractNames` the 13, `public-chain-preparation`, verified at `finalized`), then pin it:
   `scripts/elysium-switch.mjs` `export const ELYSIUM_RECORD_PIN = null;` becomes
   `ELYSIUM_RECORD_PIN = Object.freeze({ path, sha256 })`, the hash of the committed
   blob, not of the working file (changed on purpose 2026-11-07, day-9 rehearsal: a CRLF checkout's file differs from
   CI's LF blob, and PowerShell's `Get-FileHash` prints uppercase hex, which the switch refuses):
   `git show HEAD:docs/deployments/v2-elysium-99901-<date>/deployment.json | sha256sum` in Git Bash (lowercase hex; the
   path from the repository's root, no `./`). The record's folder carries the profile's slug, `v2-elysium-99901-<date>`
   (a folder under another slug is not Elysium's record). Once every piece is there, a build that would turn Elysium on
   with a profile the app's chain parser refuses, or a pinned record the production admission refuses, fails, naming
   why (`scripts/elysium-switch.mjs` `profileRefusal`, `recordRefusal`): take it back to rugged97, never around it.
3. If his read-v6 or position-plan package moved its `CONTRACT_VERSION`, the app's versions follow it:
   `src/v2/read/v6.ts:28` `READ_V6_CONTRACT_VERSION` (`:30` the next version) and `src/v2/plan/types.ts:17`
   `S1_PLAN_CONTRACT_VERSION`, each with a `// Changed on purpose 2026-11-09 (Elysium's day 9: rugged97's <package>
   <version>)` line above it; he updates `src/v2/pins.ts:15` and `:56` himself (`tests/v2/read-v6.test.mjs` holds all
   four). Nothing else moves by hand: since 7 Nov (day-9 rehearsal) every test and fixture path reads read-v6's versions
   from the package itself (`api-contracts/read-v6/runtime.mjs` `CONTRACT_VERSION`, `NEXT_VERSION`); the tests of the
   two-version probe skip, naming why, when the package has one version. Whether read-v6 moved its version decides the
   publishing order (step 9).
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
8. Run on fresh builds, from `app/`, each command on its own (changed on purpose 2026-11-07, day-9 rehearsal:
   `npm run test:pages` chains its parts with `&&`, so one render failure hid `test:session` and `test:consumer`):
   `npm run typecheck`; `npm run lint`; `npm run build:unit`; `node scripts/test.mjs`; `node --test "tests/v2/*.test.mjs"`;
   `node --test tests/elysium-switch.test.mjs tests/elysium-opening.test.mjs tests/elysium-prelaunch-guards.test.mjs
   tests/docs.test.mjs tests/contract-pin.test.mjs` (the switch's pre-launch cases, "Before day 9: the pre-launch
   state" below, now expect `stage` 'live' and no `opening`); `npm run release:build`
   (before any browser suite: a browser suite's pictures must never sit untracked in the checkout); `npm run test:session`;
   `npm run test:v2in`; `node --test --test-force-exit tests/page-watch.test.mjs tests/render.test.mjs`;
   `npm run test:consumer`; `npm run test:read`; then, from `bridge/`, `node --test` and `npm run check`.
   "day 9 in the repository" (`tests/elysium-switch.test.mjs`) and "Elysium's pinned record"
   (`tests/v2/manifest-pin.test.mjs`: the real record admitted for production on 99901) must pass, not skip. A profile
   the app's chain parser refuses (`src/v2/chains.ts` `chainOf`) or a pinned record the production admission refuses no
   longer builds at all (step 2). Live, the bundle test gives domino v2 8,500 B and the pool history chart 500 B more
   (`tests/session.bundle.test.mjs` `ELYSIUM_ALLOWANCE`); if the real record is over that, measure and raise by that file's rule.
   Measured on 7 Nov on the release build of `ready/final` (the pre-launch stage, gzip 9 on Windows): domino v2
   684,062 B against 684,500 B; the initial entry 242,999 B against 243,500 B, with no live allowance at all, so any
   Elysium code that reaches the first download shows there first. Once the repository turns Elysium on, test:v2in's two Elysium suites run on the usual test build
   (rugged97's profile and our pinned record, `tests/support/elysium-profile.mjs`), and the suites that held today's
   Elysium-off usual build take Elysium's row, search and balances read.
9. The publishing order (the Order section below has the why and the exact checks). It needs, **before Monday**, the read
   Worker built from a `main` that carries the read-v6 skew change (`bridge/src/worker.mjs` `ownChains`; a Worker deploy,
   the owner's OK) and the app with it (`src/v2/read/v6.ts` `servedOnly` before the second check; it ships with the next
   publish). Ask rugged97, in the one batched message, which of the two shapes his day-9 read-v6 has, and to tell us before
   and after he deploys his reader and gateway. Then, whichever the shape: **his reader and gateway first; then the read
   Worker built from the `main` that carries his package (the owner's OK); then the app from that `main`**, with the
   checks between each (the Order section). Never the other way round: a read Worker or app built from his four-chain
   package ahead of his gateway, or that app ahead of that Worker, refuses every portfolio and activity answer (V2
   positions, a position's page, Receipts and Automate blank on Robinhood Chain, Base and Arbitrum One;
   `tests/v2/read-v6-skew.test.mjs` "never safe"). CI uploads every green push to `main` to the preview, which reads the
   same read Worker, so his pull request is merged only with the preview held (`GATED_PREVIEW_HOLD`, the Order's step 3)
   until the app from that `main` is published by hand. If his shape is a new version: before building that Worker, run
   `node --test bridge/test/read-v6-*.test.mjs` on the merged `main` (today's app asks 1.1.0-rc.1, and `position-fees` in
   1.2.0-rc.1: both must answer as before), and the app's versions follow by step 3. Changed on purpose 2026-11-07
   (day-9 rehearsal): the read Worker bundles ONE read-v6 package and takes only that package's `CONTRACT_VERSIONS`, and
   its runtime holds every answer to one `CONSTANTS.chainIds`; rehearsed, a Worker built from a package whose only version
   is new answers today's app `502 upstream_contract_mismatch`, and today's Worker refuses the new version. So a new
   version is safe in this order only if his package keeps 1.1.0-rc.1 and 1.2.0-rc.1 in `CONTRACT_VERSIONS` with each
   answer held to its own version's chain list (the question below); a package of the new version alone is treated as
   one window: his gateway, the read Worker and the app back to back, the app's versions moved by step 3. Rolling back
   goes the other way: the app, then the Worker, then his gateway.
10. Check rugged97's two packages against the rehearsal the forced test builds used before day 9
    (`scripts/elysium-rehearsal.mjs:72` `rehearseReadV6`, `:85` `rehearsePlan`): read-v6 `CONSTANTS.priceProfiles[99901]`
    (`stable`, `wrapped`, `feed` and `heartbeatSeconds` null, `nativePool`) and position-plan-v1 `CONSTANTS.chains[99901]`
    (its `l1DataFeeSource`). Changed on purpose 2026-11-07 (day-9 rehearsal): once his packages name 99901, the forced
    builds bundle them exactly as they are (no enum is widened, so a forced build refuses what the release build
    refuses); if his shape differs, `npm run test:v2in` says where.
11. Read with the owner (Monday, in the live preview, once the Order's step 4 published it): Home's "Open positions on" row
    (`src/components/home/HomeCapabilities.tsx` `POSITION_ROW`) and that the pre-launch pieces are gone (Home's Elysium chip
    has no tag and opens New position, and What Domino is has no Elysium section), the Wallet card's "Elysium's dollar token"
    (`src/lib/docs/pages/using.ts:307`: its symbol once the real profile names it), Privacy's "network provider outside
    Domino" for Elysium's balances (`src/lib/docs/pages/custody.ts:212`: rugged97 to confirm who reads them), and what
    Elysium lacks until steps 5 and 6: no explorer link, plain token marks, and on Markets, the pool page and New
    position's pool rows no TVL, 24h volume or APR (dashes) and no liquidity line on search hits, so the docs' "Tokens
    that share a name show their liquidity" (`src/lib/docs/pages/using.ts:55`) holds there only from step 6.

Funds from Elysium need no edit: `src/finance/v2/holdings.ts` `CANDIDATE_ORIGINS` and `src/v2in/funds/model.ts`
`BALANCE_ORIGINS` name it by themselves the day crosschain-v1 pins Relay or Across for 99901 (`ELYSIUM_FUNDS_FROM`). Funds
brought **to** Elysium need none either since 9 Nov: `fundsTo` (`scripts/elysium-switch.mjs`) turns them on once its profile
names a bridge and crosschain-v1 pins 99901 with its destinations (`src/v2/types.ts` `S2_DESTINATION_CHAIN_IDS` and the
deposit's two records follow it, below).

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
| `pin` | that record's SHA-256 equal to `ELYSIUM_RECORD_PIN` (`scripts/elysium-switch.mjs`), written by a person | ours |
| `readV6` | `api-contracts/read-v6` `CONSTANTS.chainIds` names 99901 | rugged97 |
| `plan` | `api-contracts/position-plan-v1` `CONSTANTS.chains` has a 99901 row | rugged97 |

Any piece missing leaves Elysium **off**, the build and every test green, and the switch naming what is missing
(`missing`; a build prints `Elysium stays off until: ...` once anything of day 9 is there, and today's builds print
nothing). rugged97's pull request may land any part of it first: a profile without a record, a record without our pin,
read-v6 without 99901. The pin is never computed by the build: a record that is not pinned, or whose bytes differ from
its pin, is off, exactly as the other chains' records need their pins in `src/v2/manifest.ts` `V2_MANIFEST_PINS`. A pin
that is written but does not match its record fails `tests/elysium-switch.test.mjs`, as a drifted pin of the other chains
fails `tests/v2/manifest-pin.test.mjs`. Four things fail a build: a line `ELYSIUM_OPENS_ON` that is neither `null` nor
a day (the pre-launch state, below), a live build without Elysium's official mark
(`public/chains/elysium.png`, a square PNG, the owner's file), a test override that names anything but an enabled 99901
profile, and (changed on purpose 2026-11-07, day-9 rehearsal) a live build of the repository whose profile the app's
chain parser refuses or whose pinned record the production admission refuses (`profileRefusal`, `recordRefusal`, held to
the app's own parser case by case by `tests/v2/elysium-build-guard.test.mjs`): rehearsed, either built green, then threw
at load in every V2 chunk on all four networks (a profile) or showed Elysium everywhere with its contracts unavailable (a
record). The record's folder must carry the profile's slug (`v2-elysium-99901-<date>`), as `scripts/v2/deploy.mjs`
names it.

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
(`src/finance/v2/holdings.ts` `CANDIDATE_ORIGINS`, `src/v2in/funds/model.ts` `BALANCE_ORIGINS`, by themselves). Funds brought **to**
Elysium follow a third derived fact, `fundsTo` (added 9 Nov): `src/v2/types.ts` `S2_DESTINATION_CHAIN_IDS` names 99901,
a deposit there offers only the tokens crosschain-v1 lists for it (USDC), and the deposit's two records
(`src/finance/v2/crosschain.ts` `isPendingBatch`, `src/v2/crosschain/steps.ts` `isJournalRecord`) take any S2
destination, once its profile names a bridge and crosschain-v1 pins it as an origin and a destination; until then S2's
gate is off there and no destination choice names it.

How it is proven: `tests/elysium-switch.test.mjs` (every piece missing on its own, the pin, the release build ignoring the
override, the repository's own state as a skipped test until day 9), `tests/v2/elysium-chain.test.mjs` (the chain core
off and forced on), `tests/v2/chain-identity.test.mjs`, `tests/docs.test.mjs`, `tests/session.bundle.test.mjs` (today's
release build and test builds carry no `99901`, `WHYPE` or Elysium slug at all), `tests/v2/elysium-screens.test.mjs` (every
screen list off and forced on), `tests/v2in-browser/elysium-surface.test.mjs` and `tests/v2in-browser/elysium-money.test.mjs`
(every money screen on Elysium, forced on with day 9 rehearsed, and a service that does not name 99901 yet; once the
repository turns Elysium on, on the usual build with rugged97's profile: `tests/support/elysium-profile.mjs`),
`tests/v2/elysium-build-guard.test.mjs` (the build's guard against the app's own parser). The pre-launch
state (below): `tests/elysium-opening.test.mjs` (the opening day in nine time zones, UTC-12 to UTC+14),
`tests/elysium-prelaunch-guards.test.mjs` (where its names may live), the pre-launch cases of
`tests/elysium-switch.test.mjs`, `tests/docs.test.mjs` and `tests/session.bundle.test.mjs` ("Elysium before live", "Elysium
live wins over pre-launch"), and `tests/v2in-browser/elysium-surface.test.mjs` (the row and the section, the boundary
crossed in an open page at both ends of the world, after the day, the keyboard, a missing mark, live winning, and nothing
asking chain 99901 on Home, the docs, Markets, New position, Positions, Automate, the wallet dialog and the menu).

## Before day 9: the pre-launch state (added 7 Nov 2026, the owner's order)

One hand line, `scripts/elysium-switch.mjs` `ELYSIUM_OPENS_ON = '2026-11-09'` (Kinetiq's announced day), puts the
build in **pre-launch** while Elysium is not live: `stage` off / prelaunch / live, written in as
`__DOMINO_ELYSIUM_PRELAUNCH__` and `__DOMINO_ELYSIUM_OPENING__` (`src/lib/elysiumIdentity.ts` `ELYSIUM_PRELAUNCH`,
`ELYSIUM_OPENING`). It draws two things:

- Home's "Open positions on" row (the live row), its Elysium chip with the owner's mark, the tag "Opens Nov 9" /
  "Opens next", leading to the docs (`src/screens/Landing.tsx` `ElysiumNext`);
- What Domino is's last section, "Elysium" (`src/lib/docs/pages/introduction.ts`).

Nothing of chain 99901 is in such a build (`tests/session.bundle.test.mjs`), and no Elysium choice exists anywhere.

**The date is the visitor's**: the words change at the start of 9 Nov in the browser's own time zone, by themselves
(`src/lib/elysiumOpening.ts`). A build made after the day stays true.

**Live always wins**: the day every piece of the table above is in, the build is live and carries none of the
pre-launch pieces. Nothing is edited for it on Monday.

- If Kinetiq moves the day: change the line (one reviewed line) and publish.
- To take Elysium off the site before live: set it to `null` and publish.
- After launch, an optional cleanup PR may remove the pre-launch pieces and the line. Live ignores them.

A typo in the line (`'2026-11-31'`, `'9 Nov 2026'`) fails every build at once, whatever the stage. No environment variable
changes the stage.

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
  (`src/v2/read/v6.ts:122` `servedOnly`), so rugged97's four-chain read-v6 landing before our pin never shows a chain no
  table names. The read Worker's capabilities take read-v6's own list (`bridge/src/worker.mjs:106`). Since 7 Nov (the
  read-v6 version skew, "Order" below) the app and the read Worker also read a four-chain answer under today's
  three-chain package, without the fourth (`servedOnly` before the second check; `bridge/src/worker.mjs:122`
  `ownChains`).
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
  (`POSITION_ROW`); before live, in pre-launch (above), the same row with Elysium's chip saying when it opens and
  leading to the docs. The pool page's network segment and the position page's network chip draw
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

**Order.** Changed on purpose 2026-11-07 (review finding P3, then the read-v6 version skew and its review's skew-1, the
preview CI uploads, branch `ready/skew`). read-v6
takes a portfolio or activity answer only when its chains are exactly the package's `CONSTANTS.chainIds` (the schema's
one-per-chain count and `api-contracts/read-v6/runtime.mjs:160`), and three parties each hold every answer to their own
copy of the package: the app, the read Worker (`bridge/src/worker.mjs`) and rugged97's gateway (`backend/read_gateway.py`
with `backend/v2_read_contract.py`'s models). What the code does, run with the real runtimes on day-9 answers
(`tests/v2/read-v6-skew.test.mjs`; rugged97's Python models run the same way, in a scratch copy):

- **Requests are not where it breaks.** Every request today's app sends (`portfolio`; `activity` with a cursor of the three;
  `chain-pools`, `chain-tokens`, `position-fees` and `chain-balances` with its tokens, on the three) passes today's
  package, the day-9 package and his day-9 models. A request naming 99901 is refused by today's package and his
  three-chain gateway; only an app that serves Elysium sends one.
- **Answers are.** Under one version, today's package refuses every four-chain portfolio and activity answer whole, and the
  day-9 package every three-chain one; his models do the same. The chain reads (`chain-pools`, `chain-tokens`,
  `position-fees`, `chain-balances` with tokens) name the chains asked, so they are the same in either: Markets' network
  pools, token search, Fees earned and the Wallet card's balances are in no skew. (`chain-balances` without tokens would be;
  the app never sends it.)
- **What the screens showed with the code of 7 Nov (main `f6aa00bb`).** His four-chain gateway ahead: the read Worker
  answers every portfolio and activity `502 upstream_contract_mismatch`, a dash in the app. A Worker built from his
  package ahead of his gateway: the same 502. That Worker with his gateway but today's app: the app refuses the answer
  (`invalid`). That app ahead of that Worker: refused too. Each way, V2 positions, a position's page, Receipts and
  Automate go blank on Robinhood Chain, Base and Arbitrum One, Elysium's switch on or off, and the Wallet card's Base and
  Arbitrum One rows lose the tokens of the wallet's positions (they keep each network's own currencies). The
  capabilities never decide it: either Worker answers 1.2.0-rc.1, so the probe stays there, and today's app takes a list
  with 99901 beside the three (`src/v2/routes.ts` `v6Chains`); a version neither Worker has is refused with a 502.
- **The change (`ready/skew`).** The read Worker (`ownChains`) and the app (`servedOnly`, before the second check) check
  an answer their package refuses whole once more, without the chains its own `chains` lists beyond theirs: only when
  those are distinct chain ids and the answer's coverage is its own chains'; their entries left out unread, an entry of
  any other chain kept (and refused), the coverage then the remaining chains' own. What is left must pass every rule of
  the package and of the request, and the Worker relays only that (an answer its package takes, every answer today, is
  relayed byte for byte as before). Requests do not change at all. So his gateway may go first. One thing it cannot
  rescue: an activity page whose last receipt is on Elysium carries a cursor naming 99901, which today's package cannot
  ask for, so that page is still refused (a dash on Receipts for that wallet) until the Worker and the app built from his
  package are both live; only a wallet that already used Domino on Elysium has one.

**Before Monday:** the read Worker built from a `main` with this change (the owner's OK: a Worker deploy, by the
`--keep-vars` method of 4 Nov) and the app with it (the next publish). The narrowed answer the Worker relays is a plain
three-chain answer, so the app of `f6aa00bb` reads it too; the app's own half is needed from the day the Worker built
from his package is live (step 3 below), which relays the four chains as they came.

**Monday, if his read-v6 names Elysium under the same version (1.1.0-rc.1 and 1.2.0-rc.1, the chain list one longer):**

1. Check that ours is live: the read Worker's live version is the one deployed with this change (Cloudflare's deployments
   of `domino-read-bridge`; the capabilities look the same from any build), the app's live digest is the one published
   with it, `GET /api/read/v6/capabilities` (header `X-Domino-Read-Contract: 1.2.0-rc.1`) answers 200 with `chainIds`
   `[4663, 8453, 42161]`, and a known wallet's Positions and Receipts show its three networks. Then tell rugged97 he may
   deploy.
2. rugged97 deploys his reader and gateway together, and says when. Check within minutes, in the live site: the
   capabilities as in 1; `POST /api/read/v6/portfolio` answers 200 and its `chains` are exactly the three (our Worker left
   Elysium out); Positions, a V2 position's page and Receipts as before. Every portfolio answering 502
   `upstream_contract_mismatch` means our Worker is not this build: he rolls his gateway back at once.
3. His pull request is merged only after 2 is checked, and only with the preview held. CI's "Deploy gated preview" job
   (`.github/workflows/ci.yml` `preview`) uploads the release build of every green push to `main` to the gated preview,
   and the preview reads the same read Worker as production (`app/wrangler.toml` `READ_BRIDGE`, `domino-read-bridge`):
   left alone, the merge itself puts the app of his package on the preview ahead of this step's Worker, and our Worker's
   three-chain answers blank its V2 positions, a position's page, Receipts and Automate on all three networks
   (`tests/v2/read-v6-skew.test.mjs` "never safe"). So, before the merge, the repository variable `GATED_PREVIEW_HOLD`
   is set to `true` (the owner's OK: Settings > Secrets and variables > Actions > Variables, or
   `gh variable set GATED_PREVIEW_HOLD --body true`; `gh variable list` shows it); the preview keeps the app checked in 1,
   and each push to `main` only records its build ("Preview held" in the run). Then the merge, then the read Worker built
   from that `main` (the owner's OK).
   Check: the capabilities' `chainIds` `[4663, 8453, 42161, 99901]`; the portfolio answers 200 with four chains (the
   network tab); the screens still show the three networks as before (the app leaves Elysium out).
4. The app from that `main`, preview and production together by hand, after the Monday checklist (the pin written, step 8
   green). Check: the screens on the three networks as before, and Elysium's (step 11). Only then is the variable deleted
   (`gh variable delete GATED_PREVIEW_HOLD`), so `main`'s CI deploys the preview again.

**Monday, if his read-v6 names Elysium under a new version served beside 1.1.0-rc.1 and 1.2.0-rc.1:** the same four
steps. In 2, his gateway must keep answering 1.1.0-rc.1 and 1.2.0-rc.1 exactly as today (if those answers carry Elysium
anyway, our Worker leaves it out, as above). Before the Worker in 3: `node --test bridge/test/read-v6-*.test.mjs` on the
merged `main`, since the Worker serves `position-fees` in its package's `NEXT_VERSION` alone and today's app asks it in
1.2.0-rc.1 (if his package moves `NEXT_VERSION`, `bridge/src/worker.mjs` takes a reviewed change first); in 3 the
capabilities also answer in his new version. In 4 the app asks his new version (checklist step 3: the versions, the
transport's header, the probe). Changed on purpose 2026-11-07 (day-9 rehearsal): this holds only for a package that
keeps 1.1.0-rc.1 and 1.2.0-rc.1 beside the new one, each answer held to its own version's chain list (for example
`CONSTANTS.chainIdsByVersion`, read by the runtime's envelope, cursor and `chain-balances` checks on the body's
`contractVersion`, the schema enums their union): the read Worker built in 3 bundles that one package, so it must still
answer today's app in today's versions with three chains. **If his package has the new version alone**, there is no
safe step between the parties: a Worker built from it answers today's app `502 upstream_contract_mismatch`, and
today's Worker refuses the new version. Then it is one window, with the owner's OK for each part: his gateway, at once
the read Worker built from his `main`, at once the app from that `main` (checklist step 3 done, step 8 green), the checks
of 2 to 4 after the three, and V2 positions, a position's page, Receipts and Automate blank between the first and the
last.

**Never:** a Worker or app built from his package ahead of his gateway, or that app ahead of that Worker; CI's preview
upload of a green `main` is that app going out too (hence the hold in 3). Rolling back goes the other way: the app
(preview and production, with `GATED_PREVIEW_HOLD` set again so a push to `main` cannot upload that app over it), then
the Worker, then his gateway (that Worker refuses three-chain answers).

**The question for rugged97** (in the one batched message): "On day 9, does read-v6 name Elysium under the same contract
versions as today (1.1.0-rc.1 and 1.2.0-rc.1, only the chain list one longer), or under a new version served beside
them? If a new one: its name, whether `NEXT_VERSION` or `NEXT_ROUTES` move, and please keep every 1.1.0-rc.1 and
1.2.0-rc.1 answer exactly as today (the three chains, `position-fees` in 1.2.0-rc.1) until we say the app has moved,
in the package itself too: our read Worker bundles your read-v6 package and takes only its `CONTRACT_VERSIONS`, so
please keep 1.1.0-rc.1 and 1.2.0-rc.1 there beside the new one, each answer held to its own version's chain list (for
example `CONSTANTS.chainIdsByVersion`, used by `envelope()`, `cursorKey()` and `validateExchange('chain-balances')` on
the body's `contractVersion`, the schema enums the union); a package of the new version alone means your gateway, our
Worker and our app go out back to back in one window.
Either way, please deploy your reader and gateway first, only after we confirm our read Worker of this change is live,
tell us when they are out, and tell us before you would ever roll them back (once our day-9 Worker is live it refuses
three-chain answers). And please leave the merge of your pull request to us: a green `main` goes to our preview by
itself, so we merge it once your gateway is checked, with the preview held." First read-only (portfolio, Top pools),
then create and automate.

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
  inicial"): Home's "Open positions on" row, shown where Elysium is live, and since 7 Nov in pre-launch too, with the tag
  "Opens Nov 9" ("Opens next" from the visitor's 9 Nov) and leading to the docs' Elysium section. Keep its words and
  place (the date as "Nov 9", the site's en-US, or "9 Nov"), or others.
- **Elysium's token pictures.** HYPE and WHYPE have no picture (no Ether picture on a HYPE chain), and every Elysium
  token takes the plain mark until DEX Screener lists Elysium (checklist step 6); Circle's USDC gets its logo by step 7.
  A HYPE picture would be the owner's file, as Elysium's mark was. Keep the plain marks, or supply one.
- **Wallets that do not know Elysium.** The app never adds Base or Arbitrum One to a wallet (no network details, no
  public RPC); Elysium is the same: the person sees "Add Elysium to your wallet, then try again."

## Not touched

The old V1 Elysium section (`src/chains/elysium`, `src/config/chainElysium.ts`, testnet 99801) stays as it is and off.
