-- Public core-pool activity only; no account, signer or owner accounting.
CREATE SCHEMA IF NOT EXISTS domino_activity;
CREATE TABLE IF NOT EXISTS domino_activity.pools (
 pool_id text PRIMARY KEY CHECK(pool_id ~ '^0x[0-9a-f]{64}$'),
 pool_key jsonb NOT NULL,
 start_block bigint NOT NULL CHECK(start_block>0),
 base_hash text NOT NULL CHECK(base_hash ~ '^0x[0-9a-f]{64}$'),
 next_block bigint NOT NULL CHECK(next_block>=start_block),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 methodology_version integer NOT NULL DEFAULT 1 CHECK(methodology_version=1)
);
CREATE TABLE IF NOT EXISTS domino_activity.chunks (
 pool_id text NOT NULL REFERENCES domino_activity.pools(pool_id),
 start_block bigint NOT NULL CHECK(start_block>0),
 end_block bigint NOT NULL CHECK(end_block>=start_block),
 end_hash text NOT NULL CHECK(end_hash ~ '^0x[0-9a-f]{64}$'),
 end_timestamp bigint NOT NULL CHECK(end_timestamp>=0),
 model jsonb NOT NULL,
 state_snapshot jsonb NOT NULL,
 PRIMARY KEY(pool_id,start_block)
);
CREATE TABLE IF NOT EXISTS domino_activity.events (
 pool_id text NOT NULL,
 chunk_start bigint NOT NULL,
 block_number bigint NOT NULL CHECK(block_number>=0),
 block_hash text NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),
 block_timestamp bigint NOT NULL CHECK(block_timestamp>=0),
 tx_hash text NOT NULL CHECK(tx_hash ~ '^0x[0-9a-f]{64}$'),
 log_index bigint NOT NULL CHECK(log_index>=0),
 kind text NOT NULL CHECK(kind IN ('initialize','swap','modify_liquidity','donate','protocol_fee')),
 payload jsonb NOT NULL,
 raw_fingerprint text NOT NULL CHECK(raw_fingerprint ~ '^0x[0-9a-f]{64}$'),
 PRIMARY KEY(pool_id,block_hash,log_index),
 UNIQUE(pool_id,block_number,log_index),
 FOREIGN KEY(pool_id,chunk_start) REFERENCES domino_activity.chunks(pool_id,start_block) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS activity_window ON domino_activity.events(pool_id,block_timestamp);
REVOKE ALL ON SCHEMA domino_activity FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA domino_activity FROM PUBLIC;
GRANT USAGE ON SCHEMA domino_activity TO domino_catalogue_reader,domino_catalogue_writer;
GRANT SELECT ON ALL TABLES IN SCHEMA domino_activity TO domino_catalogue_reader;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA domino_activity TO domino_catalogue_writer;
