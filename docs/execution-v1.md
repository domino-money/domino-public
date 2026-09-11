# Public execution records — E1 candidate

11 September 2026 · `e1-candidate-1` · issue [#85](https://github.com/domino-money/domino/issues/85)

This is an **offline internal candidate**, not a browser contract, signing API, deployed ABI or proof of market admission. [Models](../backend/execution_models.py), [accounting](../backend/execution_accounting.py), [fixtures](../backend/tests/fixtures/execution/e1-vectors.json) and the [Solidity verifier](../contracts/test/ExecutionEncoding.t.sol) implement E1 of the [delivery plan](PUBLIC_EXECUTOR_DELIVERY_PLAN.md). Existing `read-v1`, `session-v1`, `onboarding-v1` and `deposit-v1` remain unchanged. Decimal's frontend receives a separate compatibility notice before integration.

## Identity and record validation

| Identity | Bound data and meaning |
| --- | --- |
| Sequence | Robinhood 4663, immutable owner, registry-assigned nonzero sequence ID, vault, factory, implementation address/version, managers, full PoolKey and recomputed PoolId, immutable base/quote orientation and service-fee recipient. Sequence IDs are assigned/registered by E2; supplying one here proves no registration. |
| Position | Sequence digest, PositionManager NFT token ID, registration generation, root/child role and parent, aligned range, core position ID and registration-baseline commitment. Exactly one historical root; parent graph reaches it without cycles. Active and withdrawn membership are separate custody observations. |
| Fee source | Sequence digest, original position digest and original currency address. Sequence binds chain, owner and managers transitively. Redirecting fees or converting tokens never replaces this source. |
| Fee credit | Source, transaction hash and event index identify one realized credit. Amount, block number/hash and canonical/finalized status describe its reconciliation evidence. Re-inclusion has the **same credit ID**; inconsistent payloads must reconcile, never create an additional credit. Source already contains the original currency. |
| Financial intent | Domain-bound hash of the complete plan. It excludes database leases and signer transaction nonces. Replacement transaction attempts may preserve one intent. |
| Successor reservation | Hash of sequence and parent NFT ID. Range and policy do not change this reservation identity. One unresolved reservation per parent prevents duplicate mint attempts; E5 must enforce uniqueness atomically. |

All addresses and hashes use lowercase fixed-width hex; quantities are canonical unsigned decimal strings. Booleans and small integer metadata reject coercion. Budgets use uint128; versions, state nonce, generation, block and deadline use uint64; NFT IDs use uint256; price bounds use uint160 and valid v4 sqrt limits. Positive liquidity delta is below `2**127`, because the manager applies a signed delta. Ticks are signed int24 within v4 bounds and align to the registered spacing. Unknown fields, overflow, negative amounts, exponent notation, leading zeroes, duplicate/unsorted arrays and zero identity addresses are rejected. Native currency is address zero and is supported in currency fields; it is not a valid owner/vault/manager.

E1 accepts only canonical **hookless, fixed-fee** PoolKeys. It is not a claim that every v4 market or token is admitted. A future hook/dynamic-fee extension needs its own reviewed semantics and version. Watch/draft sequences without a vault are deliberately outside these registered execution records and cannot produce an execution candidate.

`corePositionId` is independently checked as `keccak256(positionManager[20] || tickLower[3 signed] || tickUpper[3 signed] || tokenId[32])`. It identifies the manager's core position, not the wallet owning its NFT. A baseline commitment must refer to explicit registration consent, current NFT custody, core fee-growth/liquidity checkpoints and treatment of already-uncollected fees. Those data and their actual asset effects are E2/E4 work; the digest alone is not proof.

## Observations and candidate actions

`Observation` binds one block number/hash/timestamp, policy, vault state nonce, authority generation, price, operator state, custody, fee lots and prospective accruals. Original lots include a reconciliation ID; converted lots retain original source identity plus current currency and charged status. Reserved amounts remain unavailable. Historical withdrawn members may retain attributable reserves, but cannot supply a new collection. A failed read yields no replacement of valid history; these pure functions mutate neither history nor balances.

`AccrualObservation` is an estimate of collectible fees against a checkpoint, **not a realized FeeCredit**. `CollectionBudget.maxGrossRaw` caps the portion of newly realized fees that may be consumed. Actual fees can increase before inclusion: E4 must measure collection, record the actual credit, consume at most the bound and retain the unconsumed excess as uncharged fees. It must not reject harmless excess solely because it exceeds the old estimate or silently charge it. Existing reserve allocations and newly collected consumption share the same source/currency fee floor.

| Action code | Meaning |
| --- | --- |
| 1, `compound_self` | Selected sources belong to the destination position. |
| 2, `redirect_fees` | Fund an existing active member; at least one selected source is another member. |
| 3, `create_domino` | `destination.tokenId` names the active parent. Create a new NFT in the same underlying PoolKey, at the bound range. It does not initialize another Uniswap pool. |
| `wait` | Separate decision record with a reason and observation reference; has no financial intent or signing method. |

Path 0 is general; path 1 is a restricted netting candidate: self only, new collections only, no reserve allocations or swaps. These structural checks do not qualify actual netting behavior. E4 must prove general/net parity and actual fee realization.

The plan binds observation/policy hashes, expected versions/nonces, source block, deadline, exact selected reserve amounts, collection caps, destination/range, liquidity increase, separate original-gross and already-charged budgets, minimum additions, sqrt-price bounds, total gas-cost ceiling and a single typed swap commitment. Disabled swaps have one canonical all-zero representation. Enabled swaps bind an adapter identity/version, route commitment, the registered pair, exact input and minimum output. They contain no router address, arbitrary calldata, recipient, owner-wallet debit or private key.

`validate_candidate` checks coherence, active custody, caller, caps, available unreserved amounts, versions, observation age, deadline, price bounds, gas ceiling and successor conflicts. Owner direct actions remain possible if the operator is disabled/unconfigured, subject to pause and other action constraints. A revoked operator cannot act. E1 also rejects using gross fees as a swap budget: fees are first grouped by original source/current currency, then floor-charged once. The swap draws from net units plus already-charged input. Minimum additions cannot reuse swap input or exceed the guaranteed remaining/output budgets.

**Successful validation is not execution eligibility.** E3 must enforce trigger/overlap/upside geometry in either orientation, source routing, interval/history, price integrity, direct/smaller-swap/full-swap/wait comparison and separate owner-benefit/operator-sustainability gates. E2/E4 must recheck authority and fee budgets on-chain. E5 must independently reconstruct the candidate, verify current canonical evidence, reserve balances and allocate its nonce. E7 must qualify/rebuild the registered route and enforce slippage/impact bounds, rather than trust the commitment or an off-chain Boolean. No candidate may be wired directly to a signer.

Fixture gas limits, four-position cap and economic horizons are synthetic. They are **not selected release defaults**. Changing any financial field requires re-evaluation and changes the relevant hash.

## Exact fee-origin accounting

`consume_allocations` groups all selected original lots by `(sourceId, currentCurrency)` for one action. It computes `floor(grossOriginalRaw * serviceFeeBps / 10000)` once per group. Existing `FeeAccounting.sol` rounding remains authoritative: at 200 bps, 49 raw units round to zero and 50 to one. Multiple credits of 49 from one source consumed in one action mean gross 98 and cut 1. Different sources or different actions retain their own floors; this is not a minimum-fee toll or permission to split uneconomic actions.

`converted_charged` means the original basis has already been evaluated, even if its service cut rounded to zero. Consuming it incurs no second service cut. Untouched original units remain uncharged. Principal, setup proceeds, donations, treasury income and withdrawals are not FeeLots. There is no fixed idle reserve or percentage-of-position growth cap.

For every original source and current currency, `reconcile_consumption` checks:

```text
original_before + charged_before + actual_swap_out
  = service_cut + actual_liquidity_added + actual_swap_in
    + original_after + charged_after
```

Raw quantities of different currencies are never summed. Every selected net input must be contributed directly or swapped; otherwise those original gross units were not consumed and must remain uncharged. Swap output may be contributed or retained as a **charged converted residual**. The exact-output observation is not new revenue. The helper accepts independent exact-input swaps with terminal input/output records; it does not allow recycling a swap's output into another leg in the same action, partial fills or arbitrary multi-action reconciliation.

Mixed-source swap output is attributed deterministically. Sort source IDs lexicographically; for output `O`, total input `T` and cumulative input `C[i]`, source `i` receives `floor(O*C[i]/T) - floor(O*C[i-1]/T)`. Shares sum exactly to actual output, including indivisible dust. Input aggregation is single-currency only. For inputs 99 and 199, output 997 splits 331/666 in that source order. Zero-sized individual shares remain attributable. This allocation convention needs the same implementation in E4/E7 receipts.

Example in exact base units: original A=1,000; consume 400; cut A=8; add A=100; swap A=292 into B=580; add B=500; retain charged B=80 and uncharged A=600. Later use A=50 and B=80: cut A=1, add A=49 and B=80, leaving uncharged A=550. B never becomes a new chargeable fee source. Operator gas is accounted separately, not subtracted again from the owner's contribution.

These helpers are pure calculations over supplied facts. They neither authenticate a receipt nor update durable credits, reservations or charge history. A revert/unknown broadcast supplies no committed successful consumption; E5 cannot release a reservation or infer a new charge, intent, nonce or successor merely from a failed response.

## Minimum on-chain checkpoint and event-to-ledger boundary

E2/E4 must establish, rather than trust a database claim:

1. Factory/implementation registration; immutable owner/sequence/PoolKey/managers/orientation/fee recipient; actual root authorization; actual child custody and source-registration generation/baseline.
2. Per-position core liquidity/fee-growth checkpoints and measured fee realization that exclude principal and unsolicited transfers. A bare vault `balanceOf` is never the fee ledger.
3. Per-original-source/per-current-currency available original and converted charged units, with sufficient attribution to preserve the service-cut floor and prevent spending the same units twice.
4. Atomic transition tied to intent ID, expected policy/state/authority generation, actual fee collection, source/currency gross consumed and cut, swap terminal input/output, liquidity contribution, residuals, destination NFT and fixed recipients. Reverts restore the whole transition.
5. Receipts identified by sequence/intent/transaction/event, with block hash and canonicality/finality retained separately. E5 persists/reconciles their exact effects under unique constraints; reorg rollback/re-inclusion cannot duplicate credits or charges. Actual receipt fields/ABI are frozen alongside the E4 implementation, not fabricated by this offline arithmetic result.

## Authority, nonce exhaustion and recovery

Sequence ID, policy version, vault state nonce, authority generation, database revision/worker fence and signer transaction nonce are different namespaces. Automation, policy changes, pause/resume, registration/revocation and membership mutations advance the vault state nonce once when successful; a revert does not. DB fencing and signer-global nonce allocation are E5 responsibilities, not fields callers can inject into this financial plan.

At `uint64.max`, state is **terminal for new automation, resume and plans**. It must not wrap or reuse a prior nonce. E2 owner-only recovery must remain possible in this terminal state, with explicit terminal recovery events and no return to automation. This is a required refinement of the old synthetic policy harness, which currently rejects *all* mutations at nonce exhaustion, including exits. E1 does not modify that harness or claim real exits are implemented. E2 must prove owner recovery with frontend, API, indexer and operator unavailable, including exhausted nonce and revoked keys.

Current holder/individual approval checks do not prove continuous historical authorization. The official v4-periphery [owner nonce bitmap](https://github.com/Uniswap/v4-periphery/blob/dce236d4e2057422d0791d9a973a58765eb46f65/src/base/UnorderedNonce.sol#L10) is a permit nonce, not an NFT transfer/approval counter; [approve](https://github.com/Uniswap/v4-periphery/blob/dce236d4e2057422d0791d9a973a58765eb46f65/src/base/ERC721Permit_v4.sol#L81) does not advance it. Away-and-back transfers or revoke/reapprove can restore the same current values. Vault pause/revocation/rearm must invalidate old plans explicitly. E2 must qualify the actual deployed manager and choose a transfer-continuity guard; requiring a vault subscription is a possible design because [transfer clears it](https://github.com/Uniswap/v4-periphery/blob/dce236d4e2057422d0791d9a973a58765eb46f65/src/PositionManager.sol#L549), but is not implemented/qualified here and does not detect every approval-history change. Do not claim protection from unobserved history based solely on this observation record.

E2 review handoff for E4/E5: [the current vault semantics](PUBLIC_VAULT_E2.md) preserve the original registration checkpoint separately from latest rearm observations. Reconstruct E1 policy hashes by including the vault's immutable base/quote orientation alongside the stored E2 limits. Root modifications, including manual fee-only collection, invalidate E2 authority; future vault-initiated modification requires a narrow expected-modify context. The signer must validate current root permission and vault policy/state/generation before execution, not merely cached events or `rootArmed`. A temporary external revoke/reapprove can remain invisible; explicit pause/revoke/rearm is the durable on-chain epoch. A nested owner unsubscribe during a native exit is a second mutation, so that transaction can advance the vault nonce twice. Receipt indexing must follow actual emitted state and receipt-local order.

## Canonical encoding

This is explicitly **EIP-712-like candidate encoding**, not a claim of standard generic `eth_signTypedData` compatibility. No signature operation is exposed.

- Each `Record.ABI` declares the complete ordered `(fieldName, ABI type)` list. Type strings, available in the fixture `encodingTypes`, are `ClassName(type field,...)` with no spaces except between type and name.
- Record hash: `keccak256(abi.encode(keccak256(UTF8(typeString)), field1, ...))`.
- Nested records occupy bytes32 and use their record hash. Hex bytes32/address values are decoded, not hashed as textual strings. Raw decimal strings are encoded as the declared ABI integer. Negative ticks use signed ABI encoding.
- Ordered record arrays occupy bytes32 and use `keccak256(abi.encode(bytes32[] recordHashes))`, **including ABI offset and length**. This differs from standard EIP-712 packed array hashing. Empty arrays also use this rule. Entries must be unique and sorted by the key defined in the model; callers cannot silently reorder them after intent creation.
- Domain is the standard `EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)` hash with name `DominoPublicExecutor`, version `e1-candidate-1`, chain 4663 and the sequence vault.
- Intent ID is `keccak256(0x1901 || domainHash || ExecutionPlanHash)`. Credit and successor IDs have separately named ABI type hashes declared in the model. Neither is a plain JSON hash.

The encoder rejects a model whose declared ABI fields do not exactly match its record fields. The checked-in fixture includes every type string and self/redirect/mint/native/reversed/other-owner/other-sequence/other-manager/charged-residual candidates. Solidity independently reconstructs representative complete plans from literals, including nested observations, signed ticks and arrays. Any model/encoding change updates the candidate version and vectors before downstream consumers rely on it; E1 review freezes the first candidate, not a deployed signing schema.

Run the targeted Python tests with `python -m unittest discover -s backend/tests -p 'test_execution*.py' -v`, check vectors with `python backend/tests/execution_cases.py`, and run Solidity checks with `npm run test:contracts`. Full PostgreSQL/EVM regression evidence and the exact fixture digest are recorded in the [implementation report](../reports/EXECUTION_E1_IMPLEMENTATION.md).
