-- Automation cycle state beside the E5 execution store: pool fee evidence, one
-- scheduling row per admitted sequence, one record per evaluation/cycle, and
-- the publisher's signed-before-send journal. Explicit migration only: it
-- starts no worker, admits no sequence and reads no key. The intent row keeps
-- owning the plan; a cycle only points at it and at the observation it bound.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='domino_execution_publisher') THEN
  CREATE ROLE domino_execution_publisher NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='domino_execution_publisher' AND
  (rolsuper OR rolinherit OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)) OR
  EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='domino_execution_publisher')) THEN
  RAISE EXCEPTION 'execution_roles_must_be_isolated';
 END IF;
END $$;
GRANT USAGE ON SCHEMA domino_execution TO domino_execution_publisher;

-- Pool-wide fee growth and active liquidity at canonical blocks. Cumulative
-- counters run inside one epoch; a gap the sampler could not cover starts a
-- new epoch rather than inventing the missing interval. Global evidence, not
-- tenant data: every sequence on the pool reads the same rows.
CREATE TABLE domino_execution.pool_samples (
 pool_id text NOT NULL CHECK(pool_id ~ '^0x[0-9a-f]{64}$'),
 block_number numeric NOT NULL CHECK(block_number=trunc(block_number) AND block_number>=0 AND block_number<18446744073709551615),
 block_hash text NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),
 block_timestamp numeric NOT NULL CHECK(block_timestamp=trunc(block_timestamp) AND block_timestamp>=0 AND block_timestamp<18446744073709551615),
 epoch text NOT NULL CHECK(epoch ~ '^0x[0-9a-f]{64}$'),
 fee_growth0 numeric NOT NULL CHECK(fee_growth0=trunc(fee_growth0) AND fee_growth0>=0 AND fee_growth0<115792089237316195423570985008687907853269984665640564039457584007913129639936),
 fee_growth1 numeric NOT NULL CHECK(fee_growth1=trunc(fee_growth1) AND fee_growth1>=0 AND fee_growth1<115792089237316195423570985008687907853269984665640564039457584007913129639936),
 liquidity numeric NOT NULL CHECK(liquidity=trunc(liquidity) AND liquidity>=0 AND liquidity<340282366920938463463374607431768211456),
 tick integer NOT NULL CHECK(tick BETWEEN -887272 AND 887272),
 sqrt_price numeric NOT NULL CHECK(sqrt_price=trunc(sqrt_price) AND sqrt_price>0 AND sqrt_price<1461501637330902918203684832716283019655932542976),
 cumulative_fee0 numeric NOT NULL CHECK(cumulative_fee0=trunc(cumulative_fee0) AND cumulative_fee0>=0),
 cumulative_fee1 numeric NOT NULL CHECK(cumulative_fee1=trunc(cumulative_fee1) AND cumulative_fee1>=0),
 cumulative_liquidity_seconds numeric NOT NULL CHECK(cumulative_liquidity_seconds=trunc(cumulative_liquidity_seconds) AND cumulative_liquidity_seconds>=0),
 coverage_complete boolean NOT NULL,
 qualified boolean NOT NULL,
 evidence_id text NOT NULL CHECK(evidence_id ~ '^0x[0-9a-f]{64}$'),
 sampler_version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(pool_id,block_number)
);

-- One row per admitted sequence: the waiting interval the planner measures
-- against, the lease that keeps two workers from planning the same sequence,
-- and the backoff/suspension the scheduler honours. Tenant data.
CREATE TABLE domino_execution.sequence_state (
 owner text NOT NULL CHECK(owner ~ '^0x[0-9a-f]{40}$' AND owner<>'0x0000000000000000000000000000000000000000'),
 sequence_hash text PRIMARY KEY CHECK(sequence_hash ~ '^0x[0-9a-f]{64}$'),
 vault text NOT NULL CHECK(vault ~ '^0x[0-9a-f]{40}$'),
 pool_id text NOT NULL CHECK(pool_id ~ '^0x[0-9a-f]{64}$'),
 waiting_since numeric NOT NULL CHECK(waiting_since=trunc(waiting_since) AND waiting_since>=0),
 last_attempt_at numeric NOT NULL CHECK(last_attempt_at=trunc(last_attempt_at) AND last_attempt_at>=0),
 last_read_failed boolean NOT NULL DEFAULT false,
 suspended boolean NOT NULL DEFAULT false,
 suspension_reason text NOT NULL DEFAULT '' CHECK(suspension_reason ~ '^[a-z0-9_]{0,100}$'),
 next_due_at timestamptz NOT NULL DEFAULT 'epoch'::timestamptz,
 backoff_seconds integer NOT NULL DEFAULT 0 CHECK(backoff_seconds>=0),
 publication_window_start timestamptz,
 publications_in_window integer NOT NULL DEFAULT 0 CHECK(publications_in_window>=0),
 fence bigint NOT NULL DEFAULT 0 CHECK(fence>=0),
 worker_id uuid,
 lease_until timestamptz,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner,sequence_hash),
 CHECK((worker_id IS NULL)=(lease_until IS NULL)),
 CHECK(waiting_since<=last_attempt_at)
);

-- Every evaluation leaves a record, whether it waited or went on to act. The
-- decision column is the planner's sanitized summary (reasons, selected
-- candidate economics, waiting balances), never a plan or calldata.
CREATE TABLE domino_execution.cycles (
 cycle_id uuid PRIMARY KEY,
 owner text NOT NULL CHECK(owner ~ '^0x[0-9a-f]{40}$' AND owner<>'0x0000000000000000000000000000000000000000'),
 sequence_hash text NOT NULL CHECK(sequence_hash ~ '^0x[0-9a-f]{64}$'),
 state text NOT NULL CHECK(state IN ('evaluated','planned','reserved','publishing','published','executing','completed','abandoned')),
 reason text NOT NULL DEFAULT '' CHECK(reason ~ '^[a-z0-9_]{0,100}$'),
 config_version text NOT NULL CHECK(config_version ~ '^[A-Za-z0-9_.-]{1,64}$'),
 input_fingerprint text NOT NULL CHECK(input_fingerprint ~ '^0x[0-9a-f]{64}$'),
 observation_hash text NOT NULL CHECK(observation_hash ~ '^0x[0-9a-f]{64}$'),
 source_block_number numeric NOT NULL CHECK(source_block_number=trunc(source_block_number) AND source_block_number>=0),
 source_block_hash text NOT NULL CHECK(source_block_hash ~ '^0x[0-9a-f]{64}$'),
 decision jsonb NOT NULL CHECK(jsonb_typeof(decision)='object' AND octet_length(decision::text)<262144),
 intent_id text CHECK(intent_id ~ '^0x[0-9a-f]{64}$'),
 observation_id text CHECK(observation_id ~ '^0x[0-9a-f]{64}$'),
 cost jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(cost)='object' AND octet_length(cost::text)<16384),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner,cycle_id),
 FOREIGN KEY(owner,intent_id) REFERENCES domino_execution.intents(owner,intent_id),
 CHECK(state IN ('evaluated','abandoned') OR intent_id IS NOT NULL),
 CHECK(state NOT IN ('publishing','published','executing','completed') OR observation_id IS NOT NULL)
);
CREATE INDEX execution_cycles_sequence ON domino_execution.cycles(sequence_hash,created_at DESC);

-- The publisher's journal. A row exists only with its signed bytes: the
-- transaction is durable before any send, and a restart re-sends the same
-- bytes instead of publishing again. The observation id is the exact id the
-- guard will assign, computed from the same preimage, so two cycles that need
-- the same point on the same pool share one row and one transaction.
CREATE TABLE domino_execution.publications (
 observation_id text PRIMARY KEY CHECK(observation_id ~ '^0x[0-9a-f]{64}$'),
 guard text NOT NULL CHECK(guard ~ '^0x[0-9a-f]{40}$'),
 pool_id text NOT NULL CHECK(pool_id ~ '^0x[0-9a-f]{64}$'),
 block_number numeric NOT NULL CHECK(block_number=trunc(block_number) AND block_number>=0 AND block_number<18446744073709551615),
 block_hash text NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),
 block_timestamp numeric NOT NULL CHECK(block_timestamp=trunc(block_timestamp) AND block_timestamp>=0),
 expires_at numeric NOT NULL CHECK(expires_at=trunc(expires_at) AND expires_at>block_timestamp),
 sqrt_price numeric NOT NULL CHECK(sqrt_price=trunc(sqrt_price) AND sqrt_price>0),
 signer text NOT NULL CHECK(signer ~ '^0x[0-9a-f]{40}$'),
 nonce numeric NOT NULL CHECK(nonce=trunc(nonce) AND nonce>=0 AND nonce<18446744073709551615),
 envelope jsonb NOT NULL CHECK(jsonb_typeof(envelope)='object'),
 signed_bytes bytea NOT NULL CHECK(octet_length(signed_bytes) BETWEEN 1 AND 65536),
 transaction_hash text NOT NULL UNIQUE CHECK(transaction_hash ~ '^0x[0-9a-f]{64}$'),
 state text NOT NULL CHECK(state IN ('signed','submitted','broadcast_unknown','included','confirmed','reverted','reorged','expired','revoked','attention')),
 reason text NOT NULL DEFAULT '' CHECK(reason ~ '^[a-z0-9_]{0,100}$'),
 included_block_number numeric CHECK(included_block_number=trunc(included_block_number) AND included_block_number>=0),
 included_block_hash text CHECK(included_block_hash ~ '^0x[0-9a-f]{64}$'),
 gas_used numeric CHECK(gas_used=trunc(gas_used) AND gas_used>=0),
 effective_gas_price numeric CHECK(effective_gas_price=trunc(effective_gas_price) AND effective_gas_price>=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((included_block_number IS NULL)=(included_block_hash IS NULL))
);
CREATE UNIQUE INDEX execution_publisher_nonce ON domino_execution.publications(signer,nonce);
CREATE TABLE domino_execution.publisher_heads (
 chain_id integer NOT NULL CHECK(chain_id=4663), signer text NOT NULL CHECK(signer ~ '^0x[0-9a-f]{40}$'),
 next_nonce numeric NOT NULL CHECK(next_nonce=trunc(next_nonce) AND next_nonce>=0 AND next_nonce<18446744073709551615),
 PRIMARY KEY(chain_id,signer)
);
-- Operator switches the service honours before admitting work: a global pause
-- stops new cycles, never the reconciliation of what was already sent.
CREATE TABLE domino_execution.controls (
 key text PRIMARY KEY CHECK(key ~ '^[a-z0-9_]{1,64}$'),
 value jsonb NOT NULL CHECK(octet_length(value::text)<4096),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Same shape as live_fence for intents: the caller's worker and fence settings
-- must name the live lease of this sequence.
CREATE FUNCTION domino_execution.sequence_fence(identifier text) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,domino_execution AS $$
DECLARE r domino_execution.sequence_state;
BEGIN
  SELECT * INTO r FROM domino_execution.sequence_state WHERE sequence_hash=identifier
    AND owner=current_setting('domino.execution_owner',true) FOR UPDATE;
  IF NOT FOUND OR r.worker_id::text IS DISTINCT FROM current_setting('domino.execution_worker',true)
    OR r.fence::text IS DISTINCT FROM current_setting('domino.execution_fence',true)
    OR r.lease_until IS NULL OR r.lease_until<=clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_stale_fence';
  END IF;
END $$;
CREATE FUNCTION domino_execution.preserve_sequence_state() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,domino_execution AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.fence<>0 OR NEW.worker_id IS NOT NULL OR NEW.lease_until IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_state_conflict';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' OR NEW.owner<>OLD.owner OR NEW.sequence_hash<>OLD.sequence_hash OR NEW.vault<>OLD.vault OR NEW.pool_id<>OLD.pool_id THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_intent_immutable';
  END IF;
  IF NEW.fence IS DISTINCT FROM OLD.fence THEN
    -- Acquisition: one step, by the acquirer, only over an absent or expired lease.
    IF NEW.fence<>OLD.fence+1 OR NEW.worker_id IS NULL OR NEW.lease_until IS NULL
      OR NEW.lease_until<=clock_timestamp() OR NEW.lease_until>clock_timestamp()+interval '300 seconds'
      OR NEW.worker_id::text IS DISTINCT FROM current_setting('domino.execution_acquirer',true)
      OR (OLD.lease_until IS NOT NULL AND OLD.lease_until>clock_timestamp())
      OR (to_jsonb(NEW)-ARRAY['fence','worker_id','lease_until','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['fence','worker_id','lease_until','updated_at']) THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_stale_fence';
    END IF;
    RETURN NEW;
  END IF;
  -- Every other change, including releasing the lease, needs the live fence.
  PERFORM domino_execution.sequence_fence(OLD.sequence_hash);
  IF NEW.worker_id IS DISTINCT FROM OLD.worker_id AND NEW.worker_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_stale_fence';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER execution_sequence_state_guard BEFORE INSERT OR UPDATE OR DELETE ON domino_execution.sequence_state FOR EACH ROW EXECUTE FUNCTION domino_execution.preserve_sequence_state();

CREATE FUNCTION domino_execution.preserve_cycle() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,domino_execution AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_intent_immutable'; END IF;
  IF TG_OP='INSERT' THEN RETURN NEW; END IF;
  -- The evaluation and its bindings are written once. A cycle that bound an
  -- intent or an observation id cannot later point at another one.
  IF (to_jsonb(NEW)-ARRAY['state','reason','intent_id','observation_id','cost','updated_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','reason','intent_id','observation_id','cost','updated_at'])
    OR (OLD.intent_id IS NOT NULL AND NEW.intent_id IS DISTINCT FROM OLD.intent_id)
    OR (OLD.observation_id IS NOT NULL AND NEW.observation_id IS DISTINCT FROM OLD.observation_id)
    OR (OLD.state IN ('completed','abandoned') AND NEW.state<>OLD.state) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_intent_immutable';
  END IF;
  PERFORM domino_execution.sequence_fence(OLD.sequence_hash);
  RETURN NEW;
END $$;
CREATE TRIGGER execution_cycle_guard BEFORE INSERT OR UPDATE OR DELETE ON domino_execution.cycles FOR EACH ROW EXECUTE FUNCTION domino_execution.preserve_cycle();

CREATE FUNCTION domino_execution.preserve_publication() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,domino_execution AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_intent_immutable'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'signed' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_state_conflict'; END IF;
    RETURN NEW;
  END IF;
  -- Signed bytes, envelope, nonce and the point are the identity of the row.
  IF (to_jsonb(NEW)-ARRAY['state','reason','included_block_number','included_block_hash','gas_used','effective_gas_price','updated_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','reason','included_block_number','included_block_hash','gas_used','effective_gas_price','updated_at']) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_intent_immutable';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
      (OLD.state='signed' AND NEW.state IN ('submitted','broadcast_unknown','expired','attention'))
      OR (OLD.state IN ('submitted','broadcast_unknown') AND NEW.state IN ('submitted','broadcast_unknown','included','confirmed','reverted','expired','attention'))
      OR (OLD.state='included' AND NEW.state IN ('confirmed','reorged','revoked','expired'))
      OR (OLD.state='confirmed' AND NEW.state IN ('revoked','expired','reorged'))
      OR (OLD.state='reorged' AND NEW.state IN ('submitted','broadcast_unknown','included','confirmed','attention','expired'))) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_state_conflict';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER execution_publication_guard BEFORE INSERT OR UPDATE OR DELETE ON domino_execution.publications FOR EACH ROW EXECUTE FUNCTION domino_execution.preserve_publication();

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['pool_samples','sequence_state','cycles','publications','publisher_heads','controls'] LOOP
  EXECUTE format('ALTER TABLE domino_execution.%I OWNER TO domino_execution_owner',t);
  EXECUTE format('ALTER TABLE domino_execution.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE domino_execution.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON domino_execution.%I FROM PUBLIC',t);
 END LOOP;
 -- Tenant rows follow the intent store's owner setting.
 FOREACH t IN ARRAY ARRAY['sequence_state','cycles'] LOOP
  EXECUTE format('CREATE POLICY execution_tenant ON domino_execution.%I TO domino_execution_worker USING(owner=current_setting(''domino.execution_owner'',true)) WITH CHECK(owner=current_setting(''domino.execution_owner'',true))',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON domino_execution.%I TO domino_execution_worker',t);
 END LOOP;
 -- Pool evidence and operator controls are shared by every tenant's worker.
 FOREACH t IN ARRAY ARRAY['pool_samples','controls'] LOOP
  EXECUTE format('CREATE POLICY execution_shared ON domino_execution.%I TO domino_execution_worker USING(true) WITH CHECK(true)',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON domino_execution.%I TO domino_execution_worker',t);
 END LOOP;
END $$;
-- The publisher owns its journal; the worker may only read publication state.
CREATE POLICY execution_publisher ON domino_execution.publications TO domino_execution_publisher USING(true) WITH CHECK(true);
CREATE POLICY execution_publisher_head ON domino_execution.publisher_heads TO domino_execution_publisher USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE ON domino_execution.publications,domino_execution.publisher_heads TO domino_execution_publisher;
CREATE POLICY execution_worker_publication ON domino_execution.publications TO domino_execution_worker USING(true);
GRANT SELECT(observation_id,guard,pool_id,block_number,block_hash,block_timestamp,expires_at,sqrt_price,signer,transaction_hash,state,reason,included_block_number,included_block_hash,gas_used,effective_gas_price,created_at,updated_at)
 ON domino_execution.publications TO domino_execution_worker;
GRANT EXECUTE ON FUNCTION domino_execution.sequence_fence(text) TO domino_execution_worker;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA domino_execution FROM PUBLIC;
