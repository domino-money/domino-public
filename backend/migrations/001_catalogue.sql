-- Public market catalogue only. This does not apply the private-account schema.sql.
CREATE SCHEMA IF NOT EXISTS domino_catalogue;
CREATE TABLE IF NOT EXISTS domino_catalogue.state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 schema_version integer NOT NULL CHECK(schema_version=1),
 start_block bigint CHECK(start_block>0),
 next_block bigint,
 base_hash text CHECK(base_hash ~ '^0x[0-9a-f]{64}$'),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 CHECK((start_block IS NULL AND next_block IS NULL AND base_hash IS NULL)
       OR (start_block IS NOT NULL AND next_block IS NOT NULL AND next_block>=start_block AND base_hash IS NOT NULL))
);
-- Explicitly close SQL CHECK's NULL truth-value loophole, including early local installs.
ALTER TABLE domino_catalogue.state DROP CONSTRAINT IF EXISTS checkpoint_fields_complete;
ALTER TABLE domino_catalogue.state ADD CONSTRAINT checkpoint_fields_complete CHECK (
 (start_block IS NULL AND next_block IS NULL AND base_hash IS NULL)
 OR (start_block IS NOT NULL AND next_block IS NOT NULL AND next_block>=start_block AND base_hash IS NOT NULL)
);
INSERT INTO domino_catalogue.state(singleton,schema_version) VALUES(true,1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS domino_catalogue.chunks (
 start_block bigint PRIMARY KEY CHECK(start_block>0),
 end_block bigint NOT NULL CHECK(end_block>=start_block),
 end_hash text NOT NULL CHECK(end_hash ~ '^0x[0-9a-f]{64}$')
);
CREATE TABLE IF NOT EXISTS domino_catalogue.events (
 pool_id text PRIMARY KEY CHECK(pool_id ~ '^0x[0-9a-f]{64}$'),
 currency0 text NOT NULL CHECK(currency0 ~ '^0x[0-9a-f]{40}$'),
 currency1 text NOT NULL CHECK(currency1 ~ '^0x[0-9a-f]{40}$' AND currency1>currency0),
 pool_key jsonb NOT NULL,
 block_number bigint NOT NULL CHECK(block_number>=0),
 block_hash text NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),
 tx_hash text NOT NULL CHECK(tx_hash ~ '^0x[0-9a-f]{64}$'),
 log_index bigint NOT NULL CHECK(log_index>=0),
 chunk_start bigint NOT NULL REFERENCES domino_catalogue.chunks(start_block) ON DELETE CASCADE,
 UNIQUE(block_hash,log_index)
);
CREATE TABLE IF NOT EXISTS domino_catalogue.hints (
 pool_id text PRIMARY KEY CHECK(pool_id ~ '^0x[0-9a-f]{64}$'),
 currency0 text NOT NULL CHECK(currency0 ~ '^0x[0-9a-f]{40}$'),
 currency1 text NOT NULL CHECK(currency1 ~ '^0x[0-9a-f]{40}$' AND currency1>currency0),
 pool_key jsonb NOT NULL,
 observed_block bigint NOT NULL CHECK(observed_block>=0),
 observed_hash text NOT NULL CHECK(observed_hash ~ '^0x[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS event_currency0 ON domino_catalogue.events(currency0,pool_id);
CREATE INDEX IF NOT EXISTS event_currency1 ON domino_catalogue.events(currency1,pool_id);
CREATE INDEX IF NOT EXISTS hint_currency0 ON domino_catalogue.hints(currency0,pool_id);
CREATE INDEX IF NOT EXISTS hint_currency1 ON domino_catalogue.hints(currency1,pool_id);
REVOKE ALL ON SCHEMA domino_catalogue FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA domino_catalogue FROM PUBLIC;
GRANT USAGE ON SCHEMA domino_catalogue TO domino_catalogue_reader,domino_catalogue_writer;
GRANT SELECT ON ALL TABLES IN SCHEMA domino_catalogue TO domino_catalogue_reader;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA domino_catalogue TO domino_catalogue_writer;
