-- Session policy eoa_or_7702_v1: an EOA whose code is an EIP-7702 designator
-- may sign in. SIWE still proves the account's own key, which a delegation
-- never removes. The session keeps the delegate it was admitted with (NULL for
-- a plain EOA); session_store revokes it when a later check observes another
-- delegate, a new one, or a cleared one, and the browser signs in again.
--
-- Rows written under plain_eoa_v1 remain valid records but are no longer live:
-- session_store._live compares the stored policy with the current one, so every
-- earlier session signs in once more after this change is deployed.
--
-- Idempotent: the development initializer applies it on every run.
ALTER TABLE domino_sessions.sessions ADD COLUMN IF NOT EXISTS delegate text;
-- 008 declared CHECK (policy='plain_eoa_v1') on the column; PostgreSQL names it
-- sessions_policy_check.
ALTER TABLE domino_sessions.sessions DROP CONSTRAINT IF EXISTS sessions_policy_check;
ALTER TABLE domino_sessions.sessions ADD CONSTRAINT sessions_policy_check
    CHECK (policy IN ('plain_eoa_v1','eoa_or_7702_v1'));
ALTER TABLE domino_sessions.sessions DROP CONSTRAINT IF EXISTS sessions_delegate_check;
ALTER TABLE domino_sessions.sessions ADD CONSTRAINT sessions_delegate_check
    CHECK (delegate IS NULL OR (policy='eoa_or_7702_v1' AND delegate ~ '^0x[0-9a-f]{40}$'
                                AND delegate<>'0x0000000000000000000000000000000000000000'));
