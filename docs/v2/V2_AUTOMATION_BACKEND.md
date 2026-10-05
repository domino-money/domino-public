# Domino V2 — automation backend (item 3a)

Workstream item 3a of domino-money/domino#283: the automation side of the V2 backend, on F6's multi-chain foundation ([F6_BACKEND.md](F6_BACKEND.md)). It plans compounds for the F3 vaults ([F3_VAULT.md](F3_VAULT.md)), signs the price observations their anchors check ([F1_REGISTRY_ANCHOR.md](F1_REGISTRY_ANCHOR.md)), executes them as the registry's operator, and executes the owners' auto-exit mandates ([F4_AUTO_EXIT.md](F4_AUTO_EXIT.md)), one process per chain. The indexer and read API (item 3b), the deployment tooling (#301) and the Forge integration suites (#300) are separate fronts; what they must agree on with this one is at the end.

V1's automation keeps running on Robinhood, unchanged, until V2 replaces it: this front adds new modules only and touches no V1 module, migration, installer or contract.

## The slice and why

Everything an operator needs to run V2 automation end to end on a chain, on the real contracts:

| Piece | Module | Why it is in this slice |
| --- | --- | --- |
| Plan encoding | `backend/v2_plan.py` | The vault accepts nothing else; reproduces F3's golden vector byte for byte. |
| Compound planner | `backend/v2_planner.py` | The decision and the plan: pure, deterministic, integer-exact against the vault's own arithmetic. |
| Observation signer and publisher | `backend/v2_observation.py` | A v4 vault cannot execute without a signed anchor. |
| Executor and nonce journal | `backend/v2_executor.py` | Presimulation, gas caps per chain, V1's journal design, submission, reconciliation. |
| Auto-exit | `backend/v2_autoexit.py` | Watching mandates and firing them only on the anchor. |
| Vault, pool and price reads | `backend/v2_vaults.py` | Discovery, proofs that a vault is the deployment's, the v3 TWAP, fee growth, USD-free prices, the L1 fee. |
| Deployment manifest | `backend/v2_manifest.py` | #301's manifest (PR #302's schema and validator, rule for rule), bound to the chain profile and admitted only as a finalized public deployment. |
| Service and command line | `backend/v2_automation.py` | The pass, the configuration and the commands. |
| RPC credentials | `backend/v2_rpc.py` (additive) | Hosted RPC keys sealed as systemd credentials, like every other secret. |
| Events | `backend/v2_abi.py` (additive) | Receipts and logs decoded from the frozen exports. |

Domino-compound successors (MINT) and a few other parts are left for later; see [What remains](#what-remains).

## The pass

One process serves one chain with one operator key and one publisher key (`python backend/v2_automation.py --config <file> serve`). Each pass, at a head the chain's shared follower pinned ([v2_head](F6_BACKEND.md)):

1. **Deployment.** The manifest's runtime code hashes are proven at the head and its verification block is still canonical, once per process (the chain's code cache).
2. **Journal.** Every unresolved transaction is reconciled first. While one is unresolved, or an `attention` waits for an operator, nothing new is claimed: the pass still plans and reports, and sends nothing.
3. **Signer.** The operator key has no code on it (an EIP-7702 delegation was never admitted), the registry admits it as operator and not as publisher, and its balance is above the floor. If not, the pass still plans and reports (`signer`), and sends nothing.
4. **Auto-exits first** (a stop-loss is time-sensitive): every active mandate whose anchor crossed a trigger is presimulated and sent.
5. **Returns.** A vault whose owner closed the root outside the vault, with no active successor and reserves left, gets one `returnReserves()`, which pays the owner alone ([below](#returning-a-closed-vaults-reserves)); the first such vault in discovery order goes before any compound.
6. **Compounds.** Every factory vault is read and planned; the one with the greatest net owner outcome that clears every gate with its presimulated gas is sent.

At most one transaction leaves per pass, in that order: the journal holds one unresolved intent per signer.

The report is one JSON object per pass: each vault's decision and the reason of every candidate it weighed, each mandate's state, what was reconciled and what was submitted. Reasons are fixed codes (`too_soon`, `gas_not_covered`, `owner_benefit_insufficient`, `trigger_not_reached`, `v2_observation_unstable`, `reverted_spot_outside_band`, …); no key, password, keyed URL or provider message reaches it.

**Discovery.** A vault is a factory's `VaultCreated` log, read from that factory's deployment block (the manifest's receipt) and then incrementally. An event only proposes a vault. Before it is read, the head proves it: the factory's `isVault`, its code is the EIP-1167 clone of the manifest's implementation for its DEX, and the implementation's wiring (`factory`, `registry`, `priceAnchor`, the chain's position manager, `vaultSwap`, `autoExit`) is the manifest's. A vault outside the factories is never served (F4: "service factory vaults only").

**Billed calls** (the owner's 2 Oct decision for hosted RPC). A vault the contract would refuse right now (paused, halted, inside its interval) costs only its state read. The reference prices and the anchor's TWAP floor are read once per pass. The owner gate's history reads happen only for members whose candidates already clear everything else, once per pool and range per pass.

## Returning a closed vault's reserves

**Why.** On 2 Oct 2026 a V1 owner closed an automated position on Uniswap itself: liquidity 0, the NFT kept in the wallet. The vault, its subscriber, only disarmed, and the fees the automation had collected and not reinvested (38.36 USDG and 27.10 UFG) stayed in its ledger, withdrawable only by the owner through a function no screen calls; a survey of the five V1 vaults found about 220 USDG waiting the same way. V2 keeps the same custody, so the vault gained a permissionless `returnReserves()` (F3, [F3_VAULT.md](F3_VAULT.md), "Owner surface"): once the root is closed (read live) and no successor is active, anyone can make the vault pay every reserve to its owner, for no fee; a token the owner cannot receive stays idle (A8). The automation calls it, so the owner gets the money back without doing anything.

**Which vaults.** Each pass reads every factory vault as before. The reader (`v2_vaults.VaultReader`) now reads a root the owner burned (v4: no position info; v3: the manager's refusal of the token) as a closed root, where it used to fail the whole read. A vault qualifies (`v2_planner.returnable`) when its root has no liquidity and the root is its only active member; only then are its two `reserves(token)` read (two billed calls, for closed vaults alone). With nothing left, the vault is reported as before (`root_disarmed`), and it is not read again until its state nonce moves: every change to a vault's reserves advances it, so an emptied vault costs nothing more.

**The call.** `returnReserves()` is presimulated from the operator at the pinned head like any other call (`eth_call` with its result, then `eth_estimateGas`): the contract's own closure check is the authority, and a refusal is recorded as `reverted_root_open` or `reverted_successor_active`. The result is what the call would pay: when it pays nothing (every reserve is in a token the owner cannot receive, which would stay idle), nothing is sent and the vault waits as `reserves_unpayable`. Otherwise it is submitted with kind `return`, to a vault one of the deployment's factories created, under the executor's caps (gas, fee, cost per transaction, the daily `dailyCapWei`, and the per-vault ceiling when one is set), journaled, signed, sent and reconciled like a compound; a lost transaction is re-sent as the same bytes after it presimulates again. Its calldata is the same on every pass, so its journal subject is `keccak256(abi.encode(chainId, vault, stateNonce, block))` (`v2_plan.return_subject`), and an intent's id now covers its subject: each pass's return is its own intent, and the presimulation decides whether one is due.

**Order and gates.** The owner's own money goes first: the first qualifying vault, oldest first, before any compound (exits still go before everything). There is no economic gate: the operator pays the gas and charges nothing, as owner withdrawals are never charged. Each closed vault costs one return (77,583 gas on the EVM test's chain), and its reserves exist only because an earlier compound paid its tariff. A vault's pause does not hold a return back (`exitAll` pauses, and its leftovers are exactly what a return retries); the registry's global halt does, as it holds every action of the operator's, even though the contract does not read it (the owner, or anyone, can still call it).

**Waiting reasons.** `reserves_returnable` (the return is due; it is sent this pass unless an exit or another vault's return went first) and `reserves_unpayable` (the presimulation pays nothing). A keyless `plan` reports `eligible_keyless`, with `action: return_reserves`.

## The plan (`v2_plan`)

`execute(bytes plan)` takes `0x01 ‖ abi.encode(PlanV1)` with the type of F3 ("The execution plan (version 1)"); `PlanV1.encode()` reproduces `DominoV2VaultPlan.t.sol`'s golden (1,313 bytes, keccak `0x890394e7…aabdaff6`) and `decode_plan` accepts canonical bytes only. `plan_hash(chainId, vault, plan)` is the vault's own hash, emitted in `Executed` and used as `FeeCharged`'s `ref`. The auto-exit's `Execution` is encoded through the frozen `IDominoAutoExit` export. Anchor evidence is `abi.encode(uint32 secondsAgo)` for a v3 TWAP (exactly 32 bytes) or `abi.encode(PriceObservation, bytes signature)`.

## The planner (`v2_planner`)

Pure: it takes what the service read at one block and returns a decision and a plan. Nothing in it reads a chain, signs, or looks at a clock.

**The vault's arithmetic, reproduced exactly:**
- the tariff (200 bps simple, 400 bps Domino) is cut once per source and token from the uncharged gross consumed, rounded down (`DominoV2VaultMath.netOf` / `grossFor`); charged units, a swap's output, are spent first and never charged again (`Budgeted` mirrors `_capacity` and `_spend`);
- the add is amount-driven: the budgets' capacities, liquidity sized as `LiquidityAmounts` does at the price, and a floor `minLiquidity` 1% below it (A2: no zero-width window);
- the swap floor is `DominoSwapFloor.minimumOutput` at the anchor, less the pool's whole fee for the direction (v4: protocol plus LP fee), less the owner's `maxSlippageBps` (the #3409682 fix). The planner's own minimum is the simulated output less 0.5%, never below that floor.

**Sizing the swap (A5).** The vault refuses a plan whose swap output is not spent by the add (at most 1/100 may stay). The planner sizes the swap as the largest amount after which the output token is still the scarce side of the add, even if the add's price has moved against it by `swapPriceToleranceBps` (20 bps of the sqrt price): the add then spends all of the output, and what waits is input. The narrower the range, the more a price move changes the ratio it takes, and the more input waits for a later compound (about 7% of the fees on a ±6% range, under 1% on a full range). The budget of the swap's source leaves room for twice the simulated output in its output token, so a better fill than simulated is still spent.

**The quote seam.** The swap's output and leg come from one call, `quote(chain, pool, tokenIn, amountIn) -> SwapQuote(amountOut, leg, sqrtPriceAfter)`. The default, `PoolQuoter`, prices one direct v4 or v3 leg through the vault's own pool in its active range, from the state read at the planning block (`SwapMath.computeSwapStep`). Item 3c's `backend/v2_quotes.py` (on-chain QuoterV2/V4Quoter quotes, Universal Router 2.1.2 legs) can replace it through `decide(quoter=…)` or the service's `quoter_factory`, with no other change: the planner still sets every minimum and checks the floor and the leg's tokens.

**Routing.** A COMPOUND of a member is funded by its own fees (rule 1) and, in Domino mode, by members the anchor has left when the target is in range (rule 3). A disarmed root funds nothing, since collecting it would revert.

Candidates are a direct compound and balancing swaps of the whole or half of the excess; a swap below 10% of the fees in play is not considered. Among the candidates that clear both gates below, the greatest net owner outcome wins; there is no fixed idle reserve.

## When a compound runs: the economic criterion

The owner's decision of 2 Oct 2026: the cadence is economic, "balanced for the user and the platform; we must earn fees too", above a 10-minute floor (a new vault's `minimumIntervalSeconds` defaults to 600 s, which the vault enforces). A compound runs at the first pass where **both** hold, and waits otherwise (REINVESTMENT_POLICY.md's two independent gates):

1. **The platform does not lose money (execution sustainability).** Domino's fee from this execution covers the gas the operator pays, with a margin:

   ```
   tariff ≥ gas × (1 + m)   and   tariff − gas ≥ P
   tariff = Σ_tokens floor(r × gross consumed) × wei per unit          r = 2% Auto-compound, 4% Domino-compound
   gas    = units × (base fee + tip) + L1 data fee (OP Stack only)
   ```

   `m` is `planner.gasBufferBps` (the approved 15%) and `P` is `planner.platformMinProfitWei` (0 by default), both per chain. The units are a prior (`gasUnitsCompound` 450,000, `gasUnitsSwap` +170,000) until the presimulation measures the exact call; the gate is checked again with that estimate before anything is signed (V1 priced gas at about twice its real cost, #282). The smallest fee amount that may be reinvested is therefore `V_min = max(gas × (1 + m), gas + P) / r`.

2. **The owner gains, and as early as possible (owner benefit).** The added liquidity's incremental fees over a bounded horizon, after a haircut, cover what the owner pays for the compound:

   ```
   earnings_H × (1 − h) ≥ (tariff + swap cost) × (1 + o)
   earnings_H = rate × ΔL × (A − L) / (A + ΔL) × H
   ```

   `rate` is the pool's fee growth per unit of liquidity inside the target's range over the evidence window (`earningsWindowSeconds`; the time-weighted mean, V1's #254 lesson, never the quietest interval); `A` the pool's active liquidity, `L` the target's, `ΔL` what the compound adds: the same fee flow shared by more liquidity, so a position that is all the active liquidity, or out of range, earns nothing more by growing. `H` is `planner.ownerHorizonSeconds` (7 days, V1's), `h` `forecastHaircutBps` (20%), `o` `ownerMarginBps` (0), the swap cost the pool fee and impact valued at the anchor. Missing evidence never justifies an action.

**Why this is the right timing.** The owner pays only proportional costs (the tariff and the swap's pool fee), so for the owner a compound is better sooner than later once it pays back within the horizon: waiting only leaves fees idle. The one fixed cost, the gas, is the platform's, and gate 1 is exactly the earliest moment it is covered with the margin. So a vault compounds at the first pass after its fees reach `V_min` (and at least `minimumIntervalSeconds` after its last execution), as long as its range earns enough for gate 2: it neither fires before the platform is paid nor waits once both gain. Gate 2 does not depend on the amount (both sides scale with the fees), so in a pool whose range earns too little for the horizon, more waiting never unlocks it, as in V1.

**Worked examples, gate 1** (the smallest fees a compound reinvests). Illustrative inputs, ETH at US$2,700; the service reads the base fee and the L1 fee at each pass and measures the units by presimulation, and a Nitro chain counts the L1 data in the units:

| Chain | Units | Base fee + tip | L1 fee | Gas | `V_min`, Auto-compound (2%) | `V_min`, Domino-compound (4%) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Robinhood (Nitro) | 600,000 | 0.0518 gwei (V1's funding-study median) | in the units | 0.0000311 ETH (US$0.084) | US$4.83 | US$2.41 |
| Base (OP Stack) | 415,000 (measured, EVM test) | 0.005 gwei | 0.000002 ETH | 0.0000041 ETH (US$0.011) | US$0.63 | US$0.32 |
| Arbitrum One (Nitro) | 515,000 | 0.01 gwei | in the units | 0.0000052 ETH (US$0.014) | US$0.80 | US$0.40 |

With `platformMinProfitWei` set, `V_min` is at least `(gas + P) / r`: for example, P = US$0.05 on Base gives US$3.05 at 2%.

**Worked examples, gate 2** (the position's in-range fee yield the horizon needs, a direct compound by a small share of the pool, `h` = 20%): `yield over H ≥ r / (1 − r) / (1 − h)`.

| Horizon `H` | Auto-compound (2%) | Domino-compound (4%) |
| --- | ---: | ---: |
| 7 days (default) | 2.55% in 7 days (133% a year) | 5.21% in 7 days (272% a year) |
| 30 days | 31% a year | 63% a year |
| 90 days | 10.3% a year | 21% a year |
| 365 days | 2.6% a year | 5.2% a year |

These are the yields of the position's own range while in range: a concentrated range earns many times the pool's full-range rate (a ±6% range about 30 times), which is why V1's narrow positions passed a 7-day horizon on busy pools. The horizon is the one number that most changes how often a quiet pool compounds; it is configuration, per chain.

**Gas budget.** As in V1, the ceiling is a daily budget per chain: `gas.dailyCapWei`, a rolling 24 hours of what was paid, else reserved (V1's US$20 a day, now per chain and in native wei). An optional per-vault ceiling per execution (`vaultGasCeilingWei`, with per-vault overrides) remains available, unset by default.

## Signed observations (`v2_observation`)

- **Typed data from the export.** `api-contracts/v2/eip712.json` gives `PoolRef` and `PriceObservation`; the domain is `Domino` / `2` / the chain id / the chain's `priceAnchor` from the manifest. The digest equals the F0 golden, a second implementation with eth_abi alone, and the deployed anchor's own `hashObservation` (EVM test).
- **Signatures.** 65 bytes `r ‖ s ‖ v`, low s, v 27 or 28: what `DominoPriceAnchor._recover` accepts. With the anchor suite's public test key the signature is the one `DominoPriceAnchor.t.sol` pins.
- **What is signed.** The pool's spot at the block the head follower pinned, with `observedAt` = that block's timestamp (never a wall clock ahead of the chain), `validUntil` = `observedAt` + min(120 s, the consumer's maximum: the vault's `maxObservationAgeSeconds`, the auto-exit's 300 s), and `nonce` = the block number.
- **Stability.** Before signing, the spot must be within 50 bps of the pool's spot 12 s and 60 s earlier (blocks counted with the profile's block time, read through the history client). A price pushed for one block is not attested: a manipulator must hold it across the window, exposed to arbitrage. The anchor then bounds the execution's spot against the signed price, and the floors use it. The look-back's blocks must be within an endpoint's state: 30 blocks on Base and 600 on Robinhood are, but 240 on Arbitrum need an archive endpoint (a hosted full node keeps 128), as does the owner gate's window anywhere beyond the own node's 15,000 Robinhood blocks.
- **v3** uses the pool's TWAP through the anchor itself (`twapSqrtPrice`), with a window within the anchor's `minTwapSeconds` (60) and the vault's `maxObservationAgeSeconds`; the floor is taken at an anchor 10 bps worse, since a TWAP keeps moving until inclusion.

## The executor (`v2_executor`)

**It never signs bytes it was handed as a transaction.** It is given a kind (`compound`, `exit` or `return`), a target among the deployment's (a vault its factories created, or the auto-exit module) and calldata the planners built:
1. **Presimulation.** `eth_call` of the exact call from the operator at the pinned head (EIP-1898, by hash), then `eth_estimateGas`. A revert is refused with the contract's error name as a code (`reverted_stale_nonce`, `reverted_spot_outside_band`, …, from the exports and `CONTRACT_ERRORS`, each checked against the Solidity sources), never the node's message (#249's lesson).
2. **Gas policy, per chain, in native wei.** Gas limit = the estimate plus 20%, at most `maxGas`; `maxFeePerGas` = min(cap, 2 × base fee + tip), refused when the cap is below what is includable now; cost per transaction at most `maxCostWei`; a rolling 24-hour cap `dailyCapWei` counting what was paid, else what is reserved (V1's US$20 a day, now per chain and USD-free); a balance floor.
3. **Journal** (V1's design, [DURABLE_EXECUTOR.md](../DURABLE_EXECUTOR.md)): a nonce is claimed as max(the journal's next nonce, the chain's pending and latest counts); the envelope is recorded before signing and the signed bytes before anything is sent; one unresolved transaction per signer, so a new nonce is never claimed behind an ambiguous one. An intent is one (chain, kind, target, calldata, subject): a compound's subject is its plan hash and an exit's its mandate hash, both bound to their calldata already; a return's names its pass.
4. **Send**: `submitted` when the node returns our hash, `broadcast_ambiguous` otherwise.
5. **Reconcile**: every attempt's receipt is checked (a replacement or the original can win) and its inclusion verified field by field (hash, from, to, nonce, calldata, canonical block). It is final after `confirmations` blocks: `confirmed`, or `reverted` (its nonce spent). The receipt's logs are kept as the effect: `Executed`, `Compounded`, `FeeCharged`, `MandateExecuted`, …
   - A transaction the node lost is sent again as **the same bytes**, after the call presimulates again; until then it waits (`revalidation_pending`). Past its deadline it is sent anyway: it can only revert and spend its nonce (8a6e505).
   - A transaction pending for `replaceAfterSeconds` is replaced with the same nonce, calldata and gas at fees 12.5% higher, at most twice, inside the caps.
   - A nonce the chain spent without one of our receipts stops the signer (`attention`) until an operator looks and acknowledges it (`acknowledge --intent`).
   - A claim that crashed before signing is signed again from its recorded envelope: RFC 6979 gives the same bytes.

The journal is a SQLite file per chain and signer (`journalFile`, in the unit's own 0700 state directory; WAL, `synchronous=FULL`): one process owns a signer's nonces on a chain, and each claim and state change is one transaction. It holds public chain data and transactions that are broadcast anyway, never a key. Use one operator key for V2 that V1's executor never uses: two journals on one key would race for its nonces.

The log scans keep their place beside the journal, in `v2-scans-<chain>.json` (`v2_scan_state`). `VaultDiscovery` and `MandateWatcher` advance one read window at a time, and a window counts only once all its logs were accepted, so a pass that stops on its request budget keeps what it read.
- **What is saved:** after every scan, each scan's next block and what it found.
- **The next block saved** stays 64 blocks behind what was read, so a short reorganization is read again. Records are keyed, so a block read twice adds nothing.
- **The file is bound** to the chain, both factories and the auto-exit module. A file for anything else, or one that does not parse, is ignored.
- **Private:** the file must be 0600 in a 0700 directory, both owned by the unit, or the process refuses it. It is replaced atomically, and holds public chain data only.

Before this, every process scanned again from the deployment blocks. Once the chain outgrew one pass's budget, `status`, `plan` and `run-once` never finished a scan, and `serve` never got past its first pass. Deleting the file costs one rescan.

## Auto-exit (`v2_autoexit`)

- **Watch.** `MandateRegistered` logs of the module from its deployment block; each mandate's record (`mandateOf`) and status at the head; active, not past `validUntil`, the vault's exit module is the module and its owner is still the mandate's. A revoked, executed or expired mandate can never execute again and is not read on later passes.
- **Trigger.** The module's own comparison: fires at or below `triggerBelow`, or at or above a nonzero `triggerAbove`, on the **anchor**: a signed observation of the spot on v4 (after the stability check, valid at most the module's 300 s), the pool's TWAP over at least the module's `minTwapSeconds` (600 s) on v3. The spot alone never fires an exit: a price pushed in the last block is refused by the publisher (`v2_observation_unstable`, EVM test).
- **Execution.** For a conversion, one pool leg through the vault's own pool selling the other token for `convertTo`, `amountIn` 0 (the module fills in everything withdrawn) and a positive minimum under the module's fee-aware floor at the anchor. Removal minimums are the principal at the band's edges (`maxSlippageBps` around the anchor): the withdrawal meets them wherever the band lets the spot be, so the band, not a guess, bounds it.
- **Paused vaults exit.** The vault's `executeExit` ignores `paused` (F3), and so does the service: a vault created paused with the exit module enabled is protection without compounding, a supported product (owner decision, 2 Oct; EVM test). The registry's halt stops exits.
- **Default slippage.** A mandate's `maxSlippageBps` is the owner's; the app offers 1% on top of the pool's fee by default (`vaultDefaults.exitMaxSlippageBps`).
- The calldata goes through the executor like a compound: presimulated, capped, journaled.

## The deployment manifest (`v2_manifest`)

The manifest is #301's: PR #302's [`docs/v2/DEPLOYMENT.md`](DEPLOYMENT.md), its structural schema (`scripts/v2/deploy-manifest.schema.json`) and its semantic validator (`validateManifest` in `scripts/v2/deploy-schema.mjs`). `load_deployment(path, chain)` applies both, rule for rule, binds the manifest to the chain profile the service serves, then applies the backend's admission:

| Field | What the automation checks and uses |
| --- | --- |
| `schemaVersion`, `kind`, `status`, `environment` | `1`, `domino-v2-deployment`; `prepared` or `verified`; `public-chain-preparation`, `fork-rehearsal` or `local-test` (only a local test may name a chain other than 4663, 8453 and 42161). |
| `chain` | `name`, `chainId`, `nativeCurrency`: the profile's (for a local test, the chain id only). |
| `sourceCommit`, `releaseTag`, `build` | 40 hex characters; a tag; the pinned compiler profile (`0.8.26+commit.8a97fa7a`, 200 runs, via-IR, Cancun, no metadata hash), the per-file SHA-256 of the sources under `src/v2/` (or `deploy-fixtures/`), `sourceTreeSha256` (the SHA-256 of their canonical JSON), `workingTreeSourceChanges` and the profile's hash. |
| `contractNames`, `contracts` | F0's eleven components and the two vault executors (`vaultExecutor.v3`, `vaultExecutor.v4`), with their contract names. Each component is at the address CreateX's `deployCreate3` gives F0's salt for the deployer; each executor is its implementation's first CREATE. |
| `createx` | The canonical CreateX and its runtime hash; `salts` (F0's rule, `deployer ‖ 0x00 ‖ bytes11(keccak256("domino.v2.<component>"))`) and `guardedSalts` (CreateX's guard, `keccak256(abi.encode(deployer, salt))`) for the eleven components. |
| `dependencies` | The eleven the profile gives (`v3Factory`, `v3PositionManager`, `v3Quoter`, `v3SwapRouter`, `v4PoolManager`, `v4PositionManager`, `v4StateView`, `v4Quoter`, `universalRouter`, `permit2`, `wrappedNative`), at the profile's addresses; the profile's CreateX is the canonical one, with its verified code outside local tests. |
| `runtimeCodeHashes` | One per contract and dependency; outside local tests each dependency's is the profile's verified hash. |
| `roles` | `deployer`, `governance`, `guardian`, `feeRecipient`, `operator`, `publisher`: lower-case addresses, no placeholder (below 2^16, one digit repeated, `0x0…dead`), operator ≠ publisher, none a component or CreateX; in production none is a key of the public test mnemonic (Anvil's and Hardhat's ten accounts, PR #302's review, item 2). The service's keys must be the `operator` and the `publisher`. |
| `policies` | #302's constants exactly: tariffs 65, 35, 200, 400 and 20 bps on consumed fees once, a 24 h timelock, the anchor's 60 s TWAP, the exit's 300 s observation age and 600 s TWAP, Universal Router 2.1.2 or later, hooked pools refused. |
| `chargeCurrencies` | Two or more distinct `{token, rank}`; outside local tests the profile's, in its order. |
| `deploymentReceipts`, `verification` | Verified: one receipt per component (transaction hash, block number and hash, decimal gas used and gas price), all distinct, and the anchored verification (block number, hash and tag, `exact_precomputed_immutable_runtime`, `checked`, a time with its zone). Rules item 3b's loader had, which #302's validator applies too since its review: no receipt in the genesis block, no zero transaction or block hash, receipts in one block agree on its hash, and the verification is at or after every receipt and agrees with one in its block. Prepared: neither. A component's receipt block is where its log scan starts. |

Any other key, a missing one, or a value of another type refuses the whole manifest. A file is read as JavaScript reads JSON: one value per key, finite numbers, and an integral number is an integer.

**Admission.** DEPLOYMENT.md: "Backend production admission must additionally reject `local-test` and `fork-rehearsal`, unqualified source candidates, provisional verification and stale/changed on-chain state." The service admits only a `verified` manifest whose `environment` is `public-chain-preparation`, built with `workingTreeSourceChanges: false`, verified at the `finalized` tag, and whose roles hold no key of the public test mnemonic. `fork-rehearsal` and `local-test` are admissions a test asks for by name; the configuration cannot reach them. The on-chain half runs before a pass acts, once per process: every runtime code hash at the head, and the verification block still canonical at its height (`v2_deployment_anchor_reorganized`), the check deploy.mjs re-runs against a reorganization. Role changes after deployment show per pass: the signer check reads the registry, and a publisher the registry removed fails presimulation.

**Agreement with #302** was checked three ways. All four of its committed manifests load: the three fork rehearsals, each bound to its real profile and refused as production, and the offline fixture as a local test. The Base rehearsal and the offline fixture are copied into the tests. The manifest the EVM tests' fixture deployer writes passes #302's own `validateManifest`. And 12,005 mutated manifests went through both validators: the Python one never admitted what `validateManifest` refused, and every manifest only the Python one refused breaks a rule of the structural schema that `validateManifest` does not check (listed for #302 at the end).

## Configuration

One private JSON file per chain (0600, in a 0700 directory outside any checkout; `load_automation_config` refuses anything else), validated whole:

| Key | Meaning |
| --- | --- |
| `schemaVersion`, `kind` | `1`, `domino-v2-automation`. |
| `chain` | The profile name: `robinhood-4663`, `base-8453`, `arbitrum-42161`. |
| `deploymentFile` | The chain's manifest (#301's `docs/deployments/v2-<slug>-<chainId>-<date>/deployment.json`), admitted only as production. |
| `rpc` | `{"providerFile": …}` on Robinhood (the read path's local-first provider file, version 4); `{"chainRpcFile": …}` on Base and Arbitrum (F6's private V2 chain RPC file). |
| `headFile` | The chain's shared head file (`/run/domino-v2/<chain>.head.json`), shared with the other V2 services. |
| `journalFile` | The operator's journal, in the unit's state directory. |
| `operator`, `publisher` | `{address, keystoreFile, credential}`: the encrypted V3 keystore and the name of the systemd credential holding its password. Different addresses and credentials. |
| `gas` | The executor's policy: `maxGas`, `maxFeePerGas`, `priorityFeePerGas`, `maxCostWei`, `dailyCapWei`, `minBalanceWei`, and optionally `baseFeeMultiplierPercent` (200), `gasLimitMarginBps` (2000), `confirmations` (3), `replaceAfterSeconds` (60), `maxReplacements` (2), `bumpBps` (1250), `enabled` (false: nothing is sent until the owner turns it on). |
| `planner` | Optional overrides of `PlannerConfig`: the margins of the economic criterion, `gasBufferBps` (1500), `platformMinProfitWei` (0), `ownerHorizonSeconds` (604800), `forecastHaircutBps` (2000), `ownerMarginBps` (0); the gas priors `gasUnitsCompound` (450000), `gasUnitsSwap` (170000); and `deadlineSeconds`, `liquiditySlackBps`, `swapQuoteSlippageBps`, `swapMarginBps`, `swapPriceToleranceBps`, `twapDriftBps`, `minSwapShareBps`. |
| `observations` | The publisher: `validitySeconds` (120), `lookbackSeconds` ([12, 60]), `maxDeviationBps` (50). |
| `priceReferences` | `[{token, pool}]`: a pool between a token and the native or wrapped native token, per token to value directly (the chain's stable). Others are valued through the vault's pool. |
| `earningsWindowSeconds` | The owner gate's fee-growth window. On Robinhood, at most about 20 minutes stays on Domino's own node (15,000 blocks of state); older reads go to the archive fallback. |
| `twapSeconds`, `exitTwapSeconds` | The v3 TWAP windows for compounds and exits (each bounded by what the vault or the module admits; `exitTwapSeconds` at most 3,600, the module's `MAX_TWAP_SECONDS`). |
| `deadlineSeconds` | A plan's deadline after the head (a v4 plan never outlives its observation). |
| `passSeconds`, `headMaxAgeSeconds` | The serve loop's cadence and the head follower's maximum age. |
| `autoExit` | Whether this service executes mandates. |
| `vaultDefaults` | What a new vault is offered and how far the owner may move it, validated against the contracts' bounds and printed by `status`, for the app and the read API (the planner always uses each vault's own on-chain values). See below. |
| `vaultGasCeilingWei`, `vaultGasCeilingsWei` | An optional per-vault gas ceiling per execution (`null`: none) and per-vault overrides `{vault: wei}`. The owner chose the daily budget per chain (`gas.dailyCapWei`) as the ceiling. |
| `waitingFile` | Where the read API finds why each vault and mandate waits (below), or `null`. |

**`vaultDefaults`, the owner's decisions of 2 Oct 2026** (the app sends the owner's choices):

```json
"vaultDefaults": {
  "mode": null,
  "policy": {"triggerDistanceBps": 500, "maxOverlapBps": 2000, "minimumIntervalSeconds": 600, "maxPositions": 3},
  "limits": {"maxSlippageBps": 100, "maxPriceImpactBps": 100, "maxObservationAgeSeconds": 300, "upsideBps": 5000},
  "startPaused": false,
  "ownerMaxima": {"maxSlippageBps": 500, "maxPriceImpactBps": 500},
  "exitMaxSlippageBps": 100
}
```

- `mode` `null`: no default; the owner chooses Auto-compound (1, 2%) or Domino-compound (2, 4%). Auto-compound always takes `maxPositions` 1.
- `maxSlippageBps` 1% on top of the pool's fee, and `maxPriceImpactBps` (the anchor–spot band) 1%, each selectable up to `ownerMaxima` (5%). The vault itself refuses more than 10% and 5% (owner decision of 3 Oct 2026), and the configuration more than those ceilings.
- `maxObservationAgeSeconds` 300; `minimumIntervalSeconds` 600 (10 minutes, the owner's correction of 2 Oct): a floor, above which the economic criterion decides the cadence.
- The Domino parameters are V1's sequence defaults (`app/src/lib/create`): trigger 5%, overlap 20%, 3 positions, a successor's ceiling 50% higher.
- `startPaused` false; `exitMaxSlippageBps` is an exit mandate's default slippage, on top of the pool's fee.

### Per chain (Robinhood first)

All three chains are deployed, Robinhood first and Base and Arbitrum right after (owner, 2 Oct): one unit and one configuration file per chain, with the same keys.

| | Robinhood (4663) | Base (8453) | Arbitrum One (42161) |
| --- | --- | --- | --- |
| `rpc` | `providerFile`: the read path's file, Domino's own node first | `chainRpcFile`: Chainstack, dRPC, Alchemy, public; keyed URLs as credentials | the same as Base |
| `priceReferences` | USDG, v3 WETH/USDG 0.05% (`0x69Bf…8d9a`) | USDC, v3 WETH/USDC 0.05% (`0xd0b5…F224`) | USDC, v3 WETH/USDC 0.05% (`0xC696…E8D0`) |
| L1 data | in the gas units (Nitro) | `GasPriceOracle.getL1FeeUpperBound`, added to the gas | in the gas units (Nitro) |
| State for the publisher's look-back and the owner gate's window | the own node keeps 15,000 blocks (25 min) | a full node keeps 128 blocks (4 min): the window reads an archive endpoint | 128 blocks (32 s): the look-back and the window read an archive endpoint |
| `earningsWindowSeconds` (suggested) | 1200 | 3600 | 3600 |

Each reference, as configuration (Robinhood shown; Base and Arbitrum the same with their WETH and USDC, fee 500, spacing 10):

```json
"priceReferences": [{"token": "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
                     "pool": {"dex": 3, "currency0": "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
                              "currency1": "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", "fee": 500,
                              "tickSpacing": 10, "hooks": "0x0000000000000000000000000000000000000000"}}]
```

### Why a vault or a mandate waits (for the read API)

Owner decision of 2 Oct 2026 (F7 spec §9, item 24): the read API (item 3b) shows "Waiting: …" from what the automation recorded. After each `run-once`/`serve` pass, every vault's and every active mandate's latest reason is upserted into the journal's `waiting` table, and the last presimulation that reverted is kept, with its time and block, until a later presimulation of the same subject passes:

| Column | Meaning |
| --- | --- |
| `chain_id`, `kind`, `subject` | The chain, `vault` or `mandate`, and the vault's address or the mandate's hash (lower case). The key. |
| `reason`, `at`, `block` | The pass's decision for it: a fixed code (`too_soon`, `gas_not_covered`, `owner_benefit_insufficient`, `earnings_evidence_missing`, `vault_paused`, `root_disarmed`, `reserves_returnable`, `reserves_unpayable`, `trigger_not_reached`, `v2_observation_unstable`, `eligible`, `triggered`, `reverted_<error>`, …), at the head's timestamp and number. |
| `since`, `since_block` | The time and block of the first pass that gave the current reason: kept while the reason is unchanged, reset to the pass when it changes or clears (to `eligible`, say), and when a pass's head is earlier than the recorded start (a reorganization). A journal from before these columns gets each row's `at` and `block`. |
| `revert`, `revert_at`, `revert_block` | The last presimulation revert: the contract error's name as a code (`reverted_spot_outside_band`, `reverted_automation_unavailable`, …), and when; null once a presimulation passes. |

With `waitingFile` set, the same content is written atomically after each pass as one public JSON file (0644; no key, no URL), which is what the read API reads:

```json
{
  "schemaVersion": 1, "kind": "domino-v2-automation-waiting", "chainId": 8453, "block": 123456, "timestamp": 1790000000,
  "vaults": {"0x…vault": {"reason": "gas_not_covered", "since": 1789996400, "sinceBlock": 123450, "at": 1790000000,
                          "block": 123456, "lastRevert": null}},
  "mandates": {"0x…mandateHash": {"reason": "trigger_not_reached", "since": 1790000000, "sinceBlock": 123456,
                                 "at": 1790000000, "block": 123456,
                                 "lastRevert": {"code": "reverted_automation_unavailable", "at": 1789990000, "block": 123000}}}
}
```

A subject the service no longer evaluates (an executed or revoked mandate) keeps its last row. Dry runs (`plan`) record nothing.

### Credentials the owner seals

Keys never pass through a repository, a log or an assistant. On the VM each is sealed with the host's key (`systemd-creds encrypt --with-key=host`) and decrypted by systemd for the unit alone (`LoadCredentialEncrypted=`), as V1's keystore passwords are ([AUTOMATION_PILOT_CONFIGURATION.md](../AUTOMATION_PILOT_CONFIGURATION.md), "The signers' keys"):

| Credential | What it holds | Chains |
| --- | --- | --- |
| `v2-operator-keystore-password` | The password of the V2 operator's keystore (`operator.keystoreFile`) | each chain's unit (one key may serve all three chains) |
| `v2-publisher-keystore-password` | The password of the V2 publisher's keystore (`publisher.keystoreFile`) | each chain's unit |
| `v2-rpc-base-8453-<endpoint>` | A keyed Base endpoint URL, e.g. `v2-rpc-base-8453-chainstack`, `-drpc`, `-alchemy` | Base |
| `v2-rpc-arbitrum-42161-<endpoint>` | A keyed Arbitrum endpoint URL, e.g. `v2-rpc-arbitrum-42161-chainstack`, `-drpc`, `-alchemy` | Arbitrum One |

The credential names in the configuration are free (`[a-z0-9][a-z0-9-]{0,62}`); the ones above are the convention. The RPC credential names are fixed by F6's rule (`v2-rpc-` + profile + `-` + endpoint name) and are an alternative to the file's `url` or the `DOMINO_V2_RPC_*` variable, exactly one of the three. Robinhood's routes stay in the read path's provider file. The keystores are imported on the owner's machine (`cast wallet import`), copied to the VM as files the unit's user owns (0600), and the operator and publisher keys must be the manifest's `roles.operator` and `roles.publisher`, which the registry admits at deployment. The operator needs native gas on each chain.

### Commands

| Command | Keys | What it does |
| --- | --- | --- |
| `status` | none | The head, the manifest's code proven on chain, the number of factory vaults, billed calls, the vault defaults and the gas ceiling. |
| `plan` | none | One dry pass: every vault's and mandate's decision with its reasons; nothing signed or sent. |
| `run-once` | both | Reconcile, then one pass that may send one transaction. |
| `serve` | both | `run-once` every `passSeconds`. |
| `intents` | none | The journal's unresolved and `attention` intents. |
| `acknowledge --intent <id>` | none | An operator looked at an `attention` intent: the signer may claim again. |

## In production

`scripts/staging/install_v2_automation.py` installs the service and moves it to newer releases (`--inspect`, `--apply`, `--rollback`). It starts, enables and reloads nothing.

1. **Install.** Run `install_v2_automation.py --archive <tar> --archive-sha256 <hex> --commit <sha>`, first with `--inspect`, then with `--apply`.
   - **The first install** creates:
     - the identity `domino-v2-automation`, with no database role: the journal is SQLite and the service only reads the chain;
     - `/etc/domino/v2/automation` (0700), the private files, bound read-only at `/run/domino-v2-automation-config`;
     - `/var/lib/domino-v2-automation-public` (0755), each chain's `waitingFile`;
     - `domino-v2-automation.target`, wanted at boot.
   - **Every release:**
     - writes `/opt/domino/financial/releases/<sha>/v2-automation` (the backend, `api-contracts/v2` and the manifests, bound at `/run/domino-v2-deployments`);
     - writes the template `domino-v2-automation@.service`, one instance per chain. Each instance has its own `StateDirectory` (`/var/lib/domino-v2-automation/<chain>`, 0700) for the journal, the scans' state and the head.
2. **Credentials.** The keystore passwords are sealed once, by the owner, as `/etc/credstore.encrypted/v2-operator-keystore-password` and `…/v2-publisher-keystore-password` (`systemd-creds encrypt --with-key=host+tpm2`).
   - The template loads them with `LoadCredentialEncrypted=`, and imports the hosted chains' `v2-rpc-*` URLs, with the TPM in its device policy.
   - The owner makes the keystores on their own machine. `make_keystore.py` checks that the key is the manifests' `roles.operator` or `roles.publisher`; `cast wallet import` works too.
3. **Private files**, each owned by `domino-v2-automation`, mode 0600, in `/etc/domino/v2/automation`:
   - `v2-operator.json`, `v2-publisher.json`: the encrypted keystores;
   - `providers.json`: a copy of the reader's provider file, Domino's own node through its proxy (`127.0.0.1:18547`) first;
   - `chain-rpc.json`: a copy of `/etc/domino/v2/chain-rpc.json`;
   - `<chain>.json`: each chain's configuration.
     - `headFile`, `journalFile`: in the instance's state directory;
     - `waitingFile`: `/var/lib/domino-v2-automation-public/<chain>.waiting.json`, which the V2 indexer reads (`--waiting-file`).
4. **Egress.** Collect with `v2-automation` enabled, `--node-loopback-reads` and `--v2-chains`; render, update, then `nft -f`.
   - The role is optional until the identity exists. It has no unit of its own: the template binds `/etc/domino/continuous-reads/v2-automation.hosts` over `/etc/hosts`.
   - It reaches the node's proxy, its provider file's fallbacks (`rpc`), and Base's and Arbitrum's providers (`chains`).
5. **Start without sending.** Run `daemon-reload`, then `systemctl enable --now domino-v2-automation@<chain>.service` for each chain, with `gas.enabled` false.
   - Each pass plans, presimulates and records why every vault waits; nothing is sent.
   - Then set `gas.enabled` to true and restart the instance.

**The owner's numbers (5 Oct 2026):**
- `gas.dailyCapWei` is 0.0025 ETH per chain (`2500000000000000`), on Robinhood, Base and Arbitrum.
- The rest of each chain's gas policy follows V1's on Robinhood: at most 3,000,000 gas, and at most 0.0005 ETH per transaction. The fee caps and the balance floor are set per chain in its file.

Still open:
- **Funding and admission:** the operator needs ETH on each chain. The registry admitted both roles at deployment.
- **Monitoring:**
  - the pass reports (one JSON line per pass), and `intents` for `attention`;
  - the operator's balance, and the daily spend against `dailyCapWei`;
  - the registry's `ChangeScheduled`, `OperatorSet`, `PublisherSet` and `AutomationHaltSet` (F1a, "Monitoring").
- **The publisher in its own process:** it runs inside the automation process, with its own key. Splitting it into its own unit, serving signed observations over a local socket, is a follow-up if the owner wants the two keys in separate processes.

## Verification

| Test | What it proves |
| --- | --- |
| `test_v2_plan.py` (14) | PlanV1 is F3's golden (length and keccak read from the Solidity suite), the type string is F3's documented one, canonical round trip and refusals, the plan hash is the vault's, legs and paths, the exit `Execution` through the frozen export; `returnReserves()` and its result through the frozen ledger export, and a return's subject. |
| `test_v2_observation.py` (13) | The digest is the F0 golden and a second implementation's; the signature is the one `DominoPriceAnchor.t.sol` pins; low s, v 27/28, malleated and malformed signatures recover no one, and a signature the anchor would not recover never leaves the signer; the domain binds chain and anchor; evidence round trip; the publisher signs the spot at the head dated by the block, bounds the validity by the consumer, and refuses a price not held over the look-back. |
| `test_v2_planner.py` (41) | The tariff split against the vault's (fuzzed), split spending pays the same cut, `DominoSwapFloor`'s own vectors, liquidity never overcharges, the swap simulation; direct and swap candidates, the output scarce by the margin and spent within the tolerance (and refused beyond it), the vault's floor and an unspendable output refused, the #3409682 case, v3 legs and the TWAP drift in both directions, budgets and charged units first, Domino routing; both gates at their edges (the buffer, the absolute margin, the L1 fee, measured gas, the haircut, missing evidence, a quiet pool, the only liquidity, out of range), small swaps not considered, the swap cost at the anchor, the quote seam with a router quoter, the per-vault gas ceiling; which vaults a return applies to (a closed root alone, never with an active successor). |
| `test_v2_executor.py` (33) | Claim, sign, persist then send; only the manifest's operator key; one intent in flight; a new journal starts at the chain's nonce; the presimulation at the pinned block; reverts as contract error names; only the deployment's targets; every cap (gas, fee, cost per transaction, balance) and the daily window, replacements included; a disabled executor and a signer with code; confirmations, reverted receipts, a lost transaction resent as the same bytes after requalification or past its deadline, a nonce spent by someone else and its acknowledgement, fee-bump replacements and their limits, a receipt that is not ours, an ambiguous broadcast, a crash before signing, a private durable journal, waiting reasons, since when each has held (reset when it changes, clears or a head runs backwards; a journal from before `since` upgraded), and their last revert; every `CONTRACT_ERRORS` entry declared in `contracts/src/v2`; a return only to a factory vault, the same call on another pass as another intent, the presimulation's result. |
| `test_v2_autoexit.py` (10) | The module's trigger comparison, eligibility, the band's edges, removal minimums met anywhere in the band, conversion legs, planning only once the anchor crossed, the v3 window, the mandate log watch. |
| `test_v2_vaults.py` (13) | The TWAP window and the anchor's own TWAP, v3 and v4 fee growth, reference prices, the OP Stack L1 fee (and none on Nitro), discovery from both factories, the EIP-1167 clone and the wiring proof; a burned root read as closed on both DEXes (and anything else, or a successor, still refused), and a closed vault's reserves. |
| `test_v2_manifest.py` (15) | #302's own output (its Base fork rehearsal and its offline fixture, copied, and equal to #302's files once they are in the repository): each admitted as its environment only, bound to its profile. 69 rule breaks, each refusing the whole manifest, and 8 more for the receipt, verification and time rules item 3b moved in; the profile's CreateX; public test keys refused as production roles (the ten accounts derived from the mnemonic); the profile's chain, dependencies, code hashes and charge currencies; production admission (no fork, no local test, no unqualified source, nothing but `finalized`); JavaScript's canonical JSON and numbers; the file's limits; the code and anchor proofs. |
| `test_v2_automation.py` (14) | The configuration with the owner's vault defaults, each rule refusing it, Robinhood's provider file, the private file, keys that must be the manifest's operator and publisher, fixed error codes on the command line; the pass's return decision (one presimulated call, nothing to return, an emptied vault read again only once its nonce moves, the halt holding it and a pause not, a return that would pay nothing, the contract's refusal, keyless, the per-vault gas ceiling). |
| `test_v2_rpc.py` (+2) | RPC URLs from sealed credentials: exactly one source among file, credential and variable; links, directories, oversized and non-ASCII credentials refused without their value. |
| `test_v2_abi.py` (+2) | Every exported event loads with its topic; a log decodes only against its own shape. |
| `test_v2_automation_evm.py` (10, `DOMINO_TEST_EVM=1`) | On a disposable Base Anvil with Uniswap's **deployed Base bytecode** and every F0 component at its CREATE3 address, deployed by the suite's fixture with #302's constructor arguments and admitted from its #302-format manifest as a local test: a vault compounds end to end through the service's own pass (discovery, proof, planner, signed observation, presimulation, journal, receipt) and pays 2% once, in both tokens, to the registry's recipient; a balancing swap through the vault's own pool via the real swap module, its output spent (A5); a dropped execution resent as the same bytes; an auto-exit converting into WETH with 20 bps of the output, one shot, then no longer read; a paused vault that still exits; a spot pushed in the last block does not fire an exit; an exit whose presimulation reverts recorded for the read API (table and snapshot file); the signer's digest is the anchor's `hashObservation`; an owner closes a compounded root on Uniswap itself and the next pass returns the vault's reserves to the owner, exactly, before another vault's compound (journaled as `return`, `ReservesWithdrawn` in its receipt, then `root_disarmed`), and a burned root's too. |

**Gas measured** on that chain (Cancun, deployed v4 bytecode, the real anchor verifying a signed observation): a compound used 414,777 gas (estimate 467,716; calldata 1,444 bytes), a compound with one v4 pool swap leg 574,595 (estimate 632,540; 1,988 bytes), an auto-exit with conversion 396,947 (estimate 484,147; 1,284 bytes), a return of both tokens' reserves 77,583 (estimate 88,148; 4 bytes). The planner's priors (450,000 and +170,000) come from these; Nitro chains add the L1 component in gas units, so tune them per chain.

**Mutation.** Every guard of the new modules was deleted or weakened, one at a time, in a disposable worktree, against the test module meant to catch it: **163 of 163 caught**. 68 cover the executor (claims, caps, presimulation, reconciliation, replacements, waiting reasons), the planner (the floor, A5 sizing, budgets, both gates and their margins, preconditions), the publisher (stability, validity, signatures), the credential rules, the auto-exit (trigger, expiry, band, log checks) and the vault proofs. 92 cover the manifest loader, one per rule of #302's schema and validator, binding and admission. 3 cover the keys being the manifest's operator and publisher. Earlier runs left survivors, each now pinned by a test or removed as unreachable. Some guards were masked by another (the salt rule behind the address check, twice). Some boundaries no test reached (the gas buffer, the haircut, the TWAP drift, the margin, the replacement's daily cap, the parser's nesting limit). Two were defensive checks (the signer's self-check, the swap-share filter). Three checks could never decide anything, so the Python drops them: #302's `0x0…dead|beef|cafe` placeholders (already below 2^16), a collision between CREATE3 predictions, and refusing NaN or an infinity while parsing (no rule admits a float). Item 3b (PR #305) added 21, all caught: 13 for the rules it moved into the loader (receipts after genesis with non-zero hashes and one hash per block, the verification's block, hash and zone, the profile's CreateX and its code, public test keys in production and the list of those keys) and 8 for `since` (the same reason, an earlier head by time or by block, for both columns; the upgrade of an older journal; the snapshot's value). Three survived at first, each masked by another check, and are now pinned: the verification-after-receipts rule (behind the agreement with a receipt's block), by a verification before every receipt; and the earlier-head-by-time condition of both columns (behind the block's), by a head earlier in time but not in block. The return of a closed vault's reserves added 30, all caught: the predicate (an active successor, liquidity left), the reader (only the root may be gone, only a gone position is tolerated, each DEX's sign of a burn, a gone root's liquidity and fees, the reserves of both tokens), the pass (the halt, the emptied-vault memory and its key, nothing to return, keyless, nothing payable, the vault's gas ceiling and its override, a closed vault offered a return, returns as their own candidates, the pass busy after one, returns before compounds; the last four on the EVM), the executor (the kind and its targets, the call's result, its case, an intent's subject) and the subject's rules. One survived at first (an upper-case result whose digits had no letters) and is now pinned.

**CI.** The Backend job builds the ten V2 contracts the EVM tests deploy (`Build the V2 contracts the backend EVM tests deploy`, one step for this front's EVM tests and item 3b's): 83 s cold on a Mac on 2 Oct 2026 (53 sources), nothing on a warm cache. The EVM tests run in about 3 s.

## What remains

1. **Domino-compound successors**: MINT plans (the successor's range from the parent's ceiling or the anchor, `maxOverlapBps`, `upsideBps`), and rule 2 (an in-range parent near its ceiling funding its successor). The planner plans COMPOUND only; a Domino vault still compounds every member with its own fees and with members the price has left.
2. **Universal Router 2.1.2 legs and on-chain quotes**: through the quote seam, with item 3c's `v2_quotes`.
3. **v3 on an EVM**: the v3 paths (TWAP evidence, v3 fee growth, v3 legs) are unit-tested and the v3 contracts are F1c's and F3's; an end-to-end v3 compound needs a v3 swap driver on the Anvil, which #300's Forge suites or #301's local deployment can provide.
4. **The fixture deployer** (`backend/tests/v2_local_chain.py`) stays until #301's local mode can deploy against real Uniswap runtimes: `deploy-local.mjs` (PR #302) installs synthetic dependencies offline ("this mode does not test Uniswap, Permit2, swaps, positions or user journeys") and needs a fork otherwise. The fixture's manifest is already #302's format.
5. **Numbers the owner still sets per chain** (the decisions of 2 Oct are in the configuration already: the vault defaults, the economic cadence, the daily budget, paused vaults that exit): each chain's gas policy and daily budget (`gas.*`), the margins (`gasBufferBps`, `platformMinProfitWei`, `ownerMarginBps`), the owner gate's horizon (`ownerHorizonSeconds`, the number that most changes how often a quiet pool compounds; see the table above) and haircut, the publisher's look-back and band, and whether auto-exit runs on each chain.
6. **F8**: installed by `install_v2_automation.py` and the continuous egress policy ("In production" above). Funding, monitoring and alerting on `attention` remain.
7. **The publisher as its own unit**, if the owner wants the operator and publisher keys in separate processes.
8. **The operator rearm on v3** (`operatorRearm` after a third party's dust addition) is not automated yet: the pass reports such a root as disarmed.
9. **Multicall3 aggregation** of the state reads (F6's next billing lever).

## For the other fronts

- **3b (indexer and read API, PR #305).** Item 3b uses this front's `v2_manifest` (the one loader of #301's manifest; its own was retired and its extra rules moved here) and `tests/v2_local_chain.py` for its EVM tests. Its indexer reads the `waitingFile` into the V2 index and the read API serves `waiting: {reason, since, sinceBlock, …}`. Decode the log scans in `v2_vaults` and `v2_autoexit` with 3b's strict `v2_events` catalog instead of the small `v2_abi.event` helpers added here. The journal's effects carry each execution's receipt logs; the read API can show a vault's planner state from `plan`'s output (reasons are fixed codes). Serve `vaultDefaults` and the gas ceiling to the app from this configuration. `VaultDiscovery` and `MandateWatcher` are the automation's own log scans; the indexer may replace them.
- **#301 (deployment, PR #302).** `v2_manifest` validates #302's schema and `validateManifest` rule for rule, with the backend's production admission on top (above). Two items were raised for #302, and both are settled there. First, `validateManifest` admitted manifests the structural schema refuses (closed objects inside `build`, `chargeCurrencies`, `deploymentReceipts` and `verification`; string `gasUsed`, `effectiveGasPrice` and `releaseTag`; `verification.blockTag`; a string `checkedAt`; a non-empty `nativeCurrency`; a prepared manifest's `deploymentReceipts` as an object). It now validates the schema file itself and the same rules as this loader, the receipt, verification and time rules included, and `test_v2_manifest.py` runs both over the same documents. Second, its local mode now defaults to a fork that keeps the real chain id, with the real Uniswap and Permit2; the offline mode still installs synthetic dependencies, and the EVM tests run offline in CI, so they keep their own fixture deployer (real Base Uniswap runtimes, F1c's fixtures).

**Which deployer each test uses:**

| Tests | Deployment |
| --- | --- |
| `test_v2_automation_evm.py` (8) | `backend/tests/v2_local_chain.py`'s `deploy_v2` on a disposable Base Anvil with Uniswap's deployed Base runtimes; the manifest it writes is #302's format (`local-test`, admitted as such) and passes #302's `validateManifest`. |
| `test_v2_manifest.py` | No chain: #302's own manifests (copied), and synthetic ones built as deploy.mjs prepares them. |
| `test_v2_executor.py`, `test_v2_autoexit.py`, `test_v2_vaults.py` | No chain: scripted RPC fakes and a synthetic production manifest. |
| None | `deploy-local.mjs` itself: its offline mode has no Uniswap to compound or exit through. |

- **3c (S1 plan API).** The planner's quote seam (`PoolQuoter`, `SwapQuote`) is the one call to switch to `v2_quotes`; no file of that name exists here.
- **#300 (integration tests).** The EVM tests here run the service against the real stack; they do not replace the Forge journeys.
