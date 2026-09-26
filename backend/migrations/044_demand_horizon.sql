-- The demand horizon. How long ago a visitor last asked for a pool decides how
-- often the collector refreshes it and whether it keeps spending the provider
-- allowance, the activity queue and a history job (manage_public_data.py
-- interest_tier). A pool nobody asked for in a week keeps its on-chain state
-- hourly and nothing else.
--
-- The featured-pools selection keeps the pools it lists, drafts and falls back
-- to warm: never below the week tier (provider and history kept) until
-- keep_warm_until, so a fallback has figures and a chart the moment it shows.
ALTER TABLE domino_public.entities ADD COLUMN IF NOT EXISTS keep_warm_until timestamptz;
