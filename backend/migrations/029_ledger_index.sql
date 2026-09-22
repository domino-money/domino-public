-- Ledger completeness beside the execution store. The executor's
-- reconciliation records what its own transactions credited and spent; the
-- vault's fee balances can still move without an intent of ours, when the
-- owner withdraws reserves. This migration lets the reconciliation role record
-- such a withdrawal from the vault's own event in a finalized block, as a debit
-- attributed to the ledger's lots; keeps a per-sequence cursor of the finalized
-- blocks already read; and records what the ledger cannot represent, a fee
-- event of an execution that is not a reconciled effect of ours, as an
-- exception an operator has to acknowledge. Explicit migration only: no role,
-- no service, no key, and no credit is created here.

-- Where the reader of one sequence's vault events stopped. It only moves
-- forward; a rescan of earlier blocks re-finds records that already exist.
CREATE TABLE domino_execution.ledger_cursors (
 owner text NOT NULL CHECK(owner ~ '^0x[0-9a-f]{40}$' AND owner<>'0x0000000000000000000000000000000000000000'),
 sequence_hash text PRIMARY KEY CHECK(sequence_hash ~ '^0x[0-9a-f]{64}$'),
 vault text NOT NULL CHECK(vault ~ '^0x[0-9a-f]{40}$'),
 block_number numeric NOT NULL CHECK(block_number=trunc(block_number) AND block_number>=0),
 block_hash text NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner,sequence_hash)
);
CREATE FUNCTION domino_execution.preserve_cursor() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,domino_execution AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.owner<>OLD.owner OR NEW.sequence_hash<>OLD.sequence_hash OR NEW.vault<>OLD.vault
   OR NEW.block_number<OLD.block_number OR (NEW.block_number=OLD.block_number AND NEW.block_hash<>OLD.block_hash) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_cursor_regressed';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER execution_cursor_guard BEFORE UPDATE OR DELETE ON domino_execution.ledger_cursors FOR EACH ROW EXECUTE FUNCTION domino_execution.preserve_cursor();

-- An owner's withdrawal of fee reserves, from the vault's own event in a
-- finalized block: the chain fact, per source and currency. The debits below
-- attribute it to the ledger's lots by one documented convention (the oldest
-- available lot first, quarantined lots after); the sums per source, currency
-- and kind are exact, the split between lots is the ledger's own. What the
-- ledger's lots could not absorb stays on the row as unattributed, so a
-- withdrawal of money the ledger never knew keeps the disagreement visible
-- instead of hiding it.
CREATE TABLE domino_execution.withdrawals (
 withdrawal_id text PRIMARY KEY CHECK(withdrawal_id ~ '^0x[0-9a-f]{64}$'),
 owner text NOT NULL CHECK(owner ~ '^0x[0-9a-f]{40}$' AND owner<>'0x0000000000000000000000000000000000000000'),
 sequence_hash text NOT NULL CHECK(sequence_hash ~ '^0x[0-9a-f]{64}$'),
 source_id text NOT NULL CHECK(source_id ~ '^0x[0-9a-f]{64}$'),
 currency text NOT NULL CHECK(currency ~ '^0x[0-9a-f]{40}$'),
 transaction_hash text NOT NULL CHECK(transaction_hash ~ '^0x[0-9a-f]{64}$'),
 event_index bigint NOT NULL CHECK(event_index BETWEEN 0 AND 4294967295),
 block_number numeric NOT NULL CHECK(block_number=trunc(block_number) AND block_number>=0),
 block_hash text NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),
 state_nonce numeric NOT NULL CHECK(state_nonce=trunc(state_nonce) AND state_nonce>=0 AND state_nonce<18446744073709551616),
 original_raw numeric NOT NULL CHECK(original_raw=trunc(original_raw) AND original_raw>=0 AND original_raw<340282366920938463463374607431768211456),
 charged_raw numeric NOT NULL CHECK(charged_raw=trunc(charged_raw) AND charged_raw>=0 AND charged_raw<340282366920938463463374607431768211456),
 unattributed_original_raw numeric NOT NULL CHECK(unattributed_original_raw=trunc(unattributed_original_raw) AND unattributed_original_raw BETWEEN 0 AND original_raw),
 unattributed_charged_raw numeric NOT NULL CHECK(unattributed_charged_raw=trunc(unattributed_charged_raw) AND unattributed_charged_raw BETWEEN 0 AND charged_raw),
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<65536),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner,withdrawal_id),
 UNIQUE(transaction_hash,event_index),
 CHECK(original_raw+charged_raw>0)
);
CREATE INDEX execution_withdrawals_sequence ON domino_execution.withdrawals(sequence_hash,block_number DESC);
CREATE TABLE domino_execution.withdrawal_debits (
 owner text NOT NULL,
 withdrawal_id text NOT NULL,
 lot_id text NOT NULL,
 amount_raw numeric NOT NULL CHECK(amount_raw=trunc(amount_raw) AND amount_raw>0 AND amount_raw<340282366920938463463374607431768211456),
 PRIMARY KEY(withdrawal_id,lot_id),
 FOREIGN KEY(owner,withdrawal_id) REFERENCES domino_execution.withdrawals(owner,withdrawal_id),
 FOREIGN KEY(owner,lot_id) REFERENCES domino_execution.origins(owner,lot_id)
);
CREATE INDEX execution_withdrawal_debits_lot ON domino_execution.withdrawal_debits(lot_id);

CREATE FUNCTION domino_execution.preserve_withdrawal() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,domino_execution AS $$
BEGIN
 RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_withdrawal_immutable';
END $$;
CREATE TRIGGER execution_withdrawal_immutable BEFORE UPDATE OR DELETE ON domino_execution.withdrawals FOR EACH ROW EXECUTE FUNCTION domino_execution.preserve_withdrawal();

-- A debit names a lot of the withdrawal's own source and currency and never
-- exceeds what the lot still holds after settled spends and earlier debits.
-- Active claims of pending intents are not subtracted: the chain already took
-- the money, and the executor refuses such an intent before signing.
CREATE FUNCTION domino_execution.guard_withdrawal_debit() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,domino_execution AS $$
DECLARE w domino_execution.withdrawals; o domino_execution.origins; used numeric;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_withdrawal_immutable'; END IF;
 SELECT * INTO w FROM domino_execution.withdrawals WHERE owner=NEW.owner AND withdrawal_id=NEW.withdrawal_id;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_claim_mismatch'; END IF;
 SELECT * INTO o FROM domino_execution.origins WHERE owner=NEW.owner AND lot_id=NEW.lot_id FOR UPDATE;
 IF NOT FOUND OR o.source_id<>w.source_id OR o.currency<>w.currency OR o.sequence_hash<>w.sequence_hash THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_claim_mismatch';
 END IF;
 SELECT coalesce(sum(amount_raw),0) INTO used FROM domino_execution.spends WHERE lot_id=NEW.lot_id;
 SELECT used+coalesce(sum(amount_raw),0) INTO used FROM domino_execution.withdrawal_debits WHERE lot_id=NEW.lot_id;
 IF used+NEW.amount_raw>o.amount_raw THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_balance_reserved'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER execution_withdrawal_debit_guard BEFORE INSERT OR UPDATE OR DELETE ON domino_execution.withdrawal_debits FOR EACH ROW EXECUTE FUNCTION domino_execution.guard_withdrawal_debit();

-- At commit, the debits of a withdrawal account for it exactly, kind by kind:
-- original lots for the original amount, converted lots for the charged one,
-- plus whatever the row declares unattributed.
CREATE FUNCTION domino_execution.check_withdrawal_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,domino_execution AS $$
DECLARE original_debited numeric; charged_debited numeric;
BEGIN
 SELECT coalesce(sum(CASE WHEN o.kind='original' THEN d.amount_raw ELSE 0 END),0),
        coalesce(sum(CASE WHEN o.kind='converted' THEN d.amount_raw ELSE 0 END),0)
   INTO original_debited,charged_debited
   FROM domino_execution.withdrawal_debits d JOIN domino_execution.origins o ON o.owner=d.owner AND o.lot_id=d.lot_id
   WHERE d.withdrawal_id=NEW.withdrawal_id;
 IF original_debited+NEW.unattributed_original_raw<>NEW.original_raw OR charged_debited+NEW.unattributed_charged_raw<>NEW.charged_raw THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_withdrawal_incomplete';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER execution_withdrawal_complete AFTER INSERT ON domino_execution.withdrawals
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION domino_execution.check_withdrawal_complete();

-- Fee events of an execution the ledger cannot represent: the transaction is
-- not a reconciled effect of ours. One row per sequence and transaction; the
-- operator acknowledges it after recording what the evidence supports.
CREATE TABLE domino_execution.ledger_exceptions (
 exception_id text PRIMARY KEY CHECK(exception_id ~ '^0x[0-9a-f]{64}$'),
 owner text NOT NULL CHECK(owner ~ '^0x[0-9a-f]{40}$' AND owner<>'0x0000000000000000000000000000000000000000'),
 sequence_hash text NOT NULL CHECK(sequence_hash ~ '^0x[0-9a-f]{64}$'),
 kind text NOT NULL CHECK(kind IN ('foreign_execution','unreconciled_execution')),
 transaction_hash text NOT NULL CHECK(transaction_hash ~ '^0x[0-9a-f]{64}$'),
 block_number numeric NOT NULL CHECK(block_number=trunc(block_number) AND block_number>=0),
 block_hash text NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),
 intent_id text NOT NULL CHECK(intent_id ~ '^0x[0-9a-f]{64}$'),
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<65536),
 acknowledged boolean NOT NULL DEFAULT false,
 acknowledgement text NOT NULL DEFAULT '' CHECK(acknowledgement ~ '^[a-z0-9_]{0,100}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner,exception_id),
 UNIQUE(sequence_hash,transaction_hash),
 CHECK(acknowledged OR acknowledgement='')
);
CREATE FUNCTION domino_execution.preserve_exception() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,domino_execution AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.acknowledged THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_exception_immutable'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['acknowledged','acknowledgement','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['acknowledged','acknowledgement','updated_at'])
   OR (OLD.acknowledged AND NOT NEW.acknowledged) OR (NEW.acknowledged AND NEW.acknowledgement='') THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_exception_immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER execution_exception_guard BEFORE INSERT OR UPDATE OR DELETE ON domino_execution.ledger_exceptions FOR EACH ROW EXECUTE FUNCTION domino_execution.preserve_exception();

-- The claim and spend guards count withdrawal debits as money already gone
-- from a lot. Otherwise verbatim from 019.
CREATE OR REPLACE FUNCTION domino_execution.guard_claim() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,domino_execution AS $$
DECLARE i domino_execution.intents; o domino_execution.origins; used numeric;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_claim_immutable'; END IF;
  PERFORM domino_execution.live_fence(NEW.intent_id);
  SELECT * INTO i FROM domino_execution.intents WHERE intent_id=NEW.intent_id;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-'active') IS DISTINCT FROM (to_jsonb(OLD)-'active') OR NOT OLD.active OR NEW.active OR NOT (i.state='cancelled' OR (TG_TABLE_NAME IN ('lot_claims','source_claims') AND (EXISTS(SELECT 1 FROM domino_execution.effects WHERE intent_id=NEW.intent_id AND canonical) OR EXISTS(SELECT 1 FROM domino_execution.journal WHERE intent_id=NEW.intent_id AND state='reverted')))) THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_claim_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT NEW.active OR i.state<>(CASE WHEN TG_TABLE_NAME='nonce_claims' THEN 'reserved' ELSE 'planned' END) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_state_conflict';
  END IF;
  IF TG_TABLE_NAME='lot_claims' THEN
    SELECT * INTO o FROM domino_execution.origins WHERE owner=NEW.owner AND lot_id=NEW.lot_id FOR UPDATE;
    IF NOT FOUND OR o.state<>'available' OR o.sequence_hash<>i.sequence_hash THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_origin_unavailable';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(i.plan->'allocations') a WHERE a->>'lotId'=NEW.lot_id AND (a->>'amountRaw')::numeric=NEW.amount_raw) THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_claim_mismatch';
    END IF;
    SELECT coalesce(sum(amount_raw),0) INTO used FROM domino_execution.lot_claims WHERE lot_id=NEW.lot_id AND active;
    SELECT used+coalesce(sum(amount_raw),0) INTO used FROM domino_execution.spends WHERE lot_id=NEW.lot_id;
    SELECT used+coalesce(sum(amount_raw),0) INTO used FROM domino_execution.withdrawal_debits WHERE lot_id=NEW.lot_id;
    IF used+NEW.amount_raw>o.amount_raw THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_balance_reserved'; END IF;
  ELSIF TG_TABLE_NAME='source_claims' THEN
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(i.plan->'collections') a WHERE a->>'sourceId'=NEW.source_id AND (a->>'maxGrossRaw')::numeric=NEW.amount_raw)
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(i.commitments->'collections') a
        WHERE a->>'sourceId'=NEW.source_id AND a->>'checkpointId'=NEW.checkpoint_id AND (a->>'amountRaw')::numeric=NEW.amount_raw) THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_claim_mismatch';
    END IF;
  ELSIF TG_TABLE_NAME='successor_claims' THEN
    IF i.plan->>'action'<>'3' OR NEW.successor_id IS DISTINCT FROM i.commitments->>'successorId' THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_claim_mismatch';
    END IF;
  ELSIF TG_TABLE_NAME='nonce_claims' THEN
    IF NEW.chain_id<>i.chain_id THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_claim_mismatch'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION domino_execution.guard_spend() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,domino_execution AS $$
DECLARE o domino_execution.origins; used numeric;
BEGIN
 PERFORM domino_execution.live_fence(NEW.intent_id);
 IF NOT EXISTS(SELECT 1 FROM domino_execution.effects WHERE intent_id=NEW.intent_id AND canonical) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_state_conflict';
 END IF;
 SELECT * INTO o FROM domino_execution.origins WHERE owner=NEW.owner AND lot_id=NEW.lot_id FOR UPDATE;
 SELECT coalesce(sum(amount_raw),0) INTO used FROM domino_execution.spends WHERE lot_id=NEW.lot_id;
 SELECT used+coalesce(sum(amount_raw),0) INTO used FROM domino_execution.withdrawal_debits WHERE lot_id=NEW.lot_id;
 IF NOT FOUND OR o.state<>'available' OR used+NEW.amount_raw>o.amount_raw THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='execution_balance_reserved';
 END IF;
 RETURN NEW;
END $$;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['ledger_cursors','withdrawals','withdrawal_debits','ledger_exceptions'] LOOP
  EXECUTE format('ALTER TABLE domino_execution.%I OWNER TO domino_execution_owner',t);
  EXECUTE format('ALTER TABLE domino_execution.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE domino_execution.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON domino_execution.%I FROM PUBLIC',t);
  -- The reconciliation role writes; the worker reads its tenant's rows.
  EXECUTE format('CREATE POLICY execution_tenant ON domino_execution.%I TO domino_execution_ledger,domino_execution_worker USING(owner=current_setting(''domino.execution_owner'',true)) WITH CHECK(owner=current_setting(''domino.execution_owner'',true))',t);
  EXECUTE format('GRANT SELECT ON domino_execution.%I TO domino_execution_worker',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT ON domino_execution.withdrawals,domino_execution.withdrawal_debits,domino_execution.ledger_exceptions TO domino_execution_ledger;
GRANT SELECT,INSERT,UPDATE ON domino_execution.ledger_cursors TO domino_execution_ledger;
GRANT UPDATE(acknowledged,acknowledgement,updated_at) ON domino_execution.ledger_exceptions TO domino_execution_ledger;
-- The spend guard runs as the signer and now reads the debits of a lot.
CREATE POLICY execution_signer_tenant ON domino_execution.withdrawal_debits TO domino_execution_signer USING(owner=current_setting('domino.execution_owner',true));
GRANT SELECT ON domino_execution.withdrawal_debits TO domino_execution_signer;
-- The reader of vault events tells its own reconciled effects from foreign
-- ones by transaction hash: identity and state only, never signed bytes.
GRANT SELECT(owner,intent_id,transaction_hash) ON domino_execution.attempts TO domino_execution_ledger;
GRANT SELECT(owner,intent_id,state) ON domino_execution.journal TO domino_execution_ledger;
GRANT SELECT(owner,intent_id,transaction_hash,canonical) ON domino_execution.effects TO domino_execution_ledger;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['attempts','journal','effects'] LOOP
  EXECUTE format('CREATE POLICY execution_ledger_read ON domino_execution.%I TO domino_execution_ledger USING(owner=current_setting(''domino.execution_owner'',true))',t);
 END LOOP;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA domino_execution FROM PUBLIC;
