-- A settlement login may request settlement, but cannot choose the charge.
-- The two signing journals are independent of that login. PostgreSQL does
-- not itself prove chain finality; the trusted journal writers and the
-- keyless receipt verifier must still do that before recording a witness.
CREATE TABLE domino_execution.reverted_receipts (
 owner text NOT NULL,
 intent_id text PRIMARY KEY,
 transaction_hash text NOT NULL UNIQUE CHECK(transaction_hash ~ '^0x[0-9a-f]{64}$'),
 block_number numeric NOT NULL CHECK(block_number=trunc(block_number) AND block_number>=0),
 block_hash text NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),
 gas_used numeric NOT NULL CHECK(gas_used=trunc(gas_used) AND gas_used>0),
 effective_gas_price numeric NOT NULL CHECK(effective_gas_price=trunc(effective_gas_price) AND effective_gas_price>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(owner,intent_id) REFERENCES domino_execution.intents(owner,intent_id),
 FOREIGN KEY(transaction_hash) REFERENCES domino_execution.attempts(transaction_hash)
);
ALTER TABLE domino_execution.reverted_receipts OWNER TO domino_execution_owner;
ALTER TABLE domino_execution.reverted_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE domino_execution.reverted_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY execution_reverted_signer ON domino_execution.reverted_receipts
 TO domino_execution_signer USING(owner=current_setting('domino.execution_owner',true))
 WITH CHECK(owner=current_setting('domino.execution_owner',true));
CREATE POLICY gas_reverted_owner ON domino_execution.reverted_receipts
 FOR SELECT TO domino_execution_owner USING(true);
GRANT SELECT,INSERT ON domino_execution.reverted_receipts TO domino_execution_signer;
REVOKE ALL ON domino_execution.reverted_receipts FROM PUBLIC;

CREATE FUNCTION domino_execution.guard_reverted_receipt() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,domino_execution AS $$
DECLARE j domino_execution.journal; a domino_execution.attempts;
BEGIN
 IF TG_OP<>'INSERT' THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_receipt_immutable';
 END IF;
 PERFORM domino_execution.live_fence(NEW.intent_id);
 SELECT * INTO j FROM domino_execution.journal WHERE intent_id=NEW.intent_id FOR UPDATE;
 SELECT * INTO a FROM domino_execution.attempts WHERE transaction_hash=NEW.transaction_hash;
 IF j.intent_id IS NULL OR a.intent_id IS NULL OR j.owner<>NEW.owner OR a.owner<>NEW.owner
    OR a.intent_id<>NEW.intent_id OR j.state NOT IN ('signed','submitted','broadcast_unknown','included','reorged')
    OR NEW.gas_used>(a.envelope->>'gas')::numeric
    OR NEW.effective_gas_price>(a.envelope->>'maxFeePerGas')::numeric THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_receipt_invalid';
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION domino_execution.guard_reverted_receipt() OWNER TO domino_execution_owner;
REVOKE ALL ON FUNCTION domino_execution.guard_reverted_receipt() FROM PUBLIC;
CREATE TRIGGER execution_reverted_receipt_guard BEFORE INSERT OR UPDATE OR DELETE
 ON domino_execution.reverted_receipts FOR EACH ROW
 EXECUTE FUNCTION domino_execution.guard_reverted_receipt();

CREATE FUNCTION domino_execution.gas_reverted_witness(p_owner text,p_id text)
RETURNS SETOF domino_execution.reverted_receipts LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,domino_execution AS $$
 SELECT * FROM domino_execution.reverted_receipts
 WHERE p_owner ~ '^0x[0-9a-f]{40}$' AND p_id ~ '^0x[0-9a-f]{64}$'
  AND owner=p_owner AND intent_id=p_id;
$$;
ALTER FUNCTION domino_execution.gas_reverted_witness(text,text) OWNER TO domino_execution_owner;
REVOKE ALL ON FUNCTION domino_execution.gas_reverted_witness(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domino_execution.gas_reverted_witness(text,text) TO domino_gas_settlement_worker;

-- Confirmation depth is an execution policy, not chain finality. A separate
-- publisher-only witness is appended after the publisher observes the exact
-- receipt in a canonical block at or behind the RPC finalized head.
CREATE TABLE domino_execution.publication_finality (
 observation_id text PRIMARY KEY REFERENCES domino_execution.publications(observation_id),
 signer text NOT NULL CHECK(signer ~ '^0x[0-9a-f]{40}$'),
 transaction_hash text NOT NULL UNIQUE CHECK(transaction_hash ~ '^0x[0-9a-f]{64}$'),
 included_block_number numeric NOT NULL CHECK(included_block_number=trunc(included_block_number) AND included_block_number>=0),
 included_block_hash text NOT NULL CHECK(included_block_hash ~ '^0x[0-9a-f]{64}$'),
 finalized_head_number numeric NOT NULL CHECK(finalized_head_number=trunc(finalized_head_number) AND finalized_head_number>=included_block_number),
 finalized_head_hash text NOT NULL CHECK(finalized_head_hash ~ '^0x[0-9a-f]{64}$'),
 receipt_status smallint NOT NULL CHECK(receipt_status IN (0,1)),
 gas_used numeric NOT NULL CHECK(gas_used=trunc(gas_used) AND gas_used>0),
 effective_gas_price numeric NOT NULL CHECK(effective_gas_price=trunc(effective_gas_price) AND effective_gas_price>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE domino_execution.publication_finality OWNER TO domino_execution_owner;
ALTER TABLE domino_execution.publication_finality ENABLE ROW LEVEL SECURITY;
ALTER TABLE domino_execution.publication_finality FORCE ROW LEVEL SECURITY;
CREATE POLICY publisher_finality_writer ON domino_execution.publication_finality
 TO domino_execution_publisher USING(true) WITH CHECK(true);
CREATE POLICY publication_finality_owner ON domino_execution.publication_finality
 FOR SELECT TO domino_execution_owner USING(true);
GRANT SELECT,INSERT ON domino_execution.publication_finality TO domino_execution_publisher;
REVOKE ALL ON domino_execution.publication_finality FROM PUBLIC;

CREATE FUNCTION domino_execution.guard_publication_finality() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,domino_execution AS $$
DECLARE p domino_execution.publications;
BEGIN
 IF TG_OP<>'INSERT' THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='publication_finality_immutable';
 END IF;
 SELECT * INTO p FROM domino_execution.publications
  WHERE observation_id=NEW.observation_id FOR UPDATE;
 IF p.observation_id IS NULL OR p.signer<>NEW.signer OR
    p.transaction_hash<>NEW.transaction_hash OR
    p.included_block_number IS DISTINCT FROM NEW.included_block_number OR
    p.included_block_hash IS DISTINCT FROM NEW.included_block_hash OR
    p.gas_used IS DISTINCT FROM NEW.gas_used OR
    p.effective_gas_price IS DISTINCT FROM NEW.effective_gas_price OR
    p.state IS DISTINCT FROM (CASE NEW.receipt_status WHEN 1 THEN 'confirmed' ELSE 'reverted' END) OR
    NEW.gas_used>(p.envelope->>'gas')::numeric OR
    NEW.effective_gas_price>(p.envelope->>'maxFeePerGas')::numeric THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='publication_finality_mismatch';
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION domino_execution.guard_publication_finality() OWNER TO domino_execution_owner;
REVOKE ALL ON FUNCTION domino_execution.guard_publication_finality() FROM PUBLIC;
CREATE TRIGGER execution_publication_finality_guard BEFORE INSERT OR UPDATE OR DELETE
 ON domino_execution.publication_finality FOR EACH ROW
 EXECUTE FUNCTION domino_execution.guard_publication_finality();

-- A cursor advances before RPC reads, so an old unavailable receipt cannot
-- starve newer terminal publications. The next pass wraps and retries it.
CREATE TABLE domino_execution.publication_finality_cursor (
 signer text PRIMARY KEY CHECK(signer ~ '^0x[0-9a-f]{40}$'),
 last_created_at timestamptz,
 last_observation_id text,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((last_created_at IS NULL AND last_observation_id IS NULL) OR
       (last_created_at IS NOT NULL AND last_observation_id ~ '^0x[0-9a-f]{64}$'))
);
ALTER TABLE domino_execution.publication_finality_cursor OWNER TO domino_execution_owner;
ALTER TABLE domino_execution.publication_finality_cursor ENABLE ROW LEVEL SECURITY;
ALTER TABLE domino_execution.publication_finality_cursor FORCE ROW LEVEL SECURITY;
CREATE POLICY publisher_finality_cursor ON domino_execution.publication_finality_cursor
 TO domino_execution_publisher USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE ON domino_execution.publication_finality_cursor
 TO domino_execution_publisher;
REVOKE ALL ON domino_execution.publication_finality_cursor FROM PUBLIC;
CREATE INDEX execution_publication_finality_scan ON domino_execution.publications
 (signer,created_at,observation_id) WHERE state IN ('confirmed','reverted');

-- The same signed bytes may be re-included after a pre-finality reorg. The
-- journal must be able to withdraw an unfinalized revert and drive those
-- exact bytes again; no new nonce or signature is authorized here.
CREATE OR REPLACE FUNCTION domino_execution.preserve_publication() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,domino_execution AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_intent_immutable'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'signed' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_state_conflict'; END IF;
  RETURN NEW;
 END IF;
 IF (to_jsonb(NEW)-ARRAY['state','reason','included_block_number','included_block_hash','gas_used','effective_gas_price','updated_at'])
     IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','reason','included_block_number','included_block_hash','gas_used','effective_gas_price','updated_at']) THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_intent_immutable';
 END IF;
 IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
     (OLD.state='signed' AND NEW.state IN ('submitted','broadcast_unknown','expired','attention'))
     OR (OLD.state IN ('submitted','broadcast_unknown') AND NEW.state IN ('submitted','broadcast_unknown','included','confirmed','reverted','expired','attention'))
     OR (OLD.state='included' AND NEW.state IN ('confirmed','reorged','revoked','expired'))
     OR (OLD.state='confirmed' AND NEW.state IN ('revoked','expired','reorged'))
     OR (OLD.state='reverted' AND NEW.state='reorged' AND NOT EXISTS (
         SELECT 1 FROM domino_execution.publication_finality f WHERE f.observation_id=OLD.observation_id))
     OR (OLD.state='reorged' AND NEW.state IN ('submitted','broadcast_unknown','included','confirmed','reverted','attention','expired'))
     OR (OLD.state='expired' AND NEW.state IN ('submitted','broadcast_unknown'))) THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_state_conflict';
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION domino_execution.preserve_publication() OWNER TO domino_execution_owner;
REVOKE ALL ON FUNCTION domino_execution.preserve_publication() FROM PUBLIC;

CREATE OR REPLACE FUNCTION domino_gas_budget.settle(
 p_cycle_id text,p_leg text,p_spent_wei numeric,p_answer_raw numeric,
 p_round numeric,p_updated_at bigint,p_block_timestamp bigint
) RETURNS TABLE(day date,spent_usd_micros numeric,state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,domino_gas_budget AS $$
DECLARE c domino_gas_budget.claims; spent numeric; now_seconds bigint;
        witnessed numeric; gas_used numeric; gas_price numeric; maximum numeric;
        p domino_execution.publications; f domino_execution.publication_finality;
        j domino_execution.journal;
        a domino_execution.attempts; e domino_execution.effects;
        r domino_execution.reverted_receipts; gas_json jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(4663,28);
 now_seconds:=floor(extract(epoch from clock_timestamp()))::bigint;
 IF p_cycle_id !~ '^0x[0-9a-f]{64}$' OR p_leg NOT IN ('publisher','operator') OR
    p_spent_wei IS NULL OR p_spent_wei<>trunc(p_spent_wei) OR p_spent_wei<=0 OR
    p_spent_wei>=340282366920938463463374607431768211456 OR
    p_answer_raw IS NULL OR p_answer_raw<>trunc(p_answer_raw) OR p_answer_raw<=0 OR
    p_round IS NULL OR p_round<>trunc(p_round) OR floor(p_round/18446744073709551616)<>1 OR
    mod(p_round,18446744073709551616)=0 OR
    p_updated_at IS NULL OR p_block_timestamp IS NULL OR
    p_updated_at<=0 OR p_updated_at>p_block_timestamp OR
    p_block_timestamp>now_seconds OR now_seconds-p_block_timestamp>180 OR
    now_seconds-p_updated_at>7200 THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='gas_settlement_invalid';
 END IF;
 SELECT * INTO c FROM domino_gas_budget.claims
  WHERE cycle_id=p_cycle_id AND leg=p_leg FOR UPDATE;
 IF NOT FOUND THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='gas_reservation_missing';
 END IF;
 IF p_leg='publisher' THEN
  SELECT * INTO p FROM domino_execution.publications WHERE observation_id=p_cycle_id;
  IF p.observation_id IS NULL OR p.signer<>c.signer OR p.state NOT IN ('confirmed','reverted')
     OR p.included_block_number IS NULL OR p.included_block_hash IS NULL
     OR p.gas_used IS NULL OR p.effective_gas_price IS NULL
     OR p.gas_used<=0 OR p.effective_gas_price<=0
     OR octet_length(p.signed_bytes)=0 OR p.transaction_hash !~ '^0x[0-9a-f]{64}$'
     OR coalesce(p.envelope->>'gas','') !~ '^[1-9][0-9]*$'
     OR coalesce(p.envelope->>'maxFeePerGas','') !~ '^[1-9][0-9]*$' THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='gas_settlement_witness_missing';
  END IF;
  SELECT * INTO f FROM domino_execution.publication_finality WHERE observation_id=p_cycle_id;
  IF f.observation_id IS NULL OR f.signer<>p.signer OR
     f.transaction_hash<>p.transaction_hash OR
     f.included_block_number IS DISTINCT FROM p.included_block_number OR
     f.included_block_hash IS DISTINCT FROM p.included_block_hash OR
     f.gas_used IS DISTINCT FROM p.gas_used OR
     f.effective_gas_price IS DISTINCT FROM p.effective_gas_price OR
     f.finalized_head_number<f.included_block_number OR
     f.receipt_status IS DISTINCT FROM (CASE p.state WHEN 'confirmed' THEN 1 ELSE 0 END) THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='gas_settlement_finality_missing';
  END IF;
  gas_used:=f.gas_used; gas_price:=f.effective_gas_price;
  maximum:=(p.envelope->>'gas')::numeric*(p.envelope->>'maxFeePerGas')::numeric;
  IF gas_used>(p.envelope->>'gas')::numeric OR gas_price>(p.envelope->>'maxFeePerGas')::numeric THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='gas_settlement_witness_invalid';
  END IF;
 ELSE
  SELECT * INTO j FROM domino_execution.journal WHERE intent_id=p_cycle_id;
  IF j.intent_id IS NULL OR j.signer<>c.signer OR j.action<>'typed_fee_execution_v4'
     OR j.state NOT IN ('reconciled','reverted') THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='gas_settlement_witness_missing';
  END IF;
  IF j.state='reconciled' THEN
   SELECT * INTO e FROM domino_execution.effects WHERE intent_id=p_cycle_id;
   IF e.intent_id IS NULL OR NOT e.canonical OR e.owner<>j.owner OR
      e.receipt->>'intentId' IS DISTINCT FROM p_cycle_id OR
      e.receipt->>'transactionHash' IS DISTINCT FROM e.transaction_hash OR
      e.receipt->>'finalized' IS DISTINCT FROM 'true' OR
      e.receipt->>'canonical' IS DISTINCT FROM 'true' OR
      e.receipt->'block'->>'hash' IS DISTINCT FROM e.block_hash OR
      e.receipt->'block'->>'number' IS DISTINCT FROM e.block_number::text THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='gas_settlement_witness_invalid';
   END IF;
   gas_json:=e.receipt->'gas';
   IF coalesce(gas_json->>'gasUsedRaw','') !~ '^[1-9][0-9]*$' OR
      coalesce(gas_json->>'effectiveGasPriceRaw','') !~ '^[1-9][0-9]*$' OR
      coalesce(gas_json->>'receiptGasProductWei','') !~ '^[1-9][0-9]*$' OR
      gas_json->>'payer' IS DISTINCT FROM j.signer THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='gas_settlement_witness_invalid';
   END IF;
   gas_used:=(gas_json->>'gasUsedRaw')::numeric;
   gas_price:=(gas_json->>'effectiveGasPriceRaw')::numeric;
   IF (gas_json->>'receiptGasProductWei')::numeric<>gas_used*gas_price THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='gas_settlement_witness_invalid';
   END IF;
   SELECT * INTO a FROM domino_execution.attempts WHERE transaction_hash=e.transaction_hash;
  ELSE
   SELECT * INTO r FROM domino_execution.reverted_receipts WHERE intent_id=p_cycle_id;
   IF r.intent_id IS NULL OR r.owner<>j.owner OR EXISTS(
      SELECT 1 FROM domino_execution.effects WHERE intent_id=p_cycle_id AND canonical) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='gas_settlement_witness_missing';
   END IF;
   gas_used:=r.gas_used;gas_price:=r.effective_gas_price;
   SELECT * INTO a FROM domino_execution.attempts WHERE transaction_hash=r.transaction_hash;
  END IF;
  IF a.intent_id IS NULL OR a.intent_id<>p_cycle_id OR a.owner<>j.owner
     OR octet_length(a.signed_bytes)=0 OR coalesce(a.envelope->>'gas','') !~ '^[1-9][0-9]*$'
     OR coalesce(a.envelope->>'maxFeePerGas','') !~ '^[1-9][0-9]*$' THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='gas_settlement_witness_invalid';
  END IF;
  maximum:=(a.envelope->>'gas')::numeric*(a.envelope->>'maxFeePerGas')::numeric;
  IF gas_used>(a.envelope->>'gas')::numeric OR gas_price>(a.envelope->>'maxFeePerGas')::numeric THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='gas_settlement_witness_invalid';
  END IF;
 END IF;
 witnessed:=gas_used*gas_price;
 IF witnessed<>p_spent_wei OR witnessed<=0 OR witnessed>maximum OR maximum>c.max_cost_wei THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='gas_settlement_witness_invalid';
 END IF;
 IF c.state='settled' THEN
  IF c.spent_wei<>witnessed THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='gas_settlement_conflict';
  END IF;
  RETURN QUERY SELECT c.day,c.spent_usd_micros,c.state;
  RETURN;
 END IF;
 -- The signing-time ETH/USD answer is a floor; the caller cannot reprice down.
 spent:=ceil(witnessed*greatest(c.reserve_answer_raw,p_answer_raw)*1000000/100000000000000000000000000);
 UPDATE domino_gas_budget.claims SET state='settled',spent_wei=witnessed,
  spent_usd_micros=spent,settle_answer_raw=p_answer_raw,settle_round=p_round,
  settled_at=clock_timestamp(),settled_day=(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date
  WHERE cycle_id=p_cycle_id AND leg=p_leg;
 RETURN QUERY SELECT c.day,spent,'settled'::text;
END $$;
ALTER FUNCTION domino_gas_budget.settle(text,text,numeric,numeric,numeric,bigint,bigint)
 OWNER TO domino_execution_owner;
REVOKE ALL ON FUNCTION domino_gas_budget.settle(text,text,numeric,numeric,numeric,bigint,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domino_gas_budget.settle(text,text,numeric,numeric,numeric,bigint,bigint)
 TO domino_gas_settlement_worker;
