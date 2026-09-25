# Featured pools (featured-policy v1): the shadow selection

Once a day, before 12:00 UTC, the VM chooses the pools the site would feature,
by public rules, and records the choice and every reason behind it. In this
phase (shadow) nothing is published: the site keeps showing the manual list,
and the shadow list exists to be compared with it and to calibrate the rules.

## What runs

| Piece | Role |
| --- | --- |
| `backend/manage_featured.py` | `serve` (the unit's loop), `select` (one run now), `status`, and the owner's overrides |
| `backend/featured_selector.py` | One selection: listing, verification, rules, list, one transaction |
| `backend/featured_pools.py` | The rules, no I/O: eligibility, reference depth, diversity, ranking, hysteresis, slots |
| `backend/featured_evidence.py` | Chain reads at the verified block: active liquidity, the depth walk, token code and metadata |
| `backend/gt_listing.py` | GeckoTerminal listing pages and `/pools/multi`, parsed exactly as the collector parses `/pools/{id}` |
| `backend/featured_store.py` | Runs, lists, overrides and token baselines |
| `backend/featured_policy.json` | The defaults: floors, ceilings, hysteresis, diversity, schedule (changes need a PR and a deploy) |
| `backend/migrations/042_provider_priority.sql` | Provider calls by priority (see below) |
| `backend/migrations/043_featured_pools.sql` | The `domino_public.featured_*` tables |
| `ops/systemd/domino-featured.service` | The loop, as `domino-write`; installed with public data, never enabled by the installer |

## A selection

1. **Listing.** GeckoTerminal's Uniswap v4 pools on Robinhood by 24 h volume,
   20 a page, at most 10 pages, until a page ends below the volume floor.
   Each page first reserves a call with `reserve_provider_if_headroom(2)`.
2. **Screen.** Pools not already shown are dropped on provider fields alone
   (reference side, volume, liquidity, turnover, age, activity, fading
   volume, price move) before any chain read.
3. **Verify.** Each survivor's listing observation goes into a private cache
   and through `ReadService.pool_market(allow_provider=False)`, the same
   verified read the collector uses: the key rehashed to the pool id, the
   state at one block, the provider's currencies and DEX checked against it.
   `estimate_pool_apr` then gives the APR the site itself shows.
4. **Evidence.** Active liquidity; the reference depth (`reference_depth`:
   the pool's liquidity walked tick by tick until the non-reference side is
   10% cheaper, so a narrow position counts only for its width); the token's
   code, symbol and decimals.
5. **Pools already shown** (pinned, the previous list, the embedded list)
   that the listing did not reach are read with one `/pools/multi` call and
   evaluated the same way.
6. **Rules and list.** `featured_pools.evaluate` and `compose`. The first run
   has no earlier evaluation to persist against, so it only records one
   (`bootstrap`); "eligible yesterday" (E17b) reads the latest completed run of
   the last 48 hours.

A listing the provider cut short (`http_429`, the allowance refused) is
`incomplete` and retried each minute until 11:50 UTC; the last attempt keeps
the previous list (`carried_over`). Outside 11:30-12:00 UTC nothing runs.

The shadow never asks the collectors for anything: no `request_entity`, no
catalogue seed, no history job, no activity request (`test_featured_selection.py`
holds those tables empty).

## Rules

Safety rules are never relaxed, not for pins: verified identity, no hook,
fixed fee, symmetric protocol fee, a reference side (ETH, WETH or USDG, not
ETH/WETH), the token rules, owner exclusions, an `available` estimate and
active liquidity. Market rules are calibrated in the shadow; pins skip them and
the previous list's pools meet the volume, liquidity and depth floors at 70%.
`featured_policy.json` holds every value; `rules.REASONS` lists every code a
rejection can carry.

Token rules read the token's code, not proxy storage slots (the read allowlist
admits no `eth_getStorageAt`): code that can `DELEGATECALL` - outside PUSH data
and the compiler's metadata - is upgradeable and stays out unless reviewed; an
EIP-1167 clone is judged by the code it runs. Symbols are read as the site reads
them (`symbol_reading`, the port of `symbolReading`).

## Operating it

Apply the migrations as the owner of 024's functions (the public-data
deployment path), one transaction each:

```bash
psql -v ON_ERROR_STOP=1 -1 -f backend/migrations/042_provider_priority.sql
psql -v ON_ERROR_STOP=1 -1 -f backend/migrations/043_featured_pools.sql
```

`install_public_data.py` installs the unit with the release but does not enable
it. Start the shadow:

```bash
systemctl enable --now domino-featured.service
```

Run `manage_featured.py` the way the other public-data CLIs run: as
`domino-write`, with the queue worker's interpreter, from
`/opt/domino/public-data/current/backend`. `status` shows the last runs and the
latest list. Overrides apply from the next selection:

```bash
manage_featured.py pin --pool-id 0x… --slot 1 --reason "owner's choice"
manage_featured.py exclude --token 0x… --reason "…" --until <UTC seconds>
manage_featured.py unexclude --token 0x…
```

Stop it with `systemctl disable --now domino-featured.service`. Disable it
before rolling public data back to a release without `manage_featured.py`.

## Provider priority (042)

Every GeckoTerminal call spends the one allowance of 024 (25 a minute). A pool
someone asked for once stays explicit and is refreshed for good; while nobody
reads it, the collector now spends a call only while 8 of the minute's calls
remain (`IDLE_PROVIDER_HEADROOM`), the selection only while 2 remain, and a pool
a visitor is reading keeps the whole allowance. Recalibrate the ceiling in
042 and the two headrooms together, from a day of samples of what the
collector's publications record:

```sql
SELECT payload->'market'->'cache'->>'status' AS cache,
       coalesce(payload->'market'->>'reason','-') AS reason, count(*) AS pools
FROM domino_public.entities
WHERE kind='pool' AND payload IS NOT NULL AND observed_at>=extract(epoch FROM now())::bigint-60
GROUP BY 1,2 ORDER BY 3 DESC;
```

`miss` is a call made, `stale_fallback` with `provider_rate_limited` a 429,
`rate_limited` with `provider_capacity_busy` a call the allowance refused.
`provider_requests` itself keeps only the last 60 seconds.

## Known limits

- Volume and liquidity are the provider's. Wash trading on-chain is real
  trading, and positions are cheap to split across addresses: the reference
  depth (real ETH, WETH or USDG within 10%) is the rule that costs capital.
- The depth is measured once, at selection; the selection minute is public.
- The universe is the listing's top pools by volume (`coverage.truncated`).
- Age comes from the catalogue's Initialize block when the catalogue has the
  pool, otherwise from the provider's `pool_created_at`.
