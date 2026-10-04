# V2 wired integration tests (#300)

These offline Forge journeys run the production V2 contracts together, wired as a deployment would wire them, over the Uniswap bytecode deployed on Base and the Robinhood Permit2 and Universal Router 2.1.2. Each front (F1a-F4) tested with doubles of its neighbours; here none is replaced:
- the registry and price anchor, configured through the registry's own timelock;
- the zap (`DominoZapV3`, `DominoZapV4` with `DominoZapV4Steps`) and the vault swap module;
- the vault implementations, each with the executor its constructor creates, and the factory;
- the auto-exit module.

Only the currencies, the LP seed capital, a trader, a probe and the actors are test helpers. No RPC, publisher service, backend or browser is involved; prices are signed with `vm.sign` under the anchor's EIP-712 domain, or read from a v3 pool's own oracle history.

## The world

`IntegrationWorld.sol` builds it in `setUp`, for the suite's DEX:

- **Uniswap.** The Base (8453) v3 factory, NonfungiblePositionManager, WETH9, v4 PoolManager, PositionManager and StateView (F1c fixtures, `fixtures/base-8453.json`), with the storage their constructors wrote; the Robinhood Permit2, PoolManager and Universal Router 2.1.2 (F1b fixtures). Each is etched at its own address and checked against the code hash `api-contracts/v2/chains` records.
- **Governance.** The registry starts empty. The operator, the publisher, the router and four charge currencies are scheduled and executed after its one-hour timelock.
- **Currencies.** Three test ERC-20s, sorted by address: `base` (no charge currency), `quote` (rank 1) and `second` (rank 2). WETH9 and native ETH are rank 2 as on the target chains.
- **Markets.** Three pairs, each with a 0.3% position pool and a deep 0.05% pool for swap legs:
  - `main` (base, quote): the rank-1 currency is currency1;
  - `inverse` (quote, second): the rank-1 currency is currency0, so a vault on it reads prices the other way up and an auto-exit's tariff is led by currency0;
  - `side` (base, second): no rank-1 currency, for the zap's rank-2, hop and fallback cases.

  `thin` is a 1% main pool with almost no liquidity, for a conversion that must miss the anchor's floor. The router's own (Robinhood) PoolManager has the main deep pool, so router legs reach the router's real immutable destination; direct pool legs reach the LP stack's PoolManager.

The vault's factory is deployed at the address its implementation was built for. The owner approves the root to the predicted CREATE2 clone before creating it, and the NFT stays in the owner's wallet.

## Why the suites import only interfaces

The first version of these suites cost 24m42s on CI (run 37021480059): 87-263 s of compiling per suite file. The cause was not a `new` in the tests:
- solc 0.8.26 compiles, via IR, every concrete contract in a test file's import closure whenever that file is rebuilt;
- Forge lists every closure source in the output selection (with no outputs requested), and solc treats each listed contract as requested.

So each suite paid again for the vault, the zap and the fixture contracts with their 200 KB of runtime literals, even though it deployed them with `vm.getCode`. Measured on the captured compiler input of a trivial test that only imports `UniswapBase8453.sol`: 17.7 s as Forge sends it, 0.2 s once the fixture file's empty selection is dropped. A world-only test contract measured 4.5 s of its own against 41 s with its closure.

The suites are therefore built in two layers:
- **`IntegrationInterfaces.sol`.** Interfaces, structs and the cheatcodes the journeys add; the only thing the world, the journeys and the suites import besides interfaces, libraries and abstract contracts from `src/v2` and `ZapTestKit.sol`.
- **`IntegrationArtifacts.sol`.** Every concrete helper: the test currency, the trader, the v4 liquidity helper, the reentry probe, creation code for the Robinhood runtimes, and `IntegrationStage`, which installs the fixtures. No suite imports it.

Every contract is deployed from its artifact. The production ones come from `src/`, which Forge rebuilds on every run, even a filtered one, so a changed or mutated source always reaches the suites. The helpers come from `IntegrationArtifacts.sol`, which CI's Contracts (v2) job builds, with the ten V2 contracts, before any suite (`.github/workflows/ci.yml`).

## Running

From a checkout after `npm ci` (Node 24, the pinned Forge 1.7.1 and the offline solc 0.8.26 wrapper), build the artifacts once, then run each suite on its own:

```sh
cd contracts && node ../scripts/test-contracts.mjs build \
  src/v2/registry/DominoRegistry.sol src/v2/anchor/DominoPriceAnchor.sol \
  src/v2/autoexit/DominoAutoExit.sol src/v2/vault/DominoV2VaultSwapModule.sol \
  src/v2/vault/DominoV2VaultV3.sol src/v2/vault/DominoV2VaultV4.sol src/v2/vault/DominoV2VaultFactory.sol \
  src/v2/zap/DominoZapV3.sol src/v2/zap/DominoZapV4.sol src/v2/zap/DominoZapV4Steps.sol \
  test/v2/integration/IntegrationArtifacts.sol && cd ..
node scripts/test-contracts.mjs --match-path test/v2/integration/GovernancePrice.t.sol
node scripts/test-contracts.mjs --match-path test/v2/integration/ZapV3Integration.t.sol
node scripts/test-contracts.mjs --match-path test/v2/integration/ZapV4Integration.t.sol
node scripts/test-contracts.mjs --match-path test/v2/integration/VaultV3Integration.t.sol
node scripts/test-contracts.mjs --match-path test/v2/integration/VaultV4Integration.t.sol
node scripts/test-contracts.mjs --match-path test/v2/integration/AutoExitV3Integration.t.sol
node scripts/test-contracts.mjs --match-path test/v2/integration/AutoExitV4Integration.t.sol
```

Without the build, `vm.getCode` reports the missing artifact by name. Rebuild after changing a helper; the V2 sources rebuild themselves. Add `-vv` for the labelled gas figures below.

## Journey × DEX

Every row runs on both DEXes unless a cell says otherwise; the v3 and v4 suites share one journey contract each. **71 tests:** governance 6, zap 7 + 7, vault 15 + 14, auto-exit 11 + 11.

| Journey | What it proves | v3 | v4 |
| --- | --- | --- | --- |
| **Governance and price** (`GovernancePrice`) | Timelock boundaries for every role, router and currency; the wiring of the anchor; spot reads through the factory-created v3 pool and the deployed StateView | ✓ | ✓ (StateView) |
| | Signed observations, revocation by hash, the observation epoch, a removed publisher; a timelocked publisher reaches the anchor | ✓ | ✓ |
| | TWAP from real cardinality growth, elapsed time and swaps; a same-block spot does not move it | ✓ | n/a (v3 only) |
| | A second anchor on a registry without the publisher refuses its evidence (unit-level control) | ✓ | ✓ |
| **Zap, S1** (`ZapJourney`) | Permit2-witnessed create through the deployed router, submitted by a relayer; increase through a pool; relayed change of range; relayed exit converting into the rank-1 currency. 65 bps once, on the ranked input or the measured ranked output. Every `Refunded` receipt names the owner, the owner's balances move by exactly its refunds less its inputs, the relayer's by nothing | ✓ | ✓ |
| | A relayed exit replayed on the still-live position: `NonceUsed`, nothing removed; a nonce the owner voided first: `NonceUsed` | ✓ | ✓ |
| | A deferred tariff is never added to a position nor refunded by the owner's later increase and converting exit; one flush pays all three exactly | ✓ | ✓ |
| | A token callback meets the shared lock (`ReentrantCall`); a failing hostile token rolls back every input (`TokenCallFailed`) | ✓ | ✓ |
| | Fee currency by rank: a rank-2 output (the input is refused, `FeeMismatch`); a rank-1 hop between two legs; after a timelocked delisting, the first leg's input | ✓ | ✓ |
| | The guardian's router removal refuses router legs (`InvalidPlan`); the timelocked re-admission serves them | ✓ | ✓ |
| **Vault, F3** (`VaultJourney`) | CREATE2 clone at the predicted address, EIP-1167 code to its implementation, wiring equal to this world's components, the executor at the implementation's first CREATE with this build's code and wiring (another swap module is another executor) | ✓ | ✓ (+ subscription) |
| | Compound through the deployed router with a frozen recipient: the tariff is owed, the owner can neither recover nor withdraw it, anyone flushes it; `exitAll` | ✓ | ✓ |
| | Compound through a deep pool: 2% of the consumed fees delivered once | ✓ | ✓ |
| | A swap through the vault's own pool | fees stay owed in the position | fees collected again before the add |
| | An anchor 3% from the spot either way: `SpotOutsideBand`, nothing changes; 1.9%: executes | ✓ | ✓ |
| | An anchor 1.5% above the spot (inside the band): a minimum the spot would justify is under the anchor's floor (`InvalidRoute`) | ✓ | ✓ |
| | An anchor at the edge of a 0.5% band: the vault's own swap moves its pool and the second anchor read refuses (`SpotOutsideBand`); the same swap through the deep pool passes | ✓ | ✓ |
| | Domino successor, 4% once, linked and held by the clone; `exitAll` delivers it | ✓ | ✓ |
| | Inverse geometry (quote is currency0): the successor goes below the root in ticks; an anchor outside the trigger distance refuses a mint the spot would allow; the currency1-quoted side is refused | ✓ | ✓ |
| | The owner's own change disarms; a transfer unsubscribes (v4) or fails the checkpoint (v3); rearm | ✓ | ✓ |
| | `exitAll` holds the lock: a token callback's `flushOwedFees` meets `ReentrantCall` and the reserve is paid | ✓ | ✓ |
| | `returnReserves`: refused while the root is open; once the owner closes it on Uniswap, a stranger's call pays the owner exactly every reserve and the stranger nothing; a second call changes nothing | ✓ | ✓ |
| | TWAP evidence: the pool's own history anchors a compound; windows outside [60 s, the owner's age] and a same-block move of the spot are refused | ✓ | refused (`TwapUnavailable`) |
| | A timelocked operator and publisher reach the vault; the guardian's removal refuses the operator | ✓ | ✓ |
| | A stranger's dust allows one operator rearm; the owner's own decrease does not | ✓ | n/a (v3 only) |
| **Auto-exit, F4** (`AutoExitJourney`) | Upper trigger, conversion into the rank-1 currency: one 20 bps tariff on the converted gross output, exact delivery, above the anchor's floor, one shot | ✓ | ✓ |
| | Falling price across the lower trigger (refused before it); both currencies delivered, the tariff led by the rank-1 currency1 | ✓ | ✓ |
| | A conversion through the thin pool below the anchor's floor: `BelowMinimum`, nothing moves; through the deep pool it executes | ✓ | ✓ |
| | Conversion into the unlisted currency: 20 bps of each withdrawn currency, before the conversion | ✓ | ✓ |
| | Receive both on the inverse pool: the tariff is led by currency0 | ✓ | ✓ |
| | TWAP: the pool's history crosses the trigger; a window under the module's floor is refused | ✓ | refused (`TwapUnavailable`) |
| | Two owner consents, operator only, revocation, the global halt | ✓ | ✓ |
| | A spot manipulated within the block does not trigger an uncrossed signed anchor | ✓ | ✓ |
| | A hostile currency: its failing transfer reverts everything; its callback meets the lock; a refused tariff stays backed until flushed | ✓ | ✓ |
| | A frozen owner's delivery becomes an exact claim that cannot spend the debt | ✓ | ✓ |
| | **Miswiring:** a vault built for another real auto-exit module refuses the owner's module (`Unauthorized`) and the mandate cannot run on either | ✓ | ✓ |

**After every action** the zap and the module hold only backed debt and deferred deliveries; the vault's balance in each currency is its reserves plus its debt, and it holds nothing else. None of them leaves a native balance, a token allowance or a Permit2 router allowance. Failed owner attempts, flushes, callbacks and `exitAll` are each followed by the same checks.

## Wiring is checked, not assumed

- **Journey level.** `testVaultWiredToAnotherAutoExitCannotRunTheMandate` builds a second real `DominoAutoExit` and a vault implementation for it. The owner's mandate on the right module never runs: the vault refuses that module (`Unauthorized`); once its own is enabled the right one meets `ExitModuleNotEnabled`, and the wired one has no mandate (`MandateNotActive`).
- **Every vault.** `_openVault` checks the clone's code, its wiring against this world's addresses (not against its own implementation) and its executor's address. `testCloneAndConstructorCreatedExecutorCarryThisWorldsWiring` compares the executor's code with a fresh build of the same artifact and wiring.
- **Mutation.** W1-W3 below miswire the vault's auto-exit, price anchor and swap module in the production constructor.

## Mutation record

`contracts/mutations/v2-integration-2026-10-02.json` deletes or weakens, one at a time in the production source, each guard or wiring these journeys claim to pin, and runs the v3 and the v4 suite that claims it:

```sh
node scripts/mutate-contracts.mjs contracts/mutations/v2-integration-2026-10-02.json --with-artifacts
```

The sandbox gets this checkout's `contracts/out` and `contracts/cache`, so the integration artifacts must be built and the suites run first. A guard counts as covered only when its deletion fails a test.

**Result: 58 runs, 58 caught**, none expected to survive. The final run used the committed sources (`--head`); every baseline passed first.

| ID | Mutation in the production source | Review of #303 | Failing tests, v3 / v4 |
| --- | --- | --- | ---: |
| V1 | the vault's anchor band widened to 9999 bps | survived | 2 / 1 |
| V2 | the vault decides on the spot, not the anchor | survived | 2 / 2 |
| V3 | the re-anchor after the vault's swap dropped | survived | 1 / 1 |
| V4 | `exitAll` without its lock | survived | 1 / 1 |
| V5 | the fee recipient dropped: every tariff deferred | caught by 1 of 6 | 6 / 5 |
| V6 | the v4 collection after the vault's own swap dropped | new | v4 only: 1 |
| V7 | the vault's swap floor not enforced | new | 1 / 1 |
| V8 | the inverse geometry never set | new | 1 / 1 |
| V9 | `returnReserves` pays whoever calls | new | 1 / 1 |
| V10 | the anchor's band check dropped | new | 3 / 2 |
| V11 | `returnReserves` while the root is open | new | 1 / 1 |
| W1 | the vault's auto-exit wired to its swap module | caught (in the tests) | 11 / 11, all |
| W2 | the vault's price anchor wired to the registry | new | 15 / 14, all |
| W3 | the vault's swap module wired to its auto-exit | new | 15 / 14, all |
| Z1 | the leftover refund skipped | caught | 5 / 5 |
| Z2b | the leftovers paid to the relayer | survived | 1 / 1 |
| Z3 | the relay nonce not enforced | survived | 1 / 1 |
| Z4 | owed fees refunded with the leftovers | new | 1 / 1 |
| Z5 | owed fees added to the position | new | 1 / 1 |
| F1 | the fallback tariff charged in the last output | new | 1 / 1 |
| F2 | route hops not considered for the tariff currency | new | 1 / 1 |
| A1 | the upper trigger's comparison flipped | caught | 8 / 7 |
| A2 | the lower trigger never fires | survived | 1 / 1 |
| A3 | the trigger reads the spot, not the anchor | caught | 1 / 1 |
| A4 | the conversion floor dropped | survived | 1 / 1 |
| A5 | the receive-both tariff always led by currency1 | new | 1 / 1 |
| A6 | an unlisted conversion target treated as listed | new | 1 / 1 |
| A7 | a disabled upper trigger counts as crossed | new | 1 / 1 |
| T1 | the anchor's TWAP window bounds dropped | new | v3 only: 1 |
| T2 | the module's TWAP window floor dropped | new | 1 / 1 |

V6 runs on v4 only: v3 never settles fees into an increase, so the deleted branch never ran there. T1 runs on v3 only: v4 has no TWAP.

**Placement.** The review's Z2b (`_refund(tokens, msg.sender)` at its call site in `_act`) and a `selfBalance` read for Z5 do not compile: they overflow the via-IR stack (`Variable var_owner is 1 too deep`), and a mutant that does not build proves nothing. The record puts them where they compile: Z2b sends each refund to `msg.sender` inside `_refund` (its receipt still names the owner), Z5 adds the owed amount back to what `_available` may spend. The review's W1 was a test-side change; the same change made here, the journeys' vault stack wired to a second real `DominoAutoExit`, fails 10 of the 11 auto-exit journeys on each DEX with `Unauthorized` (the eleventh builds its own stacks). W1 above is its production-side counterpart.

**No `forge build --force` per mutant.** Every mutant is under `src/`, which Forge recompiles whenever it changed, on every filtered run, and the suites deploy those artifacts. The wiring mutants failing every test of their suites show that the rebuilt bytecode reaches them.

## Gas per journey

Labelled `gasleft()` deltas around the measured call (`-vv`), on the deployed DEX and router bytecode and the production artifacts. They include the adjacent prank, exclude intrinsic and calldata gas, and are regression evidence, not a fee projection (#301 measures transactions). Setup (mandate registration, market-moving swaps, approvals) is outside the deltas.

| Measured call | v3 gas | v4 gas |
| --- | ---: | ---: |
| Signed anchor read | 28,044 | 25,276 |
| Create, deployed router, Permit2 witness (relayed) | 865,630 | 707,836 |
| Increase, direct pool | 301,997 | 252,662 |
| Relayed change of range, direct pool | 734,073 | 503,827 |
| Relayed exit with conversion | 296,790 | 250,717 |
| Auto-compound, deployed router | 691,173 | 648,227 |
| Auto-compound, direct pool | 622,492 | 566,825 |
| Domino successor | 877,077 | 633,887 |
| Owner `exitAll` | 33,607 | 33,613 |
| Signed-mandate auto-exit with full conversion | 462,821 | 390,963 |

Measured again on 4 Oct 2026, after #317 and the adversarial suite's fixes. Each exact payment and refund now reads the token balance before and after (F-04), and so does each v3 hop (F-03). `exitAll` reads the exit module to disable it, a cold slot (2,146 gas). The signed anchor reads, the Domino successor and the registry are unchanged. A registry schedule plus execute is 169,858 gas (one registry, either DEX). The CI gas baseline (`contracts/.gas-snapshot`, `node scripts/gas-baseline.mjs --check --part v2`) pins every test's total.

## CI budget

Measured on 2 October 2026 on an Apple M3 Pro (Node 24.19, the pinned Forge 1.7.1, offline solc 0.8.26), replaying the Contracts (v2) job's own steps from `ci.yml`: prune, the build step, every `contracts/test/v2` suite in `find | sort` order through `test-contracts.mjs`, the V2 export check, the gas-baseline tests and `--check --part v2`, record. Cold starts from an empty `contracts/cache` and `contracts/out`; warm reuses what the cold run left.

| v2 half, locally | Build step | Suites | Export, gas | Total |
| --- | ---: | ---: | ---: | ---: |
| This change, cold | 97 s | 1,510 s (47) | 110 s | **28m37s** |
| This change, warm | 1 s | 97 s (47) | 84 s | **3m02s** |
| This change, cold, run beside main's | 96 s | 1,596 s (47) | 67 s | 29m19s |
| main `d6b1e90`, cold, run beside this one | none | 1,534 s (40) | 58 s | 26m32s |

**What the journeys add, cold:** 2m47s against main under the same load. Directly:
- the seven suites: 133 s, of which 115 s compiling: governance 10.5 s, zap 13.2 and 12.9 s, vault 23.5 and 21.5 s, auto-exit 14.0 and 19.3 s;
- the build step: about 30 s of its own. It compiles the V2 contracts that the first suite compiled before (`DominoV2External.t.sol` fell from 117 s to 52 s); the rest is `IntegrationArtifacts.sol` and its fixture closure.

**On CI**, runners take 1.6 to 2 times this Mac's time: main's near-cold v2 half took 42m52s on run 37066559693 against 26m32s here, and #296 measured 2.0-2.1. A cold v2 half with these journeys therefore needs about 46-57 minutes against its 75-minute limit, with these journeys adding about 5 minutes. The first version added 24m42s on a warm run (37021480059). A change to the journeys alone recompiles only their seven files (and the artifacts file when it changes): about 2.5 minutes here, 4-5 on CI.

**The audit suites (4 Oct 2026).** With the 19 suites of `contracts/test/v2/adversarial` and `invariant` (#319), the v2 half's 67 suites took 71.1 minutes cold on CI (run 37173015030), 61.0 of them compiling. Then the gas check met the 75-minute limit and the job was cancelled. The audit suites took 32.0 of those minutes and the other 48 suites 39.1. They now run as a third part, `Contracts (v2-audit)`, with its own cache. Each V2 part builds the deployables and the integration artifacts and checks the gas entries its own suites declare.

## Scope and exclusions

- The pairs are ERC-20 test currencies. Native/WETH positions, hooked pools, EIP-1271 and EIP-7702 signatures and the nonstandard-token matrix stay in the component suites; these journeys add frozen accounts and reentering callbacks.
- Live forks, market depth, network gas prices and profitability belong to #301. The keeper, the publisher service, the backend and the browser are not part of these offline contract journeys.
- Only `contracts/test/v2/integration/`, this document, the mutation record, the gas baseline and the CI step changed; no production source or release pin.

## Findings

No production contract bug was found. Every journey passes on the production bytecode, and every mutant in the record is caught. A failure here would be reported with its test in a separate fix, never hidden by replacing a production component with a double.
