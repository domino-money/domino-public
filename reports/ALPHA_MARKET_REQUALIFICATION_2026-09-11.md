# Alpha pool-market requalification — 11 September 2026

The current backend returned **provider TVL and 24h volume for both initial
candidate pools** through the real local HTTP API, without a catalogue or
historical replay. All six responses passed the unchanged `read-v1` model and
header checks. Requested quote-token charts did **not** qualify: one was rejected
for inconsistent token orientation and the other was unavailable after invalid
OHLC data. Both failures preserved the useful market figures and verified pool.

This is a small serial read qualification, not a deployment, capacity/load
benchmark, current quote, pricing-oracle approval or financial execution test.
There were no VM/Cloudflare changes, wallet reads, signatures or transactions.

## Exact evidence

- Producer baseline: `69359d28c88564dd47d2446f606972df2b88ff8e`.
- Executed source, adding only the probe and its tests:
  `5345eef6f67cd8bd1989414ae755e29df5d3d90f`.
- `read-v1` remains **1.1.0-rc.3**. Manifest SHA-256:
  `ec101da5ad23b19724044beaa159e79825f754c1ada58ce52d6e488545eb31c2`.
- Probe source SHA-256:
  `c4d1f2d64d0d97401d30b648081bdd7424b8c2b2339ec1250c7f14c0f174dd18`.
- [Six-read artifact](alpha-pool-market-probe-2026-09-11.json), SHA-256:
  `6d603159b9fe217990063921167a4fafdc2443106ad5994890be5e45bc9667b5`.
- [Two-request chart diagnostic](alpha-pool-market-chart-diagnostic-2026-09-11.json)
  retains the actual public address-role observations and sanitized parser result.

The HTTP run was **16:55:55–16:56:36 UTC** (13:55:55–13:56:36 in São Paulo).
It used the separately configured product RPC through the existing owned-file
loader. The configuration had one RPC endpoint; provider URLs, credentials,
wallet identifiers and private configuration contents are absent from the report.
GeckoTerminal market reads used its public Robinhood endpoint. Each result binds
the full chain/pool/currency identity, snapshot and provider retrieval time.

## Observed market results

These are dated provider observations, not reconciled Domino capital valuation.
The retrieved values were reused for the following chart/cache cases; no separate
ticker/table acquisition was added.

| Candidate | Full PoolId | Fee / spacing | Provider TVL USD | Provider volume 24h USD |
| --- | --- | --- | ---: | ---: |
| WETH/USDG | `0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6` | 200 pips / 4 | 515,348.9849 | 5,499,679.2654287 |
| MARLIN/USDG | `0xdb922f0619e11b0c1e6c3a142798f0243060b8a4331ea4f4e7de80e898cc02e7` | 50,000 pips / 500 | 13,388.435 | 4,951.4390416341 |

Both pools verified as hookless, fixed-fee v4 pools. This confirms their read
identity, not token admission for deposit or automation. The generic probe takes
PoolIds; neither token symbol nor either example is a runtime allowlist.

| Candidate | Market only | First quote chart | Repeated quote chart | RPC / market requests |
| --- | ---: | ---: | ---: | --- |
| WETH/USDG | 6.194200 s | 6.097457 s | 5.647206 s | 33 RPC / 2 market |
| MARLIN/USDG | 6.338886 s | 6.244215 s | 5.557842 s | 33 RPC / 2 market |

Each API read made **11 RPC calls**, including fresh chain/deployment/pool reads
and snapshot recheck. A cache hit avoided market HTTP only; it did not avoid RPC
verification. Across all six reads: **66 RPC calls + 4 market HTTP requests**.
The separate diagnostic added **2 public OHLCV requests and no RPC calls**.
No additional provider requests or history scans were made for this report.

All reads completed below the selected 15-second local read budget. Snapshot age
at receipt was 4–5 seconds. The chart repeats made zero new market requests;
the WETH chart reused a cached observation that still failed orientation checks,
and MARLIN remained within the existing failed-read cooldown. Failed data was
not relabeled successful because it came from cache.

These times include localhost HTTP and provider work from this workstation, one
client at a time. They exclude Pages, Worker, Access, Tunnel and the home VM.
Six observations establish neither throughput, multiuser capacity, failover nor
a latency percentile/SLA. The process-local cache retains its existing limits:
60-second freshness, up to 300-second explicitly stale fallback, 256 entries and
25 market requests per minute. Those configured limits were not load-tested.

`market.status: available` means an accepted provider observation within cache
freshness. The provider's update timestamp/block remain **unknown**; retrieval
time is not its data update time. `providerMetricsReconciled` remained false and
all APR, suggestion and execution capability fields retained their disabled/null
semantics.

## Concrete chart findings

The run explicitly requested `priceToken: quote`. This denotes the provider's
role, not raw token0/token1 or a symbol. `ReadService` compares chart metadata
against the pool market metadata before attaching prices.

| Candidate | Market roles | OHLC response roles when `token=quote` | Result |
| --- | --- | --- | --- |
| WETH/USDG | base = USDG; quote = WETH | base = WETH; quote = USDG | API rejected `provider_chart_currency_mismatch` |
| MARLIN/USDG | base = MARLIN; quote = USDG | base = USDG; quote = MARLIN | Parser rejected `invalid_market_candles`; API retained `provider_unavailable` |

The second table uses exact public address identity in the JSON diagnostic:
WETH `0x0bd7d308f8e1639fab988df18a8011f41eacad73`, USDG
`0x5fc5360d0400a0fd4f2af552add042d716f1d168`, MARLIN
`0xab35d04e1ee39c789c4a65d522417b3c7f2e4723`. Labels here are readability aids.

At 16:57:51 UTC a bounded repeat through the existing OHLC parser confirmed
reversed roles for WETH/USDG; the isolated parser accepted 24 candles with 23
closed hours and no detected gaps. That does **not** make them an accepted WETH
chart: the current parser derives selected currency from the returned role, so
the service's comparison to the independently observed market roles is essential.
Complete rolling-day history remained false. At 16:57:52 UTC the MARLIN/USDG
repeat again had reversed metadata and failed candle validation. The diagnostic
does not identify which individual OHLC assertion failed and makes no claim
about the provider's cause. Raw malformed candles are not silently repaired.

### Bounded correction to investigate next

1. Establish GeckoTerminal's documented/current semantics for `token=quote` and
   whether selecting an **explicit token address** can bind the requested chart
   without relying on response-relative base/quote roles. Fix the input/output
   identity adapter using chain+address; preserve exact selected currency and
   the existing public fields unless a coordinated contract change is necessary.
2. Capture only the bounded offending public candle fields for MARLIN in a
   separate follow-up, identify whether timestamps, OHLC ordering or another
   numeric rule fails, and qualify the provider's supported representation.
   Do not weaken number/identity checks or infer zeroes to make it pass.
3. Add independent fixtures for both role orientations, explicit requested
   currency, genuinely mismatched currencies and the specific candle defect.
   A future correction requires source review and a coordinated manifest pin.

No parser, provider adapter, API field or contract manifest was changed here.
TVL/volume can serve the first useful pool table while charts remain explicitly
unavailable. This result does not authorize the frontend data switch.

## Why a qualified APR is still unavailable — issue #4

The blocker is not a missing pool row in our database. The on-demand path already
works without any catalogue. It is the distinction between the inputs required
by the approved APR method and the available evidence.

| Missing qualification | Exact consequence / next work |
| --- | --- |
| LP-fee numerator over a coherent trailing day | This provider route supplies volume/TVL, not reconciled LP fees. It keeps `aprReason: provider_lp_fee_history_unavailable`. A static fee times volume is not silently substituted for actual LP fees. |
| Time-weighted capital denominator over that same interval | Provider current TVL is a point observation with unknown provider timestamp. It cannot become the historical denominator under the existing APR field. Full-chain/lifetime reconstruction remains optional; scope any exact ledger qualification to selected pools and required windows. |
| Production-approved causal prices for both pool currencies | `backend/price_history.py` still has `PRODUCTION_QUALIFICATIONS = {}`. Registration requires reviewed identity, source independence, timestamp/publication semantics, freshness and complete coverage, not merely an API key or a parsed price. |
| WETH/USDG reference-to-production policy | The existing Chainlink reference adapter has a distinct 86,520-second analytics age policy; ordinary production qualification still caps age at 300 seconds. The earlier full-day reference probe is not a currently fresh production series. Do not silently widen the production age bound. |
| MARLIN independent pricing | No reviewed production MARLIN feed or target-pool-independent historical source is present. A Gecko chart of the pool being assessed does not itself establish independence or an execution price. |
| End-to-end freshness/coverage | A complete historical reference example alone cannot make `usableAsCurrent24h` true. Qualified inputs, reconciled capital/fees and a fresh canonical snapshot must all agree. |

Some earlier issue #4 follow-ups are already implemented: legacy two-currency
Chainlink storage is atomic after proof revalidation through #63, and sliced
collection/recovery is covered by #30/#52. Those fixes do not populate the
production registry or solve the different policy/source gaps above. The
publication-second causal convention must also carry into any future production
qualification, rather than existing only in the reference factory.

For a simpler onboarding indicator, an attributed provider estimate or explicit
`volume × reviewed LP-fee estimate / current TVL` methodology could be assessed
as a **separate estimate**, with its limitations and name agreed before wiring.
This report does not implement or approve that estimate. It makes no APR claim
and starts no global backfill. The first read-only deployment need not wait for
an invented APR or silently change the accepted methodology.

## Reproduction and checks

From this product checkout, using its pinned backend Python environment:

```sh
backend/.venv/bin/python backend/qualify_pool_market.py \
  --rpc-config /path/to/private/product/providers.json \
  --pool-id 0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6 \
  --pool-id 0xdb922f0619e11b0c1e6c3a142798f0243060b8a4331ea4f4e7de80e898cc02e7 \
  --price-token quote \
  --output reports/new-market-observation.json
```

Use a new filename for every attempt. No URL/key is supplied as an argument;
only the existing private product configuration path is accepted. The script
ignores environment RPC overrides, opens an ephemeral numeric-loopback listener,
uses the real origin/gate/response boundary, runs three serial cases per pool
(maximum two pools), then stops the listener. It opens no DB and contains no
financial RPC method. Its report projects public fields and omits URLs and
arbitrary provider/error text. `allResponsesValid` checks schema/headers; it does
not claim every optional chart is available or production pricing is qualified.

Checks actually run:

- Nine new focused tests passed, including a real temporary loopback server
  with synthetic upstreams; error/URL redaction, zero versus absent, response
  identity, APR rejection, finite sequencing, failed-case retention and exclusive
  report output.
- `scripts/export-read-contract.py --check`: all 244 generated files matched.
- `scripts/export-read-openapi.py --check`: OpenAPI matched producer routes/models.
- Repository hygiene: 995 files checked, zero findings. Staged whitespace check
  passed; no underlying financial/accounting module changed.

The full PostgreSQL/EVM and browser suites were not rerun for this additive
operator probe. Existing production modules, schemas and consumer pins are
unchanged. Read source policies and historical evidence alongside this report:
[MVP data strategy](../MVP_DATA_STRATEGY.md),
[earlier market qualification](ON_DEMAND_MARKET_QUALIFICATION.md),
[Chainlink reference policy](CHAINLINK_REFERENCE_POLICY.md),
[legacy storage guard](LEGACY_CHAINLINK_STORAGE.md),
[price-window capacity](PRICE_WINDOW_CAPACITY.md),
[metrics methodology](../METRICS_METHODOLOGY.md).
