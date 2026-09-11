-- Reclaim expired, never-issued work even when its owner never returns.
-- Keep 010 immutable: existing installations upgrade through this replacement.
DO $$
DECLARE maintenance_owner oid;
BEGIN
 SELECT relowner INTO maintenance_owner FROM pg_class
 WHERE oid='domino_deposits.intents'::regclass;
 IF maintenance_owner<>(SELECT oid FROM pg_roles WHERE rolname=current_user)
    OR pg_has_role('domino_deposit_service',maintenance_owner,'MEMBER')
    OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='domino_deposits'
        AND p.proname IN ('reserve_capacity','release_capacity','expire_unissued')
        AND p.proowner<>maintenance_owner) THEN
   RAISE EXCEPTION 'deposit_maintenance_owner_required';
 END IF;
END
$$;

-- Separate indexes bound both oldest-first maintenance and active-slot rescue.
CREATE INDEX IF NOT EXISTS deposits_unissued_retention
 ON domino_deposits.intents(created_at,id)
 WHERE NOT outstanding AND history='[]'::jsonb AND state IN ('draft','cancelled');
CREATE INDEX IF NOT EXISTS deposits_unissued_active_retention
 ON domino_deposits.intents(created_at,id)
 WHERE NOT outstanding AND history='[]'::jsonb AND state='draft';

CREATE OR REPLACE FUNCTION domino_deposits.expire_unissued() RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,domino_deposits AS $$
DECLARE removed integer; caller text; cutoff timestamptz; selected uuid;
        expired uuid[] := ARRAY[]::uuid[];
BEGIN
 caller := current_setting('domino.deposit_owner',true);
 IF caller IS NULL OR caller !~ '^0x[0-9a-f]{40}$' THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='deposit_owner_context_required';
 END IF;
 PERFORM pg_advisory_xact_lock(19227491692793935);
 cutoff := clock_timestamp()-interval '7 days';

 -- Reserve one slot for the caller's quota. Prefer an expired active draft so
 -- that reclaiming a cancelled row alone cannot leave its active quota full.
 SELECT id INTO selected FROM domino_deposits.intents
 WHERE owner=caller AND NOT outstanding AND history='[]'::jsonb
   AND state IN ('draft','cancelled') AND created_at<cutoff
 ORDER BY (state='draft') DESC,created_at,id LIMIT 1 FOR UPDATE;
 IF selected IS NOT NULL THEN expired := array_append(expired,selected); END IF;

 -- Reserve one global active slot. Otherwise older cancelled rows can consume
 -- the whole batch, fail admission at 10,000 active, and roll back all cleanup.
 SELECT id INTO selected FROM domino_deposits.intents
 WHERE NOT outstanding AND history='[]'::jsonb AND state='draft'
   AND created_at<cutoff AND NOT (id=ANY(expired))
 ORDER BY created_at,id LIMIT 1 FOR UPDATE;
 IF selected IS NOT NULL THEN expired := array_append(expired,selected); END IF;

 -- The remaining slots always advance oldest-first across every owner, so
 -- cancelled history also progresses. All three selections total at most 32.
 expired := expired || ARRAY(
   SELECT id FROM domino_deposits.intents
   WHERE NOT outstanding AND history='[]'::jsonb AND state IN ('draft','cancelled')
     AND created_at<cutoff AND NOT (id=ANY(expired))
   ORDER BY created_at,id LIMIT (32-cardinality(expired)) FOR UPDATE);
 DELETE FROM domino_deposits.intents WHERE id=ANY(expired);
 GET DIAGNOSTICS removed=ROW_COUNT;
 RETURN removed;
END
$$;
REVOKE ALL ON FUNCTION domino_deposits.expire_unissued() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domino_deposits.expire_unissued() TO domino_deposit_service;
-- 010's release trigger updates both counters in this transaction. No DELETE
-- privilege is added to the application; issued history still needs the
-- explicit durable operator archive after 90 days, within the 50,000-row cap.
