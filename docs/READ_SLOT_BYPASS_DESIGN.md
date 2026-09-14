"""T2.3 candidate: cached-market reads bypass the single global read slot.

The audit (#138 §1.4) measured Home at 15 sequential reads = 47.3s because
`ReadGate` admits one read at a time with >=1s between starts. This design
note (not yet a commit) proposes the bounded change and its test plan.

## Design

`ReadGate` keeps exactly one slot for **provider-touching** reads (the seven
routes that hit chain RPC or the GeckoTerminal/DexScreener providers):
`token`, `pools`, `pool-market`, `wallet-assets`, `nft-positions`,
`pool-activity`, `pool-positions`. That preserves the existing provider/RPC
budget guarantees - the provider call ceilings and the 15s deadline still
apply to at most one expensive read in flight.

`catalogue` and `pool-metrics` never dispatch RPC or provider calls: they
read PostgreSQL (`domino_catalogue*`, REPEATABLE READ READ ONLY, 5s
statement timeout) and stored price series. They gain a second admission
path - same interval discipline between starts, but their own slot - so a
slow expensive read no longer serialises behind or ahead of pure DB reads.

pool-market when it answers entirely from the process-local MarketCache
TTL/stale fallback is NOT special-cased in this slice: its chain-snapshot
+ canonical re-read always touches RPC, so it keeps the provider slot. That
matches T2.2's separate plan (serve pool state from the ingestor store).

## Why not more concurrency

The 15s shared deadline and per-provider ceilings are enforced per in-flight
operation; two concurrent provider reads would double peak RPC against the
same endpoint and change the budget math that test_read_expensive_capacity
pins. Widening the provider slot is a separate, measured step (T2.1's
snapshot removes most provider reads first).

## Changes

- `read_api.py`: `ReadGate` gains `kind`-aware admission ('provider' default
  slot; 'stored' slot). `run_read` passes the route's kind. Health reports
  both slots' busy state; the gateway's `health['busy']` reconciliation
  checks the provider slot (the one it dispatches into).
- `read_gateway.py`: route -> kind map shared with read_api; the execute
  path requires the matching slot; worker CapacityLimiter(1) becomes (2)
  only if both slots exist - otherwise keep (1) and let the reader gate
  arbitrate (chosen: limiter stays 1 per slot-kind, total 2 threads).
- Tests: existing suite keeps passing with interval=0 gates in tests;
  new cases: catalogue/pool-metrics proceed while a blocking provider read
  holds its slot; provider read gets 429 while stored read in flight and
  vice versa; health busy semantics; gateway passes the right kind.

## Out of scope here

ClientBudgets (30/min/client) unchanged; no queue introduced; no provider
budget change; dev lane DevelopmentGate keeps its stricter 6-starts/2s window
for both kinds (dev budget ceilings are the binding constraint there).
"""
