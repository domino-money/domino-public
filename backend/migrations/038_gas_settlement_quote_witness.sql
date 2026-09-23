-- Isolated ETH/USD settlement quote proof. The settlement LOGIN can neither
-- append a quote nor choose its amount; the keyless reservation/oracle peer
-- reads Chainlink and writes one durable witness per attempt. No live unit is
-- started by this migration.
CREATE TABLE domino_gas_budget.settlement_quote_witnesses (
 witness_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 cycle_id text NOT NULL,
 leg text NOT NULL,
 answer_raw numeric NOT NULL CHECK(answer_raw=trunc(answer_raw) AND answer_raw>0),
 round numeric NOT NULL CHECK(round=trunc(round) AND round>0),
 answer_updated_at bigint NOT NULL CHECK(answer_updated_at>0),
 block_number bigint NOT NULL CHECK(block_number>0),
 block_hash text NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),
 block_timestamp bigint NOT NULL CHECK(block_timestamp>0),
 attested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(cycle_id,leg) REFERENCES domino_gas_budget.claims(cycle_id,leg)
);
ALTER TABLE domino_gas_budget.settlement_quote_witnesses OWNER TO domino_execution_owner;
REVOKE ALL ON domino_gas_budget.settlement_quote_witnesses FROM PUBLIC;
REVOKE ALL ON SEQUENCE domino_gas_budget.settlement_quote_witnesses_witness_id_seq FROM PUBLIC;
CREATE INDEX gas_settlement_quote_latest ON domino_gas_budget.settlement_quote_witnesses
 (cycle_id,leg,attested_at DESC,witness_id DESC);

CREATE FUNCTION domino_gas_budget.attest_settlement_quote(
 p_cycle_id text,p_leg text,p_answer_raw numeric,p_round numeric,
 p_updated_at bigint,p_block_number bigint,p_block_hash text,p_block_timestamp bigint
) RETURNS TABLE(answer_raw numeric,round numeric,answer_updated_at bigint,
 block_number bigint,block_hash text,block_timestamp bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,domino_gas_budget AS $$
DECLARE c domino_gas_budget.claims; now_seconds bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(4663,28);
 now_seconds:=floor(extract(epoch from clock_timestamp()))::bigint;
 IF p_cycle_id !~ '^0x[0-9a-f]{64}$' OR p_leg NOT IN ('publisher','operator') OR
    p_answer_raw IS NULL OR p_answer_raw<>trunc(p_answer_raw) OR p_answer_raw<=0 OR
    p_round IS NULL OR p_round<>trunc(p_round) OR floor(p_round/18446744073709551616)<>1 OR
    mod(p_round,18446744073709551616)=0 OR
    p_updated_at IS NULL OR p_block_number IS NULL OR p_block_hash IS NULL OR
    p_block_timestamp IS NULL OR p_block_number<=0 OR
    p_block_hash !~ '^0x[0-9a-f]{64}$' OR
    p_updated_at<=0 OR p_updated_at>p_block_timestamp OR
    p_block_timestamp>now_seconds OR now_seconds-p_block_timestamp>180 OR
    now_seconds-p_updated_at>7200 THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='gas_settlement_quote_invalid';
 END IF;
 SELECT * INTO c FROM domino_gas_budget.claims
  WHERE cycle_id=p_cycle_id AND leg=p_leg FOR UPDATE;
 IF c.cycle_id IS NULL OR c.state<>'reserved' THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='gas_reservation_missing';
 END IF;
 INSERT INTO domino_gas_budget.settlement_quote_witnesses
  (cycle_id,leg,answer_raw,round,answer_updated_at,block_number,block_hash,block_timestamp)
 VALUES(p_cycle_id,p_leg,p_answer_raw,p_round,p_updated_at,p_block_number,p_block_hash,p_block_timestamp);
 RETURN QUERY SELECT p_answer_raw,p_round,p_updated_at,p_block_number,p_block_hash,p_block_timestamp;
END $$;
ALTER FUNCTION domino_gas_budget.attest_settlement_quote(text,text,numeric,numeric,bigint,bigint,text,bigint)
 OWNER TO domino_execution_owner;
REVOKE ALL ON FUNCTION domino_gas_budget.attest_settlement_quote(text,text,numeric,numeric,bigint,bigint,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domino_gas_budget.attest_settlement_quote(text,text,numeric,numeric,bigint,bigint,text,bigint)
 TO domino_gas_budget_worker;

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
        q domino_gas_budget.settlement_quote_witnesses;
        receipt_block numeric; quote_high numeric;
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
  receipt_block:=f.included_block_number;
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
   receipt_block:=e.block_number;
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
   receipt_block:=r.block_number;
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
 -- The settlement login cannot nominate an ETH/USD price. Only the separate
 -- reservation/oracle peer can append a witness, using its own canonical RPC
 -- read. The freshest witness must be recent in the database clock and later
 -- than the charged receipt block. Historical high answers are a floor.
 SELECT * INTO q FROM domino_gas_budget.settlement_quote_witnesses
  WHERE cycle_id=p_cycle_id AND leg=p_leg ORDER BY attested_at DESC,witness_id DESC LIMIT 1;
 IF q.witness_id IS NULL OR q.attested_at<clock_timestamp()-interval '30 seconds'
    OR q.block_number<receipt_block
    OR q.answer_raw IS DISTINCT FROM p_answer_raw
    OR q.round IS DISTINCT FROM p_round
    OR q.answer_updated_at IS DISTINCT FROM p_updated_at
    OR q.block_timestamp IS DISTINCT FROM p_block_timestamp THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='gas_settlement_quote_missing';
 END IF;
 SELECT max(answer_raw) INTO quote_high
  FROM domino_gas_budget.settlement_quote_witnesses
  WHERE cycle_id=p_cycle_id AND leg=p_leg;
 spent:=ceil(witnessed*greatest(c.reserve_answer_raw,quote_high)*1000000/100000000000000000000000000);
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
