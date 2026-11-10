-- Points, season 1 (docs/points/POINTS.md), part 1: the revenue ledger. Per
-- chain, the ledger's cursor, which stays on the V2 index's checkpoints, and
-- one row per Domino fee the index holds (FeeCharged: assisted swap,
-- automation, Auto-exit) with its payer, valued in USD as read-v6 values a
-- token, at a checkpoint: the fee's own (the first at or after its block) or,
-- for a fee reached late whose block could no longer be read, the index's
-- newest, said so. When Domino's operator sent the fee's transaction, the gas
-- it paid is valued at the same checkpoint and shared among the transaction's
-- fees by value; a fee's net value never goes below zero. No rule of a season
-- (its window, exclusions, floors, referrals) applies here: the points engine
-- reads these rows. Public chain data only. backend/points_ledger.py writes
-- through the catalogue writer. Every row carries its block, so a rewind
-- removes exactly what a reorganization voided. Applied after 052, as 054 is.

CREATE SCHEMA IF NOT EXISTS domino_points;
GRANT USAGE ON SCHEMA domino_points TO domino_catalogue_writer, domino_catalogue_reader;

-- One row per chain: how far the ledger read. The cursor is always one of the
-- index's checkpoints (or the deployment's base below the first block), so a
-- rewind of the index is seen here without a call.
CREATE TABLE IF NOT EXISTS domino_points.ledger_cursor (
 chain_id bigint PRIMARY KEY REFERENCES domino_v2.deployments(chain_id) ON DELETE CASCADE,
 -- Domino's first block on the chain (the deployment's start): no fee exists below it.
 floor_block bigint NOT NULL CHECK(floor_block>=1),
 block_number bigint NOT NULL,
 block_hash text NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),
 -- 0 while the cursor is the deployment's base (its header is never read).
 block_timestamp bigint NOT NULL CHECK(block_timestamp>=0),
 -- The cursor was the index's newest checkpoint when it moved.
 caught_up boolean NOT NULL DEFAULT false,
 last_error text CHECK(last_error ~ '^[a-z0-9_]{1,80}$'),
 last_error_at bigint,
 updated_at bigint NOT NULL,
 CHECK(block_number>=floor_block-1),
 CHECK((last_error IS NULL)=(last_error_at IS NULL))
);

-- One row per FeeCharged, keyed as the index keys its log.
CREATE TABLE IF NOT EXISTS domino_points.revenue (
 chain_id bigint NOT NULL REFERENCES domino_v2.deployments(chain_id) ON DELETE CASCADE,
 block_number bigint NOT NULL,
 log_index integer NOT NULL CHECK(log_index>=0),
 block_hash text NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),
 block_timestamp bigint NOT NULL CHECK(block_timestamp>=0),
 tx_hash text NOT NULL CHECK(tx_hash ~ '^0x[0-9a-f]{64}$'),
 -- DominoV2Types.FEE_KIND_*: 1 assisted swap, 2 automation, 3 Auto-exit.
 kind smallint NOT NULL CHECK(kind IN (1,2,3)),
 token text NOT NULL CHECK(token ~ '^0x[0-9a-f]{40}$'),
 payer text NOT NULL CHECK(payer ~ '^0x[0-9a-f]{40}$'),
 amount numeric(78,0) NOT NULL CHECK(amount>=0),
 ref text NOT NULL CHECK(ref ~ '^0x[0-9a-f]{64}$'),
 -- NULL when the token's decimals could not be read: the fee then has no value.
 decimals smallint CHECK(decimals BETWEEN 0 AND 77),
 -- Where it was valued: the checkpoint and whether it was the index's newest instead of the fee's own.
 price_block bigint NOT NULL,
 price_late boolean NOT NULL,
 -- USD per whole token, and read-v6's source; or no price and read-v6's reason (no qualified pool, ...).
 token_usd numeric(60,18) CHECK(token_usd>=0),
 price_source text CHECK(price_source ~ '^[a-z0-9_]{1,40}$'),
 price_reason text CHECK(price_reason ~ '^[a-z0-9_]{1,80}$'),
 gross_usd numeric(60,18) NOT NULL CHECK(gross_usd>=0),
 -- The transaction's gas when Domino's operator sent it (wei, OP Stack's L1 fee included); NULL when the payer did.
 tx_gas_wei numeric(78,0) CHECK(tx_gas_wei>=0),
 -- This fee's share of that gas in USD (by value among the transaction's fees), and why it could not be valued.
 gas_usd numeric(60,18) NOT NULL CHECK(gas_usd>=0),
 gas_reason text CHECK(gas_reason ~ '^[a-z0-9_]{1,80}$'),
 net_usd numeric(60,18) NOT NULL CHECK(net_usd>=0),
 recorded_at bigint NOT NULL,
 PRIMARY KEY(chain_id,block_number,log_index),
 CHECK((token_usd IS NULL)=(price_source IS NULL)),
 CHECK((token_usd IS NULL)=(price_reason IS NOT NULL)),
 CHECK(token_usd IS NULL OR decimals IS NOT NULL),
 CHECK(tx_gas_wei IS NOT NULL OR (gas_usd=0 AND gas_reason IS NULL)),
 CHECK(gas_reason IS NULL OR net_usd=0),
 CHECK(net_usd<=gross_usd)
);
CREATE INDEX IF NOT EXISTS points_revenue_by_payer ON domino_points.revenue(payer,block_timestamp);
CREATE INDEX IF NOT EXISTS points_revenue_by_time ON domino_points.revenue(block_timestamp);

GRANT SELECT,INSERT,UPDATE,DELETE ON domino_points.ledger_cursor,domino_points.revenue TO domino_catalogue_writer;
GRANT SELECT ON domino_points.ledger_cursor,domino_points.revenue TO domino_catalogue_reader;
