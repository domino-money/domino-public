-- Private forward-only collection journal. Apply as the trusted DDL owner.
-- Roles are provisioned separately, without schema-owner membership/BYPASSRLS.
DO $$
DECLARE ddl_owner oid; account text; role_oid oid;
BEGIN
 SELECT oid INTO ddl_owner FROM pg_roles WHERE rolname=current_user;
 IF current_user IN ('domino_performance_collector','domino_performance_reader')
    OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='domino_performance' AND nspowner<>ddl_owner)
    OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='domino_performance' AND c.relname IN ('epochs','pages','receipts','events','transitions')
       AND c.relowner<>ddl_owner)
    OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='domino_performance' AND p.proname IN ('preserve_epoch','preserve_inclusion','preserve_page')
       AND p.proowner<>ddl_owner) THEN
  RAISE EXCEPTION 'performance_ddl_owner_required';
 END IF;
 FOREACH account IN ARRAY ARRAY['domino_performance_collector','domino_performance_reader'] LOOP
  SELECT oid INTO role_oid FROM pg_roles WHERE rolname=account;
  IF role_oid IS NULL OR EXISTS(SELECT 1 FROM pg_roles WHERE oid=role_oid AND
      (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication OR rolinherit))
      OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=role_oid OR roleid=role_oid) THEN
   -- NOINHERIT alone does not prevent SET ROLE. Do not silently repair grants.
   RAISE EXCEPTION 'performance_isolated_roles_required';
  END IF;
 END LOOP;
END $$;

CREATE SCHEMA IF NOT EXISTS domino_performance;
REVOKE ALL ON SCHEMA domino_performance FROM PUBLIC;
GRANT USAGE ON SCHEMA domino_performance TO domino_performance_collector, domino_performance_reader;

CREATE TABLE IF NOT EXISTS domino_performance.epochs (
 owner text NOT NULL CHECK(owner ~ '^0x[0-9a-f]{40}$'),
 epoch_id text NOT NULL CHECK(epoch_id ~ '^0x[0-9a-f]{64}$'),
 baseline jsonb NOT NULL CHECK(jsonb_typeof(baseline)='object' AND octet_length(baseline::text)<=262144),
 baseline_hash text NOT NULL CHECK(baseline_hash ~ '^[0-9a-f]{64}$'),
 cursor jsonb NOT NULL CHECK(jsonb_typeof(cursor)='object' AND octet_length(cursor::text)<=1024),
 revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 replay_generation bigint NOT NULL CHECK(replay_generation BETWEEN 1 AND 9007199254740991),
 status text NOT NULL CHECK(status IN ('active','read_failed','replaying','baseline_reorged')),
 last_error text CHECK(last_error ~ '^[a-z][a-z0-9_]{0,95}$'),
 page_count bigint NOT NULL CHECK(page_count>=0),
 receipt_count bigint NOT NULL CHECK(receipt_count>=0),
 event_count bigint NOT NULL CHECK(event_count>=0),
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL CHECK(updated_at>=created_at),
 PRIMARY KEY(owner,epoch_id),
 CHECK(baseline ?& ARRAY['owner','epochId'] AND baseline->>'owner'=owner AND baseline->>'epochId'=epoch_id)
);
CREATE TABLE IF NOT EXISTS domino_performance.pages (
 owner text NOT NULL,
 epoch_id text NOT NULL,
 replay_generation bigint NOT NULL CHECK(replay_generation BETWEEN 1 AND 9007199254740991),
 page_hash text NOT NULL CHECK(page_hash ~ '^[0-9a-f]{64}$'),
 from_block bigint NOT NULL CHECK(from_block>=0),
 through_block bigint NOT NULL CHECK(through_block>from_block),
 previous_revision bigint NOT NULL CHECK(previous_revision>=1),
 applied_revision bigint NOT NULL CHECK(applied_revision=previous_revision+1),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=4194304),
 canonical boolean NOT NULL,
 PRIMARY KEY(owner,epoch_id,replay_generation,page_hash),
 UNIQUE(owner,epoch_id,replay_generation,from_block),
 FOREIGN KEY(owner,epoch_id) REFERENCES domino_performance.epochs(owner,epoch_id)
);
CREATE TABLE IF NOT EXISTS domino_performance.receipts (
 owner text NOT NULL,
 epoch_id text NOT NULL,
 transaction_hash text NOT NULL CHECK(transaction_hash ~ '^0x[0-9a-f]{64}$'),
 block_hash text NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),
 block_number bigint NOT NULL CHECK(block_number>=0),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=262144),
 first_seen_revision bigint NOT NULL CHECK(first_seen_revision>=2),
 replay_generation bigint NOT NULL CHECK(replay_generation>=1),
 canonical boolean NOT NULL,
 PRIMARY KEY(owner,epoch_id,transaction_hash,block_hash),
 FOREIGN KEY(owner,epoch_id) REFERENCES domino_performance.epochs(owner,epoch_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS performance_receipt_one_canonical
 ON domino_performance.receipts(owner,epoch_id,transaction_hash) WHERE canonical;
CREATE TABLE IF NOT EXISTS domino_performance.events (
 owner text NOT NULL,
 epoch_id text NOT NULL,
 event_id text NOT NULL CHECK(event_id ~ '^0x[0-9a-f]{64}$'),
 transaction_hash text NOT NULL CHECK(transaction_hash ~ '^0x[0-9a-f]{64}$'),
 receipt_log_index integer NOT NULL CHECK(receipt_log_index>=0),
 block_hash text NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),
 block_number bigint NOT NULL CHECK(block_number>=0),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=8192),
 first_seen_revision bigint NOT NULL CHECK(first_seen_revision>=2),
 replay_generation bigint NOT NULL CHECK(replay_generation>=1),
 canonical boolean NOT NULL,
 PRIMARY KEY(owner,epoch_id,event_id,block_hash),
 UNIQUE(owner,epoch_id,transaction_hash,receipt_log_index,block_hash),
 FOREIGN KEY(owner,epoch_id,transaction_hash,block_hash)
   REFERENCES domino_performance.receipts(owner,epoch_id,transaction_hash,block_hash)
);
CREATE UNIQUE INDEX IF NOT EXISTS performance_event_one_canonical
 ON domino_performance.events(owner,epoch_id,event_id) WHERE canonical;
CREATE UNIQUE INDEX IF NOT EXISTS performance_ordinal_one_canonical
 ON domino_performance.events(owner,epoch_id,transaction_hash,receipt_log_index) WHERE canonical;
CREATE TABLE IF NOT EXISTS domino_performance.transitions (
 owner text NOT NULL,
 epoch_id text NOT NULL,
 revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 kind text NOT NULL CHECK(kind IN ('capture','page','read_failure','reorg','baseline_reorg')),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=2048),
 recorded_at timestamptz NOT NULL,
 PRIMARY KEY(owner,epoch_id,revision),
 FOREIGN KEY(owner,epoch_id) REFERENCES domino_performance.epochs(owner,epoch_id)
);

CREATE OR REPLACE FUNCTION domino_performance.preserve_epoch() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,domino_performance AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['cursor','revision','replay_generation','status','last_error','page_count','receipt_count','event_count','updated_at'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['cursor','revision','replay_generation','status','last_error','page_count','receipt_count','event_count','updated_at']) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='performance_immutable_baseline';
 END IF;
 IF OLD.status='baseline_reorged' OR NEW.revision<>OLD.revision+1
   OR NEW.replay_generation NOT IN (OLD.replay_generation,OLD.replay_generation+1) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='performance_invalid_revision';
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION domino_performance.preserve_inclusion() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,domino_performance AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['canonical','replay_generation']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['canonical','replay_generation'])
    OR NEW.replay_generation<OLD.replay_generation
    OR (OLD.canonical AND NEW.canonical) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='performance_immutable_inclusion';
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION domino_performance.preserve_page() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,domino_performance AS $$
BEGIN
 IF (to_jsonb(NEW)-'canonical') IS DISTINCT FROM (to_jsonb(OLD)-'canonical')
    OR NOT OLD.canonical OR NEW.canonical THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='performance_immutable_page';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA domino_performance FROM PUBLIC;
DROP TRIGGER IF EXISTS performance_preserve_epoch ON domino_performance.epochs;
CREATE TRIGGER performance_preserve_epoch BEFORE UPDATE ON domino_performance.epochs
 FOR EACH ROW EXECUTE FUNCTION domino_performance.preserve_epoch();
DROP TRIGGER IF EXISTS performance_preserve_page ON domino_performance.pages;
CREATE TRIGGER performance_preserve_page BEFORE UPDATE ON domino_performance.pages
 FOR EACH ROW EXECUTE FUNCTION domino_performance.preserve_page();
DROP TRIGGER IF EXISTS performance_preserve_receipt ON domino_performance.receipts;
CREATE TRIGGER performance_preserve_receipt BEFORE UPDATE ON domino_performance.receipts
 FOR EACH ROW EXECUTE FUNCTION domino_performance.preserve_inclusion();
DROP TRIGGER IF EXISTS performance_preserve_event ON domino_performance.events;
CREATE TRIGGER performance_preserve_event BEFORE UPDATE ON domino_performance.events
 FOR EACH ROW EXECUTE FUNCTION domino_performance.preserve_inclusion();

DO $$
DECLARE item text; account text; existing_schema text;
BEGIN
 FOREACH item IN ARRAY ARRAY['epochs','pages','receipts','events','transitions'] LOOP
  EXECUTE format('ALTER TABLE domino_performance.%I ENABLE ROW LEVEL SECURITY',item);
  EXECUTE format('ALTER TABLE domino_performance.%I FORCE ROW LEVEL SECURITY',item);
  EXECUTE format('DROP POLICY IF EXISTS performance_owner ON domino_performance.%I',item);
  EXECUTE format('CREATE POLICY performance_owner ON domino_performance.%I TO domino_performance_collector,domino_performance_reader USING(owner=current_setting(''domino.performance_owner'',true)) WITH CHECK(owner=current_setting(''domino.performance_owner'',true))',item);
 END LOOP;
 -- Do not make this private collector an auth/deposit/execution service. Revoke
 -- only its new roles; existing collaborators' schema grants remain unchanged.
 FOR existing_schema IN SELECT nspname FROM pg_namespace
   WHERE nspname IN ('domino_sessions','domino_wallet_access','domino_deposits','domino_execution','public') LOOP
  EXECUTE format('REVOKE ALL ON SCHEMA %I FROM domino_performance_collector,domino_performance_reader',existing_schema);
 END LOOP;
 FOR account IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'domino_%'
  AND rolname NOT IN ('domino_performance_collector','domino_performance_reader',current_user) LOOP
  EXECUTE format('REVOKE ALL ON SCHEMA domino_performance FROM %I',account);
 END LOOP;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA domino_performance FROM PUBLIC,domino_performance_collector,domino_performance_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA domino_performance TO domino_performance_collector,domino_performance_reader;
GRANT INSERT,UPDATE ON domino_performance.epochs,domino_performance.pages,
 domino_performance.receipts,domino_performance.events TO domino_performance_collector;
GRANT INSERT ON domino_performance.transitions TO domino_performance_collector;
ALTER DEFAULT PRIVILEGES IN SCHEMA domino_performance REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA domino_performance REVOKE ALL ON FUNCTIONS FROM PUBLIC;
