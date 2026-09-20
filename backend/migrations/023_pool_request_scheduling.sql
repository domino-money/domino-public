-- Add scheduling/fencing without resetting any acquired activity checkpoint.
ALTER TABLE domino_activity.pool_requests
 ADD COLUMN IF NOT EXISTS last_requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 ADD COLUMN IF NOT EXISTS due_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 ADD COLUMN IF NOT EXISTS claim_token text,
 ADD COLUMN IF NOT EXISTS claim_generation bigint NOT NULL DEFAULT 0 CHECK(claim_generation>=0),
 ADD COLUMN IF NOT EXISTS lease_until timestamptz,
 ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0 CHECK(consecutive_failures>=0),
 ADD COLUMN IF NOT EXISTS error_class text,
 ADD COLUMN IF NOT EXISTS span_blocks integer CHECK(span_blocks BETWEEN 1 AND 100000);
ALTER TABLE domino_activity.pool_requests DROP CONSTRAINT IF EXISTS pool_request_lease_pair;
ALTER TABLE domino_activity.pool_requests ADD CONSTRAINT pool_request_lease_pair
 CHECK((claim_token IS NULL)=(lease_until IS NULL) AND
       (claim_token IS NULL OR claim_token ~ '^[0-9a-f]{64}$'));
CREATE INDEX IF NOT EXISTS pool_request_due
 ON domino_activity.pool_requests(due_at,updated_at,pool_id) WHERE status<>'blocked';

CREATE OR REPLACE FUNCTION domino_activity.request_pool(requested_pool text, request_reason text) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF requested_pool IS NULL OR request_reason IS NULL OR
    requested_pool !~ '^0x[0-9a-f]{64}$' OR request_reason NOT IN ('read','operator','selected') THEN
  RETURN false;
 END IF;
 INSERT INTO domino_activity.pool_requests(pool_id,reason)
 VALUES(requested_pool,request_reason)
 ON CONFLICT(pool_id) DO UPDATE SET last_requested_at=clock_timestamp(),
   due_at=CASE WHEN domino_activity.pool_requests.status='following'
     THEN LEAST(domino_activity.pool_requests.due_at,clock_timestamp())
     ELSE domino_activity.pool_requests.due_at END
 WHERE domino_activity.pool_requests.last_requested_at<clock_timestamp()-interval '30 seconds';
 RETURN true;
END
$$;
REVOKE ALL ON FUNCTION domino_activity.request_pool(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domino_activity.request_pool(text,text)
 TO domino_catalogue_reader,domino_catalogue_writer;
