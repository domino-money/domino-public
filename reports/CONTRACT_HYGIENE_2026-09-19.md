# Contract hygiene: H-01 and H-02 closed, with corrections — 19 September 2026

Addendum to [CONTRACT_REVIEW_2026-09-19](CONTRACT_REVIEW_2026-09-19.md), which put
this work first: "no bytes, no behaviour change, and it closes the gap that let
the divergence happen unnoticed."

## What made H-02 urgent was worse than the review said

The review says five of the six `execution*` callbacks have no forged-call
test. Measured: replacing the **entire body** of `_requireExecution` with `{ }`
left every V4 suite passing — 18 tests in
`test/reference/OfficialDominoExecutionV4.t.sol` and 8 in
`test/DominoCompoundGuards.t.sol`. All six were unguarded by the suite, and the
single guard standing between an arbitrary caller and `executionCredit` — the
fee-credit sink — had no negative test at all.

`DominoVaultFactoryV4` had one happy-path call against thirty tests for the V3
factory it replaces, and `DominoSetup.unlockCallback` had no reference in any
suite.

## What now covers it

`test/DominoVaultV4Custody.t.sol` (15) stands the real V4 stack on the light E2
mocks with a real read helper and a stub engine; `test/DominoVaultFactoryV4.t.sol`
(5) covers the factory's refusals; one test was added to
`test/setup/DominoSetup.t.sol`. The contract suites run 211 tests.

The guard mutation above now fails two of the new tests. Coverage is asserted by
mutation, not by counting tests.

Deliberately not covered, and why: the `_T_COMPOUND` clear in `DominoVaultV4`
has no test. Removing it leaves all 211 passing. Its only same-transaction
consequence is that `_payExact` tightens the recipient-side receipt, which needs
a recipient whose balance does not move exactly, and no suite has one.

## Corrections to the review's own figures

- **"601 identical lines and 27 divergences" does not reproduce.** Measured on
  whitespace-normalised lines at `5544199`: 550 shared (469 of them significant),
  46 divergent blocks, across 720 V3 lines and 760 V4 lines. Other counting
  methods give other numbers; the figure to quote is the ABI one below, which is
  method-independent.
- **The ABI divergence is 96 shared members, 12 V3-only and 13 V4-only**, now
  enumerated with a reason each in `scripts/check-vault-abi-drift.mjs`.
- **The review's one concrete example was right and is now fixed.**
  `StaleAuthority` and `CompoundSelfCompleted` were declared and unused in V4;
  `28eeaa9` removed them. They remain in V3, which uses both. A reader measuring
  the current tree will not find the example the review describes.
- **`rearmRoot` is touched once** by the V4 suite, not zero times as the list
  implies. Every other function the review names had no V4 caller at all.

## A defect the review did not find, in V3

`DominoVault.sol:689-692` demands an exact recipient-side credit on the owner's
own exits, unconditionally. `DominoVaultV4.sol:721-728` requires it only inside
an execution, with a written rationale. The V4 behaviour is the correct one: on
V3, any pair currency that does not credit exactly — fee-on-transfer, rebasing,
a recipient that forwards inside a hook — makes `withdrawFeeReserves` and
`recoverUntrackedCurrency` revert for good, stranding the reserve with no
partial exit to fall back on.

V3 is not in the release order, so this is recorded rather than fixed. It should
not be fixed by a mechanical port: V3 has no `_compoundActive`, and the
equivalent gate there is its `_compoundStage` machine.

## The divergence the hygiene work surfaced, which is a hardening question

V3 has `_compoundStage` (`DominoVault.sol:82, :262, :267, :280-286`), a counter
that forces the callback order collect → increase → apply → checkpoint and is
pinned by `DominoCompoundGuards.t.sol:204`. **V4 has no equivalent** — zero
occurrences. `_requireExecution` checks who is calling and when, never in what
order. V4 constrains the same thing differently, through the accounting
identities in `executionApply` and the `_expectedModify` pair, but the ordering
property V3 states and tests is not stated anywhere in V4.

That is a decision, not a cleanup, and it is not taken here.

## The architecture question: extract a base, or retire V3

**A shared base costs nothing in bytes.** Slicing V4 along the shared boundary
into an abstract base plus a leaf — with two `virtual` hooks and the shared
region widened from `private` to `internal` — compiles to *byte-identical*
deployed bytecode, same sha256, because solc devirtualises a hook with one
override and the IR pipeline flattens the rest. The byte objection to extraction
does not exist.

**V3 is deployable but the release names none of it.**
`scripts/prepare-financial-release.mjs:19-21` enumerates seven components, all
V4 or shared; `docs/FINANCIAL_RELEASE.md:66-74` fixes eight transactions and no
V3 artifact.

**Retiring V3 today would make things worse, not better.** Its 55 custody tests,
plus `DominoCompoundGuards` (8) and `DominoVaultArchitecture` (7), bind to the V3
type at compile time. Before this addendum they were the only coverage the
shipped custody surface had anywhere — and they test the wrong contract.
Deleting them now would take that surface from indirectly tested to untested.
The new V4 suites are the first instalment of the port that has to come first.

Recommended order, unchanged in spirit from the review: finish porting the V3
custody assertions that apply to V4 (32 of 55 port unchanged, 20 need edits, 3
are V3-only), then take the extract-or-retire decision with the port already
done, so neither option loses coverage.

## The drift check

`scripts/check-vault-abi-drift.mjs` refuses any divergence between the two ABIs
that is not written down with a reason, and runs wherever the size gate runs, at
zero contract bytes. It catches a member added to one side, a signature change
on one side, a mutability change on one side, and a declared divergence that no
longer exists — so the list cannot rot. It does not catch two bodies drifting
behind an unchanged signature.

Hashing the shared text was prototyped and rejected: renaming one local variable
in V4 changed the hash, because the shared region is defined by the diff. A check
that fires on a rename gets re-baselined reflexively and is then worth nothing.
