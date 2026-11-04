-- Domino V2 fees (docs/v2/V2_FEES.md): Fees earned and Your APR on Base and
-- Arbitrum (item 3.1, path B, 3 Nov 2026). Per chain, the fee follower's
-- cursor, which stays on the V2 index's checkpoints; per position the index
-- knows (domino_v2.positions), where its history starts, its own Uniswap
-- events with the fees each block's settlement paid (the position's own state:
-- liquidity times the change of its fee growth inside, 2^128 apart), points of
-- its fees earned and settled (hourly for 8 days, then one a day) and its state
-- at the cursor. Public chain data only. backend/v2_fees.py writes through the
-- catalogue writer; read-v6's position-fees reads through the catalogue
-- reader. Every row derived from a block carries that block, so a rewind
-- removes exactly what a reorganization voided. Applied after 052, as 052 is.

-- One row per chain: how far the follower read. The cursor is always one of the
-- index's checkpoints (or the deployment's base below the first block), so a
-- rewind of the index is seen here without a call.
CREATE TABLE IF NOT EXISTS domino_v2.fee_cursor (
 chain_id bigint PRIMARY KEY REFERENCES domino_v2.deployments(chain_id) ON DELETE CASCADE,
 -- Domino's first block on the chain (the deployment's start): no history is read below it.
 floor_block bigint NOT NULL CHECK(floor_block>=1),
 block_number bigint NOT NULL,
 block_hash text NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),
 block_timestamp bigint NOT NULL CHECK(block_timestamp>=0),
 -- The cursor was the index's newest checkpoint when it moved: the positions' state was read there (fee_now).
 caught_up boolean NOT NULL DEFAULT false,
 last_error text CHECK(last_error ~ '^[a-z0-9_]{1,80}$'),
 last_error_at bigint,
 updated_at bigint NOT NULL,
 CHECK(block_number>=floor_block-1),
 CHECK((last_error IS NULL)=(last_error_at IS NULL))
);

-- The positions followed: every one the index knows on a chain with a cursor.
CREATE TABLE IF NOT EXISTS domino_v2.fee_positions (
 chain_id bigint NOT NULL,
 dex smallint NOT NULL CHECK(dex IN (3,4)),
 token_id numeric(78,0) NOT NULL CHECK(token_id>0),
 -- Where its history starts: its mint, or Domino's first block for a position
 -- minted before it (its fees owed there are not counted). NULL until found.
 since_kind text CHECK(since_kind IN ('mint','floor')),
 since_block bigint,
 since_hash text CHECK(since_hash ~ '^0x[0-9a-f]{64}$'),
 since_timestamp bigint,
 -- reading: its history is read back to the cursor; following: read with the
 -- cursor; burned: its manager's Transfer to zero, nothing more to read.
 status text NOT NULL CHECK(status IN ('reading','following','burned')),
 -- Every event of the position up to this block is in fee_events.
 through_block bigint NOT NULL,
 through_hash text NOT NULL CHECK(through_hash ~ '^0x[0-9a-f]{64}$'),
 through_timestamp bigint NOT NULL CHECK(through_timestamp>=0),
 -- The pool and range, fixed for a token id: v4 by its pool id, v3 by its pool's address.
 pool jsonb NOT NULL,
 pool_key text NOT NULL CHECK(pool_key ~ '^0x([0-9a-f]{40}|[0-9a-f]{64})$'),
 tick_lower integer NOT NULL,
 tick_upper integer NOT NULL,
 -- The position's state before `since` (a mint's is empty): liquidity, fee
 -- growth inside then, and on v3 what the manager owed with what had accrued.
 base_liquidity numeric(78,0) NOT NULL CHECK(base_liquidity>=0),
 base_last0 numeric(78,0) NOT NULL,
 base_last1 numeric(78,0) NOT NULL,
 base_owed0 numeric(78,0),
 base_owed1 numeric(78,0),
 burned_block bigint,
 joined_at bigint NOT NULL,
 PRIMARY KEY(chain_id,dex,token_id),
 FOREIGN KEY(chain_id,dex,token_id) REFERENCES domino_v2.positions(chain_id,dex,token_id) ON DELETE CASCADE,
 CHECK((since_kind IS NULL)=(since_block IS NULL) AND (since_block IS NULL)=(since_hash IS NULL)
       AND (since_block IS NULL)=(since_timestamp IS NULL)),
 CHECK((status='burned')=(burned_block IS NOT NULL)),
 CHECK((dex=3)=(base_owed0 IS NOT NULL) AND (base_owed0 IS NULL)=(base_owed1 IS NULL)),
 CHECK(tick_lower<tick_upper)
);

-- The position's own events. A settlement row stands for every one of its
-- logs in a block (log_indexes; log_index is the last): the net liquidity
-- change, the state read after the block, the fees that block settled and the
-- running sum since `since`. fees and settled are NULL when they cannot be
-- known (why). A transfer row is its manager's Transfer of the NFT.
CREATE TABLE IF NOT EXISTS domino_v2.fee_events (
 chain_id bigint NOT NULL,
 dex smallint NOT NULL,
 token_id numeric(78,0) NOT NULL,
 block_number bigint NOT NULL,
 log_index integer NOT NULL CHECK(log_index>=0),
 block_hash text NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),
 block_timestamp bigint NOT NULL CHECK(block_timestamp>=0),
 tx_hash text NOT NULL CHECK(tx_hash ~ '^0x[0-9a-f]{64}$'),
 kind text NOT NULL CHECK(kind IN ('increase','decrease','collect','transfer')),
 log_indexes integer[] CHECK(cardinality(log_indexes) BETWEEN 1 AND 256),
 liquidity_delta numeric(78,0),
 liquidity numeric(78,0) CHECK(liquidity>=0),
 last0 numeric(78,0),
 last1 numeric(78,0),
 owed0 numeric(78,0),
 owed1 numeric(78,0),
 fees0 numeric(78,0),
 fees1 numeric(78,0),
 settled0 numeric(78,0),
 settled1 numeric(78,0),
 why text CHECK(why IN ('same_block','liquidity')),
 -- An automatic compound: the vault's Compounded for this token in this
 -- transaction (the V2 index's), with the service fee it charged.
 auto boolean NOT NULL DEFAULT false,
 service_fee0 numeric(78,0),
 service_fee1 numeric(78,0),
 from_address text CHECK(from_address ~ '^0x[0-9a-f]{40}$'),
 to_address text CHECK(to_address ~ '^0x[0-9a-f]{40}$'),
 PRIMARY KEY(chain_id,dex,token_id,block_number,log_index),
 FOREIGN KEY(chain_id,dex,token_id) REFERENCES domino_v2.fee_positions(chain_id,dex,token_id) ON DELETE CASCADE,
 CHECK((kind='transfer')=(from_address IS NOT NULL) AND (from_address IS NULL)=(to_address IS NULL)),
 CHECK((kind='transfer')=(log_indexes IS NULL) AND (log_indexes IS NULL)=(liquidity IS NULL)
       AND (liquidity IS NULL)=(liquidity_delta IS NULL) AND (liquidity IS NULL)=(last0 IS NULL)
       AND (last0 IS NULL)=(last1 IS NULL)),
 CHECK((owed0 IS NULL)=(owed1 IS NULL) AND (fees0 IS NULL)=(fees1 IS NULL) AND (settled0 IS NULL)=(settled1 IS NULL)),
 CHECK(kind='transfer' OR (fees0 IS NULL)=(why IS NOT NULL)),
 CHECK(settled0 IS NULL OR fees0 IS NOT NULL),
 CHECK(auto=(service_fee0 IS NOT NULL) AND (service_fee0 IS NULL)=(service_fee1 IS NULL))
);

-- Measured points: what the position had earned (settled plus what accrued
-- since its last settlement) and settled at a block, cumulative since `since`.
-- One an hour for the last 8 days, then the day's first (kind 'day').
CREATE TABLE IF NOT EXISTS domino_v2.fee_points (
 chain_id bigint NOT NULL,
 dex smallint NOT NULL,
 token_id numeric(78,0) NOT NULL,
 block_number bigint NOT NULL,
 block_timestamp bigint NOT NULL CHECK(block_timestamp>=0),
 -- The hour the point stands for (Unix seconds, a multiple of 3600).
 hour bigint NOT NULL CHECK(hour%3600=0),
 kind text NOT NULL CHECK(kind IN ('hour','day')),
 earned0 numeric(78,0),
 earned1 numeric(78,0),
 settled0 numeric(78,0),
 settled1 numeric(78,0),
 PRIMARY KEY(chain_id,dex,token_id,block_number),
 FOREIGN KEY(chain_id,dex,token_id) REFERENCES domino_v2.fee_positions(chain_id,dex,token_id) ON DELETE CASCADE,
 CHECK((earned0 IS NULL)=(earned1 IS NULL) AND (earned0 IS NULL)=(settled0 IS NULL)
       AND (settled0 IS NULL)=(settled1 IS NULL)),
 CHECK((kind='day')=(hour%86400=0))
);

-- The position at the cursor, read with the events of the same pass (the "now").
CREATE TABLE IF NOT EXISTS domino_v2.fee_now (
 chain_id bigint NOT NULL,
 dex smallint NOT NULL,
 token_id numeric(78,0) NOT NULL,
 block_number bigint NOT NULL,
 block_hash text NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),
 block_timestamp bigint NOT NULL CHECK(block_timestamp>=0),
 state jsonb NOT NULL,
 read_at bigint NOT NULL,
 PRIMARY KEY(chain_id,dex,token_id),
 FOREIGN KEY(chain_id,dex,token_id) REFERENCES domino_v2.fee_positions(chain_id,dex,token_id) ON DELETE CASCADE
);

GRANT SELECT,INSERT,UPDATE,DELETE ON domino_v2.fee_cursor,domino_v2.fee_positions,domino_v2.fee_events,
 domino_v2.fee_points,domino_v2.fee_now TO domino_catalogue_writer;
GRANT SELECT ON domino_v2.fee_cursor,domino_v2.fee_positions,domino_v2.fee_events,domino_v2.fee_points,
 domino_v2.fee_now TO domino_catalogue_reader;
