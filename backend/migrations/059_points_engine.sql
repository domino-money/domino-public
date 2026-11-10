-- Points, season 1 (docs/points/POINTS.md), part 2: the engine's own rows,
-- beside 058's revenue ledger. Referral links: one per referred wallet and
-- season, signed by that wallet (EIP-191) and kept with its message and
-- signature, so anyone can check them; the first link holds. The bridge's app
-- fee, which is no V2 index event: one row per provider request, with the
-- wallet the session sent (depositor, recipient and refund address). Snapshots:
-- the season's points per wallet as the engine computed them, with the sha256
-- of their canonical JSON, the season configuration's and the team list's.
-- The team's wallets, which earn nothing and link no one: private, the
-- catalogue writer's only (never the reader's, which the public read path
-- uses); a snapshot records the sha256 of the sorted list, never its
-- addresses. points_engine.py and points_referral.py write through the
-- catalogue writer. Applied after 058.

CREATE TABLE IF NOT EXISTS domino_points.referrals (
 season text NOT NULL CHECK(season ~ '^[a-z0-9-]{1,40}$'),
 referee text NOT NULL CHECK(referee ~ '^0x[0-9a-f]{40}$'),
 referrer text NOT NULL CHECK(referrer ~ '^0x[0-9a-f]{40}$'),
 -- The exact text the referee signed, its signature (r, s, v) and the time it states.
 message text NOT NULL CHECK(length(message) BETWEEN 1 AND 1000),
 signature text NOT NULL CHECK(signature ~ '^0x[0-9a-f]{130}$'),
 issued_at bigint NOT NULL CHECK(issued_at>=0),
 recorded_at bigint NOT NULL,
 PRIMARY KEY(season,referee),
 CHECK(referee<>referrer)
);
CREATE INDEX IF NOT EXISTS points_referrals_by_referrer ON domino_points.referrals(season,referrer);

CREATE TABLE IF NOT EXISTS domino_points.bridge_fees (
 provider text NOT NULL CHECK(provider IN ('relay','across')),
 -- Relay's request id, or Across' `<origin chain>:<deposit id>`.
 request_id text NOT NULL CHECK(length(request_id) BETWEEN 1 AND 120),
 wallet text NOT NULL CHECK(wallet ~ '^0x[0-9a-f]{40}$'),
 origin_chain_id bigint NOT NULL CHECK(origin_chain_id>0),
 destination_chain_id bigint NOT NULL CHECK(destination_chain_id>0),
 charged_at bigint NOT NULL CHECK(charged_at>=0),
 token text NOT NULL CHECK(token ~ '^0x[0-9a-f]{40}$'),
 amount numeric(78,0) NOT NULL CHECK(amount>=0),
 usd numeric(60,18) NOT NULL CHECK(usd>=0),
 -- Where the amount actually collected comes from (relay_requests_v3, across_fill_transfer, ...).
 evidence text NOT NULL CHECK(evidence ~ '^[a-z0-9_]{1,40}$'),
 recorded_at bigint NOT NULL,
 PRIMARY KEY(provider,request_id)
);
CREATE INDEX IF NOT EXISTS points_bridge_fees_by_wallet ON domino_points.bridge_fees(wallet,charged_at);

CREATE TABLE IF NOT EXISTS domino_points.team (
 address text PRIMARY KEY CHECK(address ~ '^0x[0-9a-f]{40}$'),
 imported_at bigint NOT NULL CHECK(imported_at>=0)
);

CREATE TABLE IF NOT EXISTS domino_points.snapshots (
 season text NOT NULL CHECK(season ~ '^[a-z0-9-]{1,40}$'),
 taken_at bigint NOT NULL CHECK(taken_at>=0),
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 config_sha256 text NOT NULL CHECK(config_sha256 ~ '^[0-9a-f]{64}$'),
 team_sha256 text NOT NULL CHECK(team_sha256 ~ '^[0-9a-f]{64}$'),
 wallets integer NOT NULL CHECK(wallets>=0),
 body jsonb NOT NULL,
 PRIMARY KEY(season,taken_at)
);

GRANT SELECT,INSERT,UPDATE,DELETE ON domino_points.referrals,domino_points.bridge_fees,domino_points.snapshots,
 domino_points.team TO domino_catalogue_writer;
GRANT SELECT ON domino_points.referrals,domino_points.bridge_fees,domino_points.snapshots TO domino_catalogue_reader;

-- The points listener (points_api.py, part 3) answers for the SIWE session's
-- wallet through the session role it already logs in as (domino_session_auth),
-- and only through these functions, owned by a role that cannot log in: the
-- wallet's entry in the season's latest snapshot; whether a wallet is excluded
-- by the team's list or a deployment's role (an answer per wallet, never the
-- list); and recording a link, where the first holds. The listener checks the
-- referred wallet's signature before it records; the catalogue writer records
-- through the same function (points_referral.py).
DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='domino_points_owner') THEN
  CREATE ROLE domino_points_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
END
$$;
GRANT USAGE ON SCHEMA domino_points, domino_v2 TO domino_points_owner;
GRANT SELECT ON domino_points.snapshots, domino_points.team, domino_v2.deployments TO domino_points_owner;
GRANT SELECT, INSERT ON domino_points.referrals TO domino_points_owner;

CREATE OR REPLACE FUNCTION domino_points.wallet_entry(p_season text, p_wallet text)
 RETURNS TABLE(taken_at bigint, snapshot_sha256 text, entry jsonb)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,domino_points AS $$
 SELECT s.taken_at, s.sha256,
        (SELECT w FROM jsonb_array_elements(s.body->'wallets') AS w WHERE w->>'address'=p_wallet LIMIT 1)
 FROM domino_points.snapshots s WHERE s.season=p_season ORDER BY s.taken_at DESC LIMIT 1
$$;

CREATE OR REPLACE FUNCTION domino_points.is_excluded(p_wallet text, p_roles text[])
 RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,domino_points,domino_v2 AS $$
 SELECT EXISTS(SELECT 1 FROM domino_points.team t WHERE t.address=p_wallet)
     OR EXISTS(SELECT 1 FROM domino_v2.deployments d, unnest(p_roles) AS r(name)
               WHERE lower(d.manifest->'roles'->>r.name)=p_wallet)
$$;

CREATE OR REPLACE FUNCTION domino_points.record_link(p_season text, p_referee text, p_referrer text, p_message text,
 p_signature text, p_issued_at bigint, p_recorded_at bigint)
 RETURNS TABLE(outcome text, holder text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,domino_points AS $$
DECLARE held text;
BEGIN
 INSERT INTO domino_points.referrals AS l(season,referee,referrer,message,signature,issued_at,recorded_at)
  VALUES(p_season,p_referee,p_referrer,p_message,p_signature,p_issued_at,p_recorded_at)
  ON CONFLICT (season,referee) DO NOTHING RETURNING l.referrer INTO held;
 IF held IS NOT NULL THEN
  RETURN QUERY SELECT 'recorded'::text, held;
 ELSE
  RETURN QUERY SELECT 'existing'::text, l.referrer FROM domino_points.referrals l
   WHERE l.season=p_season AND l.referee=p_referee;
 END IF;
END
$$;

ALTER FUNCTION domino_points.wallet_entry(text, text) OWNER TO domino_points_owner;
ALTER FUNCTION domino_points.is_excluded(text, text[]) OWNER TO domino_points_owner;
ALTER FUNCTION domino_points.record_link(text, text, text, text, text, bigint, bigint) OWNER TO domino_points_owner;
REVOKE ALL ON FUNCTION domino_points.wallet_entry(text, text), domino_points.is_excluded(text, text[]),
 domino_points.record_link(text, text, text, text, text, bigint, bigint) FROM PUBLIC;
GRANT USAGE ON SCHEMA domino_points TO domino_session_auth;
GRANT EXECUTE ON FUNCTION domino_points.wallet_entry(text, text), domino_points.is_excluded(text, text[]),
 domino_points.record_link(text, text, text, text, text, bigint, bigint) TO domino_session_auth, domino_catalogue_writer;
