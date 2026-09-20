-- Recent public Swap observations are not the contiguous accounting ledger.
CREATE TABLE IF NOT EXISTS domino_public.history_jobs (
 pool_id text NOT NULL CHECK(pool_id ~ '^0x[0-9a-f]{64}$'),
 window_seconds integer NOT NULL CHECK(window_seconds IN (86400,604800,2592000)),
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 next_due timestamptz NOT NULL DEFAULT clock_timestamp(),
 generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0),
 lease_token text, lease_until timestamptz,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 last_error text,
 span_blocks integer NOT NULL DEFAULT 100000 CHECK(span_blocks BETWEEN 1 AND 100000),
 completed_at timestamptz,
 target jsonb,
 PRIMARY KEY(pool_id,window_seconds),
 CHECK((lease_token IS NULL)=(lease_until IS NULL))
);
ALTER TABLE domino_public.history_jobs ADD COLUMN IF NOT EXISTS target jsonb;
CREATE INDEX IF NOT EXISTS history_jobs_due ON domino_public.history_jobs(next_due,pool_id);
CREATE TABLE IF NOT EXISTS domino_public.history_coverage (
 pool_id text NOT NULL CHECK(pool_id ~ '^0x[0-9a-f]{64}$'),
 start_block bigint NOT NULL CHECK(start_block>=1),
 end_block bigint NOT NULL CHECK(end_block>=start_block),
 before_timestamp bigint NOT NULL CHECK(before_timestamp>=0),
 end_timestamp bigint NOT NULL CHECK(end_timestamp>=before_timestamp),
 end_hash text NOT NULL CHECK(end_hash ~ '^0x[0-9a-f]{64}$'),
 checked_at bigint NOT NULL CHECK(checked_at>=0),
 denomination jsonb NOT NULL,
 PRIMARY KEY(pool_id,start_block)
);
ALTER TABLE domino_public.history_coverage ADD COLUMN IF NOT EXISTS denomination jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS domino_public.history_swaps (
 pool_id text NOT NULL,
 block_number bigint NOT NULL CHECK(block_number>=1),
 log_index bigint NOT NULL CHECK(log_index>=0),
 block_hash text NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),
 transaction_hash text NOT NULL CHECK(transaction_hash ~ '^0x[0-9a-f]{64}$'),
 timestamp bigint NOT NULL CHECK(timestamp>=0),
 sqrt_price_x96 numeric(49,0) NOT NULL CHECK(sqrt_price_x96>0),
 PRIMARY KEY(pool_id,block_number,log_index)
);
CREATE INDEX IF NOT EXISTS history_swaps_time ON domino_public.history_swaps(pool_id,timestamp);
CREATE TABLE IF NOT EXISTS domino_public.history_candles (
 pool_id text NOT NULL,
 currency text NOT NULL CHECK(currency ~ '^0x[0-9a-f]{40}$'),
 quote_currency text NOT NULL CHECK(quote_currency ~ '^0x[0-9a-f]{40}$' AND quote_currency<>currency),
 resolution_seconds integer NOT NULL CHECK(resolution_seconds IN (60,3600,86400)),
 start_timestamp bigint NOT NULL CHECK(start_timestamp>=0),
 open numeric NOT NULL CHECK(open>0), high numeric NOT NULL CHECK(high>0),
 low numeric NOT NULL CHECK(low>0), close numeric NOT NULL CHECK(close>0),
 swap_count integer NOT NULL CHECK(swap_count>0),
 first_block bigint NOT NULL,first_log bigint NOT NULL,last_block bigint NOT NULL,last_log bigint NOT NULL,
 PRIMARY KEY(pool_id,currency,resolution_seconds,start_timestamp),
 CHECK(high>=low AND open BETWEEN low AND high AND close BETWEEN low AND high)
);
GRANT SELECT ON domino_public.history_jobs,domino_public.history_coverage,
 domino_public.history_swaps,domino_public.history_candles TO domino_catalogue_reader;
GRANT SELECT,INSERT,UPDATE,DELETE ON domino_public.history_jobs,domino_public.history_coverage,
 domino_public.history_swaps,domino_public.history_candles TO domino_catalogue_writer;

CREATE OR REPLACE FUNCTION domino_public.request_history(request_pool text,request_window integer)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE wanted integer;
BEGIN
 IF request_pool IS NULL OR request_pool !~ '^0x[0-9a-f]{64}$' OR
    request_window IS NULL OR request_window NOT IN (86400,604800,2592000) THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(46630250);
 IF NOT EXISTS(SELECT 1 FROM domino_public.history_jobs WHERE pool_id=request_pool)
   AND (SELECT count(*) FROM domino_public.history_jobs WHERE completed_at IS NULL)>=1000
 THEN RETURN false; END IF;
 -- Long history may never delay acquisition of the useful recent day.
 FOREACH wanted IN ARRAY ARRAY[86400,request_window] LOOP
  INSERT INTO domino_public.history_jobs(pool_id,window_seconds) VALUES(request_pool,wanted)
  ON CONFLICT(pool_id,window_seconds) DO UPDATE SET last_requested_at=clock_timestamp()
   WHERE domino_public.history_jobs.last_requested_at<clock_timestamp()-interval '30 seconds';
 END LOOP;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION domino_public.request_history(text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domino_public.request_history(text,integer)
 TO domino_catalogue_reader,domino_catalogue_writer;
