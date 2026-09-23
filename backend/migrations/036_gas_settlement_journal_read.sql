-- The keyless settlement peer reads one witness at a time through fixed
-- SECURITY DEFINER functions. It has no direct table, signer or reserve role.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='domino_gas_settlement_worker')
  OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname='domino_gas_settlement_worker' AND
   (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
  RAISE EXCEPTION 'gas_settlement_role_invalid';
 END IF;
END $$;
GRANT USAGE ON SCHEMA domino_execution TO domino_gas_settlement_worker;
-- FORCE RLS also applies to this NOLOGIN table owner. No LOGIN role inherits it.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['publications','intents','journal','attempts','effects'] LOOP
  EXECUTE format('CREATE POLICY gas_witness_owner ON domino_execution.%I FOR SELECT TO domino_execution_owner USING (true)',t);
 END LOOP;
END $$;

CREATE FUNCTION domino_execution.gas_publication_witness(p_id text)
RETURNS SETOF domino_execution.publications LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,domino_execution AS $$
 SELECT * FROM domino_execution.publications
 WHERE p_id ~ '^0x[0-9a-f]{64}$' AND observation_id=p_id;
$$;
CREATE FUNCTION domino_execution.gas_intent_witness(p_owner text,p_id text)
RETURNS SETOF domino_execution.intents LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,domino_execution AS $$
 SELECT * FROM domino_execution.intents
 WHERE p_owner ~ '^0x[0-9a-f]{40}$' AND p_id ~ '^0x[0-9a-f]{64}$'
  AND owner=p_owner AND intent_id=p_id;
$$;
CREATE FUNCTION domino_execution.gas_journal_witness(p_owner text,p_id text)
RETURNS SETOF domino_execution.journal LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,domino_execution AS $$
 SELECT * FROM domino_execution.journal
 WHERE p_owner ~ '^0x[0-9a-f]{40}$' AND p_id ~ '^0x[0-9a-f]{64}$'
  AND owner=p_owner AND intent_id=p_id;
$$;
CREATE FUNCTION domino_execution.gas_attempt_witness(p_owner text,p_id text)
RETURNS SETOF domino_execution.attempts LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,domino_execution AS $$
 SELECT * FROM domino_execution.attempts
 WHERE p_owner ~ '^0x[0-9a-f]{40}$' AND p_id ~ '^0x[0-9a-f]{64}$'
  AND owner=p_owner AND intent_id=p_id;
$$;
CREATE FUNCTION domino_execution.gas_effect_witness(p_owner text,p_id text)
RETURNS SETOF domino_execution.effects LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,domino_execution AS $$
 SELECT * FROM domino_execution.effects
 WHERE p_owner ~ '^0x[0-9a-f]{40}$' AND p_id ~ '^0x[0-9a-f]{64}$'
  AND owner=p_owner AND intent_id=p_id;
$$;

ALTER FUNCTION domino_execution.gas_publication_witness(text) OWNER TO domino_execution_owner;
ALTER FUNCTION domino_execution.gas_intent_witness(text,text) OWNER TO domino_execution_owner;
ALTER FUNCTION domino_execution.gas_journal_witness(text,text) OWNER TO domino_execution_owner;
ALTER FUNCTION domino_execution.gas_attempt_witness(text,text) OWNER TO domino_execution_owner;
ALTER FUNCTION domino_execution.gas_effect_witness(text,text) OWNER TO domino_execution_owner;
REVOKE ALL ON FUNCTION domino_execution.gas_publication_witness(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION domino_execution.gas_intent_witness(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION domino_execution.gas_journal_witness(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION domino_execution.gas_attempt_witness(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION domino_execution.gas_effect_witness(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domino_execution.gas_publication_witness(text) TO domino_gas_settlement_worker;
GRANT EXECUTE ON FUNCTION domino_execution.gas_intent_witness(text,text) TO domino_gas_settlement_worker;
GRANT EXECUTE ON FUNCTION domino_execution.gas_journal_witness(text,text) TO domino_gas_settlement_worker;
GRANT EXECUTE ON FUNCTION domino_execution.gas_attempt_witness(text,text) TO domino_gas_settlement_worker;
GRANT EXECUTE ON FUNCTION domino_execution.gas_effect_witness(text,text) TO domino_gas_settlement_worker;
