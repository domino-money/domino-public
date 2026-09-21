# Engine and earned-fee accounting review — 21 September 2026

Reviewed checkout `7be7820`, production sources frozen at `ec2e9aa`. Production files were not changed.

## Result

No additional actionable defect in the engine's fee provenance, settlement, cumulative service charge, or transient execution state was confirmed by this work. This conclusion is limited to the reviewed paths and evidence below; it is not a whole-system security certification.

## Checks performed

- Read `DominoExecutionEngineV4` in full, its routing validations and both compound arithmetic helpers, and the vault's execution callbacks, balance ledger, transient fee accumulator, and owner recovery boundaries. Read the execution, pricing, and reinvestment policies and current V4 execution specification.
- Traced `GENERAL` and `FUND`: old original allocations become the initial spending cap; only measured new fees extend that cap. Collection checks unchanged liquidity, fee checkpoints, exact currency receipts, and settled PositionManager deltas. Required allocations run before optional collection caps.
- Traced `NET`: the increase uses only realized fees; netted cash plus liquidity plus service charge reconcile to newly realized fees; prior reserves remain in the ledger. The narrow path rejects charged budgets and spending beyond newly realized amounts.
- Traced `MINT`: mint recipient is the vault, the next NFT id and custody are checked, the new position is registered before settlement, and debt is paid from the same source ledger as an ordinary add. Principal increases never create an original fee credit.
- Traced swaps: exact input is required, output goes directly to the vault, source identity is preserved through charged balances, and output is not charged again. The swap and later direct add share the per-source cumulative original-spend accumulator.
- Traced final settlement: PositionManager and engine deltas for both currencies must be zero before and after the plan, and Uniswap's unlock has its own all-currency settlement gate. Vault debits conserve original/charged amounts and require actual backing after payments.
- Reviewed transient lifetime: the engine clears its execution context on success and consumes its callback commitment before external work; the vault clears compound/action/parent/entry flags on success. Cumulative fee slots include the strictly advancing state nonce. Root callback payload slots may retain data until transaction end, but their authorization flags are cleared and later modifications overwrite their payload before using them. A revert rolls back the corresponding writes.

## Added independent arithmetic checks

`contracts/test/audit_engine/EngineFeeConservationAudit.t.sol` adds:

1. A fuzz property comparing the cumulative inverse calculation against binary search over the independent forward fee function, including original/charged caps and balance conservation.
2. A fuzz property comparing NET and GENERAL arithmetic when there is no prior original spend.
3. A split at the 49-to-51 base-unit fee boundary, checking the cumulative floor charge across two uses of a source.
4. A fuzz property requiring full exact original/charged floors to remain consumable across cumulative fee-rounding plateaus.

Executed with:

```sh
node scripts/test-contracts.mjs --match-path test/audit_engine/EngineFeeConservationAudit.t.sol
```

Result: **4 passed, 0 failed, 0 skipped**, including **512 runs for each of the three fuzz properties**, with exit status 0. Compiler `solc 0.8.26` completed successfully using the repository profile. All seven production bytecode size gates also passed; engine runtime remained 21,899 bytes. The root's separate original-suite results record **15 suites / 228 passed / 0 failed / 0 skipped**, with all exit statuses zero in `suite-results.json`; this work did not repeat those suites.

## Limitations and existing residuals

- This work did not reproduce `NET` or `FUND` on a live Robinhood Chain pool. The audit package already records that gap; local official-contract fixtures do not close it.
- Existing vault state-machine invariants primarily exercise a test engine. They do not establish every combination of real engine collection, cross-source allocation, swap, and callback as an invariant.
- No new whole-plan fuzz harness, adversarial token implementation, or malicious native fee-recipient fixture was run. Exact-transfer behavior is required by the financial path; an unsupported token can make automation fail closed.
- Price-anchor sufficiency, publisher custody, live chain opcode behavior, and economic manipulation evidence were reviewed independently in the anchor workstream and are not cleared by this accounting review.
- The known pre-observation manipulation channel and concentration-related composition reverts remain as documented; no new claim about their economic safety is made here.
