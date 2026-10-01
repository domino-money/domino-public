-- The shared provider allowance at the provider's real limit (#278).
-- GeckoTerminal's free API allows 10 calls a minute per address, and the VM
-- shares its address with the rest of the house. 042's 25 hid that while the
-- collector called little; once the listed pools were refreshed on time it
-- reached 11 a minute and most answers were 429s. 8 leaves two for anything
-- else behind the same address. Pools on screen and the featured list's pools
-- take any call left; idle refreshes leave IDLE_PROVIDER_HEADROOM, and the
-- featured selection its listingProviderHeadroom. Only the ceiling changes.
-- Keep PROVIDER_CALLS_PER_MINUTE in backend/public_observations.py equal to it.
CREATE OR REPLACE FUNCTION domino_public.reserve_provider_if_headroom(min_free integer)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
 ceiling CONSTANT integer := 8;
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
GRANT EXECUTE ON FUNCTION domino_public.reserve_provider_if_headroom(integer) TO domino_catalogue_writer;
