-- Active admission and retained audit evidence have separate finite budgets.
-- FORCE RLS also applies to a non-superuser SECURITY DEFINER. Give only the
-- trusted DDL owner explicit maintenance SELECT/DELETE visibility; never make
-- the application a member of that role or grant application DELETE.
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
 DROP POLICY IF EXISTS deposit_maintenance_read ON domino_deposits.intents;
 DROP POLICY IF EXISTS deposit_maintenance_delete ON domino_deposits.intents;
 DROP POLICY IF EXISTS deposit_maintenance_lock ON domino_deposits.intents;
 EXECUTE format('CREATE POLICY deposit_maintenance_read ON domino_deposits.intents FOR SELECT TO %I USING (true)',current_user);
 EXECUTE format('CREATE POLICY deposit_maintenance_delete ON domino_deposits.intents FOR DELETE TO %I USING (true)',current_user);
 -- SELECT FOR UPDATE needs UPDATE visibility as well. Permit locks on existing
 -- rows, while rejecting every changed row image through this policy.
 EXECUTE format('CREATE POLICY deposit_maintenance_lock ON domino_deposits.intents FOR UPDATE TO %I USING (true) WITH CHECK (false)',current_user);
END
$$;
ALTER TABLE domino_deposits.intents DROP CONSTRAINT IF EXISTS intents_state_check;
ALTER TABLE domino_deposits.intents ADD CONSTRAINT intents_state_check CHECK
 (state IN ('draft','awaiting_wallet','pending','confirmed','reverted',
            'cancel_requested','cancelled','attention','superseded'));
ALTER TABLE domino_deposits.capacity ADD COLUMN IF NOT EXISTS retained integer NOT NULL DEFAULT 0;
ALTER TABLE domino_deposits.capacity DROP CONSTRAINT IF EXISTS capacity_used_check;
-- Reorgs must be recorded even when new-work admission is saturated.
ALTER TABLE domino_deposits.capacity ADD CONSTRAINT capacity_used_check CHECK(used>=0);
UPDATE domino_deposits.capacity SET
 used=(SELECT count(*) FROM domino_deposits.intents WHERE outstanding OR state IN
       ('draft','awaiting_wallet','pending','cancel_requested','attention')),
 retained=(SELECT count(*) FROM domino_deposits.intents);
ALTER TABLE domino_deposits.capacity DROP CONSTRAINT IF EXISTS capacity_retained_check;
ALTER TABLE domino_deposits.capacity ADD CONSTRAINT capacity_retained_check
 CHECK(retained>=used AND retained<=50000);
CREATE INDEX IF NOT EXISTS deposits_terminal_retention ON domino_deposits.intents(updated_at,id)
 WHERE NOT outstanding AND state IN ('confirmed','reverted','cancelled','superseded');

CREATE OR REPLACE FUNCTION domino_deposits.reserve_capacity() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,domino_deposits AS $$
DECLARE active_count integer; retained_count integer; new_active boolean;
BEGIN
 -- The same lock protects service writes, direct role writes and maintenance.
 PERFORM pg_advisory_xact_lock(19227491692793935);
 SELECT count(*),count(*) FILTER(WHERE outstanding OR state IN
   ('draft','awaiting_wallet','pending','cancel_requested','attention'))
 INTO retained_count,active_count FROM domino_deposits.intents WHERE owner=NEW.owner;
 IF retained_count>=128 THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='deposit_owner_history_full';
 END IF;
 new_active=NEW.outstanding OR NEW.state IN ('draft','awaiting_wallet','pending','cancel_requested','attention');
 IF new_active AND active_count>=16 THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='deposit_owner_capacity_busy';
 END IF;
 UPDATE domino_deposits.capacity SET used=used+new_active::integer,retained=retained+1
 WHERE singleton AND (NOT new_active OR used<10000) AND retained<50000;
 IF NOT FOUND THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='deposit_capacity_busy';
 END IF;
 RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION domino_deposits.release_capacity() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,domino_deposits AS $$
DECLARE old_active boolean; new_active boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(19227491692793935);
 old_active=OLD.outstanding OR OLD.state IN ('draft','awaiting_wallet','pending','cancel_requested','attention');
 IF TG_OP='DELETE' THEN
   UPDATE domino_deposits.capacity SET used=used-old_active::integer,retained=retained-1 WHERE singleton;
   RETURN OLD;
 END IF;
 new_active=NEW.outstanding OR NEW.state IN ('draft','awaiting_wallet','pending','cancel_requested','attention');
 UPDATE domino_deposits.capacity SET used=used+new_active::integer-old_active::integer WHERE singleton;
 RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION domino_deposits.reserve_capacity() FROM PUBLIC;
REVOKE ALL ON FUNCTION domino_deposits.release_capacity() FROM PUBLIC;
DROP TRIGGER IF EXISTS release_deposit_capacity ON domino_deposits.intents;
CREATE TRIGGER release_deposit_capacity AFTER UPDATE OR DELETE ON domino_deposits.intents
 FOR EACH ROW EXECUTE FUNCTION domino_deposits.release_capacity();

-- Only never-issued rows may be expired by the application. Cancellation of a
-- handed-off artifact cannot remove its evidence or release a nonce by timeout.
CREATE OR REPLACE FUNCTION domino_deposits.expire_unissued() RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,domino_deposits AS $$
DECLARE removed integer;
BEGIN
 PERFORM pg_advisory_xact_lock(19227491692793935);
 DELETE FROM domino_deposits.intents WHERE id IN (
   SELECT id FROM domino_deposits.intents
   WHERE owner=current_setting('domino.deposit_owner',true)
     AND NOT outstanding AND history='[]'::jsonb AND state IN ('draft','cancelled')
     AND created_at<clock_timestamp()-interval '7 days'
   ORDER BY created_at,id LIMIT 32 FOR UPDATE);
 GET DIAGNOSTICS removed=ROW_COUNT;
 RETURN removed;
END
$$;
REVOKE ALL ON FUNCTION domino_deposits.expire_unissued() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domino_deposits.expire_unissued() TO domino_deposit_service;
