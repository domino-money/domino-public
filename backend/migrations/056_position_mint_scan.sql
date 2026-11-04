-- The activity follower's scan of the Setup contract's SetupMinted events keeps
-- where it stopped (4 Nov 2026, launch round P3, F2). Until then every run of
-- `manage_activity.py --follow --domino-positions`, once a minute, read those
-- events from the contract's deployment block (69,249,061): about 95 ms on the
-- own node on 2 Oct 2026, growing with the range, and possible only while the
-- node's log index (its last 60M blocks since 2 Nov) still reaches that block,
-- which ends in early December 2026. Now a run reads only the blocks after the
-- checkpoint (backend/domino_positions.py).
--
-- position_scan: per Setup contract, the block the scan has read through and
-- that block's hash. A run that finds the hash changed (a reorganization across
-- the checkpoint) reads again from a safe depth below it.
-- position_mints: every SetupMinted event the scan read, with its block, so that
-- rescan deletes exactly the mints of the blocks it reads again.
-- Public chain data only. The follower writes through the catalogue writer.
-- New tables, no lock on an existing one; it applies again safely.
CREATE TABLE IF NOT EXISTS domino_activity.position_scan (
 contract text PRIMARY KEY CHECK(contract ~ '^0x[0-9a-f]{40}$'),
 start_block bigint NOT NULL CHECK(start_block>0),
 scanned_through bigint NOT NULL,
 scanned_hash text NOT NULL CHECK(scanned_hash ~ '^0x[0-9a-f]{64}$'),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(scanned_through>=start_block-1)
);
CREATE TABLE IF NOT EXISTS domino_activity.position_mints (
 contract text NOT NULL REFERENCES domino_activity.position_scan(contract) ON DELETE CASCADE,
 block_number bigint NOT NULL CHECK(block_number>0),
 log_index bigint NOT NULL CHECK(log_index>=0),
 block_hash text NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),
 tx_hash text NOT NULL CHECK(tx_hash ~ '^0x[0-9a-f]{64}$'),
 token_id numeric(78,0) NOT NULL CHECK(token_id>=0),
 PRIMARY KEY(contract,block_number,log_index)
);
GRANT SELECT ON domino_activity.position_scan,domino_activity.position_mints TO domino_catalogue_reader;
GRANT SELECT,INSERT,UPDATE,DELETE ON domino_activity.position_scan,domino_activity.position_mints
 TO domino_catalogue_writer;
