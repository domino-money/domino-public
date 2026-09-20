-- Public observations, independent of wallet/session/financial tables.
-- Pool activity/backfill remains in pool_requests; these leases refresh public
-- token metadata and current market observations only.
CREATE SCHEMA IF NOT EXISTS domino_public;
REVOKE ALL ON SCHEMA domino_public FROM PUBLIC;
GRANT USAGE ON SCHEMA domino_public TO domino_catalogue_reader,domino_catalogue_writer;
CREATE TABLE IF NOT EXISTS domino_public.entities (
 chain_id integer NOT NULL DEFAULT 4663 CHECK(chain_id=4663),
 kind text NOT NULL CHECK(kind IN ('token','pool')),
 entity_id text NOT NULL,
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 next_due timestamptz NOT NULL DEFAULT clock_timestamp(),
 generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0),
 lease_token text,
 lease_until timestamptz,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 last_error text,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','rejected')),
 payload jsonb,
 observed_at bigint CHECK(observed_at>=0),
 discovery_after text,
 discovery_revision bigint,
 ledger_due timestamptz NOT NULL DEFAULT clock_timestamp(),
 ledger_stage integer NOT NULL DEFAULT 0 CHECK(ledger_stage BETWEEN 0 AND 2),
 ledger_error text,
 PRIMARY KEY(chain_id,kind,entity_id),
 CHECK((kind='token' AND entity_id ~ '^0x[0-9a-f]{40}$') OR
       (kind='pool' AND entity_id ~ '^0x[0-9a-f]{64}$')),
 CHECK((lease_token IS NULL)=(lease_until IS NULL)),
 CHECK((payload IS NULL)=(observed_at IS NULL))
);
ALTER TABLE domino_public.entities ADD COLUMN IF NOT EXISTS discovery_after text;
ALTER TABLE domino_public.entities ADD COLUMN IF NOT EXISTS discovery_revision bigint;
ALTER TABLE domino_public.entities ADD COLUMN IF NOT EXISTS ledger_due timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE domino_public.entities ADD COLUMN IF NOT EXISTS ledger_stage integer NOT NULL DEFAULT 0 CHECK(ledger_stage BETWEEN 0 AND 2);
ALTER TABLE domino_public.entities ADD COLUMN IF NOT EXISTS ledger_error text;
CREATE INDEX IF NOT EXISTS public_entities_due ON domino_public.entities(kind,next_due,entity_id);
CREATE INDEX IF NOT EXISTS public_entities_interest ON domino_public.entities(last_requested_at);
CREATE TABLE IF NOT EXISTS domino_public.provider_requests (
 started_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS domino_public.token_pools (
 chain_id integer NOT NULL DEFAULT 4663 CHECK(chain_id=4663),
 token text NOT NULL CHECK(token ~ '^0x[0-9a-f]{40}$'),
 pool_id text NOT NULL CHECK(pool_id ~ '^0x[0-9a-f]{64}$'),
 PRIMARY KEY(chain_id,token,pool_id)
);
CREATE TABLE IF NOT EXISTS domino_public.state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0)
);
INSERT INTO domino_public.state(singleton) VALUES(true) ON CONFLICT DO NOTHING;
GRANT SELECT ON ALL TABLES IN SCHEMA domino_public TO domino_catalogue_reader;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA domino_public TO domino_catalogue_writer;

CREATE OR REPLACE FUNCTION domino_public.request_entity(request_kind text,request_id text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF request_kind NOT IN ('token','pool') OR request_id IS NULL OR
    (request_kind='token' AND request_id !~ '^0x[0-9a-f]{40}$') OR
    (request_kind='pool' AND request_id !~ '^0x[0-9a-f]{64}$') THEN RETURN false; END IF;
 -- Bound novel demand globally, without limiting already acquired identities.
 -- Serialize only admission so concurrent clients cannot overrun the ceiling.
 PERFORM pg_advisory_xact_lock(46630240);
 IF NOT EXISTS(SELECT 1 FROM domino_public.entities WHERE chain_id=4663
     AND kind=request_kind AND entity_id=request_id) AND
    (SELECT count(*) FROM domino_public.entities WHERE payload IS NULL AND status='pending')>=1000
 THEN RETURN false; END IF;
 INSERT INTO domino_public.entities(kind,entity_id) VALUES(request_kind,request_id)
 ON CONFLICT(chain_id,kind,entity_id) DO UPDATE SET
  last_requested_at=clock_timestamp(),
  -- Browser interest accelerates only healthy, unleased pool observations.
  -- Token metadata keeps its TTL; all failures keep their retry backoff.
  next_due=CASE WHEN domino_public.entities.kind='pool'
     AND domino_public.entities.status<>'rejected'
     AND domino_public.entities.last_error IS NULL
     AND domino_public.entities.lease_token IS NULL
     THEN LEAST(domino_public.entities.next_due,clock_timestamp()+interval '5 seconds')
     ELSE domino_public.entities.next_due END
 WHERE domino_public.entities.last_requested_at<clock_timestamp()-interval '15 seconds';
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION domino_public.request_entity(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domino_public.request_entity(text,text)
 TO domino_catalogue_reader,domino_catalogue_writer;

CREATE OR REPLACE FUNCTION domino_public.reserve_provider() RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(46630241);
 DELETE FROM domino_public.provider_requests WHERE started_at<=clock_timestamp()-interval '60 seconds';
 IF (SELECT count(*) FROM domino_public.provider_requests)>=25 THEN RETURN false; END IF;
 INSERT INTO domino_public.provider_requests DEFAULT VALUES;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION domino_public.reserve_provider() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domino_public.reserve_provider() TO domino_catalogue_reader,domino_catalogue_writer;
