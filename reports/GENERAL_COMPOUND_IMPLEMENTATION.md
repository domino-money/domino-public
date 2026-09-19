# General compound and canonical effects — implementation evidence

12 September 2026. Issue #88, with a receipt dependency for #97. This is the
general same-NFT implementation for independent financial/architecture review.
It does not complete optimized netting, public financial execution or card APR.
The candidate incorporates the E1 hardening merged through #113 and the immutable
vault architecture from #116; the PR targets `main`.

## Result and accounting

An authorized typed plan collects proven fees, increases the same NFT's liquidity,
settles the PositionManager's debts and pays the fixed service recipient in one
atomic transaction. It can use newly realized and previously waiting fees, with
no fixed reserve or 15% liquidity-growth limit. Already charged balances are used
first; only consumed original fees incur the floor-rounded cut, at at most 2%.
The [V3 design](../docs/PUBLIC_VAULT_V3_COMPOUND.md) records equations, callbacks,
plan/event domains, size budgets and retained release gates.

Actual official-v4 fixture cases cover ERC20/ERC20 and native/ERC20, repeated
new-plus-waiting collection, waiting-only reinvestment, aggregated rounding,
untracked vault donations, insufficient-budget rollback with same-intent retry,
20% fee-funded liquidity growth and reuse of charged residuals. Only the last
case seeds its preexisting charged ledger through an explicit test harness;
production compound cannot create converted charged balances. All cases use
actual manager settlement and inspect balances/events. Native owner balance
assertions exclude the local transaction's gas payment.

The backend obtains the known transaction and complete receipt, independently
queries both event emitters, pins all eight deployment runtimes, verifies source
and finalized mined headers, reconstructs identities/checkpoints and checks exact
source effects. Two further Anvil tests deploy the real fixture and V3 factory,
then reconcile actual ERC20/native receipts without substituted successful logs.
Full receipt ordinals define fee origins. No supplied effect object becomes
canonical merely by passing an accounting equation.

Independent review caught and corrected three verifier gaps: conservation allowed
an impossible charged-first allocation or extra gross consumption on a rounding
plateau; consistent member/event labels could rename a fee source; unsigned ABI
fields alone admitted amounts exceeding v4's signed debt/realization limit.
Regressions now reject each case. E1 exact allocations remain immutable even when
V3 consumes less gross for the same net; no accounting-policy relaxation hides
that mismatch.

## Architecture and verification

The compiler profile remains pinned solc 0.8.26, optimizer 200, viaIR, Cancun.
The fixed engine has no asset custody, allowance or generic operator calldata.
Local vault recovery does not depend on engine availability. The version is 3;
existing immutable clones do not acquire this implementation automatically.

| Artifact | Runtime bytes | Remaining EIP-170 bytes | Initcode with arguments |
| --- | ---: | ---: | ---: |
| Vault | 23,841 | 735 | 43,112 |
| Compound engine | 10,020 | 14,556 | 10,568 |
| Read helper | 7,459 | 17,117 | 7,731 |
| Factory | 2,286 | 22,290 | 46,182 |

The proposed reserve gates are 512 bytes for the vault and 8,000 for the engine;
this consumes the preparatory V2 reserve and requires explicit architecture review.
Factory initcode has only 2,970 bytes left under EIP-3860, so engine runtime space
does not guarantee capacity for future Domino/swaps.

Verification on the integrated candidate:

- 163 Foundry tests and 15 Node launcher/size tests passed, no skips. They include
  512-run fuzz properties and existing custody/recovery tests.
- A clean-artifact offline rebuild took 106 seconds locally, passed all five
  official Domino integration cases and all four artifact size gates. Backend CI
  performs this build itself before Python tests; jobs share no build directory.
- 29 focused receipt tests passed, including two actual Anvil tests; the 60 E1
  boundary tests also passed. The independent final verifier review reran the
  27 offline receipt tests and found no remaining blocker in its reviewed scope.
- All 1,341 backend tests passed with PostgreSQL/EVM enabled, zero skips, in
  161 seconds on the integrated candidate after the final verifier corrections.
- All 98 vendored upstream source/license files match their recorded hashes,
  with preserved licenses. Two of them are NOT test-only: DominoRoutingHelperV4
  imports FullMath and TickMath from `@uniswap/v4-core/`, which
  contracts/foundry.toml:14 remaps into test/reference/official-v4/. A shipped
  artifact's source set therefore includes files under a directory named
  `test/`, and the release generator hashes every one it references. No other
  production source imports the vendored tree.
- Read, OpenAPI, session, onboarding and deposit exports match their producers.
  Shared API schemas, frontend source and deployment flags are unchanged.

## Handoff and work still required

The general contract and receipt module are ready for Decimal's independent
review. #88 remains open for narrow netting, financial parity and path-specific
gas evidence. Transaction-wide local test gas includes fixture setup and is not
a claim about user execution cost. E3 economic/token/provider admission and #89
crash-safe signing, broadcast and receipt persistence remain required.

For #97, the next integration must admit version 3 and its eight pins into the
private managed journal, feed these effects into its owner epoch, and reconstruct
capital exposure and qualified earning-time income. Newly collected accrual is
not necessarily newly earned trading income: opening fees and pool donations
must retain their separate meaning. The known-receipt verifier does not establish
complete transaction discovery, omitted-RPC-event absence or consensus trust.

USD valuation, complete L2 cost, rolling-day coverage and APR remain unavailable.
The receipt gas product stays separate from strategy debits. `performance-v1`
does not change, so Decimal has no field migration or card-hook change to make
from this PR. No VM, live service, wallet, signer or real funds were used.
