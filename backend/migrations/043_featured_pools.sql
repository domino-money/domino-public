-- Featured pools (featured-policy v1): each daily selection with its full
-- evaluation, the lists it produced and the owner's overrides. Only the
-- selector writes (the catalogue writer). The public reader may read lists,
-- never runs, evidence or overrides. Nothing here changes what a visitor sees
-- until a later release serves `featured_current`.
CREATE TABLE IF NOT EXISTS domino_public.featured_runs (
 id bigserial PRIMARY KEY,
 phase text NOT NULL CHECK(phase IN ('shadow','live')),
 selection_date date NOT NULL,
 -- bootstrap: evaluated, no previous evaluation to persist against, no list.
 outcome text NOT NULL CHECK(outcome IN ('bootstrap','selected','carried_over','incomplete','failed')),
 policy_version text NOT NULL CHECK(policy_version ~ '^featured-v1:[0-9a-f]{12}$'),
 started_at timestamptz NOT NULL,
 finished_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 evaluation jsonb NOT NULL,
 CHECK(finished_at>=started_at)
);
CREATE INDEX IF NOT EXISTS featured_runs_by_date ON domino_public.featured_runs(phase,selection_date,id);
CREATE INDEX IF NOT EXISTS featured_runs_by_finish ON domino_public.featured_runs(phase,finished_at);

CREATE TABLE IF NOT EXISTS domino_public.featured_lists (
 revision bigserial PRIMARY KEY,
 phase text NOT NULL CHECK(phase IN ('shadow','live')),
 status text NOT NULL CHECK(status IN ('shadow','draft','current','repaired','carried_over','manual',
                                       'none','superseded','rejected')),
 list_id text NOT NULL CHECK(list_id ~ '^0x[0-9a-f]{64}$'),
 selection_date date,
 run_id bigint,
 generated_at bigint NOT NULL CHECK(generated_at>=0),
 effective_at bigint CHECK(effective_at>=generated_at),
 valid_until bigint CHECK(valid_until>=effective_at),
 payload jsonb NOT NULL
);
-- One selection per date and phase; repairs and manual lists are revisions of their own.
CREATE UNIQUE INDEX IF NOT EXISTS featured_lists_one_selection
 ON domino_public.featured_lists(phase,selection_date) WHERE status IN ('shadow','current');

CREATE TABLE IF NOT EXISTS domino_public.featured_current (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 revision bigint NOT NULL REFERENCES domino_public.featured_lists(revision)
);

CREATE TABLE IF NOT EXISTS domino_public.featured_overrides (
 id bigserial PRIMARY KEY,
 kind text NOT NULL CHECK(kind IN ('pin','exclude_pool','exclude_token','mode','manual','veto')),
 subject text NOT NULL CHECK(subject ~ '^(0x[0-9a-f]{40}|0x[0-9a-f]{64}|auto|manual|off|[0-9]{4}-[0-9]{2}-[0-9]{2})$'),
 value jsonb NOT NULL DEFAULT '{}'::jsonb,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
 until timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revoked_at timestamptz,
 CHECK(until IS NULL OR until>created_at),
 CHECK(revoked_at IS NULL OR revoked_at>=created_at)
);
CREATE INDEX IF NOT EXISTS featured_overrides_active ON domino_public.featured_overrides(kind,subject)
 WHERE revoked_at IS NULL;

-- The last evidence per token, and when a list first showed it: the TA-5
-- baseline (a listed token whose code changes leaves) and the symbol reading
-- no other address may take afterwards.
CREATE TABLE IF NOT EXISTS domino_public.featured_token_checks (
 address text PRIMARY KEY CHECK(address ~ '^0x[0-9a-f]{40}$'),
 code_hash text CHECK(code_hash ~ '^0x[0-9a-f]{64}$'),
 symbol_reading text,
 first_listed_at timestamptz,
 listed_code_hash text CHECK(listed_code_hash ~ '^0x[0-9a-f]{64}$'),
 evidence jsonb NOT NULL,
 reasons text[] NOT NULL DEFAULT '{}',
 checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((first_listed_at IS NULL)=(listed_code_hash IS NULL))
);

GRANT SELECT,INSERT,UPDATE,DELETE ON domino_public.featured_runs,domino_public.featured_lists,
 domino_public.featured_current,domino_public.featured_overrides,domino_public.featured_token_checks
 TO domino_catalogue_writer;
GRANT USAGE,SELECT ON SEQUENCE domino_public.featured_runs_id_seq,domino_public.featured_lists_revision_seq,
 domino_public.featured_overrides_id_seq TO domino_catalogue_writer;
GRANT SELECT ON domino_public.featured_lists,domino_public.featured_current TO domino_catalogue_reader;
-- 024 grants the reader every table that exists in this schema when it runs.
-- Applied again after this migration (development re-applies the whole
-- sequence), it would open runs, overrides and evidence: close them here, last.
REVOKE ALL ON domino_public.featured_runs,domino_public.featured_overrides,
 domino_public.featured_token_checks FROM domino_catalogue_reader;
