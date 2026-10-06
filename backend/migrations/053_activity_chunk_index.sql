-- The ledgers' read of one activity chunk. The fee, position and capital steps
-- (fee_store.py, position_store.py, capital_store.py; the public-data
-- accounting lane runs one per turn) each read a chunk's events with
--   SELECT ... FROM domino_activity.events WHERE pool_id=%s AND chunk_start=%s
--   ORDER BY block_number,log_index LIMIT 2001
-- No index began with these two columns, so for a pool holding a large share
-- of the table the planner scanned all of it: on 6 Oct 2026, a parallel
-- sequential scan of about 2.87M rows (1.75 GB) for each of the two pools
-- holding 72% of them. With a cold cache that passed the catalogue's 5 s
-- statement timeout (12:36 and 12:40 UTC) and the step failed as
-- catalogue_database_unavailable. This index finds the chunk's own rows (30 to
-- 40 on average in those two pools; at most 2,000 in a chunk written since
-- that limit), and the query sorts only those. The same columns are the
-- events' foreign key to domino_activity.chunks, so a chunk deleted by an
-- activity rewind (ON DELETE CASCADE) finds its events here too, instead of
-- scanning.
--
-- Not CONCURRENTLY: scripts/staging/apply_migrations.py applies a migration
-- with psql --single-transaction, and dev_postgres.py applies them all in one
-- transaction. The build holds a SHARE lock on events until the transaction
-- commits: reads go on, inserts and deletes wait. The wait for that lock is
-- capped, so a busy writer cannot queue others behind the build, and so is
-- the build, far above the seconds it takes (docs/HISTORICAL_CAPACITY.md).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
CREATE INDEX IF NOT EXISTS activity_chunk ON domino_activity.events(pool_id, chunk_start);
