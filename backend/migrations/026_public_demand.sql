-- Distinguish explicit user discovery from metadata dependencies. The initial
-- collector admitted dependencies as demand, so old interest cannot be trusted.
-- Reset that interest once, preserving every payload, link and ledger checkpoint.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='domino_public'
               AND table_name='entities' AND column_name='discovery_requested') THEN
  ALTER TABLE domino_public.entities ADD COLUMN discovery_requested boolean NOT NULL DEFAULT false;
  UPDATE domino_activity.pool_requests q SET last_requested_at='epoch'::timestamptz
   WHERE EXISTS(SELECT 1 FROM domino_public.entities e WHERE e.kind='pool' AND e.entity_id=q.pool_id);
  UPDATE domino_public.entities SET last_requested_at='epoch'::timestamptz,
   lease_token=NULL,lease_until=NULL,generation=generation+1;
 END IF;
END $$;
ALTER TABLE domino_public.entities ALTER COLUMN last_requested_at SET DEFAULT 'epoch'::timestamptz;

CREATE OR REPLACE FUNCTION domino_public.request_entity(request_kind text,request_id text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF request_kind IS NULL OR request_kind NOT IN ('token','pool') OR request_id IS NULL OR
    (request_kind='token' AND request_id !~ '^0x[0-9a-f]{40}$') OR
    (request_kind='pool' AND request_id !~ '^0x[0-9a-f]{64}$') THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(46630240);
 -- Background prerequisites have a separate writer admission ceiling. They
 -- cannot consume the first-search capacity of explicit public demand.
 IF NOT EXISTS(SELECT 1 FROM domino_public.entities WHERE chain_id=4663
     AND kind=request_kind AND entity_id=request_id
     AND (payload IS NOT NULL OR status<>'pending' OR last_requested_at>'epoch'::timestamptz)) AND
    (SELECT count(*) FROM domino_public.entities WHERE payload IS NULL AND status='pending'
     AND last_requested_at>'epoch'::timestamptz)>=1000
 THEN RETURN false; END IF;
 INSERT INTO domino_public.entities(kind,entity_id,last_requested_at,discovery_requested)
 VALUES(request_kind,request_id,clock_timestamp(),request_kind='token')
 ON CONFLICT(chain_id,kind,entity_id) DO UPDATE SET
  last_requested_at=clock_timestamp(),
  discovery_requested=domino_public.entities.discovery_requested OR request_kind='token',
  next_due=CASE WHEN domino_public.entities.status<>'rejected'
     AND domino_public.entities.last_error IS NULL
     AND domino_public.entities.lease_token IS NULL
     AND (domino_public.entities.kind='pool' OR
          (request_kind='token' AND NOT domino_public.entities.discovery_requested))
     THEN LEAST(domino_public.entities.next_due,clock_timestamp()+interval '5 seconds')
     ELSE domino_public.entities.next_due END
 WHERE domino_public.entities.last_requested_at<clock_timestamp()-interval '15 seconds'
    OR (request_kind='token' AND NOT domino_public.entities.discovery_requested);
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION domino_public.request_entity(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domino_public.request_entity(text,text)
 TO domino_catalogue_reader,domino_catalogue_writer;

-- Preserve adaptive recovery between chunks, target cycles and worker restarts.
ALTER TABLE domino_public.history_jobs ADD COLUMN IF NOT EXISTS span_successes
 integer NOT NULL DEFAULT 0 CHECK(span_successes BETWEEN 0 AND 7);
