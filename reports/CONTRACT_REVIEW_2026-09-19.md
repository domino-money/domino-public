# Solidity contracts: hardening, hygiene, optimization, compaction — 19 September 2026

Four independent reviewers read `contracts/src` (15 files, 3,380 lines) on the
four requested axes, each with the prior records in `reports/` and
`contracts/README.md` in hand. Their findings are cited to `file:line`.
Alongside them, three things were measured here rather than estimated:

- **Every suite and the gate.** The thirteen Solidity suites run the way CI
  runs them (one dependency closure at a time, pinned Forge 1.7.1 and the
  `solc-wrapper.py` path): **189 tests passed, 0 failed, 0 skipped**, and
  `scripts/check-contract-size.mjs` passes for all ten gated artifacts.
- **Every gated contract's bytecode**, compiled with the repository's own
  pinned `solc-js` 0.8.26 and the exact CI profile (cancun, optimizer 200,
  `viaIR`, `bytecodeHash none`). The figures below are that measurement, not
  a quotation from an older report — they reproduce `V4_EXECUTION.md` exactly,
  which is what makes the reviewers' deltas trustworthy.
- **The `optimizer_runs` knob.** Lowering it is not available: at runs 50 and
  runs 1 the build fails outright with a Yul stack-too-deep in
  `DominoExecutionEngineV4`'s two-pass allocation loop
  (`Variable cleaned is 1 too deep`, `contracts/src/DominoExecutionEngineV4.sol:183`).

*Superseded — the figures below were true when this report was written and
five of the ten rows no longer reproduce. Measured at the head that carries
D-01, D-02, D-10 and the F2/F7 work:*

| Contract | Runtime | Headroom | Reserve | Slack | Creation |
|---|---:|---:|---:|---:|---:|
| DominoVault (V3) | 23,841 | 735 | 512 | 223 | 43,112 |
| DominoVaultV4 | 23,625 | 951 | 313 | **638** | 25,108 |
| DominoExecutionEngineV4 | 21,899 | 2,677 | 2,048 | 629 | 22,717 |
| DominoRoutingHelperV4 | 13,815 | 10,761 | 0 | 10,761 | 13,841 |
| DominoSetup | 11,898 | 12,678 | 0 | 12,678 | 12,970 |
| DominoCompoundEngine | 10,020 | 14,556 | 8,000 | 6,556 | 10,568 |
| DominoVaultReadHelper | 7,459 | 17,117 | 0 | 17,117 | 7,731 |
| DominoVaultFactoryV4 | 3,502 | 21,074 | 0 | 21,074 | 4,367 |
| DominoPriceGuardV4 | 2,760 | 21,816 | 0 | 21,816 | 3,166 |
| DominoVaultFactory | 2,286 | 22,290 | 0 | 22,290 | 46,182 |

**Nothing in this report has been changed.** It is an assessment; each item
below is a proposal with its own risk, and several are owner decisions.

## What matters most

**The V4 vault has zero slack.** Its runtime is exactly at the gate's reserve:
any byte added fails the build. That is the single fact that orders the rest —
several hardening fixes add code to that contract, so the compaction work is
what buys the room to make them.

*No longer true, and the order it justified no longer binds.* Moving the
vault's per-execution scratch to transient storage (D-10) freed 112 B and the
same move in the engine freed a further 481 B, so the vault now has 638 B of
slack and the engine 629 B. The hardening that needed room — D-01 and D-02 —
has landed. Byte pressure is no longer what sequences this work, which is why
F11 was declined rather than taken: 91 B is not worth removing a defence-in-depth
codehash check from the guard that protects the fee sinks.

### 1. The non-swap compound path has no independent price anchor (hardening D-01)

`DominoPriceGuardV4.referencePrice` is called in exactly one place:
`_swap`, and only when `plan.swap.amountIn != 0`
(`contracts/src/DominoExecutionEngineV4.sol:262`). For `GENERAL`, `NET`,
`FUND` and a `MINT` without a swap, the only price check is
`validateCompoundPrice`, whose band `minSqrtPriceX96 … maxSqrtPriceX96` comes
from the operator's own plan (`contracts/src/DominoVaultTypes.sol:96`). An
operator can pass `1 … type(uint160).max` and the check is vacuous. The same
unanchored spot drives the successor trigger and the source-eligibility tests
(`contracts/src/DominoRoutingHelperV4.sol:127`, `:133`, `:171`).

The operator is documented as automation authority that "never includes
resume, policy changes or withdrawals". A compromised one can still sandwich
the vault's own liquidity add: move spot, execute, restore. The loss is
bounded by the fee reserve and that action's collected fees, but it is real,
and it defeats the stated boundary.

The fix is to require an anchor for every action, not only swaps. It costs an
observation read and two `mulDiv` calls on the hot path, and it makes every
execution depend on publisher liveness — which is why D-03 and D-04 below
have to be answered with it, not after it.

### 2. A plan cannot say what one add may cost (D-02) — FIXED, and restated

*Corrected and closed after measurement; see the note at the end of this
section for what the original text got wrong.*

For a committed `liquidityIncrease` the **value** of an add is bounded by the
D-01 price anchor, but its **composition** is not: `amount1 = L(√P − √Pa)`
collapses toward a range edge, so a price move well inside
`ExecutionLimits.maxPriceImpactBps` changes the raw per-currency spend by
orders of magnitude. That knob is a single global owner setting, admitted up
to 9999 bps, whose job is liveness — not a per-execution statement of what
this add may cost. The engine bounded the spend only from below, at two
byte-identical floors, and the periphery's own ceiling was switched off.

Measured on the real contracts with one plan and three worlds, at a 1000 bps
band an owner may legitimately choose: the same calldata costs 29,555,984,009
of currency1 at the unmoved price, 49,495,984,009 after an outside buy and
10,005,699,277 after an outside sell. The mover is a third party, not the
operator.

The fix is a plan-declared per-currency ceiling on `E.Plan`, enforced in the
engine beside the existing floors, and signed as `maxNetAdded0/1` on the E1
`ExecutionPlan` so a relaying party cannot widen it. **Not** a ceiling derived
on-chain: for fixed `L` the amounts are monotone in price, so a derived
ceiling widened by `t ≥ band` can never fire and one with `t < band` is just a
tighter band the owner could already set. There is no tolerance that makes a
derived ceiling informative.

Four corrections to the original text, all measured:

1. The cites were stale: the disabled ceilings are at `DominoVaultV4.sol:311`
   and `:380`, and the floor at `DominoExecutionEngineV4.sol:177` has an
   identical twin at `:241` that the section never mentioned.
2. "The only limit is budget exhaustion" undersold what exists — the per-budget
   `maxOriginal`/`maxCharged` are absolute raw-token ceilings — and oversold the
   gap: the loss is the overpay against the anchor, not the raw token swing, and
   at the 100 bps every deployment runs it is about 4 bps.
3. Feeding the ceiling to the periphery is the *more* expensive placement, not
   the only one: engine +118 B against periphery +255 B engine and +92 B vault.
   It also bounds the wrong quantity, and on the `increase == 0` branch those
   same ABI words are minimums.
4. The `ExecutionEncoding` goldens move because the **signed** plan gains the
   field, not because `E.Plan` does. `E.Plan` is not what those goldens hash.

### 3. The price publisher is a single key with no on-chain sanity check (D-03, D-04)

`DominoPriceGuardV4.publish` accepts `sqrtPriceX96` verbatim
(`contracts/src/DominoPriceGuardV4.sol:21-32`); the guard holds no
`stateView` and compares the anchor to nothing. `publisher` is one immutable
address, no rotation, no threshold, only per-observation `revoke`. A
compromised publisher alone is a swap-path denial of service; together with
the operator key it is a drain of the fee reserve at a fabricated rate.

Freshness is self-attested on both sides: the publisher chooses
`point.timestamp` and the operator chooses `plan.observedAtTimestamp`, each up
to `block.timestamp`, so neither age bound binds. The one hard anchor is
`blockhash`, which is why the advertised 3,600-second window is unreachable —
observations really die at the 256-block cliff. Expressing freshness in
blocks would make the configured limit mean what owners think it means.

### 4. The shipping vault is tested only through its twin (hygiene H-01, H-02)

`DominoVault.sol` and `DominoVaultV4.sol` share **601 identical lines** and
have already diverged in 27 places — among them a `StaleAuthority` error and a
`CompoundSelfCompleted` event that V4 declares and never uses, and a comment
carried verbatim into V4 that is false there ("No external E2 function
exposes these sinks", `DominoVaultV4.sol:687`, while `executionCredit` and
`executionConvert` do exactly that).

Worse, the only suite that imports `DominoVaultV4` is
`test/reference/OfficialDominoExecutionV4.t.sol`. The custody surface the
release actually ships — `setOperator`, `revokeOperator`, `pause`, `resume`,
`rearmRoot`, `withdrawFeeReserves`, `recoverUntrackedCurrency`, `notifyBurn` —
has **no direct test at all**; it is covered only through the V3 copy, and
the copy has drifted. `DominoVaultFactoryV4` has one happy-path call and no
rejection suite; five of the six `execution*` callbacks have no forged-call
test, and neither does `DominoSetup.unlockCallback`.

This is the cheapest high-value work in the whole report: no production
bytes, no behaviour change, and it closes the gap that let the divergence
happen unnoticed.

### 5. Where the bytes are, and how to buy the room (compaction)

The reviewer's estimates for the vault, ordered by bytes ÷ risk, with two
already measured by a colleague on the same pinned compiler:

| Item | Change | Estimate |
|---|---|---|
| V1 | `onlyOwner`/`nonReentrant` bodies → private functions (23 expansion sites) | −250 to −450 B |
| V2 | Remove literal arguments so the Yul FunctionSpecializer stops cloning `_register` ×2, `_credit` ×2, `_invalidateRoot` ×3 | −300 to −600 B |
| V3 | PositionManager payload building → the read helper (the V3 pattern) | −350 to −550 B vault, +300 to +400 B helper |
| F1/V7 | Per-transaction scratch → transient storage | **−143 B measured**, and −14 to −17k gas per execute |
| F11 | Drop the per-callback `codehash` re-check (Cancun makes it constant in-transaction) | **−91 B measured** |
| V4, V5, V6, V8 | `calldata` params, one helper accessor, two extracted guards, one unused public getter | −390 to −650 B |

The specializer finding is the interesting one: it is invisible in the source.
The reviewer verified the pinned compiler's default Yul step sequence contains
`F` by decoding the wasm in `node_modules/solc/soljson.js`, so passing a
literal argument silently duplicates the whole function body.

`optimizer_runs` is not a lever: it does not compile below 200 (measured
above). `cbor_metadata = false` would free 13-15 B per contract and is not
inspected by the gate, but it is a reviewed-profile change.

### 6. Gas, where it is worth taking (optimization)

For a one-position, two-budget `GENERAL` execute against the measured
1,151,557 gas baseline, the reviewer's estimates total roughly 6%, or 8% with
the `consumedIntent` item:

- **F2, ≈20-30k**: the engine re-reads vault immutables through the clone
  ~51 times per execute, ~38 of them repeats (`vault.positionManager()` ×8,
  `poolId()` ×5, `position()` per point). Cache once per `unlockCallback`.
  Engine-only, no vault change.
- **F1, ≈14-17k**: the transient-storage move above, which also frees bytes.
- **F3, ≈5-15k per position**: the `Checkpoint` struct is 7 slots; two of its
  fields are never read on-chain and `observedAtBlock` sits alone in a word.
- **F7, ≈8-10k**: `RoutingHelperV4.validate` reads `slot0` twice, re-reads
  `position()` and re-checks custody per budget, and calls two of its own
  functions through `this.` — an external self-call that ABI-encodes an
  11-word struct each time.
- **F9, ≈25k**: `consumedIntent` costs a permanent `SSTORE_SET` per execute,
  while `stateNonce` already makes a completed plan unreplayable. Dropping it
  is an interface change (`IDominoVaultDraft.intentConsumed`), so it is a
  decision, not a cleanup.

Every figure is an opcode-pricing estimate. None should be adopted without
`forge snapshot` on `OfficialDominoExecutionV4`, and F1/F4/F9 depend on refund
accounting, so they need receipt gas from Anvil as well as the snapshot delta.

### 7. Two things that are not what the record says

- **`reports/GENERAL_COMPOUND_IMPLEMENTATION.md` states "production imports
  none" of the vendored Uniswap sources.** `DominoRoutingHelperV4.sol:8-9`
  imports `FullMath` and `TickMath` through a remapping into
  `test/reference/official-v4/`. A production artifact's source set therefore
  includes a directory named `test/`, and the release generator hashes every
  referenced source.
- **`contracts/README.md` describes `DominoVault.sol` as the E2 candidate
  with "no compound/mint/swap/signing method".** That file is the V3 general
  compound candidate and has `compoundSelf` at line 256. The README never
  mentions `DominoVaultV4`, `DominoExecutionEngineV4`,
  `DominoRoutingHelperV4`, `DominoPriceGuardV4` or `DominoSetup` — the five
  contracts the release actually deploys.

## Recommended order

1. **Tests first (H-02).** No bytes, no behaviour, and nothing else should be
   built on a contract whose owner surface is untested. Run the V3 custody
   suites against V4 through a shared interface, add a factory rejection
   suite, and add forged-call tests for the six callbacks and
   `DominoSetup.unlockCallback`. *Done: the factory and forged-call suites
   came with H-02, and V4 inherits 46 custody tests through
   `contracts/test/shared/CustodyBehaviour.sol` as of 20 September.*
2. **Buy the room (V1, F1, F11, V4, V5, V6, V8).** All zero-behaviour, and
   two are already measured at −234 B together. Measure V1 first: it is the
   smallest patch with the largest zero-risk estimate, and it tests the
   inliner assumption that V5 and V6 also rest on. If the vault does not
   shrink by at least 150 B, the model is wrong and the rest must be
   re-derived.
3. **Then the hardening that needs those bytes (D-01, D-02),** with D-03 and
   D-04 answered in the same change, since requiring an anchor everywhere
   makes the publisher a liveness dependency.
4. **Gas separately (F2, F7),** in the engine and routing helper, which have
   room; each with a `forge snapshot` before and after.
5. **Hygiene as it is touched (H-01, M-03 … M-10),** starting with the two
   false records above, and taking the V3/V4 duplication decision: extract a
   shared base, or retire V3 — the release order names no V3 artifact.
   *This report never enumerated M-03 … M-10 and they are lost. Fifteen minor
   findings re-derived from the code, numbered into that range, are in
   [CONTRACT_HYGIENE_MINOR_2026-09-19](CONTRACT_HYGIENE_MINOR_2026-09-19.md);
   they are not the originals. H-01 and H-02 are closed
   ([CONTRACT_HYGIENE_2026-09-19](CONTRACT_HYGIENE_2026-09-19.md)), and as of
   20 September so is every item in the minor report - see its status section.
   The V3/V4 decision was taken the same day: V3 is retired. Its factory
   and architecture suites were ported to V4 first (35 tests), its custody
   suite already ran against V4 through the shared base, and the twelve
   V3-only tests went with it.*

## What was verified sound

The hardening reviewer listed twenty-four properties it checked and found
correct, with citations. The ones worth naming: the fee-accounting
conservation in `executionApply` reconciles exactly on both the netted and
non-netted branches; the cumulative service-fee rounding cannot be split
across partial applies, because the transient slot is namespaced by
`stateNonce`; the calldata the vault forwards cannot diverge from what the
engine decoded; the currency-delta slot derivation matches v4-core; the
action bytes match the vendored `Actions` library; the `_after` checkpoint
equalities close the hidden-fee gap on non-root destinations; `_allocate`'s
two passes settle the manager's debt exactly; replay and version binding pin
seven fields; and the clone factory's one-shot implementation, CREATE2
rollback and independent EIP-1167 hash recomputation all hold.

Absence of findings in those areas is evidence, not silence.

## Not covered

- **The hardening pass did not reach the V3 lineage** (`DominoVault.sol`,
  `DominoVaultFactory.sol`, `DominoCompoundEngine.sol`) or the full
  `IDominoVaultDraft`. V3 is not in the release order, but it is deployed
  code paths' twin and shares 601 lines, so its own hardening pass is still
  owed.
- **No finding was reproduced by execution.** D-01 and D-02's exploitability
  needs a forked-pool test that manipulates spot around a compound and
  measures the value delta; D-09's overflow threshold is an arithmetic
  estimate; the gas figures need snapshots. Nothing here asserts a measured
  exploit. *Since written: D-01 and D-02 were reproduced on a fork of the
  real `weth-usdg` pool on 20 September -
  [EXECUTION_FORK_SANDWICH_2026-09-20](EXECUTION_FORK_SANDWICH_2026-09-20.md).
  The anchor refuses every post-observation move at or beyond the impact
  limit, the ceiling is the deciding clause on a wide range, and the
  pre-observation sandwich is real but costs the attacker dollars to extract
  cents. D-09's threshold and the gas snapshots are still estimates.*
- **`api-contracts/`** — the wire packages are a different thing from these
  contracts and were not part of this review.
