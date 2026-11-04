-- A session belongs to the browser origin it signed in on (launch round P3, 4 Nov 2026, item 7; review finding M1).
-- NULL is the listener's canonical origin (DOMINO_SESSION_ORIGIN): every session written before this migration and
-- every one signed in there since. A session signed in on a listed Pages preview origin carries that exact origin.
-- session_store refuses a session presented through any other admitted origin, in both directions: a preview's
-- session never works on production, nor production's on a preview. Unlisting a preview revokes its sessions by
-- origin (docs/PREVIEW_PUBLIC_READS.md, rollback).
--
-- Additive and nullable: the listeners' earlier code keeps writing NULL, the canonical origin, so this migration is
-- applied before the code that reads it, and their rollback needs no reverse step.
--
-- Idempotent: the development initializer applies it on every run.
ALTER TABLE domino_sessions.sessions ADD COLUMN IF NOT EXISTS origin text;
ALTER TABLE domino_sessions.sessions DROP CONSTRAINT IF EXISTS sessions_origin_check;
-- The form backend/session_siwe.py admits: https and a lower-case DNS name, nothing else.
ALTER TABLE domino_sessions.sessions ADD CONSTRAINT sessions_origin_check
    CHECK (origin IS NULL OR (char_length(origin) <= 261
           AND origin ~ '^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'));
CREATE INDEX IF NOT EXISTS sessions_origin ON domino_sessions.sessions(origin) WHERE origin IS NOT NULL;
