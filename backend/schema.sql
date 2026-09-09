-- Candidate PostgreSQL migration; not applied to production.
-- RLS integration and restore tests are required before deployment.
-- The API role must NOT own these tables, hold BYPASSRLS, or choose tenant IDs
-- from request bodies. SET LOCAL app.tenant_id only after wallet authentication.
BEGIN;
CREATE TABLE accounts (
 id uuid PRIMARY KEY,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE wallets (
 tenant_id uuid NOT NULL REFERENCES accounts(id),
 chain_id integer NOT NULL CHECK(chain_id=4663),
 address bytea NOT NULL CHECK(octet_length(address)=20),
 PRIMARY KEY(chain_id,address), UNIQUE(tenant_id,chain_id,address)
);
CREATE TABLE sequences (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES accounts(id),
 chain_id integer NOT NULL CHECK(chain_id=4663),
 owner_address bytea NOT NULL CHECK(octet_length(owner_address)=20),
 vault_address bytea NOT NULL CHECK(octet_length(vault_address)=20),
 pool_id bytea NOT NULL CHECK(octet_length(pool_id)=32),
 policy_version bigint NOT NULL CHECK(policy_version>=0),
 protocol_fee_bps smallint NOT NULL CHECK(protocol_fee_bps BETWEEN 0 AND 200),
 trigger_distance_bps smallint NOT NULL CHECK(trigger_distance_bps BETWEEN 0 AND 2000),
 max_overlap_bps smallint NOT NULL CHECK(max_overlap_bps BETWEEN 0 AND 2000),
 paused boolean NOT NULL DEFAULT true,
 UNIQUE(tenant_id,id), UNIQUE(chain_id,vault_address),
 FOREIGN KEY(tenant_id,chain_id,owner_address) REFERENCES wallets(tenant_id,chain_id,address)
);
CREATE TABLE positions (
 tenant_id uuid NOT NULL,
 sequence_id uuid NOT NULL,
 chain_id integer NOT NULL CHECK(chain_id=4663),
 token_id numeric(78,0) NOT NULL CHECK(token_id>=0 AND token_id<2::numeric^256),
 tick_lower integer NOT NULL CHECK(tick_lower>=-887272),
 tick_upper integer NOT NULL CHECK(tick_upper<=887272 AND tick_upper>tick_lower),
 observed_block bigint NOT NULL CHECK(observed_block>=0),
 observed_hash bytea NOT NULL CHECK(octet_length(observed_hash)=32),
 PRIMARY KEY(chain_id,token_id), UNIQUE(tenant_id,sequence_id,chain_id,token_id),
 FOREIGN KEY(tenant_id,sequence_id) REFERENCES sequences(tenant_id,id)
);
CREATE TABLE fee_lots (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 sequence_id uuid NOT NULL,
 chain_id integer NOT NULL CHECK(chain_id=4663),
 token_id numeric(78,0) NOT NULL,
 tx_hash bytea NOT NULL CHECK(octet_length(tx_hash)=32),
 log_index integer NOT NULL CHECK(log_index>=0),
 currency smallint NOT NULL CHECK(currency IN(0,1)),
 gross_units numeric(78,0) NOT NULL CHECK(gross_units>=0 AND gross_units<2::numeric^256),
 consumed_units numeric(78,0) NOT NULL DEFAULT 0 CHECK(consumed_units>=0 AND consumed_units<=gross_units),
 canonical boolean NOT NULL DEFAULT false,
 UNIQUE(chain_id,tx_hash,log_index,currency),
 FOREIGN KEY(tenant_id,sequence_id,chain_id,token_id) REFERENCES positions(tenant_id,sequence_id,chain_id,token_id)
);
CREATE TABLE execution_intents (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 sequence_id uuid NOT NULL,
 idempotency_key bytea NOT NULL CHECK(octet_length(idempotency_key)=32),
 policy_version bigint NOT NULL CHECK(policy_version>=0),
 source_block bigint NOT NULL CHECK(source_block>=0),
 source_hash bytea NOT NULL CHECK(octet_length(source_hash)=32),
 action text NOT NULL CHECK(action IN('compound_self','redirect_fees','create_domino')),
 status text NOT NULL CHECK(status IN('planned','signed','broadcast','included','confirmed','reverted','rejected','reorged')),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(sequence_id,idempotency_key),
 FOREIGN KEY(tenant_id,sequence_id) REFERENCES sequences(tenant_id,id)
);
CREATE TABLE operator_nonces (
 chain_id integer NOT NULL CHECK(chain_id=4663),
 signer bytea NOT NULL CHECK(octet_length(signer)=20),
 nonce numeric(20,0) NOT NULL CHECK(nonce>=0),
 intent_id uuid NOT NULL UNIQUE REFERENCES execution_intents(id),
 PRIMARY KEY(chain_id,signer,nonce)
);
-- operator_nonces is private to the signer coordinator; no API grants.
REVOKE ALL ON operator_nonces FROM PUBLIC;

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY account_owner ON accounts USING(id=current_setting('app.tenant_id',true)::uuid) WITH CHECK(id=current_setting('app.tenant_id',true)::uuid);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['wallets','sequences','positions','fee_lots','execution_intents'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=current_setting(''app.tenant_id'',true)::uuid) WITH CHECK (tenant_id=current_setting(''app.tenant_id'',true)::uuid)',t);
 END LOOP;
END $$;
COMMIT;
