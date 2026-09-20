# V4 fee execution: E4, E6 and E7

13 September 2026. This candidate adds a separate V4 deployment. The V3 vault,
factory, engine and read helper source/ABI remain unchanged. No Robinhood funds,
wallets, deployments or provider qualification are implied by the local tests.
The economic policy remains [REINVESTMENT_POLICY](../REINVESTMENT_POLICY.md) and
[PRICING_POLICY](../PRICING_POLICY.md).

## Components and deployment order

The factory does not embed creation bytecode for the entire architecture.
Deployment is staged and its implementation may be finalized exactly once:

1. `DominoVaultFactoryV4(poolManager, positionManager, stateView, serviceFeeRecipient)`.
2. Existing `DominoVaultReadHelper(positionManager, stateView)`.
3. `DominoRoutingHelperV4()` and `DominoPriceGuardV4(pricePublisher, stateView, maxDeviationBps, guardian)`.
4. `DominoExecutionEngineV4(factory, readHelper, routingHelper, priceGuard)`.
5. `DominoVaultV4(factory, poolManager, positionManager, stateView, serviceFeeRecipient, readHelper, engine)`.
6. The factory deployer calls `finalizeImplementation(implementation)` once.
7. The NFT owner approves the predicted clone for its root NFT, then calls the
   factory's existing owner-bound `createVault(InitParams, expectedOwnerNonce)`.

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
observation binds the pool, canonical recent block hash, timestamp and expiry;
revoked, stale, wrong-pool and mismatched-block observations fail. Local publisher
fixtures prove mechanics only. Live source quality and custody remain deployment
configuration, with publisher identity pinned separately from the executor.

The original source ID survives conversion. Output is credited in its new
currency as `charged`; it is not a new original fee lot or new income. Only the
matching typed output budget receives additional charged capacity, and its floor
is unchanged. Pre-existing charged allocations retain priority. The only Domino
charge is the owner's automation rate (at most 200 bps), evaluated as the delta
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

## Local evidence and size gates

Solc `0.8.26+commit.8a97fa7a`, Cancun, optimizer 200, viaIR, metadata hash disabled.
The vendored official core/periphery/Permit2 provenance is unchanged in
[test/reference/official-v4/provenance.json](test/reference/official-v4/provenance.json).
The runtime uses its MIT FullMath and TickMath; the tests also use SqrtPriceMath;
tests execute the actual PoolManager and PositionManager, not an effect mock.

| Component | Runtime bytes | Initcode including constructor words |
| --- | ---: | ---: |
| DominoVaultV4 | 24,263 | 25,760 |
| DominoVaultFactoryV4 | 3,502 | 4,367 |
| DominoExecutionEngineV4 | 21,902 | 22,546 |
| DominoRoutingHelperV4 | 13,842 | 13,868 |
| DominoPriceGuardV4 | 2,055 | 2,247 |
| DominoSetup (separate owner-funded setup) | 11,688 | 12,753 |

Every component fits [EIP-170](https://eips.ethereum.org/EIPS/eip-170) (24,576
runtime bytes) and [EIP-3860](https://eips.ethereum.org/EIPS/eip-3860) (49,152
initcode bytes). `scripts/check-contract-size.mjs` now enumerates the V3 and V4
components plus Setup, checks exact compiler/constructor ABI, and retains a
313-byte V4 custody reserve and 2,048-byte V4 engine reserve. Setup uses four
address words plus uint16/uint64 words (192 bytes), not six addresses. This gate
measures final artifacts; it does not bypass native chain deployment limits.

The 17 official EVM tests cover net/general parity on ERC20 and native pairs,
fee-only waiting allocations, donations, old-unallocated versus new-collection
separation, exact floor failures, cumulative rounding, successor/replay/reorg/
cap/inverse geometry, funding, swap bounds/revocation/expiry/partial-fill rollback,
converted reuse, root transfer, owner-only unmanaged recovery and helper-independent
child exit. The canonical Anvil verifier cases cover the corresponding receipts,
tampered logs/runtime identities, reorg and exact-allocation settlement.

Gas below is `receipt.gasUsed` from **separate transactions restored from the same
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
