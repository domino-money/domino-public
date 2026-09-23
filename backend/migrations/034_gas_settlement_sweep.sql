-- Durable, bounded rotation over unsettled gas claims. The settlement role
-- learns only the claim identity and (for an operator leg) the intent owner.
-- A cursor advances before network reads; a crash cannot erase a claim, and
-- wrapping the cursor retries pending and reorged receipts on a later pass.
CREATE POLICY gas_budget_owner_intent_lookup ON domino_execution.intents
 FOR SELECT TO domino_execution_owner USING(true);

CREATE TABLE domino_gas_budget.sweep_cursor (
 id smallint PRIMARY KEY CHECK(id=1),
 last_created_at timestamptz,
 last_cycle_id text,
 last_leg text,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((last_created_at IS NULL AND last_cycle_id IS NULL AND last_leg IS NULL) OR
       (last_created_at IS NOT NULL AND last_cycle_id ~ '^0x[0-9a-f]{64}$' AND
        last_leg IN ('publisher','operator')))
);
ALTER TABLE domino_gas_budget.sweep_cursor OWNER TO domino_execution_owner;
INSERT INTO domino_gas_budget.sweep_cursor(id) VALUES(1);
REVOKE ALL ON domino_gas_budget.sweep_cursor FROM PUBLIC;
CREATE INDEX gas_budget_pending_scan ON domino_gas_budget.claims
 (created_at,cycle_id,leg) WHERE state='reserved';

CREATE FUNCTION domino_gas_budget.next_pending(p_limit integer)
RETURNS TABLE(cycle_id text,leg text,owner text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,domino_gas_budget AS $$
DECLARE marker domino_gas_budget.sweep_cursor; target record;
        last_at timestamptz; last_id text; last_kind text;
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>32 THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='gas_settlement_limit_invalid';
 END IF;
 PERFORM pg_advisory_xact_lock(4663,29);
 SELECT * INTO marker FROM domino_gas_budget.sweep_cursor WHERE id=1 FOR UPDATE;
 IF NOT FOUND THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='gas_settlement_cursor_missing';
 END IF;
 -- Wrap once the suffix is empty. Reservations arriving during this call are
 -- left pending and become visible on a later invocation.
 IF marker.last_created_at IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM domino_gas_budget.claims c WHERE c.state='reserved' AND
    (c.created_at,c.cycle_id,c.leg)>
    (marker.last_created_at,marker.last_cycle_id,marker.last_leg)) THEN
  marker.last_created_at:=NULL;
  marker.last_cycle_id:=NULL;
  marker.last_leg:=NULL;
 END IF;
 FOR target IN
  SELECT c.cycle_id,c.leg,i.owner AS intent_owner,c.created_at
   FROM domino_gas_budget.claims c
   LEFT JOIN domino_execution.intents i ON c.leg='operator' AND i.intent_id=c.cycle_id
   WHERE c.state='reserved' AND
    (marker.last_created_at IS NULL OR
     (c.created_at,c.cycle_id,c.leg)>
      (marker.last_created_at,marker.last_cycle_id,marker.last_leg))
   ORDER BY c.created_at,c.cycle_id,c.leg LIMIT p_limit
 LOOP
  cycle_id:=target.cycle_id;
  leg:=target.leg;
  owner:=target.intent_owner;
  last_at:=target.created_at;
  last_id:=target.cycle_id;
  last_kind:=target.leg;
  RETURN NEXT;
 END LOOP;
 IF last_at IS NOT NULL THEN
  UPDATE domino_gas_budget.sweep_cursor SET
   last_created_at=last_at,last_cycle_id=last_id,last_leg=last_kind,
   updated_at=clock_timestamp() WHERE id=1;
 END IF;
END $$;
ALTER FUNCTION domino_gas_budget.next_pending(integer) OWNER TO domino_execution_owner;
REVOKE ALL ON FUNCTION domino_gas_budget.next_pending(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domino_gas_budget.next_pending(integer)
 TO domino_gas_settlement_worker;
