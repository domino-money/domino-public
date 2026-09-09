-- Public event-time capital and external price observations; no owner accounts.
CREATE TABLE IF NOT EXISTS domino_activity.capital_chunks (
 pool_id text NOT NULL,
 chunk_start bigint NOT NULL,
 methodology_version integer NOT NULL CHECK(methodology_version=1),
 event_count integer NOT NULL CHECK(event_count>=0),
 end_capital jsonb NOT NULL,
 PRIMARY KEY(pool_id,chunk_start),
 FOREIGN KEY(pool_id,chunk_start) REFERENCES domino_activity.position_chunks(pool_id,chunk_start) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS domino_activity.capital_events (
 pool_id text NOT NULL,
 block_hash text NOT NULL,
 log_index bigint NOT NULL,
 chunk_start bigint NOT NULL,
 capital jsonb NOT NULL,
 PRIMARY KEY(pool_id,block_hash,log_index),
 FOREIGN KEY(pool_id,block_hash,log_index) REFERENCES domino_activity.events(pool_id,block_hash,log_index) ON DELETE CASCADE,
 FOREIGN KEY(pool_id,chunk_start) REFERENCES domino_activity.capital_chunks(pool_id,chunk_start) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS domino_activity.price_observations (
 chain_id integer NOT NULL CHECK(chain_id=4663),
 currency text NOT NULL CHECK(currency ~ '^0x[0-9a-f]{40}$'),
 source text NOT NULL CHECK(source='alchemy_historical'),
 observed_at bigint NOT NULL CHECK(observed_at>=0),
 retrieved_at bigint NOT NULL CHECK(retrieved_at>=observed_at),
 price_usd text NOT NULL CHECK(price_usd ~ '^[0-9]+(\.[0-9]+)?$'),
 provenance jsonb NOT NULL,
 PRIMARY KEY(chain_id,currency,source,observed_at)
);
CREATE INDEX IF NOT EXISTS price_currency_time ON domino_activity.price_observations(currency,observed_at);
REVOKE ALL ON domino_activity.capital_chunks,domino_activity.capital_events,domino_activity.price_observations FROM PUBLIC;
GRANT SELECT ON domino_activity.capital_chunks,domino_activity.capital_events,domino_activity.price_observations TO domino_catalogue_reader;
GRANT SELECT,INSERT,UPDATE,DELETE ON domino_activity.capital_chunks,domino_activity.capital_events,domino_activity.price_observations TO domino_catalogue_writer;
