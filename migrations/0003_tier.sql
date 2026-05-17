-- Add tier column to events table.
--
-- Tier 0 = anonymous daily ping (opt-out, server-derived identity).
-- Tier 1 = detailed opt-in event stream (client UUID, explicit consent).
--
-- DEFAULT 1: all existing rows were Tier 1 opt-in events.
-- New Tier 0 rows are inserted explicitly with tier=0.

ALTER TABLE events ADD COLUMN tier INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_tier_ts ON events(tier, ts);
