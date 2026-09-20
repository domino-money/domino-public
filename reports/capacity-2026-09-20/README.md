# Capacity study evidence

See [the report](../RPC_CAPACITY_STUDY_2026-09-20.md). Measurements were made on 20 September 2026 with production reader/gateway `1b864e2a0253a9f7ce0f1a5380894ca2057dc839`, collectors `16587afac43000dd529545e44fc7a5798f6aa528` and Nitro `v3.11.4-7d5ac27`. The source audit started at Domino `03e1184094ae929985e57f6e0acfecdc094e64e3`.

These JSON files contain measurements and aggregate diagnostics, not private configurations or raw logs. No API keys, RPC access paths, wallet secrets or production assertions are included. `pools.json` contains 64 public catalogue pool IDs; catalogue membership does not prove liquidity or history readiness.

## Runs

The script itself fixes loopback targets and read-only workloads. Copy it to the appropriate host; do not send this traffic to the public endpoint. Actual commands below omit only script/output directory prefixes.

| Artifact | Host and parameters |
|---|---|
| `node-scalar.json` | clawber: `--profile node --rates 10,20,40,60,90,135,200,300,450 --seconds 45 --cooldown 15 --concurrency 8 --pools pools.json --health-module /srv/robinhood-rpc/scripts/load-health.py` |
| `node-batch8.json` | clawber: `--profile node --rates 2.5,10,25,37.5 --seconds 45 --cooldown 15 --concurrency 1 --batch 8 --pools pools.json --health-module /srv/robinhood-rpc/scripts/load-health.py` |
| `stored-initial.json` | VM: `--profile stored --rates 10,20,30,45,65,90,135,200 --seconds 30 --cooldown 15 --concurrency 4` |
| `stored.json` | VM, after idle-socket correction: `--profile stored --rates 45,65,90,135,200 --seconds 30 --cooldown 15 --concurrency 4` |
| `gateway.json` | VM, separate `benchmark-capacity-gateway.py`: `--backend <active-reader-backend> --rates 5,10,20,30,45,65,90,135,200 --seconds 60 --cooldown 15` |
| `wallet.json` | VM: `--profile wallet --rates 0.25,0.5,1 --seconds 60 --cooldown 15 --concurrency 2` |
| `network.json` | Mac: `benchmark-capacity-network.py --host domino-host`; 32 MiB synthetic transfer, at most 8 MiB/s, new SSH connection without compression |

Append `--output <private-task-file.json>` to each command. Higher planned rates were not executed after a stop. Runs were sequential; no additional load remained active after collection. Short one-request/s smoke runs preceded the stored/gateway curves and are not used to establish capacity.

**Exit zero means the script completed, not that the workload qualified.** Inspect `stoppedEarly`, failures, drops, actual duration, delivered rate and health. The preventive SLO includes three consecutive slow responses as well as rolling/final p95; the shared reason name `slo_p95` in these records can denote either. An interruption with low overall p95 does not establish a hardware ceiling.

The node guard uses the existing infrastructure script's CPU/memory/I/O/head/tunnel checks, with a stricter 200-block study cap, plus nginx aggregate checks. It collects a 30-second edge baseline, then samples approximately every five seconds. It stops for a 503 fraction more than five percentage points above baseline sustained for 30 seconds, or upstream p95 above 200 ms sustained for 15 seconds. Raw IPs and paths are never retained. The helper's hash is recorded in `node-script-sha256.txt`. This guard was used for the node curves; the VM API curves use bounded concurrency, response deadline, errors and latency admission stops, not the host-only guard.

The gateway fixture retains production code for signature verification, client quotas, four stored slots and two worker threads. It simulates 1,000 distinct IP identities only inside a separate ASGI app, using an ephemeral RSA key. It never changes production authentication, publishes a listener or forges clients against the public gateway. Its reader HTTP and PostgreSQL are real. It excludes gateway Uvicorn, Access/network/Cloudflare overhead and is not an end-to-end Internet benchmark.

The published harness includes later diagnostic improvements: final-stage gateway stop accounting; idle keep-alive replacement; extra wallet response counts. The gateway run used the earlier instrumented version; all complete stages shown had zero failures/drops and low tail latency, and the failed stage stopped on its actual 429. Node runs preceded the wallet-only response-count addition and idle-connection change. These changes do not revise the recorded request counts or turn failed stages into passes. `stored-initial.json` retains the transport interruption; only `stored.json` is used for the 45/s reader conclusion.

`wallet-correlation.json` contains selected safe fields from the reader journal, not raw log lines. `postconditions.json` contains the corresponding aggregate nginx interval and a final node/tunnel health snapshot. The final standalone health sample has no preceding resource counters, so its null CPU/I/O fields are unavailable, not zero. Resource maxima in the report come from the continuously guarded node curves.

`prior-public-soak.json` is an extract of the separate infrastructure repository's earlier 19 September qualification, with original artifact hash. It is historical evidence, not a rerun or evidence for today's complete app path.

Offline validation: `python3 -m unittest discover -s scripts -p 'test_benchmark_capacity.py'` (27 tests). The gateway diagnostic functions also received seven hermetic checks with sockets blocked. Only benchmark scripts and documentation were changed; application and infrastructure settings were not deployed.
