-- E5 signing/broadcast journal. Explicit migration only; no signer activation.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='domino_execution_signer') THEN
  CREATE ROLE domino_execution_signer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='domino_execution_signer' AND
  (rolsuper OR rolinherit OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)) OR
  EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='domino_execution_signer')) THEN
  RAISE EXCEPTION 'execution_roles_must_be_isolated';
 END IF;
END $$;
GRANT USAGE ON SCHEMA domino_execution TO domino_execution_signer;
-- Signer can lock existing rows and validate their fenced reservations. It
-- cannot create an intent, origin, successor, allocation or collection claim.
GRANT SELECT ON ALL TABLES IN SCHEMA domino_execution TO domino_execution_signer;
GRANT UPDATE(state) ON domino_execution.intents,domino_execution.origins TO domino_execution_signer;
GRANT INSERT ON domino_execution.nonce_claims TO domino_execution_signer;
GRANT EXECUTE ON FUNCTION domino_execution.live_fence(text) TO domino_execution_signer;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['origins','converted_inputs','intents','lot_claims','source_claims','successor_claims','nonce_claims'] LOOP
  EXECUTE format('CREATE POLICY execution_signer_tenant ON domino_execution.%I TO domino_execution_signer USING(owner=current_setting(''domino.execution_owner'',true)) WITH CHECK(owner=current_setting(''domino.execution_owner'',true))',t);
 END LOOP;
END $$;
CREATE TABLE domino_execution.signer_heads (
 chain_id integer NOT NULL CHECK(chain_id=4663), signer text NOT NULL CHECK(signer ~ '^0x[0-9a-f]{40}$'),
 next_nonce numeric NOT NULL CHECK(next_nonce=trunc(next_nonce) AND next_nonce>=0 AND next_nonce<18446744073709551615),
 PRIMARY KEY(chain_id,signer)
);
ALTER TABLE domino_execution.signer_heads OWNER TO domino_execution_owner;
ALTER TABLE domino_execution.signer_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE domino_execution.signer_heads FORCE ROW LEVEL SECURITY;
CREATE POLICY execution_global_head ON domino_execution.signer_heads TO domino_execution_signer USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE ON domino_execution.signer_heads TO domino_execution_signer;
CREATE TABLE domino_execution.journal (
 owner text NOT NULL, intent_id text PRIMARY KEY,
 state text NOT NULL CHECK(state IN ('signing','signed','submitted','broadcast_unknown','included','reconciled','reverted','attention','reorged')),
 reason text NOT NULL DEFAULT '', signer text NOT NULL CHECK(signer ~ '^0x[0-9a-f]{40}$'),
 nonce numeric NOT NULL CHECK(nonce=trunc(nonce) AND nonce>=0 AND nonce<18446744073709551615),
 action text NOT NULL, admission jsonb NOT NULL, envelope jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(owner,intent_id) REFERENCES domino_execution.intents(owner,intent_id)
);
CREATE TABLE domino_execution.attempts (
 owner text NOT NULL, intent_id text NOT NULL, ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 3),
 envelope jsonb NOT NULL, transaction_hash text NOT NULL UNIQUE CHECK(transaction_hash ~ '^0x[0-9a-f]{64}$'),
 signed_bytes bytea NOT NULL CHECK(octet_length(signed_bytes) BETWEEN 1 AND 65536),
 fence bigint NOT NULL CHECK(fence>0), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(intent_id,ordinal), FOREIGN KEY(owner,intent_id) REFERENCES domino_execution.intents(owner,intent_id)
);
CREATE TABLE domino_execution.effects (
 owner text NOT NULL, intent_id text PRIMARY KEY, transaction_hash text NOT NULL UNIQUE,
 block_number numeric NOT NULL CHECK(block_number=trunc(block_number) AND block_number>=0),
 block_hash text NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),
 canonical boolean NOT NULL, receipt jsonb NOT NULL CHECK(octet_length(receipt::text)<1048576),
 FOREIGN KEY(owner,intent_id) REFERENCES domino_execution.intents(owner,intent_id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['journal','attempts','effects'] LOOP
  EXECUTE format('ALTER TABLE domino_execution.%I OWNER TO domino_execution_owner',t);
  EXECUTE format('ALTER TABLE domino_execution.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE domino_execution.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY execution_signer ON domino_execution.%I TO domino_execution_signer USING(owner=current_setting(''domino.execution_owner'',true)) WITH CHECK(owner=current_setting(''domino.execution_owner'',true))',t);
  EXECUTE format('GRANT SELECT,INSERT ON domino_execution.%I TO domino_execution_signer',t);
  EXECUTE format('REVOKE ALL ON domino_execution.%I FROM PUBLIC',t);
 END LOOP;
END $$;
GRANT UPDATE(state,reason,updated_at) ON domino_execution.journal TO domino_execution_signer;
GRANT UPDATE(canonical,block_number,block_hash,receipt) ON domino_execution.effects TO domino_execution_signer;
-- Only sanitized projections leave the signer. Worker cannot read signed bytes.
GRANT SELECT ON domino_execution.journal TO domino_execution_worker;
CREATE POLICY execution_worker_journal ON domino_execution.journal TO domino_execution_worker
 USING(owner=current_setting('domino.execution_owner',true));
CREATE FUNCTION domino_execution.guard_signed_cancellation() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,domino_execution AS $$ BEGIN
 IF NEW.state='cancelled' AND EXISTS(SELECT 1 FROM domino_execution.journal WHERE intent_id=OLD.intent_id) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_state_conflict';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER execution_no_signed_cancellation BEFORE UPDATE ON domino_execution.intents
 FOR EACH ROW EXECUTE FUNCTION domino_execution.guard_signed_cancellation();
CREATE FUNCTION domino_execution.guard_journal() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,domino_execution AS $$ BEGIN
 PERFORM domino_execution.live_fence(NEW.intent_id);
 IF TG_OP='INSERT' AND (NEW.state<>'signing' OR NOT EXISTS(SELECT 1 FROM domino_execution.nonce_claims
  WHERE intent_id=NEW.intent_id AND signer=NEW.signer AND nonce=NEW.nonce AND active)) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_claim_mismatch';
 END IF;
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['state','reason','updated_at']) IS DISTINCT FROM
  (to_jsonb(OLD)-ARRAY['state','reason','updated_at']) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_intent_immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER execution_journal_guard BEFORE INSERT OR UPDATE ON domino_execution.journal
 FOR EACH ROW EXECUTE FUNCTION domino_execution.guard_journal();
CREATE FUNCTION domino_execution.guard_attempt() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,domino_execution AS $$ DECLARE j domino_execution.journal; BEGIN
 PERFORM domino_execution.live_fence(NEW.intent_id);
 SELECT * INTO j FROM domino_execution.journal WHERE intent_id=NEW.intent_id FOR UPDATE;
 IF NOT FOUND OR j.state NOT IN ('signing','signed','submitted','broadcast_unknown') OR
  NEW.fence::text IS DISTINCT FROM current_setting('domino.execution_fence',true) OR
  NEW.ordinal<>(SELECT count(*) FROM domino_execution.attempts WHERE intent_id=NEW.intent_id) OR
  (NEW.envelope-ARRAY['maxFeePerGas','maxPriorityFeePerGas']) IS DISTINCT FROM
  (j.envelope-ARRAY['maxFeePerGas','maxPriorityFeePerGas']) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_state_conflict';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER execution_attempt_guard BEFORE INSERT ON domino_execution.attempts
 FOR EACH ROW EXECUTE FUNCTION domino_execution.guard_attempt();
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA domino_execution FROM PUBLIC;
-- The authenticated status API has a separate read-only, tenant-filtered role.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='domino_execution_reader') THEN
  CREATE ROLE domino_execution_reader NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='domino_execution_reader' AND
  (rolsuper OR rolinherit OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)) OR
  EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='domino_execution_reader')) THEN
  RAISE EXCEPTION 'execution_roles_must_be_isolated';
 END IF;
END $$;
GRANT USAGE ON SCHEMA domino_execution TO domino_execution_reader;
GRANT SELECT(owner,intent_id,sequence_hash,state) ON domino_execution.intents TO domino_execution_reader;
GRANT SELECT(owner,intent_id,state,reason,signer,nonce) ON domino_execution.journal TO domino_execution_reader;
GRANT SELECT(owner,intent_id,ordinal,transaction_hash) ON domino_execution.attempts TO domino_execution_reader;
GRANT SELECT ON domino_execution.effects TO domino_execution_reader;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['intents','journal','attempts','effects'] LOOP
  EXECUTE format('CREATE POLICY execution_reader_tenant ON domino_execution.%I TO domino_execution_reader USING(owner=current_setting(''domino.execution_owner'',true))',t);
 END LOOP;
END $$;

-- Stable per-origin debits, separate from financial display effects. Reorgs do
-- not free fee money automatically; the sequence stays blocked for recovery.
CREATE TABLE domino_execution.spends (
 owner text NOT NULL, intent_id text NOT NULL, lot_id text NOT NULL,
 amount_raw numeric NOT NULL CHECK(amount_raw=trunc(amount_raw) AND amount_raw>0 AND amount_raw<340282366920938463463374607431768211456),
 PRIMARY KEY(intent_id,lot_id), FOREIGN KEY(owner,intent_id) REFERENCES domino_execution.intents(owner,intent_id),
 FOREIGN KEY(owner,lot_id) REFERENCES domino_execution.origins(owner,lot_id)
);
ALTER TABLE domino_execution.spends OWNER TO domino_execution_owner;
ALTER TABLE domino_execution.spends ENABLE ROW LEVEL SECURITY;
ALTER TABLE domino_execution.spends FORCE ROW LEVEL SECURITY;
CREATE POLICY execution_spends_tenant ON domino_execution.spends TO domino_execution_signer,domino_execution_worker,domino_execution_ledger
 USING(owner=current_setting('domino.execution_owner',true)) WITH CHECK(owner=current_setting('domino.execution_owner',true));
GRANT SELECT ON domino_execution.spends TO domino_execution_signer,domino_execution_worker,domino_execution_ledger;
-- Receipt application is in the restricted trusted reconciler code, which
-- fetches and verifies the canonical RPC effect; the public worker has no write.
GRANT INSERT ON domino_execution.spends,domino_execution.origins TO domino_execution_signer;
GRANT UPDATE(active) ON domino_execution.lot_claims,domino_execution.source_claims TO domino_execution_signer;
CREATE OR REPLACE FUNCTION domino_execution.guard_claim() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,domino_execution AS $$
DECLARE i domino_execution.intents; o domino_execution.origins; used numeric;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_claim_immutable'; END IF;
  PERFORM domino_execution.live_fence(NEW.intent_id);
  SELECT * INTO i FROM domino_execution.intents WHERE intent_id=NEW.intent_id;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-'active') IS DISTINCT FROM (to_jsonb(OLD)-'active') OR NOT OLD.active OR NEW.active OR NOT (i.state='cancelled' OR (TG_TABLE_NAME IN ('lot_claims','source_claims') AND (EXISTS(SELECT 1 FROM domino_execution.effects WHERE intent_id=NEW.intent_id AND canonical) OR EXISTS(SELECT 1 FROM domino_execution.journal WHERE intent_id=NEW.intent_id AND state='reverted')))) THEN
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
    SELECT used+coalesce(sum(amount_raw),0) INTO used FROM domino_execution.spends WHERE lot_id=NEW.lot_id;
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

CREATE FUNCTION domino_execution.guard_spend() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,domino_execution AS $$
DECLARE o domino_execution.origins; used numeric;
BEGIN
 PERFORM domino_execution.live_fence(NEW.intent_id);
 IF NOT EXISTS(SELECT 1 FROM domino_execution.effects WHERE intent_id=NEW.intent_id AND canonical) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_state_conflict';
 END IF;
 SELECT * INTO o FROM domino_execution.origins WHERE owner=NEW.owner AND lot_id=NEW.lot_id FOR UPDATE;
 SELECT coalesce(sum(amount_raw),0) INTO used FROM domino_execution.spends WHERE lot_id=NEW.lot_id;
 IF NOT FOUND OR o.state<>'available' OR used+NEW.amount_raw>o.amount_raw THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_balance_reserved';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER execution_spend_guard BEFORE INSERT ON domino_execution.spends FOR EACH ROW EXECUTE FUNCTION domino_execution.guard_spend();

-- E5 can qualify a NEW converted origin only in the same fenced transaction
-- as the verified canonical effect and original debits. The ledger's older
-- supplied conversions remain quarantined; there is no unquarantine shortcut.
DO $$ DECLARE constraint_name text; matches integer;
BEGIN
 SELECT count(*),min(conname) INTO matches,constraint_name FROM pg_constraint
 WHERE conrelid='domino_execution.origins'::regclass AND contype='c'
   AND pg_get_constraintdef(oid) LIKE '%kind = ''original''%state = ''quarantined''%';
 IF matches<>1 THEN RAISE EXCEPTION 'execution_origin_foundation_mismatch'; END IF;
 EXECUTE format('ALTER TABLE domino_execution.origins DROP CONSTRAINT %I',constraint_name);
END $$;
ALTER TABLE domino_execution.origins ADD COLUMN qualification_intent_id text;
ALTER TABLE domino_execution.origins ADD CONSTRAINT execution_conversion_qualification
 CHECK(kind='original' OR state='quarantined' OR qualification_intent_id IS NOT NULL);
ALTER TABLE domino_execution.origins ADD FOREIGN KEY(owner,qualification_intent_id)
 REFERENCES domino_execution.intents(owner,intent_id);
GRANT INSERT ON domino_execution.converted_inputs TO domino_execution_signer;
CREATE FUNCTION domino_execution.guard_qualified_conversion() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,domino_execution AS $$
DECLARE effect domino_execution.effects;
BEGIN
 IF NEW.kind='converted' AND NEW.state='available' THEN
  IF current_user<>'domino_execution_signer' OR NEW.qualification_intent_id IS NULL THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_lineage_mismatch';
  END IF;
  PERFORM domino_execution.live_fence(NEW.qualification_intent_id);
  SELECT * INTO effect FROM domino_execution.effects WHERE owner=NEW.owner
   AND intent_id=NEW.qualification_intent_id AND canonical AND transaction_hash=NEW.transaction_hash;
  IF NOT FOUND OR NEW.evidence->>'executionIntentId' IS DISTINCT FROM NEW.qualification_intent_id
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(effect.receipt->'conversions') c
      WHERE c->>'sourceId'=NEW.source_id AND c->>'currencyOut'=NEW.currency
       AND (c->>'receiptLogIndex')::bigint=NEW.event_index AND (c->>'amountOutRaw')::numeric=NEW.amount_raw)
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.evidence->'lineage'->'inputAllocations'))
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.evidence->'lineage'->'inputAllocations') a
      LEFT JOIN domino_execution.spends s ON s.owner=NEW.owner AND s.intent_id=NEW.qualification_intent_id
       AND s.lot_id=a->>'lotId' WHERE s.amount_raw IS NULL OR s.amount_raw<(a->>'amountRaw')::numeric) THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_lineage_mismatch';
  END IF;
 ELSIF NEW.qualification_intent_id IS NOT NULL THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_lineage_mismatch';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER execution_qualified_conversion BEFORE INSERT ON domino_execution.origins
 FOR EACH ROW EXECUTE FUNCTION domino_execution.guard_qualified_conversion();
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA domino_execution FROM PUBLIC;

GRANT SELECT(intent_id,canonical) ON domino_execution.effects TO domino_execution_worker;
CREATE POLICY execution_worker_effect_guard ON domino_execution.effects TO domino_execution_worker
 USING(owner=current_setting('domino.execution_owner',true));
