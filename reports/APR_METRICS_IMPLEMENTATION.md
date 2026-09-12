# APR calculations and source checks

11 September 2026. Implementation for #95, with existing wire packages and
runtime enablement preserved. See [methodology and integration handoff](../docs/APR_METRICS.md).

## Implemented

- Exact pool-estimate adapter over the existing verified `pool-market` result,
  independent of chart/history reconstruction. Retains provider attribution,
  data-age states and the estimate's limited basis.
- Strict managed NFT/sequence fee-performance calculator with epoch membership,
  covered capital intervals, original fee quantities, actual costs and explicit
  missing/stale/reorg states. It consumes supplied evidence, not live receipts.
- One-shot local CLI, synthetic review inputs/outputs, generated shape schemas
  and a digest manifest. No private metric endpoint or automatic refresh yet.
- Current no-key VFAT MCP/REST assessment with retained public evidence.

## Live source observations

The new CLI read two full PoolIds serially through the existing public reader,
using private product provider configuration without exposing it. Neither read
requested a chart, local historical ledger, wallet, signature or transaction.
Results and source hashes are in
[the dated probe](pool-apr-estimate-probe-2026-09-11.json).

| Pair | LP fee | Provider TVL USD | Provider volume24h USD | Derived pool estimate % |
| --- | --- | --- | --- | --- |
| WETH/USDG | 200 pips | 514,475.1568 | 5,440,319.73772586 | 77.193881104812130357 |
| MARLIN/USDG | 50,000 pips | 13,239.621 | 4,237.2759512748 | 584.082324643319472665 |

The observations were available at calculation time, with coherent on-chain
identity snapshots at blocks 60,456,611 and 60,456,674 respectively. The provider's
underlying publication time and complete-window coverage remain unknown. These
are dated pool estimates, not current quotations or NFT returns.

VFAT's separate WETH/USDG REST observation was 99.18059462330905%, using seven
days and active liquidity. The MARLIN exact-PoolId search returned no match.
Different providers, observation times and denominators prevent treating the
figures as interchangeable. See [VFAT method and evidence](VFAT_APR_RECHECK_2026-09-11.md).

## Independent accounting example

The synthetic sequence starts with $1,000. At 12h, it earns $100, pays a $2
service charge and funds a $98 child. The child earns $10 at the end of the day.
The operator also pays $0.25 gas from its own funds. Results are:

- New trading fees: $110, excluding the $98 internal funding movement.
- Actual net fee income: $108; operator gas is not deducted a second time.
- Time-weighted capital: ($1,000 × 12h + $1,098 × 12h) / 24h = $1,049.
- APR uses $110/$1,049 gross and $108/$1,049 net, annualized by 365; it does not
  apply a made-up compounding multiplier or claim this example is a forecast.

The fixed synthetic $1 token price is test evidence only. It is not a rule that
a stablecoin can be valued at parity in production.

## Review and checks

Focused verification covers 30 managed-performance tests, 28 pool-estimate
tests and seven CLI/example integration tests. The CLI reproduced both primary
generated output examples byte-for-byte. All existing read, OpenAPI, session,
onboarding and deposit contract exports retained their checked bytes.

Independent review found a primary-origin reclassification bug: an opening fee
or donation could reuse its identity as a new trading-fee credit. The correction
reserves every primary origin/currency once, while allowing internal transfers
to reference it. Regression coverage includes all nine primary-kind pairs and
both ordering directions; the reviewer confirmed the fix in `c2ef578`.

The full backend suite passed **1,243 tests in 161.534 seconds**, with PostgreSQL
and native EVM tests enabled and no skips. The isolated local database used
PostgreSQL 18; CI separately uses PostgreSQL 16. Repository hygiene reported
1,026 tracked/staged files and zero findings. Current CI is recorded in the PR.
No production database, VM, signer, frontend or provider flag was modified.
The temporary test database is private to the task worktree.

## Remaining integration dependencies

The actual managed collector needs executor identity/fee origins (#85), canonical
receipt/recovery production (#89), qualified valuations and authenticated epoch
ownership. It must distinguish fee credits from principal and transfers before
passing evidence to the calculator. This implementation does not claim those
dependencies are satisfied or that the cards refresh automatically.

OxDecimal must acknowledge the eventual versioned consumer mapping before real
API fields or source pins change. This candidate's pool estimate does not depend
on completing #4's optional historical pool reconstruction; that route retains
its distinct qualified LP-fee/time-weighted-capital semantics.
