# Shared gas budget: code-only, disabled slice

This branch introduces a **pre-sign authorization ceiling** of USD 20 per
`America/Sao_Paulo` calendar day, shared by the price publisher and automation
operator. It is **not installed, enabled, or ready for mainnet operation**. It
does not change contract fees or move funds. No key, signing transaction, or
mainnet broadcast is part of this slice.

The budget is reserved against the maximum native gas cost (`gasLimit *
maxFeePerGas`) for both legs atomically before the publisher signs. The worker
reads a hash-pinned canonical Chainlink ETH/USD answer from the existing
reviewed proxy, with its proxy/aggregator identity, phase 1, eight decimals,
round, freshness, and source manifest checked. Reservation applies a 20%
price buffer and integer rounding up. Both signers require a fresh matching
claim immediately before a **new** signature. The operator refreshes its
claim after publication and before its later signature. Re-broadcast of
persisted signed bytes instead requires the original pending claim to remain
counted; an old publication without one fails closed.

The PostgreSQL lock serializes reservations from both wallets. Claims are
idempotent, never re-priced down, and pending claims from a prior day count
against the new day's capacity until resolved. A separate settlement role can
replace a reservation with a finalized receipt's gross `gasUsed *
effectiveGasPrice` only after the read-only verifier ties canonical block,
transaction, signed bytes, journal, signer, intent, and claim together. A
pending or reorged receipt cannot release capacity. The gross receipt product
is a conservative accounting basis on this chain, not a measurement of the
wallet's eventual net debit.

Migration 037 closes the direct-SQL bypass of that verifier: the settlement
function derives the gas product from a durable publisher journal with a
separate append-only publisher finality witness, a canonical operator effect,
or an append-only reverted operator receipt. It rejects a
different caller-supplied amount, including a one-wei charge through the
settlement LOGIN, and retains the signing-time ETH/USD answer as a price floor.
Migration 038 closes the remaining direct-SQL price bypass: an append-only
ETH/USD witness for the exact claim is written by the separate reservation/oracle
peer after its own canonical Chainlink read at the RPC `finalized` head. The
reservation before signing still uses `latest−2`; its 20% buffer and limits
are unchanged. Settlement requires that finalized witness
to be at most 30 seconds old in database time and at or after the receipt
block. It rejects caller quote fields that differ and charges using the
highest answer witnessed for that claim or the reservation answer, whichever
is larger. If the finalized block is older than 180 seconds or its hash changes
during the read, attestation fails and the full reservation stays held. The
settlement OS peer can request this attestation over the local
socket but cannot invoke reservation operations; its database LOGIN cannot
write or read the quote table or invoke the attestation SQL function.
The settlement role cannot write those witnesses. PostgreSQL cannot prove
Robinhood Chain finality itself; it still trusts the independent journal writers
and the verifier's canonical receipt checks. Any claim without a matching
witness keeps its full reservation, including across midnight. The publisher
identity verifies the exact signed receipt against a canonical block at or
behind the RPC `finalized` head, then writes its witness. A persisted cursor
rotates through terminal publications in bounded passes, so one unavailable
old receipt does not starve newer claims. Pre-finality reverted publications
may reorg and retry their same signed bytes; no replacement nonce is created.

The ceiling is an **authorization cap**, not a mathematical promise that the
final USD cost cannot exceed $20. ETH/USD may increase by more than the 20%
buffer after signature. The settlement records the actual larger USD amount,
can put the day above $20, and then denies new work; it does not erase the
claim. A price drop does not lower historical charged cost.

## Remaining blockers before any activation

1. `GasReceiptSettlement` runs a bounded, durable rotation of reserved claims
   in a separate keyless process. Its timer is installed off; `run-once` and
   `serve` do not use the settlement DB role. Pending, reorged or ambiguous
   transactions retain their full reservation. Migration 035 releases only a
   never-signed claim after PostgreSQL proves the intent or cycle is terminal
   and the signing journal absent; an immutable tombstone blocks re-reservation.
   A journal-bound finalized receipt replaces a reservation with actual gas.
2. Migrations 032–038 retain NOLOGIN privilege roles behind distinct peer
   LOGIN bridges. Reservation uses an OS-authenticated local socket; settlement
   uses a separate unit and exact-ID journal witness functions, without direct
   table SELECT. The settlement unit requires the socket for quote attestation.
   Both remain off until private profiles and a host-level
   end-to-end rehearsal are complete. No role credential is bundled.
3. The unsigned-cancellation proof depends on the signer call graph:
   `ExecutionJournal` locks the intent and persists `signing` before using the
   operator key; `PublicationJournal.prepare` holds its observation-ID advisory
   lock across signing and journal insertion. A new signer path must preserve
   this ordering before activation.
4. Rehearse the full publisher/operator flow, including claim rotation, on an isolated fork with the
   production migration/role matrix and run CI against the pinned release
   artifacts. The focused tests in this branch do not replace that rehearsal.

Until those blockers are closed, keep the automation service disabled. The
current runtime fails closed while the socket and settlement timer are off.
Do not grant a privilege role an ad hoc login or enable the service as a workaround.

## Bounded validation

The focused unit and disposable PostgreSQL tests cover feed identity and
canonicality, stale/reorg refusal, shared atomic and concurrent reservations,
idempotence, the signing gates, legacy signed resend refusal, receipt identity,
finality, durable cursor rotation, terminal unsigned cancellation and settlement accounting including a post-sign ETH/USD jump
above the daily cap. They run with:

```sh
DOMINO_TEST_POSTGRES=1 PYTHONPATH=backend:backend/tests \
  python -m unittest -v test_gas_usd_budget \
  test_execution_signer_gas_budget test_publisher_signer \
  test_gas_receipt_settlement test_gas_unsigned_cancellation \
  test_automation_schedule
```

One read-only probe on 2026-09-22 used the already configured chain-4663
provider. The private local RPC was not configured in this checkout, so it was
not used. The pinned ETH/USD reader accepted block 70,144,610 at hash
`0xae1f94c1b58afcd72ef3821d49619941d0643302ceeccfe890deedd7f885ad58`,
round 18,446,744,073,709,553,997, with a 1,008-second answer age and zero
head age at retrieval; manifest SHA-256 was
`2ae1ea5f432cab06904134759033d7c6434c323171f954120c4933fdde42e85d`.
This is a point-in-time reader check, not live-service qualification.
