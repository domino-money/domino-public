# Automation cycle — configuration, installation and operation

Implements [V4_AUTOMATION_CYCLE_POST_DEPLOY.md](V4_AUTOMATION_CYCLE_POST_DEPLOY.md) as a
backend service around the deployed Domino V1 contracts. It admits sequences from the
verified deployment, observes them at canonical blocks, decides with the existing
economic planner, and, only when a plan is eligible and affordable, publishes one price
observation on demand and hands the intent to the existing durable executor. Nothing
here is enabled by installing it: a private configuration file names every parameter,
and both signer keys stay outside the repository.

What it is today: a **library and an integration tested on a disposable chain and
database** (`backend/tests/test_automation_cycle_evm.py`). It is **not an active
service**: no production configuration, admission profile, key or host unit exists in
this repository, and the mainnet deployment's `executionAvailable` stays `false` until
the [activation](#activation) steps below are done and recorded.

## Components

| Module | Role |
| --- | --- |
| `backend/automation_config.py` | The versioned private configuration: every operational number explicit, validated strictly, nothing defaulted from fixtures. |
| `backend/automation_observer.py` | Admission of a sequence from the verified deployment (`derive_admission`), the planner's `Observation` at one canonical block, the ledger/vault agreement check, the pool fee/liquidity sampler. |
| `backend/automation_evidence.py` | Prices from the pool's own spot at the observed block, depth/activity bounds over the sampled window, exact swap quotes by walking the pool's initialized ticks, the pool's swap cap (fee × depth over the owner's impact band, walked tick by tick), complete-path gas including publication, the L1 data component and the publications a completed cycle is expected to take. |
| `backend/automation_plan.py` | The planner's candidate → the persistable `ExecutionPlan`, proved against `validate_candidate` and the V4 wire (`rebuild_v4`) before anything is stored; the anchor's exact on-chain id computed offline. |
| `backend/publisher_signer.py` | The restricted publisher: `publish(Observation)` for the admitted guard only, signed bytes persisted before any send, one row per observation id. |
| `backend/automation_store.py` | Sequence leases, cycle records, shared pool samples, operator controls, the ledger view offered to the planner (lots net of settled spends and recorded withdrawals). |
| `backend/automation_ledger.py` | The ledger's reader of the vault's fee events from finalized blocks, under the reconciliation role: an owner withdrawal becomes a debit on the ledger's lots, our own reconciled executions are verified, any other execution is an exception that suspends the sequence until an operator acknowledges it. |
| `backend/automation_cycle.py` | The orchestrator: observe → decide → reserve → publish → execute → reconcile, with restart-safe transitions. |
| `backend/automation_cli.py` | Private commands: `status`, `evaluate`, `run-once`, `serve`, `pause`/`resume`, `suspend`/`unsuspend`, `publications`, `index`, `ledger`, `acknowledge`. |
| `backend/migrations/028_automation_cycle.sql` | Tables, the `domino_execution_publisher` role and the guards. Applied with the automation activation, never by the disabled foundation or the financial upgrade. |
| `backend/migrations/029_ledger_index.sql` | The reader's cursors, withdrawals with their lot debits, exceptions, and the claim/spend guards counting the debits. Applied with 028; no new role. |
| `backend/migrations/030_swap_exposure.sql` | The pools' shared swap budget (`swap_exposure`: each compound swap's share of its pool's cap, readable by every tenant's worker, written and released only by its own) and `sequence_state.consecutive_failures`. Applied with 028 and 029; no new role. |

The existing pieces are reused unchanged in their boundaries: `execution_planner`
decides, `execution_store` reserves, `execution_signer`/`execution_runner` sign, send and
reconcile, `execution_v4_adapter` rebuilds the wire and qualifies the anchor. Two
additions to them: an intent persisted by the cycle carries its anchor in
`commitments.priceObservationId`, and the private signer CLI prefers that binding over
its configured `priceObservationId`.

## Configuration

One JSON file, mode `0600`, owned by the service user, in a `0700` directory outside any
checkout (the same rules as the other private services). `schemaVersion: 1`,
`kind: "domino-automation-cycle"`, and a `configVersion` recorded on every cycle.

| Section | Fields | Notes |
| --- | --- | --- |
| `database` | `host`, `port`, `dbname` | Unix-socket host; the worker connects as `domino_execution_worker`, the publisher journal as `domino_execution_publisher`, the executor as `domino_execution_signer`. |
| `rpcEndpoint` | one fixed URL | `https://` or loopback `http://127.0.0.1`. The own node through its tunnel is the intended endpoint; there is no failover in the signing path. |
| `deployment` | the seven contracts, the three Uniswap dependencies, `serviceFeeRecipient`, `operator`, `pricePublisher`, `serviceFeeBps: 200`, `dominoServiceFeeBps: 400`, `expiresAt`, `codeHashes` (ten runtime hashes, `vault` being the clone) | Copy from `docs/deployments/<release>/sequence-release.json` `deployment`; every hash is re-checked on chain at every pass. |
| `sequences[]` | `owner`, `vault`, `expiresAt`, `suspended` | The admitted sequences. The vault must be the deployment's clone, owned by `owner`, with its identity hash matching; anything else is refused before the sequence is leased. |
| `operator` | `keyFile`, `policy` (`max_gas`, `max_fee_per_gas`, `priority_fee_per_gas`, `max_total_cost`, `max_replacements`, `bump_bps`, `enabled`) | The executor's `SignerPolicy`. The key file's address must equal `deployment.operator`. |
| `publisher` | `keyFile`, `maxGas`, `maxFeePerGas`, `priorityFeePerGas`, `maxTotalCostWei`, `expirySeconds`, `enabled` | The publisher's caps. Its address must equal `deployment.pricePublisher` and must differ from the operator's. |
| `planner` | the `PlannerSettings` fields | Minimum samples/duration/age, forecast horizon ceiling and haircut, minimum owner benefit, the 15 % operator cost buffer as `operatorCostBufferBps: 1500`, realization haircut, overlap and liquidity-fraction choices. |
| `pricing` | `kind: "pool_spot"`, `valuationBandBps`, `wrappedNative`, `gasPools{quote currency → pool key}`, `gasPriceBufferBps` | The anchor is the pool's own spot at the observed block, the price the guard binds: no external reference, no average, no volatility gate (the owner's decision of 22 September 2026, [study](../reports/NEW_TOKEN_AUTOMATION_STUDY_2026-09-22.md)). The planner values the other currency at the spot ± `valuationBandBps`, a few basis points of conservatism; what the execution may meet is bounded by the owner's impact and slippage limits. Gas converts one to one when the quote is ETH or `wrappedNative` (WETH, `0x0bd7d308f8e1639fab988df18a8011f41eacad73` on 4663); any other quote currency needs a native/quote pool in `gasPools`, read at the observed block and rounded against the operator by `gasPriceBufferBps`, or the evidence is unqualified (`gas_price_source_missing`). The key is any v4 pool's, `{currency0, currency1, fee, tickSpacing, hooks}`: the pool is only read, so a hook or a dynamic fee is admitted. For USDG, the ETH/USDG pool the [new-token census](../reports/NEW_TOKEN_AUTOMATION_STUDY_2026-09-22.md) valued ETH with, as its `Initialize` event on the project node gives it (id `0xbac3aa3b…4bde551`): `{"currency0": "0x0000000000000000000000000000000000000000", "currency1": "0x5fc5360d0400a0fd4f2af552add042d716f1d168", "fee": 8388608, "tickSpacing": 10, "hooks": "0x06a889870c8f83640d6816319f72e2aa579b6080"}`. |
| `swapCap` | `depthMultiplierBps` (1–10000), `windowBlocks` (1–256) | Every compound swap of every vault in one pool, over `windowBlocks`, stays below fee × depth × the multiplier. Depth is the least running average of L × √P from the spot to the owner's impact bound in the swap's direction, walked tick by tick; the fee is the lower direction's, protocol fee included. 10000 is the break-even of a push-and-restore sandwich; a pool whose other liquidity is one party's can take less (see the limitations). |
| `gas` | `publishGasUnits`, `executeGasUnits{direct,swap,mint,fund}`, `priorityFeePerGasWei`, `basePriceBufferBps`, `l1DataComponent` (`node_interface` \| `attested_none`), `operatorMinimumBalanceWei`, `publisherMinimumBalanceWei` | Units measured on the deployed V1 contracts ([22 September record](../reports/GAS_UNITS_V1_2026-09-22.md)): publication 157,278; direct compound 1.07–1.18 M (general path; the NET path ran at 1.01 M); swap 1.38 M from the cycle's own plan; successor MINT 1.65–1.90 M; redirect (`fund`) 1.30 M; the record suggests each maximum plus 10 %. The [gas funding study](../reports/GAS_FUNDING_STUDY_2026-09-21.md) holds the price history. Production uses `node_interface`; `attested_none` is for chains without one. |
| `destinations` | `maxLiquidityIncreaseBpsOfActive`, `maxLiquidityIncreaseAbsolute`, `competingLiquidityHaircutBps`, `totalLiquidityMarginBps`, `activeFractionHaircutBps`, `successorActiveFractionBps`, `exposureLossBps`, `swapFractionsBps`, `minimumSwapFractionBps`, `quoteSlippageBps`, `maxSimulationSteps` | The conservative bounds the planner's `DestinationEvidence` and `SwapQuote` need. `successorActiveFractionBps` is an explicit operator assumption for ranges that are not active yet. |
| `history` | `samplerVersion`, `sampleIntervalSeconds`, `maximumSampleGapSeconds` | A gap above the maximum, or a zero-liquidity reading, starts a new measurement epoch instead of counting an uncovered interval. |
| `plan` | `deadlineSeconds`, `maxGasCostWei`, `preferNetPath`, `liquiditySlackBps` | The plan's price band is the owner's `maxPriceImpactBps` itself, computed with the routing helper's rounding, so the band, the swap's price limit and the engine's impact check are one bound; the service keeps no narrower band. The deadline is capped by the owner's `maxObservationAgeSeconds`. The slack is what the plan keeps back from the planner's exact sizing so the execution's rounding and its own swap's price shift fit inside the caps; a swap plan is sized at the price the swap leaves and must consume the whole output, else the next candidate is tried. |
| `scheduling` | `workerId` (a fixed UUID per host, so a restarted service resumes its own leases; `null` only for evaluate-only use), `evaluationIntervalSeconds`, `minimumBackoffSeconds`, `maximumBackoffSeconds`, `leaseSeconds`, `publicationWindowSeconds`, `maxPublicationsPerWindow`, `publicationWaitSeconds`, `executionWaitSeconds`, `maxSourceBlockAge`, `cycleBudgetSeconds`, `jitterBps`, `latencyTargetSeconds`, `failureBackoffAfter` | `maxSourceBlockAge` must leave room inside the guard's 255-block window for publication and execution; the [price-band measurement](../reports/PRICE_BAND_QUALIFICATION_2026-09-21.md) saw 256 blocks pass in 15–37 s. It is also the hard stop on latency before anything is paid: at about ten blocks a second, 50 blocks is the study's five seconds. `jitterBps` randomizes every wait by up to that share, so nobody can tell when a sequence next observes. `latencyTargetSeconds` is what each cycle's measured latency is reported against (`withinTarget`); the study's target is five seconds from the observed block to the execution, ideally two. After `failureBackoffAfter` consecutive paid failures the wait doubles per failure, up to `maximumBackoffSeconds`; a completed cycle resets the count. |
| `finality` | `publicationConfirmations` | Blocks behind the head before an included publication is used. |
| `ledger` | `indexer` (`inline` \| `external`), `maxBlocksPerPass`, `maxLogsPerPass` | Who reads the vault's fee events into the ledger. `inline`: every pass reads the finalized blocks past the sequence's cursor before evaluating, so the service user must also be mapped to `domino_execution_ledger`. `external`: a separate `index` run does, and the cycle only refuses to act while an exception is unacknowledged. |
| `paused` | bool | A file-level pause; the database `controls.paused` switch is the runtime one. |

`backend/tests/automation_fixtures.py::sample_config` shows the complete shape with test
values. They are not production values.

## Installation

1. Install with [`scripts/staging/install_automation.py`](AUTOMATION_INSTALL.md): it
   places the source release, the `domino-automation` user, the off unit, migrations
   `028_automation_cycle.sql`, `029_ledger_index.sql` and `030_swap_exposure.sql` (after
   the financial upgrade's 015 and 019; 028 creates the `domino_execution_publisher`
   role, 029 adds the ledger reader's tables to the existing `domino_execution_ledger`
   role, 030 the pools' shared swap budget and the failure count) and the peer
   mappings from the service user to `domino_execution_worker`, `domino_execution_signer`,
   `domino_execution_publisher` and `domino_execution_ledger`. A ledger that
   already holds lots from before the reader existed is read from an explicit block
   once: `index --from-block <first execution block>`; otherwise the reader starts at
   the finalized head of its first pass.
2. Place the configuration and the two key files under the private directory. The
   publisher key must be a different key from the operator's, funded manually with
   ETH by the company, and the guard's current `publisher()` must be its address (the
   guardian rotates it with `proposePublisher`/`acceptPublisher` when it is not).
3. Check the profile without keys: `python backend/automation_cli.py --config <file> status`.
   It derives every sequence's admission from chain state and reports balances, the
   latest sample age and the last cycles. `evaluate` runs the planner and records a
   decision without a transaction.
4. Run one pass with keys: `run-once`. It first drives any live publication of the
   publisher to a receipt, then evaluates and, when eligible, publishes and executes.
5. `serve` loops over the admitted sequences, honouring each one's due time and backoff:
   a sequence that is not due and has nothing open is skipped without a lease or an
   evaluation, and the loop sleeps until the earliest due time (at least one second, at
   most `evaluationIntervalSeconds`). Due times carry the jitter. It stops cleanly on
   `SIGTERM`. `run-once` and `evaluate` always evaluate. Install it as a systemd unit with the same hardening
   as the other financial services (`upgrade_financial.unit_text`), `IPAddressAllow`
   limited to the node's tunnel, no environment fallback.

## How a pass runs

1. Lease the sequence (`sequence_state`, fenced like intents). A second worker gets
   `execution_lease_busy` and does nothing.
2. Resume an open cycle if one exists: a persisted intent is reserved, a signed
   publication is sent or checked, a submitted execution is stepped through the
   executor's journal. No step is repeated; the journals decide.
3. Read the vault's fee events from the finalized blocks past the sequence's cursor
   (`ledger.indexer: "inline"`; an external `index` run otherwise). An owner withdrawal
   becomes a debit on the ledger's lots, the oldest available lot first; our own
   reconciled executions are verified against the journal; any other execution is
   recorded as an exception and the sequence is suspended (`ledger_exception`) before
   anything is evaluated.
4. Evaluate: sample the pool at the head, read the vault at that block, offer
   the ledger's lots only where the vault's fee balances agree with them, build evidence,
   run the planner, record the decision.
5. Wait costs nothing. Eligible and allowed (not paused, not suspended, publication
   budget left, both signers above their minimum balance), the fast path: at a fresh
   head re-read only the pool, the vault and the ledger, re-quote only the destinations
   the evaluation found eligible (the samples are the ones just read), re-plan, build
   and prove the `ExecutionPlan`, take a swap's share of its pool's cap (refused:
   `swap_cap_exhausted`, before any intent exists), compute the anchor's id, persist
   the intent with that id, reserve, then publish, wait for inclusion inside the
   source-block window, then let the executor qualify, sign, send and reconcile.
6. Record the cost (publication and execution gas from receipts) and the latency on the
   cycle: the source block and its timestamp, the wall-clock milliseconds of each phase
   of the pass that acted (`evaluatedMs`, `plannedMs`, `persistedMs`, `reservedMs`,
   `publicationSentMs`, `publicationIncludedMs`, `executionSentMs`), the blocks from the
   source to the publication and to the execution, the execution's chain seconds after
   the source and whether that met `latencyTargetSeconds`. Move the sequence's waiting
   interval to the receipt's block, release the lease with the next due time.

Every refusal is a reason on the cycle row (`cycles.reason`) and in the CLI output:
`replan_wait`, `swap_cap_exhausted`, `swap_cap_unmeasured`, `publish_publisher_source_window`,
`publication_expired`, `anchor_revoked`, `price_outside_plan_band`, `plan_expired`,
`authority_changed`, `qualify_<executor code>` (the executor refused for a reason it
reports only as a sanitized code), `funding_required_publisher`, `execution_reverted`,
`execution_reorged`, and so on. Each decision also records the pool's swap cap per
direction with the share other swaps hold (`swapCap`), and the publications a completed
cycle is expected to take (`expectedPublicationsPerCompletion`, from the last 20 paid
attempts: attempts + 1 over completions + 1).

## Failure behaviour

| Situation | Behaviour |
| --- | --- |
| Gas too high or revenue insufficient | The planner's operator gate fails; the cycle records `wait` with the candidate economics; nothing is published. |
| A signer below its minimum balance | `refused` with `funding_required_<role>`; reconciliation of open work continues. |
| No gas pool for a non-ETH quote currency, an empty gas pool, node interface unavailable | Evidence unqualified with the reason (`gas_price_source_missing`, `gas_price_unavailable`, `gas_unavailable`); the planner waits. Never zero-filled. |
| The pool's swap cap spent by other swaps in the window | Swap quotes above what is left are not offered; the direct addition stays open and the surplus waits. Two vaults racing for the rest: the second's reservation is refused under the pool's lock, `swap_cap_exhausted`, before any intent or transaction. A cap the walk could not measure within `maxSimulationSteps` offers no swap. |
| Repeated failed attempts on a pool (paid publications the guard or engine then refused) | Each is counted (`consecutive_failures`); past `failureBackoffAfter` the wait doubles per failure up to `maximumBackoffSeconds`, and the operator's expected cost carries the publications a completion is expected to take. A completion resets the count. |
| Anchor expired, revoked, from another block, or the price left the plan band | Named by the cycle's read-only pre-check (`anchor_revoked`, `price_outside_plan_band`, `plan_expired`, `authority_changed`) or refused by the executor's qualification, in both cases before the key is used; the unsigned intent is cancelled, the cycle is `abandoned` with the reason, the publication's cost stays on record. |
| Source-block window lost before publication | `publish_publisher_source_window` or `source_window_lost`; no transaction. |
| Broadcast reply lost | The publisher row becomes `broadcast_unknown`; the next check finds the receipt or re-sends the same bytes. The executor keeps its own ambiguity handling. |
| Process crash after a publication or execution was signed | The next pass resumes from the journals: same bytes, same nonce, one receipt. |
| Two workers | One lease per sequence; the intent store's fence and the executor's journal still guard the plan and the nonce. |
| Execution reverted | `execution_reverted`, reservations released by the executor, backoff. |
| Reorg after a completed cycle | The ledger and the vault disagree; the executor re-verifies the recent effects, records `reorged`, and the sequence is suspended (`execution_reorged`) until an operator reconciles. |
| Owner pause, revocation or policy change | The planner waits (`paused`, `custody_or_operator_unavailable`) or the executor refuses (`execution_policy_changed`); a persisted intent is cancelled while unsigned. |
| Owner withdraws fee reserves | Until the withdrawal's block is final the vault and the ledger disagree: the planner waits (`ledger_chain_mismatch`) and the executor confirms the recent effects are still canonical. Once final, the reader records the withdrawal as a debit on the lots of that source and currency, and the next pass offers the reduced lots. What the ledger's lots cannot absorb stays on the row as unattributed, and the disagreement stays visible. |
| A fee event of an execution that is not a reconciled effect of ours | Recorded as `foreign_execution` (never signed here) or `unreconciled_execution` (signed here, journal not reconciled), with the transaction and its events on record; the sequence is suspended (`ledger_exception`). The operator records what the evidence supports, then `acknowledge --sequence <owner:vault> --exception <id> --reason <r>` and `unsuspend`. An own transaction still in the journal's pending states holds the reader before its block instead. |

## Activation

Deploying the contracts did not enable this. To activate, in order and recorded:

1. A verified production configuration (this document's table), with a gas pool for
   every non-ETH quote currency and the gas units re-measured on the deployed contracts.
2. Migrations 028, 029 and 030 applied and the four roles mapped on the host.
3. Both keys placed and funded; the guard's publisher equal to the publisher key.
4. `status` and `evaluate` clean for every admitted sequence over a measurement window;
   decisions recorded as `wait` with reasons that make sense.
5. A first controlled scope (one sequence, `maxPublicationsPerWindow` small), `run-once`
   by hand, the receipt reconciled, the cost checked against the estimate.
6. Only then `serve`, and only then a frontend or profile may say the automation is
   operating. `executionAvailable` in the public profiles is a separate, explicit change.

## Limitations recorded with this delivery

- The ledger is fed by the executor's reconciliation and by the reader of the vault's
  fee events (`automation_ledger.py`). The reader represents owner withdrawals; it does
  not represent an execution it did not reconcile, because the chain alone does not
  say which lots and which lineage that execution consumed. Such a transaction is an
  exception that suspends the sequence for an operator. Withdrawals before the reader's
  cursor started are read only on an explicit `index --from-block`.
- Prices come from the pool itself, by the owner's decision. A move before the
  observation is not detected: the anchor is born where the pool is. What bounds a
  manipulation is its cost: the swaps of all vaults in a pool stay under fee × depth
  over the window, where a push and its restore cost more in fees than they could take.
  An attacker who is also most of the pool's other liquidity gets back the LP share of
  the fees it pays, so its cost is lower by that share; lower `depthMultiplierBps` for
  pools whose liquidity is one party's. V1 serves hookless pools only.
- Latency on the real node and sequencer is not a test result: each cycle records it,
  from the first manual pass on. The study's success rates by latency are in
  [NEW_TOKEN_AUTOMATION_STUDY_2026-09-22.md](../reports/NEW_TOKEN_AUTOMATION_STUDY_2026-09-22.md).
- Swap quotes are exact for the pool state at the observation block, with the pool's
  protocol fee composed into the swap fee as the core does (the WETH/USDG pool charges 52
  pips each way on top of its 200-pip LP fee); a dynamic-fee pool is refused. A price move
  before execution is caught by the engine's bounds, not predicted.
- The integration is proved on Anvil with a fixture node interface and a 20 % guard band; timing on the real sequencer, the real 50 bps band and the real L1
  data component are activation measurements, not test results.
