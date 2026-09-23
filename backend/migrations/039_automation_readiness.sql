-- Let the existing authenticated execution-status reader see only the live
-- automation heartbeat for its authenticated owner. The worker already owns
-- writes to controls; this grant adds no signing or execution authority.
CREATE POLICY execution_reader_automation_ready ON domino_execution.controls
 TO domino_execution_reader
 USING (key ~ '^automation_ready_[0-9a-f]{40}$'
        AND value->>'owner'=current_setting('domino.execution_owner',true));
GRANT SELECT(key,value,updated_at) ON domino_execution.controls TO domino_execution_reader;
