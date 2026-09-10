-- Unpublished worker checkpoints. Source rewind atomically removes pending work
-- and its diagnostic; these records never qualify fees/assets by themselves.
CREATE TABLE IF NOT EXISTS domino_activity.historical_work (
 pool_id text NOT NULL,
 ledger text NOT NULL CHECK(ledger IN ('fee','position')),
 chunk_start bigint NOT NULL,
 progress jsonb NOT NULL CHECK(octet_length(progress::text)<=8388608),
 diagnostic jsonb NOT NULL,
 PRIMARY KEY(pool_id,ledger),
 FOREIGN KEY(pool_id,chunk_start) REFERENCES domino_activity.chunks(pool_id,start_block) ON DELETE CASCADE
);
REVOKE ALL ON domino_activity.historical_work FROM PUBLIC;
GRANT SELECT ON domino_activity.historical_work TO domino_catalogue_reader;
GRANT SELECT,INSERT,UPDATE,DELETE ON domino_activity.historical_work TO domino_catalogue_writer;
