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

This delivery changes repository code and deployment tooling. It does **not**
replace provider secrets/pins or restart the running VM services. Each applicable
role must receive the new release and private version 3 configuration, together
with the exact-host egress pins described in the runbook. Historical jobs retain
their historical source; current data reaches the browser through the existing
authenticated bridge. No financial capability was activated.
