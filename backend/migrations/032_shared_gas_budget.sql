-- Pilot operator/publisher gas ceiling: USD 20 per Sao Paulo calendar day.
-- A private worker reserves before signing. Pending/unknown transactions hold
-- their reservation; only verified final costs settle it. No login is enabled.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='domino_gas_budget_worker') THEN
  CREATE ROLE domino_gas_budget_worker NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='domino_gas_settlement_worker') THEN
  CREATE ROLE domino_gas_settlement_worker NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='domino_gas_budget_worker' AND
  (rolsuper OR rolinherit OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)) OR
  EXISTS(SELECT 1 FROM pg_roles WHERE rolname='domino_gas_settlement_worker' AND
  (rolsuper OR rolinherit OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)) OR
  EXISTS(SELECT 1 FROM pg_auth_members WHERE member IN
   (SELECT oid FROM pg_roles WHERE rolname IN ('domino_gas_budget_worker','domino_gas_settlement_worker'))) THEN
  RAISE EXCEPTION 'gas_budget_role_must_be_isolated';
 END IF;
END $$;
CREATE SCHEMA domino_gas_budget AUTHORIZATION domino_execution_owner;
REVOKE ALL ON SCHEMA domino_gas_budget FROM PUBLIC;
GRANT USAGE ON SCHEMA domino_gas_budget TO domino_gas_budget_worker,domino_gas_settlement_worker;

CREATE TABLE domino_gas_budget.days (
 day date PRIMARY KEY,
 cap_usd_micros numeric NOT NULL DEFAULT 20000000 CHECK(cap_usd_micros=20000000)
);
ALTER TABLE domino_gas_budget.days OWNER TO domino_execution_owner;
CREATE TABLE domino_gas_budget.claims (
 cycle_id text NOT NULL CHECK(cycle_id ~ '^0x[0-9a-f]{64}$'),
 leg text NOT NULL CHECK(leg IN ('publisher','operator')),
 signer text NOT NULL CHECK(signer ~ '^0x[0-9a-f]{40}$'),
 day date NOT NULL REFERENCES domino_gas_budget.days(day),
 max_cost_wei numeric NOT NULL CHECK(max_cost_wei=trunc(max_cost_wei) AND max_cost_wei>0 AND max_cost_wei<340282366920938463463374607431768211456),
 reserved_usd_micros numeric NOT NULL CHECK(reserved_usd_micros=trunc(reserved_usd_micros) AND reserved_usd_micros>0),
 reserve_answer_raw numeric NOT NULL CHECK(reserve_answer_raw=trunc(reserve_answer_raw) AND reserve_answer_raw>0),
 reserve_round numeric NOT NULL CHECK(reserve_round=trunc(reserve_round) AND reserve_round>0),
 reserve_updated_at bigint NOT NULL CHECK(reserve_updated_at>0),
 reserve_block_number bigint NOT NULL CHECK(reserve_block_number>0),
 reserve_block_hash text NOT NULL CHECK(reserve_block_hash ~ '^0x[0-9a-f]{64}$'),
 reserve_block_timestamp bigint NOT NULL CHECK(reserve_block_timestamp>0),
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','settled')),
 spent_wei numeric CHECK(spent_wei=trunc(spent_wei) AND spent_wei>=0),
 spent_usd_micros numeric CHECK(spent_usd_micros=trunc(spent_usd_micros) AND spent_usd_micros>=0),
 settle_answer_raw numeric,
 settle_round numeric,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 refreshed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 settled_at timestamptz,
 settled_day date,
 PRIMARY KEY(cycle_id,leg),
 CHECK((state='reserved' AND spent_wei IS NULL AND spent_usd_micros IS NULL AND settled_at IS NULL AND settled_day IS NULL) OR
       (state='settled' AND spent_wei IS NOT NULL AND spent_usd_micros IS NOT NULL AND settled_at IS NOT NULL AND settled_day IS NOT NULL))
);
ALTER TABLE domino_gas_budget.claims OWNER TO domino_execution_owner;
CREATE INDEX gas_budget_day_claims ON domino_gas_budget.claims(day);
REVOKE ALL ON ALL TABLES IN SCHEMA domino_gas_budget FROM PUBLIC;

CREATE FUNCTION domino_gas_budget.reserve(
 p_cycle_id text, p_leg text, p_signer text, p_max_cost_wei numeric,
 p_answer_raw numeric, p_round numeric, p_updated_at bigint,
 p_block_number bigint, p_block_hash text, p_block_timestamp bigint,
 p_reservation_bps integer
) RETURNS TABLE(day date,reserved_usd_micros numeric,state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,domino_gas_budget AS $$
DECLARE d date; c domino_gas_budget.claims; reserved numeric; used numeric; new_max numeric; now_seconds bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(4663,28);
 now_seconds:=floor(extract(epoch from clock_timestamp()))::bigint;
 IF p_cycle_id !~ '^0x[0-9a-f]{64}$' OR p_leg NOT IN ('publisher','operator') OR
    p_signer !~ '^0x[0-9a-f]{40}$' OR p_max_cost_wei IS NULL OR
    p_max_cost_wei<>trunc(p_max_cost_wei) OR p_max_cost_wei<=0 OR
    p_max_cost_wei>=340282366920938463463374607431768211456 OR
    p_answer_raw IS NULL OR p_answer_raw<>trunc(p_answer_raw) OR p_answer_raw<=0 OR
    p_round IS NULL OR p_round<>trunc(p_round) OR floor(p_round/18446744073709551616)<>1 OR
    mod(p_round,18446744073709551616)=0 OR
    p_updated_at IS NULL OR p_block_timestamp IS NULL OR p_block_number IS NULL OR
    p_block_number<=0 OR p_block_hash !~ '^0x[0-9a-f]{64}$' OR
    p_reservation_bps<>12000 OR
    p_updated_at<=0 OR p_updated_at>p_block_timestamp OR
    p_block_timestamp>now_seconds OR now_seconds-p_block_timestamp>180 OR
    now_seconds-p_updated_at>7200 THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='gas_reservation_invalid';
 END IF;
 d:=(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
 INSERT INTO domino_gas_budget.days(day) VALUES(d) ON CONFLICT DO NOTHING;
 PERFORM 1 FROM domino_gas_budget.days WHERE days.day=d FOR UPDATE;
 -- The day row serializes claims from both wallets and every worker process.
 SELECT * INTO c FROM domino_gas_budget.claims
  WHERE cycle_id=p_cycle_id AND leg=p_leg FOR UPDATE;
 reserved:=ceil(p_max_cost_wei*p_answer_raw*1000000*12000/1000000000000000000000000000000);
 -- An existing claim may be retried after a pause. Re-price it with a fresh
 -- feed read before authorizing another signature, but never lower its USD
 -- reservation or forget the highest observed ETH/USD answer.
 IF FOUND THEN
  IF c.signer<>p_signer THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='gas_reservation_conflict';
  END IF;
  IF c.state='settled' THEN
   RETURN QUERY SELECT c.day,c.reserved_usd_micros,c.state;
   RETURN;
  END IF;
  IF c.day>d THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='gas_reservation_conflict';
  END IF;
  new_max:=greatest(c.max_cost_wei,p_max_cost_wei);
  reserved:=greatest(c.reserved_usd_micros,
    ceil(new_max*greatest(c.reserve_answer_raw,p_answer_raw)*1000000*12000/
         1000000000000000000000000000000));
  SELECT coalesce(sum(CASE WHEN claims.state='settled' THEN claims.spent_usd_micros
                           ELSE claims.reserved_usd_micros END),0) INTO used
   FROM domino_gas_budget.claims
   WHERE claims.day=d OR (claims.day<d AND
         (claims.state='reserved' OR claims.settled_day=d));
  IF used-c.reserved_usd_micros+reserved>20000000 THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='gas_daily_cap_exceeded';
  END IF;
  UPDATE domino_gas_budget.claims SET max_cost_wei=new_max,reserved_usd_micros=reserved,
   reserve_answer_raw=greatest(c.reserve_answer_raw,p_answer_raw),
   reserve_round=p_round,reserve_updated_at=p_updated_at,
   reserve_block_number=p_block_number,reserve_block_hash=p_block_hash,
   reserve_block_timestamp=p_block_timestamp,refreshed_at=clock_timestamp()
   WHERE cycle_id=p_cycle_id AND leg=p_leg;
  RETURN QUERY SELECT c.day,reserved,'reserved'::text;
  RETURN;
 END IF;
 -- denominator above is 10^18 wei * 10^8 feed decimals * 10^4 bps.
 -- A signed transaction crossing midnight continues to consume the new day's
 -- budget until final reconciliation. This prevents two days of reservations
 -- from funding more than one day's still-live obligations at once.
 SELECT coalesce(sum(CASE WHEN claims.state='settled' THEN claims.spent_usd_micros
                          ELSE claims.reserved_usd_micros END),0) INTO used
  FROM domino_gas_budget.claims
  WHERE claims.day=d OR (claims.day<d AND
        (claims.state='reserved' OR claims.settled_day=d));
 IF reserved<=0 OR used+reserved>20000000 THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='gas_daily_cap_exceeded';
 END IF;
 INSERT INTO domino_gas_budget.claims(cycle_id,leg,signer,day,max_cost_wei,
  reserved_usd_micros,reserve_answer_raw,reserve_round,reserve_updated_at,
  reserve_block_number,reserve_block_hash,reserve_block_timestamp)
 VALUES(p_cycle_id,p_leg,p_signer,d,p_max_cost_wei,reserved,p_answer_raw,p_round,
        p_updated_at,p_block_number,p_block_hash,p_block_timestamp)
 ON CONFLICT DO NOTHING;
 SELECT * INTO c FROM domino_gas_budget.claims
  WHERE cycle_id=p_cycle_id AND leg=p_leg FOR UPDATE;
 IF c.signer<>p_signer OR c.max_cost_wei<>p_max_cost_wei THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='gas_reservation_conflict';
 END IF;
 RETURN QUERY SELECT c.day,c.reserved_usd_micros,c.state;
END $$;
ALTER FUNCTION domino_gas_budget.reserve(text,text,text,numeric,numeric,numeric,bigint,bigint,text,bigint,integer)
 OWNER TO domino_execution_owner;

CREATE FUNCTION domino_gas_budget.settle(
 p_cycle_id text,p_leg text,p_spent_wei numeric,p_answer_raw numeric,
 p_round numeric,p_updated_at bigint,p_block_timestamp bigint
) RETURNS TABLE(day date,spent_usd_micros numeric,state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,domino_gas_budget AS $$
DECLARE c domino_gas_budget.claims; spent numeric; now_seconds bigint;
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
 IF p_spent_wei>c.max_cost_wei THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='gas_settlement_invalid';
 END IF;
 IF c.state='settled' THEN
  IF c.spent_wei<>p_spent_wei THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='gas_settlement_conflict';
  END IF;
  RETURN QUERY SELECT c.day,c.spent_usd_micros,c.state;
  RETURN;
 END IF;
 -- Keep the higher of the signing-time and settlement-time ETH/USD answers.
 -- A later price drop must not create extra daily headroom for gas already paid.
 spent:=ceil(p_spent_wei*greatest(c.reserve_answer_raw,p_answer_raw)*1000000/100000000000000000000000000);
 -- denominator is 10^18 wei * 10^8 feed decimals.
 UPDATE domino_gas_budget.claims SET state='settled',spent_wei=p_spent_wei,
  spent_usd_micros=spent,settle_answer_raw=p_answer_raw,settle_round=p_round,
  settled_at=clock_timestamp(),settled_day=(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date
  WHERE cycle_id=p_cycle_id AND leg=p_leg;
 RETURN QUERY SELECT c.day,spent,'settled'::text;
END $$;
ALTER FUNCTION domino_gas_budget.settle(text,text,numeric,numeric,numeric,bigint,bigint)
 OWNER TO domino_execution_owner;

-- Read-only signer gate. A prior-day outstanding claim may be used across the
-- date boundary, but it must have been freshly reserved before signing.
CREATE FUNCTION domino_gas_budget.authorized(
 p_cycle_id text,p_leg text,p_signer text,p_required_wei numeric
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,domino_gas_budget AS $$
DECLARE c domino_gas_budget.claims; d date; used numeric;
BEGIN
 IF p_cycle_id !~ '^0x[0-9a-f]{64}$' OR p_leg NOT IN ('publisher','operator') OR
    p_signer !~ '^0x[0-9a-f]{40}$' OR p_required_wei IS NULL OR
    p_required_wei<>trunc(p_required_wei) OR p_required_wei<=0 OR
    p_required_wei>=340282366920938463463374607431768211456 THEN
  RETURN false;
 END IF;
 SELECT * INTO c FROM domino_gas_budget.claims
  WHERE cycle_id=p_cycle_id AND leg=p_leg AND signer=p_signer AND state='reserved';
 IF NOT FOUND OR c.max_cost_wei<p_required_wei OR
    c.refreshed_at<clock_timestamp()-interval '120 seconds' OR
    floor(extract(epoch from clock_timestamp()))::bigint-c.reserve_updated_at>7200 THEN
  RETURN false;
 END IF;
 d:=(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
 SELECT coalesce(sum(CASE WHEN claims.state='settled' THEN claims.spent_usd_micros
                          ELSE claims.reserved_usd_micros END),0) INTO used
  FROM domino_gas_budget.claims
  WHERE claims.day=d OR (claims.day<d AND
        (claims.state='reserved' OR claims.settled_day=d));
 RETURN used<=20000000;
END $$;
ALTER FUNCTION domino_gas_budget.authorized(text,text,text,numeric)
 OWNER TO domino_execution_owner;

-- Resending bytes already signed never authorizes a new signature. It only
-- verifies that their still-pending claim exists and continues to consume the
-- shared cap; a 120-second signing gate must not strand a nonce after restart.
CREATE FUNCTION domino_gas_budget.authorized_existing(
 p_cycle_id text,p_leg text,p_signer text,p_required_wei numeric
) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,domino_gas_budget AS $$
 SELECT p_cycle_id ~ '^0x[0-9a-f]{64}$'
  AND p_leg IN ('publisher','operator')
  AND p_signer ~ '^0x[0-9a-f]{40}$'
  AND p_required_wei IS NOT NULL AND p_required_wei=trunc(p_required_wei)
  AND p_required_wei>0 AND p_required_wei<340282366920938463463374607431768211456
  AND EXISTS(SELECT 1 FROM domino_gas_budget.claims c
   WHERE c.cycle_id=p_cycle_id AND c.leg=p_leg AND c.signer=p_signer
     AND c.state='reserved' AND c.max_cost_wei>=p_required_wei)
$$;
ALTER FUNCTION domino_gas_budget.authorized_existing(text,text,text,numeric)
 OWNER TO domino_execution_owner;

CREATE FUNCTION domino_gas_budget.status(p_day date)
RETURNS TABLE(cap_usd_micros numeric,used_usd_micros numeric,remaining_usd_micros numeric)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,domino_gas_budget AS $$
 SELECT 20000000::numeric,used,
        greatest(0::numeric,20000000::numeric-used)
 FROM (SELECT coalesce(sum(CASE WHEN state='settled' THEN spent_usd_micros
                                ELSE reserved_usd_micros END),0) AS used
       FROM domino_gas_budget.claims
       WHERE day=p_day OR (day<p_day AND (state='reserved' OR settled_day=p_day))) AS daily
$$;
ALTER FUNCTION domino_gas_budget.status(date) OWNER TO domino_execution_owner;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA domino_gas_budget FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domino_gas_budget.reserve(text,text,text,numeric,numeric,numeric,bigint,bigint,text,bigint,integer)
 TO domino_gas_budget_worker;
GRANT EXECUTE ON FUNCTION domino_gas_budget.settle(text,text,numeric,numeric,numeric,bigint,bigint)
 TO domino_gas_settlement_worker;
GRANT EXECUTE ON FUNCTION domino_gas_budget.status(date) TO domino_gas_budget_worker;
GRANT EXECUTE ON FUNCTION domino_gas_budget.authorized(text,text,text,numeric)
 TO domino_gas_budget_worker;
GRANT EXECUTE ON FUNCTION domino_gas_budget.authorized_existing(text,text,text,numeric)
 TO domino_gas_budget_worker;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='domino_execution_signer') THEN
  GRANT USAGE ON SCHEMA domino_gas_budget TO domino_execution_signer;
  GRANT EXECUTE ON FUNCTION domino_gas_budget.authorized(text,text,text,numeric)
   TO domino_execution_signer;
  GRANT EXECUTE ON FUNCTION domino_gas_budget.authorized_existing(text,text,text,numeric)
   TO domino_execution_signer;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='domino_execution_publisher') THEN
  GRANT USAGE ON SCHEMA domino_gas_budget TO domino_execution_publisher;
  GRANT EXECUTE ON FUNCTION domino_gas_budget.authorized(text,text,text,numeric)
   TO domino_execution_publisher;
 END IF;
END $$;
