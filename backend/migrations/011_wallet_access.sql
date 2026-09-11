-- Operator-managed wallet admission. No grant is created by this migration.
CREATE SCHEMA IF NOT EXISTS domino_wallet_access;
REVOKE ALL ON SCHEMA domino_wallet_access FROM PUBLIC, domino_catalogue_reader, domino_catalogue_writer, domino_session_auth, domino_wallet_access_operator;
GRANT USAGE ON SCHEMA domino_wallet_access TO domino_session_auth, domino_wallet_access_operator;

CREATE TABLE IF NOT EXISTS domino_wallet_access.grants (
    chain_id integer NOT NULL CHECK (chain_id=4663),
    address text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$' AND address<>'0x0000000000000000000000000000000000000000'),
    generation bigint NOT NULL CHECK (generation>0),
    allowed boolean NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL CHECK (updated_at>=created_at),
    PRIMARY KEY (chain_id,address)
);
CREATE TABLE IF NOT EXISTS domino_wallet_access.audit (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    chain_id integer NOT NULL CHECK (chain_id=4663),
    address text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
    generation bigint NOT NULL CHECK (generation>0),
    action text NOT NULL CHECK (action IN ('grant','revoke')),
    changed_at timestamptz NOT NULL,
    actor text NOT NULL CHECK (actor='domino_wallet_access_operator')
);
REVOKE ALL ON ALL TABLES IN SCHEMA domino_wallet_access FROM PUBLIC, domino_catalogue_reader, domino_catalogue_writer, domino_session_auth, domino_wallet_access_operator;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA domino_wallet_access FROM PUBLIC, domino_catalogue_reader, domino_catalogue_writer, domino_session_auth, domino_wallet_access_operator;
GRANT SELECT ON domino_wallet_access.grants TO domino_session_auth, domino_wallet_access_operator;
GRANT SELECT ON domino_wallet_access.audit TO domino_wallet_access_operator;
ALTER DEFAULT PRIVILEGES IN SCHEMA domino_wallet_access REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA domino_wallet_access REVOKE ALL ON FUNCTIONS FROM PUBLIC;

-- NULL generations deliberately invalidate challenges and sessions issued
-- before this admission policy. Never backfill them from a later grant.
ALTER TABLE domino_sessions.challenges ADD COLUMN IF NOT EXISTS admission_generation bigint CHECK (admission_generation>0);
ALTER TABLE domino_sessions.sessions ADD COLUMN IF NOT EXISTS admission_generation bigint CHECK (admission_generation>0);

CREATE OR REPLACE FUNCTION domino_wallet_access.set_access(wallet_address text, make_allowed boolean)
RETURNS TABLE(chain_id integer,address text,allowed boolean,generation bigint,changed boolean,updated_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,domino_wallet_access AS $$
DECLARE
    existing domino_wallet_access.grants%ROWTYPE;
    stamp timestamptz;
    next_generation bigint;
    audit_count bigint;
BEGIN
    IF session_user<>'domino_wallet_access_operator' OR make_allowed IS NULL OR wallet_address IS NULL
       OR wallet_address !~ '^0x[0-9a-f]{40}$' OR wallet_address='0x0000000000000000000000000000000000000000' THEN
        RAISE EXCEPTION USING MESSAGE='wallet_access_invalid_request', ERRCODE='P0001';
    END IF;
    -- Same lock as SessionStore: revoke cannot interleave between its final
    -- generation check and the transaction that consumes a challenge/session.
    PERFORM pg_advisory_xact_lock(19227491944452947);
    stamp:=clock_timestamp();
    SELECT g.* INTO existing FROM domino_wallet_access.grants g WHERE g.chain_id=4663 AND g.address=wallet_address;
    IF FOUND AND existing.allowed=make_allowed THEN
        RETURN QUERY SELECT existing.chain_id,existing.address,existing.allowed,existing.generation,false,existing.updated_at;
        RETURN;
    END IF;
    IF existing.address IS NULL AND NOT make_allowed THEN
        RAISE EXCEPTION USING MESSAGE='wallet_access_not_found', ERRCODE='P0001';
    END IF;
    SELECT count(*) INTO audit_count FROM domino_wallet_access.audit;
    -- Keep all generations and append-only audit. Stop grants early enough to
    -- reserve one revocation event for each of the at most 10,000 wallets.
    IF audit_count>=100000 OR (make_allowed AND audit_count>=90000)
       OR (existing.address IS NULL AND (SELECT count(*) FROM domino_wallet_access.grants)>=10000)
       OR existing.generation=9223372036854775807 THEN
        RAISE EXCEPTION USING MESSAGE='wallet_access_capacity', ERRCODE='P0001';
    END IF;
    next_generation:=COALESCE(existing.generation,0)+1;
    INSERT INTO domino_wallet_access.grants AS g(chain_id,address,generation,allowed,created_at,updated_at)
    VALUES (4663,wallet_address,next_generation,make_allowed,stamp,stamp)
    ON CONFLICT ON CONSTRAINT grants_pkey DO UPDATE SET generation=EXCLUDED.generation,allowed=EXCLUDED.allowed,updated_at=EXCLUDED.updated_at;
    INSERT INTO domino_wallet_access.audit(chain_id,address,generation,action,changed_at,actor)
    VALUES (4663,wallet_address,next_generation,CASE WHEN make_allowed THEN 'grant' ELSE 'revoke' END,stamp,session_user);
    RETURN QUERY SELECT 4663,wallet_address,make_allowed,next_generation,true,stamp;
END;
$$;
REVOKE ALL ON FUNCTION domino_wallet_access.set_access(text,boolean) FROM PUBLIC, domino_catalogue_reader, domino_catalogue_writer, domino_session_auth;
GRANT EXECUTE ON FUNCTION domino_wallet_access.set_access(text,boolean) TO domino_wallet_access_operator;
REVOKE ALL ON SCHEMA public, domino_sessions FROM domino_wallet_access_operator;

-- Defense against a legacy writer that omits the new generation. Existing
-- rows remain untouched; this does not retrofit old producers' read guards.
CREATE OR REPLACE FUNCTION domino_wallet_access.guard_session_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,domino_wallet_access AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(19227491944452947);
    IF NEW.admission_generation IS NULL OR NOT EXISTS (
        SELECT 1 FROM domino_wallet_access.grants g
        WHERE g.chain_id=NEW.chain_id AND g.address=NEW.address
          AND g.allowed AND g.generation=NEW.admission_generation
    ) THEN
        RAISE EXCEPTION USING MESSAGE='wallet_access_session_denied', ERRCODE='42501';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION domino_wallet_access.guard_session_insert() FROM PUBLIC, domino_catalogue_reader, domino_catalogue_writer, domino_session_auth, domino_wallet_access_operator;
DROP TRIGGER IF EXISTS wallet_access_session_insert ON domino_sessions.sessions;
CREATE TRIGGER wallet_access_session_insert BEFORE INSERT ON domino_sessions.sessions
FOR EACH ROW EXECUTE FUNCTION domino_wallet_access.guard_session_insert();
