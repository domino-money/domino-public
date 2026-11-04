-- Featured pools per chain (launch round P3, 4 Nov 2026): Base and Arbitrum One
-- each select a list of their own, in shadow, in these same tables beside
-- Robinhood's. Every row names its chain. The rows already here are Robinhood's
-- (4663), and so is any row a release without chain_id still writes.
-- A pool id names a pool on one chain only: a v4 PoolKey hashes alike on every
-- chain where its currencies share addresses (cbBTC has one address on Base and
-- on Arbitrum), so every key and every unique index gains the chain. A v3 pool
-- is named by its address. featured_current stays Robinhood's singleton: no
-- other chain's list is served until read-v5 takes a chain (FEATURED_POOLS.md).
-- The new keys replace the ones 043 and 045 made, under the same names, so
-- development's re-application of 043 and 045 finds them and leaves them be.
-- A release before this one writes ON CONFLICT(address) and (pool_id,condition):
-- stop domino-featured.service before applying it, and start it on the release
-- that carries it.
ALTER TABLE domino_public.featured_runs
 ADD COLUMN IF NOT EXISTS chain_id bigint NOT NULL DEFAULT 4663 CHECK(chain_id>0);
ALTER TABLE domino_public.featured_lists
 ADD COLUMN IF NOT EXISTS chain_id bigint NOT NULL DEFAULT 4663 CHECK(chain_id>0);
ALTER TABLE domino_public.featured_overrides
 ADD COLUMN IF NOT EXISTS chain_id bigint NOT NULL DEFAULT 4663 CHECK(chain_id>0);
ALTER TABLE domino_public.featured_health
 ADD COLUMN IF NOT EXISTS chain_id bigint NOT NULL DEFAULT 4663 CHECK(chain_id>0);
ALTER TABLE domino_public.featured_token_checks
 ADD COLUMN IF NOT EXISTS chain_id bigint NOT NULL DEFAULT 4663 CHECK(chain_id>0);

-- One selection per chain, date and phase; repairs and manual lists are revisions of their own.
DROP INDEX IF EXISTS domino_public.featured_lists_one_selection;
CREATE UNIQUE INDEX featured_lists_one_selection
 ON domino_public.featured_lists(chain_id,phase,selection_date) WHERE status IN ('shadow','current');
DROP INDEX IF EXISTS domino_public.featured_runs_by_date;
CREATE INDEX featured_runs_by_date ON domino_public.featured_runs(chain_id,phase,selection_date,id);
DROP INDEX IF EXISTS domino_public.featured_runs_by_finish;
CREATE INDEX featured_runs_by_finish ON domino_public.featured_runs(chain_id,phase,finished_at);
DROP INDEX IF EXISTS domino_public.featured_overrides_active;
CREATE INDEX featured_overrides_active ON domino_public.featured_overrides(chain_id,kind,subject)
 WHERE revoked_at IS NULL;

-- A token is its chain and address; a condition belongs to a pool on one chain.
ALTER TABLE domino_public.featured_token_checks DROP CONSTRAINT IF EXISTS featured_token_checks_pkey,
 ADD CONSTRAINT featured_token_checks_pkey PRIMARY KEY(chain_id,address);
ALTER TABLE domino_public.featured_health DROP CONSTRAINT IF EXISTS featured_health_pkey,
 ADD CONSTRAINT featured_health_pkey PRIMARY KEY(chain_id,pool_id,condition);
ALTER TABLE domino_public.featured_health DROP CONSTRAINT IF EXISTS featured_health_pool_id_check,
 ADD CONSTRAINT featured_health_pool_id_check CHECK(pool_id ~ '^0x([0-9a-f]{40}|[0-9a-f]{64})$');
