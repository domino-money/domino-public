-- Private owner-bound deposit evidence. Login credentials never enter this schema.
CREATE SCHEMA IF NOT EXISTS domino_deposits;
REVOKE ALL ON SCHEMA domino_deposits FROM PUBLIC, domino_catalogue_reader,
    domino_catalogue_writer, domino_session_auth;
GRANT USAGE ON SCHEMA domino_deposits TO domino_deposit_service;

CREATE TABLE IF NOT EXISTS domino_deposits.intents (
    id uuid PRIMARY KEY,
    owner text NOT NULL CHECK (owner ~ '^0x[0-9a-f]{40}$'),
    idempotency_key uuid NOT NULL,
    chain_id integer NOT NULL DEFAULT 4663 CHECK (chain_id=4663),
    selection jsonb NOT NULL CHECK (jsonb_typeof(selection)='object' AND octet_length(selection::text)<=8192),
    selection_hash text NOT NULL CHECK (selection_hash ~ '^[0-9a-f]{64}$'),
    state text NOT NULL CHECK (state IN ('draft','awaiting_wallet','pending','confirmed',
        'reverted','cancel_requested','cancelled','attention')),
    version integer NOT NULL CHECK (version>=1),
    outstanding boolean NOT NULL DEFAULT false,
    history jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(history)='array' AND jsonb_array_length(history)<=16
        AND octet_length(history::text)<=2359296),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL CHECK (updated_at>=created_at),
    UNIQUE(owner,idempotency_key),
    CHECK (NOT outstanding OR jsonb_array_length(history)>0)
);
CREATE UNIQUE INDEX IF NOT EXISTS deposits_one_outstanding_owner
    ON domino_deposits.intents(owner) WHERE outstanding;
CREATE INDEX IF NOT EXISTS deposits_owner_recent ON domino_deposits.intents(owner,created_at DESC,id DESC);

CREATE OR REPLACE FUNCTION domino_deposits.preserve_selection() RETURNS trigger
    LANGUAGE plpgsql SET search_path=pg_catalog,domino_deposits AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner IS DISTINCT FROM OLD.owner
        OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
        OR NEW.selection IS DISTINCT FROM OLD.selection
        OR NEW.selection_hash IS DISTINCT FROM OLD.selection_hash
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='deposit_immutable_selection';
    END IF;
    RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION domino_deposits.preserve_selection() FROM PUBLIC;
DROP TRIGGER IF EXISTS preserve_deposit_selection ON domino_deposits.intents;
CREATE TRIGGER preserve_deposit_selection BEFORE UPDATE ON domino_deposits.intents
    FOR EACH ROW EXECUTE FUNCTION domino_deposits.preserve_selection();

ALTER TABLE domino_deposits.intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE domino_deposits.intents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deposit_owner ON domino_deposits.intents;
CREATE POLICY deposit_owner ON domino_deposits.intents TO domino_deposit_service
    USING (owner=current_setting('domino.deposit_owner',true))
    WITH CHECK (owner=current_setting('domino.deposit_owner',true));

-- A schema-owned counter keeps capacity global despite tenant RLS. No active or
-- terminal idempotency evidence is evicted or expired to make room.
CREATE TABLE IF NOT EXISTS domino_deposits.capacity (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    used integer NOT NULL CHECK (used BETWEEN 0 AND 10000)
);
INSERT INTO domino_deposits.capacity(singleton,used)
    SELECT true,count(*) FROM domino_deposits.intents
    HAVING NOT EXISTS (SELECT 1 FROM domino_deposits.capacity) ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION domino_deposits.reserve_capacity() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,domino_deposits AS $$
BEGIN
    UPDATE domino_deposits.capacity SET used=used+1 WHERE singleton AND used<10000;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='deposit_capacity_busy';
    END IF;
    RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION domino_deposits.reserve_capacity() FROM PUBLIC;
DROP TRIGGER IF EXISTS reserve_deposit_capacity ON domino_deposits.intents;
CREATE TRIGGER reserve_deposit_capacity BEFORE INSERT ON domino_deposits.intents
    FOR EACH ROW EXECUTE FUNCTION domino_deposits.reserve_capacity();

REVOKE ALL ON ALL TABLES IN SCHEMA domino_deposits FROM PUBLIC, domino_catalogue_reader,
    domino_catalogue_writer, domino_session_auth, domino_deposit_service;
GRANT SELECT,INSERT,UPDATE ON domino_deposits.intents TO domino_deposit_service;
GRANT SELECT ON domino_deposits.capacity TO domino_deposit_service;
REVOKE ALL ON SCHEMA public FROM domino_deposit_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA domino_deposits REVOKE ALL ON TABLES FROM PUBLIC;
