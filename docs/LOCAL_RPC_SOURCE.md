# Domino's own RPC as a data source

The Robinhood node on `clawber` supplies current chain reads through the private
HTTPS route on `rpc.domino.money`. It is a **pruned node**, not an archive. The
application keeps a separate historical source and Alchemy inventory credentials.

## Routing

| Consumer | Source with a version 3 provider file |
| --- | --- |
| Token, wallet balance, pool state, current NFT and market snapshot reads | `rpcUrl`, then bounded `rpcFallbackUrls` |
| Session/onboarding plain-EOA checks | Same current list, chain and block verified |
| Direct deposit preparation/receipt reads | Current primary; existing single-provider, fail-closed transport |
| Live activity window and log-only anchor lookup | Current primary; existing bounded log reader |
| NFT reads requesting a block; owner resolution for stored pool positions | `historicalRpcUrl` |
| Catalogue/activity reconstruction, fees, positions, capital and Chainlink replay | `historicalRpcUrl`; one coherent historical provider per invocation |
| Managed performance collector and qualification forks | `historicalRpcUrl`; existing single-provider accounting/budgets |
| Alchemy inventory and external price references | `inventoryUrl`, never credentials extracted from `rpcUrl` |
| Browser product data | Existing same-origin read bridge and backend; inherits their source |

Public-provider benchmark modes remain explicit comparisons with the official
RPC. GeckoTerminal, CoinGecko and Uniswap APIs keep their distinct capabilities
and attribution. Historical source admission is not proof of archive coverage:
qualify the actual blocks needed by each job.

The browser gets no RPC token or general JSON-RPC proxy. The connected wallet
still supplies its own transaction simulations, signing and recovery transport.
Execution/signing profiles are separate and are not rewritten by data-source
configuration. No current backend consumer uses `eth_subscribe`, so this change
adds neither a WebSocket connection nor `ws.domino.money` to backend egress.

## Private configuration

From an interactive terminal in the intended release, as the identity that owns
its private provider file:

```sh
backend/.venv/bin/python backend/configure_rpc.py --local --config-file /absolute/private/providers.json
```

The terminal hides the **RPC authentication token** and historical HTTPS URL.
The token is not the Cloudflare connector token. Blank historical input preserves
the existing historical URL, or the previous primary on the first migration.
The configurator verifies the chain, deployed manager links and a common block
before an atomic, owner-only `0600` save. It does not prove old-state coverage or
restart services. Preserve a private rollback copy before replacing production
configuration; never copy a credential-bearing file into Git or an issue.

Version 3 contains the version 2 fields (`rpcUrl`, `rpcFallbackUrls`,
`rpcAllowedHosts`, `inventoryUrl`) plus required `historicalRpcUrl`. The known
pruned `rpc.domino.money` host is refused as the historical source. Legacy
version 1/2 files retain their shape and behavior. The generic RPC configurator
preserves version 3's historical source; inventory-key rotation preserves both
RPC routes. Rotate any separately stored archive credential explicitly.

`rpcUrl` becomes `https://rpc.domino.money/` followed by the private token and a
trailing slash. The exact host, HTTPS, bounded token and slash are validated;
userinfo, queries, redirects and alternate ports remain forbidden. The old
primary/fallbacks are preserved, subject to the existing three-endpoint limit.
Rotating the local token removes the old local route from the recovery list.
`DOMINO_DISCOVERY_RPC_URL` remains a validated single-source override for current
reads; it cannot replace a version 3 historical source.

The operator financial release verifier also accepts `--rpc-file` containing one
HTTPS URL in a private regular file, avoiding credentials in process arguments.
Its existing read-only method list remains unchanged.

## Recovery and consistency

Current read/session failover shares one deadline and logical-request budget
across every provider, including identity proofs. Transport failures, rate
limiting and admitted Cloudflare 52x/530 failures can advance to a configured
fallback. A disconnected tunnel may return
[530/1033](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/).
Authentication failures, reverts, invalid ABI, changed chain/hash and exhausted
budgets do not become retries.

The specific [Geth missing-trie-node error](https://github.com/ethereum/go-ethereum/blob/master/trie/errors.go)
can recover a scalar state read or state-only batch at an already observed
numeric block. The fallback must prove the same chain and every anchored block.
All delivered chain/header assertions are checked before batch recovery. A mixed
header/state batch, ambiguous missing-state error or exhausted provider list
fails closed. Provider messages and node details never enter the public response;
the existing `rpc_error` contract is retained.

Single-source historical jobs and deposit/log-window clients retain their current
failure behavior. No generic retry wrapper is inserted around financial workflows,
large indexer batches or persistently budgeted collectors.

## Applying a release

Code support and live activation are separate. Each production/development role
has its own private provider/profile file and network policy. The VM's
`127.0.0.1` is **not** the clawber host; use the authenticated HTTPS route.

1. Install the source revision using the existing release procedure.
   `install_read_release.py` preserves runtime symlinks and updates read/gateway;
   it does not update every financial/indexer service.
2. Add current public IPv4 pins for exactly `rpc.domino.money` to the applicable
   continuous/development egress input. Preserve historical/Alchemy pins. Render
   and apply the policy through existing tools, including each role's hosts file
   and `IPAddressAllow`. See [continuous egress](CONTINUOUS_EGRESS.md).
3. Update each applicable private provider file. Development `rpcUrls` profiles
   use the same private current list. Units intentionally unset environment RPC
   overrides; use their private files rather than shell exports.
4. Restart through `domino-continuous-reads.target` for its members, then perform
   bounded current-data, historical-state, inventory and public-bridge checks.
   Roll back the private config and release through the same target, retaining
   prior egress pins until verification completes.

The edge limits HTTP to 25 requests/second per IP (burst 50), with five WebSocket
connections per IP; sustained capacity was measured at 20 requests/second for the
qualified workload. This change increases neither concurrency nor existing
request budgets. VM roles may share one egress IP: the infrastructure limit is
aggregate, not an allocation per process. A local node is not unlimited capacity.
