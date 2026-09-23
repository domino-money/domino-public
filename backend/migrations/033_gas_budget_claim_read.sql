-- Private settlement proof: the budget worker may inspect only an existing
-- claim's signer, ceiling and state before releasing its reserved difference.
-- This does not grant public access or permit claim mutation.
CREATE FUNCTION domino_gas_budget.claim_for_settlement(p_cycle_id text,p_leg text)
RETURNS TABLE(signer text,max_cost_wei numeric,state text,spent_wei numeric)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,domino_gas_budget AS $$
 SELECT c.signer,c.max_cost_wei,c.state,c.spent_wei
 FROM domino_gas_budget.claims c
 WHERE c.cycle_id=p_cycle_id AND c.leg=p_leg
   AND p_cycle_id ~ '^0x[0-9a-f]{64}$'
   AND p_leg IN ('publisher','operator')
$$;
ALTER FUNCTION domino_gas_budget.claim_for_settlement(text,text)
 OWNER TO domino_execution_owner;
REVOKE ALL ON FUNCTION domino_gas_budget.claim_for_settlement(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domino_gas_budget.claim_for_settlement(text,text)
 TO domino_gas_settlement_worker;
