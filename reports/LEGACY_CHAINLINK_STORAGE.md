# Legacy Chainlink storage — issue #60

`qualify_chainlink.py --store-observations` now writes only after both currency
bundles pass full reference validation. Previously a failed reference check left
`history` in the report, and its presence alone allowed storage. Rechecking only
the pool snapshot did not protect publication or predecessor evidence.

## Commit conditions

Each bundle must match discovery's exact snapshot, requested interval and currency.
`reference_series` validates the source identity, proxy configuration, round values,
publication/predecessor proofs, end boundary and complete reference coverage before
it supplies a storage guard. The guard captures the verified bundle digest and
headers; it never adopts a replacement hash from a later request. A successor of
the end boundary is included when the requested end precedes the snapshot.

The two currency bundles share one locked PostgreSQL transaction. After inserts
and conflict checks, immediately before commit, both guards check chain ID and
every captured header, repeat the snapshot check, and confirm the original bundle
digest before and after the reads. A failure rolls back the whole batch, including
earlier inserts and revisions. An entirely idempotent retry still runs the guards.
Existing conflicting prices or provenance continue to require review.

The report retains the original failed probe's `reason` and diagnostic history.
Its new `storage` object distinguishes `not_requested`, `blocked`, `saved` and
`failed`, with the relevant reason. `observationsSaved` becomes true for both
currencies only after successful database commit. A requested save that is blocked
or fails returns a nonzero CLI exit status, even if reference validation had
initially succeeded. Reference-only invocation performs no database write.

The private bundle and guard remain paired separately from the report projection.
The guard binds the same observations passed to storage. Neither callbacks nor
RPC clients/URLs appear in the JSON report. Final per-currency request counts and
elapsed times include commit validation and waiting for the other probe; preliminary
console lines describe acquisition/reference validation before that write.

## Budgets and compatibility

The original limits remain 64 rounds per currency, 1,600 requests per currency and
a 480-second cooperative transport budget including reference/commit validation.
The guard reuses that budget; it does not restart a deadline. A general 64-round
bundle has at most 131 distinct evidence headers, so its guard needs at most 133
requests including chain ID and the final repeated snapshot. The CLI's end is
the snapshot itself, reducing that upper bound. No round/configuration ABI proof
is repeated inside the writer lock: those calls were pinned to the captured hashes.

The global writer lock is held during these bounded RPC reads. Other catalogue
writers can return `catalogue_writer_busy` until the transaction exits. Slow or
unavailable providers can exhaust the remaining budget; that is a failed save,
not permission to relax validation. A cooperative timeout is not cancellation of
an already blocked transport call.

The optional `store_observations(..., before_commit=...)` callback has the same
interface and placement as #52. This fix does not change its sliced-collection
recovery behavior, migrate schemas, qualify any production source or enable a
public API. Existing callers without a guard keep their existing behavior; this
issue specifically repairs the legacy qualification CLI.

## Evidence and recovery for previously stored rows

Existing rows are not deleted, overwritten or retroactively marked verified.
The historical committed reports record 17 WETH and 2 USDG observations in the
complete run and a USDG-only save when an earlier ETH probe exhausted its budget.
Those artifacts describe the old implementation. They do not prove that today's
database contains orphaned rows, and this correction did not access that database
or revalidate those reports against a live provider.

For an explicitly authorized review of legacy storage:

1. Preserve the original schema version 1 qualification report and its file SHA-256,
   including pool identity, snapshot, interval, each complete `history` bundle,
   reference digest, failure reason and `observationsSaved` claim. Preserve a
   separate read-only export/backup of the exact affected database rows and its
   own digest. These are different artifacts.
2. Match database rows by chain, currency, source and timestamp; compare exact
   price/provenance. Keep the stored `retrievedAt` in the database export: an
   idempotent retry intentionally retains the earlier retrieval time, so a new
   report digest is not a byte-for-byte database dump digest.
3. Revalidate the original bundle with the implemented
   `chainlink_reference.reference_series(bundle, pool_id, rpc, pool_key=...)` on
   an authorized historical RPC, without invoking storage. Record which header
   or proof failed. An RPC error means unknown availability; it is not evidence
   of an orphan. Rows alone omit the bundle's snapshot/window/end boundary and
   cannot reconstruct complete reference validation if the report is missing.
4. Preserve suspect rows and evidence for an explicit repair review. #52's
   `price_quarantine.py` accepts a reviewed sliced-collection checkpoint, not this
   legacy report. Do not relabel a legacy report as a collection or invent missing
   slice metadata. Deleting legacy rows needs a separately reviewed exact-row
   repair plan with verified backup, expected digests, writer-lock revalidation
   and rollback evidence. No legacy deletion command is supplied by this fix.

If the original report is missing, mark the evidence incomplete and retain the
rows/backup until a reviewed recovery can establish the missing provenance.
Changing retrieval times, replacing publication hashes or silently overwriting a
conflict cannot make old evidence current. Running the fixed CLI creates a new
observation attempt; it is not an automatic legacy repair.

The database commit precedes output-file creation. A later filesystem failure
does not undo a successful database commit; inspect stored rows before deciding
whether a retry is needed. Such a retry remains idempotent and revalidated.

## Validation

Regression tests exercise the real reference validator and PostgreSQL store with
synthetic archive/discovery responses. They cover failure after fetch, atomic
header changes, RPC/source/integrity errors, unchanged existing rows/revisions,
idempotent retries and the full report/CLI result. No live provider, wallet,
production qualification or legacy cleanup is used.

The combined suite passed 401 backend tests with PostgreSQL/native EVM, including
16 legacy-storage regressions, with zero skips. The normal contract command passed
29 Solidity tests (seven fuzz cases at 512 iterations) and three launcher tests.
Repository hygiene passed 367 files with zero findings. Independent review reran
14 of the real-PG regressions and 54 existing Chainlink tests, then ran eight
additional offline guard experiments; these overlapping counts are not additive.
