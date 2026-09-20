# Infrastructure snapshot — 20 September 2026

Read-only observations from **20:32:50 to 20:49:01 UTC**. This audit made no RPC/Alchemy calls, ran no load tests and made no remote changes. The structured evidence and 64 public pool IDs are in [infrastructure.json](infrastructure.json).

| Resource | Observed |
|---|---|
| Host CPU/RAM | Ryzen 7 9800X3D, 8 cores/16 threads; 91.71 GiB RAM, 53.84 GiB available |
| Nitro | v3.11.4-7d5ac27; approximately 28.97 GiB RAM; no Docker CPU/RAM quota |
| Nitro filesystem | Kingston SNVS2000G, ext4; about 647.5 GiB used, **1,166.6 GiB available** |
| SSD connection | **PCIe 3.0 x1**, controller maximum x4; unchanged from the prior storage audit |
| VM | 4 vCPU; 7.76 GiB RAM, 5.68 GiB available; root filesystem 12% occupied |
| PostgreSQL | 40 connections; 1 GiB shared buffers; 8 MiB work_mem; 128 MiB maintenance_work_mem |
| Catalogue database | 3,145,432,087 bytes; catalogue schema 185,188,352 bytes, public schema 42,696,704 bytes |

The five-minute Prometheus window ending **20:36:53 UTC** showed host CPU **3.79%**, iowait **0.213%**, and Nitro disk busy **2.70%**. Disk traffic averaged 0.582 MB/s read and 2.741 MB/s write; mean operation latency was 0.337 ms read and 1.194 ms write. These are quiet-window measurements, not sustained capacity under load or compaction.

Storage used increased **5.945 GiB in 24 hours**. A requested seven-day query returned only **65 hours of observations**, with **44.873 GiB** growth. Prometheus is configured for **30 days or 20 GiB** retention; that configuration does not establish seven days of collected history. Growth measures the filesystem, not the database alone. The varying rates do not justify a precise exhaustion forecast.

The physical NIC negotiates 10 Gb/s, but WAN bandwidth remains unmeasured. Existing node-exporter network series expose the container's eth0/lo, **not the host's physical NIC**. Those series cannot establish Internet throughput or headroom.

## Runtime limits and demand-model routes

Production reader/gateway use one Uvicorn process each, with HTTP concurrency ceilings of 8/16. The reader has a 15-second read deadline. Provider reads retain **one slot** and an approximately one-second minimum start interval; public stored reads have **four separate slots** without that interval. Gateway client admission defaults to 30/minute with burst 5. These are separate constraints from raw Nitro capacity.

Live gateway environment configures:

- V1: `token`, `pool-market`, `pools`, `catalogue`, `nft-positions`, `wallet-assets`, `pool-activity`.
- V2: `pool-market`.
- V3: `overview`, `history`, `search`.

The single GET to `127.0.0.1:8876/health` returned `status=ok`. This reader health contract does **not** publish enabledReads; the lists above came from allowlisted live gateway environment fields.

Production read and dev releases are `1b864e2a0253a9f7ce0f1a5380894ca2057dc839`; public collectors use `16587afac43000dd529545e44fc7a5798f6aa528`. Each collector is capped at one core, 512 MiB and 32 tasks. Production reader/gateway have no CPU/RAM cgroup ceiling and nofile=524288.

Development shares half a core, 1 GiB maximum RAM and 64 tasks. Reader/gateway RAM caps are 512/192 MiB; each has nofile=512. Dev admission is six starts/minute, at least two seconds apart, with 120 RPC items/minute and 64/operation. Lease expires **27 September 12:28:36 UTC**. No OOM event was recorded in the inspected reader/dev cgroups.

## Public catalogue and test endpoints

Read-only SQL used the configured Unix socket `/run/postgresql-domino`, port 8877, database `domino_catalogue`. The snapshot has 146,753 catalogue events, 10 hints, revision 6904, start block 58,736,592 and next block 68,233,442. The JSON field `vm.postgresql.samplePools.poolIds` contains **64 unique real pool IDs** selected deterministically from events/hints. Catalogue presence does not establish liquidity, recent activity or persisted history for those pools. Aggregate database size includes other schemas; private tenant table content was not read.

Nitro's direct endpoints are **host-loopback only**:

- HTTP: `http://127.0.0.1:8547/`
- WebSocket: `ws://127.0.0.1:8548/`

They bypass nginx's 25 requests/s per-source-IP limit, burst 50 and method/auth boundary. A separate authorized harness must impose its own read-only allowlist, deadlines, concurrency and stop conditions. The earlier probe established that old logs/headers work locally while some old state is missing; such missing state is not saturation evidence.

No sustainable requests/second or user-capacity conclusion is established by these passive observations.

## Public persistence and collector capacity

At **20:47:28 UTC**, 2,104 public pools existed: 2,103 ready and one pending dependency. All 1,342 token entities were ready. Only six pools were hot (requested in the last 60 seconds); none of the tokens were hot. The scheduler had 1,953 pools and 1,031 tokens due without an active lease. These are refresh obligations, not 2,984 entities without data.

| Stored payload age, seconds | Count | Minimum | p50 | p95 | Maximum |
|---|---:|---:|---:|---:|---:|
| Hot pools | 6 | 1.63 | 5.13 | 6.63 | 6.63 |
| Other pools | 2,097 | 1.63 | 585.63 | 1,039.83 | 1,090.63 |
| Tokens | 1,342 | 0.63 | 650.63 | 1,227.53 | 1,295.63 |

From **20:42:28 to 20:47:28 UTC**, current collected 155 ticks, every tick containing four pool publications and two token publications: 620 pools and 310 tokens, touching 466 unique pools. Tick time was p50 **1.379s**, mean **1.732s**, p95 **3.893s**, maximum **5.555s**, followed by the configured 0.2-second delay. There were no retries in those current ticks. The observed pool publication rate was **2.067/s**; this is a mixed pool/token workload, so per-pool RPC cost or latency cannot be isolated from it. Current does not emit rpcCalls, and its logical-call count remains unknown.

At this observed rate, a single pass over 1,000 pools would take approximately **484 seconds**, assuming all throughput were available to that set. Refreshing 1,000 distinct pools every five seconds would require **200 publications/s**, approximately **97 times** this observed publication rate. This illustrates the collector bottleneck; it does not establish raw Nitro's limit. Fairness, background tokens, retries and repeated hot refreshes affect actual completion time.

History had 450 jobs: 449 for one day and one for seven days. Seven had never completed; 448 were due without a lease; none held a live lease at the instant sampled. **443 had completed previously**, which does not mean their current windows were fully fresh. Over the five-minute journal window, history finished 47 ticks (30 current, 17 indexed), touched 31 pools and reported **8,573 logical RPC items**; duration p50 was 972ms, mean 1,341ms and p95 2,459ms, plus five seconds between ticks. Accounting produced 38 ticks; its duration and safe status aggregates are in JSON. No private wallet/tenant records were queried.

The later catalogue snapshot counted **146,797 unique pools**, 3,608 pools linked to public tokens, 5,711 token/pool links, and 449 pools with history coverage records. Entity/event/history ingestion growth rates were not established from equivalent repeated snapshots.

## RPC item counters and attribution

In the five-minute Prometheus window ending **20:49:01 UTC**, Nitro handled **90.372 logical RPC requests/s** (89.723 success and 0.649 failure). Its independent duration sample count agreed. Nginx counted **24.477 HTTP requests/s**. These are different counting units and include all respective clients; they are not caller-specific collector counters. Main observed method rates included getBlockByNumber 41.02/s, getStorageAt 15.96/s, getCode 10.52/s, successful eth_call 10.40/s, chainId 7.80/s and getTransactionReceipt 4.53/s. The method subquery uses 15-second sampling, so small differences versus total-counter rates are expected.

Root had not started a node load test during these windows. Root reports a stored-SQL gateway fixture benchmark beginning around 20:45 UTC; six hot pools were present in the demand snapshot. The audit itself generated no provider requests. Treat the total Nitro rate as shared baseline, not an exact B_collectors attribution.
