# Local RPC integration — 19 September 2026

Implemented against `main` at `675c69b` in an isolated worktree. See
[source routing and activation](../docs/LOCAL_RPC_SOURCE.md) for the per-consumer
mapping, private configuration migration and rollback procedure.

The local node is selectable as the current data source without replacing
Alchemy inventory/price credentials or sending historical state reconstruction
to the pruned node. Version 3 provider configuration preserves the existing
primary as recovery/history unless the operator explicitly supplies another
qualified historical source. Legacy configuration remains supported.

Browser responses, API versions, financial calculations and wallet signing
transports are unchanged. Generated contract manifests were refreshed only for
producer source hashes; schemas, types, fixtures and OpenAPI did not change.

## Verification

| Check | Result |
| --- | --- |
| Full backend suite, Python 3.14 with `requirements-api.lock` | 2,034 tests; no failures; 485 optional PostgreSQL/EVM cases skipped |
| Affected routing, catalogue, activity, capital, Chainlink and follower tests with isolated PostgreSQL 18 | 208 tests passed, no skips |
| Staging helper suite | 379 tests; no failures; 25 platform/optional cases skipped |
| Read bridge and shared consumer contract checks | 750 bridge tests plus 582 consumer tests passed |
| RPC file secrecy and browser wallet source guards | 14 tests passed |
| Additional inventory-rotation regression | Included in the final 15-test routing suite and PostgreSQL pass |
| Read-v1/v2, performance-v1/v2 exports and OpenAPI reproducibility | Passed |

The first attempt at the broad backend suite used an older environment missing
`eth-account` and other locked dependencies, and detected stale generated source
hashes. A task-local environment was installed from the current lock, manifests
regenerated, and the full suite above then passed. No production dependency or
database was changed. Contract/EVM suites and the full frontend build were not
rerun: Solidity, schemas and frontend application code were unchanged.

An independent review found and fixed two integration cases before delivery:
a missing-state error in a batch could mask another item's wrong chain/header,
and stored pool-position ownership initially ignored the explicit history route.
Regression tests cover both, including history outside the current fallback list.

## Real read-only probe

The modified Domino `DiscoveryReader`/`FailoverReadRpc` queried the authenticated
local HTTPS endpoint with certificate verification enabled. The token was read
through a private process pipe from the clawber configuration; it was not copied
to arguments, reports or Git.

- Chain: **4663**; common block: **67,387,733**.
- Pool: WETH/USDG, id
  `0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6`.
- Chain/deployment links, block hash and pool state passed the Domino reader.
- `getSlot0` price, tick, protocol fee and LP fee matched the official RPC at
  that exact block; canonical block hash was checked again.
- **11 logical local requests, 4 official reference requests**, no transaction,
  no load test and no ongoing watcher.

This is integration evidence, not a claim of archive coverage, maximum capacity
or production failover activation. Fault recovery is covered by deterministic
offline tests; the live node/tunnel was not interrupted.

## Runtime status

Activated on the Domino VM on **19 September 2026, approximately 21:22 UTC**,
at the owner's explicit request. Production read/gateway and development
read/gateway now run **`b2dcc8cf1da3bb4126e3dbc0285189889551841a`**.

- Production providers use version 3: the local RPC is primary; the former
  Alchemy primary remains both fallback and explicit historical source.
  Inventory credentials are unchanged. Development retains its separate
  version 1 profile, with local RPC first and its former Alchemy RPC second.
- Exact IPv4 pins for `rpc.domino.money` were added to the two reader policies,
  hosts files and systemd IP allowlists. Existing destinations and all other
  roles' rules were preserved. Both nft candidates passed syntax validation.
- The source archive was SHA-256 checked; dependency locks matched the existing
  environments. Runtime directories, database state and snapshot files were
  preserved; no migrations or dependency installation ran.
- Read targets were restarted after applying configuration and policy. Private
  backups, candidates and a rollback script remain in root-only operator storage.
  Deployment-check issues caused rollback before final activation: the checker
  now accounts for development's initial cooldown and validates its private
  profile inside the service mount namespace. File permissions were not relaxed.
- Both reader/gateway/tunnel groups are active, with four HA tunnel connections
  each. Indexer timers remain active on their existing historical source. All
  seven previously inactive financial/signing roles remain inactive, and
  systemd reports no failed units.

### Live validation after activation

| Probe | HTTP | Time | Snapshot block | Result |
| --- | --- | --- | --- | --- |
| Production WETH token | 200 | 0.681 s | 67,401,499 | Available |
| Production wallet assets, inventory enabled | 200 | 1.351 s | 67,401,533 | Alchemy inventory page received; two requested assets |
| Production WETH/USDG pool market | 200 | 0.556 s | 67,401,558 | Market available |
| Production NFT at explicit historical block | 200 | 5.989 s | 67,387,733 | One item; requested block preserved |
| Development WETH token | 200 | 0.879 s | 67,401,720 | Available |

All five bodies passed the deployed `read_contract.validate_response` contract
(`1.1.0-rc.3`). Temporary, connect-only tracing of the actual production and
development reader processes observed connections to the local RPC's pinned
addresses during their token probes, with no Alchemy connection in either trace.
Tracing ended immediately after each probe. Browser-origin calls directly to
both readers were still refused with HTTP 403 (`local_client_required`).

### Authenticated public validation

The owner subsequently supplied beta access, completing the previously pending
public-path check on 19 September. Login succeeded in the browser and through
the bounded probe (HTTP 303, Secure/HttpOnly beta cookie). The default Python
user agent initially received Cloudflare error 1010 before authentication; the
identified deployment-probe user agent was accepted without a WAF change.
The password and probe cookie were held in memory, never in a report, credential
file or command-line argument.

| Authenticated route on `https://domino.money` | HTTP | Time | Snapshot block | Result |
| --- | --- | --- | --- | --- |
| `/api/read/v1/token` | 200 | 0.456 s | 67,405,779 | WETH available |
| `/api/read/v1/wallet-assets` | 200 | 1.624 s | 67,405,817 | Zero-address read; Alchemy inventory page received |
| `/api/read/v2/pool-market` | 200 | 0.782 s | 67,405,843 | WETH/USDG market and APR estimate available |

Each call traversed the public beta gate and authenticated read bridge. All
three bodies passed the local v1/v2 validators, including recomputation of v2
APR evidence. Chain 4663, the respective contract response headers
(`1.1.0-rc.3` / `2.0.0-rc.1`) and `no-store` were verified. No wallet signature
or transaction was requested. The browser also displayed current pool prices,
provider TVL/volume and estimated APR; its temporary tab was closed afterward.

A separate limitation was visible in PONS/USDG's on-chain activity panel:
indexed block 50,906,349 was reported as 19 days behind, so the panel withheld
24-hour activity figures. Current pool state and market/APR reads succeeded;
these checks do not qualify the completeness or freshness of historical indexes.

The already published Worker revision `0f01f8f` has identical read Worker source
and read-v1/v2 wire contracts to this release; no Worker deployment was needed.

Development's existing qualification and egress deadline was preserved:
**19 September 2026, 22:47:32 UTC / 19:47:32 America/Sao_Paulo**. Production's
continuous policy does not share that expiry. No load test, node interruption,
financial activation or persistent watcher was added during deployment.
