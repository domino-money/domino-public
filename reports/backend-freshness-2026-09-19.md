# Backend freshness investigation — 19 September 2026

Read-only evidence collected on `domino-alpha` at approximately 22:47–22:51 UTC.
No services were restarted, queue statuses changed, or historical work replayed.
Provider credentials and URLs containing credentials are omitted.

## Historical activity stops after its first catch-up

The database contained **15 `following` pools and 2 `indexing` pools**. The only
enabled indexing timers were `domino-catalogue-follower.timer` and
`domino-queue-worker.timer`, each firing every minute. There was no installed
activity-following unit. Catalogue discovery continues independently of activity.

The deployed `pool_requests.py`, verified directly under
`/opt/domino/queue-worker/release/backend`, has:

```python
CLAIMABLE = ('queued', 'indexing', 'registering')
```

Its claim query filters by that list. `manage_activity.py` marks a pool `following`
when a bounded pass reaches its target, then never claims that pool again. Even a
new read does not requeue it: migration 020's `request_pool` function uses
`ON CONFLICT(pool_id) DO NOTHING`. The local source has the same behavior at
`backend/pool_requests.py:19,85` and `backend/manage_activity.py:324`.

Representative durable checkpoints:

| Pool prefix | Status | Last activity block | Block timestamp | Age at query |
| --- | --- | ---: | ---: | ---: |
| `0x84bd4e2d8be1` | following | 64,744,074 | 1,789,585,416 | 272,680 s / 3.16 days |
| `0x94c62eebf645` | following | 64,403,874 | 1,789,551,167 | 306,929 s / 3.55 days |
| `0x349d621df99e` | following | 67,423,239 | 1,789,855,180 | 2,916 s / 48.6 min |

The first row was last updated to `following` on **2026-09-16 19:05:50 UTC**.
The catalogue's `next_block` at the query was **67,451,297**, revision 5,184.
Consequently, a fast HTTP response and a current catalogue do not establish fresh
historical activity. `pool_metrics` explicitly carries the old snapshot and stale
freshness; it should not be relabeled as current.

## The two remaining backfills retry an oversized log request indefinitely

Installed queue-worker bounds:

```text
--max-pools 2 --max-steps 5 --span 100000 --lag 100
--parallel-walks --max-header-calls 5000
--search-back-blocks 400000 --search-span 5000 --search-max-spans 80
```

The worker uses an older provider configuration, version 2, pointing to
`robinhood-mainnet.g.alchemy.com`. Its deployed `manage_activity.py` reads only
`rpcUrl`; it predates the current/history RPC routing in current source.

The two `indexing` rows had 4,329 and 3,866 attempts and `last_error=http_400`.
Recent journals showed the same two pools failing every minute with
`headerCalls: 0`, while systemd reported successful service completion. The
program treats these errors as retryable `indexing` and returns success unless a
pool is `blocked` (`backend/manage_activity.py:332–341`).

Four bounded, read-only `eth_getLogs` calls, executed as the worker user against
its configured provider, isolated the failure. The address and topics were the
same PoolManager/pool filters the indexer uses; only the range length changed.

| Pool prefix | Start block | Range | HTTP | RPC code | Logs | Duration |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `0x24107d152f14` | 9,638,712 | 100,000 | 400 | -32602 | unavailable | 693 ms |
| `0x24107d152f14` | 9,638,712 | 1,000 | 200 | — | 53 | 755 ms |
| `0x4be9657ec900` | 50,906,350 | 100,000 | 400 | -32602 | unavailable | 604 ms |
| `0x4be9657ec900` | 50,906,350 | 1,000 | 200 | — | 41 | 698 ms |

The provider reported log-response size overflow, with a 10,000-log cap for wider
ranges and allowance for ranges up to 5,000 blocks. This is a query-capacity
failure, not an authentication failure. The next chunks never commit because the
same 100,000-block query is retried unchanged.

## Financial history has not been populated

The database contained **zero rows in `fee_chunks`, `position_chunks`, and
`capital_chunks`**, and no rows in `historical_work`. No fee, position or capital
collector service was active. Advancing activity alone would not fabricate or
qualify historical fee APR or TVL; those dependent accounting stages still need
their separate bounded acquisition and reconciliation.

## Stored read admission reproducer

`scripts/benchmark-read-admission.py` is a hermetic diagnostic using real gateway
and reader ASGI applications and ephemeral test identities. It uses no network,
PostgreSQL, or production state and exits zero when the probes complete. It reports
actual versus desired behavior, rather than adding known-failing regression tests
to the normal suite.

At this revision, holding only the reader's provider slot causes both `catalogue`
and `markets-snapshot` to return **429 with a 10-second retry hint**, despite their
stored response paths being available. Holding only the gateway provider slot
also blocks `markets-snapshot`. This is independent of RPC execution time:

- `backend/read_gateway.py:103–114` checks `health.busy` for every route and ignores
  `storedBusy` when the route uses the stored lane.
- `markets-snapshot` is classified as provider work in the gateway even though
  `backend/read_api.py:461–467` serves it outside reader admission with no RPC.
- `pool-metrics` really performs RPC canonicality checks
  (`backend/read_service.py:449–456`) despite the stale gate comment calling it
  stored-only; any correction must account for that actual work.
- The development gateway currently acquires one provider slot explicitly, so a
  shared route-classification change must preserve its separate admission contract
  and release the slot actually acquired.

## Bounded follow-up fixes

1. Make stored gateway admission and reader-health checks route-aware while
   preserving authentication, per-client budgets and bounded concurrency.
2. Schedule already-caught-up activity pools again with explicit priority and
   cadence. Merely adding `following` to a 2-pool/minute queue would take at least
   8.5 minutes to revisit 17 pools, exceeding the 120-second freshness criterion.
3. Split dense log windows on the observed provider size refusal, with bounded
   attempts and a persisted smaller useful span. Verify one affected chunk before
   starting wider replay; retain checkpoint and canonicality checks.
4. Preserve missing/stale financial semantics. Activate dependent accounting only
   through its own measured bounded workflow; no mass replay was run in this audit.
