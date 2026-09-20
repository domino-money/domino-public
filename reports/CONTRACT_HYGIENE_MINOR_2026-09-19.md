# Minor contract hygiene: M-03 onward, re-derived — 19 September 2026

[CONTRACT_REVIEW_2026-09-19](CONTRACT_REVIEW_2026-09-19.md) refers once, at line 232, to minor
hygiene findings "M-03 … M-10" and never enumerates them. They exist nowhere — not in that
report, not in any other file. **These are not those findings.** They cannot be recovered; what
follows is a fresh derivation from the code, numbered into the same range so the reference in
the review resolves to something. The original numbering implied eight items. Fifteen are
listed here, which is itself evidence that the range was never a complete count.

M-01 and M-02 are inferred to have been the two false records in the review's §7, since the
recommended order says the hygiene step starts with them. Both are fixed
([CONTRACT_HYGIENE_2026-09-19](CONTRACT_HYGIENE_2026-09-19.md)).

## How these were derived

Five lenses over `contracts/`, then one adversarial refuter per candidate, instructed to throw
the finding out by default. Thirty-four candidates, sixteen refuted, fifteen distinct survivors
after merging three reports of the same subject. Mutations ran in a disposable copy of the
repository, never in the tree; every agent returned `git status --porcelain` against the real
tree as part of its report, and all came back clean.

Two process notes, recorded because they bear on how much weight these carry. An earlier run of
the same work left a mutated security guard in the working tree — `recoverUntrackedCurrency`'s
insolvency arm, deleted to probe coverage and not restored — and it reached a full 2004-test
backend run before it was caught. That is why the sandbox rule above exists. And the shared
sandbox was contended: two agents reported finding another agent's mutation in it mid-run, so
any single mutation claim below should be re-run before it is relied on. The ones attributed to
me were re-run by me.

## Dead or unreachable in production source

**M-03 — `execute()`'s `_T_MODIFY` operand is dead.**
`contracts/src/DominoVaultV4.sol:286` reads `if (_tget(_T_MODIFY) != 0 || !rootPermissionValid())`.
The first operand can never be true: `executionModify` already reverts at `:318` if the flag
survives its own periphery call. The line looks like the vault's one post-condition on the
engine's callback discipline; only the `rootPermissionValid()` half does anything.

**M-04 — `readInitialPosition` re-tests a tick spacing that `readPosition` already rejected.**
`contracts/src/DominoVaultReadHelper.sol:106` lists `key.tickSpacing <= 0` as an `InvalidIdentity`
cause, one line after `readPosition` (`:105`) has already reverted `InvalidPosition` for it. The
function advertises an error it cannot produce for that input.

**M-05 — two expiry-ordering operands are unreachable-true.**
`contracts/src/DominoVaultReadHelper.sol:171` and `contracts/src/DominoPriceGuardV4.sol:57`. Each
reads as the invariant "an expiry must follow its stamp" and each is implied by an operand
earlier in the same `||` chain. A reviewer looking for that invariant finds it stated and not
enforced.

**M-06 — two more dead clauses in the price guard.**
`publish`'s `|| revoked[id]` (`DominoPriceGuardV4.sol:65`) is subsumed by the disjunct beside it,
so it can never be the clause that fires — while `revoke` itself has no once-only guard, which
is the question a reader goes to that line to answer. `_withinBand`'s `value == 0` arm (`:47`)
is unreachable from its only call site.

**M-07 — `GENERAL` and `FUND` are declared and never read.**
`contracts/src/DominoExecutionTypes.sol:11` and `:13`. `V4_EXECUTION.md:43` documents a
four-value action vocabulary; only `E.NET` and `E.MINT` are ever named in code. The other two
branches are selected by numeric ordering and by elimination, so a reader tracing an action
cannot grep for its name.

**M-08 — `IDominoVaultDraft.FeesApplied` is emitted by nothing.**
`contracts/src/IDominoVaultDraft.sol:48-60`. A thirteen-line event declaration on the file the
repository presents as its integration boundary, produced by no implementation and no harness.
The engine's real receipt is the near-namesake `SourceFeesApplied`, so the collision misleads
rather than merely wastes space.

**M-19 — four clauses in `DominoPriceGuardV4.publish` cannot be the one that
decides.** `contracts/src/DominoPriceGuardV4.sol:54-58`. Found by mutating each clause against
the guard's new suite: fifteen of nineteen clauses across `publish`, `revoke` and
`referencePrice` fail a test when deleted; these four do not, because each is subsumed by a
neighbour. `poolId == bytes32(0)` and `sqrtPriceX96 == 0` are outside any band, so `_withinBand`
refuses them first — *both became redundant when the deviation band was added in `28eeaa9`
(D-03/D-04); before that they were load-bearing. Mine.* `blockNumber >= block.number` is implied
by the hash comparison, since `blockhash` answers zero for the current block and a zero hash is
refused just above. `expiresAt <= timestamp` could only decide for a stamp in the future, which
the clause before it already refuses. Recorded rather than removed, and named in
`contracts/test/DominoPriceGuardV4.t.sol` so nobody has to prove it again.

**M-20 — two more clauses that can never decide.** `contracts/src/DominoVaultV4.sol:510` and
`contracts/src/DominoSetup.sol:143`. `_tget(_T_ENTERED) != 1` is unreachable as a sole decider
because `_T_TRANSITION` is set only inside `nonReentrant` functions, so the two are true together
or false together. `_callback == bytes32(0)` is unreachable because a zero callback also fails
the payload comparison beside it. Both are pinned as redundancies in their suites.

## Documentation the code contradicts

**M-09 — `V4_EXECUTION.md` documents the price guard's pre-hardening constructor.**
`contracts/V4_EXECUTION.md:16` shows `DominoPriceGuardV4(pricePublisher)`. The artifact takes
three arguments; the two the prose drops — the `stateView` it anchors against and the deviation
band — are exactly what make the guard a guard. `docs/FINANCIAL_RELEASE.md:16-30`'s input table
is missing the third as well. *Mine: introduced by `28eeaa9`, the D-03/D-04 hardening, which
changed that constructor and left both documents behind.*

**M-10 — `MAX_OBSERVATION_BLOCKS` says 256 and admits 255.**
`contracts/src/DominoPriceGuardV4.sol:18`, enforced at `:58` and `:82` as
`blockNumber + MAX <= block.number`. The oldest observation accepted is 255 blocks old, one
short of what `blockhash` still resolves. The constant is `public` and its NatSpec says its
purpose is to make the real lifetime explicit; it overstates it by one block. Conservative, so
not a safety issue — and *not* fixed by widening the comparison, which would be a behaviour
change to a hardening guard rather than hygiene. *Mine, same commit.*

**M-11 — the price guard's contract NatSpec attaches to the wrong declaration.**
`contracts/src/DominoPriceGuardV4.sol:4-12`. The block sits above `IStateViewGuard`, so solc's
`devdoc`/`userdoc` attribute the guard's whole trust model to a helper interface that declares
only `getSlot0`, and `DominoPriceGuardV4` documents as having none.

## Tests that assert less than their names promise

All six share one shape: a multi-clause `||` guard reached only through its first true clause,
under a name or doc comment claiming the later clauses. Five of the six are tests I wrote on
19 September while closing H-02, which makes the shape a defect in how I wrote them rather than
six coincidences: writing the test straight after reading the guard, I ordered the negative
cases the way the clauses appear and let short-circuiting collapse them.

**M-12 — `testUnlockCallbackRefusesEveryForgedEntry` pins none of the four clauses it counts.**
`contracts/test/setup/DominoSetup.t.sol:105`. All three cases stop at `msg.sender != manager` or
`!_entered`; each of the four clauses can be deleted individually with the suite green. The
uncovered pair is the payload-to-plan binding — the only thing stopping a different swap or mint
plan executing inside a legitimate unlock. *Mine.*

**M-13 — `testExecutionCallbacksRefuseThePinnedAddressAtDifferentCode` cannot reach the clause
its doc names.** `contracts/test/DominoVaultV4Custody.t.sol:354`. The comment records coverage as
measured fact, in the suite whose own report stakes its credibility on "coverage is asserted by
mutation, not by counting tests". *Mine, and the comment is the worse half.*

**M-14 — `testNotifySubscribeRefusesTheRightCallerWithTheWrongPayload` never reaches the payload
clause.** `contracts/test/DominoVaultV4Custody.t.sol:386`. Both calls are decided by
`_T_TRANSITION == 0`, two clauses earlier; the second even supplies the correct payload. *Mine.*

**M-15 — `testFinalizeImplementationIsDeployerOnlyOneShotAndIdentityChecked` exercises one of
seven identity checks.** `contracts/test/DominoVaultFactoryV4.t.sol:90`. Verified by deleting six
of the seven: both suites stay green. The realistic mis-wiring — a candidate naming the right
factory but a foreign position manager, state view or fee recipient — is uncovered. *Mine.*

**M-16 — the V4 factory's foreign-pool test covers one of two manager-agreement clauses.**
`contracts/test/DominoVaultFactoryV4.t.sol:58`. The state-view half
(`IStateViewE2(stateView_).poolManager() != poolManager_`) has no test; the V3 factory suite
covers both. *Mine, in the suite written to catch up with V3.*

**M-17 — `testOwnerCanExitChildrenAndFeesWhenEngineUnavailable` exits no fees.**
`contracts/test/reference/OfficialDominoExecutionV4.t.sol:367`. `withdrawFeeReserves` deliberately
carries no deployment-pin check so a stranded owner can still reach the reserve; that property is
pinned for V3 and unpinned for V4, the vault the release ships. Not mine — pre-existing.

## One that is coverage, not a defect

**M-18 — the price guard's read-time expiry check is unreachable in the whole test tree.**
`contracts/src/DominoPriceGuardV4.sol:81`. Every plan's deadline expires at the same instant as
its observation and the deadline is checked first, so `|| block.timestamp > point.expiresAt` can
be deleted with all 214 tests green. The guard is correct; nothing exercises it.

## One measurement that closes a compaction item

**V2 is not reachable through the compiler, and the source route is worth less
than it looks.** The review attributes 300-600 B to the Yul FunctionSpecializer
cloning `_register`, `_credit` and `_invalidateRoot` where they take literal
arguments. Compiling `DominoVaultV4` alone with the default step sequence minus
`F` gives 21,443 B against 23,625 B — **2,182 B**, four times the top of that
estimate and more than every other compaction item combined.

It cannot be taken. Building the whole tree with that sequence fails:

```
Yul exception: Variable cleaned_1 is 1 too deep in the stack
```

The default sequence is what keeps this project compilable — the review's own
opening notes the same class of stack error at
`DominoExecutionEngineV4.sol:183` — and `F` is part of it. So the 2,182 B is a
real measurement of what the pass costs and not an available saving.

That leaves the source route: contorting call sites so no literal reaches a
specialised function. With the vault now holding 638 B of slack and nothing
pending that needs them, worse code to outwit an optimiser pass is a bad
trade. Declined, with the number recorded so it is not re-derived.

## Status — 20 September 2026

Every finding above is closed, each in one of three ways: fixed, recorded as a redundancy the
tests now name, or - twice - fixed and then found to have been claimed rather than covered.
Mutations for this pass ran in a disposable copy of the last commit, never in the tree, with
one snapshot per batch; every verdict below is from that run.

| finding | disposition |
| --- | --- |
| M-03 | Dead as claimed: the `_T_MODIFY` operand is deletable with both the official execution suite and the custody suite green. Kept as a backstop and commented at the site - `executionModify` already reverts when the flag survives its own call, so the operand cannot fire unless that tail check moves. |
| M-04 | Removed. `readPosition` refuses a non-positive tick spacing first and has to, since it divides by it, so nothing can make the duplicate live again. Verified deletable against `DominoCompoundHelper.t.sol` before removal. |
| M-05 | Read-helper half removed on the same reasoning: `deadline >= observedAtTimestamp` follows from the two bounds on `block.timestamp` beside it, and the comment now says so at the subtraction that relies on it. Price-guard half recorded, below. |
| M-06 | Both recorded in the guard suite's redundancy list; neither can decide, and the suite says which clause does. |
| M-07 | The routing helper names `E.GENERAL` where it selected by range, and the two branches that handle `E.FUND` by elimination say so; the declaration points at them. The routing helper's bytecode moved with that rewrite; the vault's and the engine's did not. |
| M-08 | `FeesApplied` removed. Nothing in the repository emitted, decoded or documented it; the vaults do not inherit the interface, so no vault ABI moved and the drift script's counts are unchanged. |
| M-09 | Both documents corrected: `V4_EXECUTION.md` shows the three-argument constructor, and `FINANCIAL_RELEASE.md`'s input table has the `priceGuardDeviationBps` row the release script already required. |
| M-10 | The NatSpec now states the constant as the exclusive bound it is - admitted while strictly under 256 blocks old, so 255 at most. The comparison is untouched. |
| M-11 | The guard's NatSpec moved from `IStateViewGuard` to the contract; the interface has a one-line `@dev` of its own. |
| M-18 | Closed by the guard suite: `referencePrice`'s expiry clause fails a test when deleted. |
| M-19, M-20 | Unchanged: recorded, not removed. |

### The price guard, clause by clause

Every clause of the constructor, `_withinBand`, `publish`, `revoke` and `referencePrice` was
deleted in turn against `DominoPriceGuardV4.t.sol` - 33 mutations. Before this pass 21 failed
a test and 12 did not. Three of the twelve were gaps, not redundancies, and each has a test now:

- `revoke` refusing an id that was never published - without it the publisher could pre-revoke
  an observation and have its later, honest publication refused as already revoked;
- `referencePrice` re-checking `blockhash` at read time - the only clause that refuses a stored
  observation the chain has since reorganised away;
- `referencePrice` enforcing the block window on the way out - an observation admitted at 255
  blocks old is refused one block later, while its hash still resolves.

The other nine are redundancies, named in the suite beside the clause that decides instead. The
suite's comment used to say "fifteen of nineteen"; it counted differently, and the enumeration
replaces it.

*Re-run on 20 September after the guard gained publisher rotation (D-03's other half: an
immutable guardian proposes, the proposed key accepts, and the guardian may revoke): 39
mutations, 30 fail a test, the same nine survive. Every rotation clause - the two constructor
checks on the guardian, guardian-only proposal, no proposal of nobody or of the incumbent,
acceptance by the proposed key only, the pending slot cleared, and both arms of revoke - is
pinned by the four tests added with it.*

### Found on the way

**M-21 - my new V4 test claimed a clause it could not reach.**
`testERC20TransferFeeIsAbsorbedByTheOwnerWhileTheLedgerStaysBacked` asserted that `_payExact`'s
vault-side debit stayed exact, and did not: `MockERC20`'s fee comes off the recipient, so
`beforeVault - afterVault != amount` could never fire. The same shape as M-12 … M-17, in a test
written the night that shape was documented. Found by mutation against the ported suite;
`MockERC20` gained a sender-surcharge mode, and the clause now fails a test in both lineages.
*Mine.*

**M-22 - `resume()`'s permission check was covered by nothing in the tree.**
`if (!rootPermissionValid()) revert PermissionUnavailable()` was deletable from either vault
with every suite green. It is the one owner action that re-arms automation, so it is the one
that must refuse while the root permission is gone. A shared test pins that resume refuses and
pause does not. Pre-existing.

### The V3→V4 port, as it stands

`contracts/test/shared/CustodyBehaviour.sol` holds 47 tests both vaults inherit. V4's custody
suite went from 16 tests to 67; V3's from 55 to 59. Twelve V3 tests stay in their leaf: five
are adoption, which V4 does not have; three turn on `validateAuthority`, V3's pre-execution
entry point; three pin behaviour the lineages differ on by design (V4 declares no receiver
hook, and requires the recipient-side receipt of the financial path only); one enumerates V3's
owner-only surface. V4 acquires children through the real `executionMint` path in its suite -
a stub engine mints on `execute()` and the mock position manager answers `MINT_POSITION` - so
the thirteen child-custody tests exercise the code the release ships rather than a sink.

Those thirteen were mutated against before they were trusted. Of nine clauses on V4's child
paths - `withdrawChildPosition`'s guard and its `activePositions` decrement,
`recoverUnmanagedPosition`'s two refusals, `executionMint`'s successor rule and its two
post-mint checks on the manager, and `notifyUnsubscribe`'s refusal during an execution - only
two failed a test; the port's happy paths reached the rest. Two tests now pin seven of them: a
shared one for the managed child exit refusing the root, a withdrawn child and an unknown
token, and for recovery refusing a token the vault does not hold; and a V4 one for a second
successor of the same parent, and for a manager that minted to someone else or minted nothing
(the mock can now do both). Re-run, all seven fail a test, in V3 as well where the clause
exists. The ninth is recorded rather than pinned: `notifyUnsubscribe` refusing while
`_T_COMPOUND` is set cannot be told apart from outside, because the execution then fails its
own permission check and the frame reverts either way.

### V3 retired — 20 September 2026

The extract-or-retire decision came out as retire, once two facts were on the table: the release
order names no V3 artifact, and `docs/PUBLIC_VAULT_E2.md` records V3 as never publicly activated.
What V4 does not do that V3 did is one thing, `adoptChild` - bringing an NFT the owner already
holds into the vault as a child; V4 acquires children only by minting successors - plus the
`validateAuthority` pre-flight, whose decision the routing helper makes instead.

Removed: `DominoVault.sol`, `DominoVaultFactory.sol`, `DominoCompoundEngine.sol`; the read
helper's `compoundCall`, which only V3 called; the draft interface's `CompoundSelfPlan` and
`compoundSelf`, which nothing implemented any more; the five V3 test suites; the ABI drift
script, whose subject was two vaults; the V3 entries and reserves of the size gate; and the
backend's on-EVM tests of V3 itself - the V3 compound receipt tests and the two performance
suites (`test_performance_financial_collection_evm.py`, `test_performance_history_worker_evm.py`)
that drove V3 `compoundSelf` receipts through the V3 collection branches, five tests in all.

Two things in the backend were not V3 tests and stayed. The module that held the V3 receipt
tests was also every other EVM test's Anvil harness; it is now `backend/tests/evm_harness.py`,
with the harness and nothing else. And `test_execution_runner_evm.py` - eighteen tests of the
durable executor's crash points, nonces, reorgs, signer identity and backup/restore - ran on the
V3 vault only as a fixture; the runner, signer, store and journal it exercises are the ones V4
uses. It was ported onto the V4 executor suite's fixture before V3 was removed, scenarios
unchanged.

Kept, on purpose, and worth knowing: the backend still carries V3 branches - receipt decoding
for `compoundSelf`, and the V3 performance readers in `performance_collection.py`,
`performance_financial_collection.py` and `performance_history_worker.py`. Those modules are
pinned by SHA-256 in `api-contracts/performance-v1` and `performance-v2`, so removing the
branches is a read-contract change with manifests to regenerate and app pins to move, not a
deletion; it is the natural next step and is not this one. Their fixture-based unit tests stay;
the on-EVM tests of those branches went, because their subject no longer compiles.

Before deletion, nothing pinned by the V3 suites was left unpinned for V4: the factory suite's
thirty tests were ported as `DominoVaultFactoryV4Creation.t.sol` (28; the two constructor tests
the V4 factory suite already had are not repeated), and the architecture suite's seven as
`DominoVaultV4Architecture.t.sol`, both green on first compile - the two factories differ only
in how the implementation is bound, and the helper pin is the same contract.
