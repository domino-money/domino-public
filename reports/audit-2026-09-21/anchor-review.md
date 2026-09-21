# Anchor, routing and economic-evidence review — 21 September 2026

Reviewed checkout `7be7820` in `/tmp/domino-v4-audit-20260921`, with production sources unchanged. Scope: `DominoPriceGuardV4`, `DominoRoutingHelperV4`, anchor use in `DominoExecutionEngineV4`, the standing internal review, and the fork evidence behind audit-package §3. Read `AGENTS.md` and `docs/EXECUTION_POLICY.md` first.

## Result

A P1 chain-compatibility issue was confirmed against the actual Robinhood mainnet: pinned read-only calls show that Solidity NUMBER/BLOCKHASH and the RPC L2 observation fields use different block domains. Earlier public-RPC attempts returned HTTP 403; a subsequent call with an explicit descriptive User-Agent succeeded. No new price-band, routing, or arithmetic bypass was found. Two additional actionable evidence/claim defects remain. The pre-observation residual itself is already disclosed as D-01/D-03/D-04's accepted residual and is not presented here as a new contract vulnerability.

### A-00 — P1: Observation block numbers and hashes use the wrong block domain on Robinhood Nitro

**Locations:** `contracts/src/DominoPriceGuardV4.sol:84-88`, `:111-118`; `contracts/src/DominoVaultReadHelper.sol:144-146`; `backend/qualify_execution_fork.py:487-501`; `backend/execution_v4.py:230-232`, `:542-544`.

The publisher and execution authority carry an RPC block number/hash from Robinhood (`eth_getBlockByNumber`). The contracts compare that number to Solidity `block.number` and validate the hash with `blockhash`. On Robinhood's documented Arbitrum Nitro stack those are different domains: standard RPC returns the child/L2 block, while the NUMBER opcode returns the first non-Arbitrum ancestor's approximate block number. BLOCKHASH follows Nitro's corresponding L1-domain implementation, not the RPC child-chain block hash. The correct L2 APIs are `ArbSys(0x64).arbBlockNumber()` and `arbBlockHash()`.

When the RPC source height exceeds the current ancestor-chain height, the guard rejects it as a current/future observation before checking the price, and the read helper rejects the execution for the same reason. Even when the numeric order differs, a child block's hash does not match the ancestor-domain BLOCKHASH result. All GENERAL/NET/FUND/MINT actions require this observation, so the documented live execution path cannot become usable by simply deploying the frozen artifacts and issuing service profiles. Owner exits do not depend on these observation checks.

This is separate from the already disclosed "backend has not run live" limitation: it is a concrete disagreement between the frozen contract validation and the chain on which it is supposed to run. Switching the backend to L1 numbers alone would also violate its RPC source/hash reconciliation and would not authenticate the L2 state that was observed.

**Why the fork missed it:** `backend/deposit_fork.py:78-81` starts an ordinary Anvil EVM at the selected RPC fork block. Its NUMBER/BLOCKHASH semantics follow the fork's child block numbering; it does not execute Nitro's opcode overrides. The existing fixture explicitly sets `vm.roll` to the same domain it writes into observations. Neither supplies cross-domain integration coverage.

**Primary evidence:**

- [Robinhood's full-node guide](https://docs.robinhood.com/chain/run-a-full-node/) identifies Nitro and the stock `offchainlabs/nitro-node:v3.11.2-3599aca` image. The repository separately pins that revision in `reports/DEPOSIT_RPC_QUALIFICATION.md:158`.
- [Arbitrum's block-number documentation](https://docs.arbitrum.io/arbitrum-essentials/arbitrum-vs-ethereum/block-numbers-and-time) distinguishes Solidity's ancestor-chain height, RPC child-chain height, and the ArbSys alternative.
- [The pinned Nitro implementation](https://github.com/OffchainLabs/nitro/blob/3599acae1ad2fab4059fc46453c9cd3294126641/arbos/tx_processor.go#L915-L947) retrieves NUMBER/BLOCKHASH values from ArbOS's L1 blockhash state. [ArbSys's interface](https://github.com/OffchainLabs/nitro-precompile-interfaces/blob/main/ArbSys.sol) exposes the L2 versions.

**Correction:** Use a consistently qualified L2 block-number/hash abstraction for observation checks and checkpoint block fields, align the producer and reconciler, and qualify the resulting path on Nitro. Add a chain-capability preflight so an ordinary Anvil fork cannot count as proof of Nitro-specific opcode behavior. Updating immutable artifacts requires a new freeze/hash manifest.

**Actual mainnet validation (2026-09-21T14:58:24.588780+00:00):** the public endpoint from Robinhood's own [connection guide](https://docs.robinhood.com/chain/connecting/), `https://rpc.mainnet.chain.robinhood.com`, answered `eth_chainId = 0x1237` (4663). All following calls were pinned to block **68,886,586** (`0x41b203a`), hash `0x2e5953a95b6c5fc471393180c25e05b5842eff0848467664f6f74827e49f8951`:

| Read | Result |
| --- | --- |
| RPC header `number` | 68,886,586 (`0x41b203a`) |
| RPC header `l1BlockNumber` | 26,026,629 (`0x18d2285`) |
| `eth_call` creation simulation, NUMBER opcode | 26,026,629 (`0x18d2285`) |
| `eth_call` creation simulation, BLOCKHASH(68,886,585) | zero |
| `ArbSys(0x64).arbBlockNumber()` | 68,886,586 |
| `ArbSys(0x64).arbBlockHash(68,886,585)` | `0xb7b6646b4e8e03a76ee7a268e4229b8fba222b8b9869fa6e7e3678df0f71a4d2` — exactly the RPC prior-block hash |
| `ArbSys(0x64).arbOSVersion()` | 116, corresponding to ArbOS 61 (the interface adds 55) |

The calls and full returned values are preserved in `contracts/test/audit_anchor/anchor-mainnet-block-domain.json`. The NUMBER creation-simulation data was `0x4360005260206000f3`; the BLOCKHASH simulation was a PUSH32 of the prior L2 number, BLOCKHASH, MSTORE and RETURN. These are `eth_call` executions only, with no transaction submission or deployed probe contract. No secret configuration was read. An explicit `User-Agent: Domino read-only chain compatibility audit` was supplied on the successful retry.

This confirms the actual custom chain rather than assuming default Nitro behavior. Robinhood's own [differences guide](https://docs.robinhood.com/chain/differences-from-ethereum/) explicitly documents the L1 meaning of `block.number`. The official [mainnet chain configuration](https://cdn.robinhood.com/assets/generated_assets/hoodchain_docsite/chain-node-configs/robinhood-chain-info.json) has chain 4663, parent 1, `parent-chain-is-arbitrum=false`, ArbOS enabled, initial ArbOS 51, and genesis block 0. Its custom code limits are 98,304/196,608 bytes, rather than Ethereum's limits. SHA-256 of the downloaded configuration: `cf6c0aa2bc520a28fe8983f783676bc43de94cc25a57a1cdc9b1f0afc5208f0a`. The official [mainnet genesis](https://cdn.robinhood.com/assets/generated_assets/hoodchain_docsite/chain-node-configs/robinhood-genesis.json), SHA-256 `353e6f6441b47695b41cee0c3645cde8dd7492d2f7f574bfb6aa4371e41bb6ba`, repeats that chain configuration in `serializedChainConfig`; `arbOSInit` adds an initial L1 base fee. Its preallocations do not change the confirmed live NUMBER/BLOCKHASH result.

**Remaining limit:** no deployed Domino execution transaction was attempted, and no new Nitro fork was started. The incompatible opcode results were measured directly on mainnet without changing state.

### A-01 — P2: The fork report substitutes anchor quotes for actual swap proceeds and uses the wrong control

**Locations:** `reports/EXECUTION_FORK_SANDWICH_2026-09-20.md:57`, `:69-75`, `:171-178`; `backend/qualify_execution_fork.py:594-620`, `:708-717`, `:732-739`.

The report labels its swap-shortfall column as what the sale fetched below the true rate, says the values were measured, and reports zero for successful post-observation 0.5% and 0.9% moves. Those rows use the honest anchor but execute at a manipulated live pool price. The anchor limits the permitted swap; it does not provide its exchange rate (`DominoExecutionEngineV4.sol:290-309`). The committed JSON records input and anchor/spot prices, but no actual swap output or conversion receipt. Every displayed pre-observation shortfall is reproduced by `swapIn * (referencePrice - anchorPrice)` and every displayed post-observation zero follows from the unchanged anchor. This is a quote difference, not measured proceeds.

Recalculation from the committed raw data yields these **pre-swap spot quote differences**, which are already nonzero before the pool's own fee and swap impact:

| Range | Post-observation move | Reported shortfall | Difference at execution spot (USDG) |
| --- | ---: | ---: | ---: |
| Narrow | 0.5% | 0.0000 | 0.010237645364289585 |
| Narrow | 0.9% | 0.0000 | 0.018427254053099592 |
| Wide | 0.5% | 0.0000 | 0.001065495476022142 |
| Wide | 0.9% | 0.0000 | 0.001917910264727762 |

These are deliberately not labeled exact realized outputs; those require the missing receipt field. A local official-pool test, `contracts/test/audit_anchor/AnchorExecutionEvidence.t.sol`, captures the real `FeesConverted.amountOut` and compares the same plan with and without a post-observation move.

There is a separate control error in the same measurement: `honest_value` is always the non-swap honest run, including for every swap scenario (`qualify_execution_fork.py:708`, `:732`). The script computes a swap-honest control but does not use it. That control is already worth **0.088853 USDG more** than the ordinary honest run on the narrow pool and **0.007324 USDG more** on the wide pool because the plans consume different fees and liquidity. The reported swap benefits include that pre-existing difference. Thus neither the realized shortfall nor the incremental swap-manipulation effect is isolated as claimed.

**Impact and correction:** The factual statement that sampled manipulations were unprofitable does not become a demonstrated profitable attack from this error. However, the report overstates the evidence and masks the expected bounded post-observation loss, which matters when evaluating what a compromised operator can cost. Record the actual `FeesConverted` output, compare swap scenarios to their swap-honest control, label quote estimates separately, and recompute the tables. Do not infer safety bounds from the existing shortfall column.

**Offline evidence:** `python3 contracts/test/audit_anchor/verify_fork_evidence.py` passed and printed the values above using only committed raw records. The coordinated command `node scripts/test-contracts.mjs --match-path test/audit_anchor/AnchorExecutionEvidence.t.sol -vv` passed: **1 test, 0 failures**; compilation took 73.03 seconds and the contract size gate also passed. The unchanged official-pool fixture executes the same plan with an honest anchor in both cases and confirms that a roughly 0.5% post-observation move lowers actual swap output by more than 0.4% of input while both executions succeed.

### A-02 — P2: The ~$500 single-compound threshold is not a per-vault safety bound

**Locations:** `reports/V4_AUDIT_PACKAGE_2026-09-21.md:106-110`; `reports/EXECUTION_FORK_SANDWICH_2026-09-20.md:171-178`.

The report derives a roughly $500 threshold by dividing the sampled round-trip pool-manipulation cost by the price move and says one compound must sell that much, directing the reader to compare it against each vault's fee reserve. That conclusion assumes one victim action per manipulation. The contracts do not enforce that assumption:

- A price observation commits to pool, block/hash, timestamp, expiry and price, not a vault, action or aggregate swap amount (`DominoPriceGuardV4.sol:14`, `:94`).
- `referencePrice` is a view read with no consumption marker (`DominoPriceGuardV4.sol:108-120`). Reuse for a different action or vault is allowed.
- Each execution checks the anchor and its own vault's limits (`DominoExecutionEngineV4.sol:112-116`). The nonce and interval in `DominoRoutingHelperV4.sol:128-133` are also local to each vault.

An attacker able to cause multiple eligible fee sales on the same pool pays to move and restore that pool once, while the value exposed between those operations is the **sum** of all sales. A compromised shared operator can execute several authorized vaults before restoring; independent vaults do not share an interval. This does not require control of the publisher if it reads the already moved spot as in the disclosed experiment. Exact profitability also depends on cumulative swap impact staying inside the owner's band and on available liquidity; neither is simulated by the recorded one-action point samples.

Even with the report's linear approximation accepted, its comparison must use aggregate exposed notional across the manipulation window, rather than requiring an individual vault to reach $500. A per-vault reserve below the quoted amount does not establish the claimed economic boundary.

**Impact and correction:** This is a qualification defect in the explicitly accepted pre-observation risk, not a new way around the on-chain band. Remove the per-compound/per-vault safety interpretation. If the service relies on an economic exposure bound, qualify aggregate executions sharing a pool/window, sweep executable reserve size, and measure actual attacker profit at the threshold. The existing figures are point samples, not a minimum attack-cost proof; no additional on-chain aggregate cap is currently enforced by these contracts.

## Other conclusions and known residuals

- The publisher sanity band is applied to square-root prices, whereas the engine's impact check applies to squared price ratios. A guard band of 2000 bps admits an anchor between 0.64 and 1.44 of the live price. This alone does not defeat a 100-bps execution band: the engine still checks both before and after swap prices against the anchor. Pool manipulation before publication remains the already documented residual.
- `ratioBps` computes the exact floor: dividing an intermediate floor by the same integer denominator does not introduce additional error. Its spread check bounds the intermediate product below the `FullMath` overflow region. `checkSwapPrices` uses floor on the low side and ceiling on the high side, so integer rounding does not widen the stated band.
- Successor overlap/upside geometry and minimum adjacent-tick selection were reviewed in both orientations. The source-routing checks constrain GENERAL/NET to the same member, MINT to its parent, and FUND to the documented successor/in-range cases. No concrete bypass was identified.
- Every action receives the external anchor in `unlockCallback`, including NET and actions without a swap. Per-add `maxAdded0/1` is the operator's plan ceiling, useful against intervening market movement. It is not an independent ceiling against a compromised operator, which can choose a large value; the owner-controlled price/slippage limits provide that separate constraint.
- Publisher timestamp freshness is self-attested; block distance is the hard bound. This was explicitly acknowledged in the standing review and source, so it is not a new finding. The old publisher's observations remain usable until expiry after rotation by design.
- The guardian has indirect publishing authority because it can choose a publisher it controls. It may also nominate itself: `proposePublisher` excludes zero and current publisher, not the guardian (`DominoPriceGuardV4.sol:62`). Thus statements that the guardian "cannot publish" and that rotation necessarily requires "two keys" describe an intended operating procedure, not an on-chain separation invariant. The backend profile check prevents the honest admitted signer from continuing after an unexpected rotation, but it is not an on-chain check for an already-compromised operator. This is a trust-model clarification, not classified as a new exploit beyond the documented ability to select any publisher.
- An initial suspected swap-output budget overflow was disproved: `unlockCallback:127` clamps `maxCharged` to the existing balance before `_swap` adds the new output. It is not a finding.

## Validation limits

The raw fork records were recomputed offline, the focused official-pool Solidity test passed, and live mainnet block-domain reads were pinned and recorded. No new live Robinhood fork was run by this reviewer. No privileged keys, deployed vaults, source contracts, or existing tests were changed. Added audit tests run against the unchanged official local-pool fixture and cannot establish a dollar-denominated bound for the real pool.
