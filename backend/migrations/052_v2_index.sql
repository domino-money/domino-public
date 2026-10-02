-- Domino V2 index (docs/v2/V2_INDEXER_READ_API.md). Per chain: the deployment
-- the indexer follows (issue #301's manifest), its committed block ranges, the
-- events of its contracts and of the vaults its factories created, the
-- activity items those events form per wallet, the latest reads of what
-- they name (vaults, positions, mandates, tokens, transactions), and why the
-- chain's automation says vaults and mandates wait. Public chain data only: no
-- session, no private account. The V2 indexer writes through the catalogue
-- writer; the read API reads through the catalogue reader. V1 reads nothing
-- here. Every row derived from a block carries that block, so a rewind removes
-- exactly what a reorganization voided.
CREATE SCHEMA IF NOT EXISTS domino_v2;
GRANT USAGE ON SCHEMA domino_v2 TO domino_catalogue_writer, domino_catalogue_reader;

CREATE TABLE IF NOT EXISTS domino_v2.deployments (
 chain_id bigint PRIMARY KEY CHECK(chain_id>0),
 manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[0-9a-f]{64}$'),
 manifest jsonb NOT NULL,
 start_block bigint NOT NULL CHECK(start_block>=1),
 base_hash text NOT NULL CHECK(base_hash ~ '^0x[0-9a-f]{64}$'),
 next_block bigint NOT NULL,
 revision bigint NOT NULL DEFAULT 0,
 -- The last head a pass observed, and when (wall-clock seconds).
 head_number bigint, head_hash text CHECK(head_hash ~ '^0x[0-9a-f]{64}$'), head_timestamp bigint,
 head_observed_at bigint,
 -- The chain's `finalized` block, observed at most once a minute.
 finalized_number bigint, finalized_hash text CHECK(finalized_hash ~ '^0x[0-9a-f]{64}$'),
 finalized_timestamp bigint, finalized_observed_at bigint,
 last_error text CHECK(last_error ~ '^[a-z0-9_]{1,80}$'),
 last_error_at bigint,
 registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(next_block>=start_block),
 CHECK((head_number IS NULL)=(head_hash IS NULL) AND (head_number IS NULL)=(head_timestamp IS NULL)
       AND (head_number IS NULL)=(head_observed_at IS NULL)),
 CHECK((finalized_number IS NULL)=(finalized_hash IS NULL) AND (finalized_number IS NULL)=(finalized_timestamp IS NULL)
       AND (finalized_number IS NULL)=(finalized_observed_at IS NULL))
);

-- The deployment's components; emitter is NULL for code that never emits on its own.
CREATE TABLE IF NOT EXISTS domino_v2.contracts (
 chain_id bigint NOT NULL REFERENCES domino_v2.deployments(chain_id) ON DELETE CASCADE,
 address text NOT NULL CHECK(address ~ '^0x[0-9a-f]{40}$'),
 component text NOT NULL,
 emitter text CHECK(emitter IN ('registry','price_anchor','vault_factory','zap','auto_exit')),
 dex smallint CHECK(dex IN (3,4)),
 PRIMARY KEY(chain_id,address),
 UNIQUE(chain_id,component)
);

-- One row per committed range: its end block and hash, the V1 reconcile anchors.
CREATE TABLE IF NOT EXISTS domino_v2.checkpoints (
 chain_id bigint NOT NULL REFERENCES domino_v2.deployments(chain_id) ON DELETE CASCADE,
 start_block bigint NOT NULL,
 end_block bigint NOT NULL,
 end_hash text NOT NULL CHECK(end_hash ~ '^0x[0-9a-f]{64}$'),
 end_timestamp bigint NOT NULL CHECK(end_timestamp>=0),
 events integer NOT NULL CHECK(events>=0),
 PRIMARY KEY(chain_id,end_block),
 CHECK(end_block>=start_block)
);

-- Vaults the deployment's factories created (VaultCreated), followed from their creation.
CREATE TABLE IF NOT EXISTS domino_v2.vaults (
 chain_id bigint NOT NULL REFERENCES domino_v2.deployments(chain_id) ON DELETE CASCADE,
 vault text NOT NULL CHECK(vault ~ '^0x[0-9a-f]{40}$'),
 factory text NOT NULL CHECK(factory ~ '^0x[0-9a-f]{40}$'),
 dex smallint NOT NULL CHECK(dex IN (3,4)),
 owner text NOT NULL CHECK(owner ~ '^0x[0-9a-f]{40}$'),
 root_token_id numeric(78,0) NOT NULL CHECK(root_token_id>0),
 owner_nonce numeric(78,0) NOT NULL CHECK(owner_nonce>=0),
 block_number bigint NOT NULL,
 log_index integer NOT NULL,
 tx_hash text NOT NULL CHECK(tx_hash ~ '^0x[0-9a-f]{64}$'),
 PRIMARY KEY(chain_id,vault)
);
CREATE INDEX IF NOT EXISTS v2_vaults_by_owner ON domino_v2.vaults(owner,chain_id,block_number);

-- Every decoded event, its arguments as JSON (integers as decimal strings) and
-- who it concerns. owner: the wallet; vault: the vault; dex and token_id: the
-- position; ref: the intent, plan or mandate hash binding a receipt.
CREATE TABLE IF NOT EXISTS domino_v2.logs (
 chain_id bigint NOT NULL REFERENCES domino_v2.deployments(chain_id) ON DELETE CASCADE,
 block_number bigint NOT NULL,
 log_index integer NOT NULL CHECK(log_index>=0),
 block_hash text NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),
 block_timestamp bigint NOT NULL CHECK(block_timestamp>=0),
 tx_hash text NOT NULL CHECK(tx_hash ~ '^0x[0-9a-f]{64}$'),
 tx_index integer NOT NULL CHECK(tx_index>=0),
 address text NOT NULL CHECK(address ~ '^0x[0-9a-f]{40}$'),
 emitter text NOT NULL CHECK(emitter IN ('registry','price_anchor','vault_factory','vault','zap','auto_exit')),
 event text NOT NULL CHECK(event ~ '^[A-Z][A-Za-z0-9]{1,63}$'),
 args jsonb NOT NULL,
 owner text CHECK(owner ~ '^0x[0-9a-f]{40}$'),
 vault text CHECK(vault ~ '^0x[0-9a-f]{40}$'),
 dex smallint CHECK(dex IN (3,4)),
 token_id numeric(78,0),
 ref text CHECK(ref ~ '^0x[0-9a-f]{64}$'),
 PRIMARY KEY(chain_id,block_number,log_index)
);
CREATE INDEX IF NOT EXISTS v2_logs_by_tx ON domino_v2.logs(chain_id,tx_hash,log_index);
CREATE INDEX IF NOT EXISTS v2_logs_by_address ON domino_v2.logs(chain_id,address,event,block_number);
CREATE INDEX IF NOT EXISTS v2_logs_by_owner ON domino_v2.logs(owner,chain_id) WHERE owner IS NOT NULL;
CREATE INDEX IF NOT EXISTS v2_logs_by_ref ON domino_v2.logs(chain_id,ref) WHERE ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS v2_logs_by_position ON domino_v2.logs(chain_id,dex,token_id) WHERE token_id IS NOT NULL;

-- The receipts each wallet sees: one row per item and wallet, naming exactly the
-- logs the item consists of (all in one transaction).
CREATE TABLE IF NOT EXISTS domino_v2.activity (
 chain_id bigint NOT NULL REFERENCES domino_v2.deployments(chain_id) ON DELETE CASCADE,
 block_number bigint NOT NULL,
 log_index integer NOT NULL,
 wallet text NOT NULL CHECK(wallet ~ '^0x[0-9a-f]{40}$'),
 kind text NOT NULL CHECK(kind IN ('s1_action','zap_event','vault_created','vault_execution','vault_event',
                                   'auto_exit','auto_exit_event')),
 block_timestamp bigint NOT NULL,
 tx_hash text NOT NULL CHECK(tx_hash ~ '^0x[0-9a-f]{64}$'),
 address text NOT NULL CHECK(address ~ '^0x[0-9a-f]{40}$'),
 vault text CHECK(vault ~ '^0x[0-9a-f]{40}$'),
 ref text CHECK(ref ~ '^0x[0-9a-f]{64}$'),
 log_indexes integer[] NOT NULL CHECK(cardinality(log_indexes) BETWEEN 1 AND 256),
 PRIMARY KEY(chain_id,block_number,log_index,wallet)
);
CREATE INDEX IF NOT EXISTS v2_activity_by_wallet
 ON domino_v2.activity(wallet,block_timestamp DESC,chain_id DESC,block_number DESC,log_index DESC);

-- Positions the events name: vault roots and successors, and positions an S1
-- action created or changed. wallet: the vault owner or the action's recipient.
CREATE TABLE IF NOT EXISTS domino_v2.positions (
 chain_id bigint NOT NULL REFERENCES domino_v2.deployments(chain_id) ON DELETE CASCADE,
 dex smallint NOT NULL CHECK(dex IN (3,4)),
 token_id numeric(78,0) NOT NULL CHECK(token_id>0),
 source text NOT NULL CHECK(source IN ('vault_root','vault_successor','s1')),
 vault text CHECK(vault ~ '^0x[0-9a-f]{40}$'),
 wallet text NOT NULL CHECK(wallet ~ '^0x[0-9a-f]{40}$'),
 first_block bigint NOT NULL,
 last_event_block bigint NOT NULL,
 PRIMARY KEY(chain_id,dex,token_id),
 CHECK((source='s1')=(vault IS NULL)),
 CHECK(last_event_block>=first_block)
);
CREATE INDEX IF NOT EXISTS v2_positions_by_wallet ON domino_v2.positions(wallet,chain_id);
CREATE INDEX IF NOT EXISTS v2_positions_by_vault ON domino_v2.positions(chain_id,vault) WHERE vault IS NOT NULL;

-- The latest read of each position, at a pinned block (v2_uniswap).
CREATE TABLE IF NOT EXISTS domino_v2.position_snapshots (
 chain_id bigint NOT NULL,
 dex smallint NOT NULL,
 token_id numeric(78,0) NOT NULL,
 block_number bigint NOT NULL,
 block_hash text NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),
 block_timestamp bigint NOT NULL,
 status text NOT NULL CHECK(status IN ('live','burned','unavailable')),
 owner text CHECK(owner ~ '^0x[0-9a-f]{40}$'),
 state jsonb,
 reason text CHECK(reason ~ '^[a-z0-9_]{1,80}$'),
 read_at bigint NOT NULL,
 PRIMARY KEY(chain_id,dex,token_id),
 FOREIGN KEY(chain_id,dex,token_id) REFERENCES domino_v2.positions(chain_id,dex,token_id) ON DELETE CASCADE,
 CHECK((status='live')=(owner IS NOT NULL AND state IS NOT NULL)),
 CHECK((status='unavailable')=(reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS v2_position_snapshots_by_owner ON domino_v2.position_snapshots(owner) WHERE owner IS NOT NULL;

-- The latest read of each vault's own views, at a pinned block.
CREATE TABLE IF NOT EXISTS domino_v2.vault_snapshots (
 chain_id bigint NOT NULL,
 vault text NOT NULL,
 block_number bigint NOT NULL,
 block_hash text NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),
 block_timestamp bigint NOT NULL,
 status text NOT NULL CHECK(status IN ('read','unavailable')),
 state jsonb,
 reason text CHECK(reason ~ '^[a-z0-9_]{1,80}$'),
 read_at bigint NOT NULL,
 PRIMARY KEY(chain_id,vault),
 FOREIGN KEY(chain_id,vault) REFERENCES domino_v2.vaults(chain_id,vault) ON DELETE CASCADE,
 CHECK((status='read')=(state IS NOT NULL)),
 CHECK((status='unavailable')=(reason IS NOT NULL))
);

-- A registered mandate's terms (IDominoAutoExitExtension.mandateOf), read once:
-- they never change; the status comes from the events.
CREATE TABLE IF NOT EXISTS domino_v2.mandates (
 chain_id bigint NOT NULL REFERENCES domino_v2.deployments(chain_id) ON DELETE CASCADE,
 mandate_hash text NOT NULL CHECK(mandate_hash ~ '^0x[0-9a-f]{64}$'),
 block_number bigint NOT NULL,
 terms jsonb NOT NULL,
 PRIMARY KEY(chain_id,mandate_hash)
);

-- The receipts of the transactions activity items belong to: who sent them and what gas they paid.
CREATE TABLE IF NOT EXISTS domino_v2.transactions (
 chain_id bigint NOT NULL REFERENCES domino_v2.deployments(chain_id) ON DELETE CASCADE,
 tx_hash text NOT NULL CHECK(tx_hash ~ '^0x[0-9a-f]{64}$'),
 block_number bigint NOT NULL,
 block_hash text NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),
 sender text NOT NULL CHECK(sender ~ '^0x[0-9a-f]{40}$'),
 status smallint NOT NULL CHECK(status IN (0,1)),
 gas_used numeric(78,0) NOT NULL,
 effective_gas_price numeric(78,0) NOT NULL,
 -- OP Stack's L1 data fee, when the receipt carries one; NULL elsewhere.
 l1_fee numeric(78,0),
 PRIMARY KEY(chain_id,tx_hash)
);

-- Token metadata, read once per token: untrusted text, decimals never guessed.
CREATE TABLE IF NOT EXISTS domino_v2.tokens (
 chain_id bigint NOT NULL,
 address text NOT NULL CHECK(address ~ '^0x[0-9a-f]{40}$'),
 decimals smallint CHECK(decimals BETWEEN 0 AND 255),
 symbol text CHECK(length(symbol) BETWEEN 1 AND 40),
 status text NOT NULL CHECK(status IN ('available','partial','unavailable')),
 issues jsonb NOT NULL DEFAULT '{}'::jsonb,
 block_number bigint NOT NULL,
 PRIMARY KEY(chain_id,address)
);

-- Why vaults and mandates wait, as the chain's automation last reported it
-- (its public waitingFile, docs/v2/V2_AUTOMATION_BACKEND.md), read by the
-- indexer (v2_waiting). Not chain-derived: a rewind leaves it alone.
CREATE TABLE IF NOT EXISTS domino_v2.waiting_reports (
 chain_id bigint PRIMARY KEY REFERENCES domino_v2.deployments(chain_id) ON DELETE CASCADE,
 status text NOT NULL CHECK(status IN ('read','unavailable')),
 -- The automation pass the file reports: its head's number and time.
 block bigint CHECK(block>=0),
 block_timestamp bigint CHECK(block_timestamp>=0),
 reason text CHECK(reason ~ '^[a-z0-9_]{1,80}$'),
 read_at bigint NOT NULL,
 CHECK((status='read')=(block IS NOT NULL) AND (block IS NULL)=(block_timestamp IS NULL)),
 CHECK((status='unavailable')=(reason IS NOT NULL))
);
-- One row per subject of the last file read: its reason, since when it has
-- held (the time and block of the first pass that gave it, as the automation
-- records them), the pass that decided it, and the last presimulation revert.
CREATE TABLE IF NOT EXISTS domino_v2.waiting (
 chain_id bigint NOT NULL REFERENCES domino_v2.deployments(chain_id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('vault','mandate')),
 subject text NOT NULL CHECK(subject ~ '^0x([0-9a-f]{40}|[0-9a-f]{64})$'),
 reason text NOT NULL CHECK(reason ~ '^[a-z0-9_]{1,100}$'),
 since bigint NOT NULL CHECK(since>=0),
 since_block bigint NOT NULL CHECK(since_block>=0),
 at bigint NOT NULL,
 block bigint NOT NULL CHECK(block>=0),
 revert text CHECK(revert ~ '^[a-z0-9_]{1,100}$'),
 revert_at bigint,
 revert_block bigint,
 CHECK(since<=at AND since_block<=block),
 CHECK((revert IS NULL)=(revert_at IS NULL) AND (revert IS NULL)=(revert_block IS NULL)),
 PRIMARY KEY(chain_id,kind,subject)
);

GRANT SELECT,INSERT,UPDATE,DELETE ON domino_v2.deployments,domino_v2.contracts,domino_v2.checkpoints,
 domino_v2.vaults,domino_v2.logs,domino_v2.activity,domino_v2.positions,domino_v2.position_snapshots,
 domino_v2.vault_snapshots,domino_v2.mandates,domino_v2.transactions,domino_v2.tokens,domino_v2.waiting_reports,
 domino_v2.waiting TO domino_catalogue_writer;
GRANT SELECT ON domino_v2.deployments,domino_v2.contracts,domino_v2.checkpoints,domino_v2.vaults,domino_v2.logs,
 domino_v2.activity,domino_v2.positions,domino_v2.position_snapshots,domino_v2.vault_snapshots,domino_v2.mandates,
 domino_v2.transactions,domino_v2.tokens,domino_v2.waiting_reports,domino_v2.waiting TO domino_catalogue_reader;
