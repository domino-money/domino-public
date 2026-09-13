-- E5 foundation only. No signed/broadcast/reconciled state or transaction bytes.
-- These group roles are deliberately NOLOGIN; credential provisioning is separate.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='domino_execution_owner') THEN
    CREATE ROLE domino_execution_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='domino_execution_worker') THEN
    CREATE ROLE domino_execution_worker NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='domino_execution_ledger') THEN
    CREATE ROLE domino_execution_ledger NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('domino_execution_owner','domino_execution_worker','domino_execution_ledger')
      AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication OR rolinherit))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member IN (SELECT oid FROM pg_roles WHERE rolname IN ('domino_execution_owner','domino_execution_worker','domino_execution_ledger'))) THEN
    RAISE EXCEPTION 'execution_roles_must_be_isolated';
  END IF;
END $$;
CREATE SCHEMA domino_execution AUTHORIZATION domino_execution_owner;
REVOKE ALL ON SCHEMA domino_execution FROM PUBLIC;
GRANT USAGE ON SCHEMA domino_execution TO domino_execution_worker,domino_execution_ledger;

CREATE TABLE domino_execution.origins (
  origin_id text PRIMARY KEY CHECK(origin_id ~ '^0x[0-9a-f]{64}$'),
  owner text NOT NULL CHECK(owner ~ '^0x[0-9a-f]{40}$' AND owner<>'0x0000000000000000000000000000000000000000'),
  sequence_hash text NOT NULL CHECK(sequence_hash ~ '^0x[0-9a-f]{64}$'),
  source_id text NOT NULL CHECK(source_id ~ '^0x[0-9a-f]{64}$'),
  lot_id text NOT NULL UNIQUE CHECK(lot_id ~ '^0x[0-9a-f]{64}$'),
  currency text NOT NULL CHECK(currency ~ '^0x[0-9a-f]{40}$'),
  kind text NOT NULL CHECK(kind IN ('original','converted')),
  transaction_hash text NOT NULL CHECK(transaction_hash ~ '^0x[0-9a-f]{64}$'),
  event_index bigint NOT NULL CHECK(event_index BETWEEN 0 AND 4294967295),
  amount_raw numeric NOT NULL CHECK(amount_raw=trunc(amount_raw) AND amount_raw>=0 AND amount_raw<340282366920938463463374607431768211456),
  state text NOT NULL CHECK(state IN ('available','quarantined')),
  source_record jsonb NOT NULL CHECK(jsonb_typeof(source_record)='object' AND octet_length(source_record::text)<2048),
  evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<1048576),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(owner,lot_id), UNIQUE(owner,origin_id),
  CHECK(kind='original' OR state='quarantined'),
  CHECK(source_record->>'sequence'=sequence_hash),
  CHECK(kind<>'original' OR source_record->>'currency'=currency)
);
-- A re-inclusion or changed payload cannot manufacture a second credit/fragment.
CREATE UNIQUE INDEX execution_original_receipt ON domino_execution.origins(source_id,transaction_hash,event_index) WHERE kind='original';
CREATE UNIQUE INDEX execution_converted_receipt ON domino_execution.origins(source_id,transaction_hash,event_index,currency) WHERE kind='converted';
CREATE TABLE domino_execution.converted_inputs (
  owner text NOT NULL,
  origin_id text NOT NULL,
  input_lot_id text NOT NULL,
  amount_raw numeric NOT NULL CHECK(amount_raw=trunc(amount_raw) AND amount_raw>0 AND amount_raw<340282366920938463463374607431768211456),
  PRIMARY KEY(origin_id,input_lot_id),
  FOREIGN KEY(owner,origin_id) REFERENCES domino_execution.origins(owner,origin_id),
  FOREIGN KEY(owner,input_lot_id) REFERENCES domino_execution.origins(owner,lot_id)
);
CREATE TABLE domino_execution.intents (
  intent_id text PRIMARY KEY CHECK(intent_id ~ '^0x[0-9a-f]{64}$'),
  owner text NOT NULL CHECK(owner ~ '^0x[0-9a-f]{40}$' AND owner<>'0x0000000000000000000000000000000000000000'),
  sequence_hash text NOT NULL CHECK(sequence_hash ~ '^0x[0-9a-f]{64}$'),
  chain_id integer NOT NULL CHECK(chain_id=4663),
  model_version text NOT NULL,
  plan jsonb NOT NULL CHECK(jsonb_typeof(plan)='object' AND octet_length(plan::text)<1048576),
  observation jsonb NOT NULL CHECK(jsonb_typeof(observation)='object' AND octet_length(observation::text)<4194304),
  commitments jsonb NOT NULL CHECK(jsonb_typeof(commitments)='object' AND octet_length(commitments::text)<1048576),
  state text NOT NULL DEFAULT 'planned' CHECK(state IN ('planned','reserved','cancelled')),
  fence bigint NOT NULL DEFAULT 0 CHECK(fence>=0),
  worker_id uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(owner,intent_id),
  CHECK((worker_id IS NULL)=(lease_until IS NULL)),
  CHECK(plan->'sequence'->>'owner'=owner),
  CHECK(plan->'sequence'->>'chainId'='4663'),
  CHECK(observation->'sequence'=plan->'sequence')
);
CREATE TABLE domino_execution.lot_claims (
  owner text NOT NULL,
  intent_id text NOT NULL,
  lot_id text NOT NULL,
  amount_raw numeric NOT NULL CHECK(amount_raw=trunc(amount_raw) AND amount_raw>0 AND amount_raw<340282366920938463463374607431768211456),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY(intent_id,lot_id),
  FOREIGN KEY(owner,intent_id) REFERENCES domino_execution.intents(owner,intent_id),
  FOREIGN KEY(owner,lot_id) REFERENCES domino_execution.origins(owner,lot_id)
);
CREATE TABLE domino_execution.source_claims (
  owner text NOT NULL,
  intent_id text NOT NULL,
  source_id text NOT NULL CHECK(source_id ~ '^0x[0-9a-f]{64}$'),
  checkpoint_id text NOT NULL CHECK(checkpoint_id ~ '^0x[0-9a-f]{64}$'),
  amount_raw numeric NOT NULL CHECK(amount_raw=trunc(amount_raw) AND amount_raw>0 AND amount_raw<340282366920938463463374607431768211456),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY(intent_id,source_id),
  FOREIGN KEY(owner,intent_id) REFERENCES domino_execution.intents(owner,intent_id)
);
CREATE UNIQUE INDEX execution_one_collection ON domino_execution.source_claims(source_id) WHERE active;
CREATE TABLE domino_execution.successor_claims (
  owner text NOT NULL,
  intent_id text NOT NULL,
  successor_id text NOT NULL CHECK(successor_id ~ '^0x[0-9a-f]{64}$'),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY(intent_id),
  FOREIGN KEY(owner,intent_id) REFERENCES domino_execution.intents(owner,intent_id)
);
CREATE UNIQUE INDEX execution_one_successor ON domino_execution.successor_claims(successor_id) WHERE active;
CREATE TABLE domino_execution.nonce_claims (
  owner text NOT NULL,
  intent_id text NOT NULL,
  chain_id integer NOT NULL CHECK(chain_id=4663),
  signer text NOT NULL CHECK(signer ~ '^0x[0-9a-f]{40}$' AND signer<>'0x0000000000000000000000000000000000000000'),
  nonce numeric NOT NULL CHECK(nonce=trunc(nonce) AND nonce>=0 AND nonce<18446744073709551615),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY(intent_id),
  FOREIGN KEY(owner,intent_id) REFERENCES domino_execution.intents(owner,intent_id)
);
-- This is GLOBAL, despite tenant RLS. Cancelled claims remain immutable history.
CREATE UNIQUE INDEX execution_global_signer_nonce ON domino_execution.nonce_claims(chain_id,signer,nonce) WHERE active;

CREATE FUNCTION domino_execution.preserve_origin() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,domino_execution AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state')
    OR OLD.state='quarantined' OR NEW.state<>'quarantined' THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_origin_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER execution_origin_immutable BEFORE UPDATE OR DELETE ON domino_execution.origins FOR EACH ROW EXECUTE FUNCTION domino_execution.preserve_origin();

CREATE FUNCTION domino_execution.live_fence(identifier text) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,domino_execution AS $$
DECLARE r domino_execution.intents;
BEGIN
  SELECT * INTO r FROM domino_execution.intents WHERE intent_id=identifier
    AND owner=current_setting('domino.execution_owner',true) FOR UPDATE;
  IF NOT FOUND OR r.worker_id::text IS DISTINCT FROM current_setting('domino.execution_worker',true)
    OR r.fence::text IS DISTINCT FROM current_setting('domino.execution_fence',true)
    OR r.lease_until IS NULL OR r.lease_until<=clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_stale_fence';
  END IF;
END $$;
CREATE FUNCTION domino_execution.preserve_intent() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,domino_execution AS $$
DECLARE work_changed boolean;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'planned' OR NEW.fence<>0 OR NEW.worker_id IS NOT NULL OR NEW.lease_until IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_state_conflict';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['state','fence','worker_id','lease_until'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','fence','worker_id','lease_until']) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_intent_immutable';
  END IF;
  IF OLD.state='cancelled' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_state_conflict'; END IF;
  work_changed := ROW(NEW.fence,NEW.worker_id,NEW.lease_until) IS DISTINCT FROM ROW(OLD.fence,OLD.worker_id,OLD.lease_until);
  IF work_changed THEN
    IF NEW.state<>OLD.state OR NEW.lease_until IS NULL OR NEW.lease_until<=clock_timestamp()
      OR NEW.lease_until>clock_timestamp()+interval '300 seconds' THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_stale_fence';
    END IF;
    IF NEW.fence IS DISTINCT FROM OLD.fence THEN
      -- A new lease never steals a live one. Acquiring identity is trusted
      -- worker context; the worker cannot keep or choose a previous fence.
      IF NEW.fence<>OLD.fence+1 OR NEW.worker_id::text IS DISTINCT FROM current_setting('domino.execution_acquirer',true)
        OR (OLD.lease_until IS NOT NULL AND OLD.lease_until>clock_timestamp()) THEN
        RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_stale_fence';
      END IF;
    ELSE
      IF NEW.worker_id IS DISTINCT FROM OLD.worker_id THEN
        RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_stale_fence';
      END IF;
      PERFORM domino_execution.live_fence(OLD.intent_id);
    END IF;
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    PERFORM domino_execution.live_fence(OLD.intent_id);
    IF NOT ((OLD.state='planned' AND NEW.state IN ('reserved','cancelled')) OR (OLD.state='reserved' AND NEW.state='cancelled')) THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_state_conflict';
    END IF;
    IF NEW.state='reserved' AND (
      (SELECT count(*) FROM domino_execution.lot_claims WHERE intent_id=OLD.intent_id AND active)<>jsonb_array_length(OLD.plan->'allocations')
      OR (SELECT count(*) FROM domino_execution.source_claims WHERE intent_id=OLD.intent_id AND active)<>jsonb_array_length(OLD.plan->'collections')
      OR (SELECT count(*) FROM domino_execution.successor_claims WHERE intent_id=OLD.intent_id AND active)<>(CASE WHEN OLD.plan->>'action'='3' THEN 1 ELSE 0 END)
    ) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_claim_mismatch'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER execution_intent_immutable BEFORE INSERT OR UPDATE OR DELETE ON domino_execution.intents FOR EACH ROW EXECUTE FUNCTION domino_execution.preserve_intent();

CREATE FUNCTION domino_execution.guard_claim() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,domino_execution AS $$
DECLARE i domino_execution.intents; o domino_execution.origins; used numeric;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_claim_immutable'; END IF;
  PERFORM domino_execution.live_fence(NEW.intent_id);
  SELECT * INTO i FROM domino_execution.intents WHERE intent_id=NEW.intent_id;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-'active') IS DISTINCT FROM (to_jsonb(OLD)-'active') OR NOT OLD.active OR NEW.active OR i.state<>'cancelled' THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_claim_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT NEW.active OR i.state<>(CASE WHEN TG_TABLE_NAME='nonce_claims' THEN 'reserved' ELSE 'planned' END) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_state_conflict';
  END IF;
  IF TG_TABLE_NAME='lot_claims' THEN
    SELECT * INTO o FROM domino_execution.origins WHERE owner=NEW.owner AND lot_id=NEW.lot_id FOR UPDATE;
    IF NOT FOUND OR o.state<>'available' OR o.sequence_hash<>i.sequence_hash THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_origin_unavailable';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(i.plan->'allocations') a WHERE a->>'lotId'=NEW.lot_id AND (a->>'amountRaw')::numeric=NEW.amount_raw) THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_claim_mismatch';
    END IF;
    SELECT coalesce(sum(amount_raw),0) INTO used FROM domino_execution.lot_claims WHERE lot_id=NEW.lot_id AND active;
    IF used+NEW.amount_raw>o.amount_raw THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_balance_reserved'; END IF;
  ELSIF TG_TABLE_NAME='source_claims' THEN
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(i.plan->'collections') a WHERE a->>'sourceId'=NEW.source_id AND (a->>'maxGrossRaw')::numeric=NEW.amount_raw)
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(i.commitments->'collections') a
        WHERE a->>'sourceId'=NEW.source_id AND a->>'checkpointId'=NEW.checkpoint_id AND (a->>'amountRaw')::numeric=NEW.amount_raw) THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_claim_mismatch';
    END IF;
  ELSIF TG_TABLE_NAME='successor_claims' THEN
    IF i.plan->>'action'<>'3' OR NEW.successor_id IS DISTINCT FROM i.commitments->>'successorId' THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_claim_mismatch';
    END IF;
  ELSIF TG_TABLE_NAME='nonce_claims' THEN
    IF NEW.chain_id<>i.chain_id THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_claim_mismatch'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION domino_execution.guard_converted_input() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,domino_execution AS $$
DECLARE output domino_execution.origins; input domino_execution.origins;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_origin_immutable'; END IF;
  SELECT * INTO output FROM domino_execution.origins WHERE owner=NEW.owner AND origin_id=NEW.origin_id;
  SELECT * INTO input FROM domino_execution.origins WHERE owner=NEW.owner AND lot_id=NEW.input_lot_id;
  IF output.kind<>'converted' OR output.source_id<>input.source_id OR output.sequence_hash<>input.sequence_hash
    OR NEW.amount_raw>input.amount_raw OR output.lot_id=input.lot_id
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(output.evidence->'lineage'->'inputAllocations') a
      WHERE a->>'lotId'=NEW.input_lot_id AND (a->>'amountRaw')::numeric=NEW.amount_raw) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_lineage_mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER execution_converted_input BEFORE INSERT OR UPDATE OR DELETE ON domino_execution.converted_inputs FOR EACH ROW EXECUTE FUNCTION domino_execution.guard_converted_input();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['origins','converted_inputs','intents','lot_claims','source_claims','successor_claims','nonce_claims'] LOOP
    EXECUTE format('ALTER TABLE domino_execution.%I OWNER TO domino_execution_owner',t);
    EXECUTE format('ALTER TABLE domino_execution.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE domino_execution.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY execution_tenant ON domino_execution.%I TO domino_execution_worker,domino_execution_ledger USING(owner=current_setting(''domino.execution_owner'',true)) WITH CHECK(owner=current_setting(''domino.execution_owner'',true))',t);
    EXECUTE format('REVOKE ALL ON domino_execution.%I FROM PUBLIC',t);
    IF t LIKE '%_claims' THEN
      EXECUTE format('CREATE TRIGGER execution_claim_guard BEFORE INSERT OR UPDATE OR DELETE ON domino_execution.%I FOR EACH ROW EXECUTE FUNCTION domino_execution.guard_claim()',t);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA domino_execution FROM PUBLIC;
GRANT SELECT ON ALL TABLES IN SCHEMA domino_execution TO domino_execution_worker,domino_execution_ledger;
GRANT INSERT,UPDATE ON domino_execution.origins TO domino_execution_ledger;
GRANT INSERT ON domino_execution.converted_inputs TO domino_execution_ledger;
GRANT INSERT,UPDATE ON domino_execution.intents,domino_execution.lot_claims,domino_execution.source_claims,domino_execution.successor_claims,domino_execution.nonce_claims TO domino_execution_worker;
-- Trigger helpers run as invoker; no SECURITY DEFINER or alternate owner bypass.
GRANT EXECUTE ON FUNCTION domino_execution.live_fence(text) TO domino_execution_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE domino_execution_owner IN SCHEMA domino_execution REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE domino_execution_owner IN SCHEMA domino_execution REVOKE ALL ON FUNCTIONS FROM PUBLIC;
-- PostgreSQL requires UPDATE privilege for row locks. Only the quarantine field
-- is grantable; its trigger rejects re-enabling, identity changes and deletion.
GRANT UPDATE(state) ON domino_execution.origins TO domino_execution_worker;
