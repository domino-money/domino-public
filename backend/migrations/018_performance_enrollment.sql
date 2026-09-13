-- Session-owner enrollment and durable bounded collector scheduling. No signer.
DO $$
DECLARE ddl_owner oid; account text; role_oid oid;
BEGIN
 SELECT oid INTO ddl_owner FROM pg_roles WHERE rolname=current_user;
 IF current_user IN ('domino_performance_collector','domino_performance_reader')
    OR NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='domino_performance' AND nspowner=ddl_owner)
    OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='domino_performance' AND c.relname='enrollments' AND c.relowner<>ddl_owner)
    OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='domino_performance' AND p.proname='preserve_enrollment' AND p.proowner<>ddl_owner) THEN
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
