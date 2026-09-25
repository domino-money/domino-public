-- Provider calls by priority, still from the one shared allowance of 024.
-- A lower-priority caller spends a call only while at least `min_free` of the
-- minute's calls remain, so the pools a visitor is reading keep precedence over
-- the long tail of pools someone asked for once. 024's reserve_provider() is
-- the same reservation with nothing held back; the ceiling lives only here.
CREATE OR REPLACE FUNCTION domino_public.reserve_provider_if_headroom(min_free integer)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
 ceiling CONSTANT integer := 25;
BEGIN
 -- A headroom at or above the ceiling already refuses below; NULL would not.
 IF min_free IS NULL OR min_free<0 THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(46630241);
 DELETE FROM domino_public.provider_requests WHERE started_at<=clock_timestamp()-interval '60 seconds';
 IF (SELECT count(*) FROM domino_public.provider_requests)>=ceiling-min_free THEN RETURN false; END IF;
 INSERT INTO domino_public.provider_requests DEFAULT VALUES;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION domino_public.reserve_provider_if_headroom(integer) FROM PUBLIC;
-- Only the background writer defers; public reads keep reserve_provider().
GRANT EXECUTE ON FUNCTION domino_public.reserve_provider_if_headroom(integer) TO domino_catalogue_writer;

CREATE OR REPLACE FUNCTION domino_public.reserve_provider() RETURNS boolean
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT domino_public.reserve_provider_if_headroom(0)
$$;
REVOKE ALL ON FUNCTION domino_public.reserve_provider() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domino_public.reserve_provider() TO domino_catalogue_reader,domino_catalogue_writer;
