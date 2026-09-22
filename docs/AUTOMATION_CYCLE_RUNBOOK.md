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
| `backend/automation_evidence.py` | Price qualification against independent references, depth/activity bounds over the sampled window, exact swap quotes by walking the pool's initialized ticks, complete-path gas including publication and the L1 data component. |
| `backend/automation_plan.py` | The planner's candidate → the persistable `ExecutionPlan`, proved against `validate_candidate` and the V4 wire (`rebuild_v4`) before anything is stored; the anchor's exact on-chain id computed offline. |
| `backend/publisher_signer.py` | The restricted publisher: `publish(Observation)` for the admitted guard only, signed bytes persisted before any send, one row per observation id. |
| `backend/automation_store.py` | Sequence leases, cycle records, shared pool samples, operator controls, the ledger view offered to the planner (lots net of settled spends and recorded withdrawals). |
| `backend/automation_ledger.py` | The ledger's reader of the vault's fee events from finalized blocks, under the reconciliation role: an owner withdrawal becomes a debit on the ledger's lots, our own reconciled executions are verified, any other execution is an exception that suspends the sequence until an operator acknowledges it. |
| `backend/automation_cycle.py` | The orchestrator: observe → decide → reserve → publish → execute → reconcile, with restart-safe transitions. |
| `backend/automation_cli.py` | Private commands: `status`, `evaluate`, `run-once`, `serve`, `pause`/`resume`, `suspend`/`unsuspend`, `publications`, `index`, `ledger`, `acknowledge`. |
| `backend/migrations/028_automation_cycle.sql` | Tables, the `domino_execution_publisher` role and the guards. Applied with the automation activation, never by the disabled foundation or the financial upgrade. |
| `backend/migrations/029_ledger_index.sql` | The reader's cursors, withdrawals with their lot debits, exceptions, and the claim/spend guards counting the debits. Applied with 028; no new role. |

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
| `references` | `kind: "chainlink_usd_feeds"`, `feeds{currency → proxy, feedDecimals, heartbeatSeconds, description}`, `tokenDecimals`, `maxAgeSeconds`, `maxDivergenceBps`, `bandBps` | The pool spot is the anchor; it is qualified only when both currencies' feeds are fresh and agree within `maxDivergenceBps`. The native feed (`0x000…0`) is required unless the quote currency is native. Feeds known today: `chainlink_history.FEEDS` (ETH/USD, USDG/USD on 4663). |
| `gas` | `publishGasUnits`, `executeGasUnits{direct,swap,mint,fund}`, `priorityFeePerGasWei`, `basePriceBufferBps`, `l1DataComponent` (`node_interface` \| `attested_none`), `operatorMinimumBalanceWei`, `publisherMinimumBalanceWei` | Measured units ([gas funding study](../reports/GAS_FUNDING_STUDY_2026-09-21.md): publication 157,278; compound 1.16–1.18 M; swap 1.44–1.50 M; successor 1.74–1.90 M). Production uses `node_interface`; `attested_none` is for chains without one. |
| `destinations` | `maxLiquidityIncreaseBpsOfActive`, `maxLiquidityIncreaseAbsolute`, `competingLiquidityHaircutBps`, `totalLiquidityMarginBps`, `activeFractionHaircutBps`, `successorActiveFractionBps`, `exposureLossBps`, `swapFractionsBps`, `minimumSwapFractionBps`, `quoteSlippageBps`, `maxSimulationSteps` | The conservative bounds the planner's `DestinationEvidence` and `SwapQuote` need. `successorActiveFractionBps` is an explicit operator assumption for ranges that are not active yet. |
| `history` | `samplerVersion`, `sampleIntervalSeconds`, `maximumSampleGapSeconds` | A gap above the maximum, or a zero-liquidity reading, starts a new measurement epoch instead of counting an uncovered interval. |
| `plan` | `deadlineSeconds`, `priceBandSqrtBps`, `maxGasCostWei`, `preferNetPath`, `liquiditySlackBps` | The plan's own price band is never wider than half the owner's impact bound; the deadline is capped by the owner's `maxObservationAgeSeconds`. The slack is what the plan keeps back from the planner's exact sizing so the execution's rounding and its own swap's price shift fit inside the caps; a swap plan is sized at the price the swap leaves and must consume the whole output, else the next candidate is tried. |
| `scheduling` | `workerId` (a fixed UUID per host, so a restarted service resumes its own leases; `null` only for evaluate-only use), `evaluationIntervalSeconds`, `minimumBackoffSeconds`, `maximumBackoffSeconds`, `leaseSeconds`, `publicationWindowSeconds`, `maxPublicationsPerWindow`, `publicationWaitSeconds`, `executionWaitSeconds`, `maxSourceBlockAge`, `cycleBudgetSeconds` | `maxSourceBlockAge` must leave room inside the guard's 255-block window for publication and execution; the [price-band measurement](../reports/PRICE_BAND_QUALIFICATION_2026-09-21.md) saw 256 blocks pass in 15–37 s. |
| `finality` | `publicationConfirmations` | Blocks behind the head before an included publication is used. |
| `ledger` | `indexer` (`inline` \| `external`), `maxBlocksPerPass`, `maxLogsPerPass` | Who reads the vault's fee events into the ledger. `inline`: every pass reads the finalized blocks past the sequence's cursor before evaluating, so the service user must also be mapped to `domino_execution_ledger`. `external`: a separate `index` run does, and the cycle only refuses to act while an exception is unacknowledged. |
| `paused` | bool | A file-level pause; the database `controls.paused` switch is the runtime one. |

`backend/tests/automation_fixtures.py::sample_config` shows the complete shape with test
values. They are not production values.

## Installation

1. Apply `backend/migrations/028_automation_cycle.sql` and then
   `029_ledger_index.sql` to the financial database, after 015 and 019. 028 creates the
   `domino_execution_publisher` role and grants the worker its tables; 029 adds the
   ledger reader's tables to the existing `domino_execution_ledger` role. Map the
   service user to `domino_execution_worker`, `domino_execution_signer`,
   `domino_execution_publisher` and, with `ledger.indexer: "inline"`, to
   `domino_execution_ledger`, as the existing execution services are mapped
   (`scripts/staging/upgrade_financial.py` records the pattern); the roles are
   `NOLOGIN` group roles and these migrations do not change that. A ledger that
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
5. `serve` loops over the admitted sequences, honouring each one's due time and backoff,
   and stops cleanly on `SIGTERM`. Install it as a systemd unit with the same hardening
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
   budget left, both signers above their minimum balance): re-observe at a fresh head,
   re-plan, build and prove the `ExecutionPlan`, compute the anchor's id, persist the
   intent with that id, reserve, then publish, wait for inclusion inside the source-block
   window, then let the executor qualify, sign, send and reconcile.
6. Record the cost (publication and execution gas from receipts) on the cycle, move the
   sequence's waiting interval to the receipt's block, release the lease with the next
   due time.

Every refusal is a reason on the cycle row (`cycles.reason`) and in the CLI output:
`replan_wait`, `publish_publisher_source_window`, `publication_expired`,
`anchor_revoked`, `price_outside_plan_band`, `plan_expired`, `authority_changed`,
`qualify_<executor code>` (the executor refused for a reason it reports only as a
sanitized code), `funding_required_publisher`, `execution_reverted`,
`execution_reorged`, and so on.

## Failure behaviour

| Situation | Behaviour |
| --- | --- |
| Gas too high or revenue insufficient | The planner's operator gate fails; the cycle records `wait` with the candidate economics; nothing is published. |
| A signer below its minimum balance | `refused` with `funding_required_<role>`; reconciliation of open work continues. |
| Missing, stale or divergent references; node interface unavailable | Evidence unqualified with the reason; the planner waits. Never zero-filled. |
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

1. A verified production configuration (this document's table), with the reference
   feeds qualified per pool and the gas units re-measured on the deployed contracts.
2. Migrations 028 and 029 applied and the four roles mapped on the host.
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
- References are Chainlink USD feeds on the chain itself; pools whose currencies have no
  admitted feed never qualify, by design.
- Swap quotes are exact for the pool state at the observation block; a price move before
  execution is caught by the engine's bounds, not predicted.
- The integration is proved on Anvil with fixture feeds, a fixture node interface and a
  20 % guard band; timing on the real sequencer, the real 50 bps band and the real L1
  data component are activation measurements, not test results.
