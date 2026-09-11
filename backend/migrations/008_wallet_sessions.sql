-- Private authentication state. Apply as the database owner, never the auth role.
-- Bearer, CSRF, client/address abuse keys are hashes; SIWE challenges contain only
-- public address/message data. This schema is not part of the public catalogue.
CREATE SCHEMA IF NOT EXISTS domino_sessions;
REVOKE ALL ON SCHEMA domino_sessions FROM PUBLIC, domino_catalogue_reader, domino_catalogue_writer;
GRANT USAGE ON SCHEMA domino_sessions TO domino_session_auth;

CREATE TABLE IF NOT EXISTS domino_sessions.contexts (
    bearer_hash bytea PRIMARY KEY CHECK (octet_length(bearer_hash)=32),
    csrf_hash bytea NOT NULL CHECK (octet_length(csrf_hash)=32),
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    consumed_at timestamptz,
    CHECK (expires_at>created_at AND expires_at<=created_at+interval '10 minutes')
);
CREATE INDEX IF NOT EXISTS contexts_expiry ON domino_sessions.contexts(expires_at);

CREATE TABLE IF NOT EXISTS domino_sessions.challenges (
    id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{32}$'),
    context_hash bytea NOT NULL CHECK (octet_length(context_hash)=32),
    address text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
    nonce text NOT NULL UNIQUE CHECK (nonce ~ '^[0-9a-f]{32}$'),
    issued_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    message text NOT NULL CHECK (octet_length(message) BETWEEN 1 AND 2048),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
    consumed_at timestamptz,
    CHECK (expires_at>issued_at AND expires_at<=issued_at+interval '5 minutes')
);
CREATE INDEX IF NOT EXISTS challenges_expiry ON domino_sessions.challenges(expires_at);
CREATE INDEX IF NOT EXISTS challenges_context ON domino_sessions.challenges(context_hash);

CREATE TABLE IF NOT EXISTS domino_sessions.sessions (
    bearer_hash bytea PRIMARY KEY CHECK (octet_length(bearer_hash)=32),
    csrf_hash bytea NOT NULL CHECK (octet_length(csrf_hash)=32),
    source_context_hash bytea NOT NULL UNIQUE CHECK (octet_length(source_context_hash)=32),
    address text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
    chain_id integer NOT NULL CHECK (chain_id=4663),
    policy text NOT NULL CHECK (policy='plain_eoa_v1'),
    created_at timestamptz NOT NULL,
    last_used_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    block_number text NOT NULL CHECK (block_number ~ '^(0|[1-9][0-9]{0,19})$'),
    block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
    CHECK (expires_at=created_at+interval '12 hours'),
    CHECK (last_used_at>=created_at AND last_used_at<expires_at)
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON domino_sessions.sessions(expires_at);
CREATE INDEX IF NOT EXISTS sessions_idle ON domino_sessions.sessions(last_used_at);
CREATE INDEX IF NOT EXISTS sessions_revoked ON domino_sessions.sessions(revoked_at) WHERE revoked_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS domino_sessions.rate_limits (
    key_hash bytea PRIMARY KEY CHECK (octet_length(key_hash)=32),
    reset_at timestamptz NOT NULL,
    count integer NOT NULL CHECK (count BETWEEN 1 AND 1000)
);
CREATE INDEX IF NOT EXISTS rate_limits_expiry ON domino_sessions.rate_limits(reset_at);

CREATE TABLE IF NOT EXISTS domino_sessions.private_limits (
    key_hash bytea PRIMARY KEY CHECK (octet_length(key_hash)=32),
    -- One token per 2,000,000 microseconds; capacity five tokens.
    credit bigint NOT NULL CHECK (credit BETWEEN 0 AND 10000000),
    updated_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS private_limits_expiry ON domino_sessions.private_limits(expires_at);

REVOKE ALL ON ALL TABLES IN SCHEMA domino_sessions FROM PUBLIC, domino_catalogue_reader, domino_catalogue_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA domino_sessions TO domino_session_auth;
ALTER DEFAULT PRIVILEGES IN SCHEMA domino_sessions REVOKE ALL ON TABLES FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM domino_session_auth;
