# Robinhood local-first routing — 20 September 2026

## Delivered behavior

- Current and historical Robinhood RPC reads use the authenticated local node first. Alchemy remains the configured recovery endpoint.
- Wallet token discovery stays **exclusively on Alchemy**, following the owner's final instruction. Its candidate balances are reread through the local RPC. No global token-catalogue scan or new inventory pagination was activated on the VM.
- Ethereum execution and Beacon upstreams for Nitro were not changed.
- Provider configuration v4 removes the independent always-on historical Alchemy route. Both active production provider files were migrated; development retained its already-local-first profile.
- Catalogue/activity followers, public history/accounting, queue work, explicit historical NFT reads, Chainlink and configured tools consume the new routes. Financial collector/fork adapters preserve exact canonical block references and budgets; no financial service was activated.
- Legacy config versions retain their existing semantics for rollback. Explicit provider qualification/price-reference tools keep their named source; these are not always-on Robinhood RPC consumers.

## Runtime and verification

App, Worker, production reader/gateway and development code: `1b864e2a0253a9f7ce0f1a5380894ca2057dc839`.
[Publication workflow](https://github.com/domino-money/domino/actions/runs/35534581245) completed successfully.

Both production provider files report v4, local primary and Alchemy fallback; reader inventory remains Alchemy. Reader, gateway, tunnels, development, three public collectors and two worker timers were active. Production/development health returned HTTP 200; development admission was ready. No database migration, egress change, lease extension or financial activation occurred. Private rollback snapshots remain on the VM.

Bounded live proof: **46 logical calls in 3.11 seconds**: 41 local and 5 Alchemy. Old block 59,582,156 header/logs were served locally (9 logs). The local node lacked that block's contract state; fallback verified chain/hash and returned 3,531 bytes of code using 3 Alchemy calls. The following header/log calls returned to the local node. Wallet discovery used 2 Alchemy calls; its 6 diagnostic candidate balances stayed local and the response validated. No external balance/state call occurred in that wallet probe.

Stored read-v3 overview/search returned HTTP 200 in 12.97/7.41 ms on loopback. The public unauthenticated API retained HTTP 401 with verified TLS; this check was not an authenticated browser acceptance test.

## Latency and background contention

Three identical full wallet-page reads (20 token candidates plus native balance), measured through the production loopback API:

| Phase | Samples, milliseconds |
| --- | --- |
| Before migration | 1701.21, 1636.52, 1598.27 |
| After migration, before background spacing | 5569.97, 1792.65, 1555.98 |
| After background spacing | 1548.67, 1677.21, 1598.33 |

These are small operational samples, not a production capacity qualification. The 5,558 ms server-side outlier correlates with a reader `http_503` fallback; subsequent reads were 1,791/1,555 ms server-side. Candidate discovery code and pagination remain unchanged.

The edge's initial protection is 25 HTTP requests/second per source IP, burst 50. The tunnel makes multiple callers share that budget. In a fixed 118-second access-log span, 3,000 requests included 76 HTTP 503 responses **without contacting the upstream**; peak 53 requests/second. The historical lane became much faster locally (median 1.456 s/tick versus approximately 10.5 s previously), increasing background request pressure. At inspection, Nitro CPU was 27% and RAM 28.9 GiB; that snapshot does not establish a safe higher capacity.

Public background release `16587afac43000dd529545e44fc7a5798f6aa528` spaces history/accounting ticks by five seconds and queue/catalogue runs by sixty seconds after completion. Only those four unit definitions changed; the reader and development processes were not restarted by this mitigation. The current observation cadence, edge limit and per-job call budgets remain unchanged.

One bounded 59-second log window after spacing (2026-09-20T20:19:39+00:00 to 2026-09-20T20:20:38+00:00) recorded 1,493 HTTP requests: 10 nginx 503 refusals, peak 45 requests/second. The residual refusals mean aggregate capacity is still contested; this mitigation is not a production concurrency qualification. All three subsequent full wallet-page samples returned HTTP 200 in 1.55–1.68 seconds. No recurring monitor was installed.

## Tests

- Full backend/PostgreSQL run before removing the local-inventory experiment: 2,214 tests, 63 skipped, no failures.
- Final affected backend routing/API/inventory/dev tests: 112 passed, external network blocked.
- Final app suite: 1,116 passed.
- Final bridge: 774 tests plus 582 contract tests passed.
- Exported contracts and OpenAPI checked byte-for-byte. Public wire schemas/types and inventory implementation match the prior deployed behavior.
- Public installer tests after scheduling changes: 6 passed.
- Repository hygiene: 1,962 files checked, zero findings before the scheduling-only delta.

## Production concurrency boundary

The 25 RPS edge setting is an operational guard, not a protocol limit or measured hardware ceiling. The backend also currently permits one provider-touching read at a time; stored routes have a separate capacity pool. Increasing nginx alone therefore does not establish multi-user production capacity. A representative end-to-end benchmark must cover live wallets, stored reads, batching, background acquisition and fallback, with a shared background budget and reserved user capacity. The scheduling mitigation above does not guarantee no future burst-induced fallback.
