-- Forward managed financial evidence, separate from raw journal progress.
-- Apply after 016 as the same trusted DDL owner. No public/financial activation.
DO $$
DECLARE ddl_owner oid; account text; role_oid oid;
BEGIN
 SELECT oid INTO ddl_owner FROM pg_roles WHERE rolname=current_user;
 IF current_user IN ('domino_performance_collector','domino_performance_reader')
    OR NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='domino_performance' AND nspowner=ddl_owner)
    OR NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='domino_performance' AND c.relname='epochs' AND c.relowner=ddl_owner)
    OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='domino_performance' AND c.relname IN ('financial_heads','financial_pages') AND c.relowner<>ddl_owner)
    OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='domino_performance' AND p.proname IN ('preserve_financial_head','preserve_financial_page') AND p.proowner<>ddl_owner) THEN
  RAISE EXCEPTION 'performance_financial_ddl_owner_required';
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

CREATE TABLE IF NOT EXISTS domino_performance.financial_heads (
 owner text NOT NULL,
 epoch_id text NOT NULL,
 replay_generation bigint NOT NULL CHECK(replay_generation BETWEEN 1 AND 9007199254740991),
 revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 raw_revision bigint NOT NULL CHECK(raw_revision BETWEEN 1 AND 9007199254740991),
 cursor jsonb NOT NULL CHECK(jsonb_typeof(cursor)='object' AND octet_length(cursor::text)<=1024),
 opening jsonb NOT NULL CHECK(jsonb_typeof(opening)='object' AND octet_length(opening::text)<=524288),
 opening_hash text NOT NULL CHECK(opening_hash ~ '^[0-9a-f]{64}$'),
 state jsonb NOT NULL CHECK(jsonb_typeof(state)='object' AND octet_length(state::text)<=4194304),
 last_error text CHECK(last_error ~ '^[a-z][a-z0-9_]{0,95}$'),
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL CHECK(updated_at>=created_at),
 PRIMARY KEY(owner,epoch_id,replay_generation),
 FOREIGN KEY(owner,epoch_id) REFERENCES domino_performance.epochs(owner,epoch_id),
 CHECK(opening ?& ARRAY['owner','epochId'] AND opening->>'owner'=owner AND opening->>'epochId'=epoch_id),
 CHECK(state ?& ARRAY['owner','epochId'] AND state->>'owner'=owner AND state->>'epochId'=epoch_id)
);
CREATE TABLE IF NOT EXISTS domino_performance.financial_pages (
 owner text NOT NULL,
 epoch_id text NOT NULL,
 replay_generation bigint NOT NULL CHECK(replay_generation BETWEEN 1 AND 9007199254740991),
 from_block bigint NOT NULL CHECK(from_block>=0),
 through_block bigint NOT NULL CHECK(through_block>from_block),
 through_timestamp bigint NOT NULL CHECK(through_timestamp>=0),
 previous_revision bigint NOT NULL CHECK(previous_revision>=1),
 applied_revision bigint NOT NULL CHECK(applied_revision=previous_revision+1),
 raw_revision bigint NOT NULL CHECK(raw_revision>=1),
 raw_page_hash text NOT NULL CHECK(raw_page_hash ~ '^[0-9a-f]{64}$'),
 page_hash text NOT NULL CHECK(page_hash ~ '^[0-9a-f]{64}$'),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=8388608),
 recorded_at timestamptz NOT NULL,
 PRIMARY KEY(owner,epoch_id,replay_generation,from_block),
 FOREIGN KEY(owner,epoch_id,replay_generation) REFERENCES domino_performance.financial_heads(owner,epoch_id,replay_generation),
 FOREIGN KEY(owner,epoch_id,replay_generation,raw_page_hash) REFERENCES domino_performance.pages(owner,epoch_id,replay_generation,page_hash),
 CHECK(payload ?& ARRAY['owner','epochId'] AND payload->>'owner'=owner AND payload->>'epochId'=epoch_id)
);
CREATE INDEX IF NOT EXISTS performance_financial_window ON domino_performance.financial_pages(owner,epoch_id,replay_generation,through_timestamp,from_block);

CREATE OR REPLACE FUNCTION domino_performance.preserve_financial_head() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,domino_performance AS $$
BEGIN
 IF (NEW.owner,NEW.epoch_id,NEW.replay_generation,NEW.opening,NEW.opening_hash,NEW.created_at) IS DISTINCT FROM
    (OLD.owner,OLD.epoch_id,OLD.replay_generation,OLD.opening,OLD.opening_hash,OLD.created_at)
    OR NEW.revision<>OLD.revision+1 OR NEW.raw_revision<OLD.raw_revision THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='performance_immutable_financial_identity';
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION domino_performance.preserve_financial_page() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,domino_performance AS $$
BEGIN
 RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='performance_immutable_financial_page';
END $$;
REVOKE ALL ON FUNCTION domino_performance.preserve_financial_head(),domino_performance.preserve_financial_page() FROM PUBLIC;
DROP TRIGGER IF EXISTS performance_financial_head_guard ON domino_performance.financial_heads;
CREATE TRIGGER performance_financial_head_guard BEFORE UPDATE ON domino_performance.financial_heads
 FOR EACH ROW EXECUTE FUNCTION domino_performance.preserve_financial_head();
DROP TRIGGER IF EXISTS performance_financial_page_guard ON domino_performance.financial_pages;
CREATE TRIGGER performance_financial_page_guard BEFORE UPDATE OR DELETE ON domino_performance.financial_pages
 FOR EACH ROW EXECUTE FUNCTION domino_performance.preserve_financial_page();

DO $$
DECLARE item text;
BEGIN
 FOREACH item IN ARRAY ARRAY['financial_heads','financial_pages'] LOOP
  EXECUTE format('ALTER TABLE domino_performance.%I ENABLE ROW LEVEL SECURITY',item);
  EXECUTE format('ALTER TABLE domino_performance.%I FORCE ROW LEVEL SECURITY',item);
  EXECUTE format('DROP POLICY IF EXISTS performance_owner ON domino_performance.%I',item);
  EXECUTE format('CREATE POLICY performance_owner ON domino_performance.%I TO domino_performance_collector,domino_performance_reader USING(owner=current_setting(''domino.performance_owner'',true)) WITH CHECK(owner=current_setting(''domino.performance_owner'',true))',item);
  EXECUTE format('REVOKE ALL ON domino_performance.%I FROM PUBLIC,domino_performance_collector,domino_performance_reader',item);
  EXECUTE format('GRANT SELECT ON domino_performance.%I TO domino_performance_collector,domino_performance_reader',item);
  EXECUTE format('GRANT INSERT ON domino_performance.%I TO domino_performance_collector',item);
 END LOOP;
END $$;
GRANT UPDATE ON domino_performance.financial_heads TO domino_performance_collector;
