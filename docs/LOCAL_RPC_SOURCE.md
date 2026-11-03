# Domino's own RPC as a data source

The Robinhood node on `clawber` supplies current chain reads through the private
HTTPS route on `rpc.domino.money`. It is a **pruned node**, not an archive. The
version 4 configuration sends both current and historical Robinhood reads to
the local node first. Alchemy is retained for verified fallback. Nitro's
Ethereum execution and Beacon upstreams remain separate and unchanged.

On the services host the same node is also reachable without Cloudflare: its
proxy at `http://127.0.0.1:18547/` goes over the tailnet, with a reverse SSH
tunnel as backup ([fresh host install](FRESH_HOST_INSTALL.md), step 18). A
version 4 file may name it first, ahead of `rpc.domino.money` (#315).

## Routing

| Consumer | Source with a version 4 provider file |
| --- | --- |
| Token, wallet balance, pool state, current NFT and market snapshot reads | `rpcUrl`, then bounded `rpcFallbackUrls` |
| Session/onboarding EOA checks | Same current list, chain and block verified |
| Direct deposit preparation/receipt reads | Current primary; existing single-provider, fail-closed transport |
| Live activity window and log-only anchor lookup | Local primary for each operation; bounded, verified fallback |
| NFT reads requesting a block; owner resolution for stored pool positions | Local primary, then verified configured fallback |
| Catalogue/activity reconstruction, fees, positions, capital and Chainlink replay | Local primary for each operation, except state older than the node keeps, which starts at the fallback; fallback for transport failure or unavailable old state, with chain/block proofs |
| Managed performance collector and qualification forks | Local first; fallback attempts and identity proofs spend the existing transport budgets |
| Wallet token inventory | Alchemy exclusively for candidate discovery; every balance is reread through the local-first RPC |
| Explicit external price-reference tools | Separate provider capability; no credentials extracted from the local `rpcUrl` |
| Browser product data | Existing same-origin read bridge and backend; inherits their source |

Robinhood's public RPC is not a default anywhere: a provider file without
`rpcUrl` is refused (`rpc_url_unconfigured`), its host is not among the default
allowed hosts, and neither egress policy admits it. Public-provider benchmark
modes and qualification forks remain explicit comparisons that name
`PUBLIC_RPC_URL`. GeckoTerminal, CoinGecko and Uniswap APIs keep their distinct capabilities
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

To lead with the node's proxy on the services host, or to give the lead back:

```sh
backend/.venv/bin/python -B backend/configure_rpc.py --node-loopback on --config-file /absolute/private/providers.json
backend/.venv/bin/python -B backend/configure_rpc.py --node-loopback off --config-file /absolute/private/providers.json
```

Nothing is typed and nothing is printed but a fixed line. `on` puts
`http://127.0.0.1:18547/` first and keeps every route after it in order, so the
file reads proxy, `rpc.domino.money`, then the archive; it probes only the proxy
before saving, as the identity running it. `off` removes the proxy. Use the
runtime directory's real path: the save refuses a linked directory.

The terminal hides the **RPC authentication token** and fallback HTTPS URL.
The token is not the Cloudflare connector token. Blank fallback input preserves the existing archive/recovery endpoint, or the
previous primary on the first migration.
The configurator verifies the chain, deployed manager links and a common block
before an atomic, owner-only `0600` save. It does not prove old-state coverage or
restart services. Preserve a private rollback copy before replacing production
configuration; never copy a credential-bearing file into Git or an issue.

Version 4 contains `rpcUrl`, `rpcFallbackUrls`, `rpcAllowedHosts` and
`inventoryUrl`. The node leads: `rpcUrl` is `rpc.domino.money`, or exactly
`http://127.0.0.1:18547/` with `rpc.domino.money` as the first fallback
(`loopback_requires_local_fallback` otherwise). That URL is the only plain-HTTP
route anywhere: it is not a host in `rpcAllowedHosts`, it never appears among
the fallbacks, an environment override cannot select it, and it always goes
through the fixed no-proxy, no-redirect loopback opener. The financial
listeners' checks accept HTTPS routes only and refuse such a file at start.
Both current and historical consumers use that same ordered route; there is no
separate always-on historical Alchemy endpoint. Version 1/2/3 files remain
supported for rollback, and their existing routing semantics are unchanged
until migration.

The migration preserves a previous archive URL in the fallback list and keeps
inventory credentials separate. Rotating the local token removes the old local
URL from the fallback list. URLs and private files retain their existing exact
host/path, ownership, mode and no-redirect validation. Operator overrides remain
explicit; the deployed units unset shell RPC overrides.

Wallet token discovery deliberately remains on Alchemy's inventory API, as
requested by the owner. It is separate from the standard Robinhood RPC routes:
Alchemy supplies candidate contract addresses, and Domino rereads their balances
through the local node. No global-catalogue walk or local inventory scan is added
to the wallet request. Existing pagination, latency budgets and response schemas
remain unchanged. The configured inventory endpoint survives v4 migration.

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

A call a route did not answer within its own ceiling (8 s on the reader's
transport, 12 s by default) while the read still has time advances too
(`discovery.RpcCallTimeout`, still `read_deadline_exceeded` to every caller):
past the own node's other route, which is the same node, to the next provider.
The process's next reads pass over the routes it moved past for 15 s; the order
is kept. A slow `eth_getLogs` on the own node stays where it is: its range is
narrowed instead. A slow call that answers is kept. Each call that took 2 s or
more, or ran out of time, leaves one `rpc_slow_call` line: the provider ordinal,
methods, items, milliseconds and outcome, never a URL (item 4.5, 3 Nov 2026).

For current read/session clients, the specific [Geth missing-trie-node error](https://github.com/ethereum/go-ethereum/blob/master/trie/errors.go)
can recover a scalar state read or state-only batch at an already observed
numeric block. The fallback must prove the same chain and every anchored block.
All delivered chain/header assertions are checked before batch recovery. A mixed
header/state batch, ambiguous missing-state error or exhausted provider list
fails closed. Provider messages and node details never enter the public response;
the existing `rpc_error` contract is retained.

Historical v4 reads retain a bounded set of headers plus their highest observed
continuity anchor. Each operation returns to the local primary: a pruned-state
fallback cannot redirect subsequent logs/headers to Alchemy. The exception is
a state read whose numeric block lies more than `LOCAL_STATE_BLOCKS` (15,000)
below the highest verified header. The node keeps about 30 minutes of state
(18,000 blocks at ten per second), so such a read starts at the first route
past the node, its proxy and its public route alike, instead of drawing a
certain missing-trie refusal; consecutive old reads stay on the verified
fallback. State the node refused over one path is not asked of the other: a
refusal from the proxy skips `rpc.domino.money`. A transport failure at the
proxy does move to `rpc.domino.money`, the same node by another path. Reads inside the margin still try the node first and
keep the refusal fallback, which covers the shorter window after a restart. A switch verifies
chain identity and the continuity header; state at an evicted numeric block is
pinned again. Historical mixed batches can recover an explicit missing-state refusal only after every delivered identity/header assertion validates. Invalid chain/hash, malformed envelopes and contract reverts do
not trigger fallback. Ambiguous failed batches are not replayed.

A missing-trie refusal is an expected reason for fallback even while the local
node is healthy: availability does not imply archive-state retention. Logs and
headers present locally do not require an archive fallback. Fixed operational
messages record provider index and a safe fallback reason, never URLs or keys.
Ethereum/Beacon upstreams and the node's probes remain unchanged.

## Applying a release

Code support and live activation are separate. Each production/development role
has its own private provider/profile file and network policy. On the services
host, `127.0.0.1:18547` is the node's proxy and may lead the reader's and the
writer's files once their egress admits it (`nodeLoopbackReads`, see
[continuous egress](CONTINUOUS_EGRESS.md)). No other loopback address or port
is the node: the first VM's `127.0.0.1:8547` never was.

1. Install the source revision using the existing release procedure.
   `install_read_release.py` preserves runtime symlinks and updates read/gateway;
   it does not update every financial/indexer service.
2. Add current public IPv4 pins for exactly `rpc.domino.money` to the applicable
   continuous/development egress input. Preserve historical/Alchemy pins. Render
   and apply the policy through existing tools, including each role's hosts file
   and `IPAddressAllow`. See [continuous egress](CONTINUOUS_EGRESS.md).
3. Update each applicable private provider file. Development `rpcUrls` profiles
   use the same private current list. Units intentionally unset environment RPC
   overrides; use their private files rather than shell exports. Migrate active provider
   files to v4 only alongside compatible code; preserve private rollback copies.
4. Restart through `domino-continuous-reads.target` for its members, then perform
   bounded current-data, historical-state, inventory and public-bridge checks.
   Development also has a hash-guarded maintenance lease: update its snapshot
   transactionally when replacing tracked unit/profile files, without extending
   authorization expiry. Roll back the private config and release through the same target, retaining
   prior egress pins until verification completes.

The edge limits the backend's token to 100 requests/second per IP (burst 200) and
20 concurrent HTTP connections, with five WebSocket connections per IP (D19 in the
node's repository, 24 Sep 2026). VM roles may share one egress IP: the
infrastructure limit is aggregate, not an allocation per process. The proxy on
the services host does not pass through that edge. It bounds connections only:
512 at its listener, 128 per path, and 256 at the tailnet socket on clawber; the
per-job budgets and the reader's lanes bound the rest. The site's
server-side routes on Cloudflare have their own token, limited per token rather
than per IP, because a Worker's request does not carry the visitor's address:
1,000 requests/second (burst 2,000) and 64 connections (D21, 2 Oct 2026).

The node's rated capacity (2 Oct 2026, guarded loopback ramps; PERFORMANCE.md in
the node's repository) is a CPU budget of about four cores for RPC work; above it,
block execution slows. Per call: about 0.36 ms for `eth_call`-class reads, 1.2 ms
for a 20-read multicall, 0.58 ms for `eth_simulateV1`, 0.56 ms for `eth_getLogs`
over the last 10,000 blocks, and about 95 ms for `eth_getLogs` over everything
since the Domino deployment (block 69,249,061), a cost that grows with the range.
The node cuts any call at 30 seconds and accepts batches of up to 1,000 calls. A
local node is not unlimited capacity.

The persistent history and accounting lanes pause five seconds between ticks.
Queue/catalogue timers wait sixty seconds after a run finishes. The current
observation lane keeps its existing cadence. These background intervals reserve
capacity after historical reads become much faster on the local node; the nginx
limit and per-job budgets remain unchanged. Bursts can still use the bounded
transport fallback—these intervals are not a global rate-limit guarantee.
