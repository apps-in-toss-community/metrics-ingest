-- Schema for metrics-ingest events table.
--
-- Stores anonymous, opt-in usage telemetry from apps-in-toss-community dev
-- tools. See repo CLAUDE.md and docs.aitc.dev/privacy for the data policy.

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  event TEXT NOT NULL,
  anon_id TEXT NOT NULL,
  version TEXT NOT NULL,
  ts INTEGER NOT NULL,
  country TEXT,
  meta TEXT
);

CREATE INDEX IF NOT EXISTS idx_source_event_ts ON events(source, event, ts);
CREATE INDEX IF NOT EXISTS idx_anon_id_ts ON events(anon_id, ts);
CREATE INDEX IF NOT EXISTS idx_ts ON events(ts);
