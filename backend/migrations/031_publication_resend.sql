-- A publication the node dropped after it was sent holds its nonce like one
-- that was never sent: the chain has not spent it, every later publication of
-- the key waits behind it, and a check may meanwhile retire the row as
-- expired. Its own persisted bytes are the only transaction signed for that
-- nonce, so the publisher sends them again; a late one reverts at the guard
-- and spends the nonce. The row is live again until its receipt says what the
-- chain made of those bytes. Explicit migration only: no table, no role, no key.

-- The publication guard lets an expired row be sent again. Otherwise verbatim from 028.
CREATE OR REPLACE FUNCTION domino_execution.preserve_publication() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,domino_execution AS $$
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
      OR (OLD.state='reorged' AND NEW.state IN ('submitted','broadcast_unknown','included','confirmed','attention','expired'))
      -- Sent again, the same bytes: only a send leaves expired.
      OR (OLD.state='expired' AND NEW.state IN ('submitted','broadcast_unknown'))) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_state_conflict';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA domino_execution FROM PUBLIC;
