# Markets snapshot: persisted and refreshed in the background — 18 September 2026

`27a1d73` keeps the markets snapshot between visitors and across restarts
(#155 T2.1, #177 §3.8). This records what the development lane showed when
that commit was installed there and driven through its own reader on
loopback. Nothing here is a production figure.

## What was measured, in order

The development reader was moved from `a5e85a8` to `27a1d73` (release tree
under `/opt/domino/dev/releases/`, the enable drop-in repointed, the unit
restarted). The dev lane refuses every read for `WINDOW_SECONDS` (60 s) after
its reader starts and does not serve `markets-snapshot` at all (its fixed
route set is the seven original reads), so the proof runs through
`pool-market`, `/health` and the journal.

| Step | Observed |
|---|---|
| Restart onto `27a1d73`, `/health` | `snapshotRefresh: running, interval 240, period 240, ticks 0`; no store file yet |
| `pool-market` WETH/USDG, 94 s after start | `200`, `market.status available`, `cache miss` — a real provider observation |
| The store | `/var/lib/domino-dev/reader/markets-snapshot.json`, `-rw------- domino-dev-read`, 1,949 bytes |
| `pool-market {fromSnapshot}` | `200`, `identityStatus verified_at_block`, `priceHistory not_requested` |
| 250 s later, `/health` | `ticks 1, refreshed 1, refused 0, failed 0` |
| The refresher's record | `{"service":"read","route":"markets-snapshot","mode":"refresh","durationMs":3448,"gate":"provider","admitted":true,"status":200}` |
| The store after that tick | rewritten (mtime advanced 148 s after the seed's write) |
| Restart, then 64 s with no read and no tick (`ticks 0, refreshed 0`) | `pool-market {fromSnapshot}` → `200`, `verified_at_block`, `market.status available` |
| Gate refusals of the refresher over the whole window | 0 |

The last row is the persistence proof: after the restart the process had
made no chain or provider read and its refresher had not ticked, so the
answer can only have come from the file it adopted at startup.

## A first run that proved nothing, and why

The first pass seeded the store two seconds after the restart and got `503
upstream_unavailable`; so did its `fromSnapshot` check five seconds after the
final restart. That is the development lane's own admission
(`DevelopmentBudgets.check`, `ready_at = start + 60 s`), which wraps every
operation, `fromSnapshot` included. With nothing stored, the refresher's one
tick was `idle`, which is the correct answer to an empty store. The second
pass waited out the window. Production has no such cooldown: `ReadGate`
admits from the first request.

## What this does and does not show

- A stored pool is re-observed inside the consumer's 300 s window without a
  visitor's read: one pool, one refresh every 240 s. At the alpha's six pools
  the period is 40 s and the provider cost is 1.5 observations a minute,
  inside both lanes' ceilings.
- A restart no longer answers `not_built`; it answers the last verified state
  with its real age, `stale` if the store is older than the window.
- The refresher took the provider slot through the gate and released it; it
  was never refused here because nothing else was reading. Under load it
  skips, which the hop record will show as `admitted: false`.
- Not shown: edge caching of the route (`ETag`, `Cache-Control`). The
  gateway and the Worker rebuild response headers and accept only `POST`, so
  that is a change to three hops and their contracts, left out of this work
  on purpose.
- Noticed on the way: a refusal by the development boundary leaves no reader
  hop record, because it happens outside the reader's middleware. The dev
  gateway records its own side; the reader's silence is a gap in the
  development lane's observability only.

## Rollback on the development lane

Restore `60-enable.conf.bak-20260918-e5` over the reader's enable drop-in,
`daemon-reload`, restart `domino-dev-read.service`. The store file is
ignored by a release that does not know it.
