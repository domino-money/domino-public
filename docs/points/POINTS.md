# Domino points — season 1

Domino's Season 1 campaign awards points for the revenue a wallet generates and for the use of wallets it
referred. This document describes the season's rules, revenue ledger, points engine and authenticated routes.
Deployment host identities and live operation logs are omitted from this public derivative.

## Season 1 rules (the owner, 6–7 Nov 2026)

| Rule | As decided |
| --- | --- |
| Points for use | 1,000 points per US$1 of net revenue Domino receives from the wallet, on any chain: the 0.65% assisted swap, the 2% or 4% automation fee, the 0.2% Auto-exit fee and the 0.35% bridge app fee. Net: less the gas Domino's operator paid for that fee's transaction |
| Value | Each fee in USD where it was charged, as read-v6 values a token: the chain's stable at US$1, ETH/WETH by Chainlink, any other token by its deepest pool with at least US$10,000 of depth within 10%; a token without one counts nothing |
| Season 1 | From 00:00 UTC 9 Nov 2026 to 00:00 UTC 9 Feb 2027 (the campaign's three months). Nothing before the start counts. Only season 1 is planned |
| Referral | The referrer earns 10% more: 10% of the referred wallet's points for use. The referred wallet keeps all of its own |
| Referral: one level | 10% of the referred wallet's points for use, never of its referral points |
| Referral: existing wallets | A wallet that already used Domino may be referred. Its points for use in the season count for the referrer, whenever the link is made in the season |
| Referral: link | Fixed for the season: the referred wallet signs once, and its first link holds |
| Referral: everyone | 10% for any referrer, with no special terms |
| Conversion cap | None for now: a later decision |
| Minimum claim | None |

Rules the engine applies with these (the study of 6 Nov and the blueprint of 7 Nov, accepted with "VAI"):

- **Exclusions.** The team's wallets (the owner's list), the deployments' roles (deployer, operator, publisher, guardian, fee recipient), the governance Safe's owners and the 100 public test accounts (`api-contracts/v2/public-test-accounts.json`) earn nothing, refer no one and are referred by no one.
- **Auto-exit floor.** An Auto-exit fee counts from US$0.10 (a position of US$50); below, its gas costs Domino more than the fee.
- **Referral hygiene.** No wallet refers itself. A referral does not count when the referrer sent ETH, USDG, USDC or WETH straight to the referred wallet in the 30 days before the link or during the season; it is checked at the season's close and can be contested.
- **Published rules.** The season's configuration is versioned and its hash published on the first day; a change applies only from then on.

## The parts

| Part | What | Status |
| --- | --- | --- |
| 1. Revenue ledger | Every FeeCharged valued in USD, less Domino's gas, per wallet (`backend/points_ledger.py`, migration 058, `domino-points-ledger@`) | Live since 7 Nov 2026 |
| 2. Points engine | The season's configuration (`backend/points_season_1.json`); the window, exclusions and the Auto-exit floor; referral links signed by the referred wallet and referral points; snapshots with their hash (`backend/points_engine.py`, `backend/points_referral.py`, migration 059) | Installed 7 Nov 2026; the snapshots start after the team's list |
| 3. Routes | `points-v1` behind the wallet's sign-in: the wallet's points, and the link it signs (`backend/points_api.py`, `bridge/src/points-worker.mjs`, `api-contracts/points-v1`, `scripts/staging/install_points_api.py`) | Installed 7 Nov 2026, stopped; on after Cloudflare and the app |
| 3b. Bridge fees | The bridge's app fee in `bridge_fees` (Relay `appFees.actual`, Across fills) | Next |
| 4. App (0xdecimal) | `#/points`, the `?ref=` link, the signature, the rules and terms | Its contract is `api-contracts/points-v1` |

Nothing is lost while parts 2 and 3 are built: every fee is a chain event the V2 index keeps, Relay lists Domino's requests with the app fee each paid (`crosschain_fees.py relay-requests`), and Across' fills are chain events. Points are computed from the season's start whenever the engine runs.

## Part 1: the revenue ledger

### What it records

One row per FeeCharged the V2 index holds (`domino_points.revenue`, keyed as the index keys the log), on every chain the index follows:

- the fee as charged: kind (1 assisted swap, 2 automation, 3 Auto-exit), payer, token, amount, ref, block and transaction;
- its value:
  - USD per whole token and read-v6's source, or no value and read-v6's reason (`no_pool`, `pool_depth_below_floor`, `decimals_unknown`, ...);
  - the checkpoint it was valued at, and whether that was late (below);
- the gas:
  - when one of Domino's operators sent the transaction, its cost in wei (OP Stack's L1 fee included);
  - this fee's share of it in USD, and why the gas could not be valued, when it could not;
- `gross_usd` and `net_usd` (never below zero).

It applies no rule of a season: the window, exclusions, the floor and referrals are part 2's. It is also Domino's revenue per wallet: `points_ledger.py totals --since <unix> --until <unix>` sums it per chain and kind.

### A pass

`points_ledger.py step`, looped by `follow`:

1. **The cursor.** It is the index's checkpoint the ledger last read to (`domino_points.ledger_cursor`), or the deployment's base before the first pass. If the index no longer has it, the index rewound: the ledger deletes every row above the newest checkpoint still standing and reads on from there. This needs no call.
2. **The range.** The ledger reads to the newest checkpoint within `--span` blocks. It stops short:
   - at the checkpoint before a fee whose transaction the index has not stored yet (the index stores receipts after the logs), so its sender is known;
   - at the checkpoint holding the 2,000th fee;
   - at the 16th checkpoint holding fees.
3. **The value.** Each fee is valued at its own checkpoint, the first at or after its block. Per checkpoint holding fees, one read-v6 survey reads:
   - the fees' tokens' pools;
   - the Chainlink feed, or the native pool on a chain without one, where an operator paid gas;
   - the tokens' decimals the index has not stored.

   It reads through the chain's endpoints, anchored at that block, with read-v6's own reads and rules (`v2_chain_reads.survey`).
4. **Late fees.** A fee whose checkpoint is more than 15 minutes old when the ledger reaches it (a backlog, an outage, the first run) is valued at the index's newest checkpoint, and its row says so (`price_late`). The ledger never reads a historical block. On 7 Nov 2026 the first run read October's blocks through Robinhood's fallbacks, and the archive provider's rate limit, which the V2 automation shares, answered the automation a 429. Points start on 9 Nov, so an older fee's exact price buys nothing.
5. **Failed reads.** A read that fails at a fresh checkpoint, or a pool read-v6 could not read (`price_read_failed`, `pricing_limit_reached`), is never recorded. The pass stops with the error in the cursor, and the next pass tries again.
6. **The gas.** It counts when the sender is an operator: the deployment's (`manifest.roles.operator`) or any the registry allowed (`OperatorSet`). It is valued in the native currency at the same checkpoint and shared among the transaction's fees by value, equally when none has a value. A transaction the payer sent costs Domino nothing.
7. **The commit.** The rows and the cursor move in one transaction. It holds the checkpoint against the index's deletion, and it is refused if the cursor moved or the index rewound meanwhile.

**Cost.** A caught-up pass reads the index's database and, only when its range holds fees, one survey (three Multicall3 calls) per checkpoint holding them. Fees are a few a day per chain today.

### What runs

One instance per chain: `domino-points-ledger@robinhood-4663`, `@base-8453` and `@arbitrum-42161` (Elysium's when its index runs). It runs as `domino-write`, with the V2 indexer's sandbox, hosts file, sealed `v2-rpc-*` credentials and TPM access (`ops/systemd/domino-points-ledger@.service`). Robinhood reads the writer's provider file, which leads with the node's loopback proxy, as the indexer does; Base and Arbitrum read the V2 chain RPC file in its order, never a public RPC. The public-data release installs the unit and never enables it.

### Enabling it

1. **Migration 058,** from the archive of the release that carries it, as postgres, as 052 and 054 were: `apply_migrations.py --archive <tar> --archive-sha256 <hex> --commit <sha> --migrations 058_points_ledger`, `--inspect`, then `--apply`.
2. **The public-data release** from that commit (`install_public_data.py`). It installs `domino-points-ledger@.service`, disabled. Restart the lanes as for any public-data release.
3. **A first step by hand,** as `domino-write` with the unit's sandbox and credentials:

   ```sh
   systemd-run --pipe --wait -p User=domino-write -p SupplementaryGroups=domino-db -p 'ImportCredential=v2-rpc-*' \
     -p PrivateDevices=yes -p 'DeviceAllow=char-tpm rw' \
     -p BindReadOnlyPaths=/etc/domino/continuous-reads/write.hosts:/etc/hosts \
     -p WorkingDirectory=/opt/domino/public-data/current/backend \
     /opt/domino/queue-worker/venv/bin/python -B points_ledger.py step --chain robinhood-4663 \
     --chain-rpc-file /opt/domino/queue-worker/release/backend/runtime/chain-rpc.json
   ```

   It prints the range it recorded. `points_ledger.py status --chain robinhood-4663` shows the cursor, the index's checkpoint, the rows, the unpriced and the late.
4. **Start each chain:** `systemctl enable --now domino-points-ledger@<chain>.service`, with that chain's `domino-v2-indexer@` following. Its journal has one JSON line per pass. The backlog since the deployment takes minutes, and its fees are valued at the newest checkpoint.

**Rollback:** `systemctl disable --now domino-points-ledger@<chain>` stops it; nothing else reads its tables yet. Dropping them is `DROP SCHEMA domino_points CASCADE` as postgres.

### Verification

| Test | What it holds |
| --- | --- |
| `test_points_ledger.py` (PostgreSQL) | Over the index's own rows written as the indexer writes them, with read-v6's answers from a fake:<br>- each kind valued at its checkpoint, one survey per checkpoint holding fees, the native currency asked only where an operator paid gas;<br>- gas shared by value (equally when nothing has a value), the L1 fee counted, net never below zero, no net without a native price;<br>- an unpriced token recorded with its reason;<br>- a failed fresh read, or a pool not read, never recorded, with the error in the cursor and cleared by the next pass;<br>- a late fee valued at the newest checkpoint, marked, with no read at its own block;<br>- a fee waiting for its transaction;<br>- the registry's operators counted, a disallowed address not, a deployment without an operator refused;<br>- reorganizations before and during a pass;<br>- the limits of one pass;<br>- status and totals.<br>The production pricer over read-v6's survey: no pool asked for a base currency, decimals asked only when unknown, a price without decimals refused, at most 12 tokens a survey. Each guard is pinned by a mutant that fails the suite (30 of 30) |
| `test_install_public_data.py`, `test_financial_release_systemd.py` | The unit is installed per chain, never enabled, with the indexer's user, sandbox and credentials; a release without `points_ledger.py` is refused |
| `test_staging_helpers.py`, `test_upgrade_financial.py` | Migration 058 is packaged and applied by `apply_migrations.py` as postgres, never by the upgrade tools |

## Part 2: the engine

### What it computes

`points_engine.py snapshot` reads, in one repeatable-read transaction:

- the ledger's rows (058) and the bridge's app fees (059) whose time falls in the season;
- the season's referral links;
- the ledger's cursors;
- the excluded wallets:
  - every role the season names in every deployment's manifest (deployer, fee recipient, governance, guardian, operator, publisher);
  - the governance Safe's owners;
  - the public test accounts;
  - the team's list, imported by `points_engine.py team --team-file <path>` into `domino_points.team`. Only the catalogue writer can read that table; the reader, which the public read path uses, cannot.

From them it computes, as a pure function (`compute`):

- **Points for use.** 1,000 × the wallet's net revenue in USD: each fee's `net_usd`, and the bridge fee's USD. An Auto-exit counts only from US$0.10 of fee, read on the fee's gross value. An excluded wallet counts nothing; its revenue is reported as `excludedUsd`.
- **Referral points.** 10% of each linked wallet's points for use in the season, whatever the link's date: the owner's rule for existing wallets, and new ones alike. They are never taken from the linked wallet's own referral points, which keeps it to one level. A link with an excluded wallet on either side, a wallet linked to itself, or another season's link counts for no one.
- **Only signed links.** A link counts when its stored text is the one rebuilt from its fields and its signature
  recovers the referred wallet (`points_referral.verified`), whoever wrote the row. The listener checks the same
  before it records; a row written past it counts for no one, and the totals report it as `linksUnverified`.
- Points in six decimals, rounded down. The parts add up: `points = usagePoints + referralPoints`.

It stores the result in `domino_points.snapshots`:

- the body's canonical JSON (sorted keys, no spaces): the season, the configuration's and the team list's sha256, the time, the ledger's cursors, the totals and every wallet's entry;
- the sha256 of that JSON.

The same rows give the same body, so anyone with the rows can recompute the hash. The team list's addresses never enter the body; only the sha256 of the sorted list does.

`domino-points-snapshot.timer` takes a snapshot at five minutes past every hour (UTC). It reads and writes the catalogue only, through a Unix socket, with no network.

### Referral links

The referred wallet signs this text with `personal_sign` (EIP-191). `points_engine.py message` prints it:

```text
Domino Points, Season 1
Referred wallet: 0x<the referred wallet, lower case>
Referrer: 0x<the referrer, lower case>
This link lasts until the end of Season 1 and cannot change.
Issued at: 2026-11-09T12:00:00Z
```

`points_referral.record` rebuilds the text from the fields and recovers its signer, which must be the referred wallet. It keeps the text and the signature, so anyone can check the link later.

Refused:

- a wallet linking itself;
- an excluded wallet on either side;
- a link at or after the season's end;
- a text issued more than 10 minutes from the server's clock;
- a signature by another wallet.

The first link of a wallet holds: a later one is not recorded, and the answer names the first referrer. A wallet may sign v as 0/1 or 27/28. Only an EOA can sign, delegated by EIP-7702 or not, as the session admits. Part 3's route `link` records it for the signed-in wallet; `points_engine.py link` records a
signed link by hand.

### Enabling it

1. **Migration 059,** after 058, the same way: `apply_migrations.py ... --migrations 059_points_engine`.
2. **The public-data release** that carries the engine and the snapshot units. It installs them disabled.
3. **The team's list.** The owner provides the addresses as `{"schemaVersion": 1, "kind": "domino-points-team", "addresses": [...]}`. As `domino-write`, run `points_engine.py team --team-file <path>`; the file can be deleted afterwards. Run it again whenever the list changes: it replaces the whole list.
4. **A snapshot by hand:** `points_engine.py snapshot`. Then `points_engine.py status` shows the latest snapshot, and `points_engine.py wallet --address 0x...` shows one wallet's entry.
5. **The timer:** `systemctl enable --now domino-points-snapshot.timer`.

### Verification

| Test | What it holds |
| --- | --- |
| `test_points_engine.py` (pure, and PostgreSQL) | - Season 1's configuration as committed, its hash, and every broken variant refused; the team list<br>- Points for use per kind and chain with the bridge's fee; the Auto-exit floor on the gross value; excluded revenue reported<br>- Referral points on one level for the whole season, whatever the order of the links; links that count for no one; a row outside the season refused<br>- The signed text, its signer, v as 0/1, malformed signatures<br>- The first link holding, and every refusal<br>- The excluded wallets from the deployments, the season and the team; a deployment without roles refused<br>- A snapshot read at one moment (repeatable read), stored with the hash of its body, and the same rows giving the same body<br>- A stored link checked against its own fields and signer; a snapshot counting only signed links and reporting the others<br><br>Each guard is pinned by a mutant that fails the suite (42 of 42, and 7 of 7 for the link check) |

## Part 3: the routes

### The contract

`api-contracts/points-v1` (its README) is the contract between the listener, the Worker and the app. Seeing points
needs the wallet's sign-in: both routes answer for the SIWE session's wallet, and no request names a wallet.

| Route | Request | Answer |
| --- | --- | --- |
| `points` | `{}` | The season, the latest snapshot (`null` before the first) and the wallet's entry in it; zero for a wallet it does not hold |
| `link` | `{referrer, issuedAt, signature}` | `recorded`, or `existing` with the first referrer: the first link holds |

The app builds the text the wallet signs with the package's `referralText(season, referee, referrer, issuedAt)`,
byte for byte the text `points_referral.message` checks (`fixtures/signed-text.json` pins one). Every refusal of
`points_referral.record` has its own code (`referral_self`, `referral_wallet_excluded`, `referral_season_closed`,
`referral_message_not_fresh`, `referral_signature_invalid`, `referral_signature_mismatch`); any other malformed
link is `invalid_request`.

### The path

The same as the other signed-in families (onboarding, deposit, the plan, crosschain):

1. The browser POSTs `/api/points/v1/<route>` to the app. A Pages Function passes it to the Worker
   `domino-points-bridge` (`bridge/wrangler.points.toml`) through a binding.
2. The Worker (`bridge/src/points-worker.mjs`) turns the session cookie and the CSRF header into headers, adds the
   Access service token, and forwards to `https://points-gateway.example.invalid/internal/points/v1/<route>`. It checks every
   answer against the package before the browser sees it. It is off until `POINTS_BRIDGE_ENABLED` is exactly
   `"true"`; `GET /api/points/v1/capabilities` says whether it is on.
3. The tunnel's route for that hostname, behind its Access application, reaches the listener on 127.0.0.1:8912.
4. The listener (`backend/points_api.py`) checks the Access assertion, the session and its CSRF token, and the
   session's account (an EOA, delegated by EIP-7702 or not) on Robinhood.

### What the listener can touch

It logs in as `domino_session_auth`, the session role every signed-in listener uses, and can read no table of the
points schema. Migration 059 gives that role three functions, owned by the NOLOGIN role `domino_points_owner`:

| Function | What it gives |
| --- | --- |
| `wallet_entry(season, wallet)` | One wallet's entry in the season's latest snapshot, with the snapshot's time and hash |
| `is_excluded(wallet, roles)` | Whether a wallet is on the team's list or holds one of the roles in a deployment |
| `record_link(...)` | Inserts a link; the first holds, and the answer names its referrer |

The governance Safe's owners and the public test accounts come from the season's configuration, as the engine reads
them. `referral_wallet_excluded` answers for a referrer on the team's list as for any excluded wallet, so a signed-in
wallet that signs one link text per address can learn, one address at a time, whether that address is excluded.
The owner accepted this on 7 Nov 2026: a clear refusal serves the referred wallet better than a link that silently
counts for no one.

### Enabling it

On the VM, after migration 059:

1. **Install:** `install_points_api.py --archive <tar> --archive-sha256 <sha> --commit <commit> --inspect`, then
   `--apply`. It creates the identity `domino-points`, its peer row (proven by a connection), its directories and the
   release, and writes `domino-points.service`. It starts nothing.
2. **Private files** in `/etc/domino/financial/points` (0700, owned by `domino-points`):
   - `rpc.json`: a copy of the plan listener's (the Robinhood read path of the session check);
   - `environment`: `DOMINO_SESSION_ORIGIN`, `DOMINO_SESSION_ABUSE_SECRET` (the same as the other signed-in
     listeners'), `DOMINO_POINTS_ACCESS_ISSUER`, `DOMINO_POINTS_ACCESS_AUDIENCE` and `DOMINO_POINTS_ACCESS_SERVICE_ID`
     (the new Access application's). Copied as root from file to file; never printed.
3. **Cloudflare** (whoever holds the account): the Access application and its service token; the tunnel's hostname
   `points-gateway.example.invalid` to 127.0.0.1:8912 with the route `^/internal/points/v1/(points|link)$`; the Worker
   deployed with the token as `POINTS_ACCESS_CLIENT_ID` and `POINTS_ACCESS_CLIENT_SECRET`, still off.
4. **Egress:** collect and render the continuous egress policy with `points` among the enabled roles
   (`docs/CONTINUOUS_EGRESS.md`). Its drop-in adds `--enable`; the role reaches the Robinhood RPC and the Access
   issuer only.
5. `systemctl daemon-reload`, start `domino-points.service`, and check it with a signed-in wallet through the Worker.
6. **On:** `POINTS_BRIDGE_ENABLED = "true"`, and the app's route (part 4).

Rollback: `install_points_api.py --rollback <commit>` puts back the unit before, or its absence. Switching the
Worker off stops every request before the VM.

### Verification

| Test | What it holds |
| --- | --- |
| `test_points_api.py` (PostgreSQL) | - Requests closed; an answer whose parts do not add up refused<br>- Before any snapshot: zero and `null`<br>- A link recorded and the first one holding; then the wallet's and its referrer's points from the latest snapshot<br>- Every refusal with its code (the referred wallet itself excluded, the season closed), and nothing recorded<br>- The session role reading no table of the points schema<br>- A database failure as `points_unavailable`; the boundary (Access, session, CSRF, contract header); a disabled listener serving nothing |
| `export-points-contract.py --check`, `consumer.test.mjs` | The package as the models generate it; the fixtures through the runtime; `referralText` byte for byte |
| `points-worker.test.mjs` | - The committed configuration off and logging nothing; the capabilities answer, off and on<br>- The session, CSRF and Access headers forwarded<br>- An answer whose parts do not add up, or a recorded link naming another referrer, refused<br>- A request outside the contract refused before any upstream call |
| `test_install_points_api.py` | The unit (no credential, no `--enable`), the peer row, the release tree, the plan's refusals, the rollback |
| `test_continuous_egress_policy.py`, `test_financial_release_systemd.py` | The `points` role: optional until installed; enabled, the RPC and the issuer only, and the tunnel's way to its port; the drop-in's `--enable` as systemd reads it |

## Public deployment notes

The source documents installation, activation and rollback procedures; it does not certify the current state of
a production service. The committed points Worker is disabled and uses an example gateway. Configure the gateway
and Access credentials privately before enabling it. Production host identities, live release logs and local
rollback identifiers remain outside this public repository.
