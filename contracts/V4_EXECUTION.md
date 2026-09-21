# V4 fee execution: E4, E6 and E7

Updated 21 September 2026. This candidate uses a separate V4 deployment; the
retired V3 contracts are not part of this release. No Robinhood funds,
wallets, deployments or provider qualification are implied by the local tests.
The economic policy remains [REINVESTMENT_POLICY](../REINVESTMENT_POLICY.md) and
[PRICING_POLICY](../PRICING_POLICY.md).

## Components and deployment order

The factory does not embed creation bytecode for the entire architecture.
Deployment is staged and its implementation may be finalized exactly once:

1. `DominoVaultFactoryV4(poolManager, positionManager, stateView, serviceFeeRecipient)`.
2. `DominoVaultReadHelper(positionManager, stateView)`.
3. `DominoRoutingHelperV4()`.
4. `DominoPriceGuardV4(pricePublisher, stateView, maxDeviationBps, guardian)`.
5. `DominoExecutionEngineV4(factory, readHelper, routingHelper, priceGuard)`.
6. `DominoVaultV4(factory, poolManager, positionManager, stateView, serviceFeeRecipient, readHelper, engine)`.
7. `DominoSetup(poolManager, positionManager, stateView, serviceFeeRecipient, setupFeeBps, tariffVersion)`.
8. The factory deployer calls `finalizeImplementation(implementation)` once.

These are the eight transactions in the [unsigned release](../docs/FINANCIAL_RELEASE.md).
After deployment, each NFT owner separately approves the predicted clone for
its root NFT and calls `createVault(InitParams, expectedOwnerNonce)`.

Before finalization the factory cannot create a sequence. It has no upgrade or
second-finalization path. Clones use fixed EIP-1167 bytecode. The engine accepts
only factory-registered clones with that exact runtime. The vault pins its engine
and read helper; the engine pins the read helper, routing helper and price guard.
All cross-component calls are normal typed calls or static calls. There is no
arbitrary delegatecall, router authority, approval, wallet pull or configurable
execution recipient. `execute` forwards only its exact selector/typed calldata to
the fixed engine, which rejects noncanonical encodings and trailing bytes.

The root NFT remains in the owner's wallet, individually approved/subscribed;
automatically minted successors remain in the vault. Existing ownership,
subscription invalidation, pause, operator-generation, nonce, deadline and direct
owner recovery rules remain. The V4 API omits the V3 manual `adoptChild` and
`validateAuthority` preview. It does not offer manual child imports; safe transfers
of unexpected NFTs fail. `recoverUnmanagedPosition` still recovers an unsafe
transfer, and root transfer/revoke, child withdrawal, fee withdrawal and untracked
currency recovery do not require the execution engine or an online operator.

## Closed execution wire

`execute(DominoExecutionTypes.Plan)` has four actions: `0=GENERAL`, `1=NET`,
`2=FUND`, `3=MINT`. The nested `authority` uses the unchanged V3 CompoundPlan word
order, but its four `maxOriginal*/maxCharged*` fields must be zero. Source budgets
are the only asset authority:

```
FeeBudget(sourceId, currency, maxOriginal, maxCharged, minOriginal, minCharged)
```

Budgets must be unique and sorted by `(sourceId,currency)`; collection references
must be unique and sorted by token ID. One operation admits at most 16 collection
references and 32 source/currency budgets. These are calldata/work bounds, not an
idle-fee percentage or a liquidity-growth cap.

For E1 reconstruction, `minOriginal` is the sum of exact pre-existing original
allocations and `maxOriginal-minOriginal` is the future collection cap.
`minCharged=maxCharged` is the exact allocation of pre-existing charged lots.
The old balances must cover these floors before collection. The operational
original ceiling starts at `minOriginal` and grows only by actual measured fees
from that source in the same execution, capped by the collection allowance.
A future collection cap cannot consume old unallocated fees.

The engine first satisfies all exact floors across sources, then considers
optional collection/converted-output capacity. Unconsumed floors, insufficient
fees, leftover AMM debt or a failed postcondition revert the entire operation.
A failed attempt cannot collect a service fee or consume the intent. Owner-signed
or operator-prepared plans therefore cannot succeed on-chain with an unconsumed
E1 allocation that would be rejected only afterward by receipt reconciliation.

The plan hash is
`keccak256(abi.encode(keccak256("DominoExecutionV4"), chainId, vault, sequenceIdentityHash, plan))`.
`backend/execution_v4.py` supplies the strict models, exact ABI encoder, route
commitment, admission and canonical receipt verifier. E5 reconstructs this wire
from its immutable E1 plan/observation; it does not accept browser raw calldata.

## Netting, successor routing and swaps

GENERAL realizes fees with a zero-liquidity decrease and TAKE_PAIR, preserving
principal, then increases the exact destination liquidity and settles each debt
from admitted source balances. NET is a deliberately narrow optimized path: one
position, its two original-currency uncollected-fee budgets, no old-original
allocation floor, charged input or swap. A single increase plus TAKE_PAIR returns
the actual fee remainder. Negative sides, insufficient realized fees or any
ineligible plan revert; there is no silent general-path fallback.

MINT uses the parent and the owner's independent trigger/overlap/upside policy.
The ceiling reaches `oldCeiling*(1+upsideBps/10000)` with the minimal valid directed
tick rounding; the floor stays within the admitted overlap and never above the
old ceiling. Quote inversion is explicit. Each parent has at most one actual
successor and the position cap includes the root. The vault obtains the real
PositionManager `nextTokenId`, mints to itself, verifies ownership/liquidity,
registers fresh position/source/checkpoint identities, and records the parent
relation. A withdrawn child's historical membership and parent link are retained.
FUND admits same-sequence active destinations; ordinary in-range sources stay
self-directed unless at the configured trigger and funding their actual successor.
Out-of-range sources may fund an eligible in-range destination.

A swap is one fixed, hookless, static-fee sequence pool exact-input operation.
The wire binds source, input currency, exact net amount, original/charged caps,
minimum output, directional sqrt-price limit and a separate price-observation ID.
The engine calls the pinned official PoolManager directly; it cannot invoke an
arbitrary router or another pool. Partial fills revert. Input/output transfers,
transient settlement debts, slippage floor and before/after price impact are
checked. The publisher of `DominoPriceGuardV4` is a separate admitted price
integrity source, not a spot read relabeled as an independent oracle. Each
observation binds the pool, canonical recent L2 block hash, timestamp and expiry;
revoked, stale, wrong-pool and mismatched-block observations fail. Local publisher
fixtures prove mechanics only. Live source quality and custody remain deployment
configuration, with publisher identity pinned separately from the executor.
On chain 4663, observations and vault checkpoints obtain L2 number/hash from
ArbSys through `DominoL2Block`, using a shared 255-L2-block window. Native Nitro
`NUMBER`/`BLOCKHASH` are not substitutes. Missing or malformed ArbSys replies
fail; the local Anvil emulator is identified separately from the live probe.

The original source ID survives conversion. Output is credited in its new
currency as `charged`; it is not a new original fee lot or new income. Only the
matching typed output budget receives additional charged capacity, and its floor
is unchanged. Pre-existing charged allocations retain priority. The only Domino
charge is the owner's selected automation-mode rate (200 bps simple; 400 bps Domino), evaluated as the delta
of `floor(cumulative original consumed * rate / 10000)` for that source/currency
within the intent. Exact original allocation floors are honored even at integer
rounding plateaus. Converted output/residual is never charged again; no setup
assisted-swap tariff applies to internal automation.

## Receipts and preserved accounting

The engine emits `FeesRealized`, `BudgetApplied` and `FeesConverted`; the vault
emits `PositionRegistered`, `SuccessorCreated` and `ExecutionCompleted`. Multiple
BudgetApplied events for one source/currency in an intent are valid (floor phase,
then optional phase). Consumers must retain receipt log order instead of deduping
by source. Complete event layouts are the compiled ABI and strict decoder.

The verifier checks exact calldata, transaction and log location, a second log
acquisition, canonical source/mined/finalized block headers, all 10 runtime pins,
clone/factory/dependency identity, source preimages, custody, policy/generation,
nonce/intent state, actual NFT liquidity and before/after fee balances. It returns
`realizations` and `applications` as ordered events, `conversions` with input
amounts and output lineage, `sources` aggregated by source/currency, original
`collections` as FeeCredit records, and actual successor metadata. Gas is the
receipt gas product, not a claim of total Robinhood L2 cost or dollar value.
Same-block later mutations may make the strict end-state verification unavailable;
they are never silently attributed to the selected transaction.

Incidental destination collections stay explicit in real receipts. They cannot
increase an existing plan's collection caps. The optional E1 proof excludes only
their unspent additions from its projection view and returns them separately as
`incidentalCollections`, while preserving all actual FeeCredit records for the
durable ledger and later intents. Earning timestamps, complete income coverage,
USD valuation and live profitability are not manufactured from collection time.

## Who pays gas and how the operator is funded

The transaction sender pays network gas in native ETH. The deployer pays for
deployment, the publisher pays for publishing an observation, and the operator
pays for an automated `execute`. An owner who submits an action directly pays
that transaction's gas, including setup and owner exits. A reverted transaction
can still cost its sender gas; it cannot collect the automation service fee.

The operator must already hold enough ETH before submitting. In
`backend/execution_signer.py`, `envelope()` checks the signer's native balance
against its configured gas limit and fee cap and stops with
`execution_gas_balance` if funding is insufficient. There is no implemented
automatic top-up, sale of vault assets for gas, or reimbursement call. Internal
balancing swaps send their output to the vault's charged-fee reserve. The
service cut goes to the immutable service-fee recipient in the consumed
currency; receiving a token service fee does not automatically convert it to
ETH or transfer it to the operator.

The approved economics include operator compensation and gas within the selected mode’s 2%/4%
cut on consumed earned fees; no additional gas debit is taken from principal.
Funding and, where needed, converting the service recipient's revenue into
operator ETH are separate treasury operations that have not been automated.
The fork simulation explicitly gives synthetic accounts ETH using
`anvil_setBalance`; it neither sells user assets nor proves a live funding
service. Receipt gas products and simulated balances are not full live Nitro
cost qualification.

## Local evidence and size gates

Solc `0.8.26+commit.8a97fa7a`, Cancun, optimizer 200, viaIR, metadata hash disabled.
The vendored official core/periphery/Permit2 provenance is unchanged in
[test/reference/official-v4/provenance.json](test/reference/official-v4/provenance.json).
The runtime uses its MIT FullMath and TickMath; the tests also use SqrtPriceMath;
tests execute actual PoolManager and PositionManager reference implementations.
These vendored builds are not byte-identical to the mainnet dependency builds;
the [separate qualification](../reports/v4-remediation-2026-09-21/DEPENDENCY_QUALIFICATION.md)
records their independently verified runtime pins and limits.

The following table is a **historical 13 September measurement**, retained for
provenance, not the current deployment manifest. Read current sizes and hashes
from the corrected artifacts and `scripts/check-contract-size.mjs` output.

| Historical component | Runtime bytes | Initcode including constructor words |
| --- | ---: | ---: |
| DominoVaultV4 | 24,263 | 25,760 |
| DominoVaultFactoryV4 | 3,502 | 4,367 |
| DominoExecutionEngineV4 | 21,902 | 22,546 |
| DominoRoutingHelperV4 | 13,842 | 13,868 |
| DominoPriceGuardV4 | 2,055 | 2,247 |
| DominoSetup (separate owner-funded setup) | 11,688 | 12,753 |

The gate checks [EIP-170](https://eips.ethereum.org/EIPS/eip-170) (24,576
runtime bytes) and [EIP-3860](https://eips.ethereum.org/EIPS/eip-3860) (49,152
initcode bytes). `scripts/check-contract-size.mjs` enumerates the shipping V4
components plus Setup, checks exact compiler/constructor ABI, and retains a
313-byte V4 custody reserve and 2,048-byte V4 engine reserve. Setup uses four
address words plus uint16/uint64 words (192 bytes), not six addresses. This gate
measures final artifacts; it does not bypass native chain deployment limits.

The official EVM tests cover net/general parity on ERC20 and native pairs,
fee-only waiting allocations, donations, old-unallocated versus new-collection
separation, exact floor failures, cumulative rounding, successor/replay/reorg/
cap/inverse geometry, funding, swap bounds/revocation/expiry/partial-fill rollback,
converted reuse, root transfer, owner-only unmanaged recovery and helper-independent
child exit. The canonical Anvil verifier cases cover the corresponding receipts,
tampered logs/runtime identities, reorg and exact-allocation settlement.

The historical gas comparison below predates the 21 September ArbSys correction.
It is `receipt.gasUsed` from **separate transactions restored from the same
snapshot**, so both paths start with a fresh EVM transaction access list. Policies,
liquidity, accrued fees and final source/cash/fee state match exactly. The fixture
uses a 1e12 liquidity increase and actual uncollected fees; this is local gas, not
a live Robinhood quote or full L2 qualification.

| Pair | GENERAL gas | NET gas | Reduction |
| --- | ---: | ---: | ---: |
| ERC20/ERC20 | 1,151,557 | 996,399 | 13.5% |
| Native/ERC20 | 1,100,903 | 949,520 | 13.8% |

Run `npm run test:contracts`, the canonical receipt module with
`DOMINO_TEST_EVM=1`, and E5/performance integration tests against the combined
release. No SQL, credential, continuous-service flag or real transaction is
changed by these local commands. Concrete release identity/source qualification
and funded synthetic-versus-real wallets remain explicit operational facts, not
an extra software approval flag or a fabricated successful deployment.


## Mode-specific tariff (21 September 2026)

The Policy ABI is unchanged. Exactly `serviceFeeBps=200` selects simple
Auto-compound and `400` selects Domino-compound. New owner policies accept no
other rate. Simple mode requires `maxPositions=1` and root-only GENERAL/NET
execution; FUND, MINT, child targets and foreign-position source/collection
budgets are refused. Domino mode preserves the admitted routing rules and applies
400 bps even when a recipe only adds to its current position.

Changing mode requires the owner's policy transaction and invalidates pending
plans by policy version/state nonce. Children must be withdrawn before a downgrade;
their leftover fee reserves remain recoverable but cannot fund simple execution.
Already charged converted lots carry their old disposition through a mode change
and incur no top-up charge. The 200-bps extra swap fee is only a pricing study.
