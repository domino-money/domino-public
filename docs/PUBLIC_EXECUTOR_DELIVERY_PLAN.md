# Public executor delivery plan

Process update, 12 September 2026: [EXECUTION_POLICY.md](EXECUTION_POLICY.md) supersedes this plan's historical ownership, issue/PR and approval sequence. All authorized collaborators may execute any work package, including its consumers and deployment. Use the technical dependencies below; planning is not a prerequisite to useful implementation.

11 September 2026 · reviewed ordering in #84; E1 implementation candidate in [execution-v1](execution-v1.md) · source baseline `69359d28c88564dd47d2446f606972df2b88ff8e`

Build the public executor in seven independently reviewable work packages, starting with an offline sequence/action/accounting contract. None requires the Cloudflare Tunnel token. Real activation still requires the existing financial evidence gates; starting the backend or accepting a wallet session cannot activate automation.

This plan implements the ordering requested after the development-status review. It adds no executable code, API route, database migration, deployed ABI, fee default or financial permission. The proposed record names below are a discussion contract, not accepted wire fields. [Alpha scope](../ALPHA_SCOPE.md), [pricing](../PRICING_POLICY.md), [reinvestment](../REINVESTMENT_POLICY.md), [security](../SECURITY_SPEC.md) and the [migration assessment](EXECUTOR_MIGRATION_ASSESSMENT.md) remain authoritative.

## Existing work and the boundary to reuse

| Existing source | Reuse | Do not infer |
| --- | --- | --- |
| [v4 math](../backend/v4_math.py), [position accounting](../backend/position_accounting.py), pinned v4 differential fixtures | Exact token/liquidity math, tick conversion and principal/earned-fee distinctions | Historical core-position liabilities prove a wallet's spendable fee reserve |
| [FeeAccounting](../contracts/src/FeeAccounting.sol), [PolicyValidation](../contracts/src/PolicyValidation.sol), [draft interface](../contracts/src/IDominoVaultDraft.sol) | Floor-rounded consumed-fee split, independent geometry, caller/version/nonce requirements | Synthetic policy tests prove custody, actual exits, fee collection or swaps |
| [Session contract](../api-contracts/session-v1/README.md) and wallet allowlist | Existing owner authentication and revocation boundary | Login is NFT approval, automation consent or on-chain operator authority |
| [Deposit contract](../api-contracts/deposit-v1/README.md) and receipt/admission modules | Owner-bound immutable selections, raw amounts, checked PoolKey, durable issued-step evidence, receipt/admission patterns | Its owner-wallet nonce stream is the shared operator nonce allocator; deposit principal is earned fees; deposit admission qualifies automation |
| [Onboarding contract](../api-contracts/onboarding-v1/README.md) | Preview identity, explicit bounds and the separate owner-funded setup flow | Provider preview calldata is an approved automated route or signing request |
| [Candidate tenant schema](../backend/schema.sql) | Requirements for sequences, source lots, intents and isolated nonce records | It is deployed or complete. It needs manager identity, custody/source lineage, state nonce, recovery states and reviewed role/migration design |
| [Executor assessment](EXECUTOR_MIGRATION_ASSESSMENT.md) | Strategy mapping, C01–C11, D01–D17 and EX-01–EX-10 evidence IDs | Personal runtime, keys, deployed settings or historical test counts are public implementation evidence |

No personal-bot module or runtime is imported. Public code is the implementation starting point; the assessment preserves the already authorized source provenance.

## Shared backlog and technical dependencies

Any authorized collaborator or agent may implement E1–E7, their frontend consumers and operational integration. There is no fixed implementer or reviewer. Reuse existing work and technical interfaces; issues and PRs are optional records, not prerequisites. Split work only when that helps deliver useful progress.

The initial inventory contained no public-executor implementation issue. This plan is now tracked in [#84](https://github.com/domino-money/domino/pull/84), with E1–E7 in [#85](https://github.com/domino-money/domino/issues/85), [#86](https://github.com/domino-money/domino/issues/86), [#87](https://github.com/domino-money/domino/issues/87), [#88](https://github.com/domino-money/domino/issues/88), [#89](https://github.com/domino-money/domino/issues/89), [#90](https://github.com/domino-money/domino/issues/90) and [#91](https://github.com/domino-money/domino/issues/91), respectively. Their dependencies govern integrated completion; creating them does not start every package. [#6](https://github.com/domino-money/domino/issues/6) is closed and delivered the migration assessment only. Keep existing work in its own issues: [#4](https://github.com/domino-money/domino/issues/4) price qualification, [#5](https://github.com/domino-money/domino/issues/5) bridge, [#14](https://github.com/domino-money/domino/issues/14) wallet consumer, [#49](https://github.com/domino-money/domino/issues/49) wallet admission and [#45](https://github.com/domino-money/domino/issues/45) integration/deployment. Reuse frontend issues #2/#3/#13 and PRs #70–#72 without duplicating them; their historical author does not reserve the area.

| Order | Work package and concrete output | Depends on | Completion evidence |
| --- | --- | --- | --- |
| E1 | **Sequence, action and fee-origin contract.** Closed internal models, deterministic identity/encoding rules, accounting specification and synthetic fixtures. No network, database, signer or browser endpoint. | Existing approved specifications; no operational dependency | Reject cross-owner/sequence/currency/manager references, stale versions/nonces, raw-unit overflow and duplicate source allocations. Cover fee attribution and charged converted residuals with an independent conservation oracle. Publish exact candidate version, fixture digest and unresolved choices for review. |
| E2 | **Owner-bound vault/factory and real recovery.** Atomic versioned initialization, root permission checks, actual child/reserve custody, membership and owner-only exits. Retain policy guards. Operator authority is narrow, revocable and has no wallet-pull/principal-withdraw path. | Reviewed E1 identity/custody model | Two owners and multiple sequences; first-caller/front-run initialization rejection; donations excluded; real token/NFT transfers; root transfer/revocation; pause without blocked exits; no arbitrary recipient/call; replay/nonce exhaustion; callback and reentrancy tests. No automation enabled merely by passing these tests. |
| E3 | **Pure planner and dynamic economics.** Coherent observations produce `wait`, self-compound, existing-destination or successor candidates. Price orientation, source routing and direct/swap/wait comparison are deterministic; proposed output is not calldata. | E1; qualified observation adapters for real execution | Boundary and reversed-order geometry; direct, smaller/full swap and waiting alternatives; separate owner-benefit and operator-cost gates; stale/missing data; no fees inferred from token appreciation; single-read failure retains valid history and elapsed wait; policy/depth/gas changes cause re-evaluation. All real eligibility remains false without qualified inputs. |
| E4 | **Direct fee-only execution.** General collect/add self-compound first, followed by narrowly eligible netting with the same financial effects. Reuse exact arithmetic and enforce proven fee budgets on-chain. | E1 + E2; E3 candidate checks | C01–C10 for actual balances/events and every revert; newly realized and previously waiting fees; full economically eligible balanced use without a 15% growth cap/reserve; service cut once; general/net parity including fees realized by netting; no silent fallback; actual gas comparison. Local/fork execution only. |
| E5 | **Durable intents, constrained signer and reconciliation.** Separate private execution store/roles, fenced work ownership, signer-wide nonce reservations, independently rebuilt typed transactions, replacement/reorg/restore recovery and activity receipts. | E1 for store design; E2/E4 for transaction reconstruction and integrated tests | Forced tenant isolation under actual service roles; two owners sharing one signer; crash at each persist/sign/send boundary; ambiguous broadcast; bounded replacements; canonical reorg; restore with unresolved signed attempts; one financial effect and charge per canonical intent. API cannot request raw signing. No production key is needed for the implementation suite. |
| E6 | **Domino destination funding and successor mint.** Source-specific routing, deterministic eligible destination, unique successor intent, bounded geometry/membership and real child mint/receipt. | E1–E4; E5 recovery before integration | D01–D06 and D09–D17: self routing, threshold, existing successor, below/above range, no forced downward ladder, no duplicate child after races/unknown sends, no recursive rerouting of incoming fees, cap behavior, fixed custody, withdrawals and per-source conservation. No new underlying pool is created by a Domino step. |
| E7 | **Bounded fee-funded swaps.** Typed admitted route adapter and on-chain input/output/price/deadline limits; converted-lot accounting feeds self-compound or Domino without another service fee. | E1 + E2 + E3 + E4; E5/E6 for integrated paths | Both beneficial and rejected swaps, smaller swap beating a full swap, insufficient fee-funded quote asset, stale/manipulated quotes, output/impact violations, donations and principal excluded, exact allowance cleanup, failed swap rollback, converted residual used later without a second charge. Unsupported partial fill remains rejected until its accounting is separately qualified. |

**Parallel work after E1:** E2 custody, E3 pure planner and the non-signing store portion of E5 can proceed in isolated worktrees with one writer per file. E4's general path precedes netting optimization. E6's no-swap cases can be implemented before E7; neither is a substitute for the functional alpha's full admitted swap paths. Do not make a complete lifetime pool backfill a dependency of any wallet onboarding or executor task.

## First implementable increment: E1

E1 turns the following candidate into strict internal models and reproducible fixtures, then stops at a reviewable boundary. Proposed new files are `backend/execution_models.py`, `backend/tests/test_execution_models.py`, `backend/tests/fixtures/execution/` and a short exact-unit accounting specification alongside this document. These are proposed paths, not files supplied by this planning change. A shared browser contract package comes later with the compatibility notice; no new `api-contracts/` version is claimed here.

The increment must supply valid self/redirect/mint/wait fixtures plus negative cases, a canonical encoding/hash specification with cross-language golden vectors, and a separate transition/conservation oracle that does not merely reproduce the implementation. Include both native/erc20 currency identities, reversed token ordering, multiple owners, two sequences owned by one wallet and source/destination cross-links. It needs no VM, Cloudflare, provider credential, transaction, signer or production SQL migration.

Resolve the candidate model details in the implementation before downstream code relies on them; no separate reviewer reply is needed. Numeric gas/exposure/sequence caps and economic horizons remain named **unselected** release settings; fixture values are synthetic and never become implicit deployment defaults.

## Candidate internal data contract

**Status: proposed semantics, not a published API or final Solidity ABI.** Preserve existing field names when referencing existing contracts: `PoolKeyModel` uses `currency0`, `currency1`, `fee_pips`, `tick_spacing`, `hooks`; the draft policy uses `serviceFeeBps`, `triggerDistanceBps`, `maxOverlapBps`, `minimumIntervalSeconds`, `maxPositions`, `version`, `paused`. New browser routes/fields require the separate [compatibility notice](API_COMPATIBILITY.md).

### Sequence and ownership

| Record | Required meaning |
| --- | --- |
| `SequenceIdentity` | Chain 4663; immutable owner; sequence ID; vault address and registered implementation version; verified PoolManager/PositionManager; full PoolKey and recomputed PoolId. No supplied symbol is identity. A draft/watch record can exist without a vault, but cannot produce an executable plan. |
| `PositionIdentity` | Chain + verified PositionManager + NFT token ID, associated pool, root/child role, parent relation and historical membership. A PoolId alone omits manager identity. Retain the core position identity separately when checking fee growth; do not substitute core caller for NFT owner. |
| `CustodyObservation` | Block number/hash; current NFT holder and individual approval; vault's recorded owner/operator authority and root/child membership. Proposed custody follows the existing design: root stays in owner wallet; child NFTs reside in that owner's sequence vault until direct withdrawal. Register only after coherent actual checks. |
| `SequencePolicy` | Existing draft fields plus separately versioned execution limits and fixed base/quote orientation. Trigger and overlap remain independent. Owner consent selects the actual operational limits and fee version; an admin does not silently change them. |
| `Observation` | One coherent block number/hash/timestamp; policy version/state nonce, current price/ranges, proven fee balances and source coverage. Separate current observation, historical samples and forecast assumptions. USD values are optional qualified annotations, never a spend balance. |

Root NFT transfer stops new automation; it does not transfer the old sequence owner's already tracked reserves or child NFTs to the new root holder. A new holder needs their own explicit registration/authorization. Historical source records remain recoverable after a child leaves active membership. Registration of an existing NFT must explicitly define entitlement to its currently uncollected fees through owner consent and on-chain measurements; never infer ownership of fees settled before registration from the current NFT holder. E2 must prove those transitions with actual asset effects.

### Original fees and converted balances

| Record | Required meaning |
| --- | --- |
| `FeeSourceIdentity` | Immutable owner + sequence + source PositionIdentity + full currency identity. The source remains the original source when its fees fund another position. |
| `FeeCredit` | A uniquely attributable collection/realization, raw units and transaction/event identity, observed block hash and canonicality. A reserve already recorded in the vault has a corresponding reconciliation reference. Source + transaction hash + log/event index + currency discriminates credits; block hash records fork observation without allowing double credit on re-inclusion. A pre-execution accrual estimate is not a realized credit. |
| `FeeAllocation` | The original credit/reserve provenance, currently available raw units, exact portion reserved for this intent and target. Reject duplicate sources/over-allocation and overlapping unresolved intents; release a reservation only on proven outcome or safe pre-sign cancellation. |
| `ConvertedBalance` | Input credit allocations, service-charge disposition, actual swap-in and swap-out raw amounts, unspent proceeds by currency and original source attribution. Already charged net proceeds remain distinct from uncharged original fees. Conversion does not reset charge status. |
| `ConsumptionReceipt` | Actual original gross consumed, protocol cut, swap legs, net liquidity contributions, remaining balances and fixed recipients, per currency/source. Receipt canonicality and finality are explicit; no cross-currency raw sums or fabricated net gas. |

The database describes provenance and reconciliation; the vault must establish and enforce its own fee-only balances. A client-supplied lot ID, a database balance or current `balanceOf` including donations is not on-chain spending authority. E1 specifies the minimum on-chain checkpoint/source state and the event-to-ledger mapping; E2/E4 implement and prove it. Imported principal, setup proceeds, donations, treasury revenue and owner withdrawals have different accounting classes.

On a no-swap path, for each currency and original source:

```text
prior tracked fee reserve + realized earned fees
  = net liquidity contribution + service cut + remaining tracked fee reserve

service cut = floor(original gross consumed × serviceFeeBps / 10000)
```

For swap paths add actual swap-in and swap-out legs on the appropriate currency sides, and preserve charge disposition for converted residuals. E1 must specify deterministic source allocation and rounding for mixed-source inputs/outputs, including which original units are consumed, and E7 must verify conservation through actual route effects. The output of a swap is not new earned income. Never charge the mode’s service fee on conversion output again or levy the assisted-setup swap tariff inside automation. Untouched fees and unconsumed original input remain uncharged; a fully reverted action advances neither charges nor intent consumption. Floor rounding at 49/50 base units under 200 bps remains the existing policy, not an automatic minimum-fee toll.

### Decision, financial plan and transaction attempt

| Record | Required meaning |
| --- | --- |
| `Decision` | Candidate `wait`, `compound_self`, `redirect_fees` or `create_domino`; observation, compared alternatives, bounded economic evaluation and machine-readable reason. These names preserve the draft SQL action vocabulary; `wait` is a decision only, never a signable intent. Waiting retains amounts, source and valid measurement history. |
| `ExecutionPlan` | Versioned plan identity bound to chain/vault/owner/sequence; action and selected path; expected policy version/state nonce; coherent source block/hash; source allocations; destination or parent/range; exact gross fee caps/minimum additions; price bounds; deadline; optional typed admitted swap legs. No arbitrary calldata, router, receiver or wallet debit. |
| `SuccessorIntent` | Logical parent-to-child identity plus selected range, policy/state observation and immutable plan. Proposed rule: one unresolved successor reservation per active parent/sequence and an explicit recorded child relation; changing policy/range must reconcile the prior reservation before replacement. Policy changes cannot evade duplicate protection by minting a different-range child while a prior send is unresolved. |
| `IntentState` | Durable immutable financial intent, versioned transitions and expected effects. Suggested semantic states: planned, reserved, signed, broadcast-unknown/submitted, included, confirmed, reconciled, reverted, attention, reorged or safely cancelled before signing. E5 freezes exact states and legal edges; they do not extend existing `deposit-v1` enums. |
| `TransactionAttempt` | Private signer identity, globally allocated chain/signer nonce, deterministic signed transaction hash, replacement ancestry, maximum cost reservation and observed outcome. Signed bytes stay in restricted storage for recovery, never public logs or browser responses. |

These are different identifiers: sequence ID, immutable financial intent ID, successor identity, vault state nonce, owner policy version, database optimistic version/fencing token and signer transaction nonce. Do not reuse the deposit owner's wallet nonce as a vault nonce. The same financial intent can have bounded replacement attempts sharing a signer nonce; a lost broadcast reply must never create a fresh nonce or successor by itself.

Each completed on-chain policy/pause/resume/withdrawal/automation mutation advances the vault state nonce exactly once, with no reuse/wrap; a revert does not. Owner registration/revocation and membership mutations must invalidate prior plans too. E1 defines nonce exhaustion as terminal for automation, with owner-only recovery still available; E2 must implement and prove that explicit terminal exception to the old synthetic harness. A database lease does not authorize an old worker after fencing. Reconciliation is reversible for noncanonical observations; resubmission requires canonical nonce, intent and asset evidence.

The final hash/domain encoding is an E1 deliverable, not selected by this Markdown. It must bind all financially material fields, reject ambiguous encodings and have independent golden vectors; a plain JSON hash or client-supplied digest is not accepted signing authority. The draft on-chain plan uses bounded integer types (including uint128 budgets and uint64 policy/state fields); E1 must enforce those ABI domains while keeping wire/raw quantities canonical decimal strings and must not silently narrow larger values.

### Economic and route authority

The planner compares direct, bounded swap and waiting over a finite disclosed horizon. Its record distinguishes conservative incremental owner benefit from realizable service revenue minus full operator costs. Qualified price/depth/source assumptions are required for live eligibility; an attributed pool APR, stablecoin symbol or several RPCs observing the same pool cannot provide them. A failing read can stop new sends without resetting otherwise valid accrual history or an already elapsed interval.

Proposed route data contains an admitted adapter/route version, registered currency path, exact fee-only input budget, minimum output, deadline and reviewed price/impact bounds. It contains no free-form call facility. On-chain executable guards and the independent signer must enforce the applicable bounds; an off-chain `impactPassed` boolean is not sufficient. The precise price-integrity reference and attainable on-chain price-impact guard remain E3/E7 review decisions for each admitted operation. If those cannot be established for a market, that operation stays unavailable.

Gas estimates and reservations include the complete chosen path. Follow [existing Nitro qualification](../reports/DEPOSIT_RPC_QUALIFICATION.md): the observed estimate bundles execution and data-posting gas; do not add the included component twice. Requalify the new executor's actual paths and distinguish gross from unavailable net realized cost. Operator gas covered by the mode’s 2%/4% cut is not deducted again from the owner's net liquidity addition.

## Functional-alpha dependencies outside the seven packages

These remain required by the approved scope; they are not silently dropped or counted as delivered by this plan:

- **Owner-funded setup:** complete assisted exact-input swap, the selected tariff under the approved 65 bps ceiling, existing-pool mint and advanced initialize-plus-first-liquidity with price/competing-initialization guards. Reuse the reviewed direct-deposit path instead of rebuilding it. Swap success followed by cancelled mint must remain recoverable without another charge. Native ETH/refunds and unsupported partial fills need explicit cases. The current preview/deposit contracts do not implement these additions; their future versioned issue must coordinate with Decimal's existing consumer.
- **Real data and public access:** continue #4/#5/#14/#49 and the staging release separately. Market reads require no wallet session, but remain behind the beta Access gate during the invited alpha; private settings also require an admitted wallet session. A private operator execution service is not an extra public Worker sign endpoint. The deferred Deposit Tunnel mapping is unrelated to local executor implementation.
- **Frontend activation and receipts:** after an exact contract notice/ACK, Decimal implements sequence cards, policy review, individual authorization, signed semantic amount receipts, waiting reasons and direct-recovery controls. Existing read/practice cards are not rewritten as live holdings. This plan creates no frontend assignment without that handoff.
- **Operational policy:** choose justified position/exposure/gas budgets, bounded observation/economic horizons, fee-recipient/rotation behavior, confirmations/finality assumptions and supported admission scope from test evidence. Three positions, the practice 15% gas buffer and integer type maxima are not approved universal deployment defaults.

## Evidence and the release boundary

Use the existing [EX-01–EX-10 checklist and D01–D17 matrix](EXECUTOR_MIGRATION_ASSESSMENT.md#release-checklist-and-evidence-records); do not create a competing definition of “audited” or reset passed historical receipts to a new version. Work packages produce evidence for those gates:

| Work | Existing evidence gates it supplies |
| --- | --- |
| E1 + E2 | EX-01 manifest inputs; EX-02 invariants; EX-07 ownership/isolation; EX-08 actual owner exits |
| E3 | EX-03 price/market assumptions; EX-04 strategy cases; EX-05 economics |
| E4 | EX-02 token accounting; EX-03 actual manager paths; EX-04 self/general equivalence; EX-05 gas |
| E5 | EX-06 recovery and EX-07 signing/application isolation |
| E6 + E7 | EX-02–EX-06 full Domino/swap behavior and EX-08 recovery after those paths |
| Integrated setup + public system | Complete remaining EX-01–EX-08 coverage; optional EX-09 review/audit with recorded scope; separately authorized EX-10 limited trial |

Review clarifications from #84: E3 supplies price/market assumptions and pure strategy evidence, not EX-03 pinned-fork qualification by itself. E6/E7 also require EX-07 independent typed-plan reconstruction. Frontend recovery controls alone do not close EX-08: owner exits must work with frontend, API, indexer and operator unavailable. E5's exit evidence includes key rotation, on-chain revocation, compromised-key response, documented recovery authority and a bounded gas-funded operator cohort separated from protocol treasury.

E2 review follow-up #101 adds concrete E4/E5 prerequisites: qualify the actual PositionManager's unsubscribe gas cap/callback behavior using the [E2 qualification checklist](PUBLIC_VAULT_E2.md#positionmanager-qualification-before-funding); preserve initial checkpoint preimages; combine immutable base/quote with stored limits for E1 policy hashing; implement a narrow expected-modify context before the vault modifies its own root; and treat current root permission as authoritative even when events or `rootArmed` are stale. Do not infer an approval-history epoch from revoke/reapprove reads. The current custody runtime leaves only 463 bytes below EIP-170, requiring a reviewed refactor/version before financial paths.

**Completion of E1 is a usable implementation handoff. Completion of E4 is an internal compound milestone. Neither alone proves the invited functional alpha works.** Record source/build/deployment/admission identities and actual behavior with proportional checks. Review and audit may support this work but are not mandatory human approval gates under EXECUTION_POLICY.md. Do not claim an audit or unperformed recovery test as completed.

No external audit, deployment, production signing or financial trial is scheduled or authorized by this document. E1 and the E2 custody foundation have now been integrated; #99 and #101 preserve their review follow-ups before affected integrations. E3/E5 can advance on reviewed identities without waiting for the Tunnel, while financial activation retains all release gates above.
