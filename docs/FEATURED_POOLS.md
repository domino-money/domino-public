# Featured pools (featured-policy v1)

Once a day, before 12:00 UTC, the VM chooses the pools the site features, by
public rules, and records the choice and every reason behind it. The owner
sets the phase:

- **shadow** (the default): the list is recorded to be compared with the
  manual list and to calibrate the rules; nothing is served.
- **live**: the day's list is published at 12:00 UTC, kept warm and repaired
  during the day, and served to the site by read-v5
  (`POST /v5/read/featured-pools`).

## What runs

| Piece | Role |
| --- | --- |
| `backend/manage_featured.py` | `serve` (the unit's loop), `select` (one run now), `status`, and the owner's overrides |
| `backend/featured_selector.py` | One selection: listing, verification, rules, list, one transaction |
| `backend/featured_pools.py` | The rules, no I/O: eligibility, reference depth, diversity, ranking, hysteresis, slots |
| `backend/featured_evidence.py` | Chain reads at the verified block: active liquidity, the depth walk, token code and metadata |
| `backend/gt_listing.py` | GeckoTerminal listing pages and `/pools/multi`, parsed exactly as the collector parses `/pools/{id}` |
| `backend/featured_store.py` | Runs, lists, the served revision, overrides, health and token baselines |
| `backend/featured_live.py` | The live phase: warm-up, publication, keep-warm, health and repair, the owner's modes |
| `backend/featured_contract.py` | read-v5: the served revision on the wire, validated as it is served |
| `backend/featured_policy.json` | The defaults: floors, ceilings, hysteresis, diversity, schedule (changes need a PR and a deploy) |
| `backend/migrations/042_provider_priority.sql` | Provider calls by priority (see below) |
| `backend/migrations/043_featured_pools.sql` | The `domino_public.featured_*` tables |
| `backend/migrations/044_demand_horizon.sql` | The collector's demand horizon (see below) |
| `backend/migrations/045_featured_live.sql` | Health tracking, and the phase, mode, manual list and veto overrides |
| `api-contracts/read-v5/fixtures/` | The shared answers the Worker and the app validate against (`scripts/export-read-v5-fixtures.py`) |
| `ops/systemd/domino-featured.service` | The loop, every 30 s, as `domino-write`; installed with public data, never enabled by the installer |

## A selection

1. **Listing.** GeckoTerminal's Uniswap v4 pools on Robinhood by 24 h volume,
   20 a page, at most 10 pages, until a page ends below the volume floor.
   Each page first reserves a call with `reserve_provider_if_headroom(2)`.
   GeckoTerminal answers this host about six calls a minute, shared with the
   site's own reads, so the selection spaces its calls 20 s apart, and a 429
   or a full allowance waits 30 s and asks again for the same page, until the
   selection's 10-minute deadline.
2. **Screen.** Pools not already shown are dropped on provider fields alone
   (reference side, volume, liquidity, turnover, age, activity, fading
   volume, price move) before any chain read.
3. **Verify.** Each survivor's listing observation goes into a private cache
   and through `ReadService.pool_market(allow_provider=False)`, the same
   verified read the collector uses: the key rehashed to the pool id, the
   state at one block, the provider's currencies and DEX checked against it.
   `estimate_pool_apr` then gives the APR the site itself shows.
4. **Evidence.** Read through an RPC of its own at the block of the pool's
   verified market read (the production failover RPC reads state only at a
   block it has observed itself): active liquidity; the reference depth (`reference_depth`:
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
the previous list (`carried_over`). Outside 11:30-12:00 UTC no selection runs.

The selection itself never asks the collectors for anything: no
`request_entity`, no catalogue seed, no history job, no activity request
(`test_featured_selection.py` holds those tables empty). In the live phase it
writes the day's list as a draft; only the live service below serves it.

## The live phase

Each tick (every 30 s), in this order:

1. **Mode.** `off` serves `none`. `manual` serves the owner's pools, each
   checked against the safety rules when the list changes (a pool that fails
   one is dropped and reported). `auto` serves the day's selection.
2. **Keep warm.** The served list, today's draft, the manual list and the
   embedded list get `keep_warm_until` = now + 26 h (written again once less
   than 25 h remain). A short list's next candidates (the pools that would
   complete it, in refill order, and two beyond) get it for 1 h. The collector
   claims these pools ahead of its background backlog and refreshes them every
   240 s with the whole provider allowance (the featured tier, #278).
3. **Warm-up, 11:30-12:25 UTC.** The draft's newcomers get their verified
   identity into the catalogue once (a hint at the verified block), then are
   asked for as a visitor would ask (`request_many`): the collector refreshes
   them every 5 s and the history lane builds their chart.
4. **Publication, from 12:00 UTC.** The draft is served as soon as every
   newcomer is ready: an `available` estimate from its stored payload, both
   tokens' decimals and two complete hourly candles. From 12:25 the list is
   composed again without the newcomers still warming: their slots go to the
   pools they would have replaced, then to ready eligible pools, then to the
   embedded list. At 12:30 with nothing published, the served list stays
   (`carried_over`, its times unchanged). A veto for the date keeps the served
   list. An owner's list (`manual`, `none`) is never carried over: it stays
   until a selection is published, so `mode auto` takes effect at the next
   12:00 UTC.
5. **Health, all day.** Reads the stored payloads only; no provider call and,
   except for the hourly token check, no RPC:

   | A served pool leaves when | Once it has held for | Pins and manual pools too |
   | --- | --- | --- |
   | the owner excludes it or its token | (at once) | yes |
   | its integration class, fixed fee or protocol fee breaks a safety rule | (at once) | yes |
   | its token's code changed (checked hourly; the token is then excluded) | (at once) | yes |
   | reported TVL is below half the floor | 10 min | yes |
   | the listed token fell below 30% of its price at selection | 10 min | yes |
   | the APR or the turnover is above its ceiling | 30 min | yes |
   | the estimate is unavailable for a reason of its own (below) | 3 h | no |
   | 24 h volume is below a tenth of the floor | 3 h | no |

   A condition must be seen on at least two checks; one that clears starts
   its window again. An estimate missing only because the data is late
   (snapshot or market past five minutes) or the provider refused (rate
   limited, busy or unavailable, with the TVL and volume it leaves missing) is
   unknown, not a fault of the pool, and does not count while the last good
   data is at most 6 h old (#278). Beyond that it counts again. Nor does an
   answer that did not come clear a condition: when the provider is busy and
   the market figures are missing, their conditions (and a late estimate's)
   keep their window as it is, no check is counted, and none is confirmed
   until a check sees the condition again.

   The others keep their order. The list is completed from the day's ranked
   pools, then from the embedded list, with pools that are ready and show no
   condition now, never with a pool withdrawn this week nor from a selection
   the owner vetoed; a manual list is not completed. It becomes a new revision
   (`repaired`; a manual list stays `manual`). A list still short, even an
   empty one, looks for ready replacements again every 2 minutes and takes
   them as soon as they are ready, without another pool having to leave
   (#278): health reports `healthy` (or `idle` when empty) with its `vacant`
   slots, or `refilled` with the pools it added. The pool is listed in `withdrawn` for 7 days (at most 24), so a
   link to it can be refused, until a selection or the owner lists it again.

Back in shadow, a list served while live gives way to `none`: nothing would
check its health.

## read-v5

`POST /v5/read/featured-pools` with the body `{}` answers the served revision
as it was stored: its pools, the rules and the evaluation summary recorded at
selection, and the week's removals. `none` means nothing is served (never
served, or mode off, which keeps `withdrawn`). `upcoming` is always `null`: the
day's draft stays on the VM. The reader reads `featured_current` and
`featured_lists` through the reader role, which cannot read runs, overrides or
health; a stored list the contract refuses answers `upstream_contract_mismatch`,
never a partial list.

The contract is `backend/featured_contract.py`. Its shared fixtures are in
`api-contracts/read-v5/fixtures`: every file under `valid/` must be accepted
and every file under `invalid/` (one defect each, named by the file) refused,
by any validator. `scripts/export-read-v5-fixtures.py` writes them from the
producer and `backend/tests/test_featured_contract.py` fails when they drift.
The Worker's `runtime.mjs`, the Pages Function with its edge cache and the
app's consumption are the bridge side's (featured-pools v1 §10.3).

The gateway serves the route only with `--enable-v5` and
`DOMINO_BRIDGE_V5_READS=featured-pools`; otherwise it answers 404.

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
psql -v ON_ERROR_STOP=1 -1 -f backend/migrations/044_demand_horizon.sql
psql -v ON_ERROR_STOP=1 -1 -f backend/migrations/045_featured_live.sql
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

Going live. The first list is the draft of the first selection run in the live
phase: set the phase before 11:30 UTC for it to be published at 12:00 UTC the
same day. The live service warms pools up and keeps them warm from then on.
The owner's controls apply at the next tick (exclusions, `mode off`, `mode
manual`) or at the next selection (pins, `mode auto`); a veto must be set
before 12:00 UTC:

```bash
manage_featured.py phase --set live --reason "…"
manage_featured.py mode --set off --reason "…"            # or manual, auto
manage_featured.py manual --pools 0x…,0x… --reason "…"    # served while the mode is manual
manage_featured.py veto --date 2026-10-10 --reason "…"
```

Serving the route follows featured-pools v1 §10.5: the app tolerant of a
missing list and the Worker with the v5 code (flag off) first; then the reader
and the gateway with the route but without `--enable-v5`, and the migrations;
then `--enable-v5` with `DOMINO_BRIDGE_V5_READS=featured-pools` and a gateway
restart; then one real answer recorded on the VM and validated by both
runtimes; the Worker flag last. The route answers `none` until the first
publication.

Stop it with `systemctl disable --now domino-featured.service`. The served list
then stays as it was, unrepaired: when it should go too, set `mode --set off`
and wait for a tick (30 s) first. Disable the unit before rolling public data back to a release without
`manage_featured.py`.

## Provider priority (042, 047)

Every GeckoTerminal call spends the one allowance of 024, **8 a minute** since
047 (#278): GeckoTerminal's free API allows 10 a minute per address, and the
VM shares its address with the rest of the house. 042's 25 hid that while the
collector called little; once the listed pools were refreshed on time it
reached 11 a minute and most answers were 429s. A pool someone asked for once
stays explicit and is refreshed for good; while nobody reads it, the collector
spends a call only while 3 of the minute's calls remain
(`IDLE_PROVIDER_HEADROOM`), the selection only while 2 remain, and a pool a
visitor is reading or the featured list keeps warm keeps the whole allowance.
Recalibrate the ceiling (047, `PROVIDER_CALLS_PER_MINUTE`) and the two
headrooms together, from a day of samples of what the collector's
publications record:

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

## Demand horizon (044)

A pool someone asked for once used to be refreshed for good. The collector now
follows how long ago it was last asked for:

| Last asked for | Refresh | Provider | Activity requests | History job |
| --- | --- | --- | --- | --- |
| within 60 s (hot) | 5 s | yes | yes | yes |
| within 24 h | 120 s | yes | yes | yes |
| within 7 days | 900 s | yes | no | yes |
| earlier (cold) | 3600 s | no | no | no |
| kept warm by the featured list, when the above is slower | 240 s | yes, the whole allowance | no | yes |

A new request makes the pool hot again. A pool with `keep_warm_until` in the
future (the featured lists' pools and a short list's next candidates, written
by the live service) is refreshed at least every 240 s, and the collector
claims it, like a pool on screen, ahead of the backlog of due pools (#278:
8,842 pools and 10,800 tokens were overdue, and the listed pools waited 76
minutes behind them).

## Known limits

- Volume and liquidity are the provider's. Wash trading on-chain is real
  trading, and positions are cheap to split across addresses: the reference
  depth (real ETH, WETH or USDG within 10%) is the rule that costs capital.
- The depth is measured once, at selection; the selection minute is public.
- The universe is the listing's top pools by volume (`coverage.truncated`).
- Age comes from the catalogue's Initialize block when the catalogue has the
  pool, otherwise from the provider's `pool_created_at`.
