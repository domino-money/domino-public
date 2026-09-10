-- Extend the existing unpublished sidecar; preserve every qualified ledger row.
-- Reapplicable to both fresh and upgraded databases after 007_historical_work.
ALTER TABLE domino_activity.historical_work
 DROP CONSTRAINT IF EXISTS historical_work_ledger_check;
ALTER TABLE domino_activity.historical_work
 ADD CONSTRAINT historical_work_ledger_check CHECK(ledger IN ('fee','position','capital'));
