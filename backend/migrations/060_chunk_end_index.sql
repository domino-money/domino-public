-- The chunks' end_block reads. An activity rewind deletes a pool's chunks past
-- a block (activity_store.PgActivity.rewind:
--   DELETE FROM domino_activity.chunks WHERE pool_id=%s AND end_block>%s),
-- and until #463 the fee, position and capital steps looked up a chunk's
-- predecessor with WHERE c.pool_id=%s AND c.end_block=%s. The only index on
-- domino_activity.chunks (6.8 GB, about 3.3M rows in production) was its
-- primary key (pool_id, start_block), so each of those reads went through
-- every chunk of its pool. In pools of 64,000 to 88,000 chunks the lookups
-- passed the catalogue's 5 s statement timeout 369 times from 3 to 7 Nov 2026,
-- and pool-activity answered 503 for those pools. The steps now find the
-- predecessor through the primary key; this index keeps the other end_block
-- reads, the rewind among them, to the rows they need.
--
-- Production built it on 7 Nov 2026 (14:33 to 14:34 UTC) with CREATE INDEX
-- CONCURRENTLY, so there IF NOT EXISTS makes this a no-op. Elsewhere it is not
-- CONCURRENTLY, for the reason 053 gives: scripts/staging/apply_migrations.py
-- applies a migration with psql --single-transaction, and dev_postgres.py
-- applies them all in one transaction. The build holds a SHARE lock on chunks
-- until the transaction commits: reads go on, inserts and deletes wait. The
-- wait for that lock is capped, and so is the build, well above production's
-- 80 s concurrent build.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';
CREATE INDEX IF NOT EXISTS chunk_end ON domino_activity.chunks(pool_id, end_block);
