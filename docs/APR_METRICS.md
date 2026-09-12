# Pool estimates and managed fee performance

Implementation candidate for #95, following the owner's approved distinction:
choose a pool using a simple attributed estimate; evaluate a managed NFT or
Domino sequence using its actual fee income and changing capital. The original
two calculators run locally. The later [public pool estimate
candidate](PUBLIC_POOL_APR_ESTIMATE.md) adds an opt-in read-v2 gateway/BFF route;
managed card collection and activation remain separate.

## Pool selection

`backend/pool_apr.py` consumes the existing validated `pool-market` response. It
does not rebuild pool history, request a chart or create a catalogue job.

For an admitted hookless pool with a fixed LP fee and current protocol fee zero:

`estimated fee APR % = 36,500 × reported volume24hUSD × LP fee pips / 1,000,000 / reported TVLUSD`

This follows the methodology in Uniswap's public
[pool APR helper](https://github.com/Uniswap/interface/blob/da6d36f71c4d2fd665b0aae1a052a4ffda917b31/apps/web/src/data/pools/useTopPools.ts#L53),
using Domino's existing **GeckoTerminal** observations. It is not an APR supplied
by Uniswap, an independently reconciled historical rate, the return of a selected
range, or APY. The [documented Uniswap pool-info API](https://developers.uniswap.org/docs/api-reference/pool_info)
does not supply these analytics. No unsupported private analytics endpoint is
used. Missing inputs are not copied from Uniswap UI zero fallbacks.

The adapter rechecks PoolId/PoolKey/currency associations and fee mode. Missing
volume, missing/zero TVL, dynamic or nonzero protocol fees, hooks, mismatched identity and expired
observations do not produce a usable APR. Reported zero volume is a real zero.
Provider retrieval time is not its underlying update time. A reported 24h volume
does not prove a complete day of pool history, known pool age or causal prices.

The separate result has `scope: pool`, `source: geckoterminal`,
`feeAprEstimate24hPercent` as a decimal string or null, and
`status: available | stale | unavailable`. It retains inputs, snapshot,
retrieval/cache ages, unknown source update time, reasons and limitations.
Available estimates require market retrieval age below 60 seconds and chain
snapshot age at most 120 seconds. Older observations up to 300 seconds remain
explicitly stale; expired observations have no APR. This does not add polling
or alter the existing cache's read budget.

The public candidate also retains `inputs.protocolFeeRaw` and rejects invalid
packed directional protocol fees. Aggregate volume cannot establish their LP
share. The original `read-v1` field **`feeApr24h` remains null**, with its original
meaning. A future browser integration must adopt the new estimate semantics
explicitly, rather than relabel this result as `qualified` in the current UI.

## VFAT as a complementary source

The [current VFAT investigation](../reports/VFAT_APR_RECHECK_2026-09-11.md)
confirms public no-key REST and MCP access for Robinhood v4. Exact WETH/USDG
discovery returned data; the tested MARLIN/USDG PoolId returned no match.
VFAT's fee APR uses **seven days and active liquidity**, assuming time in range.
Its prepared closed-day history is not the current rolling 24-hour window.

That is a useful separately attributed comparison, with its original `aprBasis`.
It is not a compatible replacement for `feeAprEstimate24hPercent`. This change
does not add VFAT to the runtime provider list. The live probe and documented
REST operation make a later optional adapter concrete without another global
history pipeline or MCP installation.

## NFT and Domino sequence

`backend/managed_performance.py` accepts strict internal evidence for one
**management epoch**, binding the owner, position manager and tracked NFT
membership. The caller supplies already reconciled fee credits, actual charges,
qualified event-time token prices and capital segments. The calculator checks
their identities, uniqueness, timing, scope and coverage. It does not fetch or
independently certify those facts, authenticate the owner or authorize actions.

`gross fee APR % = 36,500 × new trading fees USD / time-weighted capital USD`

`net fee APR % = 36,500 × (new trading fees − actual service charges − other strategy-paid costs) / time-weighted capital USD`

Both formulas use a complete trailing day, `(windowStart, windowEnd]`. Capital
is the time integral over that same window, divided by its length. Its segments
must split at valuation, balance and membership changes. Include all registered
NFT assets and the epoch's residual balance once, including idle/out-of-range
capital. Do not use only the currently earning child as the denominator.

- Opening fees, donations, deposits and transfers between children are not newly
  earned trading fees. Reinvesting a fee credit does not count it again. New fees
  subsequently earned by a child do count.
- New raw token quantities are valued at their attribution timestamps. Price
  appreciation of an existing fee balance is not another fee earning event.
- Deduct actual charges when incurred; do not accrue a hypothetical 2% charge
  on untouched fees. The operator's gas funded by the service cut is reported
  separately and never deducted from the user again.
- Costs already reflected in a swap's valued proceeds must not also arrive as
  a separate debit for the same accounting metric. The receipt producer must
  provide a reconciled, non-overlapping cost decomposition.
- Before 24 hours, return observed fees and `measuring`, with APR null. Missing
  coverage or prices produce partial/unavailable metrics. An isolated failed
  read does not erase the management epoch; reorged evidence cannot produce APR.
  This display warmup imposes **no delay on executor reinvestment decisions**.
- Net fees/APR may be negative when actual costs in the day exceed newly earned
  fees. Token-price P&L and projected APY are separate measures and are not
  implemented by this fee calculator.

The result has `scope: nft | sequence`, `epochId`, `owner`, `positionManager`,
snapshot, `windowStart`, `windowEnd`, `observedSeconds`, `complete24h`, `status`
and `issues`. Amount fields are decimal strings or null:

| Field | Meaning |
| --- | --- |
| `newTradingFeesUsd` | Newly earned trading fees in the observed window |
| `actualServiceFeesUsd` | Actual Domino charges recognized in that window |
| `otherStrategyCostsUsd` | Other reconciled costs borne by the strategy |
| `operatorCostsUsd` | Operator-funded cost information; excluded from owner return |
| `netFeeIncomeUsd` | New trading fees less actual strategy costs |
| `timeWeightedCapitalUsd` | Average value of all tracked capital over the window |
| `grossFeeAprPercent` / `netFeeAprPercent` | Full-day annualized fee rate; null until ready |

`complete24h` describes covered accounting history, not whether the snapshot is
still current. Consumers must also inspect status/freshness. A stale snapshot
can retain dated observed amounts; its APR is not emitted as a current rate.
The response declares `liveCollectorImplemented: false` and
`executionAvailable: false` in this increment.

## Reproduce and hand off

Use the product Python environment with `backend/requirements-api.lock`.
`scripts/export-metrics-examples.py` generates deterministic synthetic inputs,
outputs, input/output shape documentation and a digest manifest under
`docs/metrics-examples/`; `--check` detects drift. These are **internal review
examples**, not a deployed contract package or approved consumer pin.

```sh
python scripts/export-metrics-examples.py --check
python backend/preview_metrics.py pool --input docs/metrics-examples/pool.input.json --now 1789135200
python backend/preview_metrics.py managed --input docs/metrics-examples/managed.input.json --now 1789135200
```

For a current public pool read, use `pool --pool-id <full PoolId>` and optionally
`--config-file <private product provider config>`. It makes one bounded pool
read, with no chart or historical backfill. `--now` is allowed only for offline
reproduction. Never commit private managed evidence, runtime configuration or
wallet activity. The CLI does not publish its output.

## Integration work still required

[Execution policy](EXECUTION_POLICY.md) supersedes historical owner, ACK and
approval procedures here. Any authorized collaborator or agent may implement
and operate within scope, recording results alongside or after execution.
Technical controls, compatibility evidence and wallet consent still apply.

1. The executor's forward collector must produce the baseline, canonical fee
   origins and actual receipts (#85/#89). Collect only managed subjects from
   their baseline, not all pool history. Persist idempotently and replay or
   invalidate affected evidence after reorg; do not infer fees from two USD
   balance snapshots. Bind NFT transfers and closing receipts to the correct
   owner epoch.
2. Qualify the actual valuation/coverage producer. Caller-supplied `qualified`
   or `canonicality` labels in a synthetic input are not production proof.
3. Implement and validate the versioned producer/consumer response and follow
   [API compatibility](API_COMPATIBILITY.md). The
   [read-v2 pool candidate](PUBLIC_POOL_APR_ESTIMATE.md) supplies the versioned
   route and fixtures for #13. The original read-v1 payload is preserved, with an updated source
   manifest and pin for the gateway change. Private #2 individual/sequence
   metrics require an authenticated owner-bound route, never the public reader.
4. Serve bounded cached snapshots. The proposed frontend cadence is 30–60
   seconds while visible, plus invalidation after confirmed actions; cache and
   provider budgets must be qualified at integration. The CLI is one-shot and
   does not claim automatic card refresh is implemented.

These dependencies prevent claiming live user APR today. They do not prevent
reviewing the implemented calculations, testing their examples or displaying a
reviewed provider pool estimate independently of optional historical audit #4.
