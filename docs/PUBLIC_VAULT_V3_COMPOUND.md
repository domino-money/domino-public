# General same-position compound candidate

This is a new immutable version 3, for independent review. It is not an upgrade of an existing clone, a deployed executor, a signing service, a frontend capability, or a complete #97 performance history. Version 2 custody remains a separate historical implementation.

The #116 version-2 architecture recovered 4,136 runtime bytes before execution. The initial general financial implementation measured 29,653 bytes against the 24,576-byte EIP-170 limit. Version 3 therefore introduces a separately pinned `DominoCompoundEngine`, in addition to the stateless read helper. The engine orchestrates a single closed same-NFT action; assets, source balances, policy, authorization and recovery stay in the vault. The engine performs no delegatecall; the EIP-1167 vault clone delegates only to its immutable implementation. There is no upgrade, configurable engine, engine token allowance, or operator-selected recipient.

## Proposed size budget

The compiler profile stays solc 0.8.26, optimizer 200, viaIR and Cancun. The proposed V3 gate explicitly consumes part of V2's preparatory reserve: the vault must retain at least **512 runtime bytes**, and the engine at least **8,000**. EIP-170 and EIP-3860 limits are unchanged; all four artifacts and actual constructor arguments are measured. This gate change requires the same independent architecture review as the financial implementation.

The integrated candidate measures 23,841 bytes for the vault (735 remaining), 10,020 for the engine, 7,459 for the helper and 2,286 for the factory. Factory initcode including arguments is 46,182 bytes (2,970 remaining). The factory embeds its child construction payloads: spare engine runtime does **not** imply the same spare aggregate deployment capacity. Future Domino/swaps must pass both limits; this general-only candidate makes no claim that those future paths already fit. Deploying dependencies separately would be a further reviewed construction change, not an implicit fallback.

## Transaction

1. The owner or currently registered operator calls `compoundSelf(CompoundPlan)`. The vault enforces active root permission and nonterminal, unpaused authority. The fixed engine checks exact policy/limits versions, action nonce, authority generation, immutable position identity, current stored checkpoint, replay, deadline, interval and price bounds.
2. The engine opens one PoolManager unlock, bound to the exact typed plan. It observes the canonical core position and compares liquidity and last fee-growth values to the vault checkpoint. Both PositionManager transient currency deltas must start at zero.
3. A restricted vault callback calls PositionManager's zero-liquidity decrease and takes both fee currencies to the vault. Core liquidity cannot decrease. Actual vault balance increases must equal the floor-rounded core fee-growth accrual. Root subscriber callbacks must match the expected NFT, liquidity change and accrued amounts exactly once.
4. Another restricted callback increases exactly the planned liquidity in the same NFT. No swap, second NFT, wallet contribution, Permit2 approval or liquidity-from-deltas action is used. The engine reads the PositionManager's resulting negative currency deltas.
5. The vault applies per-source accounting, synchronizes each currency, transfers exactly the ERC20 debt to PoolManager (or supplies exactly the native debt), and calls `settleFor(PositionManager)`. The fixed service recipient receives the integer service cut. All manager deltas must be zero, source reserves must remain backed, and actual vault balances must reconcile.
6. The final core checkpoint must show the exact liquidity increase and unchanged in-transaction fee growth. Root permission and price bounds are checked again. Only a successful complete action consumes the intent, advances the nonce and sets the sequence's last-execution timestamp. A revert rolls back collection, fee charge, liquidity, reserves and timer together.

The vault accepts engine callbacks only while its authorized action is active, with the pinned caller hash and a strict collect → increase → apply → checkpoint sequence. The engine admits only exact EIP-1167 clones of its constructing implementation, and allows one active vault at a time. Direct calls to an implementation, a fake clone, an idle vault callback or another engine cannot provide authority.

## Amounts and service cut

All amounts are integer currency units. For each original source/currency:

- `originalBefore + realized = grossOriginalConsumed + originalAfter`
- `chargedBefore = chargedConsumed + chargedAfter`
- `grossOriginalConsumed + chargedConsumed = serviceFee + liquidityAdded`
- `serviceFee = floor(grossOriginalConsumed × serviceFeeBps / 10000)`

Already charged residuals are consumed first within their explicit budget. Only the remaining net requirement uses original fees. The minimal gross amount giving that net under floor rounding is `(net - 1) × 10000 // (10000 - bps) + 1` for positive net, and zero for zero net. A generic ceiling formula overcharges at integer boundaries. The maximum rate remains 200 bps; there is no 15% liquidity cap, minimum one-unit toll, fixed reserve, or repeated cut on retained unconsumed fees. Waiting and newly realized original fees are aggregated before the single per-currency floor.

This path cannot create converted charged balances; those remain reserved for separately verified conversion semantics. Root and child sources keep the E1 registration identity. Same-NFT compound spends only that NFT's original-currency source balances. Fees from other positions require the separately reviewed Domino action.

## What the receipt proves

The fixed engine emits `FeesRealized` and `SourceFeesApplied`, each with the vault and intent explicitly indexed. The vault emits `CompoundSelfCompleted`, which also lets the canonical journal discover the transaction and retain all engine logs in its full receipt. A verifier must bind both emitters and the indexed vault to the same admitted deployment and transaction. `FeesRealized` records the fresh pre-collection and post-zero-decrease checkpoint commitments. The first is not necessarily the earlier plan checkpoint: outside swaps may have advanced inside growth. `SourceFeesApplied` emits two ordered currency snapshots, including zero-valued snapshots; a zero snapshot is not a fee credit. `CompoundSelfCompleted` binds the domain-separated contract plan hash, position, actual before/after liquidity and resulting authority counters.

The contract plan hash is `keccak256(abi.encode(keccak256("DominoCompoundSelfV1"), chainId, vault, sequenceIdentityHash, plan))`. It is distinct from the E1 execution-plan digest. E1 has exact allocations, while this ABI has maximum budgets; a reconciler must not rewrite an immutable E1 plan when less is consumed. The dedicated receipt verifier handles receipt facts first, and only yields an E1 proof when exact semantics agree.

Fee realization is not proof of earning time or trading-income classification. Opening uncollected fees remain opening assets for performance, even when their owner consent permits a service cut upon later use. Uniswap pool donations also increase fee growth; distinguishing those from trading fees needs canonical pool-event attribution. Unsolicited transfers directly into the vault remain untracked and cannot fund this action. USD value, full L2 transaction cost, capital-time integration and complete 24h coverage are not inferred from these events.

## Backend receipt boundary

`backend/general_compound_receipts.py` provides `CompoundPlan`, `CompoundAdmission`
and `CompoundReceiptReconciler(rpc).reconcile(plan, admission, transaction_hash)`.
The caller supplies a reviewed immutable deployment admission and a known attempt;
browser-supplied runtime hashes are not admission. The verifier accepts only the
version-3 sequence and its eight distinct contract pins. It acquires exact calldata,
receipt, both event emitters, canonical block headers, finalized inclusion and
source/mined contract state, within request, receipt-size and log-count budgets.
It rechecks canonicality at the end. This is provider evidence, not an independent
consensus proof. Later state changes in the same block can make a receipt
unverifiable under this conservative before/after method; it does not guess an
intermediate state or publish partial effects.

Position, registration checkpoint and currency source identities are reconstructed
from their preimages, including the full PositionManager pool key and packed range.
Source conservation is necessary but insufficient: the verifier recomputes
charged-first consumption and the minimal gross inverse, including signed v4
realization/debt limits. A collection's origin uses its ordinal within the full
transaction receipt, not the block-wide log index. Positive collections of the two
currencies have distinct source identities even when emitted by one event.

The internal result separates source reserves, newly realized accrual, consumed
gross fees, service charge and added liquidity. Passing both `e1_plan` and
`observation` additionally invokes the reviewed E1 effect reconciler; a smaller
actual gross amount never rewrites the immutable allocation. The contract plan
hash and E1 digest keep separate domains.

Gas records preserve the payer, `gasUsedRaw`, `effectiveGasPriceRaw` and their
`receiptGasProductWei` product. That product is explicitly unqualified as the
complete L2 cost or its isolated execution component; neither an operator-funded
cost nor an unknown poster-fee component becomes an automatic strategy debit.
USD, earning timestamp and complete income coverage remain unavailable.

This module does not persist/apply receipts or start polling. Integrating the
version-3 admission and financial facts into #97's private canonical journal,
handling failed/unknown attempts in #89, and producing complete capital and
qualified event-time income are still required. The existing `performance-v1`
consumer payload and frontend remain unchanged. See the
[implementation evidence](../reports/GENERAL_COMPOUND_IMPLEMENTATION.md).

## Remaining release gates

- This general path needs independent financial/architecture review and exact deployed manager/token identity qualification. Local official-source tests are not proof that current mainnet bytecode matches their source pins.
- The source timestamp is an operator commitment. Solidity checks its bounded age plus the recent canonical block hash, but cannot independently read a past block's timestamp. The independent signer and receipt verifier must match the actual header. RPC evidence does not replace an economic admission policy.
- Token compatibility, conservative execution economics, total L2 gas-cost limits and signer reconstruction remain separate requirements. Absolute price bounds are not a proof of a qualified USD price or protection from every manipulated market.
- Crash-safe signing, broadcast/replacement and receipt application remain #89. Narrow netting needs its own parity and gas evidence; there is no automatic fallback into another action.
- Domino creation/funding and bounded swaps remain distinct typed financial implementations. This candidate alone does not enable the approved full alpha scope.
- #117 `performance-v1` remains unchanged: financial metrics stay unavailable until complete qualified financial history exists. No frontend API field is silently made available by this contract change.
