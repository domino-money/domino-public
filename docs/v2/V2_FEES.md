# Domino V2 — Fees earned and Your APR on Base and Arbitrum (item 3.1, path B)

The app shows Fees earned (24H, 7D, 30D, All), Your APR and "Last 24 hours" for a position from its fee history. On Robinhood the app's own edge function builds that history per visit from the own node. Base and Arbitrum have no such route. Here a follower per chain stores every Domino V2 position's history, and read-v6 serves it from storage: one write serves every visitor, so the provider bill does not grow with visits.

This is launch round P3's backend (written 4 Nov 2026; nothing is deployed before the 6 Nov launch). It adds one module, one migration, one unit and one read-v6 route. The V2 indexer, portfolio and activity do not change.

## Decisions (the owner delegated them; made 3 Nov 2026)

| Decision | How it is applied |
| --- | --- |
| Path B: the backend stores and serves the history | `backend/v2_fees.py` writes; read-v6 `position-fees` reads, with no call at request time |
| Only Domino V2 positions the V2 index knows | The follower follows `domino_v2.positions` (S1's, vault roots and successors) on its chain. A position made outside Domino is not followed. The history is the NFT's: it goes on when the position leaves a vault or changes hands |
| A separate component, not the indexer | Its own unit, cursor, advisory lock and tables. Disabling it affects nothing else |
| The "now" read every 60 s | `follow --poll 60`: once caught up, a pass a minute |
| Points hourly for 8 days, then one a day | `HOURLY_DAYS = 8`; older hourly points are thinned to each UTC day's first |
| History from Domino's first block on each chain | Base 52,176,808 and Arbitrum One 511,706,605 (the deployment's start block). A position minted before it starts there |
| Uniswap v3 and v4 | Both managers, by token id |
| Reads only through the configured V2 endpoints | The writer's V2 chain RPC file: Chainstack first, Alchemy the fallback, never a public RPC by default, never reordered (`v2_rpc`) |

## What runs

One instance per chain, `domino-v2-fees@base-8453` and `domino-v2-fees@arbitrum-42161`. It runs as `domino-write`, with the V2 indexer's sandbox, hosts file, sealed `v2-rpc-*` credentials and TPM access (`ops/systemd/domino-v2-fees@.service`). The public-data release installs it and never enables it.

**A pass** (`v2_fees.py step`, looped by `follow`):

1. **The cursor.** It is the index's checkpoint the follower last read to (`domino_v2.fee_cursor`), or the deployment's base before the first pass. If the index no longer has that checkpoint, the index rewound. The follower then deletes every fee row above the newest checkpoint still standing and reads on from there. This needs no RPC call.
2. **New positions.** Each position the index knows that the follower does not is read at the cursor:
   - Not there yet: it was minted after the cursor, so it follows the cursor from its mint.
   - Already there: its history before the cursor is missing. It is read back from Domino's first block in its own ranges (`reading`) until it reaches the cursor. A vault's root minted before the vault is the usual case.
   - Already there at Domino's first block (`since` kind `floor`): what it owed there is not counted. The fees accrue from the fee growth inside at that block.
3. **One range,** from the cursor to one of the index's checkpoints. The follower never reads the chain's head, so it never runs ahead of the index.
   - **Bounds:** at most `--span` blocks (50,000 by default) and a day of chain time. The range is halved, on a fresh client, when it holds more events than one step reads or needs more requests than a pass has (400).
   - **Events,** in at most three `eth_getLogs` filters, each split per endpoint window by `v2_rpc` (Chainstack's 10,000 blocks, at most 1,000 windows a request):
     - v3's NonfungiblePositionManager `IncreaseLiquidity`, `DecreaseLiquidity` and `Collect` by token id;
     - both managers' `Transfer` by token id;
     - v4's PoolManager `ModifyLiquidity` by pool id with the PositionManager as sender. The token id is the event's salt, so other positions in those pools are read and dropped.

     Every log is decoded strictly, and its block hash must be its header's.
   - **State,** for each block holding a settlement, a point or the range's end: its header, then one Multicall3 `eth_call` with every position's state there, at most 512 reads a call. The code of Multicall3, both managers, the v3 factory and StateView is proven against the profile once per process.
   - **The commit:** events, points and, when the range ends at the index's newest checkpoint, each position's state there ("now") go in one transaction with the cursor. The transaction holds that checkpoint against the index's deletion until it commits, and refuses if the cursor moved.
4. **One range of the positions read back,** furthest behind first, up to the cursor, where they follow it.

### The fees

The fees come from the position's own state, as Uniswap computes them, never from token transfers. So a manual add or withdrawal, native ETH and a shared transaction are all exact; the app's Robinhood ledger cannot tell those apart.

- **A settlement** is an increase, a decrease or a collect. It pays what accrued since the previous one: the liquidity before it times the change of the position's `feeGrowthInsideLast`, 2^128 apart, per token.
  - **v4:** `Position.update`, in 256 bits, read from StateView's `getPositionInfo` at the end of the block.
  - **v3:** the manager's per-token checkpoint, cut to 128 bits as `NonfungiblePositionManager` credits it. The manager's `tokensOwed` is also read. The fees are what it gained beyond the principal a decrease left and what a collect took, which stays exact when several of the position's events share a block, and when a position is closed and burned in one block.
- **The checks:**
  - The liquidity must add up: before, plus the events' deltas, must be the liquidity read after (`liquidity`: an event was not seen).
  - On v3, the growth product must agree with `tokensOwed` where it can be computed.
  - On v4, two settlements in one block after a liquidity change cannot be split (`same_block`: the growth between them is not readable). A collect then an increase, as a vault's compound does, can.
  - A settlement whose fees are not known leaves its `fees` null and the running sum null from there.
- **Fees earned at a block** are the fees settled since `since` plus what accrued since the last settlement there. That is the liquidity times the growth inside then less the position's checkpoint, read with the same Multicall3 call.
- **An automatic compound** (the vault's `Compounded` in that transaction, from the V2 index) is marked with the service fee it charged.

### Storage (migration 054, schema `domino_v2`)

The catalogue writer writes, the reader reads. Every row derived from a block carries it, so a rewind removes exactly what a reorganization voided. The volume is about 0.5 MB a position a year.

| Table | Key | Holds |
| --- | --- | --- |
| `fee_cursor` | chain | Domino's first block, the cursor (block, hash, time), whether it was the index's newest checkpoint, the last error |
| `fee_positions` | chain, dex, token id | Where its history starts (`mint` or `floor`), its status (`reading`, `following`, `burned`), how far it is read, its pool and range, its state before `since` |
| `fee_events` | + block, log index | Each block's settlements (their logs, the net liquidity change, the state after, the fees and their running sum, `why`, the automatic compound and its service fee), and the NFT's transfers |
| `fee_points` | + block | The hour it stands for, `hour` or `day`, earned and settled per token |
| `fee_now` | chain, dex, token id | Its state at the cursor |

### The read (read-v6 1.2.0-rc.1)

`POST /v6/read/position-fees` `{chainId, positions: [{dex, tokenId}]}` (1 to 8) answers, per position:
- its `status`, `since`, `through` and `freshness` (fresh up to 120 s);
- `exact` and `why`;
- its settlements, transfers and points;
- its state `now`.

The chain's follower is `follower`. Field by field, the [read-v6 README](../../api-contracts/read-v6/README.md#120-rc1-position-fees-and-its-window) is the reference.

`1.2.0-rc.1` changes no `1.1.0-rc.1` answer but its version. The reader and the gateway answer each request in the version it names, as crosschain-v1's switch window did. The package keeps `1.1.0-rc.1` as its own until the app and the read Worker move, so neither changes now.

## What it costs

These are Chainstack's request units: 1 a call, any method; reads of state older than 128 blocks count as archive, 2 under the Growth plan the provisioning note of 2 Oct names. A caught-up pass costs:
- the logs of about a minute: 3 `eth_getLogs` (2 when the chain has positions of one version only);
- the cursor's header;
- one Multicall3 call, which an hour's point shares.

| | Base | Arbitrum One |
| --- | --- | --- |
| Caught up, per day | 1,440 passes × 5 = about 7,200 | about 7,200, up to 8,600 if its state reads count as archive: the cursor, the index's newest checkpoint, is 10–25 s behind the head, about 40–100 blocks, near the 128 a full node keeps |
| Each settlement of a followed position | 2 (its header and one Multicall3 call) | 2 |
| History once, from Domino's first block (mid-November) | about 1.8 M blocks: ~550 `eth_getLogs` plus ~500 for points and settlements, **about 1,000–1,500** | about 14 M blocks: ~4,200 `eth_getLogs` plus ~500, **about 4,500–5,000** |
| A position learned late (read back from the first block) | as the history's logs, once, shared by those joining together | the same |

About 16,000 units a day for both chains is about 0.5 M a month: 2–3% of 20 M. One active vault costs the automation about 69,000 a day (V2_AUTOMATION_BACKEND.md). If the plan tightens, the logs could be read only when the "now" read shows a change, plus one read every 10 minutes: about 2,000 a day a chain. That is not built.

## Enabling it (after the launch; in this order)

1. **Migration 054,** from the archive of the release that carries it, as postgres, as 052 was: `apply_migrations.py --archive <tar> --archive-sha256 <hex> --commit <sha> --migrations 054_v2_fees`, `--inspect`, then `--apply`.
2. **The public-data release** from that commit (`install_public_data.py`). It installs `domino-v2-fees@.service`, disabled. Restart the lanes as for any public-data release.
3. **A first step by hand,** as `domino-write` with the unit's sandbox and credentials, as the indexer's registration ran:

   ```sh
   systemd-run --pipe --wait -p User=domino-write -p SupplementaryGroups=domino-db -p 'ImportCredential=v2-rpc-*' \
     -p PrivateDevices=yes -p 'DeviceAllow=char-tpm rw' \
     -p BindReadOnlyPaths=/etc/domino/continuous-reads/write.hosts:/etc/hosts \
     -p WorkingDirectory=/opt/domino/public-data/current/backend \
     /opt/domino/queue-worker/venv/bin/python -B v2_fees.py step --chain base-8453 \
     --chain-rpc-file /opt/domino/queue-worker/release/backend/runtime/chain-rpc.json
   ```

   It prints the range it read. `v2_fees.py status --chain base-8453` shows the cursor, the index's checkpoint and the positions per status.
4. **Start Base:** `systemctl enable --now domino-v2-fees@base-8453.service`, with `domino-v2-indexer@base-8453` following. Its journal has one JSON line per pass. The history takes minutes: wait for `caughtUp: true` and no `readBack`.
5. **Then Arbitrum One** the same way.
6. **The read release** with read-v6 `1.2.0-rc.1`: the reader and the gateway serve both versions, and `position-fees` stays closed (`DOMINO_BRIDGE_V6_READS` does not name it). Check locally with `-H 'X-Domino-Read-Contract: 1.2.0-rc.1'` on `POST 127.0.0.1:8876/v6/read/position-fees`.
7. **The app and the Worker** (below), then open the route. The owner approved it on 7 Nov 2026. Open it in this order, each step only once the one before it answers:
   1. **The gateway,** on the read release of step 6. Move the two 70 drop-ins aside, keeping them for the rollback. Run the activation with production's flags plus `--position-fees`, first with `--inspect`, then with `--apply`, and restart `domino-continuous-reads.target`:

      ```sh
      python3 -B install_read_activation.py --commit <sha> --read-v6 --chain-reads --balance-chains --position-fees --inspect
      python3 -B install_read_activation.py --commit <sha> --read-v6 --chain-reads --balance-chains --position-fees --apply
      ```

      - The receipt says `"positionFees": true`.
      - The gateway's `DOMINO_BRIDGE_V6_READS` becomes `portfolio,activity,chain-pools,chain-balances,chain-tokens,position-fees`. Nothing else in its drop-in changes.
      - The reader's drop-in does not change: `DOMINO_V2_READ=1` already serves the route.
      - Without `--chain-reads` the activation refuses (`position_fees_need_chain_reads`).
   2. **Check through the gateway** before anything else opens. The VM has no Access assertion, so the gateway stops at Access, after it has matched the route and its version:

      ```sh
      curl -sS -i -X POST http://127.0.0.1:8878/internal/read/v6/position-fees -H 'Content-Type: application/json' \
        -H 'X-Domino-Read-Contract: 1.2.0-rc.1' --data '{"chainId": 8453, "positions": [{"dex": 4, "tokenId": "41"}]}'
      ```

      - Open: `403` `{"error":"upstream_unavailable"}`, with `X-Domino-Read-Contract: 1.2.0-rc.1`.
      - Still closed: `404` `{"error":"route_not_available"}`, with `1.1.0-rc.1`, the answer before the flag.
      - The same POST naming `1.1.0-rc.1` stays `404` `route_not_available`: the route exists in `1.2.0-rc.1` alone.
      - The gateway's journal has the hop: `"route":"position-fees","contractVersion":"1.2.0-rc.1"`, `"status":403`, `"reason":"upstream_unavailable"`.
      - The reader answers in full, as in step 6: `200` in `1.2.0-rc.1`, each chain's `follower` `current`.
   3. **The tunnel:** *Publish read path* `tunnels-v6`, dispatched on a `main` commit whose scripts name the six routes (`<commit>`, `main`'s head when dispatched):

      ```sh
      gh workflow run read-path-release.yml -f operation=tunnels-v6 -f source_sha=<commit>
      ```

      - Its line says `"v6WalletReadsEnabled": true`.
      - `inspect` shows the production path ending in `v6/(portfolio|activity|chain-pools|chain-balances|chain-tokens|position-fees))$`, every other setting kept.
      - The path published since 5 Oct, with the five routes, is a known state that the publication widens.
   4. **The Worker:** *Publish read path* `worker-v6`, dispatched the same way. It deploys the Worker with that commit's read-v6 package, so the commit's contract must be the one the reader serves:

      ```sh
      gh workflow run read-path-release.yml -f operation=worker-v6 -f source_sha=<commit>
      ```

      - `ENABLED_V6_READS` becomes the six routes, and every other flag is kept; `inspect` shows them. The five routes it holds since 6 Oct are a known state that `worker-v6` alone widens.
      - The app's Base and Arbitrum positions then read the route: the gateway's journal has `position-fees` hops answered `200` in `1.2.0-rc.1`.

   The Worker goes last. Before the tunnel names the route, the Worker's reads of it would meet the tunnel's catch-all rule instead of the gateway, and fail as `upstream_unavailable`.

**Rollback:**
- **The route:** put the gateway's two saved 70 drop-ins back, or run the activation again without `--position-fees` (`--read-v6 --chain-reads --balance-chains`, the five routes). Then restart `domino-continuous-reads.target`.
  - The gateway then answers `position-fees` `404` `route_not_available`, before it reads the version. The Worker passes that on as it is: the answer the app had before the route opened. Only the Worker's `1.2.0-rc.1` capabilities still name the route.
  - The tunnel and the Worker may keep the six routes. No operation narrows them to five, and none needs to. `disable-v6` still closes the whole of read-v6, the Worker first.
  - A tunnel or a Worker still on the five routes, after an opening that stopped before it, is a known state: every publication keeps it, and `tunnels-v6` and `worker-v6` widen it.
  - The scripts from before position-fees refuse a tunnel or a Worker with six routes (`read_tunnel_configuration_mismatch`, `Unexpected existing V6 wallet read routes`). Once either holds six, publish from a commit that names them.
- **The follower:** `systemctl disable --now domino-v2-fees@<chain>` stops it; nothing else reads its tables. The tables can stay; dropping them is `DROP TABLE domino_v2.fee_now, domino_v2.fee_points, domino_v2.fee_events, domino_v2.fee_positions, domino_v2.fee_cursor` as postgres.

## What the app and the read Worker need (0xdecimal)

- **The Worker** (`bridge/src/worker.mjs`, `V6_PROTOCOL`):
  - speak `1.2.0-rc.1` (`version: NEXT_VERSION`);
  - accept both answers (`versions: CONTRACT_VERSIONS`, as `V5_PROTOCOL` does);
  - route `position-fees` (`NEXT_ROUTES` beside `ROUTES`), checked with the package's `validateExchange`;
  - name it in `ENABLED_V6_READS`.

  The bridge test's fixture lists stay as they are: 1.2.0-rc.1's fixtures are under `fixtures/1.2.0-rc.1/`.
- **The app:**
  1. read `position-fees` on 8453 and 42161 with `X-Domino-Read-Contract: 1.2.0-rc.1`, and accept both versions on the other routes (`READ_V6_CONTRACT_VERSION`, `READ_V6_PATHS`);
  2. map the answer into `FeeHistoryView` and reuse `lib/fees` (periods, points, `positionApr`), with a v3 variant of the state (`now.poolAddress`, `tokensOwed`);
     - `settled` is the ledger's `collected`: on v3 it is what the settlement credited to `tokensOwed`;
     - a `decrease` to liquidity 0 is a close;
     - the mint is the transfer from the zero address;
  3. replace `RecordedInsights` (the session's readings) with the stored history: Fees earned 24H/7D/30D/All, Your APR and "Last 24 hours";
  4. show `reading`, `stale` and `why` without inventing a number;
  5. value the raw amounts with the qualified prices it already reads.
- **Closing the window:** once the app and the Worker are on `1.2.0-rc.1`, make it the package's version (`CONTRACT_VERSION`), merge `fixtures/1.2.0-rc.1` into the fixture folders and drop `1.1.0-rc.1`.

## What is left out

- **`portfolio.positions[].fees`** (the design's option for the Positions list's APR without a request per row): `position-fees` takes 8 positions a request. It can be added in a later version.
- **Robinhood's follower** (item 3.6: v3 and native ETH there): the code takes any chain (`--provider-file` for Robinhood), but nothing installs or enables it there. That is the owner's decision 6.
- **The EVM test against Uniswap's own contracts:** the follower is tested over a chain model that settles as Uniswap does. A replay against Anvil with Base's runtimes (`tests/v2_local_chain.py`) would prove the same sums against real `collect`s.

## Verification

| Test | What it holds |
| --- | --- |
| `test_v2_fees.py` (PostgreSQL) | Over a chain that settles v3 and v4 as Uniswap does and enforces the log window, Multicall3's reads and the topic filters:<br>- every settlement's fees are what Uniswap paid, and Fees earned at every point and now are settled plus accrued;<br>- a position minted before the floor;<br>- one learned late, read back then following;<br>- a collect and a compound in one block;<br>- same-block and missed-event histories marked inexact;<br>- a v3 position closed and burned in one block;<br>- crowded ranges halved, and many positions over several Multicall3 calls;<br>- the follower held to the index's checkpoints; reorganizations before and during a pass;<br>- hourly then daily points, thinned;<br>- code proofs, a moved base, errors recorded and cleared;<br>- the read API answering what was stored;<br>- the calls a caught-up pass makes (five), an hour's point included |
| `test_read_v6_contract.py` | The package is what the producer exports, and the Python and JS validators agree on every fixture, both versions' included. The reader and the gateway answer each version asked and refuse a version or a route the window does not have. The gateway relays the version and refuses a reader answering another. `position-fees` stays closed until named. The largest answer fits the Worker's 1 MiB |
| `test_install_public_data.py`, `test_financial_release_systemd.py` | The unit is installed per chain, never enabled, with the indexer's user, sandbox and credentials |
| `test_fresh_host.py` (`ReadActivationTests`), `read-tunnel-config.test.mjs`, `publish-read-path.test.mjs` | Opening the route (step 7). `--position-fees` adds it, last, to the gateway's list alone, only with `--chain-reads`, and the receipt says so; the reader's drop-in stays byte for byte. The tunnel and the Worker write the six routes, keep the five and the two first as known states that `tunnels-v6` and `worker-v6` widen, and refuse any other list |
