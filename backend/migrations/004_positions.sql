-- Derived public core-position accounting, independently versioned.
CREATE TABLE IF NOT EXISTS domino_activity.position_chunks (
 pool_id text NOT NULL,
 chunk_start bigint NOT NULL,
 methodology_version integer NOT NULL CHECK(methodology_version=1),
 model jsonb NOT NULL,
 reconciliation jsonb NOT NULL,
 PRIMARY KEY(pool_id,chunk_start),
 FOREIGN KEY(pool_id,chunk_start) REFERENCES domino_activity.fee_chunks(pool_id,chunk_start) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS domino_activity.position_settlements (
 pool_id text NOT NULL,
 block_hash text NOT NULL,
 log_index bigint NOT NULL,
 chunk_start bigint NOT NULL,
 settlement jsonb NOT NULL,
 PRIMARY KEY(pool_id,block_hash,log_index),
 FOREIGN KEY(pool_id,block_hash,log_index) REFERENCES domino_activity.events(pool_id,block_hash,log_index) ON DELETE CASCADE,
 FOREIGN KEY(pool_id,chunk_start) REFERENCES domino_activity.position_chunks(pool_id,chunk_start) ON DELETE CASCADE
);
REVOKE ALL ON domino_activity.position_chunks,domino_activity.position_settlements FROM PUBLIC;
GRANT SELECT ON domino_activity.position_chunks,domino_activity.position_settlements TO domino_catalogue_reader;
GRANT SELECT,INSERT,UPDATE,DELETE ON domino_activity.position_chunks,domino_activity.position_settlements TO domino_catalogue_writer;
