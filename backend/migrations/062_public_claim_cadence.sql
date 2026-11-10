-- The collector's scheduled cadence (#278). Three scheduled pool claims of four, and one token
-- claim of two, take a hot entity first; the others take the background backlog first. To
-- count persisted claims, so that no deadline or restart erases background's turn, each
-- scheduled claim read the sum of its kind's generations. That sum read every row of the kind:
-- 6,601 pages and 10-17 ms per scheduled claim, about ten times a second, on 9 Nov 2026.
-- PgPublicData.claim keeps the count here instead. A scheduled claim reads its row under the
-- kind's advisory lock and advances it by the rows it took, in the claim's own transaction.
-- A missing row counts as zero, so nothing is seeded: the cadence starts over once, at its
-- first claim.
--
-- The grants are every domino_public table's (024): the reader reads, the writer, which claims,
-- writes. It runs as postgres, as 044: domino_public is postgres's.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TABLE IF NOT EXISTS domino_public.claim_cadence(
  chain_id integer NOT NULL CHECK (chain_id=4663),
  kind text NOT NULL CHECK (kind IN ('pool','token')),
  claims bigint NOT NULL,
  PRIMARY KEY (chain_id,kind)
);
GRANT SELECT ON domino_public.claim_cadence TO domino_catalogue_reader;
GRANT SELECT,INSERT,UPDATE,DELETE ON domino_public.claim_cadence TO domino_catalogue_writer;
