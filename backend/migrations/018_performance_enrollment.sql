-- Session-owner enrollment and durable bounded collector scheduling. No signer.
DO $$
DECLARE ddl_owner oid; account text; role_oid oid;
BEGIN
 SELECT oid INTO ddl_owner FROM pg_roles WHERE rolname=current_user;
 IF current_user IN ('domino_performance_collector','domino_performance_reader')
    OR NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='domino_performance' AND nspowner=ddl_owner)
    OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='domino_performance' AND c.relname IN ('enrollments','projection_heads','projection_buckets') AND c.relowner<>ddl_owner)
    OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='domino_performance' AND p.proname IN ('preserve_enrollment','preserve_projection') AND p.proowner<>ddl_owner) THEN
  RAISE EXCEPTION 'performance_enrollment_ddl_owner_required';
 END IF;
 FOREACH account IN ARRAY ARRAY['domino_performance_collector','domino_performance_reader'] LOOP
  SELECT oid INTO role_oid FROM pg_roles WHERE rolname=account;
  IF role_oid IS NULL OR EXISTS(SELECT 1 FROM pg_roles WHERE oid=role_oid AND
      (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication OR rolinherit))
      OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=role_oid OR roleid=role_oid) THEN
   RAISE EXCEPTION 'performance_isolated_roles_required';
  END IF;
 END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS domino_performance.enrollments (
 owner text NOT NULL CHECK(owner ~ '^0x[0-9a-f]{40}$'),
 enrollment_id text NOT NULL CHECK(enrollment_id ~ '^0x[0-9a-f]{64}$'),
 vault text NOT NULL CHECK(vault ~ '^0x[0-9a-f]{40}$'),
 token_ids jsonb NOT NULL CHECK(jsonb_typeof(token_ids)='array' AND jsonb_array_length(token_ids) BETWEEN 1 AND 64),
 vault_code_hash text NOT NULL CHECK(vault_code_hash ~ '^0x[0-9a-f]{64}$'),
 epoch_id text,
 revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 status text NOT NULL CHECK(status IN ('queued','tracking','stale','blocked')),
 reason text NOT NULL CHECK(reason IN ('awaiting_baseline','forward_collection','collection_failed','baseline_reorged')),
 visible_until timestamptz NOT NULL,
 due_at timestamptz NOT NULL,
 lease_id text CHECK(lease_id ~ '^[0-9a-f]{64}$'),
 lease_until timestamptz,
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL CHECK(updated_at>=created_at),
 PRIMARY KEY(owner,enrollment_id), UNIQUE(owner,vault),
 FOREIGN KEY(owner,epoch_id) REFERENCES domino_performance.epochs(owner,epoch_id),
 CHECK((lease_id IS NULL)=(lease_until IS NULL)),
 CHECK((status='queued' AND reason='awaiting_baseline') OR (status='tracking' AND reason='forward_collection' AND epoch_id IS NOT NULL)
    OR (status='stale' AND reason='collection_failed') OR (status='blocked' AND reason='baseline_reorged' AND epoch_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS performance_enrollment_due ON domino_performance.enrollments(owner,due_at);
CREATE OR REPLACE FUNCTION domino_performance.preserve_enrollment() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,domino_performance AS $$
BEGIN
 IF TG_OP='DELETE' OR (NEW.owner,NEW.enrollment_id,NEW.vault,NEW.token_ids,NEW.vault_code_hash,NEW.created_at)
    IS DISTINCT FROM (OLD.owner,OLD.enrollment_id,OLD.vault,OLD.token_ids,OLD.vault_code_hash,OLD.created_at)
    OR NEW.revision<>OLD.revision+1 OR OLD.epoch_id IS NOT NULL AND NEW.epoch_id IS DISTINCT FROM OLD.epoch_id THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='performance_immutable_enrollment';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS performance_preserve_enrollment ON domino_performance.enrollments;
CREATE TRIGGER performance_preserve_enrollment BEFORE UPDATE OR DELETE ON domino_performance.enrollments
 FOR EACH ROW EXECUTE FUNCTION domino_performance.preserve_enrollment();
ALTER TABLE domino_performance.enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE domino_performance.enrollments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS performance_owner ON domino_performance.enrollments;
CREATE POLICY performance_owner ON domino_performance.enrollments TO domino_performance_collector,domino_performance_reader
 USING(owner=current_setting('domino.performance_owner',true)) WITH CHECK(owner=current_setting('domino.performance_owner',true));
REVOKE ALL ON domino_performance.enrollments FROM PUBLIC,domino_performance_collector,domino_performance_reader;
GRANT SELECT ON domino_performance.enrollments TO domino_performance_collector,domino_performance_reader;
GRANT INSERT,UPDATE ON domino_performance.enrollments TO domino_performance_collector;
REVOKE ALL ON FUNCTION domino_performance.preserve_enrollment() FROM PUBLIC;

-- Derived minute summaries are replaceable only with a new revision. The raw
-- canonical pages, financial observations and all old replay generations stay
-- in their existing immutable journals; no projection grants delete privilege.
CREATE TABLE IF NOT EXISTS domino_performance.projection_heads (
 owner text NOT NULL, epoch_id text NOT NULL, replay_generation bigint NOT NULL,
 revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 next_bucket bigint NOT NULL CHECK(next_bucket>=0 AND next_bucket%60=0),
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 PRIMARY KEY(owner,epoch_id,replay_generation),
 FOREIGN KEY(owner,epoch_id,replay_generation) REFERENCES domino_performance.financial_heads(owner,epoch_id,replay_generation)
);
CREATE TABLE IF NOT EXISTS domino_performance.projection_buckets (
 owner text NOT NULL, epoch_id text NOT NULL, replay_generation bigint NOT NULL,
 bucket bigint NOT NULL CHECK(bucket>=0 AND bucket%60=0),
 revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 source_raw_revision bigint NOT NULL CHECK(source_raw_revision>=1),
 source_financial_revision bigint NOT NULL CHECK(source_financial_revision>=1),
 summary jsonb NOT NULL CHECK(jsonb_typeof(summary)='object' AND octet_length(summary::text)<=32768),
 summary_hash text NOT NULL CHECK(summary_hash ~ '^[0-9a-f]{64}$'),
 dirty boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 PRIMARY KEY(owner,epoch_id,replay_generation,bucket),
 FOREIGN KEY(owner,epoch_id,replay_generation) REFERENCES domino_performance.projection_heads(owner,epoch_id,replay_generation),
 CHECK(summary->>'owner'=owner AND summary->>'epochId'=epoch_id AND
   (summary->>'replayGeneration')::bigint=replay_generation AND (summary->>'bucket')::bigint=bucket)
);
CREATE INDEX IF NOT EXISTS performance_projection_dirty ON domino_performance.projection_buckets(owner,epoch_id,replay_generation,bucket) WHERE dirty;
CREATE OR REPLACE FUNCTION domino_performance.preserve_projection() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,domino_performance AS $$
BEGIN
 IF TG_OP='DELETE' OR (NEW.owner,NEW.epoch_id,NEW.replay_generation,NEW.created_at)
    IS DISTINCT FROM (OLD.owner,OLD.epoch_id,OLD.replay_generation,OLD.created_at)
    OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='performance_projection_revision_required';
 END IF;
 IF TG_TABLE_NAME='projection_heads' THEN
  IF NEW.next_bucket<OLD.next_bucket THEN RAISE EXCEPTION 'performance_projection_cursor_regressed'; END IF;
 ELSE
  IF NEW.bucket<>OLD.bucket OR NEW.source_raw_revision<OLD.source_raw_revision
     OR NEW.source_financial_revision<OLD.source_financial_revision THEN
   RAISE EXCEPTION 'performance_projection_source_regressed';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS performance_preserve_projection ON domino_performance.projection_heads;
CREATE TRIGGER performance_preserve_projection BEFORE UPDATE OR DELETE ON domino_performance.projection_heads
 FOR EACH ROW EXECUTE FUNCTION domino_performance.preserve_projection();
DROP TRIGGER IF EXISTS performance_preserve_projection ON domino_performance.projection_buckets;
CREATE TRIGGER performance_preserve_projection BEFORE UPDATE OR DELETE ON domino_performance.projection_buckets
 FOR EACH ROW EXECUTE FUNCTION domino_performance.preserve_projection();
ALTER TABLE domino_performance.projection_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE domino_performance.projection_heads FORCE ROW LEVEL SECURITY;
ALTER TABLE domino_performance.projection_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE domino_performance.projection_buckets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS performance_owner ON domino_performance.projection_heads;
CREATE POLICY performance_owner ON domino_performance.projection_heads TO domino_performance_collector,domino_performance_reader
 USING(owner=current_setting('domino.performance_owner',true)) WITH CHECK(owner=current_setting('domino.performance_owner',true));
DROP POLICY IF EXISTS performance_owner ON domino_performance.projection_buckets;
CREATE POLICY performance_owner ON domino_performance.projection_buckets TO domino_performance_collector,domino_performance_reader
 USING(owner=current_setting('domino.performance_owner',true)) WITH CHECK(owner=current_setting('domino.performance_owner',true));
REVOKE ALL ON domino_performance.projection_heads,domino_performance.projection_buckets FROM PUBLIC,domino_performance_collector,domino_performance_reader;
GRANT SELECT ON domino_performance.projection_heads,domino_performance.projection_buckets TO domino_performance_collector,domino_performance_reader;
GRANT INSERT,UPDATE ON domino_performance.projection_heads,domino_performance.projection_buckets TO domino_performance_collector;
REVOKE ALL ON FUNCTION domino_performance.preserve_projection() FROM PUBLIC;
