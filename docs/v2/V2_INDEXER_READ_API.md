# Domino V2 — indexer and read API (#283, item 3b)

The V2 indexer follows each chain's V2 deployment from its first block and keeps, in PostgreSQL, every event of the V2 contracts and of the vaults their factories create, cut into receipts per wallet, with the latest reads of what those events name. The read API (contract **read-v6**) answers the app (F7) from that index: one wallet's vaults, positions, mandates, credits and receipts on Robinhood (4663), Base (8453) and Arbitrum One (42161), with explicit per-chain freshness. It adds new modules, one migration and one contract; no V1 module, route, contract or manifest changes behaviour. It builds on the automation (3a, PR #306, on main) and reuses its deployment-manifest loader (`backend/v2_manifest.py`) and its local chain fixture (`backend/tests/v2_local_chain.py`).

## The slice and why

The app has no other source for lists and history on Base and Arbitrum (owner, 2 Oct: no public RPC in the browser), v4 positions are not enumerable per owner on chain, and a receipt needs events from several contracts of one transaction. So this slice builds the whole path from the chain to the app's wire, for every V2 event family, rather than a part of it:

1. **Indexer** (all event families, reorg-safe, bounded, few calls) and its **enrichment** reads (vault state, positions, mandate terms, tokens, gas).
2. **Storage**: migration `052_v2_index.sql`, schema `domino_v2`.
3. **read-v6**: two stored routes on the local reader and the gateway, the generated package (schemas, fixtures, types, runtime, manifest) and CI checks.

Left for the next slices (see [What remains](#what-remains)): the bridge Worker route and the app's consumption, installation on the VM, the pools list for Base and Arbitrum, qualified USD, the anchor's reference price per vault.

## Owner decisions this slice encodes

| Decision | Date | How it is applied |
| --- | --- | --- |
| Chains: Robinhood (own node), Base and Arbitrum (hosted RPC billed per call) | 1–2 Oct | One indexer per chain, one `getLogs` per range per 100 addresses with the topic filter, header reads batched, the finalized block read at most once a minute, no `eth_chainId`, enrichment only when something is due. Per-chain `unavailable`/`stale` from day one; one chain out never empties the others. |
| Browser reads of Base and Arbitrum go through this API for lists and history (F7 §9 item 9) | 2 Oct | read-v6 serves every chain's lists and history; the app reads only pre-sign data through the wallet. |
| USD only from qualified sources (pool against the chain's stable, or the profile's Chainlink ETH/USD), never totalled across chains without it | 2 Oct | No source is qualified in this slice: every `price` is `null` with `priceReason: no_qualified_price_source`, and no answer sums anything across chains. |
| Waiting reasons (§9 item 24): the automation records the last simulation revert per vault and mandate; expose `waiting: {reason, since}` | 2 Oct | `waiting` on every vault and active mandate, read from the automation's waiting file (below), with the contract error's name. |
| A vault may be paused while auto-exit protects it | 2 Oct | `paused`, `pausedBy`, `exitModule`, `rootArmed`, the custody reason: states, not errors; `paused` is not a mandate blocker. |
| Hooked v4 pools are refused; tariffs per PRICING_POLICY V2 | 1 Oct | The index records what the contracts did; tariffs are shown with their rate (65, 200/400, 20 bps) and token, as charged. |

## What exists now

| Module | What it does |
| --- | --- |
| `backend/v2_manifest.py` (3a's, PR #306) | Loads issue #301's manifest (PR #302's format, `scripts/v2/deploy-manifest.schema.json`), bound to the chain profile, admitted for production, a fork rehearsal or a local test (below). This slice has no loader of its own. |
| `backend/v2_events.py` | The event catalog per emitter kind, from the frozen ABI exports (`api-contracts/v2/abi`) plus F1b's `SwapLegExecuted` (pinned to the Solidity source); strict decoding (topic count, clean high bits, canonical re-encoding). |
| `backend/v2_activity.py` | Cuts one transaction's decoded logs into receipts (items) per wallet; finds the positions they name. |
| `backend/v2_index_store.py` | The writer (one per chain, session advisory lock, optimistic `revision`) and the reader (one `REPEATABLE READ READ ONLY` snapshot per answer). |
| `backend/v2_snapshots.py` | The enrichment reads, pinned at the latest checkpoint's block. |
| `backend/v2_indexer.py` | Registration, passes, reconciliation and rewind, enrichment; CLI `register`, `step`, `follow`, `status`. |
| `backend/v2_waiting.py` | Reads the automation's per-chain waiting file whole or not at all, `since` and `sinceBlock` as recorded. |
| `backend/v2_read_contract.py`, `backend/v2_read_service.py` | read-v6's models and builders. |
| `backend/migrations/052_v2_index.sql` | The schema. In production `scripts/staging/apply_migrations.py` applies it as postgres, the owner of `domino_v2` as of `domino_public` (registered in `dev_postgres.py` and the staging helpers; `upgrade_financial` does not apply it). |
| `scripts/export-read-v6-contract.py`, `api-contracts/read-v6/` | The contract package. |

## The deployment manifest (#301)

The indexer registers a `v2_manifest.Deployment`: 3a's loader applies the deployment tool's `validateManifest` rules to PR #302's format (the 18 top-level keys, the 13 contract names, the fixed policies, the roles, every address derived from the deployer's F0 salts through CreateX's CREATE3 and each executor as its implementation's first CREATE, the build's compiler profile and source-tree hash, complete distinct receipts and the verification record), binds it to the chain profile (chain id, name and native symbol, the dependencies at the profile's addresses and, outside a local test, their verified code hashes and the charge currencies), and admits it for one use (`--admission`): `production` only a verified `public-chain-preparation` manifest built from committed sources and verified at `finalized`; `fork-rehearsal` and `local-test` only their own environment.

`register` then proves the manifest on the chain before following it: every receipt's block and the verification block are canonical, and every Domino runtime (and, outside a local test, every dependency) has the manifest's code hash. The index starts at the earliest receipt; the manifest is stored with its SHA-256 (of the canonical JSON), and a chain follows one deployment.

## How a chain is followed

- **Cursor.** `deployments.next_block` and `revision` per chain; each committed range is a checkpoint `(end_block, end_hash, end_timestamp)`. A pass takes the chain's advisory lock, so one writer per chain.
- **A pass** (`step`): observe the head (the shared head file of F6's `HeadFollower`, or the node), the finalized block (at most once a minute), then reconcile, index one range, enrich, and read the automation's waiting file when one is given (a local file, no call).
- **Reorganizations** (V1's approach): the latest checkpoint must still be on the chain (its block at or below the head, with its hash); otherwise the pass walks back through up to 64 checkpoints and rewinds to the newest that stands, or to the deployment's base. A base that moved is `v2_deployment_reorganized` (re-register). Inside a range, the boundary headers are read before and after the logs, and every event's block hash must be its header's; any mismatch is `index_snapshot_reorganized` and nothing is committed. A rewind deletes every row above the fork (logs, activity, vaults, positions, snapshots, mandates, transactions) and relinks positions whose vault went away.
- **Bounds.** A range is at most `--span` blocks (10,000 by default, 100,000 at most), at about 10 s of blocks below the head (`--lag`); each `getLogs` window is split by the endpoint's `maxLogBlocks`; a pass has a request budget (400) and an event budget. A vault created in a range is followed from its creation block in the same range.
- **Calls per pass when idle:** the head (shared), one header for the checkpoint, nothing else; a range with events adds one `getLogs` per 100 followed addresses, the event blocks' headers (batched) and the enrichment due.

### Tables (`domino_v2`)

| Table | Key | Holds | Removed by a rewind |
| --- | --- | --- | --- |
| `deployments` | chain | The manifest (and its sha256), first block, base hash, cursor, revision, last head and finalized block observed, last error | — |
| `contracts` | chain, address | The 13 components: emitter kind, dex | — |
| `checkpoints` | chain, end block | Committed ranges | above the fork |
| `vaults` | chain, vault | Every vault a factory created: owner, dex, root, owner nonce, creation | created above the fork |
| `logs` | chain, block, log index | Every decoded event: emitter, event, args (JSON, integers as strings), keys (owner, vault, dex, token id, ref) | above the fork |
| `activity` | chain, block, log index, wallet | One receipt per wallet: kind, anchor log, its log indexes | above the fork |
| `positions` | chain, dex, token id | Positions the index knows: source (`vault_root`, `vault_successor`, `s1`), vault, wallet, first and last event block | first seen above the fork |
| `position_snapshots` | chain, dex, token id | The latest read: `live`, `burned` (proven by the manager's `Transfer` to zero) or `unavailable` | read above the fork |
| `vault_snapshots` | chain, vault | The latest read of the vault's views, ledgers and reserves | read above the fork |
| `mandates` | chain, mandate hash | The terms read from `mandateOf`, checked against `MandateRegistered` | registered above the fork |
| `transactions` | chain, tx | Sender, status, gas used, effective gas price, L1 fee | above the fork |
| `tokens` | chain, address | Decimals and symbol as read (V1's rules), status | — |
| `waiting_reports` | chain | The automation's last waiting file the indexer read: its pass (block, time), or why it could not be read | — |
| `waiting` | chain, kind, subject | Each vault's and mandate's reason in that file, since when it has held (time and block), the pass's time and block, the last presimulation revert | — |

The catalogue writer role writes, the reader role reads; nothing here is private.

### Enrichment

After a range, at the latest checkpoint's block, bounded per pass (25 receipts, 25 mandates, 10 vaults, 10 positions, 20 tokens): each new transaction's receipt (gas and sender); each new mandate's terms; each vault and position an event touched since its last read, or not read for 30 minutes (`--refresh`); each unknown token. Work is chosen from the store first: a pass with nothing due spends no call. A position read uses F6's `UniswapReader`, which proves the manager's and StateView's code. A position the manager no longer knows is `burned` only when the manager's own `Transfer` to zero proves it, read with one `getLogs` from the position's last indexed event (no Domino event can name a burned token); a range wider than an endpoint serves in one read leaves it `unavailable` (`v2_burn_unproven`) and the pass goes on.

## Why a vault or a mandate waits

The automation (3a, docs/v2/V2_AUTOMATION_BACKEND.md, "Why a vault or a mandate waits") keeps a `waiting` table in its journal, keyed by (chain id, kind, subject), with each subject's latest reason (a fixed code; a presimulation revert is `reverted_<error>`), the time and block of the pass that decided it, since when the reason has held (`since`, `since_block`: the first pass that gave it, kept while it holds, reset when it changes or clears; added to the journal by this slice), and the last decoded presimulation revert, and writes the same content after each pass as one public JSON file per chain (`waitingFile`, kind `domino-v2-automation-waiting`). That is the contract this slice uses:

- the chain's indexer reads the file once a pass (`--waiting-file`), whole or not at all: a file missing, too large or malformed in any part leaves the chain `unavailable`, never half read; it never reads the automation's journal;
- the rows go into the V2 index (`domino_v2.waiting`, `waiting_reports`), so the read API needs no access to the automation's files and answers from one database snapshot;
- `since` and `sinceBlock` come from the automation as recorded; the indexer computes nothing;
- read-v6 shows it as `waiting: {reason, since, sinceBlock, error, checkedAt, checkedBlock, lastRevert}`: `error` is the contract error's name when the reason is `reverted_<snake case>` of an error contracts/src/v2 declares (`V2_ERRORS`, pinned to the sources); a file whose pass is more than 600 s old is `stale`, its reasons shown with their age; an ended mandate's last row is not shown.

## The read API (read-v6)

| Route | Answer |
| --- | --- |
| `POST /v6/read/portfolio` `{wallet}` | Per chain status; vaults (≤ 50), positions (≤ 100), mandates (≤ 100), credits, tokens, `truncated` |
| `POST /v6/read/activity` `{wallet, limit?, cursor?}` | Receipts newest first, `limit` 1–50 (20); `nextCursor` = `timestamp.chain.block.logIndex` of the last item, exclusive |
| `POST /v6/read/chain-pools` `{chainId, token, pairedToken?}` | The token's standard hookless pools on a chain, read at its head (≤ 32) |
| `POST /v6/read/chain-balances` `{wallet, tokens?}` | A wallet's balances per chain, each chain's base currencies by default |
| `POST /v6/read/chain-tokens` `{chainId, query, limit?}` | Known tokens on Base or Arbitrum One that match (≤ 24) |

Served by the local reader (`read_api.py`, stored lane, header `X-Domino-Read-Contract: 1.0.0-rc.1`) when `DOMINO_V2_READ=1`, and through the gateway (`read_gateway.py`, `--enable-v6`, `DOMINO_BRIDGE_V6_READS=portfolio,activity`; it re-validates every answer and that it is about the wallet asked); `bridge_http.py`'s client knows the routes. Field by field, the package's [README](../../api-contracts/read-v6/README.md) is the reference; the generated schemas and `types.ts` are the contract.

### The chain reads (0xdecimal's items 1-3, 5 Oct 2026)

`chain-pools`, `chain-balances` and `chain-tokens` are not index reads (`backend/v2_chain_reads.py`):

- **Where they read:** at request time, one Multicall3 call per chain at the chain's head (`v2_head`). Robinhood goes through the reader's provider file (the own node); Base and Arbitrum go through the V2 chain RPC file's hosted endpoints (F6), billed per call.
- **Cache:** pools for 15 s, balances for 10 s, the index's known tokens for 60 s.
- **Lanes:** `chain-pools` and `chain-balances` take the reader's provider lane; `chain-tokens` reads no chain and takes the stored lane.
- **Search sources:** the profile's currencies; the Uniswap Labs Default token list, pinned in `backend/data/token-lists` with its version, SHA-256 and GPL-3.0 license (`scripts/update-uniswap-token-list.py` refreshes it; the owner's decision of 5 Oct 2026); tokens the index read in full; tokens a `chain-pools` read found priced pools for. The last are kept in the reader's runtime (`v2-learned-tokens.json`), at most 5,000 per chain.
- **Turning them on:** `install_read_activation.py --read-v6 --chain-reads` adds to the reader `DOMINO_V2_CHAIN_READS=1`, `DOMINO_V2_CHAIN_RPC_FILE` and `ImportCredential=v2-rpc-*` with the TPM, and adds the three routes to the gateway.
  - **The file:** the operator copies `/etc/domino/v2/chain-rpc.json` into `/etc/domino/read`, owned by `domino-read`, directory 0700 and file 0600. The unit binds that directory read-only at `/run/domino-read-config`, because the file's loader refuses one inside a release tree, where the reader's runtime directory is, and `/etc/domino` is root's alone.
  - **Order:** the activation refuses `--chain-reads` until the file is there. A missing directory leaves the reader up, with its chain reads unavailable.
  - The reader reaches the hosted endpoints once the egress is collected with `--v2-chains` (`read` is one of the `CHAIN_ROLES`).
  - **Publishing:** the tunnel path and the read Worker go through the reviewed workflow (*Publish read path*, `operation`
    `tunnels-v6`, `worker-v6`, rollback `disable-v6`, dispatched on a `main` commit), with the repository's stored
    Cloudflare token. `worker-v6` deploys the Worker with that commit's read-v6 package, so dispatch it from the commit
    whose contract the reader serves.
  - A fault in that configuration leaves the three routes answering `upstream_unavailable` and the read path up.

### What the app consumes (F7 spec)

| F7 | read-v6 |
| --- | --- |
| §6.2 positions per owner × chain | `portfolio.positions`: chain, dex, manager, token id, `vault {address, role}`, `state` (`live`: owner, `custody {approved, subscriber}`, pool, range, liquidity, spot, `inRange`, `feesOwed`, `principalAtSpot`; `snapshot`, `freshness`) |
| §6.2 vaults per owner | `portfolio.vaults`: chain, dex, root, members with ledgers and lots, policy, limits, `paused` + `pausedBy`, `rootArmed` + `custody {reason, source, since}`, reserves and idle per token, `exitModule`, `stateNonce`, `lastExecutionAt`, `quoteCurrency`, `lastExecution`, `totals`; chain `automationHalted`, `operatorsAdmitted` |
| §6.2 mandates per owner, §4.5 | `portfolio.mandates`: hash, vault, token id, `terms`, `validUntil`, `status`, `expired`, `moduleEnabled`, `blockedBy`, `executed`; `credits` (unclaimed per token); `waiting` (§4.9) |
| §6.2 activity, §2.11 receipts | `activity.items`: per transaction, decoded events with raw values: S1 (inputs, legs, steps, refunds, tariff), vault executions, auto-exits, owner and mandate events, and a closed vault's reserves returned to its owner by someone else's `returnReserves()` (`reserves_returned`, with `returnedBy` and `byOperator`; 0xdecimal's item 8, 5 Oct 2026); `tx.gas` (receipt fields, L1 fee on Base) and `tx.finality` per chain |
| §6.2 tokens and prices | `tokens`: metadata as read; `price: null` with its reason |
| §6.3 states | zero: a measured `"0"`; unavailable: `status: unavailable` + `reason` (chain, read, token); stale: `freshness.status` and chain `stale`; partial: `coverage: partial`, per-chain status, `truncated`; unqualified: `price: null` + `priceReason` |

### F7 §9 open points this answers

- **9 (Base and Arbitrum reads in the browser):** lists and history come from read-v6, all three chains in one answer with per-chain status; the app reads only pre-sign data through the wallet.
- **10 (V2 read API fields):** read-v6 `1.0.0-rc.1` as above; the fields §6.2 lists that are not here are in [What remains](#what-remains).
- **24 (auto-exit waiting reasons):** `waiting` on vaults and active mandates, with `chains[].waitingReasons` saying whether the automation reports. The app's copy table (§4.9) keys on `waiting.error` (the contract error's name) and, for the planner's own codes, on `waiting.reason`.

## Operating it

```sh
# once per chain (prints the proof: receipts canonical, runtimes' code hashes)
python backend/v2_indexer.py register --chain base-8453 --deployment docs/deployments/v2-base-8453-<date>/deployment.json \
  --chain-rpc-file <private V2 RPC file>
# then
python backend/v2_indexer.py follow --chain base-8453 --chain-rpc-file <file> --head-file <shared head file> \
  --waiting-file <the chain's automation waitingFile>
python backend/v2_indexer.py status --chain base-8453
```

Robinhood's routes come from the read path's provider file (`--provider-file`), the others from F6's chain RPC file. The catalogue database is the reader's (`database_settings`). `register` admits production manifests only, unless `--admission fork-rehearsal` or `--admission local-test`. The reader needs `DOMINO_V2_READ=1`; it reads waiting reasons from the index, not from files.

### In production (Robinhood first)

The indexer runs as the catalogue writer, `domino-write`, from the public-data release, which is the whole archive. The V2 modules read `api-contracts/v2` from it. Its provider file, `catalogue-db.json`, egress (the node's loopback proxy and the `rpc` class) and hosts file are the public-data lanes'. Nothing below starts on install.

1. **Migration 052.** Use the archive of the release that carries it:
   `apply_migrations.py --archive <tar> --archive-sha256 <hex> --commit <sha> --migrations 052_v2_index`, first with `--inspect`, then with `--apply`.
2. **The public-data release from that commit,** with `install_public_data.py`. It installs `domino-v2-indexer@.service` and never enables it. Restart the three lanes as for any public-data release.
3. **Preflight and registration.** Run both as `domino-write` from `/opt/domino/public-data/current/backend`, with the unit's sandbox (for example `systemd-run --pipe --wait -p User=domino-write -p SupplementaryGroups=domino-db -p WorkingDirectory=… -p BindReadOnlyPaths=/etc/domino/continuous-reads/write.hosts:/etc/hosts`):
   - `v2_rpc.py check --chain robinhood-4663 --endpoint local` (read-only);
   - `v2_indexer.py register --chain robinhood-4663 --deployment ../docs/deployments/v2-robinhood-4663-2026-10-04/deployment.json`. It prints `registered`, the start block 80,189,516 and 24 proven code hashes.
4. **Start the follower:** `systemctl enable --now domino-v2-indexer@robinhood-4663.service`. The enablement joins `domino-public-data.target`. Its journal has one JSON line per pass; wait for `caught_up_to_target`. The unit restarts on any exit, because `follow` returns 0 after five failed rounds in a row. Before rolling the public-data release back, disable the instance.
5. **read-v6 on the read path.** Use a read release that has #305 (`install_read_release.py`). Move the two 70 drop-ins aside, then run `install_read_activation.py --commit <sha> --read-v6`, first with `--inspect`, then with `--apply`. It adds `DOMINO_V2_READ=1` to the reader, and `--enable-v6` with `DOMINO_BRIDGE_V6_READS=portfolio,activity` to the gateway, keeping v1 to v5 as they were. Restart `domino-continuous-reads.target`.
6. **Check locally:** `POST http://127.0.0.1:8876/v6/read/portfolio {"wallet": "0x…"}` should show chain 4663 `current`. Base and Arbitrum stay `unavailable` until their deployments are registered.

### Base and Arbitrum

The writer reads their hosted providers from its private V2 chain RPC file (`backend/v2_rpc.py`). A provider's URL carries its key, so each URL is a sealed credential, never a file in clear.

1. **Credentials and file.**
   - **The URLs:** `/etc/credstore.encrypted/v2-rpc-<chain>-<name>` (`systemd-creds encrypt --with-key=host+tpm2 --name=v2-rpc-base-8453-chainstack …`). They were sealed on 3 Oct, for `chainstack` and `alchemy` on both chains.
   - **The file:** the operator's `/etc/domino/v2/chain-rpc.json`, which lists Chainstack, then Alchemy, then each chain's public endpoint. Copy it for the writer to `/opt/domino/queue-worker/release/backend/runtime/chain-rpc.json`, owned by `domino-write`, mode 0600. Its loader refuses a file outside a private directory, behind a symlink or inside a checkout.
   - **The unit:** `domino-v2-indexer@.service` imports every `v2-rpc-*` credential, because the loader checks every chain the file names. It also opens the TPM that decrypts them (`DeviceAllow=char-tpm rw`), which systemd 255 adds by itself only for `LoadCredentialEncrypted=`. It passes that file to every instance; Robinhood's instance never reads it.
2. **Egress.** Collect with `--v2-chains`. That pins Base's and Arbitrum's hosts (`chains` in CONTINUOUS_EGRESS.md) for the writer and, once enabled, for the plan listener. Render, update, then `nft -f`.
3. **Preflight and registration.** Run both with the unit's sandbox and credentials: `systemd-run --pipe --wait -p User=domino-write -p SupplementaryGroups=domino-db -p 'ImportCredential=v2-rpc-*' -p WorkingDirectory=/opt/domino/public-data/current/backend -p BindReadOnlyPaths=/etc/domino/continuous-reads/write.hosts:/etc/hosts …`.
   - `v2_rpc.py check --chain base-8453 --chain-rpc-file <the writer's file>` checks each endpoint's chain, its head, the profile's 25 code hashes and the archive probe. On 4 Oct, Chainstack and Alchemy passed on both chains. The public endpoints were refused locally at their 2 requests per second, by design: they stay a last resort.
   - `v2_indexer.py register --chain base-8453 --deployment ../docs/deployments/v2-base-8453-2026-10-04/deployment.json --chain-rpc-file <the writer's file>`, then the same for `arbitrum-42161`.
4. **Start:** `systemctl enable --now domino-v2-indexer@base-8453.service domino-v2-indexer@arbitrum-42161.service`. read-v6 then shows both chains as `current`.

`status` connects as the catalogue reader, which the writer's identity is not mapped to. Read `domino_v2.deployments` with psql as the operator instead, or run `status` from the reader's release.

## What 3a, #301 and F7 must align with

- **Automation (3a, PR #306, merged):** this slice uses its `v2_manifest` (the one loader of #301's manifest) and its `tests/v2_local_chain.py` (the one fixture deployer). The waiting file is read as #306 documents it, with `since` and `sinceBlock`, which this slice adds to the journal (`v2_executor.Journal.record_waiting`) and the file. The rules this slice's own loader had and `v2_manifest` lacked moved into it, with their tests and mutants: public test-mnemonic keys refused as production roles (PR #302's review, item 2), receipts after the genesis with non-zero hashes and one hash per block, the verification at or after every receipt and agreeing with one in its block, a check time with its zone, and the profile's CreateX. #306's docs propose decoding its log scans with `v2_events`, the strict catalog here.
- **Deployment (#301, PR #302):** its local mode now defaults to a fork that keeps the real chain id, with the real Uniswap and Permit2 at their addresses; the EVM tests run offline in CI, so they keep the automation's `tests/v2_local_chain.py`.
- **App (F7):** read-v6 through the bridge once its Worker route exists (`/api/read/v6/portfolio`, `/api/read/v6/activity`); per-chain status before any figure; no totals across chains; `waiting.error` for §4.9's copy and `waiting.reason` for the automation's own codes; `waiting.since` for how long.

## What remains

| Item | Why it is not here |
| --- | --- |
| The shared head file (`--head-file`) | Optional: each follower reads its own head. |
| Pools' market metrics (TVL, volume, APR) on `chain-pools` | They need qualified USD (next row); each pool says `no_qualified_price_source` until then. |
| Qualified USD (pool against the chain's stable; Chainlink ETH/USD from the profile, with heartbeat and sequencer uptime) | Its own qualification; prices are `null` with a reason until then. |
| The anchor's reference price per vault with its age (§5.2 distance) | Needs the publisher's observations or a TWAP read per vault. |
| `approvedForAll` in a position's custody | Not read yet (`isApprovedForAll(owner, vault)` for a vault's root); the vault's live `rootArmed` covers its custody. |
| Pool cost per leg (tiers, approximate cost on one-hop legs, §2.11) | Derivable from the legs and pool fees; not derived yet. |
| Multicall3 for the snapshot reads | They are JSON-RPC batches of `eth_call` now. |
| The implementation events from 3c's ABI export | The catalog pins `SwapLegExecuted` to the source; `test_v2_indexer_evm.py` holds the catalog to every event the compiled contracts declare until the export covers them. |
| The deployment tool's local mode in the EVM tests | Its offline mode's dependencies are synthetic and cannot run a pool; the tests use the automation's fixture deployer until it can. |

## Verification in this slice

| Test | Deployment it uses | What it holds |
| --- | --- | --- |
| `test_v2_events.py` | none | The catalog, strict decoding, keys. |
| `test_v2_activity.py` | none | Receipts cut per transaction and wallet. |
| `test_v2_indexer.py` (PostgreSQL) | synthetic manifests in #302's format (`tests/v2_index_fixtures.py`), admitted by `v2_manifest`; a scripted chain | Registration proofs, ranges, continuity, rewinds (deeper and shorter chains, the base), enrichment, the waiting file kept with `since` and served, the read service. |
| `test_read_v6_contract.py`, `test_v2_waiting.py` | none | The package is what the producer exports; Python and JS validators agree on every fixture; the routes, gateway and bridge client; the waiting file read whole or not at all, `since` and `sinceBlock` kept as the automation recorded them. |
| `test_v2_indexer_evm.py` (Anvil and PostgreSQL) | the automation's `tests/v2_local_chain.py` (`LocalChain`, `deploy_v2`): real V2 contracts at their CREATE3 addresses, Base's real Uniswap runtimes, a manifest in #302's format admitted as `local-test` | An owner's journey on the real contracts (S1 create, vault, pause and resume, auto-exit enabled, a compound with a publisher-signed observation, two mandates, one revoked, the other executed while paused), indexed in several ranges, enriched and answered; the registry's timelocked change, cancellation, removal, epoch and halt as the chain status shows them; the automation's waiting file read into the index and served; a position burned by the zap's exit, proven and no longer listed, and a burn too far back for one read, left unavailable without stopping the pass; the catalog against every event the compiled contracts declare; two reorganizations under the indexer (a replaced branch, a shorter one). |

CI: the Backend job builds the ten V2 contracts the EVM tests deploy (one step for the automation's and this slice's), runs `export-read-v6-contract.py --check` and the whole backend suite; the Frontend job type-checks `types.ts` and `runtime.d.mts`. The loader's own tests are #306's (`test_v2_manifest.py`).
