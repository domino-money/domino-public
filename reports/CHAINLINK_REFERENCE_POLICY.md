# Historical Chainlink reference analytics

Issue #4; implementation for review, September 2026. This policy supports bounded
historical reference calculations. It does not qualify an execution oracle,
enable public deposits or change the production price registry.

## What is implemented

`backend/chainlink_history.py` reads the two reviewed Robinhood standard proxies:
ETH/USD and USDG/USD. Native ETH and the canonical WETH wrapper have explicit
ETH-reference mappings; canonical USDG uses its market reference, not a fixed
dollar peg. Exact addresses, phase 1, aggregator, token/feed decimals and the
captured official manifest digest are pinned in code. A phase/configuration
change fails for review. This is a source adapter, not a runtime token-admission
list: generic token discovery elsewhere remains unchanged.

Each answer retains its integer value, round ID, `updatedAt`, first proven
publication block and the immediately preceding block/round. Historical calls
use EIP-1898 block hashes with `requireCanonical: true`. Canonical headers are
rechecked before returning. RPC errors, missing rounds, ambiguous publication
timestamps, revisions and exhausted request/time budgets fail explicitly.

Migration 006 stores this evidence separately from Alchemy observations.
Identical retries retain the original observation; a conflicting price or proof
requires review. Source selection occurs before the database row limit, so one
provider cannot crowd out another qualified source. Stored provider flags never
create qualification. Database restore tests include both sources and grants.

## Named policy and causal convention

`chainlink_robinhood_reference_analytics_v1` applies only in the explicit
reference factory. Ordinary `PriceQualification` retains its 300-second ceiling.
The production qualification registry remains empty.

| Parameter | Rule |
| --- | --- |
| Documented heartbeat | 86,400 seconds |
| Domino analytics grace | 120 seconds |
| Maximum answer age | 86,520 seconds, measured from `answerUpdatedAt` |
| Availability | Publication block timestamp **plus one second** |
| Valid interval | Explicit requested interval, ending no later than the pinned snapshot |
| Asset binding | Exact chain/address/decimals and full PoolKey hash; ordered currency pair at valuation |
| Reuse | Recheck publication/predecessor/snapshot hashes, proxy configuration and actual round values |
| Execution | Disabled |

The extra 120 seconds is an explicit analytics tolerance, **not a Chainlink SLA**
or an empirically calibrated guarantee. The earlier probe observed a USDG interval
of 86,426 seconds; that supports testing the policy, not assuming every interval
will fit. The documented 0.5% deviation threshold triggers updates and does not
guarantee a maximum pricing error.

The valuation engine orders events by timestamp. Different blocks and earlier
swaps within a publication block can share that second. Deferring a newly
published price for the entire second conservatively avoids future-price use;
it may produce a short unavailable interval when the previous answer expires.
Retrieval or delayed publication never refreshes the answer's age. Coverage
checks include fractional intervals, both boundaries and omitted rounds.

Reference results are explicitly labeled `reference_analytics_only` and preserve
their evidence digest. They are CEX reference valuations, not promises of an
executable Robinhood swap price. No qualified sequencer-uptime feed or downtime
recovery policy has been established for execution. Offline reference evidence
does not establish continuous market availability.

## Reproduce a bounded probe

From the repository root with its backend environment and optional private
development catalogue configured:

```sh
backend/.venv/bin/python backend/qualify_chainlink.py \
  --pool-id 0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6 \
  --provider-config backend/runtime/providers.json \
  --store-observations \
  --output reports/my-chainlink-history.json
```

Omit `--provider-config` to try the public RPC. Omit `--store-observations` for
report-only operation. Existing output files are never overwritten. Each of two
independent currency probes allows at most 1,600 requests, 360 seconds for archive
discovery and 480 seconds including proof revalidation. These are CLI ceilings,
not scheduled polling intervals. No wallet, signer,
background schedule, provider URL in the report or automatic retry is involved.
The CLI verifies a real pool identity but deliberately reports TVL/APR as null:
price evidence alone is not reconciled capital history.

## Completed live evidence

The [complete Alchemy probe](chainlink-alchemy-full-history-probe-2026-09-09.json)
verified WETH/USDG pool `84bd…d0b6` at block **58,982,799**, hash
`0x0a6c11001ec1881af7d4fe1cf6e90cbc4234c8a9f5e613a7d4a7dbe0f4bde376`.
The common reference interval is Unix time **1,788,914,482–1,789,000,882**,
exactly 86,400 seconds. Both currencies passed the explicit reference policy.

| Currency | Proven rounds | Largest answer interval | RPC requests | Elapsed |
| --- | ---: | ---: | ---: | ---: |
| WETH via ETH/USD | 17 | 30,769 s | 838 | 389.136 s |
| USDG/USD | 2 | 86,426 s | 136 | 62.948 s |

The counts cover each currency's archive discovery and independent proof
revalidation, excluding the small shared pool-identity/final-header reads.
Observed publication timestamps equaled `updatedAt` in these 19 rounds; their
block/predecessor proofs establish this rather than assuming it. Same-second
ordering still requires the conservative availability rule. A database read
confirmed **17 WETH and 2 USDG** observations persisted in the isolated public
development catalogue, with no duplication from the repeated USDG probe.

The [public-RPC attempt](chainlink-history-probe-2026-09-09.json) failed on both
currencies after 37 calls. A separate diagnostic identified an archive-state
metadata error at block 58,815,849; the configured Alchemy endpoint successfully
read that same block with EIP-1898. The [earlier capped Alchemy attempt](chainlink-alchemy-history-probe-2026-09-09.json)
completed USDG but exhausted the 180-second ETH discovery limit. The final CLI
uses the explicit ceilings above and preserves completed evidence.

This is a cold historical qualification workload, not an acceptable synchronous
public request or an execution price check. Incremental ingestion and reuse of
revalidated history are still needed for serving users efficiently. Automated
validation passed **254 backend tests**, including PostgreSQL/EVM, migration
reapply, source isolation, publication causality and database restore.

## Remaining work for full pool APR

The previously committed capital samples cover 3,438 and 1,008 seconds. Neither
pair consists only of these reviewed reference assets, and neither establishes
a complete reconciled day. A complete ETH/USDG or explicitly mapped WETH/USDG
capital interval is still needed for the first end-to-end 24h reference APR.
Other tokens need their own price source/independence and temporal qualification.

[Earlier live evidence](PRICE_SOURCE_READINESS.md) records the official sources
and first round-history inspection. The [VFAT assessment](VFAT_MCP_ASSESSMENT.md)
adds a useful candidate for discovery/comparison without silently changing APR
methodology or marking its historical data qualified.
