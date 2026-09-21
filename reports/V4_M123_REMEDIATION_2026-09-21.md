# V4 M-1 / M-2 / M-3 remediation candidate

This is a new, predeployment candidate following the owner's authorization to
implement the three medium findings from the second independent audit. The
original `v4-audit-2026-09-21` tag at
`255fc38b6eb62d630c8354a8dcec870f3c9dee39` remains unchanged. This candidate must
not be represented as that frozen or independently audited release.

## M-1: fee payment after the PoolManager unlock

The vault accumulates each currency's service fee in per-execution transient
storage. It pays the totals only after the engine returns from the PoolManager
unlock. Reentrancy protection and exact financial-receipt checks remain active
during payment. Slots are cleared before the external payment, and a payment
failure reverts the entire execution, including swaps, liquidity changes and any
earlier fee payment.

The engine's physical swap-input balance check now expects only `amountIn` to
leave the vault while unlocked. The accounting debit still includes the service
fee, which remains physically in the vault until the deferred payment. Pending
fees never become a spendable ledger allocation.

Native-currency tests use a contract recipient that accepts payment only after
the manager has locked, all deltas have settled and the committed liquidity has
been added. They compare exact economics with an EOA recipient, verify refusal
and non-exact receipts revert, and compare successive payments with the emitted
fee accounting in a single transaction. An ERC20 fixture checks the payment
boundary and one aggregate transfer per currency. These are regression tests of
the repaired boundary, not a claim that an economic exploit was demonstrated
against the old candidate.

## M-2: every swap output must fund the same execution

The actual output of every internal swap is added to the matching source and
output-currency budget's `minCharged`, as well as its existing `maxCharged`.
Existing minimum allocations are preserved. The allocator consumes mandatory
floors before optional budgets, and the final zero-floor check requires all new
output to have funded that action's liquidity addition.

This applies to original-funded, charged-funded and mixed swaps. Adding a small
original amount cannot exempt an otherwise charged swap. A different source
cannot satisfy the output's floor. No arbitrary percentage or raw-token dust
allowance is introduced. An oversized conversion must be reduced or re-quoted;
direct reinvestment or waiting remains available when a feasible conversion is
not established. Existing charged reserves remain consumable without another
service fee.

The planner rejects quotes whose known expected output exceeds the addition in
that currency, including when expected output plus already mandatory old-lot
allocations would exceed the addition. Original-lot allocations are evaluated
net of the selected mode's fee; charged lots are not charged again, and optional
collection caps are not mistaken for floors. The quoted minimum is not treated
as actual output. This is an early eligibility filter; fresh simulation and
on-chain execution still enforce actual output, source allocation, prices and
all other limits. Full consumption alone does not establish profitability; the
owner-benefit policy still applies.

The ABI is unchanged, but execution acceptance is intentionally stricter: plans
that leave newly converted output waiting are now refused. Backend/EVM fixtures
have been adapted to that behavior. A test-only derived vault seeds backed
pre-existing charged balances for the legacy-lineage regression; no seed method
was added to the production vault.

## M-3: committed, independently reproduced artifact identity

`scripts/release-artifact-manifest.mjs` recompiles the production import closure
using the pinned compiler wrapper and compares all seven Foundry artifacts with
that independent output. It records source/build-input hashes, compiler settings,
creation/runtime identity, ABI identity and normalized immutable byte ranges in
`contracts/release-artifacts.json`.

Bytecode comparison is exact. ABI comparison ignores only top-level entry order;
argument/tuple order and duplicate entries remain bound. Immutable normalization
ignores compiler AST identifiers, never byte offsets. Empty remapping contexts
are normalized to Foundry's equivalent spelling; nonempty contexts and the
remaining compiler settings remain exact.

Preparation and verification require that manifest and every source/build input
to match the same Git commit. The manifest cannot be replaced locally or merely
staged to bless a changed artifact; committing the manifest alone while leaving
an input dirty also fails. Artifact objects are sealed after authentication, and
direct API calls require the authenticated object and its matching source commit.
Both unsigned and verified records carry the manifest SHA-256.

The trust boundary is the selected Git revision and pinned build environment.
The manifest is not its own independent approval and does not defend against
replacement of that trusted revision or toolchain. CI independently reproduces
it with `--check`; there is no silent legacy/untrusted-manifest bypass.

## Approved policy and deployment status

- Simple automation remains 200 bps; Domino remains 400 bps, charged once on
  consumed original earned fees. Internal automation swaps have no extra fee.
- Assisted Setup swaps remain capped at the approved 65 bps; tariff version 1.
- The selected publication band remains 50 sqrt-price bps.
- No deployed contract was upgraded, no signing key was used and no mainnet
  transaction was sent for this remediation.
- The previous unsigned proposal describes the previous code. Regenerate it for
  the validated new candidate; do not reuse its initcode or call it audited code.
- Current nonce, balances, gas, fork rehearsal and independent review of this
  diff remain separate from local correctness checks. Price-source and live
  publisher/executor qualification remain activation prerequisites.

## Validation

Validation is being completed on Node 24 with the existing compiler settings and
unchanged size-reserve requirements. The accompanying candidate evidence will
record the completed runs and any remaining limitation before delivery.
