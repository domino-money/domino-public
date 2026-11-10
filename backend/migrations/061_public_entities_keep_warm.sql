-- The collector's hot claims. PgPublicData.claim takes a hot entity (one on screen in the
-- last minute, or one the featured list keeps warm, #278) ahead of the background backlog in
-- three turns of four. It used to rank the two classes with a CASE at the head of its ORDER BY,
-- which no index can follow. So every claim read the whole of domino_public.entities and sorted
-- its due rows. On 8 Nov 2026 that was 6,490 pages and 13 ms a claim, the catalogue writer's
-- largest PostgreSQL cost. Each class now has its own statement. The background backlog follows
-- public_entities_due. Hot rows come through public_entities_interest (last_requested_at) and
-- through this index, which holds only the entities the featured list has kept warm: 27 of
-- 22,975 pools in production on 8 Nov 2026.
--
-- Not CONCURRENTLY, for the reason 053 gives: scripts/staging/apply_migrations.py applies a
-- migration with psql --single-transaction, and dev_postgres.py applies them all in one
-- transaction. The build holds a SHARE lock on domino_public.entities until the transaction
-- commits: reads go on, and the lanes' writes wait. The wait for that lock is capped, and so is
-- the build. A production deploy builds the index CONCURRENTLY first, so there IF NOT EXISTS
-- makes this a no-op.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE INDEX IF NOT EXISTS public_entities_keep_warm ON domino_public.entities(keep_warm_until)
  WHERE keep_warm_until IS NOT NULL;
