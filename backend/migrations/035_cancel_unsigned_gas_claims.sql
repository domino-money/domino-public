-- Release only gas claims whose canonical signer path can no longer sign.
-- Keep an immutable tombstone: the same claim ID can never be reserved again.
-- This migration does not enable any service or grant table DML to a worker.
CREATE TABLE domino_gas_budget.cancelled_claims (
 cycle_id text NOT NULL CHECK(cycle_id ~ '^0x[0-9a-f]{64}$'),
 leg text NOT NULL CHECK(leg IN ('publisher','operator')),
 signer text NOT NULL CHECK(signer ~ '^0x[0-9a-f]{40}$'),
 day date NOT NULL,
 max_cost_wei numeric NOT NULL CHECK(max_cost_wei>0),
 reserved_usd_micros numeric NOT NULL CHECK(reserved_usd_micros>0),
 reason text NOT NULL CHECK(reason IN ('unsigned_cancelled_intent','unsigned_abandoned_cycles')),
 cancelled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(cycle_id,leg)
);
ALTER TABLE domino_gas_budget.cancelled_claims OWNER TO domino_execution_owner;
REVOKE ALL ON domino_gas_budget.cancelled_claims FROM PUBLIC;

CREATE FUNCTION domino_gas_budget.guard_cancelled_claim() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,domino_gas_budget AS $$
BEGIN
 RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='gas_cancellation_immutable';
END $$;
ALTER FUNCTION domino_gas_budget.guard_cancelled_claim() OWNER TO domino_execution_owner;
REVOKE ALL ON FUNCTION domino_gas_budget.guard_cancelled_claim() FROM PUBLIC;
CREATE TRIGGER gas_cancelled_claim_immutable BEFORE UPDATE OR DELETE
 ON domino_gas_budget.cancelled_claims FOR EACH ROW
 EXECUTE FUNCTION domino_gas_budget.guard_cancelled_claim();

CREATE FUNCTION domino_gas_budget.guard_claim_reuse() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,domino_gas_budget AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM domino_gas_budget.cancelled_claims t
           WHERE t.cycle_id=NEW.cycle_id AND t.leg=NEW.leg) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='gas_reservation_conflict';
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION domino_gas_budget.guard_claim_reuse() OWNER TO domino_execution_owner;
REVOKE ALL ON FUNCTION domino_gas_budget.guard_claim_reuse() FROM PUBLIC;
CREATE TRIGGER gas_claim_no_reuse BEFORE INSERT ON domino_gas_budget.claims
 FOR EACH ROW EXECUTE FUNCTION domino_gas_budget.guard_claim_reuse();

CREATE FUNCTION domino_gas_budget.guard_claim_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,domino_gas_budget AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM domino_gas_budget.cancelled_claims t
    WHERE t.cycle_id=OLD.cycle_id AND t.leg=OLD.leg AND t.signer=OLD.signer
      AND t.day=OLD.day AND t.max_cost_wei=OLD.max_cost_wei
      AND t.reserved_usd_micros=OLD.reserved_usd_micros) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='gas_cancellation_proof_missing';
 END IF;
 RETURN OLD;
END $$;
ALTER FUNCTION domino_gas_budget.guard_claim_delete() OWNER TO domino_execution_owner;
REVOKE ALL ON FUNCTION domino_gas_budget.guard_claim_delete() FROM PUBLIC;
CREATE TRIGGER gas_claim_proven_delete BEFORE DELETE ON domino_gas_budget.claims
 FOR EACH ROW EXECUTE FUNCTION domino_gas_budget.guard_claim_delete();

-- FORCE RLS is enabled on these journals. Only the schema owner executing the
-- function below receives this view; the settlement caller receives no rows.
CREATE POLICY gas_cancel_owner_journal ON domino_execution.journal
 FOR SELECT TO domino_execution_owner USING(true);
CREATE POLICY gas_cancel_owner_attempts ON domino_execution.attempts
 FOR SELECT TO domino_execution_owner USING(true);
CREATE POLICY gas_cancel_owner_cycles ON domino_execution.cycles
 FOR SELECT TO domino_execution_owner USING(true);
CREATE POLICY gas_cancel_owner_publications ON domino_execution.publications
 FOR SELECT TO domino_execution_owner USING(true);
-- PostgreSQL requires an UPDATE RLS policy for SELECT ... FOR UPDATE. The
-- definer may lock every intent, but WITH CHECK(false) prevents this policy
-- from authorizing an intent mutation.
CREATE POLICY gas_cancel_owner_intent_lock ON domino_execution.intents
 FOR UPDATE TO domino_execution_owner USING(true) WITH CHECK(false);

CREATE FUNCTION domino_gas_budget.cancel_unsigned(p_cycle_id text,p_leg text)
RETURNS TABLE(cancelled boolean,released_usd_micros numeric,reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,domino_gas_budget AS $$
DECLARE c domino_gas_budget.claims; i domino_execution.intents;
        proof_reason text;
BEGIN
 IF p_cycle_id IS NULL OR p_cycle_id !~ '^0x[0-9a-f]{64}$' OR
    p_leg IS NULL OR p_leg NOT IN ('publisher','operator') THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='gas_cancellation_invalid';
 END IF;
 IF p_leg='operator' THEN
  -- prepare() and persist_signed() hold this same row lock across their key
  -- boundary. A committed cancelled intent cannot enter either path later.
  SELECT * INTO i FROM domino_execution.intents
   WHERE intent_id=p_cycle_id FOR UPDATE;
  IF NOT FOUND OR i.state<>'cancelled' THEN
   RETURN QUERY SELECT false,0::numeric,'intent_not_terminal'::text;
   RETURN;
  END IF;
  IF EXISTS(SELECT 1 FROM domino_execution.journal j WHERE j.intent_id=p_cycle_id)
     OR EXISTS(SELECT 1 FROM domino_execution.attempts a WHERE a.intent_id=p_cycle_id) THEN
   RETURN QUERY SELECT false,0::numeric,'signing_or_signed'::text;
   RETURN;
  END IF;
  proof_reason:='unsigned_cancelled_intent';
 ELSE
  -- PublicationJournal.prepare() takes exactly this transaction advisory
  -- lock before signer.sign() and persists signed bytes before releasing it.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_cycle_id,0));
  IF EXISTS(SELECT 1 FROM domino_execution.publications p
            WHERE p.observation_id=p_cycle_id) THEN
   RETURN QUERY SELECT false,0::numeric,'signing_or_signed'::text;
   RETURN;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM domino_execution.cycles cy
                WHERE cy.observation_id=p_cycle_id)
     OR EXISTS(
      SELECT 1 FROM domino_execution.cycles cy
      LEFT JOIN domino_execution.intents ci ON ci.intent_id=cy.intent_id
      WHERE cy.observation_id=p_cycle_id AND
       (cy.state<>'abandoned' OR ci.intent_id IS NULL OR ci.state<>'cancelled'
        OR EXISTS(SELECT 1 FROM domino_execution.journal j
                  WHERE j.intent_id=cy.intent_id)
        OR EXISTS(SELECT 1 FROM domino_execution.attempts a
                  WHERE a.intent_id=cy.intent_id))) THEN
   RETURN QUERY SELECT false,0::numeric,'cycle_not_terminal'::text;
   RETURN;
  END IF;
  proof_reason:='unsigned_abandoned_cycles';
 END IF;
 -- reserve()/settle() take this lock before changing the shared-day total.
 -- It is acquired after the signer-specific lock to avoid deadlock with the
 -- operator signing path that may re-price a reserved claim.
 PERFORM pg_advisory_xact_lock(4663,28);
 SELECT * INTO c FROM domino_gas_budget.claims
  WHERE cycle_id=p_cycle_id AND leg=p_leg FOR UPDATE;
 IF NOT FOUND OR c.state<>'reserved' THEN
  RETURN QUERY SELECT false,0::numeric,'claim_not_reserved'::text;
  RETURN;
 END IF;
 INSERT INTO domino_gas_budget.cancelled_claims
  (cycle_id,leg,signer,day,max_cost_wei,reserved_usd_micros,reason)
 VALUES(c.cycle_id,c.leg,c.signer,c.day,c.max_cost_wei,c.reserved_usd_micros,
        proof_reason);
 DELETE FROM domino_gas_budget.claims
  WHERE cycle_id=p_cycle_id AND leg=p_leg;
 RETURN QUERY SELECT true,c.reserved_usd_micros,proof_reason;
END $$;
ALTER FUNCTION domino_gas_budget.cancel_unsigned(text,text)
 OWNER TO domino_execution_owner;
REVOKE ALL ON FUNCTION domino_gas_budget.cancel_unsigned(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domino_gas_budget.cancel_unsigned(text,text)
 TO domino_gas_settlement_worker;
