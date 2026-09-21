# Local bytecode replay of price-band admission

Run from the repository root, with its existing npm dependencies and compiled
Foundry artifacts available:

```sh
node reports/price-band-2026-09-21/replay_guard.mjs
```

The script starts an isolated Anvil on a loopback-only ephemeral port, with
chain ID 4663 and Cancun rules. It has no remote RPC or fork argument, reads no
key, uses only Anvil's synthetic unlocked accounts, never runs Forge and never
writes `contracts/out`. Its sole output is `guard-replay-results.json`.
The input sample file must already contain at least 20 seconds of readings.
Run again after collection finishes to bind the results to the final input hash;
`sampleInput.endedAtUTC`, collection `status`, `noncanonicalBlocks` and
`canonicalityCheckedBlocks` preserve the collector's provenance. Missing fields
remain null, never an invented success or zero; a snapshot without a final
status is still in progress. Canonicality qualification belongs to the collector,
not this synthetic replay.

Before deployment it verifies the raw compiler metadata's compiler/settings,
every referenced source's keccak256, and absence of linked libraries. The guard's
artifact SHA-256, creation-code hash, runtime-template hash and source hashes
must match the existing `reports/revert-fees-2026-09-21/artifact-verification.json`
pins. The test mocks undergo the same metadata/source checks and have their own
artifact/code hashes recorded; they are not production deployments. Foundry's
parsed metadata omits some empty ABI/doc fields and normalizes remapping prefixes,
so raw compiler metadata supplies the authoritative settings/source map.

The compiled `MockGuardStateView` from `DominoPriceGuardV4.t.sol` provides a
controllable `getSlot0`. The generic E2 `MockStateView` does not implement that
method. The compiled `MockNitroArbSys` is installed at `0x64` explicitly. Installed
code is read back; deployed guard runtime matches its template outside compiler
immutable ranges, and publisher, guardian, state-view address and band getters
are verified. No claim is made that ordinary Anvil reproduces Nitro's actual
ancestor-chain opcode domain: the mock deliberately maps its ArbSys interface
to this local chain's number/hash context.

The run checks:

- Bands **25, 50, 100, 200 and 2,000 bps of square-root price**.
- For three spot magnitudes, including non-divisible integer boundaries and a
  value whose square exceeds uint256, the first/last admitted integer and one
  integer inside/outside each edge. Lower rounding is ceiling; upper rounding
  is floor. Zero reference and zero spot are rejected.
- The asymmetric denominator example: reference 19,900 against spot 20,000 at
  50 bps passes; reversing them fails. The denominator is publication-time spot.
- Publication at block ages 255, 256 and 257: only 255 is accepted. Real local
  publish transactions also persist one observation per band; `referencePrice`
  accepts it at age 255 and rejects it at age 256 with its timestamp unexpired.
- The first valid reference per sampled pool against the first global sample at
  least 500 ms and 20 seconds later, under all five bands. A missing pool read
  at that future sample is recorded, never replaced by a later successful one.
  Sample prices and block gaps are preserved; hashes and timestamps are local
  synthetic context. These are bounded sample pairs, not exhaustive live replay.

Each publication case executes the actual compiled guard through local
`eth_call` and compares the outcome with `analyze.py::within_band` plus its
separate block-age condition. Only the expected `InvalidObservation()` custom
error counts as rejection; transport errors or other reverts fail the run.
This distinction prevents a broken fixture from masquerading as successful
negative coverage. The stored-observation checks additionally use actual local
transactions and canonical local block hashes.

The captured run contains **187 publication decisions and 10 stored-observation
age checks**, all passing, with seven pools contributing 70 live-pair decisions.
Exact counts, input/script/analyzer hashes, sample coverage, artifact provenance,
deployed local runtime hashes and every decision are recorded in the JSON.

This proves the tested guard boundaries and the analyzer's decision fidelity for
those inputs. It does **not** measure production VM/HTTPS latency, publisher
submission or inclusion delay, independent-oracle integrity, manipulation cost,
liquidity sufficiency or the suitability of any band as a live operating choice.
No mainnet transaction was sent.
