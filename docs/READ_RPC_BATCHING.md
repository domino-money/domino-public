# Bounded public-read RPC batching — #123 candidate

Source reference: `adba60f45fe20e53b2b38fde040c9eeb03fad380`, including the
pre-dispatch failover correction. This candidate reduces serial network round
trips while retaining each chain, deployment, manager, pool and canonicality
check. It is deployed and live in the reader and gateway as `e4a989b`
(included in reader/gateway `85e7511`), though production serving was not
re-timed after the 13 September app redesign.

## Observation and expected cost

Read-only diagnosis on 12 September 2026 found successful market responses,
including a miss with retrieval age zero and a warm hit with age five seconds.
The active continuous reader profile had no 600-second expiry; its read egress
deny counter did not increase during those reads. That observation does not
establish the cause of any earlier provider failure. The cache's generic
`provider_unavailable` reason alone cannot identify DNS, egress or rate limits.

A bounded profile of the installed reader measured 11 successful sequential
RPC calls totaling 5.426415 seconds. A separate chain-ID/latest-header batch
completed in 0.430863 seconds with the exact two response IDs. That small probe
proves support for that envelope on the endpoint tested; it does not qualify
the five-item batch, fallback endpoints or this full candidate.

The healthy configured failover path has these phases:

| Phase | Logical RPC calls | HTTP envelopes before | Candidate HTTP envelopes |
| --- | ---: | ---: | ---: |
| Provider chain verification | 1 | 1 | 1 |
| Snapshot chain ID and latest header | 2 | 2 | 1 |
| Three contract-code reads and two manager-link reads | 5 | 5 | 1 |
| Full pool key and current pool state | 2 | 2 | 2 |
| Final canonical header | 1 | 1 | 1 |
| Total | 11 | 11 | 6 |

This removes five serial round trips, not five validations or budget units.
It does not promise a fixed speedup: provider batch processing, response sizes,
TLS and fresh GeckoTerminal retrieval time remain variable. No capacity limit,
cache TTL, provider quota, refresh schedule or financial capability changes.

## Verification and failure boundary

`ReadService` enables batches for its built-in configured RPC transports.
Injected `rpc_factory` implementations retain their existing interface;
`ReadRpc` itself defaults to sequential snapshot reads. No token or pool
allowlist is introduced.

The latest header is parsed and checked before the independent deployment
reads are constructed at its explicit numeric block. Code presence and both
manager links still validate. Pool identity/state and the final canonical
header remain ordered. A batch cannot establish and consume a new state
anchor within the same envelope.

Each batch contains at most eight allowlisted read methods and 65,536 request
bytes. The existing 2,000,000-byte response limit and shared monotonic deadline
apply. Every attempted item spends the same logical RPC budget, including
failed batches and all failover chain/anchor checks. Write methods, state
overrides, nonnumeric state blocks and excessive call gas are rejected.

Responses must have an exact bijection of integer IDs, excluding booleans and
floats. Duplicate, missing or unexpected IDs, malformed envelopes and any RPC
error reject the whole batch. No partial result or anchor set is committed.

A retryable scalar failure while verifying a provider **before batch dispatch**
may advance to the next endpoint. Every existing anchor is then checked again.
This phase distinction fixes a regression that blocked healthy fallback even
when the failed primary had received no batch. After a batch attempt, an
ambiguous network failure is not automatically retried. Explicit retryable
HTTP responses may advance within the same deadline and count; wrong chains,
changed anchors, malformed responses and exhausted budgets fail closed.
There is no automatic sequential replay for an unsupported batch provider.

## Display provenance

The frontend's display clock adds elapsed screen time to retrieval age. That
can make an observation stale without a network refresh being attempted. The
figures dialog now states staleness and retains any known reason, provider and
retrieval timestamp without inventing a failed refresh. Returning viewers
still reuse a completed read; this copy correction adds no automatic polling.

## Unchanged-wire notice

The regenerated `read-v1` manifest changes only source hashes for
`backend/discovery.py`, `backend/rpc_failover.py` and `backend/read_service.py`.
Its version remains `1.1.0-rc.3`; all schemas, types, runtime validators,
fixtures, error definitions and `backend/openapi-read.json` are byte-identical
to the merged main baseline. Onboarding and deposit regeneration produces no
diff; the session package is also unchanged. Monetary strings, nullability,
retrieval age and availability meanings are preserved.

| Artifact | SHA-256 |
| --- | --- |
| `read-v1/manifest.json` | `91a73a54a1cd4eb40e9df55c5a9691163a2c6569a58a9a3a1ef9d2799a20196a` |
| `onboarding-v1/manifest.json` | `2f6eb9f02b8cd2d06cddd4352e7db6fdae6b19bd7f2a91577a9ec15039b5d416` |
| `deposit-v1/manifest.json` | `be0e22ddfb5b6ea437a88999c9d924013bb5128af13060bd2af6f28a803848df` |
| `session-v1/manifest.json` | `278d5fa3f3a6571c92e13e39bddc3e1b9091a8ad82e4b83aa534cc9e83decd42` |
| `backend/openapi-read.json` | `8de9a88b3c1535d0ba3cafcbc2b0917a09ae7f83ab755ec9ea994cb0d2ff23fc` |

`app/src/lib/read/pin.ts` records this source commit and the manifest digest;
the consumer pin tests validate the actual imported bytes. This source notice
does not claim a published PR or a new live release.

## Acceptance and rollback

Offline tests cover response identity, batch limits, shared budgets/deadlines,
pre-dispatch bootstrap and all-anchor failover, ambiguous completion, existing
sequential/custom transports, snapshot parity and the 11-to-6 envelope count.
The frontend regressions cover local aging with no new read and preservation
of known reasons. These tests do not substitute for endpoint qualification.

Local validation used Python 3.14 and Node 24.19.0: backend discovery ran
1,373 tests (1,034 passed; 339 opt-in PostgreSQL/EVM cases skipped), the app's
586 tests had 585 passes and one existing skip, and bridge/shared read checks
passed 650 and 490 tests respectively. App typecheck, lint, production/fixture
builds, shared read typecheck and the focused browser aging test passed. All
five contract/OpenAPI export checks passed. The independent batch audit passed
35 focused/adversarial cases; the display-copy source review found no blocker.
The full PostgreSQL/EVM CI and actual endpoint benchmark remain separate gates.

Before rollout, the operator must qualify the frozen full snapshot/pool/final
header path, including the exact two- and five-item batches, separately on
every configured primary and fallback endpoint under the existing reader
identity and network policy. Record safe method/count/duration/success facts,
source hashes and unchanged service state; omit credentials and private URLs.
Reject unsupported envelopes or failed identity/freshness proofs. The normal
review, current-head CI and coordinated rollout gates still apply.

If qualification fails, retain the current release and investigate that
endpoint without broadening policy or retrying ambiguous batches. If a later
reviewed rollout regresses, restore the recorded previous reader release and
matching consumer provenance pin through the existing deployment procedure.
This candidate introduces no persistent schema migration or data conversion.
