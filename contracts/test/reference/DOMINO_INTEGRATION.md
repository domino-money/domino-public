# Domino compound against official v4

`OfficialDominoCompound.t.sol` uses the actual Domino factory, EIP-1167 vault,
fixed compound engine and read helper against the pinned upstream PoolManager,
PositionManager and StateView. The source provenance and offline setup are in
`README.md` and `official-v4/provenance.json`.

The initial NFT belongs to the test owner. Only its individual approval is given
to the factory-predicted vault, and factory initialization establishes the real
PositionManager subscription. Neither the compound engine nor a general router
receives NFT or currency spending approval. Swaps occur after vault registration,
so the realized fees in these cases are newly accrued protocol fees.

The tests cover:

- ERC20/ERC20: collect, consume part of the fee balance, wait, accrue more swap
  fees and consume both waiting and newly collected fees. One case crosses an
  integer rounding boundary that detects separate fee floors. A third compound
  consumes waiting original fees with no new swap or fee accrual.
- Native/ERC20: actual fee collection, native and ERC20 settlement, recipient
  service payments and residual accounting. Direct donations to the vault remain
  outside its source fee ledger.
- Insufficient gross budget: collection, liquidity change, service transfers,
  checkpoint, last-execution time, nonce and intent consumption all revert. The
  same intent can then succeed with sufficient budget; a successful replay fails.
- A liquidity increase of 20%, funded entirely from real protocol fees earned in
  an explicitly synthetic 10%-fee pool. This distinguishes the supported fee
  budget from the removed 15% liquidity-growth cap, without recommending a pool
  tariff or claiming execution economics.
- Already-charged residual consumption and reuse with no additional service cut.
  Only this case uses a derived vault exposing the protected converted-credit
  sink, with exact balance backing. Its clone uses the actual compound engine's
  expected runtime identity. This is synthetic source setup, not qualification of
  a swap, conversion receipt or converted-origin reconciliation producer.

For every successful action the test independently compares financial event rows
with actual source balances, fee-recipient transfers, unchanged owner balances,
NFT holder/approval/subscription, exact core liquidity, nonce and consumed intent.
It checks conservation by currency/source, the immutable registration checkpoint,
unchanged authority generation, and a relocked PoolManager with no unresolved
currency deltas. Receipt-local log ordering and raw event data are available from
Foundry traces for the canonical receipt adapter's subsequent parity fixtures.

`FeesRealized` and `SourceFeesApplied` must come from the vault's fixed compound
engine and explicitly index the vault and intent. Source currency is decoded
from event data. Both unique source records must match the realized amounts and
precede the vault's own `CompoundSelfCompleted` event. The assertions check the
emitter, vault, source, currency, intent, nonzero checkpoint IDs and exact
completion commitment.

These are local synthetic-chain tests. They do not admit real tokens or providers,
establish operator economics, create a scheduler, send transactions to Robinhood,
or implement swaps/converted-origin acquisition. Complete backend and deployment
gates remain the integrating change's responsibility.

Run the targeted suite from the repository root with the pinned Forge launcher:

```sh
npm run test:contracts -- --match-contract OfficialDominoCompoundTest
```

The public command also enforces the repository's production bytecode gates.
Direct pinned Forge invocations during development run the fixture alone; passing
those tests does not waive a failing production size gate.

Validation on 12 September 2026: all five cases passed with the final
engine-emitted financial events, using direct pinned Forge without code-size
overrides. The tested production snapshot had SHA-256 prefixes `a6fd04b3`
(vault), `2b44143b` (types), `ce7dfca5` (read helper) and `9ed63329` (engine).
Only fixture files are part of this test commit; production changes belong to
the integrating E4 branch. All 98 vendored reference file hashes remained valid.
