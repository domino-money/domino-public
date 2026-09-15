-- Demand queue for on-demand pool indexing. A public read never writes to the
-- activity ledger: it may only ask for a pool through the narrowly granted
-- requester role, and a worker drains this queue. No revision, model or
-- published event is affected by a request.
CREATE TABLE IF NOT EXISTS domino_activity.pool_requests (
 pool_id text PRIMARY KEY CHECK(pool_id ~ '^0x[0-9a-f]{64}$'),
 reason text NOT NULL CHECK(reason IN ('read','operator','selected')),
 status text NOT NULL DEFAULT 'queued'
  CHECK(status IN ('queued','registering','indexing','following','blocked')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 last_error text,
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 detail jsonb
);
CREATE INDEX IF NOT EXISTS pool_request_status
 ON domino_activity.pool_requests(status,requested_at);
-- Idempotent upgrade for a table created before the default existed.
ALTER TABLE domino_activity.pool_requests ALTER COLUMN status SET DEFAULT 'queued';
GRANT SELECT ON domino_activity.pool_requests TO domino_catalogue_reader;
GRANT SELECT,INSERT,UPDATE,DELETE ON domino_activity.pool_requests TO domino_catalogue_writer;

-- A public read gains no table privilege it did not already have: the only new
-- capability is this function, which needs the owner's rights to arbitrate the
-- primary key. Asking twice is the same as asking once, asking cannot change a
-- status, and a read that cannot ask still reads.
-- Parameter names must not shadow the columns the insert touches.
DROP FUNCTION IF EXISTS domino_activity.request_pool(text,text);
CREATE FUNCTION domino_activity.request_pool(requested_pool text, request_reason text) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF requested_pool !~ '^0x[0-9a-f]{64}$' OR request_reason NOT IN ('read','operator','selected') THEN
  RETURN false;
 END IF;
 INSERT INTO domino_activity.pool_requests(pool_id,reason)
 VALUES(requested_pool,request_reason)
 ON CONFLICT(pool_id) DO NOTHING;
 RETURN true;
END
$$;
REVOKE ALL ON FUNCTION domino_activity.request_pool(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domino_activity.request_pool(text,text) TO domino_catalogue_reader;
-- The writer already owns table DML; it also asks through the function so an
-- operator or the worker uses one code path.
GRANT EXECUTE ON FUNCTION domino_activity.request_pool(text,text) TO domino_catalogue_writer;
