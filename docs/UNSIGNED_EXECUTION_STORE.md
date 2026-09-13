# Unsigned execution store — partial E5

12 September 2026 · issue #89 · stacked on E1 hardening #99

Migration 015 remains the unsigned foundation described below. The explicit
migration 019 and concrete signer, runner, recovery and read-only status gateway
are documented in [DURABLE_EXECUTOR.md](DURABLE_EXECUTOR.md).

This is an internal, non-signing storage foundation. It has no listener, HTTP
endpoint, frontend change, wallet session integration, RPC client, signer,
transaction bytes, broadcast method or service activation. `executionEligible`
is always false. It does not complete E5 or satisfy signed-attempt recovery,
canonical receipt reconciliation or EX-06/EX-07 financial release evidence.

## What is persisted

`backend/migrations/015_unsigned_execution.sql` creates `domino_execution`,
independent of catalogue, session and deposit schemas and their nonce streams.
All seven tables force row-level security. The schema owner, execution worker
and ledger roles have no superuser, RLS bypass, role creation, database creation,
replication or inherited-role privilege. No function is SECURITY DEFINER.
The migration creates NOLOGIN roles; operator-managed authentication and any
service installation remain separate work. It rejects existing privileged or
inheriting roles with these names. It is applied once by the schema migration
operator, not by the runtime store or existing dev/migration scripts.

The trusted internal caller supplies an authenticated owner context. The store
sets that context transaction-locally and clears it with connection teardown.
RLS protects against accidental missing tenant filters; the role is a trusted
backend principal and can intentionally set another owner context. This is not
wallet authentication, process attestation or protection from a fully compromised
worker database credential. No browser accepts or selects this context.

- **Intents:** a rebuilt, validated E1 `ExecutionPlan` and `Observation`, model
  version, domain-bound `intent_id()`, sequence identity and immutable derived
  resource commitments. Persisting is idempotent by the financial intent ID and
  happens before work, reservations or a nonce claim. Different amounts, ranges,
  policies or observations require different plans. Leases and signer nonces
  do not change the financial hash. Neither typed consistency nor supplied
  canonical flags independently prove current custody or financial authority.
- **Origins:** stable fee credit or converted allocation ID, exact source/lot,
  amount, original source record and immutable supplied evidence. IDs remain
  after quarantine/cancellation; nothing can delete an origin, rename it, change
  its amount/class or re-enable a quarantined origin. Original receipt uniqueness
  is `(source, transactionHash, receipt-local eventIndex)`; converted uniqueness
  additionally binds output currency. Block hash is evidence, not a dedup key.
- **Claims:** exact lot amounts, exclusive collection source/checkpoint,
  exclusive successor identity and global chain/signer/nonce ownership. Claims
  cannot change their amounts/identities. Cancellation marks them inactive while
  preserving their history.

E1 cryptographic hashing and semantic reconstruction happen in Python. Immutable
SQL `commitments` carry the derived source/checkpoint mapping and successor ID;
SQL does not reimplement Keccak/ABI or authenticate a supplied observation.
Triggers bind claims to these commitments and the stored plan, enforce aggregate
lot availability under row locks, and refuse a `reserved` state missing any
required claim. Exact raw amounts use integer-valued numeric checks, avoiding
PostgreSQL scale coercion. An eventual restricted signer must independently
reconstruct these identities from approved code and current canonical evidence.

## Fee evidence and converted lineage

The separate `ExecutionLedgerStore` role can record matching, typed original
credits only when their supplied evidence says canonical and finalized. The
execution worker cannot insert credits or change their amounts. PostgreSQL row
locking requires UPDATE permission; the worker receives it solely on `state`,
whose trigger permits only quarantine. Neither role can re-enable an origin.
A conflicting repeat raises `execution_identity_conflict`; it never creates a
second fragment or silently replaces the old evidence. The trusted reconciler
must quarantine suspect evidence explicitly before further use. This slice
contains no live verifier or reorg reconciliation procedure.

Converted lineage records preserve every input allocation, with owner/source
foreign keys and exact amount checks. They are always **quarantined and cannot
be reserved**. E1 lineage IDs alone do not prove swap output, input consumption,
service cuts or receipt canonicality. Activating a converted balance requires
E4/E5 atomic reconciliation of the debits, realized output and attributed
residuals. There is deliberately no conversion activation method here. No 2%
fee is charged by this store; no principal, donation or treasury balance is
accepted as an original FeeCredit.

## Work ownership and lifecycle

The only states are `planned`, `reserved` and `cancelled`. There is no signed
state and no API that accepts signed attempts. A UUID identifies a worker; a
monotonically increasing database fence prevents an old worker from continuing
after recovery. Acquiring requires an absent/expired lease and increments the
fence exactly once. Renewing requires the same live worker/fence. SQL rejects
live-lease theft, expired renewal, fence reuse and leases longer than 300 seconds.
Database time drives these rules; a lease expiring never releases reservations.

The maximum lease is an operational storage bound, not a gas policy, financial
horizon or selected release setting. A successor claim derives from sequence
and parent, so changing the proposed range cannot mint a second reservation.
All resource reservations and the transition to `reserved` commit atomically.
Cancellation with a current fence releases every unsigned claim in one
transaction, retaining immutable history and final worker/fence evidence.
`reservations()` recovers all committed claims for a restarted process.

`reserve_nonce()` atomically claims an explicit candidate nonce under a global
unique index on `(4663, signer, nonce)` across owners. It does not query or
advance an RPC nonce, choose the next nonce or prove that a supplied nonce is
canonical/unspent. It refuses expired intents and quarantined reserved origins.
An eventual signer must freshly qualify that nonce along with current state and
all financial bounds. Safe pre-sign cancellation allows another intent to claim
the same nonce; history remains and no silent permanent nonce hole is created.
A future signing boundary must freeze this release path before any signing
attempt, including ambiguous signer replies. It cannot reuse this cancellation
logic after an uncertain signing/broadcast outcome.

## Verification and remaining work

Validated against the hardened E1 base (`7d169696`): **24 focused PostgreSQL
tests passed**, zero skipped; the complete backend suite with
`DOMINO_TEST_POSTGRES=1 DOMINO_TEST_EVM=1` passed **1,336 tests**, zero skipped.
Repository hygiene checked 1,099 files with zero findings; the diff check passed.
The full suite includes the existing ledger, migrations, reorg and local EVM
regressions as well as this private store. No production configuration is used.

Run the actual role/concurrency tests, without provider credentials:

```sh
DOMINO_TEST_POSTGRES=1 backend/.venv/bin/python -m unittest discover -s backend/tests -p test_execution_store.py -v
```

`execution_pg.py` creates its own short-lived PostgreSQL cluster on a private
Unix socket with no TCP listener. Only this fixture enables login for the three
test roles. Tests connect as the real nonsuperuser worker, ledger and table-owner
roles, including missing context, foreign owners, disabled RLS and alternate
role/schema attempts. Tests cover concurrent overspending, duplicate workers,
lease takeover/fencing, successor and checkpoint conflicts, concurrent owners
claiming one signer nonce, safe nonce reuse, permanent credit/converted
uniqueness, raw numeric rejection and crash rollback at persist/reserve/nonce/
cancellation boundaries. The child cluster is stopped and removed on completion.

Still required for full #89: independent typed transaction reconstruction,
registered signer isolation, actual signing, signed-byte/hash persistence before
broadcast, ambiguous outcomes, bounded replacements, E4 receipt reconciliation,
reorg/re-inclusion and backup/restore with unresolved signed attempts. Those
require #88 and its reviewed ABI/effect boundary. The ordinary deposit nonce
stream, schema draft and personal bot are not reused. No stored record or
passing fixture closes public execution, custody, token, market or route gates.
