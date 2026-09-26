-- Featured pools, live: the draft becomes the served list (featured_current),
-- and the served list is repaired during the day when a pool breaks a safety
-- rule. A condition that must hold across checks (liquidity collapse, price
-- fall, APR or turnover above the ceiling, no estimate, volume collapse) is
-- tracked here from its first sighting until it clears.
CREATE TABLE IF NOT EXISTS domino_public.featured_health (
 pool_id text NOT NULL CHECK(pool_id ~ '^0x[0-9a-f]{64}$'),
 condition text NOT NULL CHECK(condition IN ('tvl_collapse','price_fall','apr_or_turnover_above_ceiling',
                                             'estimate_unavailable','volume_collapse')),
 first_seen_at bigint NOT NULL CHECK(first_seen_at>=0),
 last_seen_at bigint NOT NULL,
 checks integer NOT NULL DEFAULT 1 CHECK(checks>=1),
 PRIMARY KEY(pool_id,condition),
 CHECK(last_seen_at>=first_seen_at)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON domino_public.featured_health TO domino_catalogue_writer;
REVOKE ALL ON domino_public.featured_health FROM domino_catalogue_reader;

-- The owner also chooses the phase (shadow or live) and a manual list; a veto
-- names the date whose selection must not be published.
ALTER TABLE domino_public.featured_overrides DROP CONSTRAINT IF EXISTS featured_overrides_kind_check;
ALTER TABLE domino_public.featured_overrides ADD CONSTRAINT featured_overrides_kind_check
 CHECK(kind IN ('pin','exclude_pool','exclude_token','mode','manual','veto','phase'));
ALTER TABLE domino_public.featured_overrides DROP CONSTRAINT IF EXISTS featured_overrides_subject_check;
ALTER TABLE domino_public.featured_overrides ADD CONSTRAINT featured_overrides_subject_check
 CHECK(subject ~ '^(0x[0-9a-f]{40}|0x[0-9a-f]{64}|auto|manual|off|shadow|live|[0-9]{4}-[0-9]{2}-[0-9]{2})$');
