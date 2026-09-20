# V4 contracts: what remains, and whether they are ready for an audit — 20 September 2026

State of the four tracks the [19 September review](CONTRACT_REVIEW_2026-09-19.md) opened, as of
`ec2e9aa` on `main`. Every closed item names the record that closes it; every open one says what
would close it. The last section answers the question this was written for.

## Hardening

**Closed.**

| finding | what | closed by |
| --- | --- | --- |
| D-01 | every action anchors to a published price, checked against the pool's live reading | `28eeaa9`; reproduced on a fork of the real pool ([EXECUTION_FORK_SANDWICH](EXECUTION_FORK_SANDWICH_2026-09-20.md)) |
| D-02 | a plan states the ceiling of what one add may cost; the fee-on-transfer and per-execution bounds | D-02 section of the review; ceiling shown deciding on a wide range in the fork report |
| D-03 | the publisher is one key: band against the pool's reading, then rotation through an immutable guardian with a two-key handshake and guardian revoke | `28eeaa9`, `ec2e9aa`; 39-mutation batch, 30 pinned, 9 recorded redundancies |
| D-04 | the guard holds the `stateView` it bounds against | `28eeaa9` |
| D-10 | per-execution scratch in transient storage, vault and engine | D-10 in the review; 638 B of vault slack that made D-01/D-02 fit |

**Open.**

- **D-09** — the overflow threshold is an arithmetic estimate. Closing it is one test that pins
  the threshold, in `DominoCompoundHelper.t.sol` or beside `ratioBps`.
- **D-05 … D-08 are not on record.** The review cites D-09 and D-10 by number and never
  enumerates the ones between; like the original M-03 … M-10 they cannot be recovered. This is a
  fact to state in the audit package, not a set of items to close.

## Optimization and compaction

**Closed.** F2 and F7 (engine and routing helper: −9.2% on a general execution, −11.1% on a
netting one, measured); F3 (premise false), F11 (−91 B would remove a defence-in-depth codehash
check) and V2 (2,182 B measured, but the optimizer sequence that yields it fails to compile
tree-wide) declined with measurements; the compaction items V1 and V4–V8 made unnecessary by
D-10 — the vault has 951 B of headroom against a 313 B reserve, the engine 2,677 B against 2,048.

**Open.**

- A committed gas baseline (`forge snapshot`) so a regression fails CI. Today the figures live in
  reports and in one `GasComparison` event of the reference suite.

## Review and hygiene

**Closed, nothing open.** H-01, H-02 ([CONTRACT_HYGIENE](CONTRACT_HYGIENE_2026-09-19.md));
M-03 … M-22 ([CONTRACT_HYGIENE_MINOR](CONTRACT_HYGIENE_MINOR_2026-09-19.md), status section);
the V3 lineage retired with its factory, architecture and executor suites ported to V4 first.

## Security evidence (SECURITY_SPEC §8)

**Held.**

- Unit, fuzz and invariant tests: 15 suites, 219 tests, coverage asserted by mutation rather than
  by count; `DominoVaultV4Invariants.t.sol` holds the custody ledger's five invariants under a
  fuzzed owner and engine, with a self-test that proves each handler action reaches the vault.
- Mainnet-state fork of the execution path: compound (`GENERAL`), the swap path, successor mint
  (`MINT`) and every owner exit, on the real `weth-usdg` pool through the real PositionManager;
  the sandwich measured at five move sizes on two ranges.
- Recovery: the durable executor's eighteen crash, nonce, reorg, signer and backup tests, ported
  to the V4 vault, plus the V4 executor's seven.
- Gas read from receipts (1,162,908 for a 1,764-byte compound; 1,742,808 for a successor mint;
  every owner exit under 80,000) and the L1 data component from the live node (zero, a point
  sample).

**Open.**

- `NET` and `FUND` on the real fork — both run only on the local official-contract fixtures.
- Economic benchmarks the matrix names: small reserves, repeated failed attempts, lower fee
  accrual. The fork's fees came from synthetic volume; the real accrual rate on this pool is not
  measured.
- Application security review — cross-tenant access, replay, frontend transaction substitution,
  admin and signer isolation. Covered by tests on a local chain; no dedicated adversarial pass.
  This is the app and backend, not the contracts.
- Owner recovery drill with the frontend, API and indexer unavailable — operational.
- The executor's behaviour on an `InvalidAmount()` refusal: on a ±2% range a 0.5% move between
  observation and execution fails an honest compound closed, so the executor must re-plan rather
  than treat it as a fault. Not tested.

## Ready for an audit?

**Yes, for the contracts — with a package of two or three days' work before it is sent.** The
internal review is closed, every recorded finding has a disposition, coverage is verified by
deletion, and the two economic findings were reproduced on the real pool. What an auditor needs
and does not yet have is not code:

1. **A freeze.** No design change is pending; the one open decision (the publisher's trust model)
   was taken — guardian rotation, no threshold. Freeze at `ec2e9aa` or later, and say so.
2. **D-09 as a test, and the gas baseline.** Estimates in the reports cost an auditor time.
3. **A scope and trust-model document.** The seven deployed artifacts and their libraries; the
   roles — one-shot deployer, owner, operator, publisher, guardian, fee recipient — and what each
   may do; the known limitations in writing: one live publisher as the liveness dependency,
   pre-observation manipulation bounded by the publisher's integrity and the attacker's measured
   cost, concentrated ranges failing closed on small moves, D-05 … D-08 unrecorded.
4. **Reproducibility.** Pinned solc 0.8.26 with `via_ir`, artifact hashes, the test commands, and
   the mutation procedure (the disposable copy and the batches), so the coverage claims can be
   checked rather than trusted.
5. **An index of the reports** with each finding's disposition — the pieces exist; they need
   assembling.

**Not ready for an audit: the service around the contracts.** Signer, executor, planner and read
path have never been exercised against a real deployment. A compromised operator key is bounded
today by the contracts — anchor, ceiling, band — but the service that holds that key is where
the next adversarial pass belongs.
