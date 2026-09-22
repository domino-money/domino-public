-- The rules the owner approved on 22 September 2026 for new, volatile tokens.
-- Every compound swap in a pool takes a share of one budget, fee x depth, that
-- all vaults on that pool share over a window of blocks: a sandwich pays for
-- the push and the restore, and the swaps it could exploit together stay below
-- that cost. A sequence also counts its consecutive failed attempts, for its
-- backoff and for the operator's expected cost. Explicit migration only: no
-- role, no service and no key.

-- One row per swap a cycle is about to persist. The share is in millionths of
-- the cap measured at the plan's source block; the sum over the window is
-- checked under a per-pool lock before the row is written. A reservation whose
-- intent was cancelled unsigned is released; a signed one stays until the
-- window passes it, whatever the execution's outcome. An intent holds at most
-- one live reservation; a released one does not stop the same plan, rebuilt
-- at the same block, from reserving again.
CREATE TABLE domino_execution.swap_exposure (
 reservation_id uuid PRIMARY KEY,
 intent_id text NOT NULL CHECK(intent_id ~ '^0x[0-9a-f]{64}$'),
 owner text NOT NULL CHECK(owner ~ '^0x[0-9a-f]{40}$' AND owner<>'0x0000000000000000000000000000000000000000'),
 sequence_hash text NOT NULL CHECK(sequence_hash ~ '^0x[0-9a-f]{64}$'),
 pool_id text NOT NULL CHECK(pool_id ~ '^0x[0-9a-f]{64}$'),
 block_number numeric NOT NULL CHECK(block_number=trunc(block_number) AND block_number>=0 AND block_number<18446744073709551615),
 zero_for_one boolean NOT NULL,
 amount_in numeric NOT NULL CHECK(amount_in=trunc(amount_in) AND amount_in>0 AND amount_in<340282366920938463463374607431768211456),
 cap_raw numeric NOT NULL CHECK(cap_raw=trunc(cap_raw) AND cap_raw>0),
 usage_ppm integer NOT NULL CHECK(usage_ppm BETWEEN 1 AND 1000000),
 released boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX execution_swap_exposure_live ON domino_execution.swap_exposure(intent_id) WHERE NOT released;
CREATE INDEX execution_swap_exposure_pool ON domino_execution.swap_exposure(pool_id,block_number) WHERE NOT released;

CREATE FUNCTION domino_execution.preserve_swap_exposure() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,domino_execution AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_intent_immutable'; END IF;
  IF TG_OP='INSERT' THEN
    PERFORM domino_execution.sequence_fence(NEW.sequence_hash);
    -- A share is taken live, by the lease holder, on its own sequence's pool;
    -- the row-level policy keeps the row's owner the tenant's.
    IF NEW.released OR NOT EXISTS(SELECT 1 FROM domino_execution.sequence_state WHERE sequence_hash=NEW.sequence_hash
        AND pool_id=NEW.pool_id) THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_state_conflict';
    END IF;
    RETURN NEW;
  END IF;
  -- The reservation is written once; it can only be released, once.
  IF (to_jsonb(NEW)-ARRAY['released','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['released','updated_at'])
    OR OLD.released OR NOT NEW.released THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_intent_immutable';
  END IF;
  PERFORM domino_execution.sequence_fence(OLD.sequence_hash);
  -- Only a share whose intent was never persisted or was cancelled goes back:
  -- a cancelled intent was never signed, and a signed one may still land.
  IF EXISTS(SELECT 1 FROM domino_execution.intents WHERE intent_id=OLD.intent_id AND state<>'cancelled') THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_state_conflict';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER execution_swap_exposure_guard BEFORE INSERT OR UPDATE OR DELETE ON domino_execution.swap_exposure FOR EACH ROW EXECUTE FUNCTION domino_execution.preserve_swap_exposure();

ALTER TABLE domino_execution.swap_exposure OWNER TO domino_execution_owner;
ALTER TABLE domino_execution.swap_exposure ENABLE ROW LEVEL SECURITY;
ALTER TABLE domino_execution.swap_exposure FORCE ROW LEVEL SECURITY;
REVOKE ALL ON domino_execution.swap_exposure FROM PUBLIC;
-- Every tenant's worker reads the whole pool's budget; it writes only its own rows.
CREATE POLICY execution_shared_read ON domino_execution.swap_exposure FOR SELECT TO domino_execution_worker USING(true);
CREATE POLICY execution_tenant_insert ON domino_execution.swap_exposure FOR INSERT TO domino_execution_worker
 WITH CHECK(owner=current_setting('domino.execution_owner',true));
CREATE POLICY execution_tenant_update ON domino_execution.swap_exposure FOR UPDATE TO domino_execution_worker
 USING(owner=current_setting('domino.execution_owner',true)) WITH CHECK(owner=current_setting('domino.execution_owner',true));
GRANT SELECT,INSERT ON domino_execution.swap_exposure TO domino_execution_worker;
GRANT UPDATE(released,updated_at) ON domino_execution.swap_exposure TO domino_execution_worker;

-- Consecutive attempts paid for and not completed; a completion resets it.
ALTER TABLE domino_execution.sequence_state ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0 CHECK(consecutive_failures>=0);
-- Every evaluation leaves a cycle row. The two lookups a pass makes on them,
-- the open cycle and the latest paid attempts, stay small as the table grows.
CREATE INDEX execution_cycles_open ON domino_execution.cycles(sequence_hash,created_at DESC)
 WHERE state NOT IN ('evaluated','completed','abandoned');
CREATE INDEX execution_cycles_paid ON domino_execution.cycles(sequence_hash,created_at DESC)
 WHERE cost->'publication' ? 'gasUsedRaw';
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA domino_execution FROM PUBLIC;
